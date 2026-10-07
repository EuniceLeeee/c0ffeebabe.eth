import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { runtimeLeg, runtimeExecutor } from "../../runtime-execution.js";
import { VAULT, MAX_INPUT, MAX_UINT, same } from "./codec.js";
import { swapProgram } from "./runtime.js";
import { VAULT_ACTION } from "./action.js";
import { assertRoute } from "./routes.js";
import type { BalancerV2Descriptor, BalancerV2ExactEvidence, BalancerV2Route } from "./types.js";
export const execution: ExecutionSemantics<BalancerV2Descriptor, BalancerV2Route, BalancerV2ExactEvidence> = {
  buildRuntimeLeg({ descriptor: d, route: r, executor }) {
    assertRoute(d, r); runtimeExecutor(executor, d.pool, VAULT);
    return runtimeLeg(VAULT_ACTION, swapProgram(d.poolId, r.tokenIn, r.tokenOut, executor, 1n));
  },
  runtimeProjection: () => ({ allowanceSpender: null, prewarmQuoteCalls: [] }),
  buildFragment(i) {
    assertRoute(i.descriptor, i.route); runtimeExecutor(i.executor, i.descriptor.pool, VAULT);
    const e = i.exactEvidence;
    if (i.amountIn <= 0n || i.amountIn > MAX_INPUT || i.quotedAmountOut <= 0n || i.quotedAmountOut > MAX_UINT ||
        i.minAmountOut < 0n || i.minAmountOut > i.quotedAmountOut || e.kind !== "balancer-v2-vault-exact-in" ||
        e.binding !== i.route.bindingRef.fingerprint || e.routeKey !== i.route.routeKey || e.amountIn !== i.amountIn ||
        e.amountOut !== i.quotedAmountOut || !same(e.executor, i.executor)) throw new Error("balancer-v2 incompatible exact evidence");
    return { requirements: [], nodes: [{ adapterId: VAULT_ACTION, target: VAULT, tokenIn: i.route.tokenIn, tokenOut: i.route.tokenOut,
      amount: i.amountIn, params: { poolId: i.descriptor.poolId, minAmountOut: i.minAmountOut }, children: [] }] };
  },
  expectedEffects: ({ route }) => [
    { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
  ],
};
