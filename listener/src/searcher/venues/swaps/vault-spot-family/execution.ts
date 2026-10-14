import { NO_EXECUTION_RUNTIME_PROJECTION, type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { runtimeLeg, runtimeExecutor } from "../../runtime-execution.js";
import { amount } from "./codec.js";
import { assertRoute } from "./routes.js";
import { swapProgram } from "./runtime.js";
import { ACTION } from "./manifest.js";
import type { Descriptor, Route, Evidence } from "./types.js";
export const execution = {
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildRuntimeLeg(i) { assertRoute(i.descriptor, i.route);
    return runtimeLeg(ACTION, swapProgram(i.descriptor.vault, i.route.tokenIn, i.route.tokenOut, i.executor, 1n)); },
  buildFragment(i) {
    assertRoute(i.descriptor, i.route); amount(i.amountIn); amount(i.quotedAmountOut); amount(i.minAmountOut, true);
    runtimeExecutor(i.executor, i.descriptor.vault, ...i.descriptor.tokens);
    const e = i.exactEvidence;
    if (e.kind !== "vault-spot-execution" || e.executor !== i.executor.toLowerCase() || e.binding !== i.route.bindingRef.fingerprint ||
        e.routeKey !== i.route.routeKey || e.amountIn !== i.amountIn || e.amountOut !== i.quotedAmountOut) throw new Error("vault-spot Exact evidence mismatch");
    return { requirements: [], nodes: [{ adapterId: ACTION, target: i.descriptor.vault, tokenIn: i.route.tokenIn, tokenOut: i.route.tokenOut,
      amount: i.amountIn, params: { minAmountOut: i.minAmountOut }, children: [] }] };
  },
  expectedEffects: ({ route: r }) => [{ kind: "token-delta", token: r.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: r.tokenOut, account: "executor", direction: "increase" }],
} satisfies ExecutionSemantics<Descriptor, Route, Evidence>;
