import { localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { address, uint } from "./codec.js";
import { assertRoute } from "./routes.js";
import { decodeState, redemptionOutputs, stateRequests } from "./state.js";
import type { Descriptor, Evidence, Route } from "./types.js";
type Input = ExactQuoteInput<Descriptor, Route>;
function check(i: Input) { assertRoute(i.descriptor, i.route); uint(i.amountIn); const a = address(i.executor);
  if ([i.descriptor.set, i.descriptor.module, i.descriptor.controller, ...i.descriptor.components,
    ...(i.descriptor.legacy ? [i.descriptor.legacy.factory, i.descriptor.legacy.vault] : [])].includes(a)) throw new Error("set-redemption executor aliases dependency");
  if (i.prefix?.length) throw new Error("set-redemption local baseline cannot consume a prefix; shared EVM prefix required"); }
function result(i: Input, outputs: readonly bigint[]) {
  return { amountOut: outputs[i.descriptor.components.indexOf(i.route.component)], evidence: { kind: "set-redemption-local-quote" as const,
    source: i.source, binding: i.route.bindingRef.fingerprint, routeKey: i.route.routeKey, executor: address(i.executor), amountIn: i.amountIn, outputs } };
}
export const program: ExactRequestProgram<Descriptor, Route, Evidence> = {
  requirements: i => { check(i); return { transports: i.amountIn ? ["get-code", "eth-call"] : [] }; },
  buildRequests: i => { check(i); return i.amountIn ? stateRequests(i.descriptor) : []; },
  decode({ programInput: i, initialResults, dependentEvidence }) {
    check(i); if (dependentEvidence.length) throw new Error("set-redemption unexpected exact rounds");
    if (!i.amountIn) { if (initialResults.length) throw new Error("set-redemption unexpected zero reads"); return result(i, i.descriptor.components.map(() => 0n)); }
    const outputs = redemptionOutputs(decodeState(i.descriptor, initialResults, i.source), i.amountIn), q = result(i, outputs);
    if (!q.amountOut) throw new Error("set-redemption selected component rounds to zero"); return q;
  },
};
export const exact = {
  methods: () => [localZeroExactMethod<Descriptor, Route, Evidence>("zero", i => { check(i); return result(i, i.descriptor.components.map(() => 0n)); }),
    { id: "source-unit-floor", kind: "request-program", program,
      // The shared runtime can materialize the real preceding EVM calls. Do
      // not claim arbitrary component transfer hooks have a local state model.
      trialState: { unsupportedReason: "Set and all component transfer effects require the shared EVM prefix for sequential quotes" } }],
  cacheCompatibilityProjection: i => ({ binding: i.route.bindingRef.fingerprint, executor: address(i.executor), routeKey: i.route.routeKey }),
} satisfies ExactQuoteSemantics<Descriptor, Route, Evidence>;
