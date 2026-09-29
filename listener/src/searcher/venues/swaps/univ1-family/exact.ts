import { localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram, type ExactTrialStateRef } from "../../adapter-family-plugin.js";
import { hashCanonical } from "../../canonical-value.js";
import { nativeBalanceState, storageState, tokenBalanceState, tokenSupplyState } from "../../local-state-models/resources.js";
import { checked, lower, sourceEqual, WETH } from "./codec.js";
import { staticBinding } from "./instance.js";
import { assertRoute } from "./routes.js";
import { decodeState, quoteAmount, quoteTransition, stateRequests } from "./state.js";
import type { Descriptor, Evidence, Route, State } from "./types.js";
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
function trialRef(d: Descriptor): ExactTrialStateRef {
  return { key: `pool:${lower(d.pool)}`, schema: "anyswap-v1-reserves:v1", binding: hashCanonical(staticBinding(d)),
    dependencies: [storageState(d.pool), nativeBalanceState(d.pool), tokenBalanceState(d.token, d.pool)] };
}
function trialState(i: Input): State | undefined {
  const value = i.trialState?.get(trialRef(i.descriptor));
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || !("source" in value) ||
      !("nativeReserve" in value) || typeof value.nativeReserve !== "bigint" ||
      !("tokenReserve" in value) || typeof value.tokenReserve !== "bigint") throw new Error("univ1 malformed trial state");
  const state = value as State;
  sourceEqual(state.source, i.source);
  return state;
}
function quoteState(i: Input, state: State) {
  if (!i.trialState || i.amountIn === 0n) return quoted(i, quoteAmount(state, i.route.buy, i.amountIn));
  const { amountOut, state: next } = quoteTransition(state, i.route.buy, i.amountIn);
  const d = i.descriptor;
  return { ...quoted(i, amountOut), stateChanges: [{ ref: trialRef(d), value: next }],
    // A fee payment can touch another model's inventory. Publishing only this
    // exchange's reserves would incorrectly make that other model independent.
    // Wrapping/unwrapping also changes WETH backing and executor balances.
    stateEffects: [storageState(d.pool), nativeBalanceState(d.pool), tokenBalanceState(d.token, d.pool),
      i.route.buy ? nativeBalanceState(d.issuer) : tokenBalanceState(d.token, d.issuer),
      nativeBalanceState(i.executor), tokenBalanceState(d.token, i.executor), tokenBalanceState(WETH, i.executor),
      nativeBalanceState(WETH), tokenSupplyState(WETH)] };
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
    const baseline = decodeState(initialResults, i.source);
    return quoteState(i, trialState(i) ?? baseline);
  },
};
export const exact = {
  methods: () => [localZeroExactMethod<Descriptor, Route, Evidence>("local-zero", i => { validate(i); return quoted(i, 0n); }),
    { id: "univ1-execution-math", kind: "request-program", program, trialState: { quote(i) {
      validate(i);
      const state = trialState(i);
      return state === undefined ? { status: "not-applicable", reason: "univ1 trial state not loaded" }
        : { status: "quoted", result: quoteState(i, state) };
    } } }],
  cacheCompatibilityProjection: ({ route, executor }) => ({ binding: route.bindingRef.fingerprint, routeKey: route.routeKey, executor: lower(executor) }),
} satisfies ExactQuoteSemantics<Descriptor, Route, Evidence>;
