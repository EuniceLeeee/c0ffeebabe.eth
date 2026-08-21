/**
 * One production policy owns every startup observation range that can
 * nominate an instance or an edge. Historical universe files are warm
 * nominations only: neither an environment variable nor old metadata may
 * expand this fixed canonical window.
 *
 * 14400 blocks = 2 days at 12s slots. Widened from 50 after live
 * acceptance found three active fork/univ4 pools (XL1/XYO, USDT/WBTC,
 * WBTC pair) that were enumerated in active-pools.json but landed outside
 * the 50-block scan window, so they never entered the candidate partition
 * and their arbitrage paths never reached the graph.
 */
export const STRICT_EDGE_COLLECTION_WINDOW_BLOCKS = 14_400 as const;

export function strictEdgeCollectionFromBlock(cutoffNumber: number): number {
  if (!Number.isSafeInteger(cutoffNumber) || cutoffNumber < 0) {
    throw new Error("strict edge collection cutoff must be a non-negative integer");
  }
  return Math.max(
    0,
    cutoffNumber - STRICT_EDGE_COLLECTION_WINDOW_BLOCKS + 1,
  );
}
