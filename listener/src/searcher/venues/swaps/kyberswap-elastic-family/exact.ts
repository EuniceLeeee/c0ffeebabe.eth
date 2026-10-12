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
  quoteExactInput,
  stepTargetTick,
} from "./math.js";
import {
  KYSWAP_STATE_ID,
  decodePoolState,
  neighbourRequests,
  poolStateRequests,
  crossingRequests,
  decodeCrossings,
} from "./state.js";
import { KYSWAP_SWAP_ACTION } from "./manifest.js";
import type {
  KyberSwapDescriptor,
  KyberSwapExactEvidence,
  KyberSwapRoute,
} from "./types.js";

const EXACT_QUOTE_ID = "kyberswap-elastic-exact-input";

type QuoteInput = {
  readonly descriptor: KyberSwapDescriptor;
  readonly route: KyberSwapRoute;
  readonly amountIn: bigint;
  readonly source: import("../../adapter-request-program.js").CanonicalSource;
};

/**
 * Specified-amount exact-input quote across initialized ticks. Each missing
 * crossing declares a source-bound round through the existing central issuer.
 * Smaller amounts reuse the same state reads; larger amounts request only the
 * additional crossing evidence they need. No private RPC or quote fallback.
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
    if (input.programInput.amountIn <= 0n) return null;
    assertKyberSwapInvocation(input.programInput.descriptor, input.programInput.route);
    const results = collectRequestProgramResults(input.initialResults, input.priorEvidence);
    const neighbours = results.some(result => result.id === KYSWAP_STATE_ID.neighbours);
    const probe = decodePoolState(results, {neighbours});
    assertSource(probe.source, input.programInput.source);
    if (probe.locked) return null;
    if (input.programInput.route.direction === "token1-in" && !neighbours) {
      return bindRequestResultRound({transports: ["eth-call"]},
        neighbourRequests(input.programInput.descriptor.pool, probe.nearestCurrentTick));
    }
    const outcome = quoteExactInput({state: probe, isToken0: input.programInput.route.isToken0,
      amountIn: input.programInput.amountIn, ticks: decodeCrossings(results, probe.source)});
    if (outcome.ok || outcome.missingTick === undefined) return null;
    return bindRequestResultRound({transports: ["eth-call"]},
      crossingRequests(input.programInput.descriptor.pool, outcome.missingTick));
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
    const outcome = quoteExactInput({
      state,
      isToken0: programInput.route.isToken0,
      amountIn: programInput.amountIn,
      ticks: decodeCrossings(results, state.source),
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
          sqrtPBefore: state.sqrtP,
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
        sqrtPBefore: state.sqrtP,
        steps: outcome.quote.steps,
        crossedTicks: outcome.quote.crossedTicks,
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
          "KyberSwap Elastic linked-tick/reinvestment state is not registered " +
          "as a shared trial-state model",
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
    quoteMode: "elastic-exact-input",
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
    readonly sqrtPBefore?: bigint;
    readonly steps?: number;
    readonly crossedTicks?: readonly number[];
    readonly refusal: string | null;
    readonly source?: import("../../adapter-request-program.js").CanonicalSource;
  },
): KyberSwapExactEvidence {
  return Object.freeze({
    kind: "kyberswap-elastic-exact-input",
    source: Object.freeze({ ...(quote.source ?? input.source) }),
    pool: input.descriptor.pool,
    tokenIn: input.route.tokenIn,
    tokenOut: input.route.tokenOut,
    direction: input.route.direction,
    isToken0: input.route.isToken0,
    feeUnits: input.descriptor.feeUnits,
    amountIn: input.amountIn,
    amountOut: quote.amountOut,
    sqrtPBefore: quote.sqrtPBefore ?? 0n,
    sqrtPAfter: quote.sqrtPAfter,
    liquidity: quote.liquidity,
    deltaL: quote.deltaL,
    targetTick: quote.targetTick,
    steps: quote.steps ?? 0,
    crossedTicks: quote.crossedTicks ?? Object.freeze([]),
    refusal: quote.refusal,
    bindingFingerprint: input.route.bindingRef.fingerprint,
  });
}

void KYSWAP_SWAP_ACTION;
