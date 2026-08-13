import { ADDR } from "../../../../shared/constants/addresses.js";
import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import { sameAddress } from "../standard-family/common.js";
import { assertSelfBurnNativeInvocation } from "./shared.js";
import type {
  SelfBurnNativeDescriptor,
  SelfBurnNativeExactEvidence,
  SelfBurnNativeRoute,
} from "./types.js";

export const selfBurnNativeExecution = {
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertSelfBurnNativeInvocation(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n ||
      input.quotedAmountOut <= 0n ||
      evidence.kind !== "self-burn-native-effect-delta" ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      !sameAddress(evidence.token, input.descriptor.token) ||
      !sameAddress(evidence.executor, input.executor) ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint
    ) {
      throw new Error(
        "self-burn native execution received incompatible exact evidence",
      );
    }
    return Object.freeze({
      requirements: Object.freeze([]),
      nodes: Object.freeze([
        Object.freeze({
          adapterId: input.route.adapterId,
          target: input.descriptor.token,
          tokenIn: input.descriptor.token,
          tokenOut: input.descriptor.token,
          amount: input.amountIn,
          params: {},
          children: [],
        }),
        Object.freeze({
          adapterId: "weth-deposit-value",
          target: input.descriptor.nativeAnchor,
          tokenIn: ADDR.ZERO,
          tokenOut: input.descriptor.nativeAnchor,
          amount: input.quotedAmountOut,
          params: {},
          children: [],
        }),
      ]),
    });
  },
  expectedEffects: ({ descriptor, route }) => Object.freeze([
    Object.freeze({
      kind: "token-delta" as const,
      token: route.tokenIn,
      account: "executor" as const,
      direction: "decrease" as const,
    }),
    Object.freeze({
      kind: "total-supply-delta" as const,
      token: descriptor.token,
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
  SelfBurnNativeDescriptor,
  SelfBurnNativeRoute,
  SelfBurnNativeExactEvidence
>;
