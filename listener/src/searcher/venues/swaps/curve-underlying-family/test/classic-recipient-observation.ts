import assert from "node:assert/strict";
import { executionNativeSides } from "../../../../execution-asset-boundary.js";
import type { FamilyRouteDescriptor } from "../../../adapter-family-plugin.js";
import { ADDR } from "../../../../../shared/constants/addresses.js";
export function assertClassicRecipientWrapping(calls: readonly any[], executor: string,
  route: Pick<FamilyRouteDescriptor, "tokenIn" | "tokenOut" | "executionAssets">,
  amountIn: bigint, actualOutput: bigint, inputResidue: bigint) {
  const sides = executionNativeSides(route);
  const wrapped = calls.filter(t => t.from?.toLowerCase() === executor.toLowerCase() && t.to?.toLowerCase() === ADDR.WETH.toLowerCase());
  const withdraw = wrapped.filter(t => t.input?.startsWith("0x2e1a7d4d")), deposit = wrapped.filter(t => t.input === "0xd0e30db0");
  assert.equal(withdraw.length, sides?.input ? 1 : 0); assert.equal(deposit.length, sides ? 1 : 0);
  if (withdraw.length) assert.equal(BigInt("0x" + withdraw[0].input.slice(10)), amountIn);
  if (deposit.length) assert.equal(BigInt(deposit[0].value), sides?.output ? actualOutput : inputResidue);
  return { withdrawals: withdraw.length, deposits: deposit.length };
}
