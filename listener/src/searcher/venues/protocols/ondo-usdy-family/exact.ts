import type { ExactQuoteInput, ExactQuoteSemantics, ExactRequestProgram } from "../../adapter-family-plugin.js";
import { callRequest, canonicalAddress, lowerAddress, MAX_UINT256, successfulResult } from "../standard-family/common.js";
import { ONDO_FEES_INTERFACE, ONDO_MANAGER_INTERFACE, ONDO_ORACLE_INTERFACE } from "./abi.js";
import { redeemOut } from "./math.js";
import type { OndoDescriptor, OndoExactEvidence, OndoRoute } from "./types.js";

type Input = ExactQuoteInput<OndoDescriptor, OndoRoute>;
const ZERO_ID = "0x" + "0".repeat(64);

function quote(input: Input, priceRwa: bigint, priceReceive: bigint, feeFlat: bigint, feeBps: bigint, feePrecision: bigint) {
  if (input.amountIn <= 0n || input.amountIn > MAX_UINT256) throw new Error("ondo exact input out of range");
  const amountOut = redeemOut({ amount: input.amountIn, priceRwa, priceReceive, normalizer: input.descriptor.normalizer, receiveDecimals: input.descriptor.receiveDecimals, feeFlat, feeBps, feePrecision });
  const evidence: OndoExactEvidence = Object.freeze({ kind: "ondo-usdy-redeem", source: Object.freeze({ ...input.source }), manager: canonicalAddress(input.descriptor.manager), rwa: canonicalAddress(input.descriptor.rwa), receive: canonicalAddress(input.descriptor.receive), amountIn: input.amountIn, amountOut, executor: canonicalAddress(input.executor), bindingFingerprint: input.route.bindingRef.fingerprint });
  return Object.freeze({ amountOut, evidence });
}

const program: ExactRequestProgram<OndoDescriptor, OndoRoute, OndoExactEvidence> = {
  requirements: () => ({ transports: ["eth-call" as const] }),
  buildRequests: (input) => Object.freeze([
    callRequest("ondo-price-rwa", input.descriptor.oracle, ONDO_ORACLE_INTERFACE.encodeFunctionData("getAssetPrice", [input.descriptor.rwa])),
    callRequest("ondo-price-receive", input.descriptor.oracle, ONDO_ORACLE_INTERFACE.encodeFunctionData("getAssetPrice", [input.descriptor.receive])),
    callRequest("ondo-fee-config", input.descriptor.fees, ONDO_FEES_INTERFACE.encodeFunctionData("getActiveFeeConfig", [input.descriptor.rwa, input.descriptor.receive, ZERO_ID])),
    callRequest("ondo-fee-precision", input.descriptor.fees, ONDO_FEES_INTERFACE.encodeFunctionData("FEE_PRECISION")),
  ]),
  decode({ programInput: input, initialResults }) {
    const priceRwa = BigInt(ONDO_ORACLE_INTERFACE.decodeFunctionResult("getAssetPrice", successfulResult(initialResults, "ondo-price-rwa").data)[0]);
    const priceReceive = BigInt(ONDO_ORACLE_INTERFACE.decodeFunctionResult("getAssetPrice", successfulResult(initialResults, "ondo-price-receive").data)[0]);
    const cfg = ONDO_FEES_INTERFACE.decodeFunctionResult("getActiveFeeConfig", successfulResult(initialResults, "ondo-fee-config").data);
    const active = cfg[0] as unknown as { flatFee: bigint; bpsFee: bigint };
    const feePrecision = BigInt(ONDO_FEES_INTERFACE.decodeFunctionResult("FEE_PRECISION", successfulResult(initialResults, "ondo-fee-precision").data)[0]);
    return quote(input, priceRwa, priceReceive, BigInt(active.flatFee ?? 0n), BigInt(active.bpsFee ?? 0n), feePrecision);
  },
};

export const ondoExact = {
  methods: () => Object.freeze([Object.freeze({ id: "ondo-usdy-redeem", kind: "request-program" as const, chainAmountQuote: true as const, program })]),
  cacheCompatibilityProjection: ({ descriptor, route, executor }) => ({ manager: lowerAddress(descriptor.manager), executor: lowerAddress(executor), bindingFingerprint: route.bindingRef.fingerprint, quoteSemantics: "ondo-usdy-instant-redeem-v1" }),
} satisfies ExactQuoteSemantics<OndoDescriptor, OndoRoute, OndoExactEvidence>;
