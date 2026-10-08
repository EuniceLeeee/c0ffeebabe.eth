import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { runtimeExecutor, runtimeLeg } from "../../runtime-execution.js";
import { checked, MAX_UINT, nonzero, sourceEqual } from "./codec.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import { swapProgram } from "./runtime.js";
import type { Descriptor, Evidence, Route } from "./types.js";
export const execution = {
  buildRuntimeLeg({ descriptor: d, route: r, executor }) {
    assertRoute(d, r); runtimeExecutor(executor, d.pool, d.factory, ...d.tokens);
    return runtimeLeg(ACTION, swapProgram(d.pool, r.tokenIn, r.tokenOut, executor, 1n));
  },
  runtimeProjection: () => ({ allowanceSpender: null, prewarmQuoteCalls: [] }),
  buildFragment(i) {
    assertRoute(i.descriptor, i.route); runtimeExecutor(i.executor, i.descriptor.pool, i.descriptor.factory, ...i.descriptor.tokens);
    const e = i.exactEvidence; sourceEqual(e.source, e.source); checked(i.amountIn); checked(i.quotedAmountOut);
    if (e.kind !== "balancer-v1-chain-exact-in" || e.binding !== i.route.bindingRef.fingerprint || e.routeKey !== i.route.routeKey ||
        e.amountIn !== i.amountIn || e.amountOut !== i.quotedAmountOut || e.executor !== nonzero(i.executor) ||
        i.amountIn <= 0n || i.quotedAmountOut <= 0n || i.minAmountOut <= 0n || i.minAmountOut > i.quotedAmountOut || i.minAmountOut > MAX_UINT) {
      throw new Error("balancer-v1 incompatible execution evidence");
    }
    return { requirements: [], nodes: [{ adapterId: ACTION, target: i.descriptor.pool, tokenIn: i.route.tokenIn,
      tokenOut: i.route.tokenOut, amount: i.amountIn, params: { minAmountOut: i.minAmountOut, executor: nonzero(i.executor) }, children: [] }] };
  },
  expectedEffects: ({ route }) => [
    { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
  ],
} satisfies ExecutionSemantics<Descriptor, Route, Evidence>;
