/**
 * Canonical schema v1 for opencode-memory.
 *
 * Follows docs/08-deep-research-and-revised-architecture.md §§4-6, 23:
 * - evidence and derived memory are separate layers
 * - single canonical store with `kind` (+ `tier`), not physical collections
 * - scope is an independent dimension
 * - versioning via supersession, never silent overwrite
 * - typed relations without requiring a graph database
 *
 * Embeddings / FTS / entity indexes are DERIVED and rebuildable.
 * They must never be treated as source of truth.
 */

/** Semantic type: WHAT the memory means. */
export type MemoryKind =
  | "preference"
  | "decision"
  | "fact"
  | "constraint"
  | "procedure"
  | "failure_lesson"
  | "project_state"
  | "relationship"

export const MEMORY_KINDS: readonly MemoryKind[] = [
  "preference",
  "decision",
  "fact",
  "constraint",
  "procedure",
  "failure_lesson",
  "project_state",
  "relationship",
] as const

/**
 * Operational tier: HOW the memory should behave
 * (retention, decay, promotion). Orthogonal to `kind`.
 */
export type MemoryTier = "working" | "episodic" | "semantic" | "procedural"

export const MEMORY_TIERS: readonly MemoryTier[] = [
  "working",
  "episodic",
  "semantic",
  "procedural",
] as const

/** Lifecycle status of a derived memory. */
export type MemoryStatus = "active" | "superseded" | "retracted"

/** Where a piece of evidence / memory came from. Drives authority ranking. */
export type SourceKind = "user" | "assistant" | "tool" | "test" | "git" | "system"

export const SOURCE_KINDS: readonly SourceKind[] = [
  "user",
  "assistant",
  "tool",
  "test",
  "git",
  "system",
] as const

/**
 * Scope level. Same `kind` may exist at several levels;
 * retrieval must prefer the most specific authorized scope.
 */
export type ScopeLevel =
  | "global"
  | "organization"
  | "project"
  | "workspace"
  | "branch"
  | "session"
  | "task"

export const SCOPE_PRECEDENCE: readonly ScopeLevel[] = [
  "global",
  "organization",
  "project",
  "workspace",
  "branch",
  "session",
  "task",
] as const

/** Typed relations between records. Small closed set for v1. */
export type RelationType =
  | "supports"
  | "contradicts"
  | "supersedes"
  | "caused_by"
  | "fixes"
  | "depends_on"
  | "derived_from"
  | "related_to"

export const RELATION_TYPES: readonly RelationType[] = [
  "supports",
  "contradicts",
  "supersedes",
  "caused_by",
  "fixes",
  "depends_on",
  "derived_from",
  "related_to",
] as const

export interface MemoryScope {
  level: ScopeLevel
  projectId?: string
  organizationId?: string
  repository?: string
  workspaceId?: string
  worktree?: string
  branch?: string
  sessionId?: string
  taskId?: string
}

export interface Relation {
  type: RelationType
  targetId: string
  /** Provenance: model inference must be labelled as such, never as fact. */
  provenance: SourceKind | "model-inference"
  createdAt: number
}

/**
 * Evidence: immutable / append-only record of what actually happened.
 * Source-auditable. Never silently rewritten.
 */
export interface EvidenceRecord {
  id: string
  content: string
  sourceKind: SourceKind
  createdAt: number
  /** Stable idempotency key for safe replay / retry. */
  idempotencyKey: string
  projectId?: string
  repository?: string
  workspaceId?: string
  worktree?: string
  branch?: string
  sessionId?: string
  taskId?: string
  metadata?: Record<string, unknown>
}

/**
 * Derived memory: self-contained unit created from one or more evidences.
 * Points back to its sources. Versioned via supersession.
 */
export interface MemoryRecord {
  id: string
  content: string
  kind: MemoryKind
  tier: MemoryTier
  scope: MemoryScope

  status: MemoryStatus
  /** Set when status is `superseded`: the replacement record. */
  supersededById?: string
  /** Set on the replacement: the record it replaces. */
  supersedesId?: string

  createdAt: number
  updatedAt: number
  validFrom?: number
  validUntil?: number

  sourceIds: string[]
  /** Highest-authority origin among sources; used for ranking, not truth. */
  sourceKind: SourceKind
  confidence?: number

  relations?: Relation[]

  extractorVersion: string
  decisionModel: string
  embeddingModel?: string
  embeddingVersion?: string

  metadata?: Record<string, unknown>
}

/** Consolidation operations (§7.4 + §23). */
export type ConsolidationOp =
  | "ADD"
  | "UPDATE"
  | "SUPERSEDE"
  | "NOOP"
  | "CONFLICT"
  | "REVIEW"

export const CONSOLIDATION_OPS: readonly ConsolidationOp[] = [
  "ADD",
  "UPDATE",
  "SUPERSEDE",
  "NOOP",
  "CONFLICT",
  "REVIEW",
] as const

/**
 * Proposal produced by an (async, isolated) extractor over completed
 * sessions. Ambiguous proposals stay pending; promotion keeps
 * source ids and versions.
 */
export type PendingStatus = "pending" | "accepted" | "rejected" | "expired"

export interface PendingMemoryRecord {
  id: string
  content: string
  kind: MemoryKind
  tier: MemoryTier
  scope: MemoryScope
  sourceIds: string[]
  sourceKind: SourceKind
  proposedOp: ConsolidationOp
  /** Target of UPDATE / SUPERSEDE, when applicable. */
  targetId?: string
  reason?: string
  status: PendingStatus
  createdAt: number
  updatedAt: number
  extractorVersion: string
}

/**
 * Handoff: transient execution state for session continuity.
 * Separate protocol from durable semantic memory.
 * Exactly-once at the logical level via atomic claim.
 */
export type HandoffClaimState = "unclaimed" | "claimed" | "consumed" | "expired"

export interface HandoffRecord {
  id: string
  summary: string
  completedWork: string[]
  failedAttempts: string[]
  openQuestions: string[]
  nextSteps: string[]
  projectId?: string
  repository?: string
  workspaceId?: string
  worktree?: string
  branch?: string
  lastCommit?: string
  originSessionId: string
  claimState: HandoffClaimState
  claimedBySessionId?: string
  createdAt: number
  expiresAt?: number
}

/** Feedback signals for future ranking / decay (no magic score in v1). */
export type MemoryFeedbackKind =
  | "recalled_used"
  | "marked_useful"
  | "marked_irrelevant"
  | "reconfirmed"
  | "contradicted"
  | "superseded"

export interface MemoryFeedback {
  memoryId: string
  kind: MemoryFeedbackKind
  sessionId?: string
  createdAt: number
  note?: string
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return (
    typeof value === "string" &&
    (MEMORY_KINDS as readonly string[]).includes(value)
  )
}

export function isMemoryTier(value: unknown): value is MemoryTier {
  return (
    typeof value === "string" &&
    (MEMORY_TIERS as readonly string[]).includes(value)
  )
}

export function isRelationType(value: unknown): value is RelationType {
  return (
    typeof value === "string" &&
    (RELATION_TYPES as readonly string[]).includes(value)
  )
}

export function isConsolidationOp(value: unknown): value is ConsolidationOp {
  return (
    typeof value === "string" &&
    (CONSOLIDATION_OPS as readonly string[]).includes(value)
  )
}
