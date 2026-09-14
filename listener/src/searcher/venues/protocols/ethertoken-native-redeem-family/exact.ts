import type { ExactQuoteInput, ExactQuoteSemantics } from "../../adapter-family-plugin.js";
import { canonicalAddress, lowerAddress, MAX_UINT256 } from "../standard-family/common.js";
import { assertEtherTokenNativeInvocation } from "./shared.js";
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
    Object.freeze({ id: "identity-proven-one-to-one", kind: "local" as const, quote }),
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
