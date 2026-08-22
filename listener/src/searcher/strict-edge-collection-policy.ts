/**
 * One production policy owns every startup observation range that can
 * nominate an instance or an edge. Historical universe files are warm
 * nominations only: neither an environment variable nor old metadata may
 * expand this fixed canonical window.
 *
 * 14400 blocks = 2 days at 12s slots. The observation digest streams per
 * log (no giant concatenated string), so a widened window no longer hits
 * "Invalid string length". Four active univ4 pools (XL1/XYO, USDT/WBTC,
 * WBTC) lie ~41000 blocks before head; they enter the candidate partition
 * via the event-scan window (their swap logs nominate poolIds) plus the
 * retain channel: reverseBindUniv4 resolves the full PoolKey through the
 * archive node's Initialize reverse scan when the PositionManager lookup
 * misses, and the runner merge collapses the retained/event aliases so one
 * instance enters the run once. Verified memos are durable across windows.
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

/**
 * Dormancy nomination window (7 days at 12s slots). A pool dormant for the
 * strict 2-day observation window but active within this wider window is
 * still nominated (as a warm nomination only) so its durable verified memo
 * can be reused across a rebuild; only pools silent for the full 7 days are
 * dropped by a fresh run. The wider scan never enters the catalog-event
 * source receipts (the strict 2-day window remains the complete-observation
 * proof); it is nomination-only, exactly like the startup universe files.
 */
export const DORMANCY_NOMINATION_WINDOW_BLOCKS = 50_400 as const;

export function dormancyNominationFromBlock(cutoffNumber: number): number {
  if (!Number.isSafeInteger(cutoffNumber) || cutoffNumber < 0) {
    throw new Error("dormancy nomination cutoff must be a non-negative integer");
  }
  return Math.max(
    0,
    cutoffNumber - DORMANCY_NOMINATION_WINDOW_BLOCKS + 1,
  );
}
