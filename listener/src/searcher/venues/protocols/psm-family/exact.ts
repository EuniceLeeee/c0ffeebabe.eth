import {
  localZeroExactMethod,
  bindRequestResultRound,
  collectRequestProgramResults,
  type ExactQuoteInput,
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
import { assertPsmInvocation } from "./binding.js";
import { PSM_INTERFACE, psmSellQuote, psmBuyQuote } from "./codec.js";
import { decodePsmTrial, psmTrialDependentRequests, psmTrialRequests, quotePsmTrial } from "./trial-state.js";
import type {
  PsmDescriptor,
  PsmExactEvidence,
  PsmRoute,
} from "./types.js";

const psmRequestProgram: ExactRequestProgram<
  PsmDescriptor,
  PsmRoute,
  PsmExactEvidence
> = {
  requirements: ({ descriptor, route, amountIn, trialState }) => {
    assertPsmInvocation(descriptor, route);
    return { transports: amountIn === 0n ? [] : trialState ? ["get-code" as const, "eth-call" as const] : ["eth-call" as const] };
  },
  buildRequests(input) {
    assertPsmInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("PSM exact input cannot be negative");
    }
    if (input.amountIn > MAX_UINT256) throw new Error("PSM exact input exceeds uint256");
    if (input.amountIn === 0n) return [];
    if (input.trialState) return psmTrialRequests(input);
    return Object.freeze([callRequest(
      "exact-fee",
      input.descriptor.target,
      PSM_INTERFACE.encodeFunctionData(input.route.direction === "sell-gem" ? "tin" : "tout"),
    )]);
  },
  buildDependentProgram({ programInput, initialResults, completedRound }) {
    return programInput.trialState && programInput.amountIn > 0n && completedRound === 0
      ? bindRequestResultRound({ transports: ["eth-call"] }, psmTrialDependentRequests(programInput, initialResults)) : null;
  },
  decode({ programInput, initialResults, dependentEvidence }) {
    assertPsmInvocation(programInput.descriptor, programInput.route);
    if (programInput.amountIn < 0n || programInput.amountIn > MAX_UINT256) {
      throw new Error("PSM exact input is outside uint256 range");
    }
    const results = initialResults;
    if (programInput.amountIn === 0n) {
      return Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(programInput, 0n, 0n),
      });
    }
    if (programInput.trialState) return quotePsmTrial(programInput,
      decodePsmTrial(programInput, initialResults, collectRequestProgramResults(initialResults, dependentEvidence)))!;
    if (programInput.prefix?.length) throw new Error("PSM prefix requires issued trial state");
    if (results.length !== 1 || results[0]?.id !== "exact-fee") {
      throw new Error("PSM exact results are missing or ambiguous");
    }
    const result = returnedResult(results, "exact-fee");
    if (!/^0x[0-9a-fA-F]{64}$/.test(result.data)) throw new Error("PSM invalid uint256 result");
    assertSource(result.source, programInput.source);
    const fee = BigInt(
      PSM_INTERFACE.decodeFunctionResult(programInput.route.direction === "sell-gem" ? "tin" : "tout", result.data)[0],
    );
    const amountOut = (programInput.route.direction === "sell-gem" ? psmSellQuote : psmBuyQuote)(
      programInput.amountIn,
      fee,
      programInput.descriptor.decimalScale,
    );
    if (amountOut <= 0n) throw new Error("PSM exact quote returned no output");
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(programInput, amountOut, fee),
    });
  },
};

export const psmExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<PsmDescriptor, PsmRoute, PsmExactEvidence>(
      "local-zero",
      (input) => Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(input, 0n, 0n),
      }),
    ),
    Object.freeze({
      id: "psm-quote",
      kind: "request-program" as const,
      program: psmRequestProgram,
      trialState: { quote(input: ExactQuoteInput<PsmDescriptor, PsmRoute>) {
        assertPsmInvocation(input.descriptor, input.route);
        if (input.amountIn < 0n || input.amountIn > MAX_UINT256) throw new Error("PSM exact input is outside uint256 range");
        const result = quotePsmTrial(input);
        return result === undefined ? { status: "not-applicable" as const, reason: "PSM trial inventory not loaded" }
          : { status: "quoted" as const, result };
      } },
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    target: lowerAddress(descriptor.target),
    direction: route.direction,
    quoteSemantics: "source-directional-integer-fee-v2",
    decimalScale: descriptor.decimalScale,
    bindingFingerprint: route.bindingRef.fingerprint,
  }),
} satisfies ExactQuoteSemantics<PsmDescriptor, PsmRoute, PsmExactEvidence>;

function exactEvidence(
  input: {
    readonly descriptor: PsmDescriptor;
    readonly route: PsmRoute;
    readonly amountIn: bigint;
    readonly source: PsmExactEvidence["source"];
  },
  amountOut: bigint,
  fee: bigint,
): PsmExactEvidence {
  return Object.freeze({
    kind: "psm-directional-fee",
    direction: input.route.direction,
    source: input.source,
    target: input.descriptor.target,
    amountIn: input.amountIn,
    amountOut,
    fee,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}
