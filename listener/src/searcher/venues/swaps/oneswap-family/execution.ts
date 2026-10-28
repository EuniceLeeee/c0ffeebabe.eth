import { ethers } from "ethers";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { checked, LIMIT112, lower, sourceEqual } from "./codec.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import { executionProgram } from "./runtime-execution.js";
import type { Descriptor, Evidence, Route } from "./types.js";
export const execution = {
  buildRuntimeLeg({ descriptor: d, route: r, executor, settlement }) {
    assertRoute(d, r);
    if (settlement?.kind === "quote-output" || settlement?.kind === "deferred-input") return null;
    return { actionAdapterId: ACTION, program: ethers.hexlify(executionProgram({ pool: d.pool, rawIn: r.buy ? d.money : d.stock,
      rawOut: r.buy ? d.stock : d.money, factory: d.factory, implementation: d.implementation, executor, minimum: 1n, ...(settlement ? { recipient: settlement.recipient } : {}) })),
      settlement: { directOutput: true }, ...(settlement ? { settlementRequest: settlement } : {}) };
  },
  runtimeProjection: () => ({ allowanceSpender: null, prewarmQuoteCalls: [] }),
  buildFragment(i) {
    const d = i.descriptor, r = i.route, e = i.exactEvidence;
    assertRoute(d, r); sourceEqual(e.source, e.source);
    checked(i.amountIn, LIMIT112); checked(i.quotedAmountOut, LIMIT112); checked(i.minAmountOut, LIMIT112);
    if (!i.amountIn || !i.minAmountOut || i.minAmountOut > i.quotedAmountOut || e.kind !== "oneswap-orderbook-math" ||
        e.routeKey !== r.routeKey || e.binding !== r.bindingRef.fingerprint || e.amountIn !== i.amountIn ||
        e.amountOut !== i.quotedAmountOut || e.executor !== lower(i.executor)) throw new Error("oneswap incompatible execution evidence");
    return { requirements: [], nodes: [{ adapterId: ACTION, target: d.pool, tokenIn: r.tokenIn, tokenOut: r.tokenOut, amount: i.amountIn,
      params: { rawIn: r.buy ? d.money : d.stock, rawOut: r.buy ? d.stock : d.money, factory: d.factory,
        implementation: d.implementation, executor: lower(i.executor), minimum: i.minAmountOut }, children: [] }] };
  },
  expectedEffects: ({ route }) => [
    { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
  ],
} satisfies ExecutionSemantics<Descriptor, Route, Evidence>;
