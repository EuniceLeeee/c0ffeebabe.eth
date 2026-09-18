import { localZeroExactMethod, type ExactQuoteSemantics, type ExactQuoteInput, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { MAX_UINT, assertSource, call, quotePool, returned, uint } from "./codec.js";
import { assertRoute } from "./routes.js";
import type { CurvePlainDescriptor, CurvePlainExactEvidence, CurvePlainRoute } from "./types.js";

function validate(input: ExactQuoteInput<CurvePlainDescriptor, CurvePlainRoute>): void {
  assertRoute(input.descriptor, input.route);
  if (input.amountIn < 0n || input.amountIn > MAX_UINT) throw new Error("curve-plain invalid uint256 amount");
}
function quote(input: ExactQuoteInput<CurvePlainDescriptor, CurvePlainRoute>, amountOut: bigint) {
  return { amountOut, evidence: { kind: "curve-plain-get-dy" as const, quoteAbi: input.route.quoteAbi, source: input.source,
    binding: input.route.bindingRef.fingerprint, routeKey: input.route.routeKey, amountIn: input.amountIn, amountOut } };
}
const program: ExactRequestProgram<CurvePlainDescriptor, CurvePlainRoute, CurvePlainExactEvidence> = {
  requirements: () => ({ transports: ["eth-call"] }),
  buildRequests(input) {
    validate(input);
    return input.amountIn === 0n ? [] : [call("exact-get-dy", input.descriptor.pool,
      quotePool(input.route.quoteAbi).encodeFunctionData("get_dy", [input.route.i, input.route.j, input.amountIn]))];
  },
  decode({ programInput, initialResults }) {
    validate(programInput);
    if (programInput.amountIn === 0n) return quote(programInput, 0n);
    const read = returned(initialResults, "exact-get-dy");
    assertSource(read.source, programInput.source);
    const amountOut = uint(read.data);
    if (amountOut === 0n) throw new Error("curve-plain no positive exact output");
    return quote(programInput, amountOut);
  },
};
export const curvePlainExact = {
  methods: () => [localZeroExactMethod<CurvePlainDescriptor, CurvePlainRoute, CurvePlainExactEvidence>("local-zero", input => {
    validate(input); return quote(input, 0n);
  }), { id: "curve-plain-get-dy", kind: "request-program" as const, chainAmountQuote: true as const, program }],
  cacheCompatibilityProjection: ({ descriptor, route }) => ({ pool: descriptor.pool, binding: route.bindingRef.fingerprint,
    routeKey: route.routeKey, i: route.i, j: route.j, executionMode: route.executionMode, quoteAbi: route.quoteAbi }),
} satisfies ExactQuoteSemantics<CurvePlainDescriptor, CurvePlainRoute, CurvePlainExactEvidence>;
