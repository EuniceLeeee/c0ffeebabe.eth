import { NO_EXECUTION_RUNTIME_PROJECTION, type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { assertInvocation } from "./binding.js";
import { calculate, nonzero } from "./codec.js";
import type { Descriptor, Route, ExactEvidence } from "./types.js";
export const execution = {
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertInvocation(input.descriptor, input.route);
    const e = input.exactEvidence;
    if (input.amountIn <= 0n || input.quotedAmountOut <= 0n || input.minAmountOut < 0n || input.minAmountOut > input.quotedAmountOut ||
        e.kind !== "mantle-migration-amount-quote" || e.amountIn !== input.amountIn || e.amountOut !== input.quotedAmountOut ||
        e.bindingFingerprint !== input.route.bindingRef.fingerprint || nonzero(e.executor) !== nonzero(input.executor) ||
        calculate(input.amountIn, input.descriptor.numerator, input.descriptor.denominator) !== input.quotedAmountOut) {
      throw new Error("migration incompatible exact evidence");
    }
    return { requirements: [], nodes: [{ adapterId: "token-migration", target: input.descriptor.target,
      tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, amount: input.amountIn, params: {}, children: [] }] };
  },
  expectedEffects: ({ route }) => [
    { kind: "token-delta" as const, token: route.tokenIn, account: "executor" as const, direction: "decrease" as const },
    { kind: "token-delta" as const, token: route.tokenOut, account: "executor" as const, direction: "increase" as const },
  ],
} satisfies ExecutionSemantics<Descriptor, Route, ExactEvidence>;
