import { lendingGuardRequests, assertLendingGuards, lendingSwapRequest, decodeLendingSwap,
  lendingSimulationRequirements, lendingProjection } from "./lending.js";
import { legacyPlainQuoteRequests, decodeLegacyPlainState, quoteLegacyPlain } from "./legacy-plain.js";
import { classicUnderlyingQuoteRequests, classicUnderlyingQuoteNextRound, decodeClassicUnderlyingQuote } from "./classic-meta-quote.js";
import { curveUnderlyingQuoteModelProjection } from "./quote-model.js";
import { CURVE_UNDERLYING_NATIVE_QUOTE } from "./native.js";
import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import {
  CURVE_UNDERLYING_POOL_INTERFACE,
  decodeGetDy,
  requireSuccessfulResult,
  sameAddress,
} from "./codec.js";
import type {
  CurveUnderlyingDescriptor,
  CurveUnderlyingExactEvidence,
  CurveUnderlyingRoute,
} from "./types.js";

const EXACT_QUOTE_ID = "exact-get-dy-underlying";

const curveUnderlyingRequestProgram: ExactRequestProgram<
  CurveUnderlyingDescriptor,
  CurveUnderlyingRoute,
  CurveUnderlyingExactEvidence
> = {
  requirements: ({ descriptor }) => descriptor.lending ? { ...lendingSimulationRequirements,
    transports: ["eth-call", "get-code", "get-storage", "effect-delta-simulation"] } :
    ({ transports: descriptor.quoteModel || descriptor.legacyPlain ? ["eth-call", "get-code", "get-storage"] : ["eth-call"] }),
  buildRequests(input) {
    assertInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n || input.amountIn > (1n << 256n) - 1n) {
      throw new Error("curve-underlying exact amountIn outside uint256 range");
    }
    if (input.amountIn === 0n) return [];
    if (input.descriptor.lending) return [...lendingGuardRequests(input.descriptor.pool, input.descriptor.lending),
      lendingSwapRequest({ id: EXACT_QUOTE_ID, ...input.route, pool: input.descriptor.pool, amountIn: input.amountIn })];
    if (input.descriptor.quoteModel) return classicUnderlyingQuoteRequests(input);
    if (input.descriptor.legacyPlain) return legacyPlainQuoteRequests(input.descriptor.pool);
    return Object.freeze([Object.freeze({
      id: EXACT_QUOTE_ID,
      kind: "eth-call" as const,
      to: input.descriptor.pool,
      data: (input.descriptor.nativeAlias ? CURVE_UNDERLYING_NATIVE_QUOTE : CURVE_UNDERLYING_POOL_INTERFACE).encodeFunctionData(
        input.descriptor.nativeAlias ? "get_dy" : "get_dy_underlying",
        [BigInt(input.route.i), BigInt(input.route.j), input.amountIn],
      ),
      completion: "return-data" as const,
    })]);
  },
  buildDependentProgram({ programInput: current, completedRound, initialResults }) {
    return current.descriptor.quoteModel && current.amountIn > 0n
      ? classicUnderlyingQuoteNextRound(current, completedRound, initialResults) : null;
  },
  decode({ programInput, initialResults, dependentEvidence }) {
    const results = initialResults;
    assertInvocation(programInput.descriptor, programInput.route);
    if (programInput.amountIn === 0n) return zeroQuote(programInput);
    let amountOut: bigint;
    if (programInput.descriptor.lending) {
      assertLendingGuards(programInput.descriptor.pool, programInput.descriptor.coins,
        programInput.descriptor.lending, programInput.source, initialResults);
      const received = decodeLendingSwap({ pool: programInput.descriptor.pool, coins: programInput.descriptor.coins,
        binding: programInput.descriptor.lending, i: programInput.route.i, j: programInput.route.j,
        amountIn: programInput.amountIn, source: programInput.source, executor: programInput.executor },
        requireSuccessfulResult(results, EXACT_QUOTE_ID));
      if (received === null) throw new Error("curve-underlying lending exchange reverted");
      amountOut = received;
    } else if (programInput.descriptor.quoteModel) {
      amountOut = decodeClassicUnderlyingQuote(programInput, initialResults, dependentEvidence);
    } else if (programInput.descriptor.legacyPlain) {
      const state = decodeLegacyPlainState(programInput.descriptor.legacyPlain, programInput.source, initialResults);
      amountOut = quoteLegacyPlain(state, programInput.route.i, programInput.route.j, programInput.amountIn);
    } else {
      const result = requireSuccessfulResult(results, EXACT_QUOTE_ID);
      assertSource(result.source, programInput.source);
      amountOut = decodeGetDy(result.data);
    }
    if (amountOut <= 0n) {
      throw new Error("curve-underlying exact quote returned non-positive output");
    }
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(programInput, amountOut),
    });
  },
};

