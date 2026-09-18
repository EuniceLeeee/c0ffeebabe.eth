import { bindRequestResultRound, collectRequestProgramResults,
  type DependentRequestProgram, type ExactQuoteInput, type ExactQuoteResult,
  type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { assertSource, decodeOperateResult, FLUID_ERC20_INTERFACE, FLUID_VAULT_INTERFACE,
  requireSuccessfulResult, sameAddress, tokenDelta } from "./codec.js";
import { fluidMaxBorrowRequest } from "./borrow-math.js";
import { decodeFluidCurrentState, fluidConfigRequests, fluidRateProgram } from "./state.js";
import type { FluidCreditDescriptor, FluidCreditRiskEvidence, FluidCreditRoute } from "./types.js";

type Input = ExactQuoteInput<FluidCreditDescriptor, FluidCreditRoute> & { readonly debtBps?: bigint };
const OPERATE_ID = "credit-exact-operate";
export function assertFluidCreditRoute(descriptor: FluidCreditDescriptor, route: FluidCreditRoute): void {
  if (route.instanceKey !== descriptor.instanceKey || !sameAddress(route.vault, descriptor.vault) ||
      !sameAddress(route.tokenIn, descriptor.supplyToken) || !sameAddress(route.tokenOut, descriptor.borrowToken) ||
      route.taxonomy.slotKind !== "lend" || route.lifecycle !== "standing-position") {
    throw new Error("fluid-credit quote route does not match descriptor");
  }
}
function validate(input: Input): void {
  assertFluidCreditRoute(input.descriptor, input.route);
  if (input.amountIn < 10_000n || input.amountIn > (1n << 127n) - 1n) {
    throw new Error("fluid-credit exact requires int128 collateral at least 10000 raw units");
  }
}

/** One amount quote program, also consumed by the Credit risk wrapper. */
export const fluidCreditBorrowProgram = {
  requirements: (_input: Input) => ({ transports: ["eth-call"] as const }),
  buildRequests(input) {
    validate(input);
    return fluidConfigRequests(input.descriptor.vault);
  },
  buildDependentProgram({ programInput: input, completedRound, initialResults, priorEvidence }) {
    validate(input);
    if (completedRound === 0) return fluidRateProgram(input.descriptor.vault, initialResults);
    if (completedRound !== 1) return null;
    const state = decodeFluidCurrentState(collectRequestProgramResults(initialResults, priorEvidence));
    assertSource(state.source, input.source);
    const debt = fluidMaxBorrowRequest(input.amountIn, state, input.debtBps);
    return bindRequestResultRound({ transports: ["effect-delta-simulation"], caller: "executor",
      effects: ["return-data", "token-delta"] }, [{
      id: OPERATE_ID, kind: "effect-delta-simulation",
      preCalls: [{ caller: { kind: "executor" }, to: input.descriptor.supplyToken,
        data: FLUID_ERC20_INTERFACE.encodeFunctionData("approve", [input.descriptor.vault, input.amountIn]) }],
      call: { caller: { kind: "executor" },
        executionMode: input.transactionOrigin === undefined ? "top-level" : "impersonated-call-frame", to: input.descriptor.vault,
        data: FLUID_VAULT_INTERFACE.encodeFunctionData("operate", [0n, input.amountIn, debt, input.executor]) },
      overrideIntent: { caller: { kind: "executor" }, tokenBalances: [{ token: input.descriptor.supplyToken, amount: input.amountIn }] },
      observe: ["return-data", "token-delta"],
      observeTokenBalances: [{ token: input.descriptor.supplyToken, account: { kind: "executor" } },
        { token: input.descriptor.borrowToken, account: { kind: "executor" } }],
    }]);
  },
  decode({ programInput: input, initialResults, dependentEvidence }) {
    validate(input);
    const results = collectRequestProgramResults(initialResults, dependentEvidence);
    const state = decodeFluidCurrentState(results);
    assertSource(state.source, input.source);
    const requested = fluidMaxBorrowRequest(input.amountIn, state, input.debtBps);
    const result = requireSuccessfulResult(results, OPERATE_ID);
    assertSource(result.source, input.source);
    const returned = decodeOperateResult(result.data);
    const collateralDelta = tokenDelta(result, input.descriptor.supplyToken, input.executor);
    const debtDelta = tokenDelta(result, input.descriptor.borrowToken, input.executor);
    if (returned.nftId <= 0n || returned.finalSupply !== input.amountIn || returned.finalBorrow !== requested ||
        collateralDelta !== -input.amountIn || debtDelta !== requested) {
      throw new Error("fluid-credit exact operate did not prove requested collateral and actual debt receipt");
    }
    return { amountOut: debtDelta, evidence: Object.freeze({ kind: "fluid-credit-effect-delta-risk-proof" as const,
      source: input.source, vault: input.descriptor.vault, routeKey: input.route.routeKey, executor: input.executor,
      collateralAmount: input.amountIn, debtBps: input.debtBps ?? 10_000n, debtAmount: debtDelta,
      nftId: returned.nftId, finalSupply: returned.finalSupply, finalBorrow: returned.finalBorrow,
      collateralDelta, debtDelta, borrowState: state }) };
  },
} satisfies DependentRequestProgram<Input, ExactQuoteResult<FluidCreditRiskEvidence>>;

export const fluidCreditExactProgram: ExactRequestProgram<FluidCreditDescriptor, FluidCreditRoute, FluidCreditRiskEvidence> = fluidCreditBorrowProgram;

export const fluidCreditExact = {
  methods: () => [{ id: "fluid-credit-oracle-operate", kind: "request-program" as const,
    chainAmountQuote: true as const, program: fluidCreditExactProgram }],
  cacheCompatibilityProjection: ({ descriptor, route }) => ({ vault: descriptor.vault,
    binding: route.bindingRef.fingerprint, routeKey: route.routeKey, tokenIn: route.tokenIn, tokenOut: route.tokenOut }),
} satisfies ExactQuoteSemantics<FluidCreditDescriptor, FluidCreditRoute, FluidCreditRiskEvidence>;
