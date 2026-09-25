import { localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { POOL, assertRoute, assertSource, assertUint, call, lower, nonzero, resultSet, returned, uint } from "./codec.js";
import { balanceRequest, bindingRequests, currentGovernance, decodeActive, governanceRound } from "./state.js";
import type { MooniswapDescriptor, MooniswapQuoteEvidence, MooniswapRoute } from "./types.js";

type Input = ExactQuoteInput<MooniswapDescriptor, MooniswapRoute>;
function validate(i: Input) {
  assertRoute(i.descriptor, i.route); assertSource(i.source, i.source); assertUint(i.amountIn);
  if (nonzero(i.executor) === lower(i.descriptor.pool)) throw new Error("mooniswap executor equals pool");
}
function quote(i: Input, amountOut: bigint, governance?: string) {
  return { amountOut, evidence: { kind: "mooniswap-get-return" as const, source: { ...i.source },
    routeKey: i.route.routeKey, binding: i.route.bindingRef.fingerprint, executor: lower(i.executor), amountIn: i.amountIn, amountOut,
    ...(governance === undefined ? {} : { governance }) } };
}
const IDS = ["quote", "output-balance", "input-balance", "governance", "token0", "token1"];

// getReturn evaluates virtual balances and voted fee/slippage/decay at the
// source block's timestamp. Never replace this with real-reserve V2 arithmetic.
// A positive view result is not a proof of arbitrary-caller execution or net
// token receipt: those remain identity/execution acceptance and final-sim gates.
export const mooniswapQuoteProgram: ExactRequestProgram<MooniswapDescriptor, MooniswapRoute, MooniswapQuoteEvidence> = {
  requirements: () => ({ transports: ["eth-call"], caller: "executor" }),
  buildRequests(i) {
    validate(i); if (i.amountIn === 0n) return [];
    const d = i.descriptor;
    return [call("quote", d.pool, POOL.encodeFunctionData("getReturn", [i.route.tokenIn, i.route.tokenOut, i.amountIn])),
      balanceRequest("output-balance", i.route.tokenOut, d.pool), balanceRequest("input-balance", i.route.tokenIn, d.pool), ...bindingRequests(d)];
  },
  buildDependentProgram({ programInput: i, completedRound, initialResults }) {
    validate(i);
    if (i.amountIn === 0n || completedRound !== 0) return null;
    resultSet(initialResults, IDS, i.source);
    return governanceRound(i.descriptor, initialResults, i.source);
  },
  decode({ programInput: i, initialResults: results, dependentEvidence }) {
    validate(i);
    if (i.amountIn === 0n) {
      if (results.length || dependentEvidence.length) throw new Error("mooniswap unexpected zero quote evidence");
      return quote(i, 0n);
    }
    resultSet(results, IDS, i.source);
    const data = (id: string) => returned(results, id, i.source).data;
    const governance = currentGovernance(i.descriptor, results, i.source);
    if (!decodeActive(dependentEvidence, i.source)) throw new Error("mooniswap inactive governance");
    const amountOut = uint(data("quote")), balanceOut = uint(data("output-balance"));
    if (uint(data("input-balance")) === 0n || amountOut <= 0n || amountOut > balanceOut) throw new Error("mooniswap output unavailable or exceeds inventory");
    return quote(i, amountOut, governance);
  },
};
export const mooniswapExact = {
  methods: () => [localZeroExactMethod<MooniswapDescriptor, MooniswapRoute, MooniswapQuoteEvidence>("local-zero", i => { validate(i); return quote(i, 0n); }),
    // Neither stateOnlyReads nor a block-environment-independent reusePolicy
    // applies. Source-bound central request handling owns every positive quote.
    { id: "mooniswap-get-return", kind: "request-program", chainAmountQuote: true, program: mooniswapQuoteProgram }],
  cacheCompatibilityProjection: i => ({ binding: i.route.bindingRef.fingerprint, routeKey: i.route.routeKey, executor: lower(i.executor) }),
} satisfies ExactQuoteSemantics<MooniswapDescriptor, MooniswapRoute, MooniswapQuoteEvidence>;