export const curveUnderlyingExact = {
  methods: (input) => Object.freeze([
    localZeroExactMethod<
      CurveUnderlyingDescriptor,
      CurveUnderlyingRoute,
      CurveUnderlyingExactEvidence
    >(
      "local-zero",
      (input) => {
        assertInvocation(input.descriptor, input.route);
        return zeroQuote(input);
      },
    ),
    Object.freeze({
      id: input.descriptor.lending ? "curve-lending-actual-receipt"
        : input.descriptor.quoteModel ? "curve-classic-meta-execution"
        : input.descriptor.legacyPlain ? "curve-legacy-plain-execution" : "curve-get-dy",
      kind: "request-program" as const,
      ...(input.descriptor.quoteModel && input.route.i > 0
        ? { trialState: { unsupportedReason: "classic base deposit/exchange post-state is not modeled; independent source quotes only" } }
        : { chainAmountQuote: true as const }),
      program: curveUnderlyingRequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    pool: descriptor.pool,
    quoteModel: curveUnderlyingQuoteModelProjection(descriptor.quoteModel),
    legacyPlain: descriptor.legacyPlain ? { ...descriptor.legacyPlain } : null,
    lending: lendingProjection(descriptor.lending),
    nativeAlias: descriptor.nativeAlias ? { ...descriptor.nativeAlias } : null,
    registryBinding: {
      registry: descriptor.registryBinding.registry,
      handlers: descriptor.registryBinding.handlers,
      lookupSemantics: descriptor.registryBinding.lookupSemantics,
    },
    route: {
      routeKey: route.routeKey,
      i: route.i,
      j: route.j,
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
      semantics: route.semantics,
    },
  }),
} satisfies ExactQuoteSemantics<
  CurveUnderlyingDescriptor,
  CurveUnderlyingRoute,
  CurveUnderlyingExactEvidence
>;

function zeroQuote(input: Parameters<typeof exactEvidence>[0]) {
  return Object.freeze({
    amountOut: 0n,
    evidence: exactEvidence(input, 0n),
  });
}

function exactEvidence(
  input: {
    readonly descriptor: CurveUnderlyingDescriptor;
    readonly route: CurveUnderlyingRoute;
    readonly amountIn: bigint;
    readonly source: CurveUnderlyingExactEvidence["source"];
  },
  amountOut: bigint,
): CurveUnderlyingExactEvidence {
  return Object.freeze({
    kind: input.descriptor.lending ? "curve-underlying-lending" as const
      : input.descriptor.quoteModel ? "curve-underlying-classic-meta" as const
      : input.descriptor.legacyPlain ? "curve-underlying-legacy-plain" as const : "curve-underlying-get-dy" as const,
    source: input.source,
    pool: input.descriptor.pool,
    routeKey: input.route.routeKey,
    i: input.route.i,
    j: input.route.j,
    tokenIn: input.route.tokenIn,
    tokenOut: input.route.tokenOut,
    amountIn: input.amountIn,
    amountOut,
    ...(input.descriptor.nativeAlias ? { nativeAlias: input.descriptor.nativeAlias } : {}),
  });
}

function assertInvocation(
  descriptor: CurveUnderlyingDescriptor,
  route: CurveUnderlyingRoute,
): void {
  const direction = descriptor.verifiedDirections.find((candidate) =>
    candidate.i === route.i && candidate.j === route.j
  );
  if (
    route.instanceKey !== descriptor.instanceKey ||
    !sameAddress(route.pool, descriptor.pool) ||
    direction === undefined ||
    !sameAddress(route.tokenIn, direction.tokenIn) ||
    !sameAddress(route.tokenOut, direction.tokenOut)
  ) {
    throw new Error("curve-underlying exact route does not match descriptor");
  }
}

function assertSource(
  actual: CurveUnderlyingExactEvidence["source"],
  expected: CurveUnderlyingExactEvidence["source"],
): void {
  if (
    actual.number !== expected.number ||
    actual.generation !== expected.generation ||
    actual.hash.toLowerCase() !== expected.hash.toLowerCase()
  ) {
    throw new Error("curve-underlying exact quote came from a foreign source");
  }
}
