import { ethers } from "ethers";
import { NO_EXECUTION_RUNTIME_PROJECTION, type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor, runtimeLeg } from "../../runtime-execution.js";
import { ABI, NEED, TAKE, scales, uint } from "./codec.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import { quoteBudget } from "./state.js";
import type { Binding, Descriptor, Evidence, Route } from "./types.js";
export function takeProgram(d: Binding, executor: string, minimumOut?: bigint) {
  const actor = runtimeExecutor(executor, d.target, d.implementation, d.want, d.sold), s = scales(d);
  const p = new RuntimeAmountProgram().constant(12, 1n);
  if (minimumOut !== undefined) {
    if (!uint(minimumOut)) throw new Error("Yearn auction zero output floor");
    p.call(d.want, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(14, 0).math("sub", 8, 14, 0)
      .call(d.sold, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(13, 0);
  }
  // A scaled getAmountNeeded probe recovers the FULL raw price, including the
  // fraction discarded by price() for <18-decimal payment tokens. No Exact.
  p.call(d.target, ABI.encodeFunctionData(NEED, [d.sold, s.priceProbe]), { static: true }).load(1, 0)
    .constant(11, s.want).math("sub", 2, 1, 11) // isActive iff rawPrice / wantScaler > 0
    .constant(9, s.sold).math("mul", 1, 1, 9).constant(10, s.denominator)
    .math("add", 2, 0, 12).math("mul", 2, 2, 10).math("sub", 2, 2, 12).math("div", 3, 2, 1)
    .call(d.want, ABI.encodeFunctionData("approve", [d.target, 0n])).load(5, 0).equal(5, 12)
    .call(d.want, ABI.encodeFunctionData("approve", [d.target, 0n]), { patches: [{ offset: 36, reg: 0 }] }).load(5, 0).equal(5, 12)
    .call(d.target, ABI.encodeFunctionData(TAKE, [d.sold, 0n]), { patches: [{ offset: 36, reg: 3 }] }).load(4, 0)
    .call(d.want, ABI.encodeFunctionData("approve", [d.target, 0n])).load(5, 0).equal(5, 12);
  if (minimumOut !== undefined) p.call(d.want, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(6, 0)
    .math("sub", 7, 14, 6).math("sub", 8, 7, 12).math("sub", 8, 0, 7)
    .call(d.sold, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(6, 0)
    .math("sub", 6, 6, 13).equal(6, 4).constant(7, minimumOut).math("sub", 8, 6, 7);
  return p;
}
export const execution = {
  buildRuntimeLeg: ({ descriptor: d, route: r, executor }) => { assertRoute(d, r);
    return { ...runtimeLeg(ACTION, takeProgram(d, executor)), inputMode: "maximum" as const }; },
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
