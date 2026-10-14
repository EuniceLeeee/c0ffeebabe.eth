import { NO_EXECUTION_RUNTIME_PROJECTION, type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { runtimeLeg } from "../../runtime-execution.js";
import { amount, address } from "./codec.js";
import { binding } from "./instance.js";
import { assertRoute } from "./routes.js";
import { swapProgram, quoteProgram } from "./runtime.js";
import { ACTION } from "./manifest.js";
import type { Descriptor, Route, Evidence } from "./types.js";
export const execution = {
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildRuntimeLeg(i) {
    assertRoute(i.descriptor, i.route);
    const request = i.settlement;
    if (request && !["quote-output", "direct-output", "deferred-input"].includes(request.kind)) return null;
    const program = request?.kind === "quote-output" ? quoteProgram(i.descriptor, i.route.i, i.executor, request.recipient)
      : swapProgram(i.descriptor, i.route.i, i.executor, 1n, request);
    return { ...runtimeLeg(ACTION, program), settlement: { quoteOutput: true, directOutput: true,
      // This is the measured callback funding account, not the final maker.
      // SwapVM owns the subsequent transferFrom and Aqua.push bookkeeping.
      deferredInput: address(i.executor) }, ...(request ? { settlementRequest: request } : {}) };
  },
  buildFragment(i) {
    assertRoute(i.descriptor, i.route); amount(i.amountIn); amount(i.quotedAmountOut); amount(i.minAmountOut, true);
    const e = i.exactEvidence, origin = i.transactionOrigin === undefined ? null : address(i.transactionOrigin);
    if (e.kind !== "aqua-swapvm-quote" || e.executor !== address(i.executor) || e.transactionOrigin !== origin ||
        e.binding !== i.route.bindingRef.fingerprint || e.routeKey !== i.route.routeKey || e.amountIn !== i.amountIn || e.amountOut !== i.quotedAmountOut)
      throw new Error("aqua Exact evidence mismatch");
    swapProgram(i.descriptor, i.route.i, i.executor, i.minAmountOut);
    return { requirements: [], nodes: [{ adapterId: ACTION, target: i.descriptor.router, tokenIn: i.route.tokenIn, tokenOut: i.route.tokenOut,
      amount: i.amountIn, params: { binding: JSON.stringify(binding(i.descriptor)), i: BigInt(i.route.i), minAmountOut: i.minAmountOut }, children: [] }] };
  },
  expectedEffects: ({ route: r }) => [{ kind: "token-delta", token: r.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: r.tokenOut, account: "executor", direction: "increase" }],
} satisfies ExecutionSemantics<Descriptor, Route, Evidence>;
