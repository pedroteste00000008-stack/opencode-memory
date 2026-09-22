import { afterEach, describe, expect, it } from "vitest"
import { applyConsolidationOp } from "../../src/consolidation.js"
import type { MemoryRecord } from "../../src/schema.js"
import { SqliteMemoryStore } from "../../src/storage/sqlite.js"

let store: SqliteMemoryStore | null = null

afterEach(() => {
  store?.close()
  store = null
})

function mem(
  id: string,
  content: string,
  scope: MemoryRecord["scope"] = { level: "project", projectId: "proj-a" },
): MemoryRecord {
  return {
    id,
    content,
    kind: "decision",
    tier: "semantic",
    scope,
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
    sourceIds: ["e1"],
    sourceKind: "user",
    extractorVersion: "test",
    decisionModel: "test",
  }
}

describe("SqliteMemoryStore", () => {
  it("deduplicates evidence by idempotency key (safe replay)", () => {
    store = new SqliteMemoryStore()
    const ev = {
      id: "ev1",
      content: "hello",
      sourceKind: "user" as const,
      createdAt: 1,
      idempotencyKey: "k1",
    }
    expect(store.putEvidence(ev)).toBe("inserted")
    expect(store.putEvidence({ ...ev, id: "ev2" })).toBe("duplicate")
    expect(store.getEvidence("ev1")?.content).toBe("hello")
  })

  it("applies SUPERSEDE atomically and hides retired memory from FTS", () => {
    store = new SqliteMemoryStore()
    const s = store
    s.putMemory(mem("old", "neste projeto usaremos chromadb"))
    const { record, retired } = applyConsolidationOp(
      "SUPERSEDE",
      {
        content: "decidimos substituir chromadb por sqlite",
        kind: "decision",
        tier: "semantic",
        scope: { level: "project", projectId: "proj-a" },
        sourceIds: ["e2"],
        sourceKind: "user",
        extractorVersion: "test",
        decisionModel: "test",
      },
      s.getMemory("old"),
      2000,
    )
    s.transaction(() => {
      s.putMemory(retired!)
      s.putMemory(record!)
    })
    expect(s.getMemory("old")?.status).toBe("superseded")
    expect(s.searchLexical("chromadb").map((h) => h.record.id)).not.toContain(
      "old",
    )
    expect(
      s.searchLexical("sqlite").map((h) => h.record.id),
    ).toContain(record!.id)
  })

  it("enforces scope isolation in SQL", () => {
    store = new SqliteMemoryStore()
    store.putMemory(mem("a", "não use lombock neste projeto"))
    const other = store.listMemories({
      scope: { level: "project", projectId: "proj-b" },
    })
    expect(other).toHaveLength(0)
    const same = store.listMemories({
      scope: { level: "project", projectId: "proj-a" },
    })
    expect(same.map((m) => m.id)).toContain("a")
  })

  it("rejects memories with incomplete scope columns", () => {
    store = new SqliteMemoryStore()
    expect(() =>
      store.putMemory(mem("bad", "x", { level: "branch" })),
    ).toThrow(/requires/)
  })

  it("respects validity windows", () => {
    store = new SqliteMemoryStore()
    store.putMemory({
      ...mem("exp", "registry migration state"),
      validFrom: 1000,
      validUntil: 1500,
    })
    expect(store.listMemories({ now: 2000 })).toHaveLength(0)
    expect(
      store.listMemories({ now: 1200 }).map((m) => m.id),
    ).toContain("exp")
  })

  it("grants handoff claim exactly once", () => {
    store = new SqliteMemoryStore()
    store.putHandoff({
      id: "h1",
      summary: "wip",
      completedWork: [],
      failedAttempts: [],
      openQuestions: [],
      nextSteps: ["resume"],
      originSessionId: "s1",
      claimState: "unclaimed",
      createdAt: 1,
    })
    expect(store.claimHandoff("h1", "s2")).toBe(true)
    expect(store.claimHandoff("h1", "s3")).toBe(false)
    expect(store.getHandoff("h1")?.claimedBySessionId).toBe("s2")
  })

  it("tracks pending proposals through review", () => {
    store = new SqliteMemoryStore()
    store.putPending({
      id: "p1",
      content: "maybe deploy via bare metal",
      kind: "fact",
      tier: "semantic",
      scope: { level: "project", projectId: "proj-a" },
      sourceIds: ["e9"],
      sourceKind: "assistant",
      proposedOp: "REVIEW",
      status: "pending",
      createdAt: 1,
      updatedAt: 1,
      extractorVersion: "test",
    })
    expect(store.listPending("pending")).toHaveLength(1)
    store.setPendingStatus("p1", "rejected")
    expect(store.listPending("pending")).toHaveLength(0)
  })
})
