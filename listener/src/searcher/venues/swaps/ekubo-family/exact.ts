import { localZeroExactMethod, type ExactQuoteSemantics, type ExactQuoteInput, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { EKUBO_MAX_EXACT_INPUT, encodeEkuboQuote } from "../ekubo/abi.js";
import { assertSource, call, decodeQuote, lower, returned, validateResults } from "./codec.js";
import { staticBinding } from "./instance.js";
import { assertRoute } from "./routes.js";
import type { EkuboDescriptor, EkuboExactEvidence, EkuboRoute } from "./types.js";

function validate(input: ExactQuoteInput<EkuboDescriptor, EkuboRoute>): void {
  assertRoute(input.descriptor, input.route);
  assertSource(input.source, input.source);
  lower(input.executor);
  if (input.amountIn < 0n || input.amountIn > EKUBO_MAX_EXACT_INPUT) throw new Error("ekubo invalid int128 exact input");
}
function quote(input: ExactQuoteInput<EkuboDescriptor, EkuboRoute>, amountOut: bigint) {
  return { amountOut, evidence: { kind: "ekubo-router-exact-input" as const, source: Object.freeze({ ...input.source }),
    executor: lower(input.executor), binding: input.route.bindingRef.fingerprint, routeKey: input.route.routeKey,
    amountIn: input.amountIn, amountOut } };
}
const program: ExactRequestProgram<EkuboDescriptor, EkuboRoute, EkuboExactEvidence> = {
  requirements: () => ({ transports: ["eth-call"] }),
  buildRequests(input) {
    validate(input);
    return input.amountIn === 0n ? [] : [call("exact-quote", encodeEkuboQuote(input.descriptor.poolKey, input.route.isToken1, input.amountIn))];
  },
  decode({ programInput, initialResults, dependentEvidence }) {
    validate(programInput);
    if (dependentEvidence.length !== 0) throw new Error("ekubo unexpected exact rounds");
    validateResults(initialResults, programInput.amountIn === 0n ? [] : ["exact-quote"], programInput.source);
    if (programInput.amountIn === 0n) return quote(programInput, 0n);
    const decoded = decodeQuote(returned(initialResults, "exact-quote").data, programInput.route.isToken1, programInput.amountIn);
    return quote(programInput, decoded.amountOut);
  },
};
export const ekuboExact = {
  methods: () => [localZeroExactMethod<EkuboDescriptor, EkuboRoute, EkuboExactEvidence>("local-zero", input => {
    validate(input); return quote(input, 0n);
  }), { id: "ekubo-router-exact-input", kind: "request-program" as const, chainAmountQuote: true as const, program }],
  cacheCompatibilityProjection: ({ descriptor, route }) => ({ ...staticBinding(descriptor), routeKey: route.routeKey,
    binding: route.bindingRef.fingerprint, isToken1: route.isToken1 }),
} satisfies ExactQuoteSemantics<EkuboDescriptor, EkuboRoute, EkuboExactEvidence>;
