import {
  localZeroExactMethod,
  type ExactQuoteInput,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import {
  assertSource,
  MAX_UINT256,
  returnedResult,
} from "../standard-family/common.js";
import { assertOriginStethArmInvocation } from "./binding.js";
import {
  ORIGIN_STETH_ARM_PRICE_SCALE,
  originStethArmQuote,
  originStethArmRateSlot,
  storageRequest,
  storageWordToUint,
} from "./codec.js";
import type {
  OriginStethArmDescriptor,
  OriginStethArmExactEvidence,
  OriginStethArmRoute,
} from "./types.js";

type Input = ExactQuoteInput<OriginStethArmDescriptor, OriginStethArmRoute>;

const RATE_REQUEST_ID = "exact-traderate";

/**
 * Exact swap output for the verified implementation. The only chain read is
 * the same price word the swap uses; the output is the protocol's own integer
 * formula `floor(amountIn * rate / 1e36)`, not a point-price approximation.
 * Sequential trial overlays are not modeled because a swap leg cannot change
 * the operator-only price words; the declaration is explicit rather than an
 * invented approximation.
 */
const originStethArmRequestProgram: ExactRequestProgram<
  OriginStethArmDescriptor,
  OriginStethArmRoute,
  OriginStethArmExactEvidence
> = {
  requirements: ({ descriptor, route, amountIn }) => {
    assertOriginStethArmInvocation(descriptor, route);
    return { transports: amountIn === 0n ? [] : ["get-storage" as const] };
  },
  buildRequests(input) {
    assertOriginStethArmInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("Origin stETH ARM exact input cannot be negative");
    }
    if (input.amountIn > MAX_UINT256) {
      throw new Error("Origin stETH ARM exact input exceeds uint256");
    }
    if (input.amountIn === 0n) return Object.freeze([]);
    return Object.freeze([storageRequest(
      RATE_REQUEST_ID,
      input.descriptor.target,
      originStethArmRateSlot(input.route.direction),
    )]);
  },
  decode({ programInput, initialResults }) {
    assertOriginStethArmInvocation(programInput.descriptor, programInput.route);
    if (programInput.amountIn < 0n || programInput.amountIn > MAX_UINT256) {
      throw new Error("Origin stETH ARM exact input is outside uint256 range");
    }
    if (programInput.amountIn === 0n) {
      if (initialResults.length !== 0) {
        throw new Error("Origin stETH ARM zero exact has unexpected state");
      }
      return Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(programInput, 0n, 0n),
      });
    }
    if (initialResults.length !== 1 || initialResults[0]?.id !== RATE_REQUEST_ID) {
      throw new Error("Origin stETH ARM exact price read is missing or ambiguous");
    }
    const result = returnedResult(initialResults, RATE_REQUEST_ID);
    assertSource(result.source, programInput.source);
    const rate = storageWordToUint(result.data);
    const amountOut = originStethArmQuote(programInput.amountIn, rate);
    if (amountOut <= 0n) {
      throw new Error("Origin stETH ARM exact quote returned no output");
    }
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(programInput, amountOut, rate),
    });
  },
};

export const originStethArmExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<
      OriginStethArmDescriptor,
      OriginStethArmRoute,
      OriginStethArmExactEvidence
    >(
      "local-zero",
      (input) => Object.freeze({
        amountOut: 0n,
        evidence: exactEvidence(input, 0n, 0n),
      }),
    ),
    Object.freeze({
      id: "origin-steth-arm-price",
      kind: "request-program" as const,
      trialState: {
        unsupportedReason:
          "origin-steth-arm operator price words are read per quote; no sequential trial overlay is modeled",
      },
      program: originStethArmRequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    target: route.target.toLowerCase(),
    direction: route.direction,
    quoteSemantics: "origin-arm-linear-price-v1",
    priceScale: ORIGIN_STETH_ARM_PRICE_SCALE,
    rateSlot: originStethArmRateSlot(route.direction),
    bindingFingerprint: route.bindingRef.fingerprint,
    implementationCodeHash: descriptor.implementationCodeHash,
  }),
} satisfies ExactQuoteSemantics<
  OriginStethArmDescriptor,
  OriginStethArmRoute,
  OriginStethArmExactEvidence
>;

function exactEvidence(
  input: Input,
  amountOut: bigint,
  rate: bigint,
): OriginStethArmExactEvidence {
  return Object.freeze({
    kind: "origin-steth-arm-linear-price" as const,
    source: Object.freeze({ ...input.source }),
    target: input.descriptor.target,
    tokenIn: input.route.tokenIn,
    tokenOut: input.route.tokenOut,
    direction: input.route.direction,
    amountIn: input.amountIn,
    amountOut,
    rate,
    rateSlot: originStethArmRateSlot(input.route.direction),
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}
