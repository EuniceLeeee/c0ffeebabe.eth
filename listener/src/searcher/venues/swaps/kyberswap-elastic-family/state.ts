import { assertSameSource, assertSource, callRequest } from
  "../../protocols/standard-family/common.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
  CanonicalSource,
} from "../../adapter-request-program.js";
import {
  KYSWAP_FEE_UNITS,
  KYSWAP_POOL_INTERFACE,
} from "./abi.js";
import {
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
} from "../../../solver/v3-math.js";
import type { KyberSwapPoolState, KyberSwapTickState } from "./types.js";

export const KYSWAP_STATE_ID = Object.freeze({
  poolState: "kyswap-pool-state",
  liquidityState: "kyswap-liquidity-state",
  feeUnits: "kyswap-swap-fee-units",
  neighbours: "kyswap-initialized-ticks",
});

/**
 * One source-bound round of Elastic pool state. `getPoolState()` and
 * `getLiquidityState()` are the Elastic surfaces (there is no `slot0()` /
 * `liquidity()` on these pools), and `swapFeeUnits()` is the fee.
 */
export function poolStateRequests(pool: string): readonly AdapterRequest[] {
  return Object.freeze([
    callRequest(
      KYSWAP_STATE_ID.poolState,
      pool,
      KYSWAP_POOL_INTERFACE.encodeFunctionData("getPoolState"),
    ),
    callRequest(
      KYSWAP_STATE_ID.liquidityState,
      pool,
      KYSWAP_POOL_INTERFACE.encodeFunctionData("getLiquidityState"),
    ),
    callRequest(
      KYSWAP_STATE_ID.feeUnits,
      pool,
      KYSWAP_POOL_INTERFACE.encodeFunctionData("swapFeeUnits"),
    ),
  ]);
}

/**
 * The pool's initialized-tick linked list neighbours of `tick`. The verified
 * source derives a swap's step target from exactly this relation
 * (`nextTick = nearestCurrentTick`, then `initializedTicks[nextTick].next` when
 * the price moves up), so a quote never guesses a boundary position.
 */
export function neighbourRequests(
  pool: string,
  tick: number,
): readonly AdapterRequest[] {
  if (!Number.isSafeInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error("kyberswap elastic invalid tick for neighbour read");
  }
  return Object.freeze([
    callRequest(
      KYSWAP_STATE_ID.neighbours,
      pool,
      KYSWAP_POOL_INTERFACE.encodeFunctionData("initializedTicks", [tick]),
    ),
  ]);
}

export function decodePoolState(
  results: readonly AdapterRequestResult[],
  options: { readonly neighbours: boolean },
): KyberSwapPoolState {
  const state = result(results, KYSWAP_STATE_ID.poolState);
  const liquidity = result(results, KYSWAP_STATE_ID.liquidityState);
  const fee = result(results, KYSWAP_STATE_ID.feeUnits);
  const used = options.neighbours
    ? [state, liquidity, fee, result(results, KYSWAP_STATE_ID.neighbours)]
    : [state, liquidity, fee];
  assertSameSource(used);
  const poolState = KYSWAP_POOL_INTERFACE.decodeFunctionResult(
    "getPoolState",
    state.data,
  );
  const liquidityState = KYSWAP_POOL_INTERFACE.decodeFunctionResult(
    "getLiquidityState",
    liquidity.data,
  );
  const feeUnits = BigInt(KYSWAP_POOL_INTERFACE.decodeFunctionResult(
    "swapFeeUnits",
    fee.data,
  )[0]);
  const sqrtP = BigInt(poolState[0] as bigint);
  const currentTick = Number(poolState[1]);
  const nearestCurrentTick = Number(poolState[2]);
  const locked = Boolean(poolState[3]);
  const baseL = BigInt(liquidityState[0] as bigint);
  const reinvestL = BigInt(liquidityState[1] as bigint);
  if (
    sqrtP < MIN_SQRT_RATIO ||
    sqrtP >= MAX_SQRT_RATIO ||
    !Number.isSafeInteger(currentTick) ||
    currentTick < MIN_TICK ||
    currentTick > MAX_TICK ||
    !Number.isSafeInteger(nearestCurrentTick) ||
    nearestCurrentTick < MIN_TICK ||
    nearestCurrentTick > currentTick ||
    feeUnits <= 0n ||
    feeUnits >= KYSWAP_FEE_UNITS
  ) {
    throw new Error("kyberswap elastic pool state is not swapable");
  }
  let previousTick: number | null = null;
  let nextTick: number | null = null;
  if (options.neighbours) {
    const neighbours = KYSWAP_POOL_INTERFACE.decodeFunctionResult(
      "initializedTicks",
      result(results, KYSWAP_STATE_ID.neighbours).data,
    );
    previousTick = Number(neighbours[0]);
    nextTick = Number(neighbours[1]);
    if (
      !Number.isSafeInteger(previousTick) ||
      !Number.isSafeInteger(nextTick) ||
      previousTick > nearestCurrentTick ||
      nextTick <= nearestCurrentTick
    ) {
      throw new Error("kyberswap elastic tick list is inconsistent");
    }
  }
  return Object.freeze({
    source: { ...state.source },
    sqrtP,
    currentTick,
    nearestCurrentTick,
    locked,
    baseL,
    reinvestL,
    feeUnits,
    previousTick,
    nextTick,
  });
}

