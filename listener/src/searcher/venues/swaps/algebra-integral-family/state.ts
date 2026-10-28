import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { ALGEBRA_POOL_INTERFACE } from "./abi.js";
import {
  canonicalAddress,
  decodeGlobalStateResult,
  decodeInt24Result,
  decodeUint16Result,
  decodeUint128Result,
  requireSuccessfulResult,
  type AlgebraGlobalState,
} from "./codec.js";
import { sqrtRatioAtTick, type AlgebraRangeStep } from "./math.js";
import type { AlgebraIntegralDirection } from "./types.js";

export const ALGEBRA_GLOBAL_STATE_REQUEST_ID = "pool-global-state";
export const ALGEBRA_LIQUIDITY_REQUEST_ID = "pool-liquidity";
export const ALGEBRA_FEE_REQUEST_ID = "pool-fee";
export const ALGEBRA_TICK_SPACING_REQUEST_ID = "pool-tick-spacing";
export const ALGEBRA_NEXT_TICK_REQUEST_ID = "pool-next-tick-global";
export const ALGEBRA_PREV_TICK_REQUEST_ID = "pool-prev-tick-global";

interface PoolCall {
  readonly id: string;
  readonly functionName:
    | "globalState"
    | "liquidity"
    | "fee"
    | "tickSpacing"
    | "nextTickGlobal"
    | "prevTickGlobal";
}

const PRICE_STATE_CALLS: readonly PoolCall[] = Object.freeze([
  Object.freeze({ id: ALGEBRA_GLOBAL_STATE_REQUEST_ID, functionName: "globalState" as const }),
  Object.freeze({ id: ALGEBRA_LIQUIDITY_REQUEST_ID, functionName: "liquidity" as const }),
  Object.freeze({ id: ALGEBRA_FEE_REQUEST_ID, functionName: "fee" as const }),
  Object.freeze({ id: ALGEBRA_TICK_SPACING_REQUEST_ID, functionName: "tickSpacing" as const }),
  Object.freeze({ id: ALGEBRA_NEXT_TICK_REQUEST_ID, functionName: "nextTickGlobal" as const }),
  Object.freeze({ id: ALGEBRA_PREV_TICK_REQUEST_ID, functionName: "prevTickGlobal" as const }),
]);

/** One pinned-block read set; the request transport owns reuse and dedup. */
export function algebraPriceStateRequests(pool: string): readonly AdapterRequest[] {
  return Object.freeze(PRICE_STATE_CALLS.map((call) => Object.freeze({
    id: call.id,
    kind: "eth-call" as const,
    to: canonicalAddress(pool),
    data: ALGEBRA_POOL_INTERFACE.encodeFunctionData(call.functionName),
    completion: "return-data" as const,
  })));
}

export interface AlgebraPriceState {
  readonly source: CanonicalSource;
  readonly globalState: AlgebraGlobalState;
  readonly liquidity: bigint;
  readonly fee: bigint;
  readonly tickSpacing: number;
  readonly nextTickGlobal: number;
  readonly prevTickGlobal: number;
}

/**
 * Every field comes from the same canonical source: a mixed-block read set would
 * silently price one cutoff with another cutoff's liquidity.
 */
export function readAlgebraPriceState(
  results: readonly AdapterRequestResult[],
): AlgebraPriceState {
  const first = requireSuccessfulResult(results, ALGEBRA_GLOBAL_STATE_REQUEST_ID);
  for (const id of [
    ALGEBRA_LIQUIDITY_REQUEST_ID,
    ALGEBRA_FEE_REQUEST_ID,
    ALGEBRA_TICK_SPACING_REQUEST_ID,
    ALGEBRA_NEXT_TICK_REQUEST_ID,
    ALGEBRA_PREV_TICK_REQUEST_ID,
  ]) {
    const other = requireSuccessfulResult(results, id);
    if (
      other.source.number !== first.source.number ||
      other.source.hash.toLowerCase() !== first.source.hash.toLowerCase() ||
      other.source.generation !== first.source.generation
    ) {
      throw new Error("algebra-integral state reads came from different canonical sources");
    }
  }
  return Object.freeze({
    source: first.source,
    globalState: decodeGlobalStateResult(results, ALGEBRA_GLOBAL_STATE_REQUEST_ID),
    liquidity: decodeUint128Result(results, ALGEBRA_LIQUIDITY_REQUEST_ID, "liquidity"),
    fee: decodeUint16Result(results, ALGEBRA_FEE_REQUEST_ID, "fee"),
    tickSpacing: decodeInt24Result(results, ALGEBRA_TICK_SPACING_REQUEST_ID, "tickSpacing", 1),
    nextTickGlobal: decodeInt24Result(results, ALGEBRA_NEXT_TICK_REQUEST_ID, "nextTickGlobal", -887272),
    prevTickGlobal: decodeInt24Result(results, ALGEBRA_PREV_TICK_REQUEST_ID, "prevTickGlobal", -887272),
  });
}

/**
 * The single modelled step: the pool's current price/liquidity plus the price of
 * the initialized tick the swap would have to reach, taken from the pool's OWN
 * `nextTickGlobal`/`prevTickGlobal`. `SwapCalculation._calculateSwap` uses those
 * same two ticks as its first target, so "does this input reach the target" is
 * decided with the pool's rule rather than an assumed tick window.
 */
export function algebraRangeStep(
  state: AlgebraPriceState,
  direction: AlgebraIntegralDirection,
): AlgebraRangeStep {
  const zeroForOne = direction === "zero-for-one";
  const boundTick = zeroForOne ? state.prevTickGlobal : state.nextTickGlobal;
  return Object.freeze({
    sqrtPriceX96: state.globalState.sqrtPriceX96,
    liquidity: state.liquidity,
    fee: state.fee,
    targetSqrtPriceX96: sqrtRatioAtTick(boundTick),
    tickSpacing: state.tickSpacing,
  });
}

export function algebraBoundTick(
  state: Pick<AlgebraPriceState, "nextTickGlobal" | "prevTickGlobal">,
  direction: AlgebraIntegralDirection,
): number {
  return direction === "zero-for-one" ? state.prevTickGlobal : state.nextTickGlobal;
}
