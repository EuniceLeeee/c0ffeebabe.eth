import type { ExactQuoteInput, ExactQuoteSemantics, ExactRequestProgram } from "../../adapter-family-plugin.js";
import { MAX_UINT256, callRequest, canonicalAddress, lowerAddress, successfulResult } from "../standard-family/common.js";
import { ACCOUNTANT_INTERFACE } from "./abi.js";
import { withdrawOut } from "./pricing.js";
import type { BoringDescriptor, BoringExactEvidence, BoringRoute } from "./types.js";

type Input = ExactQuoteInput<BoringDescriptor, BoringRoute>;

const program: ExactRequestProgram<BoringDescriptor, BoringRoute, BoringExactEvidence> = {
  requirements: () => ({ transports: ["eth-call" as const] }),
  buildRequests: (input: Input) => Object.freeze([
    callRequest("boring-rate", input.descriptor.accountant, ACCOUNTANT_INTERFACE.encodeFunctionData("getRateInQuoteSafe", [input.descriptor.asset])),
  ]),
  decode({ programInput: input, initialResults }) {
    if (input.amountIn <= 0n || input.amountIn > MAX_UINT256) throw new Error("boring exact input out of range");
    const rate = BigInt(ACCOUNTANT_INTERFACE.decodeFunctionResult("getRateInQuoteSafe", successfulResult(initialResults, "boring-rate").data)[0]);
    const amountOut = withdrawOut({ shares: input.amountIn, rate, shareDecimals: input.descriptor.shareDecimals });
    const evidence: BoringExactEvidence = Object.freeze({
      kind: "boring-vault-withdraw",
      source: Object.freeze({ ...input.source }),
      teller: canonicalAddress(input.descriptor.teller),
      vault: canonicalAddress(input.descriptor.vault),
      asset: canonicalAddress(input.descriptor.asset),
      amountIn: input.amountIn,
      amountOut,
      executor: canonicalAddress(input.executor),
      bindingFingerprint: input.route.bindingRef.fingerprint,
    });
    return Object.freeze({ amountOut, evidence });
  },
};

export const boringExact = {
  methods: () => Object.freeze([Object.freeze({
    id: "boring-vault-withdraw",
    kind: "request-program" as const,
    chainAmountQuote: true as const,
    program,
  })]),
  cacheCompatibilityProjection: ({ descriptor, route, executor }: {
    readonly descriptor: BoringDescriptor;
    readonly route: BoringRoute;
    readonly executor: string;
  }) => ({
    teller: lowerAddress(descriptor.teller),
    executor: lowerAddress(executor),
    bindingFingerprint: route.bindingRef.fingerprint,
    quoteSemantics: "boring-vault-teller-v1",
  }),
} satisfies ExactQuoteSemantics<BoringDescriptor, BoringRoute, BoringExactEvidence>;
