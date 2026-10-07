import { localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactQuoteResult, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { storageState, tokenBalanceState, tokenSupplyState } from "../../local-state-models/resources.js";
import { hashCanonical } from "../../canonical-value.js";
import { binding } from "./instance.js";
import { dependencies } from "./pricing.js";
import { assertSource, sourceValid, uint } from "./codec.js";
import { assertRoute } from "./routes.js";
import { assertActor, decodeState, dependentRound, requirements, rootRequests, withdraw } from "./state.js";
import type { Descriptor, Evidence, Route, State } from "./types.js";
type Input = ExactQuoteInput<Descriptor, Route>;
export function check(i: Input): void {
  assertRoute(i.descriptor, i.route); uint(i.amountIn); sourceValid(i.source); assertActor(i.descriptor, i.executor);
  if (i.prefix?.length && !i.trialState) throw new Error("badger-sett prefix requires issued trial state");
}
function evidence(i: Input, amountOut: bigint): Evidence {
  return { kind: "badger-sett-liquid-local", source: i.source, fingerprint: i.route.bindingRef.fingerprint, routeKey: i.route.routeKey,
    executor: assertActor(i.descriptor, i.executor), amountIn: i.amountIn, amountOut };
}
export function trialRef(i: Input) {
  const d = i.descriptor;
  return { key: `evm:${d.vault}:badger-sett-liquid`, schema: "badger-sett-liquid-v1",
    binding: hashCanonical({ ...binding(d), executor: i.executor.toLowerCase() }),
    dependencies: [...dependencies(d).map(storageState), tokenSupplyState(d.vault),
      tokenBalanceState(d.asset, d.vault), tokenBalanceState(d.asset, d.strategy)] };
}
export function quoteTrial(i: Input, initial?: State): ExactQuoteResult<Evidence> | undefined {
  check(i);
  if (!i.amountIn) return { amountOut: 0n, evidence: evidence(i, 0n) };
  const ref = trialRef(i);
  // get() must run before considering fresh reads, so a dirty/incompatible
  // shared resource can never be overwritten by the source baseline.
  const state = (i.trialState?.get(ref) as State | undefined) ?? initial;
  if (!state) return undefined;
  assertSource(state.source, i.source);
  const q = withdraw(state, i.amountIn, i.executor);
  if (!q.amountOut) throw new Error("badger-sett output rounds to zero");
  return { amountOut: q.amountOut, evidence: evidence(i, q.amountOut), ...(i.trialState ? {
    stateChanges: [{ ref, value: q.state }],
    stateEffects: [storageState(i.descriptor.vault), tokenSupplyState(i.descriptor.vault),
      tokenBalanceState(i.descriptor.asset, i.descriptor.vault), tokenBalanceState(i.descriptor.asset, i.descriptor.strategy),
      tokenBalanceState(i.descriptor.vault, i.executor), tokenBalanceState(i.descriptor.asset, i.executor),
      ...(q.feeShares > 0n ? [tokenBalanceState(i.descriptor.vault, state.treasury)] : [])],
  } : {}) };
}
export const program: ExactRequestProgram<Descriptor, Route, Evidence> = {
  requirements: i => { check(i); return i.amountIn ? requirements : { transports: [] }; },
  buildRequests: i => { check(i); return i.amountIn ? rootRequests(i.descriptor.vault) : []; },
  buildDependentProgram: ({ programInput: i, completedRound, initialResults, priorEvidence }) => {
    check(i); return i.amountIn ? dependentRound(i.descriptor, initialResults, priorEvidence, completedRound, i.source) : null;
  },
  decode({ programInput: i, initialResults, dependentEvidence }) {
    check(i);
    if (!i.amountIn) {
      if (initialResults.length || dependentEvidence.length) throw new Error("badger-sett unexpected zero reads");
      return quoteTrial(i)!;
    }
    return quoteTrial(i, decodeState(i.descriptor, initialResults, dependentEvidence, i.source))!;
  },
};
export const exact = {
  methods: () => [localZeroExactMethod<Descriptor, Route, Evidence>("zero", i => quoteTrial(i)!),
    { id: "source-liquid-withdraw", kind: "request-program", program,
      // Local amount model, not an ABI amount quote; not eth-call-only reads.
      trialState: { quote(i: Input) { const result = quoteTrial(i); return result ? { status: "quoted" as const, result }
        : { status: "not-applicable" as const, reason: "badger-sett trial state not loaded" }; } } }],
  cacheCompatibilityProjection: i => ({ binding: i.route.bindingRef.fingerprint, route: i.route.routeKey, executor: i.executor.toLowerCase() }),
} satisfies ExactQuoteSemantics<Descriptor, Route, Evidence>;
