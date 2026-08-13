import { ethers } from "ethers";
import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import { assertAstraRouteBinding } from "./binding.js";
import { sameAddress } from "./codec.js";
import type {
  AstraMultiTokenDescriptor,
  AstraMultiTokenExactEvidence,
  AstraMultiTokenRoute,
} from "./types.js";

export const astraMultiTokenExecution = {
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertExecutionEvidence(input);
    return Object.freeze({
      requirements: Object.freeze([Object.freeze({
        kind: "approve" as const,
        token: input.route.tokenIn,
        spender: input.descriptor.target,
        amount: input.amountIn,
      })]),
      nodes: Object.freeze([Object.freeze({
        adapterId: "astra-multitoken-change",
        target: input.descriptor.target,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: { minAmountOut: input.minAmountOut },
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
      token: route.tokenIn,
      account: "route-target" as const,
      direction: "increase" as const,
    }),
    Object.freeze({
      kind: "token-delta" as const,
      token: route.tokenOut,
      account: "route-target" as const,
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
  AstraMultiTokenDescriptor,
  AstraMultiTokenRoute,
  AstraMultiTokenExactEvidence
>;

function assertExecutionEvidence(input: {
  readonly descriptor: AstraMultiTokenDescriptor;
  readonly route: AstraMultiTokenRoute;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly exactEvidence: AstraMultiTokenExactEvidence;
  readonly executor: string;
}): void {
  assertAstraRouteBinding(input.descriptor, input.route);
  const evidence = input.exactEvidence;
  if (
    input.amountIn <= 0n ||
    input.quotedAmountOut <= 0n ||
    evidence.kind !== "astra-multitoken-get-return" ||
    !sameAddress(evidence.target, input.descriptor.target) ||
    !sameAddress(input.route.target, input.descriptor.target) ||
    !sameAddress(evidence.tokenIn, input.route.tokenIn) ||
    !sameAddress(evidence.tokenOut, input.route.tokenOut) ||
    evidence.amountIn !== input.amountIn ||
    evidence.amountOut !== input.quotedAmountOut ||
    evidence.bindingFingerprint !== input.route.bindingRef.fingerprint
  ) {
    throw new Error(
      "astra-multitoken execution received incompatible exact evidence",
    );
  }
  ethers.getAddress(input.executor);
}
