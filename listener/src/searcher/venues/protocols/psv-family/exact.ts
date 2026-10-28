import { localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { ABI, call, decode, rows, uint } from "./codec.js";
import { assertRoute } from "./routes.js";
import { assertCapacity, decodeState, requirements, stateRequests } from "./state.js";
import type { Descriptor, Evidence, Route } from "./types.js";
type Input = ExactQuoteInput<Descriptor, Route>;
function check(i: Input): string {
  assertRoute(i.descriptor, i.route); uint(i.amountIn);
  if (i.prefix?.length || i.runtimeEvidence.length) throw new Error("PSV sequential/pending quoted preview unsupported; use runtime sim");
  return runtimeExecutor(i.executor, i.descriptor.target, i.descriptor.implementation, i.descriptor.gem, i.descriptor.stable).toLowerCase();
}
const preview = (i: Input) => i.route.direction === "sell-gem" ? "previewSellGem" : "previewBuyGem";
export const requests = (i: Input) => { const actor = check(i); return i.amountIn ? [...stateRequests(i.descriptor),
  call("amount-preview", i.descriptor.target, ABI.encodeFunctionData(preview(i), [i.amountIn, actor]))] : []; };
const evidence = (i: Input, amountOut: bigint): Evidence => ({ kind: "psv-recipient-preview", source: i.source,
  fingerprint: i.route.bindingRef.fingerprint, routeKey: i.route.routeKey, executor: check(i), amountIn: i.amountIn, amountOut });
export const program: ExactRequestProgram<Descriptor, Route, Evidence> = {
  requirements: i => { check(i); return i.amountIn ? requirements : { transports: [] }; }, buildRequests: requests,
  decode({ programInput: i, initialResults, dependentEvidence }) {
    check(i); if (dependentEvidence.length) throw new Error("PSV unexpected dependent round");
    if (!i.amountIn) { if (initialResults.length) throw new Error("PSV unexpected zero reads"); return { amountOut: 0n, evidence: evidence(i, 0n) }; }
    const r = rows(initialResults, requests(i), i.source), guardIds = new Set(stateRequests(i.descriptor).map(v => v.id));
    const s = decodeState(i.descriptor, initialResults.filter(v => guardIds.has(v.id)), i.source);
    if (s.treasury === check(i)) throw new Error("PSV fee receiver executor unsupported");
    const q = decode(preview(i), r.get("amount-preview")); assertCapacity(i.descriptor, s, i.route.direction, i.amountIn, q[0], q[1]);
    return { amountOut: q[0] as bigint, evidence: evidence(i, q[0]) };
  },
};
export const exact = {
  methods: () => [localZeroExactMethod<Descriptor, Route, Evidence>("zero", i => { check(i); return { amountOut: 0n, evidence: evidence(i, 0n) }; }),
    { id: "recipient-amount-preview", kind: "request-program", chainAmountQuote: true, program }],
  cacheCompatibilityProjection: i => ({ binding: i.route.bindingRef.fingerprint, route: i.route.routeKey, executor: check(i) }),
} satisfies ExactQuoteSemantics<Descriptor, Route, Evidence>;
