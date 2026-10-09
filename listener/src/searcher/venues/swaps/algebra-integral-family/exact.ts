import {
  localZeroExactMethod,
  type ExactMethod,
  type ExactQuoteInput,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { ALGEBRA_PLUGIN_DYNAMIC_FEE_FLAG } from "./abi.js";
import { canonicalAddress, sameAddress } from "./codec.js";
import { quoteAlgebraExactInput } from "./math.js";
import {
  algebraBoundTick,
  algebraPriceStateRequests,
  algebraRangeStep,
  readAlgebraPriceState,
  type AlgebraPriceState,
} from "./state.js";
import type {
  AlgebraIntegralDescriptor,
  AlgebraIntegralExactEvidence,
  AlgebraIntegralRoute,
} from "./types.js";

type AlgebraExactInput = ExactQuoteInput<AlgebraIntegralDescriptor, AlgebraIntegralRoute>;

/**
 * The supported variant quotes the pool's own single-in-range step with the
 * executed fee the pool will actually charge (`globalState.lastFee`, since the
 * dynamic-fee bit is refused at identity) and DECLINES the amount when it would
 * reach the next initialized tick instead of extrapolating across the pool's
 * tick tree. Every number comes from a source-bound read; no off-chain per-hop
 * call and no point-price multiplication is used as an amount quote.
 */
const program: ExactRequestProgram<
  AlgebraIntegralDescriptor,
  AlgebraIntegralRoute,
  AlgebraIntegralExactEvidence
> = {
  requirements: () => ({ transports: ["eth-call"] }),
  buildRequests(input) {
    assertRoute(input.descriptor, input.route);
    // Zero input is identity, handled by the local-zero method.
    if (input.amountIn <= 0n) return [];
    return algebraPriceStateRequests(input.descriptor.pool);
  },
  decode({ programInput, initialResults }) {
    assertRoute(programInput.descriptor, programInput.route);
    if (programInput.amountIn <= 0n) {
      return declinedQuote(programInput, "non-positive input");
    }
    const state = readAlgebraPriceState(initialResults);
    assertSource(state.source, programInput.source);
    return quoteFromState(programInput, state);
  },
};

export const algebraIntegralExact = {
  methods: (input): readonly ExactMethod<
    AlgebraIntegralDescriptor,
    AlgebraIntegralRoute,
    AlgebraIntegralExactEvidence
  >[] => Object.freeze([
    localZeroExactMethod<
      AlgebraIntegralDescriptor,
      AlgebraIntegralRoute,
      AlgebraIntegralExactEvidence
    >(
      "algebra-local-zero",
      (zeroInput) => {
        assertRoute(zeroInput.descriptor, zeroInput.route);
        return declinedQuote(zeroInput, "zero input");
      },
    ),
    Object.freeze({
      id: "algebra-single-range-state",
      kind: "request-program" as const,
      stateOnlyReads: true as const,
      // This family models one in-range step and publishes no shared V3 tick
      // cell: a crossed-range state would need the pool's tick tree, which is
      // not read here. Sequential-prefix support is therefore declared absent
      // rather than approximated.
      trialState: {
        unsupportedReason:
          "algebra-integral quotes model a single in-range step and publish no shared V3 trial cell",
      },
      program,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route, executor }) => ({
    pool: descriptor.pool,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    tickSpacing: descriptor.tickSpacing,
    feeBinding: descriptor.executedFee.kind,
    plugin: descriptor.executedFee.plugin,
    factoryBinding: {
      factory: descriptor.factoryBinding.factory,
      reversePool: descriptor.factoryBinding.reversePool,
    },
    caller: canonicalAddress(executor),
  }),
} satisfies ExactQuoteSemantics<
  AlgebraIntegralDescriptor,
  AlgebraIntegralRoute,
  AlgebraIntegralExactEvidence
>;

function quoteFromState(
  input: AlgebraExactInput,
  state: AlgebraPriceState,
): ReturnType<typeof declinedQuote> {
  if ((state.globalState.pluginConfig & ALGEBRA_PLUGIN_DYNAMIC_FEE_FLAG) !== 0) {
    return declinedQuote(
      input,
      "pool is plugin-dynamic-fee controlled; the executed fee is not state-readable",
      state,
    );
  }
  if (state.fee !== state.globalState.lastFee) {
    return declinedQuote(
      input,
      `fee() ${state.fee} differs from globalState.lastFee ${state.globalState.lastFee}`,
      state,
    );
  }
  const zeroForOne = input.route.direction === "zero-for-one";
  const quote = quoteAlgebraExactInput(
    algebraRangeStep(state, input.route.direction),
    zeroForOne,
    input.amountIn,
  );
  if (quote.status === "declined") {
    return declinedQuote(input, quote.reason, state);
  }
  return Object.freeze({
    amountOut: quote.amountOut,
    evidence: evidence(input, state, {
      amountOut: quote.amountOut,
      sqrtPriceX96After: quote.sqrtPriceX96After,
      declinedReason: null,
    }),
  });
}

function declinedQuote(
  input: AlgebraExactInput,
  reason: string,
  state?: AlgebraPriceState,
): {
  readonly amountOut: bigint;
  readonly evidence: AlgebraIntegralExactEvidence;
} {
  return Object.freeze({
    amountOut: 0n,
    evidence: evidence(input, state, {
      amountOut: 0n,
      sqrtPriceX96After: 0n,
      declinedReason: reason,
    }),
  });
}

function evidence(
  input: AlgebraExactInput,
  state: AlgebraPriceState | undefined,
  quote: {
    readonly amountOut: bigint;
    readonly sqrtPriceX96After: bigint;
    readonly declinedReason: string | null;
  },
): AlgebraIntegralExactEvidence {
  const boundTick = state === undefined
    ? 0
    : algebraBoundTick(state, input.route.direction);
  return Object.freeze({
    kind: "algebra-integral-single-range" as const,
    source: input.source,
    pool: input.descriptor.pool,
    tokenIn: input.route.tokenIn,
    tokenOut: input.route.tokenOut,
    tickSpacing: input.descriptor.tickSpacing,
    executedFee: state === undefined ? input.descriptor.executedFee.fee : state.fee,
    feeProvenance: "algebra-static-last-fee" as const,
    pluginFeeProvenance: "structurally-zero-without-dynamic-fee-flag" as const,
    pluginConfig: state === undefined
      ? input.descriptor.executedFee.pluginConfig
      : state.globalState.pluginConfig,
    amountIn: input.amountIn,
    amountOut: quote.amountOut,
    sqrtPriceX96Before: state === undefined ? 0n : state.globalState.sqrtPriceX96,
    sqrtPriceX96After: quote.sqrtPriceX96After,
    rangeBoundTick: boundTick,
    rangeBoundSqrtPriceX96: state === undefined
      ? 0n
      : algebraRangeStep(state, input.route.direction).targetSqrtPriceX96,
    declinedReason: quote.declinedReason,
  });
}

function assertRoute(
  descriptor: AlgebraIntegralDescriptor,
  route: AlgebraIntegralRoute,
): void {
  const zeroForOne = route.direction === "zero-for-one";
  const expectedIn = zeroForOne ? descriptor.token0 : descriptor.token1;
  const expectedOut = zeroForOne ? descriptor.token1 : descriptor.token0;
  if (
    (route.direction !== "zero-for-one" && route.direction !== "one-for-zero") ||
    route.instanceKey !== descriptor.instanceKey ||
    !sameAddress(route.pool, descriptor.pool) ||
    !sameAddress(route.tokenIn, expectedIn) ||
    !sameAddress(route.tokenOut, expectedOut) ||
    route.tickSpacing !== descriptor.tickSpacing
  ) {
    throw new Error(
      `algebra-integral exact route binding does not match ${descriptor.pool}`,
    );
  }
}

function assertSource(
  actual: CanonicalSource,
  expected: CanonicalSource,
): void {
  if (
    actual.number !== expected.number ||
    actual.hash.toLowerCase() !== expected.hash.toLowerCase() ||
    actual.generation !== expected.generation
  ) {
    throw new Error("algebra-integral exact quote came from a foreign source");
  }
}
