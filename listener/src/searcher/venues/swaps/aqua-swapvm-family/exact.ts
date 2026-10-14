import { localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { stateRequests, decodeState, quoteRequest, quoteOutput, amount, address } from "./codec.js";
import { assertRoute } from "./routes.js";
import type { Descriptor, Route, Evidence } from "./types.js";
type Input = ExactQuoteInput<Descriptor, Route>;
const origin = (i: { transactionOrigin?: string }) => i.transactionOrigin === undefined ? null : address(i.transactionOrigin);
function check(i: Input) { assertRoute(i.descriptor, i.route); amount(i.amountIn, true); runtimeExecutor(i.executor, i.descriptor.router, i.descriptor.aqua, i.descriptor.order.maker, ...i.descriptor.tokens); origin(i); }
function result(i: Input, out: bigint) { return { amountOut: out, evidence: { kind: "aqua-swapvm-quote" as const, source: i.source,
  executor: address(i.executor), transactionOrigin: origin(i), binding: i.route.bindingRef.fingerprint, routeKey: i.route.routeKey,
  amountIn: i.amountIn, amountOut: out } }; }
export const exactProgram: ExactRequestProgram<Descriptor, Route, Evidence> = {
  requirements: () => ({ transports: ["get-code", "eth-call"], caller: "executor" }),
  buildRequests(i) { check(i); return i.amountIn === 0n ? [] : [...stateRequests(i.descriptor), quoteRequest(i.descriptor, i.route.i, i.amountIn)]; },
  decode({ programInput: i, initialResults, dependentEvidence }) {
    check(i); if (dependentEvidence.length) throw new Error("aqua unexpected Exact round");
    if (i.amountIn === 0n) { if (initialResults.length) throw new Error("aqua zero quote reads"); return result(i, 0n); }
    const s = decodeState(i.descriptor, initialResults, i.source);
    if (!s.active) throw new Error("aqua strategy inactive");
    return result(i, quoteOutput(i.descriptor, initialResults, i.amountIn, s.capacities[i.route.j]));
  },
};
export const exact = {
  methods: () => [localZeroExactMethod<Descriptor, Route, Evidence>("zero", i => { check(i); return result(i, 0n); }),
    { id: "aqua-v1-chain-quote", kind: "request-program", chainAmountQuote: true, program: exactProgram }],
  cacheCompatibilityProjection: i => ({ binding: i.route.bindingRef.fingerprint, routeKey: i.route.routeKey, executor: address(i.executor), transactionOrigin: origin(i) }),
} satisfies ExactQuoteSemantics<Descriptor, Route, Evidence>;
