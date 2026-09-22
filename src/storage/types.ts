/**
 * Storage interfaces for the canonical state (§11, §23.11).
 *
 * Canonical tables and derived indexes must never be left partially
 * updated after an operation is considered complete. Implementations
 * must apply multi-step mutations (e.g. SUPERSEDE) atomically and
 * serialize writers (single-writer / transactional guarantee).
 *
 * Embeddings, FTS and entity indexes are DERIVED: rebuildable from
 * the canonical tables at any time.
 */

import type {
  EvidenceRecord,
  HandoffClaimState,
  HandoffRecord,
  MemoryFeedback,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
  MemoryTier,
  PendingMemoryRecord,
  PendingStatus,
} from "../schema.js"

export interface MemoryFilter {
  /** Request scope: only memories visible from here are returned. */
  scope?: MemoryScope
  kinds?: MemoryKind[]
  tiers?: MemoryTier[]
  /** Defaults to ["active"]. Pass null for any status. */
  status?: MemoryStatus[] | null
  /** Validity window check (defaults to now). Pass null to skip. */
  now?: number | null
  limit?: number
  offset?: number
}

export interface LexicalHit {
  record: MemoryRecord
  /** FTS5 bm25 rank (more negative = better). */
  rank: number
}

export interface CanonicalStore {
  // ── Evidence (append-only) ──────────────────────────
  putEvidence(record: EvidenceRecord): "inserted" | "duplicate"
  getEvidence(id: string): EvidenceRecord | undefined

  // ── Derived memories (versioned) ────────────────────
  putMemory(record: MemoryRecord): void
  getMemory(id: string): MemoryRecord | undefined
  listMemories(filter?: MemoryFilter): MemoryRecord[]
  countMemories(filter?: Omit<MemoryFilter, "limit" | "offset">): number
  searchLexical(query: string, filter?: MemoryFilter): LexicalHit[]

  // ── Handoff (atomic claim, exactly-once logical) ────
  putHandoff(record: HandoffRecord): void
  getHandoff(id: string): HandoffRecord | undefined
  /**
   * Atomically transitions unclaimed -> claimed.
   * Returns true only to the single winner; concurrent losers get false.
   */
  claimHandoff(id: string, sessionId: string): boolean
  setHandoffState(id: string, state: HandoffClaimState): void

  // ── Pending proposals ───────────────────────────────
  putPending(record: PendingMemoryRecord): void
  listPending(status?: PendingStatus): PendingMemoryRecord[]
  setPendingStatus(id: string, status: PendingStatus): void

  // ── Feedback signals ────────────────────────────────
  addFeedback(feedback: MemoryFeedback): void

  // ── Transactions ────────────────────────────────────
  transaction<T>(fn: () => T): T

  close(): void
}
