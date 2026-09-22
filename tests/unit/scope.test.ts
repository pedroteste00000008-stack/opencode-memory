import { describe, expect, it } from "vitest"
import {
  compareScopeSpecificity,
  isScopeVisible,
} from "../../src/scope.js"

describe("scope isolation", () => {
  it("global memories are visible everywhere", () => {
    expect(
      isScopeVisible({ level: "global" }, { level: "project", projectId: "x" }),
    ).toBe(true)
  })

  it("project memories never leak across projects", () => {
    expect(
      isScopeVisible(
        { level: "project", projectId: "a" },
        { level: "project", projectId: "b" },
      ),
    ).toBe(false)
    expect(
      isScopeVisible(
        { level: "project", projectId: "a" },
        { level: "project", projectId: "a" },
      ),
    ).toBe(true)
  })

  it("branch memories are isolated by branch", () => {
    expect(
      isScopeVisible(
        { level: "branch", projectId: "p", branch: "main" },
        { level: "branch", projectId: "p", branch: "feat" },
      ),
    ).toBe(false)
  })

  it("sorts most-specific scope first", () => {
    const scopes = [{ level: "global" }, { level: "project" }, { level: "branch" }] as const
    const sorted = [...scopes].sort(compareScopeSpecificity)
    expect(sorted[0].level).toBe("branch")
  })
})
