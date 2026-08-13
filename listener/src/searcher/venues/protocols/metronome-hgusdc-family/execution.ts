import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import {
  assertMetronomeHgUsdcInvocation,
} from "./shared.js";
import { sameAddress } from "../standard-family/common.js";
import type {
  MetronomeHgUsdcDescriptor,
  MetronomeHgUsdcExactEvidence,
  MetronomeHgUsdcRoute,
} from "./types.js";

export const metronomeHgUsdcExecution = {
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertMetronomeHgUsdcInvocation(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n ||
      input.quotedAmountOut <= 0n ||
      evidence.kind !== "metronome-hgusdc-dependent-quote" ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      evidence.curveOut <= 0n ||
      !sameAddress(evidence.router, input.descriptor.router) ||
      !sameAddress(evidence.curve, input.descriptor.curve) ||
      !sameAddress(evidence.vault, input.descriptor.vault) ||
      evidence.pathHash !== input.descriptor.pathHash ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint
    ) {
      throw new Error(
        "Metronome hgUSDC execution received incompatible exact evidence",
      );
    }
    return Object.freeze({
      requirements: Object.freeze([Object.freeze({
        kind: "transfer-to-pool" as const,
        token: input.descriptor.tokenIn,
        pool: input.descriptor.curve,
        amount: input.amountIn,
      })]),
      nodes: Object.freeze([Object.freeze({
        adapterId: input.route.adapterId,
        target: input.descriptor.router,
        tokenIn: input.descriptor.tokenIn,
        tokenOut: input.descriptor.tokenOut,
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
  MetronomeHgUsdcDescriptor,
  MetronomeHgUsdcRoute,
  MetronomeHgUsdcExactEvidence
>;
