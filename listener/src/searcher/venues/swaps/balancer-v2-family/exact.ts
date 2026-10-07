import { localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { VAULT, MAX_INPUT, assertSource, call, lower, nonzero, queryData, quoteOutput, resultSet, returned } from "./codec.js";
import { assertRoute } from "./routes.js";
import type { BalancerV2Descriptor, BalancerV2ExactEvidence, BalancerV2Route } from "./types.js";
type Input = ExactQuoteInput<BalancerV2Descriptor, BalancerV2Route>;
function validate(i: Input) {
  assertRoute(i.descriptor, i.route); nonzero(i.executor); assertSource(i.source, i.source);
  if (i.amountIn < 0n || i.amountIn > MAX_INPUT) throw new Error("balancer-v2 invalid signed delta input");
}
function quote(i: Input, amountOut: bigint) {
  return { amountOut, evidence: { kind: "balancer-v2-vault-exact-in" as const, source: { ...i.source },
    binding: i.route.bindingRef.fingerprint, routeKey: i.route.routeKey, executor: lower(i.executor), amountIn: i.amountIn, amountOut } };
}
const program: ExactRequestProgram<BalancerV2Descriptor, BalancerV2Route, BalancerV2ExactEvidence> = {
  requirements: () => ({ transports: ["eth-call"], caller: "executor" }),
  buildRequests(i) {
    validate(i);
    return i.amountIn === 0n ? [] : [{ ...call("exact-in", VAULT,
      queryData(i.descriptor.poolId, i.route.tokenIn, i.route.tokenOut, i.amountIn, i.executor)), caller: { kind: "executor" } }];
  },
  decode({ programInput: i, initialResults, dependentEvidence }) {
    validate(i);
    if (dependentEvidence.length) throw new Error("balancer-v2 unexpected quote round");
    if (i.amountIn === 0n) {
      if (initialResults.length) throw new Error("balancer-v2 unexpected zero results");
      return quote(i, 0n);
    }
    resultSet(initialResults, ["exact-in"], i.source);
    return quote(i, quoteOutput(returned(initialResults, "exact-in").data, i.amountIn));
  },
};
export const exact = {
  methods: () => [localZeroExactMethod<BalancerV2Descriptor, BalancerV2Route, BalancerV2ExactEvidence>("local-zero", i => {
    validate(i); return quote(i, 0n);
  }), { id: "balancer-v2-vault-exact-in", kind: "request-program" as const, chainAmountQuote: true as const, program }],
  cacheCompatibilityProjection: ({ route, executor }) => ({ poolId: route.poolId, routeKey: route.routeKey,
    binding: route.bindingRef.fingerprint, executor: lower(executor) }),
} satisfies ExactQuoteSemantics<BalancerV2Descriptor, BalancerV2Route, BalancerV2ExactEvidence>;
