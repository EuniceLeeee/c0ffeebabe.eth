import { ethers } from "ethers";
import { NO_EXECUTION_RUNTIME_PROJECTION, type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor, runtimeLeg } from "../../runtime-execution.js";
import { ABI, TAKE, uint } from "./codec.js";
import { budgetProgram, quoteProgram, deferredProgram } from "./runtime-settlement.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import { quoteBudget } from "./state.js";
import type { Binding, Descriptor, Evidence, Route } from "./types.js";
export function takeProgram(d: Binding, executor: string, minimumOut?: bigint, recipient?: string) {
  const actor = runtimeExecutor(executor, d.target, d.implementation, d.want, d.sold);
  // receiver() receives payment proceeds; this address receives the sold token.
  const taker = recipient === undefined ? actor : runtimeExecutor(recipient, d.target, d.implementation, d.want, d.sold);
  const minimum = minimumOut ?? 1n;
  const p = new RuntimeAmountProgram().constant(12, 1n);
  p.nativeBalance(15);
  if (minimum !== undefined) {
    if (!uint(minimum)) throw new Error("Yearn auction zero output floor");
    p.call(d.want, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(14, 0).math("sub", 8, 14, 0)
      .call(d.sold, ABI.encodeFunctionData("balanceOf", [taker]), { static: true }).load(13, 0);
  }
  budgetProgram(p, d)
    .call(d.want, ABI.encodeFunctionData("approve", [d.target, 0n])).load(5, 0).equal(5, 12)
    .call(d.want, ABI.encodeFunctionData("approve", [d.target, 0n]), { patches: [{ offset: 36, reg: 0 }] }).load(5, 0).equal(5, 12)
    .call(d.target, ABI.encodeFunctionData(recipient === undefined ? TAKE : "take(address,uint256,address)",
      recipient === undefined ? [d.sold, 0n] : [d.sold, 0n, taker]), { patches: [{ offset: 36, reg: 3 }] }).load(4, 0)
    .call(d.want, ABI.encodeFunctionData("approve", [d.target, 0n])).load(5, 0).equal(5, 12);
  if (minimum !== undefined) p.call(d.want, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(6, 0)
    .math("sub", 7, 14, 6).math("sub", 8, 7, 12).math("sub", 8, 0, 7)
    .math("mul", 9, 4, 1).math("div", 9, 9, 10).equal(7, 9)
    .call(d.sold, ABI.encodeFunctionData("balanceOf", [taker]), { static: true }).load(6, 0)
    .math("sub", 6, 6, 13).equal(6, 4).constant(7, minimum).math("sub", 8, 6, 7);
  p.nativeBalance(6).equal(6, 15);
  return p;
}
export const execution = {
  buildRuntimeLeg: ({ descriptor: d, route: r, executor, settlement }) => { assertRoute(d, r);
    const actor = runtimeExecutor(executor, d.target, d.implementation, d.want, d.sold);
    const program = settlement?.kind === "quote-output" ? quoteProgram(d, actor, settlement.recipient)
      : settlement?.kind === "deferred-input" ? deferredProgram(d, actor, settlement)
      : takeProgram(d, actor, undefined, settlement?.recipient);
    return { ...runtimeLeg(ACTION, program), inputMode: "maximum" as const,
      settlement: { quoteOutput: true as const, directOutput: true as const, deferredInput: actor },
      ...(settlement ? { settlementRequest: settlement } : {}) }; },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(i) {
    const d = i.descriptor, r = i.route, e = i.exactEvidence; assertRoute(d, r);
    const actor = runtimeExecutor(i.executor, d.target, d.implementation, d.want, d.sold).toLowerCase();
    if (!uint(i.amountIn) || !uint(i.quotedAmountOut) || !uint(i.minAmountOut) || i.minAmountOut > i.quotedAmountOut ||
        e.kind !== "yearn-auction-budget" || e.fingerprint !== r.bindingRef.fingerprint || e.routeKey !== r.routeKey ||
        e.executor !== actor || e.state.receiver === actor || e.amountIn !== i.amountIn || e.amountOut !== i.quotedAmountOut)
      throw new Error("Yearn auction incompatible quote evidence");
    const q = quoteBudget(d, e.state, i.amountIn);
    if (q.spent !== e.spent || q.amountOut !== e.amountOut) throw new Error("Yearn auction inconsistent budget evidence");
    return { requirements: [], nodes: [{ adapterId: ACTION, target: d.target, tokenIn: r.tokenIn, tokenOut: r.tokenOut, amount: i.amountIn,
      params: { runtimeAmountProgram: ethers.hexlify(takeProgram(d, actor, i.minAmountOut).bytes()) }, children: [] }] };
  },
  expectedEffects: ({ descriptor: d, route: r }) => { assertRoute(d, r); return [
    { kind: "token-delta", token: r.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: r.tokenOut, account: "executor", direction: "increase" }]; },
} satisfies ExecutionSemantics<Descriptor, Route, Evidence>;
