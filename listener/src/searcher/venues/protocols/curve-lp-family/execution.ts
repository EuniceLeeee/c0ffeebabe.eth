import { ethers } from "ethers";
import { NO_EXECUTION_RUNTIME_PROJECTION, type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor, runtimeLeg } from "../../runtime-execution.js";
import { ABI, uint } from "./codec.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import type { Descriptor, Evidence, Route } from "./types.js";
export function lpProgram(d: Descriptor, r: Route, executor: string, minimumOut?: bigint) {
  assertRoute(d, r); const actor = runtimeExecutor(executor, d.pool, d.lp, ...d.coins), p = new RuntimeAmountProgram().constant(12, 1n);
  if (minimumOut !== undefined) { if (!uint(minimumOut)) throw new Error("curve-lp zero floor");
    p.call(r.tokenIn, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(14, 0).math("sub", 8, 14, 0)
      .call(r.tokenOut, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(13, 0); }
  if (r.direction === "mint") p.call(r.tokenIn, ABI.encodeFunctionData("approve", [d.pool, 0n])).load(5, 0).equal(5, 12)
    .call(r.tokenIn, ABI.encodeFunctionData("approve", [d.pool, 0n]), { patches: [{ offset: 36, reg: 0 }] }).load(5, 0).equal(5, 12);
  const fn = r.direction === "mint" ? "add_liquidity" : "remove_liquidity_one_coin";
  const data = ABI.encodeFunctionData(fn, r.direction === "mint" ? [[0n, 0n], minimumOut ?? 1n] : [0n, r.index, minimumOut ?? 1n]);
  p.call(d.pool, data, { patches: [{ offset: r.direction === "mint" ? 4 + r.index * 32 : 4, reg: 0 }] }).load(4, 0);
  if (r.direction === "mint") p.call(r.tokenIn, ABI.encodeFunctionData("approve", [d.pool, 0n])).load(5, 0).equal(5, 12);
  if (minimumOut !== undefined) p.call(r.tokenIn, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(6, 0)
    .math("sub", 7, 14, 6).equal(7, 0).call(r.tokenOut, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(6, 0)
    .math("sub", 6, 6, 13).equal(6, 4).constant(7, minimumOut).math("sub", 8, 6, 7);
  return p;
}
export const execution = { buildRuntimeLeg: ({ descriptor: d, route: r, executor }) => runtimeLeg(ACTION, lpProgram(d, r, executor)),
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(i) { const d = i.descriptor, r = i.route, e = i.exactEvidence; assertRoute(d, r);
    const actor = runtimeExecutor(i.executor, d.pool, d.lp, ...d.coins).toLowerCase();
    if (!uint(i.amountIn) || !uint(i.quotedAmountOut) || !uint(i.minAmountOut) || i.minAmountOut > i.quotedAmountOut ||
        e.kind !== "curve-lp-exact" || e.binding !== r.bindingRef.fingerprint || e.routeKey !== r.routeKey || e.executor !== actor ||
        e.amountIn !== i.amountIn || e.amountOut !== i.quotedAmountOut) throw new Error("curve-lp incompatible quote evidence");
    return { requirements: [], nodes: [{ adapterId: ACTION, target: d.pool, tokenIn: r.tokenIn, tokenOut: r.tokenOut, amount: i.amountIn,
      params: { runtimeAmountProgram: ethers.hexlify(lpProgram(d, r, actor, i.minAmountOut).bytes()) }, children: [] }] };
  }, expectedEffects: ({ descriptor: d, route: r }) => { assertRoute(d, r); return [
    { kind: "token-delta", token: r.tokenIn, account: "executor", direction: "decrease" }, { kind: "token-delta", token: r.tokenOut, account: "executor", direction: "increase" }]; },
} satisfies ExecutionSemantics<Descriptor, Route, Evidence>;
