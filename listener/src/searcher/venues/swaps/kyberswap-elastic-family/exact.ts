import {
  bindRequestResultRound,
  collectRequestProgramResults,
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import { assertSource } from "../../protocols/standard-family/common.js";
import {
  assertKyberSwapInvocation,
  assertPositiveAmount,
  lower,
} from "./codec.js";
import {
  quoteExactInputStep,
  stepTargetTick,
} from "./math.js";
import {
  KYSWAP_STATE_ID,
  decodePoolState,
  neighbourRequests,
  poolStateRequests,
} from "./state.js";
import { KYSWAP_SWAP_ACTION } from "./manifest.js";
import type {
  KyberSwapDescriptor,
  KyberSwapExactEvidence,
  KyberSwapRoute,
} from "./types.js";

const EXACT_QUOTE_ID = "kyberswap-elastic-single-range";

type QuoteInput = {
  readonly descriptor: KyberSwapDescriptor;
  readonly route: KyberSwapRoute;
  readonly amountIn: bigint;
  readonly source: import("../../adapter-request-program.js").CanonicalSource;
};

/**
 * Specified-amount exact-input quote for the pool's FIRST swap step.
 *
 * The state read is the pool's own `getPoolState()` / `getLiquidityState()` /
 * `swapFeeUnits()` (plus the initialized-tick neighbours when the price moves
 * up), and the arithmetic is the verified `SwapMath` step the pool itself runs.
 * When the caller's amount would reach the next initialized tick the step
 * crosses a range whose post-crossing liquidity is not in this round's
 * evidence, so the quote is refused with `amountOut = 0` — never extrapolated,
 * never replaced by a point-price sample. The caller's amount is preserved
 * exactly; runtime execution takes the previous leg's ACTUAL received amount.
 */
const program: ExactRequestProgram<
  KyberSwapDescriptor,
  KyberSwapRoute,
  KyberSwapExactEvidence
> = {
  requirements: ({ descriptor, route }) => {
    assertKyberSwapInvocation(descriptor, route);
    return { transports: ["eth-call"] };
  },
  buildRequests(input) {
    assertKyberSwapInvocation(input.descriptor, input.route);
    assertPositiveAmount(input.amountIn, "exact quote amount");
    return poolStateRequests(input.descriptor.pool);
  },
  buildDependentProgram(input) {
    // Central invokes this again after decoding every dependent round. This
    // model has exactly one neighbour read, not an unbounded tick walk.
    if (input.completedRound > 0) return null;
    if (input.programInput.amountIn <= 0n) return null;
    // Down-tick swaps take their step target from `nearestCurrentTick`, which
    // the first round already returned; up-tick swaps need that tick's `next`.
    if (input.programInput.route.direction === "token0-in") return null;
    const probe = decodePoolState(input.initialResults, { neighbours: false });
    if (probe.locked) return null;
    return bindRequestResultRound(
      { transports: ["eth-call"] },
      neighbourRequests(
        input.programInput.descriptor.pool,
        probe.nearestCurrentTick,
      ),
    );
  },
  decode(input) {
    const { programInput, initialResults } = input;
    assertKyberSwapInvocation(programInput.descriptor, programInput.route);
    if (programInput.amountIn <= 0n) {
      return Object.freeze({
        amountOut: 0n,
        evidence: evidenceFor(programInput, {
          amountOut: 0n,
          sqrtPAfter: 0n,
          liquidity: 0n,
          deltaL: 0n,
          targetTick: null,
          refusal: "zero-amount",
        }),
      });
    }
    const results = collectRequestProgramResults(
      initialResults,
      input.dependentEvidence,
    );
    const neighbours = programInput.route.direction === "token1-in" &&
      results.some((result) => result.id === KYSWAP_STATE_ID.neighbours);
    const state = decodePoolState(results, { neighbours });
    assertSource(state.source, programInput.source);
    const liquidity = state.baseL + state.reinvestL;
    const outcome = quoteExactInputStep({
      state,
      isToken0: programInput.route.isToken0,
      amountIn: programInput.amountIn,
    });
    if (!outcome.ok) {
      return Object.freeze({
        amountOut: 0n,
        evidence: evidenceFor(programInput, {
          amountOut: 0n,
          sqrtPAfter: state.sqrtP,
          liquidity,
          deltaL: 0n,
          targetTick: stepTargetTick(state, programInput.route.isToken0),
          refusal: outcome.refusal,
          source: state.source,
        }),
      });
    }
    return Object.freeze({
      amountOut: outcome.quote.amountOut,
      evidence: evidenceFor(programInput, {
        amountOut: outcome.quote.amountOut,
        sqrtPAfter: outcome.quote.sqrtPAfter,
        liquidity,
        deltaL: outcome.quote.deltaL,
        targetTick: outcome.quote.targetTick,
        refusal: null,
        source: state.source,
      }),
    });
  },
};

export const kyberswapElasticExact = {
  methods: (input: QuoteInput) => Object.freeze([
    localZeroExactMethod<
      KyberSwapDescriptor,
      KyberSwapRoute,
      KyberSwapExactEvidence
    >("local-zero", (zeroInput) => Object.freeze({
      amountOut: 0n,
      evidence: evidenceFor(zeroInput, {
        amountOut: 0n,
        sqrtPAfter: 0n,
        liquidity: 0n,
        deltaL: 0n,
        targetTick: null,
        refusal: "zero-amount",
      }),
    })),
    Object.freeze({
      id: EXACT_QUOTE_ID,
      kind: "request-program" as const,
      stateOnlyReads: true as const,
      trialState: {
        unsupportedReason:
          "KyberSwap Elastic step state (baseL + reinvestL with a step-target " +
          "initialized tick) is not registered as a shared trial-state model",
      },
      program,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route, executor }: {
    readonly descriptor: KyberSwapDescriptor;
    readonly route: KyberSwapRoute;
    readonly executor: string;
  }) => ({
    pool: lower(descriptor.pool),
    tokenIn: lower(route.tokenIn),
    tokenOut: lower(route.tokenOut),
    direction: route.direction,
    isToken0: route.isToken0,
    feeUnits: descriptor.feeUnits,
    quoteMode: "elastic-single-range",
    bindingFingerprint: route.bindingRef.fingerprint,
    executor: lower(executor),
  }),
} satisfies ExactQuoteSemantics<
  KyberSwapDescriptor,
  KyberSwapRoute,
  KyberSwapExactEvidence
>;

function evidenceFor(
  input: QuoteInput,
  quote: {
    readonly amountOut: bigint;
    readonly sqrtPAfter: bigint;
    readonly liquidity: bigint;
    readonly deltaL: bigint;
    readonly targetTick: number | null;
    readonly refusal: string | null;
    readonly source?: import("../../adapter-request-program.js").CanonicalSource;
  },
): KyberSwapExactEvidence {
  return Object.freeze({
    kind: "kyberswap-elastic-single-range",
    source: Object.freeze({ ...(quote.source ?? input.source) }),
    pool: input.descriptor.pool,
    tokenIn: input.route.tokenIn,
    tokenOut: input.route.tokenOut,
    direction: input.route.direction,
    isToken0: input.route.isToken0,
    feeUnits: input.descriptor.feeUnits,
    amountIn: input.amountIn,
    amountOut: quote.amountOut,
    sqrtPBefore: 0n,
    sqrtPAfter: quote.sqrtPAfter,
    liquidity: quote.liquidity,
    deltaL: quote.deltaL,
    targetTick: quote.targetTick,
    refusal: quote.refusal,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}

void KYSWAP_SWAP_ACTION;
