/**
 * Scope handling (§6): independent dimension + precedence + isolation.
 *
 * - retrieval prefers the most specific authorized scope
 * - never mix projects by similarity without explicit authorization
 */

import type { MemoryScope, ScopeLevel } from "./schema.js"
import { SCOPE_PRECEDENCE } from "./schema.js"

export function scopeRank(level: ScopeLevel): number {
  return SCOPE_PRECEDENCE.indexOf(level)
}

/**
 * True when a memory in `memoryScope` is visible from `requestScope`.
 * Global memories are visible everywhere; project memories only
 * inside the same project; branch inside same branch; etc.
 */
export function isScopeVisible(
  memoryScope: MemoryScope,
  requestScope: MemoryScope,
): boolean {
  if (memoryScope.level === "global") return true
  switch (memoryScope.level) {
    case "organization":
      return (
        memoryScope.organizationId !== undefined &&
        memoryScope.organizationId === requestScope.organizationId
      )
    case "project":
      return (
        memoryScope.projectId !== undefined &&
        memoryScope.projectId === requestScope.projectId
      )
    case "workspace":
      if (memoryScope.projectId !== requestScope.projectId) return false
      return (
        memoryScope.workspaceId !== undefined &&
        memoryScope.workspaceId === requestScope.workspaceId
      )
    case "branch":
      if (memoryScope.projectId !== requestScope.projectId) return false
      return (
        memoryScope.branch !== undefined &&
        memoryScope.branch === requestScope.branch
      )
    case "session":
      return (
        memoryScope.sessionId !== undefined &&
        memoryScope.sessionId === requestScope.sessionId
      )
    case "task":
      return (
        memoryScope.taskId !== undefined &&
        memoryScope.taskId === requestScope.taskId
      )
  }
}

/** Sort most-specific scope first (higher precedence rank first). */
export function compareScopeSpecificity(a: MemoryScope, b: MemoryScope): number {
  return scopeRank(b.level) - scopeRank(a.level)
}
