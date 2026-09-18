import { quoteV2ExactInput } from "../../../solver/v2-constant-product-math.js";
import { cachedCanonicalAddress } from "../../../../shared/canonical-address.js";
import {
  localZeroExactMethod,
  type ExactQuoteInput,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import {
  decodeReservesResult,
  requireSuccessfulResult,
  UNIV2_PAIR_INTERFACE,
  UNIV2_TOKEN_INTERFACE,
} from "./codec.js";
import { uniV2InputCapacity } from "./reserve-capacity.js";
import { decodePoolQuote, poolQuoteRequest } from "./pool-quote.js";
import { decodeRouterQuote, routerQuoteRequests, ROUTER_QUOTE_REQUEST_IDS, uniV2QuoteRouter } from "./router-quote.js";
import type {
  UniV2Descriptor,
  UniV2ExactEvidence,
  UniV2ReserveExactEvidence,
  UniV2Route,
} from "./types.js";

const EXACT_RESERVES_REQUEST_ID = "exact-reserves";
const EXACT_INPUT_BALANCE_REQUEST_ID = "exact-input-balance";
type Input = ExactQuoteInput<UniV2Descriptor, UniV2Route>;
type UniV2QuotePreference = "local" | "router";

const createUniV2RequestProgram = (quotePreference: UniV2QuotePreference): ExactRequestProgram<
  UniV2Descriptor,
  UniV2Route,
  UniV2ExactEvidence
> => ({
  requirements: () => ({ transports: ["eth-call"] }),
  buildRequests(input) {
    assertRoute(input.descriptor, input.route);
    if (input.amountIn === 0n) return [];
    if (input.amountIn < 0n) throw new Error("univ2 exact amountIn cannot be negative");
    return [Object.freeze({
      id: EXACT_RESERVES_REQUEST_ID,
      kind: "eth-call" as const,
      to: input.descriptor.pool,
      data: UNIV2_PAIR_INTERFACE.encodeFunctionData("getReserves"),
      completion: "return-data" as const,
    }), Object.freeze({
      id: EXACT_INPUT_BALANCE_REQUEST_ID,
      kind: "eth-call" as const,
      to: input.route.tokenIn,
      data: UNIV2_TOKEN_INTERFACE.encodeFunctionData("balanceOf", [input.descriptor.pool]),
      completion: "return-data" as const,
    }), ...(input.descriptor.quoteModel.kind === "pool-get-amount-out" ? [
      poolQuoteRequest("exact-pool-quote", input.descriptor.pool, input.route.tokenIn, input.amountIn),
    ] : usesRouter(input.descriptor, quotePreference)
      ? routerQuoteRequests(input.descriptor, input.route, input.amountIn) : [])];
  },
  buildDependentProgram: () => null,
  decode({ programInput, initialResults, dependentEvidence }) {
    assertRoute(programInput.descriptor, programInput.route);
    if (programInput.amountIn === 0n) {
      return {
        amountOut: 0n,
        evidence: zeroEvidence(programInput),
      };
    }
    if (programInput.amountIn < 0n) {
      throw new Error("univ2 exact amountIn cannot be negative");
    }
    const state = readInitialState(programInput, initialResults, quotePreference);
    // Zero is an unavailable amount, not a pool blacklist. The solver can
    // still quote a smaller legal input at this same source. Read balanceOf
    // as donations/unsynced transfers also consume uint112 headroom.
    const capacityExceeded = programInput.amountIn > state.maxAmountIn;
    const evidence: UniV2ReserveExactEvidence = Object.freeze({
      ...zeroEvidence(programInput), ...state,
      ...(capacityExceeded ? { unavailableReason: "input-reserve-capacity" as const } : {}),
    });
    if (programInput.descriptor.quoteModel.kind === "pool-get-amount-out") {
      if (dependentEvidence.length !== 0) throw new Error("univ2 unexpected pool-quote round");
      const amountOut = capacityExceeded ? 0n : decodePoolQuote(initialResults, "exact-pool-quote") ?? 0n;
      return Object.freeze({ amountOut, evidence: Object.freeze({ ...evidence, amountOut }) });
    }
    if (usesRouter(programInput.descriptor, quotePreference)) {
      if (dependentEvidence.length !== 0) throw new Error("univ2 unexpected router quote round");
      const quote = decodeRouterQuote(programInput.descriptor, programInput.amountIn,
        quoteV2ExactInput(state.reserveIn, state.reserveOut, programInput.amountIn, programInput.descriptor.feeRule.feeBps),
        initialResults);
      // Capacity is still an independent hard ceiling; a Router quote alone
      // is not an executable-capacity or transfer-eligibility proof.
      if (capacityExceeded) return Object.freeze({ amountOut: 0n, evidence });
      return Object.freeze({ amountOut: quote.amountOut, evidence: Object.freeze({ ...evidence,
        kind: "univ2-router-amounts" as const, quoteModel: "constant-product" as const, ...quote }) });
    }
    if (dependentEvidence.length !== 0) throw new Error("univ2 unexpected local-quote round");
    const amountOut = trialOutput(programInput, state);
    return Object.freeze({ amountOut, evidence: Object.freeze({ ...evidence, amountOut }) });
  },
});

/** Ordinary V2 defaults to source-reserve math; Router parity stays explicitly selectable. */
export function createUniV2Exact(quotePreference: UniV2QuotePreference = "local"): ExactQuoteSemantics<
  UniV2Descriptor,
  UniV2Route,
  UniV2ExactEvidence
> {
  const program = createUniV2RequestProgram(quotePreference);
  return {
    methods: (input) => Object.freeze([
      localZeroExactMethod<UniV2Descriptor, UniV2Route, UniV2ExactEvidence>(
        "local-zero",
        (input) => {
          assertRoute(input.descriptor, input.route);
          return Object.freeze({ amountOut: 0n, evidence: zeroEvidence(input) });
        },
      ),
      Object.freeze({
        id: usesRouter(input.descriptor, quotePreference) ? "router-amounts-out" : "pair-reserves",
        kind: "request-program" as const,
        // Only an actual pool/Router return is a chain amount quote.
        ...(input.descriptor.quoteModel.kind === "pool-get-amount-out" || usesRouter(input.descriptor, quotePreference)
          ? { chainAmountQuote: true as const } : { stateOnlyReads: true as const }),
        program,
      }),
    ]),
    cacheCompatibilityProjection: ({ descriptor, route }) => ({
      quotePreference,
      quoteModel: descriptor.quoteModel,
      pool: descriptor.pool,
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
      feeRule: {
        kind: descriptor.feeRule.kind,
        feeBps: descriptor.feeRule.feeBps,
        evidence: descriptor.feeRule.evidence,
      },
      ...(usesRouter(descriptor, quotePreference) ? {
        quoteRouter: uniV2QuoteRouter(descriptor), quoteSemantics: "router-factory-pair-amounts-v1",
      } : descriptor.quoteModel.kind === "constant-product" ? {
        quoteSemantics: "source-reserves-constant-product-v1",
      } : {}),
    }),
  };
}

export const univ2Exact = createUniV2Exact();

function usesRouter(descriptor: UniV2Descriptor, quotePreference: UniV2QuotePreference): boolean {
  return quotePreference === "router" && uniV2QuoteRouter(descriptor) !== null;
}

function assertResults(results: readonly AdapterRequestResult[], ids: readonly string[], source: CanonicalSource): void {
  if (results.length !== ids.length || new Set(results.map(result => result.id)).size !== ids.length ||
      results.some(result => !ids.includes(result.id))) throw new Error("univ2 missing or ambiguous request results");
  for (const result of results) {
    if (!result.ok) throw new Error(`univ2 request result ${result.id} is unresolved: ${result.failure}`);
    if (result.source.number !== source.number || result.source.hash.toLowerCase() !== source.hash.toLowerCase() ||
        result.source.generation !== source.generation) throw new Error("univ2 exact source mismatch");
  }
}

function readInitialState(input: Input, results: readonly AdapterRequestResult[], quotePreference: UniV2QuotePreference) {
  assertRoute(input.descriptor, input.route);
  if (input.amountIn < 0n) throw new Error("univ2 exact amountIn cannot be negative");
  assertResults(results, [EXACT_RESERVES_REQUEST_ID, EXACT_INPUT_BALANCE_REQUEST_ID,
    ...(input.descriptor.quoteModel.kind === "pool-get-amount-out" ? ["exact-pool-quote"]
      : usesRouter(input.descriptor, quotePreference) ? ROUTER_QUOTE_REQUEST_IDS : [])], input.source);
  const reserves = decodeReservesResult(results, EXACT_RESERVES_REQUEST_ID);
  const balance = requireSuccessfulResult(results, EXACT_INPUT_BALANCE_REQUEST_ID);
  if (!/^0x[0-9a-fA-F]{64}$/.test(balance.data)) throw new Error("univ2 invalid input balance result");
  const inputBalance = BigInt(balance.data);
  const zeroForOne = input.route.direction === "zero-for-one";
  return Object.freeze({ reserveIn: zeroForOne ? reserves.reserve0 : reserves.reserve1,
    reserveOut: zeroForOne ? reserves.reserve1 : reserves.reserve0,
    inputBalance, maxAmountIn: uniV2InputCapacity(inputBalance) });
}

function trialOutput(input: Input, state: ReturnType<typeof readInitialState>): bigint {
  if (input.amountIn > state.maxAmountIn) return 0n;
  const fee = input.descriptor.feeRule;
  if (fee.kind !== "constant-bps" || fee.feeBps < 0n || fee.feeBps >= 10_000n) {
    throw new Error("univ2 invalid constant-product fee rule");
  }
  return quoteV2ExactInput(state.reserveIn, state.reserveOut, input.amountIn, fee.feeBps);
}

function assertRoute(
  descriptor: UniV2Descriptor,
  route: UniV2Route,
): void {
  const zeroForOne = route.direction === "zero-for-one";
  const expectedIn = zeroForOne ? descriptor.token0 : descriptor.token1;
  const expectedOut = zeroForOne ? descriptor.token1 : descriptor.token0;
  if (
    (route.direction !== "zero-for-one" && route.direction !== "one-for-zero") ||
    route.instanceKey !== descriptor.instanceKey ||
    !sameAddress(route.pool, descriptor.pool) ||
    !sameAddress(route.tokenIn, expectedIn) ||
    !sameAddress(route.tokenOut, expectedOut)
  ) {
    throw new Error(`univ2 exact route binding does not match ${descriptor.pool}`);
  }
}

function sameAddress(left: string, right: string): boolean {
  return cachedCanonicalAddress(left) === cachedCanonicalAddress(right);
}

function zeroEvidence(input: {
  readonly descriptor: UniV2Descriptor;
  readonly route: UniV2Route;
  readonly amountIn: bigint;
  readonly source: UniV2ExactEvidence["source"];
}): UniV2ReserveExactEvidence {
  return Object.freeze({
    kind: "univ2-reserves-exact" as const,
    quoteModel: input.descriptor.quoteModel.kind,
    source: input.source,
    pool: input.descriptor.pool,
    tokenIn: input.route.tokenIn,
    tokenOut: input.route.tokenOut,
    amountIn: input.amountIn,
    amountOut: 0n,
    reserveIn: 0n,
    reserveOut: 0n,
    feeBps: input.descriptor.feeRule.feeBps,
  });
}
