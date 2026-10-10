import { localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { ABI, call, decode, rows, uint } from "./codec.js";
import { assertRoute } from "./routes.js";
import { decodeState, requirements, stateRequests } from "./state.js";
import { mintQuote } from "./model.js";
import type { Descriptor, Evidence, Route } from "./types.js";
type Input = ExactQuoteInput<Descriptor, Route>;
function check(i: Input) { assertRoute(i.descriptor, i.route); uint(i.amountIn);
  if (i.prefix?.length || i.runtimeEvidence.length) throw new Error("curve-lp prefix state requires shared execution; use runtime sim");
  return runtimeExecutor(i.executor, i.descriptor.pool, i.descriptor.lp, ...i.descriptor.coins).toLowerCase(); }
export function requests(i: Input) { check(i); return i.amountIn ? [...stateRequests(i.descriptor), ...(i.route.direction === "redeem"
  ? [call("exact-withdraw", i.descriptor.pool, ABI.encodeFunctionData("calc_withdraw_one_coin", [i.amountIn, i.route.index]))] : [])] : []; }
function output(i: Input, amountOut: bigint) { return { amountOut, evidence: { kind: "curve-lp-exact" as const, source: i.source,
  binding: i.route.bindingRef.fingerprint, routeKey: i.route.routeKey, executor: check(i), amountIn: i.amountIn, amountOut } }; }
export const program: ExactRequestProgram<Descriptor, Route, Evidence> = {
  requirements: i => { check(i); return i.amountIn ? requirements : { transports: [] }; }, buildRequests: requests,
  decode({ programInput: i, initialResults, dependentEvidence }) { check(i);
    if (dependentEvidence.length) throw new Error("curve-lp unexpected dependent round");
    if (!i.amountIn) { if (initialResults.length) throw new Error("curve-lp zero-input reads"); return output(i, 0n); }
    const r = rows(initialResults, requests(i), i.source), s = decodeState(i.descriptor, initialResults.filter(v => v.id !== "exact-withdraw"), i.source);
    if (s.killed || !s.totalSupply || s.balances.some(b => b <= 0n)) throw new Error("curve-lp no active liquidity");
    const amountOut = i.route.direction === "mint" ? mintQuote(s, i.route.index, i.amountIn) : uint(decode("calc_withdraw_one_coin", r.get("exact-withdraw"))[0]);
    if (!amountOut || (i.route.direction === "redeem" && (i.amountIn >= s.totalSupply || amountOut > s.balances[i.route.index]))) throw new Error("curve-lp no positive capacity");
    return output(i, amountOut);
  },
};
export const exact = { methods: ({ route }) => [localZeroExactMethod<Descriptor, Route, Evidence>("zero", i => output(i, 0n)),
  route.direction === "redeem"
    ? { id: "chain-withdraw", kind: "request-program", chainAmountQuote: true, program }
    : { id: "source-fee-aware-mint", kind: "request-program",
      trialState: { unsupportedReason: "LP supply and pool balances require shared prefix execution" }, program }],
  cacheCompatibilityProjection: i => ({ binding: i.route.bindingRef.fingerprint, route: i.route.routeKey, executor: check(i) }),
} satisfies ExactQuoteSemantics<Descriptor, Route, Evidence>;
