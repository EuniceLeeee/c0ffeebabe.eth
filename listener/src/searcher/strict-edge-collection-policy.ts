/**
 * One production policy owns every startup observation range that can
 * nominate an instance or an edge. Historical universe files are warm
 * nominations only: neither an environment variable nor old metadata may
 * expand this fixed canonical window.
 *
 * 50 blocks: the 2-day window (14400) was introduced to catch four active
 * univ4 pools ~41000 blocks before head, but univ4 pools cannot enter the
 * candidate partition yet (swap logs carry only poolId and the retain
 * channel's chain-truth sources - PositionManager poolKeys and the
 * Initialize reverse scan - do not resolve them on the local node). The
 * widened window only paid scan cost, so it is parked until the univ4
 * reverse binding admits pools; then restore 14400 (the streaming
 * observation hash makes the wide window safe: no giant concatenated
 * string, no "Invalid string length").
 */
export const STRICT_EDGE_COLLECTION_WINDOW_BLOCKS = 50 as const;

export function strictEdgeCollectionFromBlock(cutoffNumber: number): number {
  if (!Number.isSafeInteger(cutoffNumber) || cutoffNumber < 0) {
    throw new Error("strict edge collection cutoff must be a non-negative integer");
  }
  return Math.max(
    0,
    cutoffNumber - STRICT_EDGE_COLLECTION_WINDOW_BLOCKS + 1,
  );
}
