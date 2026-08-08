import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import {
  assertSource,
  decodeDeclaredFluidDexQuote,
  FLUID_DEX_INTERFACE,
  requireSuccessfulResult,
  sameAddress,
} from "./codec.js";
import type {
  FluidDexDescriptor,
  FluidDexExactEvidence,
  FluidDexRoute,
} from "./types.js";

const EXACT_QUOTE_ID = "exact-fluid-dex-declared-revert";

const fluidDexRequestProgram: ExactRequestProgram<
  FluidDexDescriptor,
  FluidDexRoute,
  FluidDexExactEvidence
> = {
  requirements: () => ({
    transports: ["eth-call"],
    effects: ["revert-data"],
  }),
  buildRequests(input) {
    assertInvocation(input.descriptor, input.route);
    if (input.amountIn < 0n) {
      throw new Error("fluid-dex exact amountIn cannot be negative");
    }
    if (input.amountIn === 0n) return [];
    return Object.freeze([Object.freeze({
      id: EXACT_QUOTE_ID,
      kind: "eth-call" as const,
      to: input.descriptor.quoteBinding.target,
      data: FLUID_DEX_INTERFACE.encodeFunctionData("swapIn", [
        input.route.swap0To1,
        input.amountIn,
        0n,
        input.descriptor.quoteBinding.recipient,
      ]),
      completion: "return-or-revert-data" as const,
    })]);
  },
  decode({ programInput, initialResults }) {
    const results = initialResults;
    assertInvocation(programInput.descriptor, programInput.route);
    if (programInput.amountIn === 0n) return zeroQuote(programInput);
    const result = requireSuccessfulResult(results, EXACT_QUOTE_ID);
    assertSource(result.source, programInput.source);
    const amountOut = decodeDeclaredFluidDexQuote(result);
    if (amountOut === null) {
      throw new Error(
        "fluid-dex exact quote lacked the declared FluidDexSwapResult revert",
      );
    }
    return Object.freeze({
      amountOut,
      evidence: exactEvidence(
        programInput,
        amountOut,
        "reverted-as-declared",
      ),
    });
  },
};

export const fluidDexExact = {
  methods: () => Object.freeze([
    localZeroExactMethod<FluidDexDescriptor, FluidDexRoute, FluidDexExactEvidence>(
      "local-zero",
      (input) => {
        assertInvocation(input.descriptor, input.route);
        return zeroQuote(input);
      },
    ),
    Object.freeze({
      id: "declared-revert-quote",
      kind: "request-program" as const,
      program: fluidDexRequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    pool: descriptor.pool,
    token0: descriptor.token0,
    token1: descriptor.token1,
    factoryBinding: {
      factory: descriptor.factoryBinding.factory,
      dexId: descriptor.factoryBinding.dexId,
      reverseDex: descriptor.factoryBinding.reverseDex,
    },
    quoteBinding: {
      target: descriptor.quoteBinding.target,
      recipient: descriptor.quoteBinding.recipient,
      completion: descriptor.quoteBinding.completion,
      successEncoding: descriptor.quoteBinding.successEncoding,
    },
    route: {
      routeKey: route.routeKey,
      swap0To1: route.swap0To1,
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
    },
  }),
} satisfies ExactQuoteSemantics<
  FluidDexDescriptor,
  FluidDexRoute,
  FluidDexExactEvidence
>;

function zeroQuote(input: Parameters<typeof exactEvidence>[0]) {
  return Object.freeze({
    amountOut: 0n,
    evidence: exactEvidence(input, 0n, "local-zero"),
  });
}

function exactEvidence(
  input: {
    readonly descriptor: FluidDexDescriptor;
    readonly route: FluidDexRoute;
    readonly amountIn: bigint;
    readonly source: FluidDexExactEvidence["source"];
  },
  amountOut: bigint,
  completion: FluidDexExactEvidence["completion"],
): FluidDexExactEvidence {
  return Object.freeze({
    kind: "fluid-dex-declared-revert-quote" as const,
    source: input.source,
    pool: input.descriptor.pool,
    routeKey: input.route.routeKey,
    swap0To1: input.route.swap0To1,
    tokenIn: input.route.tokenIn,
    tokenOut: input.route.tokenOut,
    amountIn: input.amountIn,
    amountOut,
    completion,
  });
}

function assertInvocation(
  descriptor: FluidDexDescriptor,
  route: FluidDexRoute,
): void {
  const expectedIn = route.swap0To1 ? descriptor.token0 : descriptor.token1;
  const expectedOut = route.swap0To1 ? descriptor.token1 : descriptor.token0;
  if (
    route.instanceKey !== descriptor.instanceKey ||
    !sameAddress(route.pool, descriptor.pool) ||
    !sameAddress(route.tokenIn, expectedIn) ||
    !sameAddress(route.tokenOut, expectedOut)
  ) {
    throw new Error("fluid-dex exact route does not match descriptor");
  }
}
