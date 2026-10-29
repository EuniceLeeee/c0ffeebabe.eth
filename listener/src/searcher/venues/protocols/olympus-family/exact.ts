import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import {
  assertSource,
  callRequest,
  lowerAddress,
  MAX_UINT256,
  returnedResult,
} from "../standard-family/common.js";
import { assertOlympusInvocation } from "./binding.js";
import { OLYMPUS_INTERFACE, olympusQuote } from "./codec.js";
import type {
  OlympusDescriptor,
  OlympusExactEvidence,
  OlympusRoute,
} from "./types.js";

const olympusRequestProgram: ExactRequestProgram<
  OlympusDescriptor,
  OlympusRoute,
  OlympusExactEvidence
> = {
  requirements: ({ descriptor, route, amountIn }) => {
    assertOlympusInvocation(descriptor, route);
    return { transports: amountIn === 0n ? [] : ["eth-call" as const] };
  },
  buildRequests(input) {
    assertOlympusInvocation(input.descriptor, input.route);
    if (input.amountIn > 0n && (input.trialState || input.prefix?.length)) {
      throw new Error("Olympus sequential local state transition model is unproven");
    }
    if (input.amountIn < 0n) {
      throw new Error("Olympus exact input cannot be negative");
    }
    if (input.amountIn > MAX_UINT256) {
      throw new Error("Olympus exact input exceeds uint256");
    }
    if (input.amountIn === 0n) return [];
    return Object.freeze([callRequest(
      "exact-index",
      input.descriptor.staking,
      OLYMPUS_INTERFACE.encodeFunctionData("index"),
    )]);
  },
  decode({ programInput, initialResults }) {
    assertOlympusInvocation(programInput.descriptor, programInput.route);
    if (programInput.amountIn > 0n &&
        (programInput.trialState || programInput.prefix?.length)) {
      throw new Error("Olympus sequential local state transition model is unproven");
    }
    if (programInput.amountIn < 0n || programInput.amountIn > MAX_UINT256) {
      throw new Error("Olympus exact input is outside uint256 range");
    }
    if (programInput.amountIn === 0n) {
      return Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(programInput, 0n, 0n),
      });
    }
    if (initialResults.length !== 1 || initialResults[0]?.id !== "exact-index") {
      throw new Error("Olympus exact results are missing or ambiguous");
    }
    const result = returnedResult(initialResults, "exact-index");
    if (!/^0x[0-9a-fA-F]{64}$/.test(result.data)) {
      throw new Error("Olympus invalid uint256 result");
    }
    assertSource(result.source, programInput.source);
    const index = BigInt(
      OLYMPUS_INTERFACE.decodeFunctionResult("index", result.data)[0],
    );
    const amountOut = olympusQuote(programInput.amountIn, index);
    if (amountOut <= 0n) {
      throw new Error("Olympus exact quote returned no output");
    }
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(programInput, amountOut, index),
    });
  },
};

export const olympusExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<OlympusDescriptor, OlympusRoute, OlympusExactEvidence>(
      "local-zero",
      (input) => Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(input, 0n, 0n),
      }),
    ),
    Object.freeze({
      id: "olympus-index",
      kind: "request-program" as const,
      // gOHM burn and OHM payout are amount-independent in `index`, but this
      // Family has no proven model for replaying sequential trial state on
      // one staking contract. The production sim uses buildRuntimeLeg for
      // receipt-driven trials; explicit quotes keep this read-and-formula
      // method.
      trialState: { unsupportedReason: "Olympus unstake burn/payout state transition is not modeled for sequential trials" },
      program: olympusRequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }: {
    readonly descriptor: OlympusDescriptor;
    readonly route: OlympusRoute;
  }) => ({
    staking: lowerAddress(descriptor.staking),
    gOHM: lowerAddress(descriptor.gOHM),
    OHM: lowerAddress(descriptor.OHM),
    direction: route.direction,
    quoteSemantics: "olympus-index-floor-v1",
    bindingFingerprint: route.bindingRef.fingerprint,
  }),
} satisfies ExactQuoteSemantics<
  OlympusDescriptor,
  OlympusRoute,
  OlympusExactEvidence
>;

function exactEvidence(
  input: {
    readonly descriptor: OlympusDescriptor;
    readonly route: OlympusRoute;
    readonly amountIn: bigint;
    readonly source: OlympusExactEvidence["source"];
  },
  amountOut: bigint,
  index: bigint,
): OlympusExactEvidence {
  return Object.freeze({
    kind: "olympus-index-unstake",
    source: input.source,
    staking: input.descriptor.staking,
    gOHM: input.descriptor.gOHM,
    OHM: input.descriptor.OHM,
    amountIn: input.amountIn,
    amountOut,
    index,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}
