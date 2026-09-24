import { localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { ROUTER, MAX_INPUT, assertSource, call, lower, nonzero, queryData, returned, uint } from "./codec.js";
import { assertRoute } from "./routes.js";
import type { BalancerV3Descriptor, BalancerV3ExactEvidence, BalancerV3Route } from "./types.js";
import { decodeLocalState, localStateRequests, quoteLocal } from "./local-state.js";

type Input = ExactQuoteInput<BalancerV3Descriptor, BalancerV3Route>;
function validate(input: Input): void {
  assertRoute(input.descriptor, input.route);
  nonzero(input.executor); assertSource(input.source, input.source);
  if (input.amountIn < 0n || input.amountIn > MAX_INPUT) throw new Error("balancer-v3 invalid Permit2 uint160 input amount");
}
function quote(input: Input, amountOut: bigint, kind: BalancerV3ExactEvidence["kind"] = "balancer-v3-router-exact-in") {
  return { amountOut, evidence: { kind, source: { ...input.source },
    binding: input.route.bindingRef.fingerprint, routeKey: input.route.routeKey, executor: lower(input.executor),
    amountIn: input.amountIn, amountOut } };
}
const program: ExactRequestProgram<BalancerV3Descriptor, BalancerV3Route, BalancerV3ExactEvidence> = {
  requirements: () => ({ transports: ["eth-call"] }),
  buildRequests(input) {
    validate(input);
    return input.amountIn === 0n ? [] : [call("exact-in", ROUTER,
      queryData(input.route.pool, input.route.tokenIn, input.route.tokenOut, input.amountIn, input.executor))];
  },
  decode({ programInput, initialResults }) {
    validate(programInput);
    if (programInput.amountIn === 0n) {
      if (initialResults.length !== 0) throw new Error("balancer-v3 unexpected zero quote results");
      return quote(programInput, 0n);
    }
    if (initialResults.length !== 1) throw new Error("balancer-v3 invalid exact result count");
    const read = returned(initialResults, "exact-in");
    assertSource(read.source, programInput.source);
    const amountOut = uint(read.data);
    if (amountOut <= 0n) throw new Error("balancer-v3 no positive exact output");
    return quote(programInput, amountOut);
  },
};
const localProgram: ExactRequestProgram<BalancerV3Descriptor, BalancerV3Route, BalancerV3ExactEvidence> = {
  requirements: () => ({ transports: ["eth-call"] }),
  buildRequests(input) {
    validate(input);
    return input.amountIn === 0n ? [] : localStateRequests(input.descriptor);
  },
  decode({ programInput: input, initialResults, dependentEvidence }) {
    validate(input);
    if (dependentEvidence.length !== 0) throw new Error("balancer-v3 unexpected local exact round");
    if (input.amountIn === 0n) {
      if (initialResults.length !== 0) throw new Error("balancer-v3 unexpected zero quote results");
      return quote(input, 0n, "balancer-v3-local-exact-in");
    }
    const state = decodeLocalState(input.descriptor, initialResults);
    return quote(input, quoteLocal(input.descriptor, input.route, state, input.amountIn, input.source),
      "balancer-v3-local-exact-in");
  },
};
export const balancerV3Exact = {
  methods: (input) => [localZeroExactMethod<BalancerV3Descriptor, BalancerV3Route, BalancerV3ExactEvidence>("local-zero", input => {
    validate(input); return quote(input, 0n);
  }), ...(input.descriptor.binding.localModel ? [{ id: "balancer-v3-local-exact-in", kind: "request-program" as const,
    // These amount-independent reads can depend on block time. Reuse is the
    // existing same-source byte memo, not a stateOnlyReads cross-source promise.
    program: localProgram }] : [{ id: "balancer-v3-router-exact-in", kind: "request-program" as const,
    chainAmountQuote: true as const, program }])],
  cacheCompatibilityProjection: ({ route, executor }) => ({ pool: route.pool, binding: route.bindingRef.fingerprint,
    routeKey: route.routeKey, executor: lower(executor) }),
} satisfies ExactQuoteSemantics<BalancerV3Descriptor, BalancerV3Route, BalancerV3ExactEvidence>;
