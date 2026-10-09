import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor, runtimeExactApproval, runtimeClearApproval } from "../../runtime-execution.js";
import { ROUTER_ABI, PERMIT2, PERMIT2_ABI, MAX_EXPIRATION } from "./codec.js";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import type { PlanFragment } from "../../route-leg-adapter.js";
import { ROUTER, MAX_INPUT, MAX_UINT, same } from "./codec.js";
import { ROUTER_ACTION } from "./action.js";
import { assertRoute } from "./routes.js";
import { supportsLocalPricing } from "./local-state.js";
import type { BalancerV3Descriptor, BalancerV3ExactEvidence, BalancerV3Route } from "./types.js";

export const balancerV3Execution: ExecutionSemantics<BalancerV3Descriptor, BalancerV3Route, BalancerV3ExactEvidence> = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertRoute(d, r); runtimeExecutor(executor, d.pool, ROUTER, PERMIT2);
    const p = new RuntimeAmountProgram().constant(1, 160n).math("shr", 2, 0, 1).constant(3, 0n).equal(2, 3);
    runtimeExactApproval(p, r.tokenIn, PERMIT2);
    p.call(PERMIT2, PERMIT2_ABI.encodeFunctionData("approve", [r.tokenIn, ROUTER, 0n, MAX_EXPIRATION]),
      { patches: [{ offset: 68, reg: 0 }] })
      .call(ROUTER, ROUTER_ABI.encodeFunctionData("swapSingleTokenExactIn",
        [d.pool, r.tokenIn, r.tokenOut, 0n, 1n, MAX_UINT, false, "0x"]), { patches: [{ offset: 100, reg: 0 }] })
      .call(PERMIT2, PERMIT2_ABI.encodeFunctionData("approve", [r.tokenIn, ROUTER, 0n, 0n]));
    runtimeClearApproval(p, r.tokenIn, PERMIT2);
    return runtimeLeg(ROUTER_ACTION, p);
  },
  runtimeProjection: () => ({ allowanceSpender: null, prewarmQuoteCalls: [] }),
  buildFragment(input): PlanFragment {
    assertRoute(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (input.amountIn <= 0n || input.amountIn > MAX_INPUT || input.quotedAmountOut <= 0n || input.quotedAmountOut > MAX_UINT ||
        input.minAmountOut < 0n || input.minAmountOut > input.quotedAmountOut ||
        (evidence.kind !== "balancer-v3-router-exact-in" &&
          !(evidence.kind === "balancer-v3-local-exact-in" && supportsLocalPricing(input.descriptor))) ||
        evidence.binding !== input.route.bindingRef.fingerprint ||
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
