import { ADDR } from "../../../../shared/constants/addresses.js";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import type { ResolvedPlanNode } from "../../../../types.js";
import { MAX_UINT, same } from "./codec.js";
import { actionId, assertRoute } from "./routes.js";
import type { EllaDescriptor, EllaEvidence, EllaRoute } from "./types.js";

export const ellaExecution = {
  runtimeProjection: ({ hop }) => ({ allowanceSpender: hop.adapterId === "ella-sell-token" ? hop.target : null, prewarmQuoteCalls: [] }),
  buildFragment(i) {
    assertRoute(i.descriptor, i.route);
    const e = i.exactEvidence;
    if (i.amountIn <= 0n || i.amountIn > MAX_UINT || i.quotedAmountOut <= 0n || i.minAmountOut < 0n || i.minAmountOut > i.quotedAmountOut ||
        e.kind !== "ella-source-math" || e.unavailableReason || e.binding !== i.route.bindingRef.fingerprint ||
        e.routeKey !== i.route.routeKey || e.amountIn !== i.amountIn || e.amountOut !== i.quotedAmountOut || !same(e.executor, i.executor)) {
      throw new Error("ella incompatible execution evidence");
    }
    const buy = i.route.direction === "buy-token";
    const swap: ResolvedPlanNode = { adapterId: actionId(i.route.direction), target: i.descriptor.pool,
      tokenIn: buy ? ADDR.ZERO : i.descriptor.token, tokenOut: buy ? i.descriptor.token : ADDR.ZERO,
      amount: i.amountIn, params: {}, children: [] };
    const wrap: ResolvedPlanNode = { adapterId: buy ? "weth-withdraw-amount" : "weth-deposit-value", target: ADDR.WETH,
      tokenIn: buy ? ADDR.WETH : ADDR.ZERO, tokenOut: buy ? ADDR.ZERO : ADDR.WETH,
      amount: buy ? i.amountIn : i.quotedAmountOut, params: {}, children: [] };
    // No native minOut function exists. The common executor amount propagation
    // and mandatory terminal balance/repayment guard remain authoritative.
    return { requirements: buy ? [] : [{ kind: "approve" as const, token: i.descriptor.token, spender: i.descriptor.pool, amount: MAX_UINT }],
      nodes: buy ? [wrap, swap] : [swap, wrap] };
  },
  expectedEffects: ({ route }) => [
    { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
  ],
} satisfies ExecutionSemantics<EllaDescriptor, EllaRoute, EllaEvidence>;
