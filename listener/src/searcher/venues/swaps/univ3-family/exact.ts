import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import {
  UNIV3_QUOTER_V2_INTERFACE,
} from "../univ3-abi.js";
import {
  canonicalAddress,
  requireSuccessfulResult,
  sameAddress,
} from "./codec.js";
import type {
  UniV3Descriptor,
  UniV3ExactEvidence,
  UniV3Route,
} from "./types.js";

const EXACT_QUOTE_REQUEST_ID = "exact-factory-bound-quote";

const univ3RequestProgram: ExactRequestProgram<
  UniV3Descriptor,
  UniV3Route,
  UniV3ExactEvidence
> = {
  requirements: () => ({ transports: ["eth-call"], caller: "executor" }),
  buildRequests(input) {
    assertRoute(input.descriptor, input.route);
    if (input.amountIn <= 0n) return [];
    const quoter = input.descriptor.quoterBinding.quoter;
    if (quoter === null) {
      throw new Error(
        `univ3 reverse-verified factory ` +
          `${input.descriptor.factoryBinding.factory} has no verified quoter binding`,
      );
    }
    return [Object.freeze({
      id: EXACT_QUOTE_REQUEST_ID,
      kind: "eth-call" as const,
      to: quoter,
      caller: Object.freeze({ kind: "executor" as const }),
      data: UNIV3_QUOTER_V2_INTERFACE.encodeFunctionData(
        "quoteExactInputSingle",
        [{
          tokenIn: input.route.tokenIn,
          tokenOut: input.route.tokenOut,
          amountIn: input.amountIn,
          fee: input.descriptor.fee,
          sqrtPriceLimitX96: 0n,
        }],
      ),
      completion: "return-data" as const,
    })];
  },
  decode({ programInput, initialResults }) {
    const results = initialResults;
    assertRoute(programInput.descriptor, programInput.route);
    if (programInput.amountIn <= 0n) return zeroQuote(programInput);
    const result = requireSuccessfulResult(results, EXACT_QUOTE_REQUEST_ID);
    assertSource(result.source, programInput.source);
    const decoded = UNIV3_QUOTER_V2_INTERFACE.decodeFunctionResult(
      "quoteExactInputSingle",
      result.data,
    );
    const amountOut = BigInt(decoded[0]);
    const initializedTicksCrossed = Number(decoded[2]);
    if (
      !Number.isSafeInteger(initializedTicksCrossed) ||
      initializedTicksCrossed < 0
    ) {
      throw new Error("univ3 exact quote returned invalid initialized tick count");
    }
    return Object.freeze({
      amountOut,
      evidence: evidence(programInput, {
        amountOut,
        sqrtPriceX96After: BigInt(decoded[1]),
        initializedTicksCrossed,
        gasEstimate: BigInt(decoded[3]),
      }),
    });
  },
};

export const univ3Exact = {
  methods: () => Object.freeze([
    localZeroExactMethod<UniV3Descriptor, UniV3Route, UniV3ExactEvidence>(
      "local-zero",
      (input) => {
        assertRoute(input.descriptor, input.route);
        return zeroQuote(input);
      },
    ),
    Object.freeze({
      id: "quoter-v2",
      kind: "request-program" as const,
      program: univ3RequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route, executor }) => ({
    pool: descriptor.pool,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    fee: descriptor.fee,
    factoryBinding: {
      factory: descriptor.factoryBinding.factory,
      reversePool: descriptor.factoryBinding.reversePool,
    },
    quoterBinding: {
      quoter: descriptor.quoterBinding.quoter,
      router: descriptor.quoterBinding.router,
      provenance: descriptor.quoterBinding.provenance,
    },
    caller: canonicalAddress(executor),
  }),
} satisfies ExactQuoteSemantics<
  UniV3Descriptor,
  UniV3Route,
  UniV3ExactEvidence
>;

function zeroQuote(input: Parameters<typeof evidence>[0]) {
  return Object.freeze({
    amountOut: 0n,
    evidence: evidence(input, {
      amountOut: 0n,
      sqrtPriceX96After: 0n,
      initializedTicksCrossed: 0,
      gasEstimate: 0n,
    }),
  });
}

function evidence(
  input: {
    readonly descriptor: UniV3Descriptor;
    readonly route: UniV3Route;
    readonly amountIn: bigint;
    readonly source: UniV3ExactEvidence["source"];
    readonly executor: string;
  },
  quote: {
    readonly amountOut: bigint;
    readonly sqrtPriceX96After: bigint;
    readonly initializedTicksCrossed: number;
    readonly gasEstimate: bigint;
  },
): UniV3ExactEvidence {
  return Object.freeze({
    kind: "univ3-factory-bound-quoter" as const,
    source: input.source,
    pool: input.descriptor.pool,
    quoter: input.descriptor.quoterBinding.quoter,
    caller: canonicalAddress(input.executor),
    tokenIn: input.route.tokenIn,
    tokenOut: input.route.tokenOut,
    fee: input.descriptor.fee,
    amountIn: input.amountIn,
    amountOut: quote.amountOut,
    sqrtPriceX96After: quote.sqrtPriceX96After,
    initializedTicksCrossed: quote.initializedTicksCrossed,
    gasEstimate: quote.gasEstimate,
  });
}

function assertRoute(
  descriptor: UniV3Descriptor,
  route: UniV3Route,
): void {
  const zeroForOne = route.direction === "zero-for-one";
  const expectedIn = zeroForOne ? descriptor.token0 : descriptor.token1;
  const expectedOut = zeroForOne ? descriptor.token1 : descriptor.token0;
  if (
    route.instanceKey !== descriptor.instanceKey ||
    !sameAddress(route.pool, descriptor.pool) ||
    !sameAddress(route.tokenIn, expectedIn) ||
    !sameAddress(route.tokenOut, expectedOut) ||
    route.fee !== descriptor.fee ||
    route.tickSpacing !== descriptor.tickSpacing
  ) {
    throw new Error(`univ3 exact route binding does not match ${descriptor.pool}`);
  }
}

function assertSource(
  actual: UniV3ExactEvidence["source"],
  expected: UniV3ExactEvidence["source"],
): void {
  if (
    actual.number !== expected.number ||
    actual.hash.toLowerCase() !== expected.hash.toLowerCase() ||
    actual.generation !== expected.generation
  ) {
    throw new Error("univ3 exact quote came from a foreign source");
  }
}
