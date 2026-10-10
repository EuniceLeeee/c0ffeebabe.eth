import { ethers } from "ethers";
import { NO_EXECUTION_RUNTIME_PROJECTION, type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor, runtimeLeg } from "../../runtime-execution.js";
import { ABI, uint } from "./codec.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import type { Descriptor, Evidence, Route } from "./types.js";
export function swapProgram(d: Descriptor, r: Route, executor: string, minimumOut?: bigint) {
  assertRoute(d, r); const actor = runtimeExecutor(executor, d.target, d.implementation, d.gem, d.stable);
  const p = new RuntimeAmountProgram().constant(12, 1n);
  if (minimumOut !== undefined) p.call(r.tokenOut, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(13, 0);
  // r0 is this operation's input, measured by the shared receipt boundary.
  // Exact temporary approvals are bool-checked and always cleared atomically.
  p.call(r.tokenIn, ABI.encodeFunctionData("approve", [d.target, 0n])).load(1, 0).equal(1, 12)
    .call(r.tokenIn, ABI.encodeFunctionData("approve", [d.target, 0n]), { patches: [{ offset: 36, reg: 0 }] }).load(1, 0).equal(1, 12)
    .call(d.target, ABI.encodeFunctionData(r.direction === "sell-gem" ? "sellGem" : "buyGem", [actor, 0n]), { patches: [{ offset: 36, reg: 0 }] })
    .call(r.tokenIn, ABI.encodeFunctionData("approve", [d.target, 0n])).load(1, 0).equal(1, 12);
  if (minimumOut !== undefined) p.call(r.tokenOut, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(1, 0)
    .math("sub", 1, 1, 13).constant(2, uint(minimumOut)).math("sub", 1, 1, 2);
  return p;
}
export const execution = {
  buildRuntimeLeg: ({ descriptor: d, route: r, executor }) => runtimeLeg(ACTION, swapProgram(d, r, executor)),
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
