import { localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { checked, lower, sourceEqual } from "./codec.js";
import { assertRoute } from "./routes.js";
import { decodeState, quoteAmount, stateRequests } from "./state.js";
import type { Descriptor, Evidence, Route } from "./types.js";
type Input = ExactQuoteInput<Descriptor, Route>;
function validate(i: Input): void {
  assertRoute(i.descriptor, i.route); checked(i.amountIn); sourceEqual(i.source, i.source);
  const executor = lower(i.executor);
  // An issuer/exchange actor would receive fees or alter reserve accounting.
  if ([i.descriptor.issuer, i.descriptor.pool, i.descriptor.token].includes(executor)) throw new Error("univ1 unsupported executor");
}
function quoted(i: Input, amountOut: bigint) {
  return { amountOut, evidence: { kind: "univ1-execution-math" as const, source: Object.freeze({ ...i.source }), executor: lower(i.executor),
    binding: i.route.bindingRef.fingerprint, routeKey: i.route.routeKey, amountIn: i.amountIn, amountOut } };
}
const program: ExactRequestProgram<Descriptor, Route, Evidence> = {
  requirements: () => ({ transports: ["eth-call"] }),
  buildRequests(i) { validate(i); return i.amountIn === 0n ? [] : stateRequests(i.descriptor); },
  decode({ programInput: i, initialResults, dependentEvidence }) {
    validate(i);
    if (dependentEvidence.length) throw new Error("univ1 unexpected quote rounds");
    if (i.amountIn === 0n) {
      if (initialResults.length) throw new Error("univ1 unexpected zero quote results");
      return quoted(i, 0n);
    }
    return quoted(i, quoteAmount(decodeState(initialResults, i.source), i.route.buy, i.amountIn));
  },
};
export const exact = {
  methods: () => [localZeroExactMethod<Descriptor, Route, Evidence>("local-zero", i => { validate(i); return quoted(i, 0n); }),
    { id: "univ1-execution-math", kind: "request-program", program }],
  cacheCompatibilityProjection: ({ route, executor }) => ({ binding: route.bindingRef.fingerprint, routeKey: route.routeKey, executor: lower(executor) }),
} satisfies ExactQuoteSemantics<Descriptor, Route, Evidence>;
