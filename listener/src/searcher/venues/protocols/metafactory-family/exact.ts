import { ethers } from "ethers";
import type {
  ExactQuoteSemantics,
  ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import {
  callRequest,
  canonicalAddress,
  MAX_UINT256,
  returnedResult,
  assertSameSource,
} from "../standard-family/common.js";
import { assertMetafactoryInvocation } from "./binding.js";
import {
  METAFACTORY_INTERFACE,
  METAFACTORY_MAX_UINT256,
  metafactoryRedeemAmount,
  metafactoryWord,
} from "./codec.js";
import type {
  MetafactoryDescriptor,
  MetafactoryExactEvidence,
  MetafactoryRoute,
} from "./types.js";

const metafactoryRequestProgram: ExactRequestProgram<
  MetafactoryDescriptor,
  MetafactoryRoute,
  MetafactoryExactEvidence
> = {
  requirements: () => ({ transports: ["eth-call" as const] }),
  buildRequests(input) {
    assertMetafactoryInvocation(input.descriptor, input.route);
    if (canonicalAddress(input.executor) === ethers.ZeroAddress) {
      throw new Error("metafactory redemption executor is the zero address");
    }
    if (input.amountIn <= 0n || input.amountIn > MAX_UINT256) {
      throw new Error("metafactory redemption input is outside uint256 range");
    }
    return Object.freeze([
      callRequest(
        "exact-eth-allocated",
        input.descriptor.target,
        METAFACTORY_INTERFACE.encodeFunctionData("totalEthAllocated"),
      ),
      callRequest(
        "exact-circulating-supply",
        input.descriptor.target,
        METAFACTORY_INTERFACE.encodeFunctionData("circulatingSupply"),
      ),
      // The exact same view the composter itself exposes for the requested
      // amount. It is cross-checked against the bound pro-rata expression.
      callRequest(
        "exact-amount-quote",
        input.descriptor.target,
        METAFACTORY_INTERFACE.encodeFunctionData(
          "calculateRedemptionAmount",
          [input.amountIn],
        ),
      ),
    ]);
  },
  decode({ programInput: input, initialResults }) {
    assertMetafactoryInvocation(input.descriptor, input.route);
    if (input.amountIn <= 0n || input.amountIn > MAX_UINT256) {
      throw new Error("metafactory redemption input is outside uint256 range");
    }
    if (input.prefix?.length) {
      throw new Error("metafactory prefix is not modelled by the pro-rata view");
    }
    const allocated = returnedResult(initialResults, "exact-eth-allocated");
    const supply = returnedResult(initialResults, "exact-circulating-supply");
    const quoted = returnedResult(initialResults, "exact-amount-quote");
    const source = assertSameSource([allocated, supply, quoted]);
    if (
      input.source !== undefined &&
      (source.number !== input.source.number ||
        source.hash.toLowerCase() !== input.source.hash.toLowerCase() ||
        source.generation !== input.source.generation)
    ) {
      throw new Error("metafactory exact quote came from a foreign source");
    }
    const totalEthAllocated = metafactoryWord(
      allocated.data, "metafactory totalEthAllocated");
    const circulatingSupply = metafactoryWord(
      supply.data, "metafactory circulatingSupply");
    const chainAmountOut = metafactoryWord(
      quoted.data, "metafactory redemption amount");
    const amountOut = metafactoryRedeemAmount(
      input.amountIn, totalEthAllocated, circulatingSupply);
    if (chainAmountOut !== amountOut) {
      throw new Error(
        "metafactory chain redemption amount disagrees with the bound pro-rata rate",
      );
    }
    if (amountOut <= 0n) {
      throw new Error("metafactory zero output is not searchable");
    }
    if (amountOut > METAFACTORY_MAX_UINT256) {
      throw new Error("metafactory output is outside uint256 range");
    }
    return Object.freeze({
      amountOut,
      evidence: Object.freeze({
        kind: "metafactory-pro-rata-eth-quote" as const,
        source,
        target: canonicalAddress(input.descriptor.target),
        tokenIn: canonicalAddress(input.descriptor.tokenIn),
        nativeAnchor: canonicalAddress(input.descriptor.nativeAnchor),
        amountIn: input.amountIn,
        amountOut,
        totalEthAllocated,
        circulatingSupply,
        executor: canonicalAddress(input.executor),
        bindingFingerprint: input.route.bindingRef.fingerprint,
      }) satisfies MetafactoryExactEvidence,
    });
  },
};

export const metafactoryExact = {
  methods: () => Object.freeze([Object.freeze({
    id: "metafactory-pro-rata-eth-view",
    kind: "request-program" as const,
    // The composter's own view returns this amount; it is a chain amount
    // quote for the requested input, not a local point-price extrapolation.
    chainAmountQuote: true as const,
    program: metafactoryRequestProgram,
  })]),
  cacheCompatibilityProjection: ({ descriptor, route, executor }) => ({
    target: descriptor.target.toLowerCase(),
    tokenIn: descriptor.tokenIn.toLowerCase(),
    nativeAnchor: descriptor.nativeAnchor.toLowerCase(),
    codeHash: descriptor.codeHash.toLowerCase(),
    executor: canonicalAddress(executor).toLowerCase(),
    bindingFingerprint: route.bindingRef.fingerprint,
    quoteSemantics: "compost-pro-rata-eth-view-v1",
  }),
} satisfies ExactQuoteSemantics<
  MetafactoryDescriptor,
  MetafactoryRoute,
  MetafactoryExactEvidence
>;
