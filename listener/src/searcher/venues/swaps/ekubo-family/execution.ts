import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { EKUBO_MAX_EXACT_INPUT, EKUBO_ROUTER } from "../ekubo/abi.js";
import { createEkuboPoolKeyBinding } from "../ekubo/pool-key.js";
import { assertSource, MAX_UINT, same } from "./codec.js";
import { EKUBO_ACTION_ID } from "./manifest.js";
import { assertRoute } from "./routes.js";
import type { EkuboDescriptor, EkuboExactEvidence, EkuboRoute } from "./types.js";

export const ekuboExecution = {
  runtimeProjection: () => ({ allowanceSpender: EKUBO_ROUTER, prewarmQuoteCalls: [] }),
  buildFragment(input) {
    const { descriptor, route, exactEvidence: evidence } = input;
    assertRoute(descriptor, route);
    assertSource(evidence.source, evidence.source);
    if (input.amountIn <= 0n || input.amountIn > EKUBO_MAX_EXACT_INPUT || input.minAmountOut <= 0n ||
        input.minAmountOut > input.quotedAmountOut || evidence.kind !== "ekubo-router-exact-input" ||
        evidence.binding !== route.bindingRef.fingerprint || evidence.routeKey !== route.routeKey ||
        evidence.amountIn !== input.amountIn || evidence.amountOut !== input.quotedAmountOut || evidence.amountOut <= 0n ||
        !same(evidence.executor, input.executor)) throw new Error("ekubo incompatible exact execution evidence");
    return { requirements: [{ kind: "approve" as const, token: route.tokenIn, spender: EKUBO_ROUTER, amount: MAX_UINT }],
      nodes: [{ adapterId: EKUBO_ACTION_ID, target: EKUBO_ROUTER, tokenIn: route.tokenIn, tokenOut: route.tokenOut,
        amount: input.amountIn, params: { ...descriptor.poolKey, poolId: descriptor.poolId,
          bindingHash: createEkuboPoolKeyBinding(descriptor.poolKey).hash, isToken1: route.isToken1,
          amountOutMin: input.minAmountOut, receiver: input.executor }, children: [] }] };
  },
  // The router is not pool custody. Core holds balances for many independent
  // pools; only the executor's two route-token deltas are the generic effects.
  expectedEffects: ({ route }) => [
    { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
  ],
} satisfies ExecutionSemantics<EkuboDescriptor, EkuboRoute, EkuboExactEvidence>;
