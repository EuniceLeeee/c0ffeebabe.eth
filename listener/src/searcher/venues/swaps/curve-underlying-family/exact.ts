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
  requirements: () => ({ transports: ["eth-call"] }),
  buildRequests(input) {
    assertInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("curve-underlying exact amountIn cannot be negative");
    }
    if (input.amountIn === 0n) return [];
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
  decode({ programInput, initialResults }) {
    const results = initialResults;
    assertInvocation(programInput.descriptor, programInput.route);
    if (programInput.amountIn === 0n) return zeroQuote(programInput);
    const result = requireSuccessfulResult(results, EXACT_QUOTE_ID);
    assertSource(result.source, programInput.source);
    const amountOut = decodeGetDy(result.data);
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
  methods: () => Object.freeze([
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
      id: "curve-get-dy",
      kind: "request-program" as const,
      program: curveUnderlyingRequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    pool: descriptor.pool,
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
    kind: "curve-underlying-get-dy" as const,
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
