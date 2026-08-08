import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { MAX_UINT256, sameAddress } from "../standard-family/common.js";
import { assertMetronomeSynthInvocation } from "./shared.js";
import type {
  MetronomeSynthDescriptor,
  MetronomeSynthExactEvidence,
  MetronomeSynthRoute,
} from "./types.js";

export const metronomeSynthExecution = {
  buildFragment(input) {
    assertMetronomeSynthInvocation(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n ||
      input.quotedAmountOut <= 0n ||
      evidence.kind !== "metronome-synth-quote" ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      !sameAddress(evidence.pool, input.descriptor.pool) ||
      !sameAddress(evidence.tokenIn, input.route.tokenIn) ||
      !sameAddress(evidence.tokenOut, input.route.tokenOut) ||
      evidence.oracleBinding !== input.descriptor.oracleBinding ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint
    ) {
      throw new Error(
        "Metronome synth execution received incompatible exact evidence",
      );
    }
    return Object.freeze({
      requirements: Object.freeze([Object.freeze({
        kind: "approve" as const,
        token: input.route.tokenIn,
        spender: input.descriptor.pool,
        amount: MAX_UINT256,
      })]),
      nodes: Object.freeze([Object.freeze({
        adapterId: input.route.adapterId,
        target: input.descriptor.pool,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: {},
        children: [],
      })]),
    });
  },
  expectedEffects: ({ route }) => Object.freeze([
    Object.freeze({
      kind: "token-delta" as const,
      token: route.tokenIn,
      account: "executor" as const,
      direction: "decrease" as const,
    }),
    Object.freeze({
      kind: "token-delta" as const,
      token: route.tokenOut,
      account: "executor" as const,
      direction: "increase" as const,
    }),
  ]),
} satisfies ExecutionSemantics<
  MetronomeSynthDescriptor,
  MetronomeSynthRoute,
  MetronomeSynthExactEvidence
>;
