export function defaultFinalVerifyFloorBps(
  quoteSafetyBps: bigint,
  maxHops: number,
): bigint {
  const perHopHaircutBps = quoteSafetyBps < 10_000n ? 10_000n - quoteSafetyBps : 0n;
  if (perHopHaircutBps <= 0n || maxHops <= 0) return 0n;
  // One extra hop of slack keeps the gate conservative around integer rounding.
  return perHopHaircutBps * BigInt(maxHops + 1);
}

export function shouldRunFinalVerify(
  quoteProfit: bigint,
  flashAmount: bigint,
  finalVerifyFloorBps: bigint,
): boolean {
  if (quoteProfit > 0n) return true;
  if (flashAmount <= 0n || finalVerifyFloorBps <= 0n) return false;
  return quoteProfit >= -floorAmount(flashAmount, finalVerifyFloorBps);
}

export function floorAmount(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / 10_000n;
}
