import { localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram,
  type ExactTrialStateRef } from "../../adapter-family-plugin.js";
import { hashCanonical } from "../../canonical-value.js";
import { storageState, tokenBalanceState } from "../../local-state-models/resources.js";
import { ROUTER, MAX_INPUT, assertSource, call, lower, nonzero, queryData, returned, uint } from "./codec.js";
import { assertRoute } from "./routes.js";
import { staticBinding } from "./instance.js";
import type { BalancerV3Descriptor, BalancerV3ExactEvidence, BalancerV3Route } from "./types.js";
import { decodeLocalState, localStateRequests, quoteLocal, quoteLocalTransition, supportsLocalPricing, type BalancerLocalState } from "./local-state.js";

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
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
function supportsTrialState(descriptor: BalancerV3Descriptor): boolean {
  const binding = descriptor.binding;
  // An arbitrary rate provider can read another protocol internally. Its
  // address alone does not prove the transitive dependencies needed to carry
  // that rate across swaps. Keep those pools' existing single-hop local quote.
  return Boolean(binding.localModel) && lower(binding.hooks.address) === ZERO_ADDRESS &&
    binding.hooks.flags.every(flag => !flag) && binding.tokenInfo.every(info =>
      info.tokenType === 0 && lower(info.rateProvider) === ZERO_ADDRESS && !info.paysYieldFees);
}
function poolResource(descriptor: BalancerV3Descriptor): string {
  return `vault-pool:${lower(descriptor.binding.vault)}:${lower(descriptor.pool)}`;
}
function trialRef(input: Input): ExactTrialStateRef {
  return { key: `pool:${lower(input.descriptor.pool)}`, schema: "balancer-v3-pool-data-v1",
    binding: hashCanonical(staticBinding(input.descriptor)),
    // Pool parameters and Vault configuration are read dependencies; ordinary
    // swaps mutate the pool-specific Vault accounting, not the global config.
    dependencies: [poolResource(input.descriptor), storageState(input.descriptor.pool),
      storageState(input.descriptor.binding.vault)] };
}
function trialState(input: Input): BalancerLocalState | undefined {
  const value = input.trialState?.get(trialRef(input));
  if (value === undefined) return undefined;
  const state = value as BalancerLocalState;
  if (!state || state.model !== input.descriptor.binding.localModel || !Array.isArray(state.balancesRaw) ||
      !Array.isArray(state.balances) || state.balancesRaw.length !== input.descriptor.binding.tokens.length ||
      state.balances.length !== state.balancesRaw.length ||
      state.balancesRaw.some(value => typeof value !== "bigint" || value < 0n) ||
      state.balances.some(value => typeof value !== "bigint" || value < 0n)) {
    throw new Error("balancer-v3 invalid trial state");
  }
  assertSource(state.source, input.source);
  return state;
}
function localQuote(input: Input, state: BalancerLocalState) {
  if (!input.trialState || !supportsTrialState(input.descriptor)) {
    return quote(input, quoteLocal(input.descriptor, input.route, state, input.amountIn, input.source), "balancer-v3-local-exact-in");
  }
  const next = quoteLocalTransition(input.descriptor, input.route, state, input.amountIn, input.source);
  const vault = input.descriptor.binding.vault;
  return { ...quote(input, next.amountOut, "balancer-v3-local-exact-in"),
    stateChanges: [{ ref: trialRef(input), value: next.nextState }],
    stateEffects: [poolResource(input.descriptor), tokenBalanceState(input.route.tokenIn, vault),
      tokenBalanceState(input.route.tokenOut, vault), tokenBalanceState(input.route.tokenIn, input.executor),
      tokenBalanceState(input.route.tokenOut, input.executor)] };
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
    const current = supportsTrialState(input.descriptor) ? trialState(input) : undefined;
    return localQuote(input, current ?? state);
  },
};
export const balancerV3Exact = {
  methods: (input) => [localZeroExactMethod<BalancerV3Descriptor, BalancerV3Route, BalancerV3ExactEvidence>("local-zero", input => {
    validate(input); return quote(input, 0n);
  }), ...(supportsLocalPricing(input.descriptor) ? [{ id: "balancer-v3-local-exact-in", kind: "request-program" as const,
    // These amount-independent reads can depend on block time. Reuse is the
    // existing same-source byte memo, not a stateOnlyReads cross-source promise.
    ...(supportsTrialState(input.descriptor) ? { trialState: {
      quote(current: Input) {
        validate(current);
        if (!supportsTrialState(current.descriptor)) throw new Error("balancer-v3 trial state unsupported");
        const state = trialState(current);
        return state === undefined ? { status: "not-applicable" as const, reason: "balancer-v3 trial state not loaded" }
          : { status: "quoted" as const, result: localQuote(current, state) };
      },
    } } : { trialState: {
      unsupportedReason: "balancer-v3 hook, rate-provider or yield-fee transition dependencies are unproven",
    } }), program: localProgram }] : [{ id: "balancer-v3-router-exact-in", kind: "request-program" as const,
    chainAmountQuote: true as const, program }])],
  cacheCompatibilityProjection: ({ route, executor }) => ({ pool: route.pool, binding: route.bindingRef.fingerprint,
    routeKey: route.routeKey, executor: lower(executor) }),
} satisfies ExactQuoteSemantics<BalancerV3Descriptor, BalancerV3Route, BalancerV3ExactEvidence>;
