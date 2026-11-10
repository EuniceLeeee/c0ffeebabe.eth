import type {
  ExactQuoteInput,
  ExactQuoteSemantics,
  ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import { callRequest, canonicalAddress, lowerAddress, MAX_UINT256, successfulResult } from "../standard-family/common.js";
import { MELLOW_ORACLE_INTERFACE } from "./abi.js";
import { depositShares, redeemAssets } from "./math.js";
import { assertMellowQueueInvocation } from "./shared.js";
import type {
  MellowQueueDescriptor,
  MellowQueueExactEvidence,
  MellowQueueRoute,
} from "./types.js";

type Input = ExactQuoteInput<MellowQueueDescriptor, MellowQueueRoute>;

function quoteWithPrice(input: Input, priceD18: bigint) {
  assertMellowQueueInvocation(input.descriptor, input.route);
  if (typeof input.amountIn !== "bigint" || input.amountIn <= 0n || input.amountIn > MAX_UINT256) {
    throw new Error("mellow queue exact input is outside positive uint256 range");
  }
  if (priceD18 <= 0n) throw new Error("mellow queue oracle price is zero");
  const d = input.descriptor;
  const amountOut = d.kind === "deposit"
    ? depositShares({ assets: input.amountIn, priceD18, penaltyD6: d.penaltyD6 })
    : redeemAssets({ shares: input.amountIn, priceD18, penaltyD6: d.penaltyD6 });
  const evidence: MellowQueueExactEvidence = Object.freeze({
    kind: "mellow-queue-oracle-price",
    source: Object.freeze({ ...input.source }),
    queue: canonicalAddress(d.queue),
    asset: canonicalAddress(d.asset),
    share: canonicalAddress(d.share),
    direction: d.kind,
    amountIn: input.amountIn,
    amountOut,
    priceD18,
    penaltyD6: d.penaltyD6,
    executor: canonicalAddress(input.executor),
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
  return Object.freeze({ amountOut, evidence });
}

const program: ExactRequestProgram<MellowQueueDescriptor, MellowQueueRoute, MellowQueueExactEvidence> = {
  requirements: () => ({ transports: ["eth-call" as const] }),
  buildRequests: (input) => Object.freeze([callRequest(
    "exact-oracle-report",
    input.descriptor.oracle,
    MELLOW_ORACLE_INTERFACE.encodeFunctionData("getReport", [input.descriptor.asset]),
  )]),
  decode({ programInput: input, initialResults }) {
    const result = successfulResult(initialResults, "exact-oracle-report");
    const decoded = MELLOW_ORACLE_INTERFACE.decodeFunctionResult("getReport", result.data);
    return quoteWithPrice(input, BigInt(decoded[0]));
  },
};

export const mellowQueueExact = {
  methods: () => Object.freeze([Object.freeze({
    id: "mellow-queue-oracle-price",
    kind: "request-program" as const,
    chainAmountQuote: true as const,
    program,
  })]),
  cacheCompatibilityProjection: ({ descriptor, route, executor }) => ({
    queue: lowerAddress(descriptor.queue),
    kind: descriptor.kind,
    executor: lowerAddress(executor),
    bindingFingerprint: route.bindingRef.fingerprint,
    quoteSemantics: "mellow-oracle-getReport-v1",
  }),
} satisfies ExactQuoteSemantics<
  MellowQueueDescriptor,
  MellowQueueRoute,
  MellowQueueExactEvidence
>;
