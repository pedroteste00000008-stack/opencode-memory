/**
 * SQLite canonical store (benchmark candidate, provisional default).
 *
 * - One file holds canonical tables + FTS5 lexical index.
 * - FTS rows are maintained in the SAME transaction as the canonical
 *   write, so the two can never diverge on a committed operation.
 * - node:sqlite is synchronous: within one process, statements cannot
 *   interleave, which gives the single-writer discipline (§23.11.1).
 *   Multi-step mutations additionally run inside explicit transactions.
 * - Scope filtering mirrors src/scope.ts `isScopeVisible` in SQL.
 */

import { createRequire } from "node:module"
import type {
  EvidenceRecord,
  HandoffClaimState,
  HandoffRecord,
  MemoryFeedback,
  MemoryRecord,
  MemoryScope,
  PendingMemoryRecord,
  PendingStatus,
} from "../schema.js"
import type { CanonicalStore, LexicalHit, MemoryFilter } from "./types.js"

// Loaded via require(): vitest 1.x's vite pipeline does not recognize
// the `node:sqlite` builtin specifier and tries to bundle it.
// Runtime require() bypasses the transform; types still come from
// @types/node. Revisit when the test runner is upgraded.
const require = createRequire(import.meta.url)
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite")

type SqlParam = string | number | bigint | null

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  project_id TEXT, repository TEXT, workspace_id TEXT, worktree TEXT,
  branch TEXT, session_id TEXT, task_id TEXT,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  kind TEXT NOT NULL,
  tier TEXT NOT NULL,
  scope_level TEXT NOT NULL,
  project_id TEXT, organization_id TEXT, repository TEXT,
  workspace_id TEXT, worktree TEXT, branch TEXT, session_id TEXT, task_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  superseded_by_id TEXT, supersedes_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  valid_from INTEGER, valid_until INTEGER,
  source_ids TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  confidence REAL,
  relations TEXT,
  extractor_version TEXT NOT NULL,
  decision_model TEXT NOT NULL,
  embedding_model TEXT, embedding_version TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_scope
  ON memories(scope_level, project_id, branch, session_id);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
  USING fts5(id UNINDEXED, content, tokenize = 'unicode61');

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  completed_work TEXT NOT NULL,
  failed_attempts TEXT NOT NULL,
  open_questions TEXT NOT NULL,
  next_steps TEXT NOT NULL,
  project_id TEXT, repository TEXT, workspace_id TEXT, worktree TEXT,
  branch TEXT, last_commit TEXT,
  origin_session_id TEXT NOT NULL,
  claim_state TEXT NOT NULL DEFAULT 'unclaimed',
  claimed_by_session_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS pending (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  kind TEXT NOT NULL,
  tier TEXT NOT NULL,
  scope_level TEXT NOT NULL,
  project_id TEXT, branch TEXT, session_id TEXT, task_id TEXT,
  workspace_id TEXT, organization_id TEXT,
  source_ids TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  proposed_op TEXT NOT NULL,
  target_id TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  extractor_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_memory ON feedback(memory_id);
`

/** Minimal PT/EN stopwords: bare OR matching on articles and
 *  prepositions destroys precision (e.g. "de" matching everything). */
const STOPWORDS = new Set(
  "o,a,os,as,um,uma,de,da,do,das,dos,em,no,na,nos,nas,por,para,com,sem,sob,e,ou,que,se,como,mais,mas,ao,aos,the,an,of,in,on,at,to,for,and,or,is,are,was,be,with,by,from,as,it,this,that".split(
    ",",
  ),
)

/** Escape user text into a safe FTS5 OR query (prevents syntax errors). */
export function escapeFtsQuery(query: string): string {
  const terms = query
    .split(/[^\p{L}\p{N}]+/gu)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .slice(0, 10)
  if (terms.length === 0) return ""
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ")
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** Required scope columns per level; writers must satisfy these. */
function assertScopeColumns(scope: MemoryScope): void {
  const need: string[] = []
  if (scope.level === "organization" && !scope.organizationId)
    need.push("organizationId")
  if (
    (scope.level === "project" ||
      scope.level === "workspace" ||
      scope.level === "branch") &&
    !scope.projectId
  )
    need.push("projectId")
  if (scope.level === "workspace" && !scope.workspaceId)
    need.push("workspaceId")
  if (scope.level === "branch" && !scope.branch) need.push("branch")
  if (scope.level === "session" && !scope.sessionId) need.push("sessionId")
  if (scope.level === "task" && !scope.taskId) need.push("taskId")
  if (need.length > 0) {
    throw new Error(
      `[memory] scope '${scope.level}' requires: ${need.join(", ")}`,
    )
  }
}

interface ScopeClause {
  sql: string
  params: SqlParam[]
}

/** SQL mirror of `isScopeVisible` (src/scope.ts). */
function scopeClause(req: MemoryScope): ScopeClause {
  const params: SqlParam[] = []
  const branches: string[] = ["scope_level = 'global'"]
  if (req.organizationId !== undefined) {
    branches.push("(scope_level = 'organization' AND organization_id = ?)")
    params.push(req.organizationId)
  }
  if (req.projectId !== undefined) {
    branches.push("(scope_level = 'project' AND project_id = ?)")
    params.push(req.projectId)
    if (req.workspaceId !== undefined) {
      branches.push(
        "(scope_level = 'workspace' AND project_id = ? AND workspace_id = ?)",
      )
      params.push(req.projectId, req.workspaceId)
    }
    if (req.branch !== undefined) {
      branches.push(
        "(scope_level = 'branch' AND project_id = ? AND branch = ?)",
      )
      params.push(req.projectId, req.branch)
    }
  }
  if (req.sessionId !== undefined) {
    branches.push("(scope_level = 'session' AND session_id = ?)")
    params.push(req.sessionId)
  }
  if (req.taskId !== undefined) {
    branches.push("(scope_level = 'task' AND task_id = ?)")
    params.push(req.taskId)
  }
  return { sql: `(${branches.join(" OR ")})`, params }
}

function memoryWhere(filter: MemoryFilter): ScopeClause {
  const conds: string[] = []
  const params: SqlParam[] = []
  if (filter.scope !== undefined) {
    const s = scopeClause(filter.scope)
    conds.push(s.sql)
    params.push(...s.params)
  }
  if (filter.kinds !== undefined && filter.kinds.length > 0) {
    conds.push(`kind IN (${filter.kinds.map(() => "?").join(",")})`)
    params.push(...filter.kinds)
  }
  if (filter.tiers !== undefined && filter.tiers.length > 0) {
    conds.push(`tier IN (${filter.tiers.map(() => "?").join(",")})`)
    params.push(...filter.tiers)
  }
  const status = filter.status === undefined ? ["active"] : filter.status
  if (status !== null) {
    conds.push(`status IN (${status.map(() => "?").join(",")})`)
    params.push(...status)
  }
  const now = filter.now === undefined ? Date.now() : filter.now
  if (now !== null) {
    conds.push("(valid_from IS NULL OR valid_from <= ?)")
    conds.push("(valid_until IS NULL OR valid_until > ?)")
    params.push(now, now)
  }
  return {
    sql: conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "",
    params,
  }
}

type MemoryRow = Record<string, string | number | null>

function rowToMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row["id"] as string,
    content: row["content"] as string,
    kind: row["kind"] as MemoryRecord["kind"],
    tier: row["tier"] as MemoryRecord["tier"],
    scope: {
      level: row["scope_level"] as MemoryRecord["scope"]["level"],
      projectId: (row["project_id"] as string | null) ?? undefined,
      organizationId: (row["organization_id"] as string | null) ?? undefined,
      repository: (row["repository"] as string | null) ?? undefined,
      workspaceId: (row["workspace_id"] as string | null) ?? undefined,
      worktree: (row["worktree"] as string | null) ?? undefined,
      branch: (row["branch"] as string | null) ?? undefined,
      sessionId: (row["session_id"] as string | null) ?? undefined,
      taskId: (row["task_id"] as string | null) ?? undefined,
    },
    status: row["status"] as MemoryRecord["status"],
    supersededById:
      (row["superseded_by_id"] as string | null) ?? undefined,
    supersedesId: (row["supersedes_id"] as string | null) ?? undefined,
    createdAt: row["created_at"] as number,
    updatedAt: row["updated_at"] as number,
    validFrom: (row["valid_from"] as number | null) ?? undefined,
    validUntil: (row["valid_until"] as number | null) ?? undefined,
    sourceIds: parseJson<string[]>(row["source_ids"] as string, []),
    sourceKind: row["source_kind"] as MemoryRecord["sourceKind"],
    confidence: (row["confidence"] as number | null) ?? undefined,
    relations: parseJson(row["relations"] as string | null, undefined),
    extractorVersion: row["extractor_version"] as string,
    decisionModel: row["decision_model"] as string,
    embeddingModel:
      (row["embedding_model"] as string | null) ?? undefined,
    embeddingVersion:
      (row["embedding_version"] as string | null) ?? undefined,
    metadata: parseJson(row["metadata"] as string | null, undefined),
  }
}

export class SqliteMemoryStore implements CanonicalStore {
  private db: InstanceType<typeof DatabaseSync>
  private txnDepth = 0

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path)
    this.db.exec(SCHEMA)
  }

  transaction<T>(fn: () => T): T {
    // Re-entrant: putMemory and other multi-step writers are already
    // transactional, so outer orchestrators can wrap them freely.
    if (this.txnDepth > 0) return fn()
    this.txnDepth += 1
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const out = fn()
      this.db.exec("COMMIT")
      return out
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    } finally {
      this.txnDepth = 0
    }
  }

  putEvidence(record: EvidenceRecord): "inserted" | "duplicate" {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO evidence
         (id, content, source_kind, created_at, idempotency_key,
          project_id, repository, workspace_id, worktree, branch,
          session_id, task_id, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.content,
        record.sourceKind,
        record.createdAt,
        record.idempotencyKey,
        record.projectId ?? null,
        record.repository ?? null,
        record.workspaceId ?? null,
        record.worktree ?? null,
        record.branch ?? null,
        record.sessionId ?? null,
        record.taskId ?? null,
        json(record.metadata),
      )
    return res.changes === 1 ? "inserted" : "duplicate"
  }

  getEvidence(id: string): EvidenceRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM evidence WHERE id = ?")
      .get(id) as MemoryRow | undefined
    if (!row) return undefined
    return {
      id: row["id"] as string,
      content: row["content"] as string,
      sourceKind: row["source_kind"] as EvidenceRecord["sourceKind"],
      createdAt: row["created_at"] as number,
      idempotencyKey: row["idempotency_key"] as string,
      projectId: (row["project_id"] as string | null) ?? undefined,
      repository: (row["repository"] as string | null) ?? undefined,
      workspaceId: (row["workspace_id"] as string | null) ?? undefined,
      worktree: (row["worktree"] as string | null) ?? undefined,
      branch: (row["branch"] as string | null) ?? undefined,
      sessionId: (row["session_id"] as string | null) ?? undefined,
      taskId: (row["task_id"] as string | null) ?? undefined,
      metadata: parseJson(row["metadata"] as string | null, undefined),
    }
  }

  putMemory(record: MemoryRecord): void {
    assertScopeColumns(record.scope)
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memories
           (id, content, kind, tier, scope_level,
            project_id, organization_id, repository, workspace_id, worktree,
            branch, session_id, task_id, status, superseded_by_id, supersedes_id,
            created_at, updated_at, valid_from, valid_until, source_ids,
            source_kind, confidence, relations, extractor_version,
            decision_model, embedding_model, embedding_version, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             content = excluded.content, kind = excluded.kind,
             tier = excluded.tier, scope_level = excluded.scope_level,
             project_id = excluded.project_id,
             organization_id = excluded.organization_id,
             repository = excluded.repository,
             workspace_id = excluded.workspace_id,
             worktree = excluded.worktree, branch = excluded.branch,
             session_id = excluded.session_id, task_id = excluded.task_id,
             status = excluded.status,
             superseded_by_id = excluded.superseded_by_id,
             supersedes_id = excluded.supersedes_id,
             updated_at = excluded.updated_at,
             valid_from = excluded.valid_from,
             valid_until = excluded.valid_until,
             source_ids = excluded.source_ids,
             source_kind = excluded.source_kind,
             confidence = excluded.confidence, relations = excluded.relations,
             extractor_version = excluded.extractor_version,
             decision_model = excluded.decision_model,
             embedding_model = excluded.embedding_model,
             embedding_version = excluded.embedding_version,
             metadata = excluded.metadata`,
        )
        .run(
          record.id,
          record.content,
          record.kind,
          record.tier,
          record.scope.level,
          record.scope.projectId ?? null,
          record.scope.organizationId ?? null,
          record.scope.repository ?? null,
          record.scope.workspaceId ?? null,
          record.scope.worktree ?? null,
          record.scope.branch ?? null,
          record.scope.sessionId ?? null,
          record.scope.taskId ?? null,
          record.status,
          record.supersededById ?? null,
          record.supersedesId ?? null,
          record.createdAt,
          record.updatedAt,
          record.validFrom ?? null,
          record.validUntil ?? null,
          json(record.sourceIds),
          record.sourceKind,
          record.confidence ?? null,
          json(record.relations),
          record.extractorVersion,
          record.decisionModel,
          record.embeddingModel ?? null,
          record.embeddingVersion ?? null,
          json(record.metadata),
        )
      // Derived FTS index updated in the SAME transaction.
      this.db
        .prepare("DELETE FROM memories_fts WHERE id = ?")
        .run(record.id)
      if (record.status === "active") {
        this.db
          .prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)")
          .run(record.id, record.content)
      }
    })
  }

  getMemory(id: string): MemoryRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as MemoryRow | undefined
    return row ? rowToMemory(row) : undefined
  }

  listMemories(filter: MemoryFilter = {}): MemoryRecord[] {
    const w = memoryWhere(filter)
    let sql = `SELECT * FROM memories ${w.sql} ORDER BY updated_at DESC`
    const params = [...w.params]
    if (filter.limit !== undefined) {
      sql += " LIMIT ?"
      params.push(filter.limit)
    }
    if (filter.offset !== undefined) {
      if (filter.limit === undefined) sql += " LIMIT -1"
      sql += " OFFSET ?"
      params.push(filter.offset)
    }
    const rows = this.db.prepare(sql).all(...params) as MemoryRow[]
    return rows.map(rowToMemory)
  }

  countMemories(
    filter: Omit<MemoryFilter, "limit" | "offset"> = {},
  ): number {
    const w = memoryWhere(filter)
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM memories ${w.sql}`)
      .get(...w.params) as { n: number }
    return row.n
  }

  searchLexical(query: string, filter: MemoryFilter = {}): LexicalHit[] {
    const fts = escapeFtsQuery(query)
    if (!fts) return []
    const w = memoryWhere({ ...filter, status: filter.status ?? ["active"] })
    // Join FTS hits against the canonical table so scope / validity /
    // status filters apply to the same rows the index points to.
    const sql = `
      SELECT m.*, bm25(memories_fts) AS rank
      FROM memories_fts
      JOIN memories m ON m.id = memories_fts.id
      ${w.sql ? `${w.sql} AND` : "WHERE"} memories_fts MATCH ?
      ORDER BY rank
      ${filter.limit !== undefined ? "LIMIT ?" : "LIMIT 50"}`
    const params =
      filter.limit !== undefined
        ? [...w.params, fts, filter.limit]
        : [...w.params, fts]
    const rows = this.db.prepare(sql).all(...params) as Array<
      MemoryRow & { rank: number }
    >
    return rows.map((r) => ({ record: rowToMemory(r), rank: r.rank }))
  }

  putHandoff(record: HandoffRecord): void {
    this.db
      .prepare(
        `INSERT INTO handoffs
         (id, summary, completed_work, failed_attempts, open_questions,
          next_steps, project_id, repository, workspace_id, worktree, branch,
          last_commit, origin_session_id, claim_state, claimed_by_session_id,
          created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        record.id,
        record.summary,
        json(record.completedWork),
        json(record.failedAttempts),
        json(record.openQuestions),
        json(record.nextSteps),
        record.projectId ?? null,
        record.repository ?? null,
        record.workspaceId ?? null,
        record.worktree ?? null,
        record.branch ?? null,
        record.lastCommit ?? null,
        record.originSessionId,
        record.claimState,
        record.claimedBySessionId ?? null,
        record.createdAt,
        record.expiresAt ?? null,
      )
  }

  getHandoff(id: string): HandoffRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM handoffs WHERE id = ?")
      .get(id) as MemoryRow | undefined
    if (!row) return undefined
    return {
      id: row["id"] as string,
      summary: row["summary"] as string,
      completedWork: parseJson<string[]>(row["completed_work"] as string, []),
      failedAttempts: parseJson<string[]>(row["failed_attempts"] as string, []),
      openQuestions: parseJson<string[]>(row["open_questions"] as string, []),
      nextSteps: parseJson<string[]>(row["next_steps"] as string, []),
      projectId: (row["project_id"] as string | null) ?? undefined,
      repository: (row["repository"] as string | null) ?? undefined,
      workspaceId: (row["workspace_id"] as string | null) ?? undefined,
      worktree: (row["worktree"] as string | null) ?? undefined,
      branch: (row["branch"] as string | null) ?? undefined,
      lastCommit: (row["last_commit"] as string | null) ?? undefined,
      originSessionId: row["origin_session_id"] as string,
      claimState: row["claim_state"] as HandoffRecord["claimState"],
      claimedBySessionId:
        (row["claimed_by_session_id"] as string | null) ?? undefined,
      createdAt: row["created_at"] as number,
      expiresAt: (row["expires_at"] as number | null) ?? undefined,
    }
  }

  claimHandoff(id: string, sessionId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE handoffs
         SET claim_state = 'claimed', claimed_by_session_id = ?
         WHERE id = ? AND claim_state = 'unclaimed'`,
      )
      .run(sessionId, id)
    return res.changes === 1
  }

  setHandoffState(id: string, state: HandoffClaimState): void {
    this.db
      .prepare("UPDATE handoffs SET claim_state = ? WHERE id = ?")
      .run(state, id)
  }

  putPending(record: PendingMemoryRecord): void {
    this.db
      .prepare(
        `INSERT INTO pending
         (id, content, kind, tier, scope_level, project_id, branch,
          session_id, task_id, workspace_id, organization_id, source_ids,
          source_kind, proposed_op, target_id, reason, status, created_at,
          updated_at, extractor_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.content,
        record.kind,
        record.tier,
        record.scope.level,
        record.scope.projectId ?? null,
        record.scope.branch ?? null,
        record.scope.sessionId ?? null,
        record.scope.taskId ?? null,
        record.scope.workspaceId ?? null,
        record.scope.organizationId ?? null,
        json(record.sourceIds),
        record.sourceKind,
        record.proposedOp,
        record.targetId ?? null,
        record.reason ?? null,
        record.status,
        record.createdAt,
        record.updatedAt,
        record.extractorVersion,
      )
  }

  listPending(status?: PendingMemoryRecord["status"]): PendingMemoryRecord[] {
    const rows = (
      status === undefined
        ? this.db.prepare("SELECT * FROM pending ORDER BY created_at DESC").all()
        : this.db
            .prepare("SELECT * FROM pending WHERE status = ? ORDER BY created_at DESC")
            .all(status)
    ) as MemoryRow[]
    return rows.map((row) => ({
      id: row["id"] as string,
      content: row["content"] as string,
      kind: row["kind"] as PendingMemoryRecord["kind"],
      tier: row["tier"] as PendingMemoryRecord["tier"],
      scope: {
        level: row["scope_level"] as PendingMemoryRecord["scope"]["level"],
        projectId: (row["project_id"] as string | null) ?? undefined,
        branch: (row["branch"] as string | null) ?? undefined,
        sessionId: (row["session_id"] as string | null) ?? undefined,
        taskId: (row["task_id"] as string | null) ?? undefined,
        workspaceId: (row["workspace_id"] as string | null) ?? undefined,
        organizationId:
          (row["organization_id"] as string | null) ?? undefined,
      },
      sourceIds: parseJson<string[]>(row["source_ids"] as string, []),
      sourceKind: row["source_kind"] as PendingMemoryRecord["sourceKind"],
      proposedOp: row["proposed_op"] as PendingMemoryRecord["proposedOp"],
      targetId: (row["target_id"] as string | null) ?? undefined,
      reason: (row["reason"] as string | null) ?? undefined,
      status: row["status"] as PendingMemoryRecord["status"],
      createdAt: row["created_at"] as number,
      updatedAt: row["updated_at"] as number,
      extractorVersion: row["extractor_version"] as string,
    }))
  }

  setPendingStatus(
    id: string,
    status: PendingMemoryRecord["status"],
  ): void {
    this.db
      .prepare(
        "UPDATE pending SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, Date.now(), id)
  }

  addFeedback(feedback: MemoryFeedback): void {
    this.db
      .prepare(
        `INSERT INTO feedback
         (memory_id, kind, session_id, created_at, note)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        feedback.memoryId,
        feedback.kind,
        feedback.sessionId ?? null,
        feedback.createdAt,
        feedback.note ?? null,
      )
  }

  close(): void {
    this.db.close()
  }
}
