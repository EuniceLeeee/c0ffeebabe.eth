import type { ExecutionSemantics } from
  "../../adapter-family-plugin.js";
import { sameAddress } from "../standard-family/common.js";
import { assertEigenpieInvocation } from "./binding.js";
import type {
  EigenpieDescriptor,
  EigenpieExactEvidence,
  EigenpieRoute,
} from "./types.js";

export const eigenpieExecution = {
  buildFragment(input) {
    assertEigenpieInvocation(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n ||
      input.quotedAmountOut <= 0n ||
      evidence.kind !== "eigenpie-pair-quote" ||
      !sameAddress(evidence.tokenIn, input.route.tokenIn) ||
      !sameAddress(evidence.tokenOut, input.route.tokenOut) ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint
    ) {
      throw new Error(
        "Eigenpie execution received incompatible exact evidence",
      );
    }
    return Object.freeze({
      requirements: Object.freeze([Object.freeze({
        kind: "approve" as const,
        token: input.route.tokenIn,
        spender: input.descriptor.target,
        amount: input.amountIn,
      })]),
      nodes: Object.freeze([Object.freeze({
        adapterId: "eigenpie-deposit-asset",
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
      token: route.tokenOut,
      account: "executor" as const,
      direction: "increase" as const,
    }),
    Object.freeze({
      kind: "total-supply-delta" as const,
      token: route.tokenOut,
      direction: "increase" as const,
    }),
  ]),
} satisfies ExecutionSemantics<
  EigenpieDescriptor,
  EigenpieRoute,
  EigenpieExactEvidence
>;
