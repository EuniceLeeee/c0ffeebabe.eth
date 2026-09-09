/** Pair._update stores token balances, not just reserves, in uint112 slots. */
export const UNIV2_MAX_RESERVE = (1n << 112n) - 1n;

export function uniV2InputCapacity(balanceIn: bigint): bigint {
  if (balanceIn < 0n) throw new Error("univ2 input balance cannot be negative");
  return balanceIn >= UNIV2_MAX_RESERVE ? 0n : UNIV2_MAX_RESERVE - balanceIn;
}
