import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeDeferredPayment, runtimeDeferredOpeningFloor, type RuntimeSettlementRequest } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor, runtimeExactApproval, runtimeClearApproval } from "../../runtime-execution.js";
import { ABI, binding, profile, amount, takerData } from "./codec.js";
import type { Binding } from "./types.js";
export function quoteProgram(b: Binding, i: number, executor: string, recipient?: string) {
  const d = binding(b.router, b.order, b.tokens);
  if ((i !== 0 && i !== 1) || !profile(d.order) || d.strategyHash !== b.strategyHash) throw new Error("aqua execution binding");
  runtimeExecutor(executor, d.router, d.aqua, d.order.maker, ...d.tokens);
  const receiver = recipient === undefined ? undefined : runtimeExecutor(recipient, d.router, d.aqua, d.order.maker, ...d.tokens);
  // Deployed v1 SwapVM.sol:110 expressly supports STATICCALL. The admitted
  // concentration/flat fee/XYC/salt program has no state-writing instruction.
  return new RuntimeAmountProgram().constant(15, 1n).math("sub", 14, 0, 15)
    .call(d.router, ABI.encodeFunctionData("quote", [d.order, d.tokens[i], d.tokens[1-i], 0n, takerData(1n, receiver === undefined ? {} : { recipient: receiver })]),
      { static: true, patches: [{ offset: 100, reg: 0 }] })
    .load(1, 0).equal(1, 0).load(2, 64).constant(3, BigInt(d.strategyHash)).equal(2, 3)
    .load(4, 32).math("sub", 14, 4, 15).constant(3, 0n).math("add", 0, 4, 3);
}
export function swapProgram(b: Binding, i: number, executor: string, minimum: bigint,
  settlement?: Exclude<RuntimeSettlementRequest, { kind: "quote-output" }>) {
  const d = binding(b.router, b.order, b.tokens), tokenIn = d.tokens[i], tokenOut = d.tokens[1-i];
  if ((i !== 0 && i !== 1) || !profile(d.order) || d.strategyHash !== b.strategyHash) throw new Error("aqua execution binding");
  const actor = runtimeExecutor(executor, d.router, d.aqua, d.order.maker, ...d.tokens); amount(minimum, true);
  const receiver = settlement?.kind === "direct-output"
    ? runtimeExecutor(settlement.recipient, d.router, d.aqua, d.order.maker, ...d.tokens) : actor;
  if (settlement?.kind === "deferred-input") amount(settlement.paymentAmount);
  const deferred = settlement?.kind === "deferred-input" ? runtimeDeferredPayment({
    tokenOut, executor: actor, debtOffset: 132, ...settlement,
  }) : null;
  const p = new RuntimeAmountProgram().constant(15, 1n).math("sub", 14, 0, 15)
    .call(tokenIn, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(1, 0)
    .call(tokenOut, ABI.encodeFunctionData("balanceOf", [receiver]), { static: true }).load(2, 0).nativeBalance(3);
  runtimeExactApproval(p, tokenIn, d.router);
  if (settlement?.kind === "deferred-input") runtimeDeferredOpeningFloor(p, tokenOut, actor, settlement.paymentAmount);
  const data = ABI.encodeFunctionData("swap", [d.order, tokenIn, tokenOut, 0n, takerData(minimum, {
    ...(settlement?.kind === "direct-output" ? { recipient: receiver } : {}),
    ...(deferred ? { callbackScript: deferred.script } : {}),
  })]);
  // swap: fifth head word is the offset to takerTraitsAndData; skip its length.
  // The callback slice starts after index6 of the 22-byte traits header. The
  // nested ABI bytes wrapper adds offset+length (64 bytes) before the script.
  const takerStart = 4 + Number(BigInt(ethers.dataSlice(data, 132, 164))) + 32;
  const header = BigInt(ethers.dataSlice(data, takerStart, takerStart + 22));
  const outgoing = takerStart + 22 + Number((header >> 112n) & 65535n) + 64;
  p.call(d.router, data, {
    patches: [{ offset: 100, reg: 0 }, ...(deferred ? [
      { offset: outgoing + deferred.limitOffset, reg: 0 }, { offset: outgoing + deferred.floorOffset, reg: 13 },
    ] : [])],
    // preTransferInCallback has 8 ABI arguments. data content starts at292;
    // abi.encode(bytes(script)) adds64. amountIn (the full debt) is at132.
    ...(deferred ? { callback: { incomingOffset: 356, outgoingOffset: outgoing } } : {}),
  })
    .load(4, 0).equal(4, 0).load(5, 32).load(6, 64).constant(7, BigInt(d.strategyHash)).equal(6, 7);
  runtimeClearApproval(p, tokenIn, d.router);
  p.call(tokenIn, ABI.encodeFunctionData("allowance", [actor, d.router]), { static: true }).load(6, 0).constant(7, 0n).equal(6, 7)
    .call(tokenIn, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(6, 0);
  // The measured prefix pays input into the executor staging account. The
  // router then pulls that exact credit and calls Aqua.push; old input remains.
  if (deferred) p.equal(6, 1);
  else p.math("sub", 7, 1, 6).equal(7, 0);
  p.call(tokenOut, ABI.encodeFunctionData("balanceOf", [receiver]), { static: true }).load(6, 0).math("sub", 7, 6, 2);
  if (settlement?.kind === "deferred-input") {
    // Prefix hop0 actually consumes paymentAmount (central exact-debit guard).
    // Its later hops use each actual receipt. Gross released output therefore
    // equals retained new output plus that first input; old output is preserved.
    p.constant(9, settlement.paymentAmount).math("add", 10, 7, 9).equal(10, 5);
  } else p.equal(7, 5);
  const outputReg = deferred ? 5 : 7;
  p.math("sub", 14, outputReg, 15).constant(9, minimum).math("sub", 14, outputReg, 9).nativeBalance(6).equal(3, 6);
  return p;
}
