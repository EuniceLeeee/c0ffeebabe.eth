import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { lower, MAX_UINT, sourceEqual, WETH } from "./codec.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import type { Descriptor, Evidence, Route } from "./types.js";
export const execution = {
  runtimeProjection: ({ hop }) => ({ allowanceSpender: lower(hop.tokenIn) === WETH ? null : hop.target, prewarmQuoteCalls: [] }),
  buildFragment(i) {
    assertRoute(i.descriptor, i.route);
    const e = i.exactEvidence; sourceEqual(e.source, e.source);
    if (e.kind !== "univ1-execution-math" || e.binding !== i.route.bindingRef.fingerprint || e.routeKey !== i.route.routeKey ||
        e.amountIn !== i.amountIn || e.amountOut !== i.quotedAmountOut || e.executor !== lower(i.executor) ||
        i.amountIn <= 0n || i.quotedAmountOut <= 0n || i.minAmountOut <= 0n || i.minAmountOut > i.quotedAmountOut ||
        [i.descriptor.issuer, i.descriptor.pool, i.descriptor.token].includes(lower(i.executor))) throw new Error("univ1 incompatible execution evidence");
    return { requirements: i.route.buy ? [] : [{ kind: "approve" as const, token: i.descriptor.token, spender: i.descriptor.pool, amount: MAX_UINT }],
      nodes: [{ adapterId: ACTION, target: i.descriptor.pool, tokenIn: i.route.tokenIn, tokenOut: i.route.tokenOut, amount: i.amountIn,
        params: { buy: i.route.buy, amountOut: i.minAmountOut, executor: i.executor }, children: [] }] };
  },
  expectedEffects: ({ route }) => [
    { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
  ],
} satisfies ExecutionSemantics<Descriptor, Route, Evidence>;
