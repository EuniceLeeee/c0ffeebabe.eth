import { ethers } from "ethers";
import { NO_EXECUTION_RUNTIME_PROJECTION, type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor, runtimeLeg } from "../../runtime-execution.js";
import { ABI, uint } from "./codec.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import type { Descriptor, Evidence, Route } from "./types.js";
export function debondProgram(d: Pick<Descriptor, "pod" | "asset" | "staking">, executor: string, minimumOut?: bigint) {
  const actor = runtimeExecutor(executor, d.pod, d.asset, d.staking);
  const p = new RuntimeAmountProgram();
  // Shared runtime-amount-flow protects old input/output inventory and supplies
  // the measured prior receipt in r0. Do not quote or re-read it in this Family.
  if (minimumOut !== undefined) p.call(d.asset, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(1, 0);
  p.call(d.pod, ABI.encodeFunctionData("debond", [0n, [], []]), { patches: [{ offset: 4, reg: 0 }] });
  if (minimumOut !== undefined) p.call(d.asset, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(2, 0)
    .math("sub", 2, 2, 1).constant(3, uint(minimumOut)).math("sub", 2, 2, 3);
  return p;
}
export const execution = {
  buildRuntimeLeg({ descriptor: d, route: r, executor }) { assertRoute(d, r); return runtimeLeg(ACTION, debondProgram(d, executor)); },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(i) {
    const d = i.descriptor, r = i.route, e = i.exactEvidence; assertRoute(d, r);
    const actor = runtimeExecutor(i.executor, d.pod, d.asset, d.staking).toLowerCase();
    uint(i.amountIn); uint(i.quotedAmountOut); uint(i.minAmountOut);
    if (!i.amountIn || !i.quotedAmountOut || !i.minAmountOut || i.minAmountOut > i.quotedAmountOut || e.kind !== "peapods-weighted-local" ||
        e.fingerprint !== r.bindingRef.fingerprint || e.routeKey !== r.routeKey || e.executor !== actor ||
        e.amountIn !== i.amountIn || e.amountOut !== i.quotedAmountOut) throw new Error("peapods execution evidence mismatch");
    return { requirements: [], nodes: [{ adapterId: ACTION, target: d.pod, tokenIn: d.pod, tokenOut: d.asset, amount: i.amountIn,
      params: { runtimeAmountProgram: ethers.hexlify(debondProgram(d, actor, i.minAmountOut).bytes()) }, children: [] }] };
  },
  expectedEffects: ({ descriptor: d, route: r }) => { assertRoute(d, r); return [
    { kind: "token-delta", token: d.pod, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: d.asset, account: "executor", direction: "increase" },
  ]; },
} satisfies ExecutionSemantics<Descriptor, Route, Evidence>;
