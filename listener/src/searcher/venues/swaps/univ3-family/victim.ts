import type { CanonicalValue } from "../../canonical-value.js";
import type {
  NormalizedSwapVictimImpact,
  VictimReplaySpec,
} from "../../adapter-family-plugin.js";
import type { PoolImpact } from "../../swap-observation.js";
import {
  buildApprovedSwapVictimOverlay,
} from "../../victim-runtime-shared.js";
import {
  v3SwapToState,
  type V3PoolState,
} from "../../../solver/v3-math.js";
import {
  UNIV3_ROUTER_INTERFACE,
} from "../univ3-abi.js";
import { canonicalAddress, sameAddress } from "./codec.js";
import type { UniV3Descriptor, UniV3Route } from "./types.js";

export const univ3VictimReplay = {
  bind({ descriptor, routes, impact }) {
    if (!sameAddress(impact.pool, descriptor.pool)) return null;
    return routes.find((route) =>
      sameAddress(route.tokenIn, impact.tokenIn) &&
      sameAddress(route.tokenOut, impact.tokenOut)
    ) ?? null;
  },
  applyLocal({ descriptor, route, preState, impact, source }) {
    assertImpactBinding(descriptor, route, impact);
    if (impact.amountIn <= 0n) return null;
    const state = decodeFullV3State(preState, descriptor);
    const result = v3SwapToState(
      state,
      route.direction === "zero-for-one",
      impact.amountIn,
    );
    if (result.amountOut <= 0n) return null;
    return Object.freeze({
      amountOut: result.amountOut,
      postImpact: livePostImpact(descriptor.pool, result.state, source.number),
    });
  },
  exactPostState({ descriptor, route, impact, source }) {
    assertImpactBinding(descriptor, route, impact);
    if (impact.exactPostState === undefined) return null;
    const state = canonicalRecord(impact.exactPostState, "exact post-state");
    return Object.freeze({
      kind: "v3",
      pool: descriptor.pool,
      sqrtPriceX96: canonicalBigint(state.sqrtPriceX96, "sqrtPriceX96"),
      tick: canonicalInteger(state.tick, "tick"),
      liquidity: canonicalBigint(state.liquidity, "liquidity"),
      blockNumber: source.number,
    });
  },
  buildOverlay({ descriptor, route, impact }) {
    assertImpactBinding(descriptor, route, impact);
    if (impact.amountIn <= 0n) return null;
    const router = descriptor.quoterBinding.router;
    if (router === null) return null;
    const poolImpact: PoolImpact = {
      pool: descriptor.pool,
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
      amountIn: impact.amountIn,
      matchedAdapterId: "univ3-swap",
    };
    return buildApprovedSwapVictimOverlay({
      impact: poolImpact,
      approveTarget: router,
      swapTarget: router,
      swapCalldata: UNIV3_ROUTER_INTERFACE.encodeFunctionData(
        "exactInputSingle",
        [{
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          fee: descriptor.fee,
          recipient: "0x000000000000000000000000000000000000dEaD",
          amountIn: impact.amountIn,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        }],
      ),
      gasLimit: 0x1000000,
    });
  },
} satisfies VictimReplaySpec<UniV3Descriptor, UniV3Route>;

function assertImpactBinding(
  descriptor: UniV3Descriptor,
  route: UniV3Route,
  impact: NormalizedSwapVictimImpact,
): void {
  if (
    route.instanceKey !== descriptor.instanceKey ||
    !sameAddress(route.pool, descriptor.pool) ||
    !sameAddress(impact.pool, descriptor.pool) ||
    !sameAddress(impact.tokenIn, route.tokenIn) ||
    !sameAddress(impact.tokenOut, route.tokenOut)
  ) {
    throw new Error("univ3 victim impact does not match the bound route");
  }
}

