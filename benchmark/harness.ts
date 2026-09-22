/**
 * Benchmark harness v0 (deterministic baseline, no ML weights).
 *
 * Section A — pure-function gates (scope, dedupe heuristic, sanitize).
 * Section B — store-backed retrieval: seeds an in-memory SQLite store
 *   from the dataset and runs the real recall pipeline (FTS5/BM25 +
 *   RRF + scope/validity + budget), checking recall vs abstention.
 *
 * Full harness (dense vs hybrid vs hybrid+RRF+reranker, Laya
 * multilingual vs Router, storage backends, p50/p95, RAM) lands
 * after the embedding slice. This file is the regression gate
 * skeleton: every later change must keep it green.
 */

import { readFileSync } from "node:fs"
import { suggestOp } from "../src/consolidation.js"
import { recall } from "../src/retrieval/search.js"
import { sanitizeForPersistence } from "../src/sanitize.js"
import { isScopeVisible } from "../src/scope.js"
import type { MemoryRecord, MemoryScope } from "../src/schema.js"
import { SqliteMemoryStore } from "../src/storage/sqlite.js"

interface LooseScope {
  level: MemoryScope["level"]
  projectId?: string
  organizationId?: string
  branch?: string
  sessionId?: string
  taskId?: string
  workspaceId?: string
}

interface Row {
  id: string
  category: string
  scope?: LooseScope
  memory?: {
    content: string
    kind: string
    tier: string
    scope?: LooseScope
  }
  old?: { content: string; kind: string; tier: string }
  new?: { content: string; kind: string; tier: string }
  expected?: string
  expected_op?: string
  request_scope?: LooseScope
  query?: string
}

const DEFAULT_SEED_SCOPE: LooseScope = { level: "project", projectId: "proj-a" }

function toRecord(content: string, kind: string, tier: string, id: string): MemoryRecord {
  return {
    id,
    content,
    kind: kind as MemoryRecord["kind"],
    tier: tier as MemoryRecord["tier"],
    scope: { level: "project", projectId: "proj-a" },
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    sourceIds: ["e1"],
    sourceKind: "user",
    extractorVersion: "harness-v0",
    decisionModel: "heuristic",
  }
}

function loadRows(datasetPath: string): Row[] {
  return readFileSync(datasetPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row)
}

function runPureChecks(rows: Row[]): string[] {
  const failed: string[] = []
  for (const row of rows) {
    if (row.category === "scope-isolation" || row.category === "branch-specific") {
      const memScope = {
        level: row.scope?.level ?? row.memory?.scope?.level ?? "project",
        projectId: row.scope?.projectId ?? "proj-a",
        branch: row.scope?.branch,
      } as Parameters<typeof isScopeVisible>[0]
      const reqScope = {
        level: row.request_scope?.level ?? "project",
        projectId: row.request_scope?.projectId ?? "proj-a",
        branch: row.request_scope?.branch,
      } as Parameters<typeof isScopeVisible>[1]
      const visible = isScopeVisible(memScope, reqScope)
      if (row.expected === "abstain" && visible) failed.push(`${row.id}: leak across scope`)
      continue
    }
    if (row.expected_op && row.old && row.new) {
      const out = suggestOp(row.new.content, [
        toRecord(row.old.content, row.old.kind, row.old.tier, `${row.id}-old`),
      ])
      // Heuristic baseline: duplicates must be NOOP; updates may be
      // ADD (heuristic) or SUPERSEDE/REVIEW (Laya). Only assert NOOP cases.
      if (row.expected_op === "NOOP" && out.op !== "NOOP") {
        failed.push(`${row.id}: expected NOOP, got ${out.op}`)
      }
      continue
    }
    if (row.category === "abstention" && row.query?.includes("senha")) {
      const s = sanitizeForPersistence("senha = hunter2hunter2")
      if (!s.text.includes("[REDACTED")) failed.push(`${row.id}: secret not redacted`)
    }
  }
  return failed
}

async function runStoreChecks(rows: Row[]): Promise<string[]> {
  const failed: string[] = []
  for (const row of rows) {
    // Only rows that seed a memory and issue a query exercise retrieval.
    if (!row.memory || !row.query || !row.expected) continue
    const store = new SqliteMemoryStore()
    try {
      const seedScope = (row.memory.scope ?? row.scope ?? DEFAULT_SEED_SCOPE) as MemoryScope
      store.putMemory({
        ...toRecord(row.memory.content, row.memory.kind, row.memory.tier, `${row.id}-mem`),
        scope: seedScope,
      })
      const reqScope = (row.request_scope ?? DEFAULT_SEED_SCOPE) as MemoryScope
      const res = await recall(store, { query: row.query, scope: reqScope })
      const included = res.hits.filter((h) => h.included)
      if (row.expected === "recall" && included.length === 0) {
        failed.push(`${row.id}: expected recall, got abstention`)
      }
      if (row.expected === "abstain" && included.length > 0) {
        failed.push(
          `${row.id}: expected abstention, got ${included.map((h) => h.record.id).join(",")}`,
        )
      }
    } finally {
      store.close()
    }
  }
  return failed
}

export function runHarnessV0(datasetPath: string): { passed: number; failed: string[] } {
  const rows = loadRows(datasetPath)
  const failed = runPureChecks(rows)
  return { passed: rows.length - failed.length, failed }
}

export async function runHarnessV1(
  datasetPath: string,
): Promise<{ passed: number; failed: string[] }> {
  const rows = loadRows(datasetPath)
  const failed = [...runPureChecks(rows), ...(await runStoreChecks(rows))]
  const total = rows.length + rows.filter((r) => r.memory && r.query && r.expected).length
  return { passed: total - failed.length, failed }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dataset = new URL("./dataset.v0.jsonl", import.meta.url).pathname
  const res = await runHarnessV1(dataset)
  console.log(`harness v1: ${res.passed} passed, ${res.failed.length} failed`)
  for (const f of res.failed) console.log(`  FAIL ${f}`)
  process.exit(res.failed.length ? 1 : 0)
}
