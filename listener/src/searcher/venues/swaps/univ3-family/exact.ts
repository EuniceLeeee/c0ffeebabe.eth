import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import {
  UNIV3_POOL_INTERFACE,
  UNIV3_QUOTER_V2_INTERFACE,
  UNIV3_TICK_LENS,
  UNIV3_TICK_LENS_INTERFACE,
} from "../univ3-abi.js";
import {
  V3MissingBitmapWordError,
  v3SwapToState,
  type V3PoolState,
} from "../../../solver/v3-math.js";
import {
  bindRequestResultRound,
  collectRequestProgramResults,
} from "../../adapter-family-plugin.js";
import type { RequestRequirements } from "../../adapter-request-program.js";
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
const LOCAL_SLOT0_REQUEST_ID = "local-slot0";
const LOCAL_LIQUIDITY_REQUEST_ID = "local-liquidity";
const LOCAL_TICK_WORD_PREFIX = "local-tick-word:";

/**
 * Reverse-verified V3 pools with a factory-bound quoter quote through the
 * quoter contract.  Quoter-less fork pools (reverse-verified factories
 * without a known QuoterV2) quote locally: read slot0 + liquidity, warm the
 * current tick word via TickLens, and run the bit-exact local v3 swap math.
 * The local path is the same pricing surface the scanner already trusts for
 * forks (slot0/liquidity mids), and the final revm simulation still gates
 * execution, so a local quote can never bypass the real state.
 */
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
    if (quoter !== null) {
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
    }
    return Object.freeze([
      Object.freeze({
        id: LOCAL_SLOT0_REQUEST_ID,
        kind: "eth-call" as const,
        to: input.descriptor.pool,
        data: UNIV3_POOL_INTERFACE.encodeFunctionData("slot0"),
        completion: "return-data" as const,
      }),
      Object.freeze({
        id: LOCAL_LIQUIDITY_REQUEST_ID,
        kind: "eth-call" as const,
        to: input.descriptor.pool,
        data: UNIV3_POOL_INTERFACE.encodeFunctionData("liquidity"),
        completion: "return-data" as const,
      }),
    ]);
  },
  buildDependentProgram({ programInput, completedRound, initialResults, priorEvidence }) {
    if (completedRound !== 0) return null;
    if (programInput.descriptor.quoterBinding.quoter !== null) return null;
    assertRoute(programInput.descriptor, programInput.route);
    const results = collectRequestProgramResults(initialResults, priorEvidence);
    const slot0Result = requireSuccessfulResult(results, LOCAL_SLOT0_REQUEST_ID);
    assertSource(slot0Result.source, programInput.source);
    const decoded = UNIV3_POOL_INTERFACE.decodeFunctionResult(
      "slot0",
      slot0Result.data,
    );
    const tick = Number(decoded[1]);
    const tickSpacing = programInput.descriptor.tickSpacing;
    const compressed = Math.floor(tick / tickSpacing);
    const currentWord = compressed >> 8;
    const words: number[] = [];
    for (let word = currentWord - 1; word <= currentWord + 1; word++) {
      if (!words.includes(word)) words.push(word);
    }
    const requests = words.map((word) => Object.freeze({
      id: LOCAL_TICK_WORD_PREFIX + word,
      kind: "eth-call" as const,
      to: UNIV3_TICK_LENS,
      data: UNIV3_TICK_LENS_INTERFACE.encodeFunctionData(
        "getPopulatedTicksInWord",
        [programInput.descriptor.pool, word],
      ),
      completion: "return-data" as const,
    }));
    return bindRequestResultRound(
      { transports: ["eth-call"] } satisfies RequestRequirements,
      Object.freeze(requests),
    );
  },
  decode({ programInput, initialResults, dependentEvidence }) {
    assertRoute(programInput.descriptor, programInput.route);
    if (programInput.amountIn <= 0n) return zeroQuote(programInput);
    const quoter = programInput.descriptor.quoterBinding.quoter;
    if (quoter !== null) {
      const results = initialResults;
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
    }
    const results = collectRequestProgramResults(initialResults, dependentEvidence);
    const slot0Result = requireSuccessfulResult(results, LOCAL_SLOT0_REQUEST_ID);
    const liquidityResult = requireSuccessfulResult(results, LOCAL_LIQUIDITY_REQUEST_ID);
    assertSource(slot0Result.source, programInput.source);
    assertSource(liquidityResult.source, programInput.source);
    const slot0 = UNIV3_POOL_INTERFACE.decodeFunctionResult(
      "slot0",
      slot0Result.data,
    );
    const sqrtPriceX96 = BigInt(slot0[0]);
    const tick = Number(slot0[1]);
    const liquidity = BigInt(
      UNIV3_POOL_INTERFACE.decodeFunctionResult(
        "liquidity",
        liquidityResult.data,
      )[0],
    );
    if (sqrtPriceX96 === 0n || liquidity === 0n) {
      return zeroQuote(programInput);
    }
    const tickSpacing = programInput.descriptor.tickSpacing;
    const tickBitmap = new Map<number, bigint>();
    const ticks = new Map<number, bigint>();
    for (const wordResult of results) {
      if (!wordResult.id.startsWith(LOCAL_TICK_WORD_PREFIX)) continue;
      if (!wordResult.ok) continue;
      const word = Number(wordResult.id.slice(LOCAL_TICK_WORD_PREFIX.length));
      const populated = UNIV3_TICK_LENS_INTERFACE.decodeFunctionResult(
        "getPopulatedTicksInWord",
        wordResult.data,
      )[0] as Array<{ tick: bigint; liquidityNet: bigint }>;
      if (!tickBitmap.has(word)) tickBitmap.set(word, 0n);
      for (const entry of populated) {
        const tk = Number(entry.tick);
        ticks.set(tk, BigInt(entry.liquidityNet));
        const compressed = Math.floor(tk / tickSpacing);
        const bitmapWord = compressed >> 8;
        const bit = ((compressed % 256) + 256) % 256;
        tickBitmap.set(
          bitmapWord,
          (tickBitmap.get(bitmapWord) ?? 0n) | (1n << BigInt(bit)),
        );
      }
    }
    const zeroForOne = programInput.route.direction === "zero-for-one";
    const state: V3PoolState = {
      sqrtPriceX96,
      tick,
      liquidity,
      fee: programInput.descriptor.fee,
      tickSpacing,
      tickBitmap,
      ticks,
    };
    let amountOut: bigint;
    try {
      amountOut = v3SwapToState(state, zeroForOne, programInput.amountIn).amountOut;
    } catch (error) {
      if (error instanceof V3MissingBitmapWordError) {
        // The swap crossed beyond the warmed words; report zero rather than
        // failing the probe: a fork pool with deeper tick movement than the
        // local window cannot be quoted safely, and zero keeps it out of the
        // solver (final sim remains the authority for everything admitted).
        return zeroQuote(programInput);
      }
      throw error;
    }
    return Object.freeze({
      amountOut,
      evidence: evidence(programInput, {
        amountOut,
        sqrtPriceX96After: state.sqrtPriceX96,
        initializedTicksCrossed: 0,
        gasEstimate: 0n,
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
