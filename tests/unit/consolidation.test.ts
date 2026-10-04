import { describe, expect, it } from "vitest"
import {
  applyConsolidationOp,
  suggestOp,
} from "../../src/consolidation.js"
import type { MemoryRecord } from "../../src/schema.js"

function mem(content: string, id = "m1"): MemoryRecord {
  return {
    id,
    content,
    kind: "decision",
    tier: "semantic",
    scope: { level: "project", projectId: "p" },
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    sourceIds: ["e1"],
    sourceKind: "user",
    extractorVersion: "v0",
    decisionModel: "heuristic",
  }
}

describe("consolidation state machine", () => {
  it("NOOP on exact duplicate", () => {
    const out = suggestOp("usamos postgres", [mem("Usamos  Postgres")])
    expect(out.op).toBe("NOOP")
  })

  it("ADD when nothing equivalent exists", () => {
    expect(suggestOp("preferimos typescript", []).op).toBe("ADD")
  })

  it("SUPERSEDE retires old and links both sides", () => {
    const old = mem("usamos chromadb", "old")
    const { record, retired } = applyConsolidationOp(
      "SUPERSEDE",
      {
        content: "usamos sqlite",
        kind: "decision",
        tier: "semantic",
        scope: { level: "project", projectId: "p" },
        sourceIds: ["e2"],
        sourceKind: "user",
        extractorVersion: "v0",
        decisionModel: "heuristic",
      },
      old,
      99,
    )
    expect(retired?.status).toBe("superseded")
    expect(retired?.supersededById).toBe(record?.id)
    expect(record?.supersedesId).toBe("old")
  })

  it("UPDATE keeps id and unions sources", () => {
    const old = mem("usamos sqlite", "m1")
    const { record } = applyConsolidationOp(
      "UPDATE",
      {
        content: "usamos sqlite com fts5",
        kind: "decision",
        tier: "semantic",
        scope: { level: "project", projectId: "p" },
        sourceIds: ["e2"],
        sourceKind: "user",
        extractorVersion: "v0",
        decisionModel: "heuristic",
      },
      old,
      100,
    )
    expect(record?.id).toBe("m1")
    expect(record?.sourceIds).toEqual(["e1", "e2"])
  })

  it("CONFLICT and REVIEW never mutate", () => {
    const old = mem("x", "m1")
    expect(
      applyConsolidationOp("CONFLICT", { ...old, sourceIds: ["e2"] }, old),
    ).toEqual({})
    expect(
      applyConsolidationOp("REVIEW", { ...old, sourceIds: ["e2"] }, old),
    ).toEqual({})
  })
})
