import type { ExactQuoteInput, ExactQuoteSemantics, ExactRequestProgram } from "../../adapter-family-plugin.js";
import { callRequest, canonicalAddress, lowerAddress, MAX_UINT256, successfulResult } from "../standard-family/common.js";
import { ARCANA_SOURCE_INTERFACE } from "./abi.js";
import { assertArcanaInvocation } from "./shared.js";
import type { ArcanaDescriptor, ArcanaExactEvidence, ArcanaRoute } from "./types.js";

type Input = ExactQuoteInput<ArcanaDescriptor, ArcanaRoute>;

function quote(input: Input, amountOut: bigint) {
  assertArcanaInvocation(input.descriptor, input.route);
  if (typeof input.amountIn !== "bigint" || input.amountIn <= 0n || input.amountIn > MAX_UINT256) {
    throw new Error("arcana exact input is outside positive uint256 range");
  }
  if (amountOut <= 0n) throw new Error("arcana preview returned zero");
  const evidence: ArcanaExactEvidence = Object.freeze({
    kind: "arcana-migration-preview",
    source: Object.freeze({ ...input.source }),
    sourceContract: canonicalAddress(input.descriptor.source),
    oldToken: canonicalAddress(input.descriptor.oldToken),
    arcToken: canonicalAddress(input.descriptor.arcToken),
    tokenId: input.descriptor.tokenId,
    amountIn: input.amountIn,
    amountOut,
    executor: canonicalAddress(input.executor),
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
  return Object.freeze({ amountOut, evidence });
}

const program: ExactRequestProgram<ArcanaDescriptor, ArcanaRoute, ArcanaExactEvidence> = {
  requirements: () => ({ transports: ["eth-call" as const] }),
  buildRequests: (input) => Object.freeze([callRequest(
    "exact-preview-arc",
    input.descriptor.source,
    ARCANA_SOURCE_INTERFACE.encodeFunctionData("previewArcAmount", [
      input.descriptor.tokenId,
      input.amountIn,
    ]),
  )]),
  decode({ programInput: input, initialResults }) {
    const result = successfulResult(initialResults, "exact-preview-arc");
    const amountOut = BigInt(ARCANA_SOURCE_INTERFACE.decodeFunctionResult(
      "previewArcAmount",
      result.data,
    )[0]);
    return quote(input, amountOut);
  },
};

export const arcanaMigrationExact = {
  methods: () => Object.freeze([Object.freeze({
    id: "arcana-migration-preview",
    kind: "request-program" as const,
    chainAmountQuote: true as const,
    program,
  })]),
  cacheCompatibilityProjection: ({ descriptor, route, executor }) => ({
    source: lowerAddress(descriptor.source),
    tokenId: descriptor.tokenId,
    executor: lowerAddress(executor),
    bindingFingerprint: route.bindingRef.fingerprint,
    quoteSemantics: "arcana-previewArcAmount-v1",
  }),
} satisfies ExactQuoteSemantics<ArcanaDescriptor, ArcanaRoute, ArcanaExactEvidence>;
