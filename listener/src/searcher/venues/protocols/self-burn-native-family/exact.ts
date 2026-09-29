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
  canonicalAddress,
  lowerAddress,
} from "../standard-family/common.js";
import { assertSelfBurnNativeInvocation } from "./shared.js";
import type {
  SelfBurnNativeDescriptor,
  SelfBurnNativeExactEvidence,
  SelfBurnNativeFeeParameters,
  SelfBurnNativeRoute,
} from "./types.js";

import { selfBurnFeeRequests, decodeSelfBurnFees, calculateSelfBurnFee } from "./fee-quote.js";
import { decodeSelfBurnTrial, quoteSelfBurnTrial, selfBurnTrialDependentRequests, selfBurnTrialRequests } from "./trial-state.js";

const MAX_UINT256 = (1n << 256n) - 1n;
type Input = ExactQuoteInput<SelfBurnNativeDescriptor, SelfBurnNativeRoute>;

function assertInput(input: Input): void {
  assertSelfBurnNativeInvocation(input.descriptor, input.route);
  if (typeof input.amountIn !== "bigint" || input.amountIn < 0n || input.amountIn > MAX_UINT256) {
    throw new Error("self-burn native exact input is outside uint256 range");
  }
}

const selfBurnNativeRequestProgram: ExactRequestProgram<
  SelfBurnNativeDescriptor, SelfBurnNativeRoute, SelfBurnNativeExactEvidence
> = {
  requirements(input) {
    assertInput(input);
    return { transports: input.amountIn === 0n ? [] : input.trialState ? ["eth-call" as const, "get-code" as const, "get-storage" as const] : ["eth-call" as const] };
  },
  buildRequests(input) {
    assertInput(input);
    return input.amountIn === 0n ? Object.freeze([]) : input.trialState ? selfBurnTrialRequests(input) : selfBurnFeeRequests(input.descriptor.token, "exact");
  },
  buildDependentProgram({ programInput, initialResults, completedRound }) {
    return programInput.trialState && programInput.amountIn > 0n && completedRound === 0
      ? bindRequestResultRound({ transports: ["get-code"] }, selfBurnTrialDependentRequests(programInput, initialResults)) : null;
  },
  decode({ programInput, initialResults, dependentEvidence }) {
    assertInput(programInput);
    if (programInput.amountIn === 0n) {
      if (initialResults.length !== 0) throw new Error("self-burn native zero quote has unexpected fee results");
      return Object.freeze({ amountOut: 0n, evidence: exactEvidence(programInput, 0n, null) });
    }
    if (programInput.trialState) return quoteSelfBurnTrial(programInput,
      decodeSelfBurnTrial(programInput, initialResults, collectRequestProgramResults(initialResults, dependentEvidence)))!;
    if (programInput.prefix?.length) throw new Error("self-burn prefix requires issued trial state");
    const { source, fees } = decodeSelfBurnFees(initialResults, "exact");
    assertSource(source, programInput.source);
    const fee = calculateSelfBurnFee(programInput.amountIn, fees);
    const evidence = exactEvidence(programInput, fee, fees);
    return Object.freeze({ amountOut: evidence.amountOut, evidence });
  },
};

export const selfBurnNativeExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<SelfBurnNativeDescriptor, SelfBurnNativeRoute, SelfBurnNativeExactEvidence>(
      "local-zero", input => {
        assertInput(input);
        return Object.freeze({ amountOut: 0n, evidence: exactEvidence(input, 0n, null) });
      }),
    Object.freeze({ id: "source-fee-quote", kind: "request-program" as const, program: selfBurnNativeRequestProgram,
      trialState: { quote(input: Input) {
        const result = quoteSelfBurnTrial(input);
        return result === undefined ? { status: "not-applicable" as const, reason: "self-burn trial inventory not loaded" }
          : { status: "quoted" as const, result };
      } } }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route, executor }) => ({
    token: lowerAddress(descriptor.token),
    executor: lowerAddress(executor),
    bindingFingerprint: route.bindingRef.fingerprint,
    quoteSemantics: "source-fee-getters-checked-uint256-v1",
  }),
} satisfies ExactQuoteSemantics<SelfBurnNativeDescriptor, SelfBurnNativeRoute, SelfBurnNativeExactEvidence>;

function exactEvidence(input: Input, fee: bigint, fees: SelfBurnNativeFeeParameters | null): SelfBurnNativeExactEvidence {
  return Object.freeze({
    kind: "self-burn-native-fee-quote",
    source: Object.freeze({ ...input.source }),
    token: canonicalAddress(input.descriptor.token),
    amountIn: input.amountIn,
    amountOut: input.amountIn - fee,
    executor: canonicalAddress(input.executor),
    bindingFingerprint: input.route.bindingRef.fingerprint,
    fee,
    fees,
  });
}
