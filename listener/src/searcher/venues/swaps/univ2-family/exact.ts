import { quoteV2ExactInput } from "../../../solver/v2-constant-product-math.js";
import { cachedCanonicalAddress } from "../../../../shared/canonical-address.js";
import {
  localZeroExactMethod,
  type ExactQuoteSemantics,
  type ExactRequestProgram,
} from "../../adapter-family-plugin.js";
import {
  decodeReservesResult,
  requireSuccessfulResult,
  UNIV2_PAIR_INTERFACE,
  UNIV2_TOKEN_INTERFACE,
} from "./codec.js";
import { uniV2InputCapacity } from "./reserve-capacity.js";
import { decodePoolQuote, poolQuoteRequest } from "./pool-quote.js";
import type {
  UniV2Descriptor,
  UniV2ExactEvidence,
  UniV2Route,
} from "./types.js";

const EXACT_RESERVES_REQUEST_ID = "exact-reserves";
const EXACT_INPUT_BALANCE_REQUEST_ID = "exact-input-balance";

const univ2RequestProgram: ExactRequestProgram<
  UniV2Descriptor,
  UniV2Route,
  UniV2ExactEvidence
> = {
  requirements: () => ({ transports: ["eth-call"] }),
  buildRequests(input) {
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
    ] : [])];
  },
  decode({ programInput, initialResults }) {
    const results = initialResults;
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
    const reserves = decodeReservesResult(results, EXACT_RESERVES_REQUEST_ID);
    const zeroForOne = programInput.route.direction === "zero-for-one";
    const reserveIn = zeroForOne ? reserves.reserve0 : reserves.reserve1;
    const reserveOut = zeroForOne ? reserves.reserve1 : reserves.reserve0;
    const balanceResult = requireSuccessfulResult(results, EXACT_INPUT_BALANCE_REQUEST_ID);
    const inputBalance = BigInt(UNIV2_TOKEN_INTERFACE.decodeFunctionResult(
      "balanceOf", balanceResult.data,
    )[0]);
    const maxAmountIn = uniV2InputCapacity(inputBalance);
    // Zero is an unavailable amount, not a pool blacklist. The solver can
    // still quote a smaller legal input at this same source. Read balanceOf
    // as donations/unsynced transfers also consume uint112 headroom.
    const capacityExceeded = programInput.amountIn > maxAmountIn;
    const amountOut = capacityExceeded ? 0n : programInput.descriptor.quoteModel.kind === "pool-get-amount-out"
      ? decodePoolQuote(results, "exact-pool-quote") ?? 0n : quoteV2ExactInput(
      reserveIn,
      reserveOut,
      programInput.amountIn,
      programInput.descriptor.feeRule.feeBps,
    );
    return Object.freeze({
      amountOut,
      evidence: Object.freeze({
        kind: "univ2-reserves-exact" as const,
        quoteModel: programInput.descriptor.quoteModel.kind,
        source: reserves.source,
        pool: programInput.descriptor.pool,
        tokenIn: programInput.route.tokenIn,
        tokenOut: programInput.route.tokenOut,
        amountIn: programInput.amountIn,
        amountOut,
        reserveIn,
        reserveOut,
        feeBps: programInput.descriptor.feeRule.feeBps,
        inputBalance,
        maxAmountIn,
        ...(capacityExceeded ? { unavailableReason: "input-reserve-capacity" as const } : {}),
      }),
    });
  },
};

export const univ2Exact = {
  methods: () => Object.freeze([
    localZeroExactMethod<UniV2Descriptor, UniV2Route, UniV2ExactEvidence>(
      "local-zero",
      (input) => {
        assertRoute(input.descriptor, input.route);
        return Object.freeze({ amountOut: 0n, evidence: zeroEvidence(input) });
      },
    ),
    Object.freeze({
      id: "pair-reserves",
      kind: "request-program" as const,
      program: univ2RequestProgram,
    }),
  ]),
  cacheCompatibilityProjection: ({ descriptor, route }) => ({
    quoteModel: descriptor.quoteModel,
    pool: descriptor.pool,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    feeRule: {
      kind: descriptor.feeRule.kind,
      feeBps: descriptor.feeRule.feeBps,
      evidence: descriptor.feeRule.evidence,
    },
  }),
} satisfies ExactQuoteSemantics<
  UniV2Descriptor,
  UniV2Route,
  UniV2ExactEvidence
>;

function assertRoute(
  descriptor: UniV2Descriptor,
  route: UniV2Route,
): void {
  const zeroForOne = route.direction === "zero-for-one";
  const expectedIn = zeroForOne ? descriptor.token0 : descriptor.token1;
  const expectedOut = zeroForOne ? descriptor.token1 : descriptor.token0;
  if (
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
}): UniV2ExactEvidence {
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
