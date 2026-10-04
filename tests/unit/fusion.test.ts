import { describe, expect, it } from "vitest"
import { reciprocalRankFusion } from "../../src/retrieval/fusion.js"

describe("reciprocal rank fusion", () => {
  it("ranks items present in multiple streams first", () => {
    const fused = reciprocalRankFusion([
      [
        { id: "a", rank: 0 },
        { id: "b", rank: 1 },
      ],
      [
        { id: "b", rank: 0 },
        { id: "c", rank: 1 },
      ],
    ])
    expect(fused[0].id).toBe("b")
  })

  it("never averages raw backend scores", () => {
    const fused = reciprocalRankFusion([[{ id: "x", rank: 5 }]])
    expect(fused[0].score).toBeCloseTo(1 / (60 + 5 + 1))
  })
})
