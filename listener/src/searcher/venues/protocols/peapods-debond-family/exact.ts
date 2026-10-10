import { localZeroExactMethod, type ExactQuoteInput, type ExactQuoteResult, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { storageState, tokenBalanceState, tokenSupplyState } from "../../local-state-models/resources.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { hashCanonical } from "../../canonical-value.js";
import { assertSource, sourceValid, uint } from "./codec.js";
import { binding } from "./instance.js";
import { debond } from "./math.js";
import { assertRoute } from "./routes.js";
import { decodeState, requirements, stateRequests } from "./state.js";
import type { Descriptor, Evidence, Route, State } from "./types.js";
type Input = ExactQuoteInput<Descriptor, Route>;
function check(i: Input): string {
  assertRoute(i.descriptor, i.route); uint(i.amountIn); sourceValid(i.source);
  if (i.prefix?.length && !i.trialState) throw new Error("peapods prefix requires issued trial state");
  return runtimeExecutor(i.executor, i.descriptor.pod, i.descriptor.asset, i.descriptor.staking).toLowerCase();
}
function evidence(i: Input, amountOut: bigint): Evidence { return { kind: "peapods-weighted-local", source: i.source,
  fingerprint: i.route.bindingRef.fingerprint, routeKey: i.route.routeKey, executor: check(i), amountIn: i.amountIn, amountOut }; }
export const trialRef = (i: Input) => ({ key: `evm:${i.descriptor.pod}:peapods-debond`, schema: "peapods-weighted-v1",
  binding: hashCanonical(binding(i.descriptor)), dependencies: [storageState(i.descriptor.pod), storageState(i.descriptor.asset),
    tokenSupplyState(i.descriptor.pod), tokenBalanceState(i.descriptor.asset, i.descriptor.pod)] });
export function quoteTrial(i: Input, initial?: State): ExactQuoteResult<Evidence> | undefined {
  const actor = check(i);
  if (!i.amountIn) return { amountOut: 0n, evidence: evidence(i, 0n) };
  const ref = trialRef(i), s = (i.trialState?.get(ref) as State | undefined) ?? initial;
  if (!s) return undefined;
  assertSource(s.source, i.source);
  const q = debond(s, i.amountIn);
  if (!q.amountOut) throw new Error("peapods zero output");
  return { amountOut: q.amountOut, evidence: evidence(i, q.amountOut), ...(i.trialState ? {
    stateChanges: [{ ref, value: q.state }], stateEffects: [storageState(i.descriptor.pod), tokenSupplyState(i.descriptor.pod),
      tokenBalanceState(i.descriptor.asset, i.descriptor.pod), tokenBalanceState(i.descriptor.asset, actor),
      tokenBalanceState(i.descriptor.pod, actor), tokenBalanceState(i.descriptor.pod, i.descriptor.pod)],
  } : {}) };
}
export const program: ExactRequestProgram<Descriptor, Route, Evidence> = {
  requirements: i => { check(i); return i.amountIn ? requirements : { transports: [] }; },
  buildRequests: i => { check(i); return i.amountIn ? stateRequests(i.descriptor) : []; },
  decode({ programInput: i, initialResults, dependentEvidence }) {
    check(i); if (dependentEvidence.length) throw new Error("peapods unexpected dependent round");
    if (!i.amountIn) { if (initialResults.length) throw new Error("peapods unexpected zero reads"); return quoteTrial(i)!; }
    return quoteTrial(i, decodeState(i.descriptor, initialResults, i.source))!;
  },
};
export const exact = {
  methods: () => [localZeroExactMethod<Descriptor, Route, Evidence>("zero", i => quoteTrial(i)!),
    { id: "weighted-source-amount", kind: "request-program", program,
      trialState: { quote(i: Input) { const result = quoteTrial(i); return result ? { status: "quoted" as const, result }
        : { status: "not-applicable" as const, reason: "peapods trial state not loaded" }; } } }],
  cacheCompatibilityProjection: i => ({ binding: i.route.bindingRef.fingerprint, route: i.route.routeKey, executor: check(i) }),
} satisfies ExactQuoteSemantics<Descriptor, Route, Evidence>;
