import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import type { PlanFragment } from "../../route-leg-adapter.js";
import { ROUTER, MAX_INPUT, MAX_UINT, same } from "./codec.js";
import { ROUTER_ACTION } from "./action.js";
import { assertRoute } from "./routes.js";
import type { BalancerV3Descriptor, BalancerV3ExactEvidence, BalancerV3Route } from "./types.js";

export const balancerV3Execution: ExecutionSemantics<BalancerV3Descriptor, BalancerV3Route, BalancerV3ExactEvidence> = {
  runtimeProjection: () => ({ allowanceSpender: null, prewarmQuoteCalls: [] }),
  buildFragment(input): PlanFragment {
    assertRoute(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (input.amountIn <= 0n || input.amountIn > MAX_INPUT || input.quotedAmountOut <= 0n || input.quotedAmountOut > MAX_UINT ||
        input.minAmountOut < 0n || input.minAmountOut > input.quotedAmountOut ||
        evidence.kind !== "balancer-v3-router-exact-in" || evidence.binding !== input.route.bindingRef.fingerprint ||
        evidence.routeKey !== input.route.routeKey || evidence.amountIn !== input.amountIn ||
        evidence.amountOut !== input.quotedAmountOut || !same(evidence.executor, input.executor)) {
      throw new Error("balancer-v3 incompatible exact execution evidence");
    }
    const { tokenIn, tokenOut, pool } = input.route;
    return { requirements: [], nodes: [{ adapterId: ROUTER_ACTION, target: ROUTER,
      tokenIn, tokenOut, amount: input.amountIn, params: { pool, minAmountOut: input.minAmountOut }, children: [] }] };
  },
  expectedEffects: ({ route }) => [
    { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
  ],
};
