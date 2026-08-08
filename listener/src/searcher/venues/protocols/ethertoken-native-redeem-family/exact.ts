import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import type {
  AdapterRequestResult,
  CanonicalSource,
} from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertSource,
  canonicalAddress,
  effectsProjection,
  lowerAddress,
  successfulResult,
} from "../standard-family/common.js";
import {
  assertEtherTokenNativeInvocation,
  etherTokenWithdrawalSimulation,
  validateEtherTokenWithdrawal,
} from "./shared.js";
import type {
  EtherTokenNativeRedeemDescriptor,
  EtherTokenNativeRedeemExactEvidence,
  EtherTokenNativeRedeemRoute,
} from "./types.js";

const etherTokenNativeRedeemRequestProgram: ExactRequestProgram<
  EtherTokenNativeRedeemDescriptor,
  EtherTokenNativeRedeemRoute,
  EtherTokenNativeRedeemExactEvidence
> = {
  requirements(input) {
    assertEtherTokenNativeInvocation(input.descriptor, input.route);
    return input.amountIn === 0n
      ? { transports: [] }
      : {
          transports: ["effect-delta-simulation" as const],
          caller: "executor" as const,
          effects: [
            "return-data" as const,
            "token-delta" as const,
            "native-delta" as const,
            "total-supply-delta" as const,
            "logs" as const,
          ],
        };
  },
  buildRequests(input) {
    assertEtherTokenNativeInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("EtherToken native exact input cannot be negative");
    }
    return input.amountIn === 0n
      ? []
      : Object.freeze([etherTokenWithdrawalSimulation({
          id: "exact-withdraw",
          token: input.descriptor.token,
          actor: input.executor,
          callerRef: Object.freeze({ kind: "executor" as const }),
          amountIn: input.amountIn,
        })]);
  },
  decode({ programInput, initialResults }) {
    const results = initialResults;
    if (programInput.amountIn === 0n) {
      return Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(programInput, 0n, null),
      });
    }
    const result = successfulResult(results, "exact-withdraw");
    assertSource(result.source, programInput.source);
    const amountOut = validateEtherTokenWithdrawal({
      result,
      token: programInput.descriptor.token,
      actor: programInput.executor,
      amountIn: programInput.amountIn,
    });
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(programInput, amountOut, result),
    });
  },
};

export const etherTokenNativeRedeemExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<
      EtherTokenNativeRedeemDescriptor,
      EtherTokenNativeRedeemRoute,
      EtherTokenNativeRedeemExactEvidence
    >(
      "local-zero",
      (input) => Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(input, 0n, null),
      }),
    ),
    Object.freeze({
      id: "withdraw-effect-simulation",
      kind: "request-program" as const,
      program: etherTokenNativeRedeemRequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route, executor }) => ({
    token: lowerAddress(descriptor.token),
    executor: lowerAddress(executor),
    bindingFingerprint: route.bindingRef.fingerprint,
    effectSemantics: "exact-burn-equal-native-out-v1",
  }),
} satisfies ExactQuoteSemantics<
  EtherTokenNativeRedeemDescriptor,
  EtherTokenNativeRedeemRoute,
  EtherTokenNativeRedeemExactEvidence
>;

function exactEvidence(
  input: {
    readonly descriptor: EtherTokenNativeRedeemDescriptor;
    readonly route: EtherTokenNativeRedeemRoute;
    readonly amountIn: bigint;
    readonly source: CanonicalSource;
    readonly executor: string;
  },
  amountOut: bigint,
  result: Extract<AdapterRequestResult, { readonly ok: true }> | null,
): EtherTokenNativeRedeemExactEvidence {
  return Object.freeze({
    kind: "ethertoken-native-effect-delta",
    source: input.source,
    token: input.descriptor.token,
    amountIn: input.amountIn,
    amountOut,
    executor: canonicalAddress(input.executor),
    bindingFingerprint: input.route.bindingRef.fingerprint,
    effectsHash: result === null
      ? hashCanonical([])
      : hashCanonical(effectsProjection(result.effects)),
  });
}
