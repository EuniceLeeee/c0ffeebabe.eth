import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import {
  assertSource,
  callRequest,
  lowerAddress,
  returnedResult,
} from "../standard-family/common.js";
import { assertWstethInvocation } from "./binding.js";
import { WSTETH_INTERFACE } from "./codec.js";
import type {
  WstethDescriptor,
  WstethExactEvidence,
  WstethRoute,
} from "./types.js";

const wstethRequestProgram: ExactRequestProgram<
  WstethDescriptor,
  WstethRoute,
  WstethExactEvidence
> = {
  requirements: ({ descriptor, route }) => {
    assertWstethInvocation(descriptor, route);
    return { transports: ["eth-call" as const] };
  },
  buildRequests(input) {
    assertWstethInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("wstETH exact input cannot be negative");
    }
    if (input.amountIn === 0n) return [];
    return Object.freeze([callRequest(
      "exact-conversion",
      input.descriptor.target,
      WSTETH_INTERFACE.encodeFunctionData(
        input.route.direction === "wrap"
          ? "getWstETHByStETH"
          : "getStETHByWstETH",
        [input.amountIn],
      ),
    )]);
  },
  decode({ programInput, initialResults }) {
    const results = initialResults;
    assertWstethInvocation(programInput.descriptor, programInput.route);
    if (programInput.amountIn === 0n) {
      return Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(programInput, 0n),
      });
    }
    const result = returnedResult(results, "exact-conversion");
    assertSource(result.source, programInput.source);
    const fn = programInput.route.direction === "wrap"
      ? "getWstETHByStETH"
      : "getStETHByWstETH";
    const amountOut = BigInt(
      WSTETH_INTERFACE.decodeFunctionResult(fn, result.data)[0],
    );
    if (amountOut <= 0n) {
      throw new Error("wstETH exact quote returned no output");
    }
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(programInput, amountOut),
    });
  },
};

export const wstethExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<WstethDescriptor, WstethRoute, WstethExactEvidence>(
      "local-zero",
      (input) => Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(input, 0n),
      }),
    ),
    Object.freeze({
      id: "wsteth-preview",
      kind: "request-program" as const,
      program: wstethRequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    target: lowerAddress(descriptor.target),
    direction: route.direction,
    bindingFingerprint: route.bindingRef.fingerprint,
  }),
} satisfies ExactQuoteSemantics<
  WstethDescriptor,
  WstethRoute,
  WstethExactEvidence
>;

function exactEvidence(
  input: {
    readonly descriptor: WstethDescriptor;
    readonly route: WstethRoute;
    readonly amountIn: bigint;
    readonly source: WstethExactEvidence["source"];
  },
  amountOut: bigint,
): WstethExactEvidence {
  return Object.freeze({
    kind: "wsteth-conversion-quote",
    source: input.source,
    target: input.descriptor.target,
    direction: input.route.direction,
    amountIn: input.amountIn,
    amountOut,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}
