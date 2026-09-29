import { localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { canonicalAddress, lowerAddress, MAX_UINT256 } from "../standard-family/common.js";
import { assertEtherTokenNativeInvocation } from "./shared.js";
import { decodeEtherTokenTrial, etherTokenTrialRequests, quoteEtherTokenTrial } from "./trial-state.js";
import type {
  EtherTokenNativeRedeemDescriptor,
  EtherTokenNativeRedeemExactEvidence,
  EtherTokenNativeRedeemRoute,
} from "./types.js";

type Input = ExactQuoteInput<EtherTokenNativeRedeemDescriptor, EtherTokenNativeRedeemRoute>;

// Identity proves an exact token burn and equal native payout. This is the
// amount model, not proof of this actor's balance or current redeemability;
// the real withdraw + WETH deposit still goes through mandatory final sim.
function quote(input: Input) {
  assertEtherTokenNativeInvocation(input.descriptor, input.route);
  if (typeof input.amountIn !== "bigint" || input.amountIn < 0n || input.amountIn > MAX_UINT256) {
    throw new Error("EtherToken native exact input is outside uint256 range");
  }
  const evidence: EtherTokenNativeRedeemExactEvidence = Object.freeze({
    kind: "ethertoken-native-one-to-one",
    source: Object.freeze({ ...input.source }),
    token: canonicalAddress(input.descriptor.token),
    amountIn: input.amountIn,
    amountOut: input.amountIn,
    executor: canonicalAddress(input.executor),
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
  return Object.freeze({ status: "quoted" as const,
    result: Object.freeze({ amountOut: input.amountIn, evidence }) });
}

export const etherTokenNativeRedeemExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<EtherTokenNativeRedeemDescriptor, EtherTokenNativeRedeemRoute, EtherTokenNativeRedeemExactEvidence>("local-zero", i => quote(i).result),
    Object.freeze({ id: "identity-proven-one-to-one", kind: "request-program" as const, program,
      trialState: { quote(i: Input) {
        const result = quoteEtherTokenTrial(i);
        return result === undefined ? { status: "not-applicable" as const, reason: "EtherToken trial inventory not loaded" }
          : { status: "quoted" as const, result };
      } } }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route, executor }) => ({
    token: lowerAddress(descriptor.token),
    executor: lowerAddress(executor),
    bindingFingerprint: route.bindingRef.fingerprint,
    quoteSemantics: "exact-burn-equal-native-out-v1",
  }),
} satisfies ExactQuoteSemantics<
  EtherTokenNativeRedeemDescriptor,
  EtherTokenNativeRedeemRoute,
  EtherTokenNativeRedeemExactEvidence
>;

const program: ExactRequestProgram<EtherTokenNativeRedeemDescriptor, EtherTokenNativeRedeemRoute, EtherTokenNativeRedeemExactEvidence> = {
  requirements: i => ({ transports: i.amountIn > 0n && i.trialState ? ["eth-call", "get-code"] : [] }),
  buildRequests: i => i.amountIn > 0n && i.trialState ? etherTokenTrialRequests(i) : [],
  decode({ programInput: i, initialResults, dependentEvidence }) {
    if (dependentEvidence.length) throw new Error("EtherToken unexpected dependent state");
    if (i.amountIn > 0n && i.trialState) return quoteEtherTokenTrial(i, decodeEtherTokenTrial(i, initialResults))!;
    if (i.prefix?.length) throw new Error("EtherToken prefix requires issued trial state");
    if (initialResults.length) throw new Error("EtherToken unexpected independent quote state");
    return quote(i).result;
  },
};
