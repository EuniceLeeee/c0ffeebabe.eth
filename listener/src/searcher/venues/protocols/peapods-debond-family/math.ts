import { BPS, Q96, uint } from "./codec.js";
import type { State } from "./types.js";
const wrap = (value: bigint) => BigInt.asUintN(256, value);
/** Exact WeightedIndex 0.7.6 order, including unchecked intermediate products.
 * Neither the 98%-of-supply exemption nor the two Q96 floors is linearized. */
export function debond(s: State, amountIn: bigint) {
  uint(amountIn); uint(s.supply); uint(s.backing); uint(s.feeBps);
  if (s.feeBps > BPS || amountIn <= 0n || s.supply <= 0n || amountIn > s.supply) throw new Error("peapods unavailable amount/supply/fee");
  const exempt = amountIn >= wrap(s.supply * 98n) / 100n;
  const burned = exempt ? amountIn : wrap(amountIn * (BPS - s.feeBps)) / BPS;
  const fractionX96 = wrap(burned * Q96) / s.supply;
  const amountOut = wrap(s.backing * fractionX96) / Q96;
  if (burned > amountIn || amountOut > s.backing) throw new Error("peapods unsupported wrapped output");
  return { amountOut, burned, feeShares: amountIn - burned, exempt,
    state: { ...s, supply: s.supply - burned, backing: s.backing - amountOut } };
}
