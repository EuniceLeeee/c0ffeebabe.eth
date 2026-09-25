import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { MOONISWAP_ACTION, assertRoute, assertUint, lower, nonzero } from "./codec.js";
import type { MooniswapDescriptor, MooniswapRoute, MooniswapQuoteEvidence } from "./types.js";
export const mooniswapExecution = {
  runtimeProjection: ({ hop }) => ({ allowanceSpender: hop.target, prewarmQuoteCalls: [] }),
  buildFragment(input) {
    assertRoute(input.descriptor, input.route);
    assertUint(input.amountIn, true); assertUint(input.quotedAmountOut, true); assertUint(input.minAmountOut);
    const e = input.exactEvidence;
    if (nonzero(input.executor) === lower(input.descriptor.pool) || input.minAmountOut > input.quotedAmountOut ||
        e.kind !== "mooniswap-get-return" || e.amountIn !== input.amountIn || e.amountOut !== input.quotedAmountOut ||
        e.routeKey !== input.route.routeKey || e.binding !== input.route.bindingRef.fingerprint ||
        lower(e.executor) !== lower(input.executor) || !e.governance) throw new Error("mooniswap incompatible execution evidence");
    nonzero(e.governance);
    return { requirements: [{ kind: "approve" as const, token: input.route.tokenIn,
      spender: input.descriptor.pool, amount: input.amountIn }], nodes: [{ adapterId: MOONISWAP_ACTION, target: input.descriptor.pool,
      tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, amount: input.amountIn,
      params: { minAmountOut: input.minAmountOut }, children: [] }] };
  },
  expectedEffects: ({ route }) => [
    { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
  ],
} satisfies ExecutionSemantics<MooniswapDescriptor, MooniswapRoute, MooniswapQuoteEvidence>;
