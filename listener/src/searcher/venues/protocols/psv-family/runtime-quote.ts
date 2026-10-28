import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { ABI } from "./codec.js";
import { assertRoute } from "./routes.js";
import type { Descriptor, Route } from "./types.js";

/** Transaction-local preparation for the existing settlement composer. The
 * preview is recipient-sensitive and omits capacity checks. A treasury receiver
 * receives both the net transfer and the fee, although the ABI returns only net.
 * No off-chain Exact result or amount enters this program. */
export function quoteProgram(d: Descriptor, r: Route, executor: string, recipient = executor) {
  assertRoute(d, r);
  runtimeExecutor(executor, d.target, d.implementation, d.gem, d.stable);
  const receiver = runtimeExecutor(recipient, d.target, d.implementation, d.gem, d.stable);
  const sell = r.direction === "sell-gem";
  return new RuntimeAmountProgram().constant(15, 1n).math("sub", 14, 0, 15).constant(10, 0n)
    .call(d.target, ABI.encodeFunctionData("paused"), { static: true }).load(1, 0).equal(1, 10)
    .call(d.target, ABI.encodeFunctionData(sell ? "previewSellGem" : "previewBuyGem", [0n, receiver]),
      { static: true, patches: [{ offset: 4, reg: 0 }] })
    .load(1, 0).load(2, 32).math("sub", 14, 1, 15).math("add", 3, 1, 2)
    .call(d.target, ABI.encodeFunctionData("treasury"), { static: true }).load(4, 0)
    .constant(5, BigInt(receiver)).math("eq", 5, 4, 5).math("mul", 6, 2, 5).math("add", 6, 1, 6)
    .call(d.target, ABI.encodeFunctionData("getReserves"), { static: true }).load(8, sell ? 0 : 32)
    .math("sub", 14, 8, 3)
    .constant(9, 10n ** BigInt(18 - (sell ? d.gemDecimals : d.stableDecimals))).math("mul", 9, 0, 9)
    .call(d.target, ABI.encodeFunctionData("maxPerTransaction"), { static: true }).load(8, 0)
    .math("eq", 11, 8, 10).constant(12, ethers.MaxUint256).math("mul", 11, 11, 12).math("add", 8, 8, 11)
    .math("sub", 14, 8, 9)
    .call(d.target, ABI.encodeFunctionData("getRemainingBlockCapacity"), { static: true }).load(8, 0)
    .math("sub", 14, 8, 9).math("add", 0, 6, 10);
}
