import { afterEach, describe, expect, it } from "vitest"
import { recall } from "../../src/retrieval/search.js"
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
  extra: Partial<MemoryRecord> = {},
): MemoryRecord {
  return {
    id,
    content,
    kind: "decision",
    tier: "semantic",
    scope: { level: "project", projectId: "proj-a" },
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
    sourceIds: ["e1"],
    sourceKind: "user",
    extractorVersion: "test",
    decisionModel: "test",
    ...extra,
  }
}

const SCOPE_A = { level: "project", projectId: "proj-a" } as const

describe("recall", () => {
  it("recalls lexically matching memories", async () => {
    store = new SqliteMemoryStore()
    store.putMemory(mem("m1", "neste projeto o banco de dados e postgresql, nao mongodb"))
    store.putMemory(mem("m2", "o usuario gosta de cafe forte"))
    const res = await recall(store, {
      query: "qual banco de dados usar",
      scope: { ...SCOPE_A },
    })
    const included = res.hits.filter((h) => h.included).map((h) => h.record.id)
    expect(included).toContain("m1")
    expect(included).not.toContain("m2")
    expect(res.hits.find((h) => h.record.id === "m1")?.streams).toContain(
      "lexical",
    )
  })

  it("abstains across project boundaries", async () => {
    store = new SqliteMemoryStore()
    store.putMemory(mem("m1", "neste projeto nao use lombok"))
    const res = await recall(store, {
      query: "posso usar lombok",
      scope: { level: "project", projectId: "proj-b" },
    })
    expect(res.hits.filter((h) => h.included)).toHaveLength(0)
  })

  it("fuses lexical and dense streams and records provenance", async () => {
    store = new SqliteMemoryStore()
    store.putMemory(mem("m1", "postgresql e o banco oficial do projeto"))
    store.putMemory(mem("m2", "atas da reuniao sobre postgresql"))
    const res = await recall(store, {
      query: "postgresql",
      scope: { ...SCOPE_A },
      dense: () => [{ id: "m2", rank: 0 }],
    })
    expect(res.trace.denseEnabled).toBe(true)
    const m2 = res.hits.find((h) => h.record.id === "m2")
    expect(m2?.streams).toEqual(expect.arrayContaining(["lexical", "dense"]))
  })

  it("enforces the token budget with an explained exclusion", async () => {
    store = new SqliteMemoryStore()
    store.putMemory(mem("m1", "postgresql ".repeat(50)))
    store.putMemory(mem("m2", "postgresql e otimo"))
    const res = await recall(store, {
      query: "postgresql",
      scope: { ...SCOPE_A },
      maxChars: 100,
    })
    const excluded = res.hits.filter((h) => !h.included)
    expect(excluded.length).toBeGreaterThan(0)
    expect(excluded[0].excludedReason).toMatch(/token-budget|top-k/)
  })

  it("returns empty hits (abstention) when nothing matches", async () => {
    store = new SqliteMemoryStore()
    const res = await recall(store, {
      query: "senha do banco de producao",
      scope: { ...SCOPE_A },
    })
    expect(res.hits).toHaveLength(0)
  })
})
