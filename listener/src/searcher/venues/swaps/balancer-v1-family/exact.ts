import { bindRequestResultRound, collectRequestProgramResults, localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { call, checked, nonzero, returned, sourceEqual, uint, validateResults } from "./codec.js";
import { assertRoute } from "./routes.js";
import { decodeState, guardOutput, quoteData, stateRequests } from "./state.js";
import type { Descriptor, Evidence, Route } from "./types.js";
type Input = ExactQuoteInput<Descriptor, Route>;
function validate(i: Input): void {
  assertRoute(i.descriptor, i.route); checked(i.amountIn); sourceEqual(i.source, i.source);
  const actor = nonzero(i.executor);
  if ([i.descriptor.pool, i.descriptor.factory, ...i.descriptor.tokens].includes(actor)) throw new Error("balancer-v1 unsupported executor");
}
function quoted(i: Input, amountOut: bigint) {
  return { amountOut, evidence: { kind: "balancer-v1-chain-exact-in" as const, source: Object.freeze({ ...i.source }), executor: nonzero(i.executor),
    binding: i.route.bindingRef.fingerprint, routeKey: i.route.routeKey, amountIn: i.amountIn, amountOut } };
}
const program: ExactRequestProgram<Descriptor, Route, Evidence> = {
  requirements: () => ({ transports: ["eth-call"] }),
  buildRequests(i) { validate(i); return i.amountIn === 0n ? [] : stateRequests(i.descriptor); },
  buildDependentProgram({ programInput: i, completedRound, initialResults, priorEvidence }) {
    validate(i);
    if (i.amountIn === 0n || completedRound > 0) return null;
    if (priorEvidence.length) throw new Error("balancer-v1 unexpected quote rounds");
    const state = decodeState(i.descriptor, initialResults, i.source);
    return bindRequestResultRound({ transports: ["eth-call"] }, [call("amount-out", i.descriptor.pool, quoteData(i.descriptor, i.route, state, i.amountIn))]);
  },
  decode({ programInput: i, initialResults, dependentEvidence }) {
    validate(i);
    if (i.amountIn === 0n) {
      if (initialResults.length || dependentEvidence.length) throw new Error("balancer-v1 unexpected zero quote results");
      return quoted(i, 0n);
    }
    if (dependentEvidence.length !== 1) throw new Error("balancer-v1 missing/extra quote round");
    const state = decodeState(i.descriptor, initialResults, i.source);
    const all = collectRequestProgramResults(initialResults, dependentEvidence);
    validateResults(all, [...i.descriptor.tokens.map((_, k) => `balance:${k}`), "amount-out"], i.source);
    const amountOut = uint(returned(all, "amount-out"));
    guardOutput(i.descriptor, i.route, state, i.amountIn, amountOut);
    return quoted(i, amountOut);
  },
};
export const exact = {
  methods: () => [localZeroExactMethod<Descriptor, Route, Evidence>("local-zero", i => { validate(i); return quoted(i, 0n); }),
    { id: "balancer-v1-chain-exact-in", kind: "request-program", chainAmountQuote: true, program }],
  cacheCompatibilityProjection: ({ route, executor }) => ({ binding: route.bindingRef.fingerprint, routeKey: route.routeKey, executor: nonzero(executor) }),
} satisfies ExactQuoteSemantics<Descriptor, Route, Evidence>;
