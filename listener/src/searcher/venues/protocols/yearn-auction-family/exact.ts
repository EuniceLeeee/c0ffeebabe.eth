import { localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { uint } from "./codec.js";
import { assertRoute } from "./routes.js";
import { decodeState, quoteBudget, requirements, stateRequests } from "./state.js";
import type { Descriptor, Evidence, Route, State } from "./types.js";
type Input = ExactQuoteInput<Descriptor, Route>;
function check(i: Input): string {
  assertRoute(i.descriptor, i.route); uint(i.amountIn);
  if (i.prefix?.length || i.runtimeEvidence.length) throw new Error("Yearn auction sequential/pending quote requires shared prefix execution; use runtime sim");
  return runtimeExecutor(i.executor, i.descriptor.target, i.descriptor.implementation, i.descriptor.want, i.descriptor.sold).toLowerCase();
}
const evidence = (i: Input, q: { amountOut: bigint; spent: bigint }, state: State): Evidence => ({ kind: "yearn-auction-budget", source: i.source,
  fingerprint: i.route.bindingRef.fingerprint, routeKey: i.route.routeKey, executor: check(i), amountIn: i.amountIn, ...q, state });
export const program: ExactRequestProgram<Descriptor, Route, Evidence> = {
  requirements: i => { check(i); return i.amountIn ? requirements : { transports: [] }; },
  buildRequests: i => { check(i); return i.amountIn ? stateRequests(i.descriptor) : []; },
  decode({ programInput: i, initialResults, dependentEvidence }) {
    check(i); if (dependentEvidence.length) throw new Error("Yearn auction unexpected dependent round");
    if (!i.amountIn) { if (initialResults.length) throw new Error("Yearn auction unexpected zero reads");
      return { amountOut: 0n, evidence: evidence(i, { amountOut: 0n, spent: 0n }, { source: i.source, receiver: i.descriptor.target, rawPrice: 0n, available: 0n }) }; }
    const state = decodeState(i.descriptor, initialResults, i.source);
    if (state.receiver === check(i)) throw new Error("Yearn auction payment receiver cannot be executor");
    const q = quoteBudget(i.descriptor, state, i.amountIn); return { amountOut: q.amountOut, evidence: evidence(i, q, state) };
  },
};
export const exact = { methods: () => [localZeroExactMethod<Descriptor, Route, Evidence>("zero", i => {
  check(i); return { amountOut: 0n, evidence: evidence(i, { amountOut: 0n, spent: 0n }, { source: i.source, receiver: i.descriptor.target, rawPrice: 0n, available: 0n }) }; }),
  // Amount-specific local inversion of current on-chain state, not a chain
  // amount quote. Timestamp-dependent reads must never carry across sources.
  { id: "current-auction-budget", kind: "request-program", trialState: { unsupportedReason: "auction price, capacity and settlement require shared prefix execution" }, program }],
  cacheCompatibilityProjection: i => ({ binding: i.route.bindingRef.fingerprint, route: i.route.routeKey, executor: check(i) }),
} satisfies ExactQuoteSemantics<Descriptor, Route, Evidence>;
