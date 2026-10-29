import { ethers } from "ethers";
import { NO_EXECUTION_RUNTIME_PROJECTION, type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { address, amount } from "./codec.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import { swapProgram } from "./runtime.js";
import type { Descriptor, Evidence, Route } from "./types.js";

export const execution = {
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildRuntimeLeg(input) {
    const descriptor = input.descriptor, route = input.route;
    assertRoute(descriptor, route);
    const request = input.settlement;
    // This family's verified flow is input-first with no pair callback; it does
    // not claim Ammalgam's `ammalgamSwapCallV1` deferred-input path.
    if (request !== undefined && request.kind === "deferred-input") return null;
    const executor = runtimeExecutor(input.executor, descriptor.pair, route.tokenIn, route.tokenOut);
    const recipient = request !== undefined &&
      (request.kind === "direct-output" || (request.kind === "quote-output" && request.recipient !== undefined))
      ? address(request.recipient!)
      : address(executor);
    const program = swapProgram({
      pair: descriptor.pair,
      tokenX: descriptor.tokenX,
      tokenY: descriptor.tokenY,
      xForY: route.xForY,
      executor,
      recipient,
      minimum: 1n,
    });
    return {
      actionAdapterId: ACTION,
      program: ethers.hexlify(program.bytes()),
      settlement: { directOutput: true as const },
      ...(request === undefined ? {} : { settlementRequest: request }),
    };
  },
  buildFragment(input) {
    const descriptor = input.descriptor, route = input.route, evidence = input.exactEvidence;
    assertRoute(descriptor, route);
    amount(input.amountIn);
    amount(input.quotedAmountOut);
    amount(input.minAmountOut, true);
    runtimeExecutor(input.executor, descriptor.pair, route.tokenIn, route.tokenOut);
    if (input.minAmountOut > input.quotedAmountOut) throw new Error("ammalgam minimum above quote");
    if (evidence.kind !== "ammalgam-pair-execution" ||
        evidence.executor !== input.executor.toLowerCase() ||
        evidence.binding !== route.bindingRef.fingerprint ||
        evidence.routeKey !== route.routeKey ||
        evidence.amountIn !== input.amountIn ||
        evidence.amountOut !== input.quotedAmountOut) {
      throw new Error("ammalgam incompatible exact evidence");
    }
    return {
      requirements: [],
      nodes: [{
        adapterId: ACTION,
        target: descriptor.pair,
        tokenIn: route.tokenIn,
        tokenOut: route.tokenOut,
        amount: input.amountIn,
        params: {
          minimum: input.minAmountOut,
          xForY: route.xForY,
          tokenX: descriptor.tokenX,
          tokenY: descriptor.tokenY,
        },
        children: [],
      }],
    };
  },
  expectedEffects: ({ route }) => [
    { kind: "token-delta" as const, token: route.tokenIn, account: "executor" as const, direction: "decrease" as const },
    { kind: "token-delta" as const, token: route.tokenOut, account: "executor" as const, direction: "increase" as const },
  ],
} satisfies ExecutionSemantics<Descriptor, Route, Evidence>;