export function stateSource(
  results: readonly AdapterRequestResult[],
): CanonicalSource {
  return { ...result(results, KYSWAP_STATE_ID.poolState).source };
}

/** One crossing's state and linked-list continuation, owned by this Family.
 * IDs bind the actual tick, so additional rounds never repeat a request ID. */
export function crossingRequests(pool: string, tick: number): readonly AdapterRequest[] {
  if (!Number.isSafeInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error("kyberswap elastic invalid crossing tick");
  }
  return Object.freeze([
    callRequest(`kyswap-tick:${tick}`, pool,
      KYSWAP_POOL_INTERFACE.encodeFunctionData("ticks", [tick])),
    callRequest(`kyswap-tick-neighbours:${tick}`, pool,
      KYSWAP_POOL_INTERFACE.encodeFunctionData("initializedTicks", [tick])),
  ]);
}

export function decodeCrossings(results: readonly AdapterRequestResult[], source: CanonicalSource):
  ReadonlyMap<number, KyberSwapTickState> {
  const ticks = new Map<number, KyberSwapTickState>();
  for (const row of results) {
    const match = /^kyswap-tick:(-?\d+)$/.exec(row.id);
    if (!match) continue;
    const tick = Number(match[1]);
    if (!Number.isSafeInteger(tick) || tick < MIN_TICK || tick > MAX_TICK || ticks.has(tick)) {
      throw new Error("kyberswap elastic invalid or duplicate crossing result");
    }
    const data = result(results, row.id);
    const link = result(results, `kyswap-tick-neighbours:${tick}`);
    assertSource(data.source, source);
    assertSource(link.source, source);
    const [gross, net] = KYSWAP_POOL_INTERFACE.decodeFunctionResult("ticks", data.data);
    const [prev, next] = KYSWAP_POOL_INTERFACE.decodeFunctionResult("initializedTicks", link.data);
    const liquidityGross = BigInt(gross), liquidityNet = BigInt(net);
    const previous = Number(prev), nextTick = Number(next);
    if (!Number.isSafeInteger(previous) || !Number.isSafeInteger(nextTick) ||
      previous < MIN_TICK || nextTick > MAX_TICK ||
      (tick === MIN_TICK ? previous !== tick : previous >= tick) ||
      (tick === MAX_TICK ? nextTick !== tick : nextTick <= tick) ||
      liquidityGross < (liquidityNet < 0n ? -liquidityNet : liquidityNet) ||
      (liquidityGross === 0n && tick !== MIN_TICK && tick !== MAX_TICK)) {
      throw new Error("kyberswap elastic crossing state is inconsistent");
    }
    ticks.set(tick, Object.freeze({tick, liquidityGross, liquidityNet, previous, next: nextTick}));
  }
  return ticks;
}

function result(
  results: readonly AdapterRequestResult[],
  id: string,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  const found = results.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`kyberswap elastic request result ${id} is missing`);
  }
  if (!found.ok) {
    throw new Error(
      `kyberswap elastic request result ${id} is unresolved: ${found.failure}`,
    );
  }
  if (found.completion !== "returned") {
    throw new Error(
      `kyberswap elastic request result ${id} did not return normally`,
    );
  }
  return found;
}
