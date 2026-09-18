import {
  localZeroExactMethod,
  bindRequestResultRound,
  collectRequestProgramResults,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import {
  UNIV3_QUOTER_V2_INTERFACE,
} from "../univ3-abi.js";
import {
  V3MissingBitmapWordError,
  MIN_SQRT_RATIO,
  MAX_SQRT_RATIO,
  v3SwapToState,
} from "../../../solver/v3-math.js";
import { resolveUniV3StateReader, UNIV3_STATE_WORD_RADIUS, readUniV3State, uniV3StateRequestData } from "./state-reader.js";
import { tickLensStateRequests, tickLensDependentProgram, readTickLensState } from "./tick-lens-state.js";
import { assertUniV3SwapAccess, uniV3SwapAccessRequest } from "./swap-access.js";
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
const LOCAL_STATE_REQUEST_ID = "local-pool-state";
type QuoteMode = "local" | "quoter";

/**
 * One aggregated state read supplies 49 source-bound bitmap words. The existing
 * request transport owns deduplication and reuse; the Family owns only reads,
 * decoding and swap math. The factory-bound Quoter remains an explicit option.
 * Neither quote mode proves transfer eligibility; mandatory final sim remains.
 */
function requestProgram(mode: QuoteMode): ExactRequestProgram<
  UniV3Descriptor,
  UniV3Route,
  UniV3ExactEvidence
> {
  const quoteThroughChain = (input: { readonly descriptor: UniV3Descriptor }) =>
    mode === "quoter" && input.descriptor.quoterBinding.quoter !== null;
  return {
    requirements: (input) => !quoteThroughChain(input)
      ? ({ transports: ["eth-call"] })
      : ({ transports: ["eth-call"], caller: "executor" }),
    buildRequests(input) {
      assertRoute(input.descriptor, input.route);
      if (input.amountIn <= 0n) return [];
      const quoter = input.descriptor.quoterBinding.quoter;
      if (quoteThroughChain(input)) {
        return [Object.freeze({
          id: EXACT_QUOTE_REQUEST_ID,
          kind: "eth-call" as const,
          to: quoter!,
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
      const reader = resolveUniV3StateReader(input.descriptor);
      if (reader === null) return tickLensStateRequests(input.descriptor);
      return Object.freeze([
        Object.freeze({
          id: LOCAL_STATE_REQUEST_ID,
          kind: "eth-call" as const,
          to: reader.address,
          data: uniV3StateRequestData(input.descriptor),
          completion: "return-data" as const,
        }),
      ]);
    },
    buildDependentProgram(input) {
      if (input.programInput.amountIn <= 0n) return null;
      const results = collectRequestProgramResults(input.initialResults, input.priorEvidence);
      const access = uniV3SwapAccessRequest(input.programInput);
      // Keep authorization in its own round: its source-bound id cannot make
      // the unchanged tick rounds miss their existing cross-block state cache.
      if (access && !results.some(result => result.id === access.id)) {
        return bindRequestResultRound({ transports: ["eth-call"] }, [access]);
      }
      assertUniV3SwapAccess(input.programInput, results);
      if (quoteThroughChain(input.programInput) || resolveUniV3StateReader(input.programInput.descriptor) !== null) return null;
      return tickLensDependentProgram({ ...input, completedRound: input.completedRound - (access ? 1 : 0) });
    },
    decode(input) {
      const { programInput, initialResults } = input;
      assertRoute(programInput.descriptor, programInput.route);
      if (programInput.amountIn <= 0n) return zeroQuote(programInput);
      assertUniV3SwapAccess(programInput, collectRequestProgramResults(initialResults, input.dependentEvidence));
      if (quoteThroughChain(programInput)) {
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
      const state = resolveUniV3StateReader(programInput.descriptor) === null ? readTickLensState(input) : (() => {
        if (initialResults.length !== 1) throw new Error("univ3 incomplete or duplicate pool state result");
        const result = requireSuccessfulResult(initialResults, LOCAL_STATE_REQUEST_ID);
        assertSource(result.source, programInput.source);
        return readUniV3State(result.data, programInput.descriptor);
      })();
      const { tick, ticks } = state;
      if (state.sqrtPriceX96 === 0n) {
        return zeroQuote(programInput);
      }
      const zeroForOne = programInput.route.direction === "zero-for-one";
      let swap: ReturnType<typeof v3SwapToState>;
      try {
        swap = v3SwapToState(state, zeroForOne, programInput.amountIn);
      } catch (error) {
        if (error instanceof V3MissingBitmapWordError) {
          // This amount exceeded the known window, not proof of zero liquidity.
          // Never publish a point-price or partial-fill substitute.
          return zeroQuote(programInput, "univ3-local-ticks");
        }
        throw error;
      }
      if (swap.state.sqrtPriceX96 === MIN_SQRT_RATIO + 1n || swap.state.sqrtPriceX96 === MAX_SQRT_RATIO - 1n) {
        return zeroQuote(programInput, "univ3-local-ticks");
      }
      const initializedTicksCrossed = [...ticks.keys()].filter(tk => zeroForOne
        ? tk <= tick && tk > swap.state.tick : tk > tick && tk <= swap.state.tick).length;
      return Object.freeze({
        amountOut: swap.amountOut,
        evidence: evidence(programInput, {
          amountOut: swap.amountOut,
          sqrtPriceX96After: swap.state.sqrtPriceX96,
          initializedTicksCrossed,
          gasEstimate: 0n,
        }, "univ3-local-ticks"),
      });
    },
  };
}

// Family-owned selection: effective/Exact/Solver keep the same central entry.
export function createUniV3Exact(mode: QuoteMode = "local") {
  const program = requestProgram(mode);
  return {
    methods: (input) => Object.freeze([
      localZeroExactMethod<UniV3Descriptor, UniV3Route, UniV3ExactEvidence>(
        "local-zero",
        (input) => {
          assertRoute(input.descriptor, input.route);
          return zeroQuote(input);
        },
      ),
      Object.freeze({
        id: mode === "quoter" && input.descriptor.quoterBinding.quoter !== null ? "quoter-v2" :
          resolveUniV3StateReader(input.descriptor) === null ? "local-ticks-49" : "local-state-49",
        kind: "request-program" as const,
        ...(mode !== "quoter" || input.descriptor.quoterBinding.quoter === null
          ? { stateOnlyReads: true as const } : { chainAmountQuote: true as const }),
        program,
      }),
    ]),
    cacheCompatibilityProjection: ({ descriptor, route, executor }) => ({
      pool: descriptor.pool,
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
      fee: descriptor.fee,
      quoteMode: mode,
      tickWordRadius: UNIV3_STATE_WORD_RADIUS,
      stateReader: resolveUniV3StateReader(descriptor)?.address ?? null,
      swapAccess: { ...descriptor.swapAccess },
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
}

export const univ3Exact = createUniV3Exact();

function zeroQuote(input: Parameters<typeof evidence>[0], kind: UniV3ExactEvidence["kind"] = "univ3-factory-bound-quoter") {
  return Object.freeze({
    amountOut: 0n,
    evidence: evidence(input, {
      amountOut: 0n,
      sqrtPriceX96After: 0n,
      initializedTicksCrossed: 0,
      gasEstimate: 0n,
    }, kind),
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
  kind: UniV3ExactEvidence["kind"] = "univ3-factory-bound-quoter",
): UniV3ExactEvidence {
  return Object.freeze({
    kind,
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
    (route.direction !== "zero-for-one" && route.direction !== "one-for-zero") ||
    descriptor.fee < 0n || descriptor.fee >= 1_000_000n ||
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
