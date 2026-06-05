export function estimateFlashBounds(victimAmountIn: bigint): [bigint, bigint] {
  if (victimAmountIn <= 0n) throw new Error("victim amount must be positive");
  return [victimAmountIn / 2n, victimAmountIn * 2n];
}

export function candidateFlashAmounts(low: bigint, high: bigint): bigint[] {
  const mid = (low + high) / 2n;
  const anchors = [
    low,
    (low + mid) / 2n,
    mid,
    low * 2524n / 1000n, // victim-impact derived band around the wstUSR depeg route
    (mid + high) / 2n,
    high,
  ];
  return [...new Set(anchors.filter((x) => x > 0n).map((x) => x.toString()))]
    .map((x) => BigInt(x));
}
