/**
 * Rank fusion for heterogeneous retrieval streams (§8, §23.5).
 *
 * Never average raw scores from different backends (different scales
 * and directions). Use Reciprocal Rank Fusion over rank positions.
 */

export interface RankedItem {
  id: string
  rank: number // 0-based within its stream
}

export function reciprocalRankFusion(
  streams: RankedItem[][],
  k = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>()
  for (const stream of streams) {
    for (const item of stream) {
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + item.rank + 1))
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
}
