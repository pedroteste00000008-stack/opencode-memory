/**
 * Consolidation decision helpers (§7.4-7.5, §19.4).
 *
 * Explicit ops: ADD | UPDATE | SUPERSEDE | NOOP | CONFLICT | REVIEW.
 * This module is PURE and deterministic: it encodes the state-machine
 * invariants. The Laya kernel decides the op in production; this module
 * applies it and guards illegal transitions. A small heuristic
 * `suggestOp` exists only for tests / benchmark baselines.
 */

import type { ConsolidationOp, MemoryRecord } from "./schema.js"

export interface ConsolidationOutcome {
  op: ConsolidationOp
  /** Target record for UPDATE / SUPERSEDE / CONFLICT. */
  targetId?: string
  reason: string
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Baseline heuristic (NOT the production decider).
 * Production uses Laya + existing-memory lookup; this is only for
 * benchmark comparison and unit tests of the state machine.
 */
export function suggestOp(
  candidateContent: string,
  existing: MemoryRecord[],
): ConsolidationOutcome {
  const norm = normalize(candidateContent)
  if (!norm) return { op: "NOOP", reason: "empty candidate" }
  const active = existing.filter((m) => m.status === "active")
  for (const mem of active) {
    if (normalize(mem.content) === norm) {
      return { op: "NOOP", targetId: mem.id, reason: "exact duplicate" }
    }
  }
  // Contradiction cue (very conservative; Laya decides for real).
  const negationCue =
    /\b(n(ã|a)o (use|usar|usamos)|substitu(ir|ído|ido)|em vez de|ao inv[eé]s de|deprecated|obsoleto)\b/i
  if (negationCue.test(candidateContent)) {
    const sameKind = active.find(
      (m) => m.kind === "decision" || m.kind === "constraint",
    )
    if (sameKind) {
      return {
        op: "REVIEW",
        targetId: sameKind.id,
        reason: "possible contradiction: needs Laya decision",
      }
    }
  }
  return { op: "ADD", reason: "no equivalent active memory" }
}

/**
 * Apply an op, enforcing invariants:
 * - UPDATE keeps id, bumps updatedAt, preserves sourceIds union
 * - SUPERSEDE retires old (status=superseded) and links both sides
 * - NOOP changes nothing
 * - CONFLICT / REVIEW never mutate; they route to pending
 */
export function applyConsolidationOp(
  op: ConsolidationOp,
  candidate: Omit<MemoryRecord, "id" | "createdAt" | "updatedAt" | "status"> & {
    id?: string
  },
  target: MemoryRecord | undefined,
  now: number = Date.now(),
): { record?: MemoryRecord; retired?: MemoryRecord } {
  switch (op) {
    case "ADD": {
      const record: MemoryRecord = {
        ...candidate,
        id: candidate.id ?? `mem_${now.toString(36)}`,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }
      return { record }
    }
    case "UPDATE": {
      if (!target) throw new Error("UPDATE requires a target record")
      if (target.status !== "active") {
        throw new Error("UPDATE target must be active")
      }
      const record: MemoryRecord = {
        ...target,
        content: candidate.content,
        kind: candidate.kind,
        tier: candidate.tier,
        scope: candidate.scope,
        sourceIds: Array.from(
          new Set([...target.sourceIds, ...candidate.sourceIds]),
        ),
        updatedAt: now,
      }
      return { record }
    }
    case "SUPERSEDE": {
      if (!target) throw new Error("SUPERSEDE requires a target record")
      if (target.status !== "active") {
        throw new Error("SUPERSEDE target must be active")
      }
      const replacementId = candidate.id ?? `mem_${now.toString(36)}`
      const retired: MemoryRecord = {
        ...target,
        status: "superseded",
        supersededById: replacementId,
        updatedAt: now,
        validUntil: now,
      }
      const record: MemoryRecord = {
        ...candidate,
        id: replacementId,
        status: "active",
        supersedesId: target.id,
        createdAt: now,
        updatedAt: now,
        validFrom: now,
      }
      return { record, retired }
    }
    case "NOOP":
      return {}
    case "CONFLICT":
    case "REVIEW":
      // Routed to PendingMemoryRecord by the caller; no mutation here.
      return {}
  }
}