function decodeFullV3State(
  value: CanonicalValue,
  descriptor: UniV3Descriptor,
): V3PoolState {
  const state = canonicalRecord(value, "pre-state");
  if (
    state.pool !== undefined &&
    (typeof state.pool !== "string" || !sameAddress(state.pool, descriptor.pool))
  ) {
    throw new Error("univ3 victim pre-state pool mismatch");
  }
  const fee = canonicalBigint(state.fee, "fee");
  const tickSpacing = canonicalInteger(state.tickSpacing, "tickSpacing");
  if (fee !== descriptor.fee || tickSpacing !== descriptor.tickSpacing) {
    throw new Error("univ3 victim pre-state static binding mismatch");
  }
  return {
    sqrtPriceX96: canonicalBigint(state.sqrtPriceX96, "sqrtPriceX96"),
    tick: canonicalInteger(state.tick, "tick"),
    liquidity: canonicalBigint(state.liquidity, "liquidity"),
    fee,
    tickSpacing,
    tickBitmap: canonicalNumberBigintMap(state.tickBitmap, "tickBitmap"),
    ticks: canonicalNumberBigintMap(state.ticks, "ticks"),
    ...optionalNumber(state, "observationIndex"),
    ...optionalNumber(state, "observationCardinality"),
    ...optionalNumber(state, "observationCardinalityNext"),
    ...optionalNumber(state, "feeProtocol"),
    ...optionalBoolean(state, "unlocked"),
  };
}

function livePostImpact(
  pool: string,
  state: V3PoolState,
  blockNumber: number,
): CanonicalValue {
  return Object.freeze({
    kind: "v3",
    pool: canonicalAddress(pool),
    sqrtPriceX96: state.sqrtPriceX96,
    tick: state.tick,
    liquidity: state.liquidity,
    blockNumber,
    ...(state.observationIndex === undefined
      ? {}
      : { observationIndex: state.observationIndex }),
    ...(state.observationCardinality === undefined
      ? {}
      : { observationCardinality: state.observationCardinality }),
    ...(state.observationCardinalityNext === undefined
      ? {}
      : { observationCardinalityNext: state.observationCardinalityNext }),
    ...(state.feeProtocol === undefined
      ? {}
      : { feeProtocol: state.feeProtocol }),
    ...(state.unlocked === undefined ? {} : { unlocked: state.unlocked }),
  });
}

function canonicalRecord(
  value: CanonicalValue,
  label: string,
): Readonly<Record<string, CanonicalValue>> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`univ3 victim ${label} must be a canonical record`);
  }
  return value as Readonly<Record<string, CanonicalValue>>;
}

function canonicalBigint(value: CanonicalValue | undefined, label: string): bigint {
  if (typeof value !== "bigint") {
    throw new Error(`univ3 victim ${label} must be bigint`);
  }
  return value;
}

function canonicalInteger(value: CanonicalValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`univ3 victim ${label} must be a safe integer`);
  }
  return value;
}

function canonicalNumberBigintMap(
  value: CanonicalValue | undefined,
  label: string,
): Map<number, bigint> {
  if (!Array.isArray(value)) {
    throw new Error(`univ3 victim ${label} must be an entry array`);
  }
  const out = new Map<number, bigint>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error(`univ3 victim ${label} has malformed entry`);
    }
    const key = canonicalInteger(entry[0], `${label} key`);
    const item = canonicalBigint(entry[1], `${label} value`);
    if (out.has(key)) throw new Error(`univ3 victim ${label} has duplicate key`);
    out.set(key, item);
  }
  return out;
}

function optionalNumber(
  state: Readonly<Record<string, CanonicalValue>>,
  key:
    | "observationIndex"
    | "observationCardinality"
    | "observationCardinalityNext"
    | "feeProtocol",
): Partial<Record<typeof key, number>> {
  return state[key] === undefined
    ? {}
    : { [key]: canonicalInteger(state[key], key) } as Record<typeof key, number>;
}

function optionalBoolean(
  state: Readonly<Record<string, CanonicalValue>>,
  key: "unlocked",
): Partial<Record<typeof key, boolean>> {
  if (state[key] === undefined) return {};
  if (typeof state[key] !== "boolean") {
    throw new Error(`univ3 victim ${key} must be boolean`);
  }
  return { [key]: state[key] };
}
