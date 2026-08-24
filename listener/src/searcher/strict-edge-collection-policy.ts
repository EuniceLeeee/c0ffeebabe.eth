/**
 * One production policy owns every startup observation range that can
 * nominate an instance or an edge. Historical universe files are warm
 * nominations only: neither an environment variable nor old metadata may
 * expand this fixed canonical window.
 *
 * 14400 blocks = 2 days at 12s slots. The observation digest streams per
 * log (no giant concatenated string). Discovery never widens beyond this
 * range; previously verified candidates are retained by their durable memo
 * snapshots and revalidated independently of recent activity.
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
