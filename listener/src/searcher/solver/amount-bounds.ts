export function estimateFlashBounds(victimAmountIn: bigint): [bigint, bigint] {
  if (victimAmountIn <= 0n) throw new Error("victim amount must be positive");
  // Flash size is in same order of magnitude as the victim swap. The actual
  // optimum is found by binary search over this band — solver picks the best.
  return [victimAmountIn / 2n, victimAmountIn * 2n];
}

/**
 * Returns a small set of flash-amount anchors spanning [low, high].
 * Solver tries each and keeps the best simulated netProfit.
 *
 * Uses uniform linear spacing — simple and robust. A future improvement
 * could be true convex binary search (collapse toward the local maximum).
 */
export function candidateFlashAmounts(low: bigint, high: bigint): bigint[] {
  if (high <= low) return low > 0n ? [low] : [];
  const STEPS = 6n;
  const set = new Set<string>();
  for (let i = 0n; i <= STEPS; i++) {
    const amt = low + ((high - low) * i) / STEPS;
    if (amt > 0n) set.add(amt.toString());
  }
  return [...set].map((s) => BigInt(s));
}
