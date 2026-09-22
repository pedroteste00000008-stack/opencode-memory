/**
 * Recall path (§8, §23.5): independent, explainable candidate streams.
 *
 * query
 *   |-> scope / validity / temporal filters (canonical store)
 *   |-> lexical stream (FTS5/BM25)
 *   |-> dense stream (injectable; absent until the embedding slice)
 *   |-> rank fusion (RRF over positions, never raw-score averaging)
 *   |-> authority/validity ordering
 *   |-> optional reranker (injectable; off until benchmark proves gain)
 *   |-> diversity + token budget -> ephemeral context (3-8 memories)
 *
 * Every inclusion/exclusion is recorded so the `explain` surface can
 * reconstruct why a memory reached the context.
 */

import { scopeRank } from "../scope.js"
import type { MemoryRecord, MemoryScope } from "../schema.js"
import { reciprocalRankFusion } from "./fusion.js"
import type { CanonicalStore } from "../storage/types.js"

export interface DenseHit {
  id: string
  rank: number
}

export type DenseSearchFn = (
  query: string,
  limit: number,
) => DenseHit[] | Promise<DenseHit[]>

export type RerankFn = (
  query: string,
  candidates: MemoryRecord[],
  topK: number,
) => MemoryRecord[] | Promise<MemoryRecord[]>

export interface RecallOptions {
  query: string
  scope: MemoryScope
  kinds?: MemoryRecord["kind"][]
  limit?: number
  /** Oversampling per stream before fusion. */
  oversample?: number
  dense?: DenseSearchFn
  rerank?: RerankFn
  now?: number | null
  /** Approximate budget for injected context (chars/4 token estimate). */
  maxChars?: number
}

export interface ExplainedHit {
  record: MemoryRecord
  streams: string[]
  fusedScore: number
  included: boolean
  excludedReason?: string
}

export interface RecallTrace {
  lexicalCount: number
  denseCount: number
  fusedCount: number
  denseEnabled: boolean
  rerankEnabled: boolean
}

export interface RecallResult {
  hits: ExplainedHit[]
  trace: RecallTrace
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export async function recall(
  store: CanonicalStore,
  opts: RecallOptions,
): Promise<RecallResult> {
  const limit = opts.limit ?? 5
  const oversample = opts.oversample ?? 20
  const maxChars = opts.maxChars ?? 8000

  const lexical = store.searchLexical(opts.query, {
    scope: opts.scope,
    kinds: opts.kinds,
    now: opts.now,
    limit: oversample,
  })
  const lexicalById = new Map(lexical.map((h, i) => [h.record.id, { hit: h, rank: i }]))

  let denseById = new Map<string, { id: string; rank: number }>()
  if (opts.dense) {
    const dense = await opts.dense(opts.query, oversample)
    denseById = new Map(dense.map((d) => [d.id, d]))
  }

  const streams: Array<Array<{ id: string; rank: number }>> = [
    [...lexicalById.values()].map((v) => ({ id: v.hit.record.id, rank: v.rank })),
  ]
  const streamNames = new Map<string, string[]>()
  for (const id of lexicalById.keys()) streamNames.set(id, ["lexical"])
  if (opts.dense) {
    streams.push([...denseById.values()])
    for (const id of denseById.keys()) {
      streamNames.set(id, [...(streamNames.get(id) ?? []), "dense"])
    }
  }

  const fused = reciprocalRankFusion(streams)

  // Resolve fused ids against the canonical store (single source of truth)
  // and drop anything that fails scope/validity on re-read.
  const resolved: Array<{ record: MemoryRecord; fusedScore: number; streams: string[] }> = []
  for (const f of fused) {
    const record = store.getMemory(f.id)
    if (!record || record.status !== "active") continue
    resolved.push({
      record,
      fusedScore: f.score,
      streams: streamNames.get(f.id) ?? [],
    })
  }

  // Authority ordering: fused score first, then scope specificity,
  // then recency. Deterministic for the benchmark gate.
  resolved.sort((a, b) => {
    if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore
    const scopeDiff = scopeRank(b.record.scope.level) - scopeRank(a.record.scope.level)
    if (scopeDiff !== 0) return scopeDiff
    return b.record.updatedAt - a.record.updatedAt
  })

  let candidates = resolved.map((r) => r.record)
  if (opts.rerank) {
    candidates = await opts.rerank(opts.query, candidates, oversample)
  }
  const candidateSet = new Map(candidates.map((c) => [c.id, c]))
  const ordered = resolved.filter((r) => candidateSet.has(r.record.id))

  // Diversity: at most 2 memories per kind keep one kind from
  // flooding the context; then apply the token budget.
  const perKind = new Map<string, number>()
  const hits: ExplainedHit[] = []
  let usedChars = 0
  for (const r of ordered) {
    const kindCount = perKind.get(r.record.kind) ?? 0
    if (kindCount >= 2 && ordered.length > limit) {
      hits.push({ ...r, included: false, excludedReason: "diversity" })
      continue
    }
    if (hits.filter((h) => h.included).length >= limit) {
      hits.push({ ...r, included: false, excludedReason: "top-k" })
      continue
    }
    if (usedChars + r.record.content.length > maxChars) {
      hits.push({ ...r, included: false, excludedReason: "token-budget" })
      continue
    }
    perKind.set(r.record.kind, kindCount + 1)
    usedChars += r.record.content.length
    hits.push({ ...r, included: true })
  }

  return {
    hits,
    trace: {
      lexicalCount: lexical.length,
      denseCount: denseById.size,
      fusedCount: resolved.length,
      denseEnabled: opts.dense !== undefined,
      rerankEnabled: opts.rerank !== undefined,
    },
  }
}
