import { localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { checked, decodeCanonical, lower, POOL, resultsSource, returned, sourceEqual } from "./codec.js";
import { assertRoute } from "./routes.js";
import { decodeState, STATE_IDS, stateRequests } from "./state.js";
import type { Descriptor, Evidence, Route } from "./types.js";
type Input = ExactQuoteInput<Descriptor, Route>;
function validate(i: Input) {
  assertRoute(i.descriptor, i.route); sourceEqual(i.source, i.source); checked(i.amountIn);
  if ([i.descriptor.pool, i.route.tokenIn, i.route.tokenOut, "0x0000000000000000000000000000000000000000"].includes(lower(i.executor)))
    throw new Error("precision-pool unsupported executor");
}
function quote(i: Input, amountOut: bigint) {
  return { amountOut, evidence: { kind: "precision-pool-chain-quote" as const, source: { ...i.source }, executor: lower(i.executor),
    routeKey: i.route.routeKey, binding: i.route.bindingRef.fingerprint, amountIn: i.amountIn, amountOut } };
}
const zero = (i: Input) => { validate(i); return quote(i, 0n); };
export const program: ExactRequestProgram<Descriptor, Route, Evidence> = {
  requirements: i => i.amountIn === 0n ? { transports: [] } : { transports: ["eth-call", "get-code"], caller: "executor" },
  buildRequests(i) {
    validate(i); if (!i.amountIn) return [];
    return [...stateRequests(i.descriptor), {
      id: "quote", kind: "eth-call", to: i.descriptor.pool, completion: "return-data", caller: { kind: "executor" },
      data: POOL.encodeFunctionData("quoteExactIn",
        [lower(i.executor), i.route.zeroForOne ? i.descriptor.token0 : i.descriptor.token1, i.amountIn]),
    }];
  },
  decode({ programInput: i, initialResults, dependentEvidence }) {
    validate(i);
    if (dependentEvidence.length) throw new Error("precision-pool unexpected exact rounds");
    if (!i.amountIn) { if (initialResults.length) throw new Error("precision-pool unexpected zero reads"); return zero(i); }
    resultsSource(initialResults, [...STATE_IDS, "quote"], i.source);
    const s = decodeState(i.descriptor, initialResults.filter(r => r.id !== "quote"), i.source);
    const [amountOut, fits] = decodeCanonical(POOL, "quoteExactIn", returned(initialResults, "quote"));
    const reserveOut = i.route.zeroForOne ? s.reserve1 : s.reserve0;
    if (!s.supply || !fits || amountOut <= 0n || amountOut > reserveOut) throw new Error("precision-pool quote does not fit or exceeds inventory");
    return quote(i, amountOut);
  },
};
export const exact = {
  methods: () => [localZeroExactMethod<Descriptor, Route, Evidence>("local-zero", zero),
    // fits may be false at both small and large sizes. No monotonicity claim,
    // local V2 approximation, partial-fill fallback or private search loop.
    { id: "precision-pool-quote-exact-in", kind: "request-program", chainAmountQuote: true, program }],
  cacheCompatibilityProjection: ({ route, executor }) => ({ binding: route.bindingRef.fingerprint, routeKey: route.routeKey, executor: lower(executor) }),
} satisfies ExactQuoteSemantics<Descriptor, Route, Evidence>;
