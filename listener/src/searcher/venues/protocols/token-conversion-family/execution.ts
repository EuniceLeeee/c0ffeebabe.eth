import { NO_EXECUTION_RUNTIME_PROJECTION, type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { sameAddress } from "../standard-family/common.js";
import { assertInvocation } from "./binding.js";
import { positiveAmount } from "./variants.js";
import type { ConversionDescriptor, ConversionRoute, ConversionExactEvidence } from "./types.js";
export const execution = {
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(i) {
    assertInvocation(i.descriptor, i.route); positiveAmount(i.amountIn); positiveAmount(i.quotedAmountOut);
    const e = i.exactEvidence;
    // The central execution issuer validates the exact handle's canonical
    // source/session before exposing its evidence to this Family slot.
    if (e.kind !== "token-conversion-balance-quote" || e.direction !== i.route.direction ||
        e.amountIn !== i.amountIn || e.amountOut !== i.quotedAmountOut || !sameAddress(e.executor, i.executor) ||
        e.bindingFingerprint !== i.route.bindingRef.fingerprint) throw new Error("conversion execution evidence mismatch");
    return { requirements: [], nodes: [{ adapterId: i.route.adapterId, target: i.descriptor.target,
      tokenIn: i.route.tokenIn, tokenOut: i.route.tokenOut, amount: i.amountIn,
      params: { variant: i.descriptor.variant }, children: [] }] };
  },
  expectedEffects: ({ route }) => [
    { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
  ],
} satisfies ExecutionSemantics<ConversionDescriptor, ConversionRoute, ConversionExactEvidence>;
