import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import {
  assertSource,
  callRequest,
  lowerAddress,
  returnedResult,
  sameAddress,
} from "../standard-family/common.js";
import { assertEigenpieInvocation } from "./binding.js";
import {
  decodeEigenpieQuote,
  EIGENPIE_INTERFACE,
} from "./codec.js";
import type {
  EigenpieDescriptor,
  EigenpieExactEvidence,
  EigenpieRoute,
} from "./types.js";

const eigenpieRequestProgram: ExactRequestProgram<
  EigenpieDescriptor,
  EigenpieRoute,
  EigenpieExactEvidence
> = {
  requirements: ({ descriptor, route }) => {
    assertEigenpieInvocation(descriptor, route);
    return { transports: ["eth-call" as const] };
  },
  buildRequests(input) {
    assertEigenpieInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("Eigenpie exact input cannot be negative");
    }
    if (input.amountIn === 0n) return [];
    return Object.freeze([callRequest(
      "exact-quote",
      input.descriptor.target,
      EIGENPIE_INTERFACE.encodeFunctionData("getMLRTAmountToMint", [
        input.route.tokenIn,
        input.amountIn,
      ]),
    )]);
  },
  decode({ programInput, initialResults }) {
    const results = initialResults;
    if (programInput.amountIn === 0n) {
      return Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(programInput, 0n),
      });
    }
    const result = returnedResult(results, "exact-quote");
    assertSource(result.source, programInput.source);
    const quote = decodeEigenpieQuote(result.data);
    if (
      !sameAddress(quote.tokenOut, programInput.route.tokenOut) ||
      quote.amountOut <= 0n
    ) {
      throw new Error("Eigenpie exact quote returned an incompatible receipt");
    }
    return Object.freeze({
      amountOut: quote.amountOut,
      evidence: exactEvidence(programInput, quote.amountOut),
    });
  },
};

export const eigenpieExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<EigenpieDescriptor, EigenpieRoute, EigenpieExactEvidence>(
      "local-zero",
      (input) => Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(input, 0n),
      }),
    ),
    Object.freeze({
      id: "get-mlrt-amount-to-mint",
      kind: "request-program" as const,
      program: eigenpieRequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    target: lowerAddress(descriptor.target),
    asset: lowerAddress(route.tokenIn),
    receipt: lowerAddress(route.tokenOut),
    bindingFingerprint: route.bindingRef.fingerprint,
  }),
} satisfies ExactQuoteSemantics<
  EigenpieDescriptor,
  EigenpieRoute,
  EigenpieExactEvidence
>;

function exactEvidence(
  input: {
    readonly descriptor: EigenpieDescriptor;
    readonly route: EigenpieRoute;
    readonly amountIn: bigint;
    readonly source: CanonicalSource;
  },
  amountOut: bigint,
): EigenpieExactEvidence {
  return Object.freeze({
    kind: "eigenpie-pair-quote",
    source: input.source,
    target: input.descriptor.target,
    tokenIn: input.route.tokenIn,
    tokenOut: input.route.tokenOut,
    amountIn: input.amountIn,
    amountOut,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}
