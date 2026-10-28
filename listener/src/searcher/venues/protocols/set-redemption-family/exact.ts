import { localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { address, call, decode, rows, uint } from "./codec.js";
import { assertRoute } from "./routes.js";
import { decodeState, redemptionOutputs, issuanceOutput, stateRequests } from "./state.js";
import { VAULT } from "./legacy.js";
import type { Descriptor, Evidence, Route } from "./types.js";
type Input = ExactQuoteInput<Descriptor, Route>;
function check(i: Input) { assertRoute(i.descriptor, i.route); uint(i.amountIn); const a = address(i.executor);
  if ([i.descriptor.set, i.descriptor.module, i.descriptor.controller, ...i.descriptor.components,
    ...(i.descriptor.legacy ? [i.descriptor.legacy.factory, i.descriptor.legacy.vault,
      ...(i.descriptor.legacy.issuance ? [i.descriptor.legacy.issuance.transferProxy] : [])] : [])].includes(a)) throw new Error("set-redemption executor aliases dependency");
  if (i.prefix?.length) throw new Error("set-redemption local baseline cannot consume a prefix; shared EVM prefix required"); }
function result(i: Input, outputs: readonly bigint[]) {
  return { amountOut: outputs[i.descriptor.components.indexOf(i.route.component)], evidence: { kind: "set-redemption-local-quote" as const,
    source: i.source, binding: i.route.bindingRef.fingerprint, routeKey: i.route.routeKey, executor: address(i.executor), amountIn: i.amountIn, outputs } };
}
export const exactRequests = (i: Input) => [...stateRequests(i.descriptor), ...(i.route.issue ? [call("issuer-credit", i.descriptor.legacy!.vault,
  VAULT.encodeFunctionData("getOwnerBalance", [i.route.component, address(i.executor)]))] : [])];
export const program: ExactRequestProgram<Descriptor, Route, Evidence> = {
  requirements: i => { check(i); return { transports: i.amountIn ? ["get-code", "eth-call"] : [] }; },
  buildRequests: i => { check(i); return i.amountIn ? exactRequests(i) : []; },
  decode({ programInput: i, initialResults, dependentEvidence }) {
    check(i); if (dependentEvidence.length) throw new Error("set-redemption unexpected exact rounds");
    if (!i.amountIn) { if (initialResults.length) throw new Error("set-redemption unexpected zero reads"); return result(i, i.descriptor.components.map(() => 0n)); }
    const r = rows(initialResults, exactRequests(i).map(q => q.id), i.source);
    if (i.route.issue && decode(VAULT, "getOwnerBalance", r.get("issuer-credit"))[0] !== 0n) throw new Error("set-legacy issuance cannot consume existing Vault credit");
    const s = decodeState(i.descriptor, initialResults.filter(q => q.id !== "issuer-credit"), i.source);
    const outputs = i.route.issue ? [issuanceOutput(s, i.amountIn, address(i.executor))] : redemptionOutputs(s, i.amountIn), q = result(i, outputs);
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
