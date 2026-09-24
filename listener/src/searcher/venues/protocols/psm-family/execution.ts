import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import { MAX_UINT256 } from "../standard-family/common.js";
import { assertPsmInvocation } from "./binding.js";
import { psmBuyQuote, psmSellQuote } from "./codec.js";
import type { PsmDescriptor, PsmExactEvidence, PsmRoute } from "./types.js";

export const psmExecution = {
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertPsmInvocation(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n ||
      input.quotedAmountOut <= 0n ||
      evidence.kind !== "psm-directional-fee" ||
      evidence.direction !== input.route.direction ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint
    ) {
      throw new Error("PSM execution received incompatible exact evidence");
    }
    const sell = input.route.direction === "sell-gem";
    if ((sell ? psmSellQuote : psmBuyQuote)(input.amountIn, evidence.fee,
      input.descriptor.decimalScale) !== input.quotedAmountOut) {
      throw new Error("PSM execution fee does not reproduce exact output");
    }
    return Object.freeze({
      requirements: Object.freeze([Object.freeze({
        kind: "approve" as const,
        token: input.route.tokenIn,
        spender: input.descriptor.target,
        amount: MAX_UINT256,
      })]),
      nodes: Object.freeze([Object.freeze({
        adapterId: "psm",
        target: input.descriptor.target,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: { direction: input.route.direction,
          gemAmount: sell ? input.amountIn : input.quotedAmountOut,
          fee: evidence.fee, scale: input.descriptor.decimalScale },
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
} satisfies ExecutionSemantics<PsmDescriptor, PsmRoute, PsmExactEvidence>;
