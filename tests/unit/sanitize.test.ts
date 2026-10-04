import { describe, expect, it } from "vitest"
import { isPersistableText, sanitizeForPersistence } from "../../src/sanitize.js"

describe("sanitizeForPersistence", () => {
  it("redacts secrets before persistence", () => {
    const r = sanitizeForPersistence("my api_key = supersecretvalue123")
    expect(r.text).toContain("[REDACTED:api-key-assign]")
    expect(r.redacted).toContain("api-key-assign")
  })

  it("strips control chars and bounds length", () => {
    const r = sanitizeForPersistence("ab\u0000cd", 2)
    expect(r.text).not.toContain("\u0000")
    expect(r.truncated).toBe(true)
  })

  it("rejects trivially short contents", () => {
    expect(isPersistableText("   ")).toBe(false)
    expect(isPersistableText("short!!!")).toBe(true)
  })
})
