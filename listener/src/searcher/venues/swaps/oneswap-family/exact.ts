import { localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { checked, LIMIT112, lower, sourceEqual } from "./codec.js";
import { quoteAmount } from "./math.js";
import { assertRoute } from "./routes.js";
import { decodeState, stateRequests } from "./state.js";
import type { Descriptor, Evidence, Route } from "./types.js";
type Input = ExactQuoteInput<Descriptor, Route>;
function validate(i: Input) {
  assertRoute(i.descriptor, i.route); sourceEqual(i.source, i.source); checked(i.amountIn, LIMIT112);
  if ([i.descriptor.pool, i.descriptor.stock, i.descriptor.money].includes(lower(i.executor))) throw new Error("oneswap unsupported executor");
}
function quote(i: Input, amounts: ReturnType<typeof quoteAmount>) {
  return { amountOut: amounts.amountOut, evidence: { ...amounts, kind: "oneswap-orderbook-math" as const,
    source: { ...i.source }, executor: lower(i.executor), routeKey: i.route.routeKey, binding: i.route.bindingRef.fingerprint, amountIn: i.amountIn } };
}
const zero = (i: Input) => { validate(i); return quote(i, { amountOut: 0n, amountIntoPool: 0n, bookOutput: 0n, fee: 0n }); };
export const program: ExactRequestProgram<Descriptor, Route, Evidence> = {
  requirements: () => ({ transports: ["eth-call", "get-code"] }),
  buildRequests(i) { validate(i); return i.amountIn ? stateRequests(i.descriptor) : []; },
  decode({ programInput: i, initialResults, dependentEvidence }) {
    validate(i);
    if (dependentEvidence.length) throw new Error("oneswap unexpected exact rounds");
    if (!i.amountIn) { if (initialResults.length) throw new Error("oneswap unexpected zero reads"); return zero(i); }
    const s = decodeState(i.descriptor, initialResults, i.source);
    // Maker payments to the executor would change the net input/output flow.
    if ((i.route.buy ? s.sells : s.buys).some(o => lower(o.maker) === lower(i.executor))) throw new Error("oneswap executor is a maker");
    return quote(i, quoteAmount(i.descriptor, s, i.route.buy, i.amountIn));
  },
};
export const exact = {
  methods: () => [localZeroExactMethod<Descriptor, Route, Evidence>("local-zero", zero),
    { id: "oneswap-orderbook-math", kind: "request-program", program,
      trialState: { unsupportedReason: "Maker payments and orderbook/native mutations require actual sequential runtime simulation; no local prefix approximation." } }],
  cacheCompatibilityProjection: ({ route, executor }) => ({ binding: route.bindingRef.fingerprint, routeKey: route.routeKey, executor: lower(executor) }),
} satisfies ExactQuoteSemantics<Descriptor, Route, Evidence>;
