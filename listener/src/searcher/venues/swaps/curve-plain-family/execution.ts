import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { MAX_UINT } from "./codec.js";
import { actionId, assertRoute } from "./routes.js";
import type { CurvePlainDescriptor, CurvePlainExactEvidence, CurvePlainRoute } from "./types.js";

export const curvePlainExecution = {
  runtimeProjection: ({ hop }) => ({ allowanceSpender: hop.adapterId === "curve-exchange-plain" ? hop.target : null,
    prewarmQuoteCalls: [] }),
  buildFragment(input) {
    assertRoute(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (input.amountIn <= 0n || input.amountIn > MAX_UINT || input.minAmountOut < 0n || input.minAmountOut > input.quotedAmountOut ||
      evidence.kind !== "curve-plain-get-dy" || evidence.quoteAbi !== input.route.quoteAbi || evidence.binding !== input.route.bindingRef.fingerprint ||
      evidence.routeKey !== input.route.routeKey || evidence.amountIn !== input.amountIn || evidence.amountOut !== input.quotedAmountOut ||
      evidence.amountOut <= 0n) throw new Error("curve-plain incompatible exact execution evidence");
    const regular = input.route.executionMode === "exchange";
    return { requirements: regular
      ? [{ kind: "approve" as const, token: input.route.tokenIn, spender: input.descriptor.pool, amount: MAX_UINT }]
      : [{ kind: "transfer-to-pool" as const, token: input.route.tokenIn, pool: input.descriptor.pool, amount: input.amountIn }],
      nodes: [{ adapterId: actionId(input.route.executionMode), target: input.descriptor.pool,
        tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, amount: input.amountIn,
        params: { i: BigInt(input.route.i), j: BigInt(input.route.j), minDy: input.minAmountOut, receiver: input.executor }, children: [] }] };
  },
  expectedEffects: ({ route }) => [
    { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: route.tokenIn, account: "route-target", direction: "increase" },
    { kind: "token-delta", token: route.tokenOut, account: "route-target", direction: "decrease" },
    { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
  ],
} satisfies ExecutionSemantics<CurvePlainDescriptor, CurvePlainRoute, CurvePlainExactEvidence>;
