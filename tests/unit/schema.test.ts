import { describe, expect, it } from "vitest"
import {
  isConsolidationOp,
  isMemoryKind,
  isMemoryTier,
  isRelationType,
} from "../../src/schema.js"

describe("schema guards", () => {
  it("accepts all memory kinds", () => {
    for (const k of [
      "preference",
      "decision",
      "fact",
      "constraint",
      "procedure",
      "failure_lesson",
      "project_state",
      "relationship",
    ]) {
      expect(isMemoryKind(k)).toBe(true)
    }
    expect(isMemoryKind("conversations")).toBe(false)
  })

  it("accepts tiers and rejects legacy collections", () => {
    expect(isMemoryTier("working")).toBe(true)
    expect(isMemoryTier("semantic")).toBe(true)
    expect(isMemoryTier("facts")).toBe(false)
  })

  it("accepts the closed relation set", () => {
    expect(isRelationType("supersedes")).toBe(true)
    expect(isRelationType("likes")).toBe(false)
  })

  it("accepts consolidation ops including REVIEW", () => {
    for (const op of ["ADD", "UPDATE", "SUPERSEDE", "NOOP", "CONFLICT", "REVIEW"]) {
      expect(isConsolidationOp(op)).toBe(true)
    }
    expect(isConsolidationOp("DELETE")).toBe(false)
  })
})
