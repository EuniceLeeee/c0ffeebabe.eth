import { ethers } from "ethers";
import { NO_EXECUTION_RUNTIME_PROJECTION, type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor, runtimeLeg } from "../../runtime-execution.js";
import { ABI, uint } from "./codec.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import { quoteProgram } from "./runtime-quote.js";
import type { Descriptor, Evidence, Route } from "./types.js";
export function swapProgram(d: Descriptor, r: Route, executor: string, minimumOut?: bigint, recipient = executor) {
  assertRoute(d, r); runtimeExecutor(executor, d.target, d.implementation, d.gem, d.stable);
  const receiver = runtimeExecutor(recipient, d.target, d.implementation, d.gem, d.stable);
  const p = new RuntimeAmountProgram().constant(12, 1n);
  if (minimumOut !== undefined) p.call(r.tokenOut, ABI.encodeFunctionData("balanceOf", [receiver]), { static: true }).load(13, 0);
  // r0 is this operation's input, measured by the shared receipt boundary.
  // Exact temporary approvals are bool-checked and always cleared atomically.
  p.call(r.tokenIn, ABI.encodeFunctionData("approve", [d.target, 0n])).load(1, 0).equal(1, 12)
    .call(r.tokenIn, ABI.encodeFunctionData("approve", [d.target, 0n]), { patches: [{ offset: 36, reg: 0 }] }).load(1, 0).equal(1, 12)
    .call(d.target, ABI.encodeFunctionData(r.direction === "sell-gem" ? "sellGem" : "buyGem", [receiver, 0n]), { patches: [{ offset: 36, reg: 0 }] })
    .call(r.tokenIn, ABI.encodeFunctionData("approve", [d.target, 0n])).load(1, 0).equal(1, 12);
  if (minimumOut !== undefined) p.call(r.tokenOut, ABI.encodeFunctionData("balanceOf", [receiver]), { static: true }).load(1, 0)
    .math("sub", 1, 1, 13).constant(2, uint(minimumOut)).math("sub", 1, 1, 2);
  return p;
}
function directProgram(d: Descriptor, r: Route, executor: string, recipient: string) {
  const actor = runtimeExecutor(executor, d.target, d.implementation, d.gem, d.stable);
  const receiver = runtimeExecutor(recipient, d.target, d.implementation, d.gem, d.stable);
  const separate = receiver !== actor;
  const p = new RuntimeAmountProgram().run(quoteProgram(d, r, actor, receiver).bytes(), 0, 6, true)
    .call(r.tokenIn, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(1, 0)
    .call(r.tokenOut, ABI.encodeFunctionData("balanceOf", [receiver]), { static: true }).load(2, 0).nativeBalance(3);
  if (separate) p.call(r.tokenIn, ABI.encodeFunctionData("balanceOf", [receiver]), { static: true }).load(4, 0)
    .call(r.tokenOut, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(5, 0);
  p.run(swapProgram(d, r, actor, 1n, receiver).bytes(), 0, 7)
    .call(r.tokenIn, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(8, 0).math("sub", 8, 1, 8).equal(8, 0)
    .call(r.tokenOut, ABI.encodeFunctionData("balanceOf", [receiver]), { static: true }).load(8, 0).math("sub", 8, 8, 2).equal(8, 6)
    .nativeBalance(8).equal(8, 3);
  // A fee paid back to the payer in an intermediate asset is split output,
  // outside this exact-conservation direct path. Roll back rather than spend
  // old stock, redirect treasury funds, or weaken the shared inventory guard.
  if (separate) p.call(r.tokenIn, ABI.encodeFunctionData("balanceOf", [receiver]), { static: true }).load(8, 0).equal(8, 4)
    .call(r.tokenOut, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(8, 0).equal(8, 5);
  return p;
}
export const execution = {
  buildRuntimeLeg: ({ descriptor: d, route: r, executor, settlement: request }) => {
    if (request && request.kind !== "quote-output" && request.kind !== "direct-output") return null;
    const p = request?.kind === "quote-output" ? quoteProgram(d, r, executor, request.recipient)
      : request?.kind === "direct-output" ? directProgram(d, r, executor, request.recipient) : swapProgram(d, r, executor);
    return { ...runtimeLeg(ACTION, p), settlement: { quoteOutput: true, directOutput: true },
      ...(request ? { settlementRequest: request } : {}) };
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(i) {
    const d = i.descriptor, r = i.route, e = i.exactEvidence; assertRoute(d, r);
    const actor = runtimeExecutor(i.executor, d.target, d.implementation, d.gem, d.stable).toLowerCase();
    uint(i.amountIn); uint(i.quotedAmountOut); uint(i.minAmountOut);
    if (!i.amountIn || !i.quotedAmountOut || !i.minAmountOut || i.minAmountOut > i.quotedAmountOut || e.kind !== "psv-recipient-preview" ||
        e.fingerprint !== r.bindingRef.fingerprint || e.routeKey !== r.routeKey || e.executor !== actor || e.amountIn !== i.amountIn || e.amountOut !== i.quotedAmountOut)
      throw new Error("PSV incompatible quote evidence");
    return { requirements: [], nodes: [{ adapterId: ACTION, target: d.target, tokenIn: r.tokenIn, tokenOut: r.tokenOut, amount: i.amountIn,
      params: { runtimeAmountProgram: ethers.hexlify(swapProgram(d, r, actor, i.minAmountOut).bytes()) }, children: [] }] };
  },
  expectedEffects: ({ descriptor: d, route: r }) => { assertRoute(d, r); return [
    { kind: "token-delta", token: r.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: r.tokenOut, account: "executor", direction: "increase" }]; },
} satisfies ExecutionSemantics<Descriptor, Route, Evidence>;
