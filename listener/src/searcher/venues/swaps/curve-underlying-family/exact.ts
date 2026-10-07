import { classicUnderlyingQuoteRequests, classicUnderlyingQuoteNextRound, decodeClassicUnderlyingQuote } from "./classic-meta-quote.js";
import { curveUnderlyingQuoteModelProjection } from "./quote-model.js";
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
  requirements: ({ descriptor }) => ({ transports: descriptor.quoteModel ? ["eth-call", "get-code", "get-storage"] : ["eth-call"] }),
  buildRequests(input) {
    assertInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n || input.amountIn > (1n << 256n) - 1n) {
      throw new Error("curve-underlying exact amountIn outside uint256 range");
    }
    if (input.amountIn === 0n) return [];
    if (input.descriptor.quoteModel) return classicUnderlyingQuoteRequests(input);
    return Object.freeze([Object.freeze({
      id: EXACT_QUOTE_ID,
      kind: "eth-call" as const,
      to: input.descriptor.pool,
      data: CURVE_UNDERLYING_POOL_INTERFACE.encodeFunctionData(
        "get_dy_underlying",
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
    if (programInput.descriptor.quoteModel) {
      amountOut = decodeClassicUnderlyingQuote(programInput, initialResults, dependentEvidence);
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
      id: input.descriptor.quoteModel ? "curve-classic-meta-execution" : "curve-get-dy",
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
    kind: input.descriptor.quoteModel ? "curve-underlying-classic-meta" as const : "curve-underlying-get-dy" as const,
    source: input.source,
    pool: input.descriptor.pool,
    routeKey: input.route.routeKey,
    i: input.route.i,
    j: input.route.j,
    tokenIn: input.route.tokenIn,
    tokenOut: input.route.tokenOut,
    amountIn: input.amountIn,
    amountOut,
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
