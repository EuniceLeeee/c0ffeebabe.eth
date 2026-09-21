import { localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { MAX_UINT, assertSource, lower, same } from "./codec.js";
import { assertRoute } from "./routes.js";
import { decodeState, quoteAmount, stateRequests } from "./state.js";
import type { EllaDescriptor, EllaEvidence, EllaRoute } from "./types.js";
type Input = ExactQuoteInput<EllaDescriptor, EllaRoute>;
function validate(i: Input) {
  assertRoute(i.descriptor, i.route);
  if (typeof i.amountIn !== "bigint" || i.amountIn < 0n || i.amountIn > MAX_UINT) throw new Error("ella invalid amountIn");
}
function quote(i: Input, amountOut: bigint, unavailableReason?: string) {
  return { amountOut, evidence: { kind: "ella-source-math" as const, source: i.source, executor: lower(i.executor),
    binding: i.route.bindingRef.fingerprint, routeKey: i.route.routeKey, amountIn: i.amountIn, amountOut,
    ...(unavailableReason ? { unavailableReason } : {}) } };
}
const program: ExactRequestProgram<EllaDescriptor, EllaRoute, EllaEvidence> = {
  requirements: () => ({ transports: ["eth-call", "get-storage"] }),
  buildRequests(i) { validate(i); return i.amountIn === 0n ? [] : stateRequests(i.descriptor); },
  decode({ programInput: i, initialResults, dependentEvidence }) {
    validate(i);
    if (dependentEvidence.length) throw new Error("ella unexpected dependent state");
    if (i.amountIn === 0n) return quote(i, 0n);
    const state = decodeState(i.descriptor, initialResults);
    assertSource(state.source, i.source);
    // A fee recipient equal to this caller would change its actual net delta.
    if (same(state.feesAddress, i.executor) || same(i.executor, i.descriptor.pool)) throw new Error("ella unsupported execution actor");
    const q = quoteAmount(state, i.route.direction, i.amountIn);
    return quote(i, q.amountOut, q.unavailableReason);
  },
};
export const ellaExact = {
  methods: () => [localZeroExactMethod<EllaDescriptor, EllaRoute, EllaEvidence>("local-zero", i => { validate(i); return quote(i, 0n); }),
    // No chainAmountQuote claim: tokenPrice is a rate, amountOut is local math.
    // No cross-block state carry guarantee for a mutable oracle binding.
    { id: "ella-source-math", kind: "request-program", program }],
  cacheCompatibilityProjection: i => ({ binding: i.route.bindingRef.fingerprint, direction: i.route.direction, executor: lower(i.executor) }),
} satisfies ExactQuoteSemantics<EllaDescriptor, EllaRoute, EllaEvidence>;
