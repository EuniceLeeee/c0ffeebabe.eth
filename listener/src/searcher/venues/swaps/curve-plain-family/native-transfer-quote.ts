import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { assertSource, call, isNativeCoin, returned, same, uint } from "./codec.js";
import type { CurveNativeTransferQuote } from "./types.js";

// stETH transfer(amount) moves floor(amount * totalShares / totalPooledEther)
// shares. balanceOf then floors the conversion back to pooled ETH. get_dy is
// the nominal transfer, not that independently observed account balance delta.
// The model is only for the proved raw-native -> stETH exchange surface; never
// apply it to an arbitrary token or change the requested input / dust policy.
export const STETH_TRANSFER_RATE = new ethers.Interface([
  "function getTotalShares() view returns (uint256)",
  "function getTotalPooledEther() view returns (uint256)",
]);
export function hasNativeStEthTransfer(coins: readonly string[]): boolean {
  return coins.some(isNativeCoin) && coins.some(coin => same(coin, ADDR.STETH));
}
export function usesNativeStEthTransfer(coins: readonly string[], i: number, j: number): boolean {
  return !!coins[i] && !!coins[j] && isNativeCoin(coins[i]) && same(coins[j], ADDR.STETH);
}
export function nativeStEthRateRequests() {
  return [
    call("native-steth-total-shares", ADDR.STETH, STETH_TRANSFER_RATE.encodeFunctionData("getTotalShares")),
    call("native-steth-total-pooled", ADDR.STETH, STETH_TRANSFER_RATE.encodeFunctionData("getTotalPooledEther")),
  ];
}
export function projectNativeTransferQuote(coins: readonly string[], i: number, j: number,
  nominalAmountOut: bigint, source: CanonicalSource, results: readonly AdapterRequestResult[]):
  { amountOut: bigint; transferQuote?: CurveNativeTransferQuote } {
  if (!usesNativeStEthTransfer(coins, i, j)) return { amountOut: nominalAmountOut };
  const read = (id: string) => {
    const result = returned(results, id); assertSource(result.source, source); return uint(result.data);
  };
  const totalShares = read("native-steth-total-shares"), totalPooledEther = read("native-steth-total-pooled");
  if (totalShares <= 0n || totalPooledEther <= 0n || nominalAmountOut < 0n) {
    throw new Error("curve-plain invalid stETH transfer rate");
  }
  const transferredShares = nominalAmountOut * totalShares / totalPooledEther;
  const amountOut = transferredShares * totalPooledEther / totalShares;
  // With old recipient shares the balance delta is this lower bound or +1.
  // Do not consume that inventory, guess the old balance, or widen tolerance.
  return { amountOut, transferQuote: { model: "steth-transfer-shares", nominalAmountOut,
    totalShares, totalPooledEther, transferredShares, amountOut } };
}
