import {
  bindRequestResultRound,
  collectRequestProgramResults,
  localZeroExactMethod,
  type ExactQuoteInput,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { amount } from "./codec.js";
import { assertRoute } from "./routes.js";
import { decodeState, quotable, stateRequests } from "./state.js";
import { decodeReceipt, simulationRequest, simulationRequirements } from "./simulation.js";
import type { Descriptor, Evidence, Route } from "./types.js";

type Input = ExactQuoteInput<Descriptor, Route>;

function validate(input: Input): void {
  assertRoute(input.descriptor, input.route);
  amount(input.amountIn, true);
  runtimeExecutor(input.executor, input.descriptor.pair, input.route.tokenIn, input.route.tokenOut);
}

function quote(input: Input, amountOut: bigint): { amountOut: bigint; evidence: Evidence } {
  return {
    amountOut,
    evidence: {
      kind: "ammalgam-pair-execution",
      source: { ...input.source },
      binding: input.route.bindingRef.fingerprint,
      routeKey: input.route.routeKey,
      executor: input.executor.toLowerCase(),
      amountIn: input.amountIn,
      amountOut,
    },
  };
}

/**
 * Exact quote = same-state execution of the family runtime program.
 *
 * The pair's `swap` requires the caller to name the output amount, so the
 * program derives it from pair state with the verified fee model and the pair's
 * own K check then accepts or rejects it. The isolated simulation is therefore
 * the quote: the returned amount is the output the pair actually delivered, not
 * an assumption about it.
 */
export const exactProgram: ExactRequestProgram<Descriptor, Route, Evidence> = {
  // Round 0 reads pair state only: no caller-bound or executor request is
  // issued here. The isolated execution round below declares the executor.
  requirements: input => input.amountIn === 0n ? { transports: [] } : { transports: ["eth-call"] },
  buildRequests(input) {
    validate(input);
    return input.amountIn === 0n ? [] : stateRequests(input.descriptor);
  },
  buildDependentProgram({ programInput: input, completedRound, initialResults }) {
    validate(input);
    if (input.amountIn === 0n || completedRound !== 0) return null;
    const state = decodeState(input.descriptor, initialResults, input.source);
    const reason = quotable(state);
    if (reason) throw new Error(reason);
    return bindRequestResultRound(
      simulationRequirements,
      [simulationRequest({
        descriptor: input.descriptor,
        route: input.route,
        amountIn: input.amountIn,
        executor: input.executor,
        recipient: input.executor,
      })],
    );
  },
  decode({ programInput: input, initialResults, dependentEvidence }) {
    validate(input);
    if (input.amountIn === 0n) {
      if (initialResults.length !== 0 || dependentEvidence.length !== 0) {
        throw new Error("ammalgam zero quote has reads");
      }
      return quote(input, 0n);
    }
    if (dependentEvidence.length !== 1) throw new Error("ammalgam missing Exact simulation round");
    const state = decodeState(input.descriptor, initialResults, input.source);
    const reason = quotable(state);
    if (reason) throw new Error(reason);
    const all = collectRequestProgramResults(initialResults, dependentEvidence);
    return quote(input, decodeReceipt(all, input.descriptor, input.route, input.amountIn, input.executor));
  },
};

export const exact = {
  methods: () => [
    localZeroExactMethod<Descriptor, Route, Evidence>("zero", input => {
      validate(input);
      return quote(input, 0n);
    }),
    {
      id: "ammalgam-pair-executed-output",
      kind: "request-program" as const,
      chainAmountQuote: true,
      program: exactProgram,
    },
  ],
  cacheCompatibilityProjection: input => ({
    binding: input.route.bindingRef.fingerprint,
    routeKey: input.route.routeKey,
    executor: input.executor.toLowerCase(),
  }),
} satisfies ExactQuoteSemantics<Descriptor, Route, Evidence>;
