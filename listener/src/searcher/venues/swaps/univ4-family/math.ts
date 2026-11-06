import { ethers } from "ethers";
import type { DeclarativeMathModel, MathValue } from "../../declarative-math.js";
import type { RuntimeMathModel } from "../../declarative-runtime-math.js";
import {
  bigintRatio,
  q96DirectedReserves,
  q96PrecisionProbeAmount,
} from "../blockscan-state-shared.js";
import { v4PoolId } from "../univ4-common.js";
import { poolKeyProjection } from "./codec.js";
import type { V4PoolKey } from "../../../planner/token-graph.js";

/**
 * UniV4 declarative math. Entries are pure integer functions of already-read
 * state; they never read a transport, encode a call or decide admission.
 *
 * The production helpers (`q96DirectedReserves`, `q96PrecisionProbeAmount`,
 * `v4PoolId`) stay the single implementation of the concentrated-liquidity
 * reserve proxies and the PoolKey hash; this module only adapts them to
 * declarative MathValue records. Price ratios stay integer until the common
 * graph-mid boundary. No price may be reconstructed from a fraction of the
 * pool state.
 */
type Data = Readonly<Record<string, any>>;
const MAX_UINT256 = (1n << 256n) - 1n;
const Q96 = 1n << 96n;
const Q192 = Q96 * Q96;
const MAX_UINT128 = (1n << 128n) - 1n;
function record(value: MathValue, label: string): Data {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Map) {
    throw new Error(`univ4 math: ${label} must be a record`);
  }
  return value as Data;
}
function array(value: MathValue, label: string): readonly MathValue[] {
  if (!Array.isArray(value)) throw new Error(`univ4 math: ${label} must be an array`);
  return value;
}
function uint(value: MathValue, label: string): bigint {
  const parsed = typeof value === "bigint" ? value
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? BigInt(value)
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value)
    : null;
  if (parsed === null || parsed < 0n || parsed > MAX_UINT256) {
    throw new Error(`univ4 math: ${label} must be uint256`);
  }
  return parsed;
}
function integer(value: MathValue, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`univ4 math: ${label} must be an integer in [${min}, ${max}]`);
  }
  return value;
}
function address(value: MathValue, label: string): string {
  if (typeof value !== "string") throw new Error(`univ4 math: ${label} must be an address`);
  return ethers.getAddress(value);
}
function lower(value: MathValue, label: string): string {
  return address(value, label).toLowerCase();
}
function direction(value: MathValue): "zero-for-one" | "one-for-zero" {
  if (value !== "zero-for-one" && value !== "one-for-zero") throw new Error("univ4 math: invalid direction");
  return value;
}
function poolKey(value: MathValue): V4PoolKey {
  const input = record(value, "pool key");
  const key = {
    currency0: address(input.currency0, "currency0"),
    currency1: address(input.currency1, "currency1"),
    fee: integer(input.fee, "fee", 0, 0xff_ffff),
    tickSpacing: integer(input.tickSpacing, "tickSpacing", -0x80_0000, 0x7f_ffff),
    hooks: address(input.hooks, "hooks"),
  };
  if (BigInt(key.currency0) >= BigInt(key.currency1)) throw new Error("univ4 math: PoolKey currency order");
  return key;
}

/** `v4PoolId(PoolKey)`. The candidate derives this from the calldata/event
 * PoolKey; identity then re-verifies the same hash on chain. */
export const univ4PoolIdMathModel: DeclarativeMathModel = {
  id: "univ4:pool-id",
  version: 1,
  validateInput(value) { poolKey(value); },
  evaluate(value) { return v4PoolId(poolKey(value)).toLowerCase(); },
  validateOutput(value) {
    if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) throw new Error("univ4 math: pool id output");
  },
};

/** Per-direction precision probe amount, or null when the integer reserve
 * proxies already clear the scanner floor. Mirrors univ4-family/pricing.ts. */
export const univ4PrecisionAmountMathModel: DeclarativeMathModel = {
  id: "univ4:precision-amount",
  version: 1,
  validateInput(value) {
    const input = record(value, "precision input");
    uint(input.sqrtPriceX96, "sqrtPriceX96");
    uint(input.liquidity, "liquidity");
    uint(input.maxAmountIn, "maxAmountIn");
    address(input.token0, "token0");
    address(input.token1, "token1");
    direction(input.direction);
  },
  evaluate(value) {
    const input = record(value, "precision input");
    const amount = q96PrecisionProbeAmount({
      sqrtPriceX96: uint(input.sqrtPriceX96, "sqrtPriceX96"),
      liquidity: uint(input.liquidity, "liquidity"),
      token0: address(input.token0, "token0"),
      token1: address(input.token1, "token1"),
      edge: {
        adapterId: "univ4-unlock",
        instanceKey: "univ4-precision",
        target: address(input.manager, "manager"),
        tokenIn: address(input.tokenIn, "tokenIn"),
        tokenOut: address(input.tokenOut, "tokenOut"),
        slotKind: "swap",
        edgeKind: "swap",
        leavesStandingPosition: false,
      },
      maxAmountIn: uint(input.maxAmountIn, "maxAmountIn"),
    });
    return amount === null ? null : amount;
  },
  validateOutput(value) {
    if (value !== null && (typeof value !== "bigint" || value <= 0n || value > MAX_UINT128)) {
      throw new Error("univ4 math: precision amount output");
    }
  },
};

interface PricingInput {
  readonly snapshot: Data;
  readonly descriptor: Data;
  readonly routes: readonly Data[];
}
function pricingInput(value: MathValue): PricingInput {
  const input = record(value, "pricing input");
  const snapshot = record(input.snapshot, "pricing snapshot");
  uint(snapshot.sqrtPriceX96, "sqrtPriceX96");
  uint(snapshot.liquidity, "liquidity");
  uint(snapshot.lpFee, "lpFee");
  integer(snapshot.tick, "tick", -0x80_0000, 0x7f_ffff);
  const descriptor = record(input.descriptor, "pricing descriptor");
  address(descriptor.managerBinding.manager, "manager");
  poolKey(descriptor.poolKey);
  address(descriptor.graphToken0, "graphToken0");
  address(descriptor.graphToken1, "graphToken1");
  const routes = array(input.routes, "pricing routes");
  return { snapshot, descriptor, routes: routes.map(route => record(route, "pricing route")) };
}

function unavailableReason(snapshot: Data): string | null {
  const parts: string[] = [];
  if (uint(snapshot.sqrtPriceX96, "sqrtPriceX96") === 0n) parts.push("sqrtPriceX96");
  if (uint(snapshot.liquidity, "liquidity") === 0n) parts.push("liquidity");
  return parts.length === 0 ? null : `univ4 pool has zero ${parts.join(" and ")} at the current source`;
}

interface PrecisionOutcome {
  readonly amountOut?: bigint;
  readonly failure?: string;
}
function precisionOutcome(snapshot: Data, requestId: string): PrecisionOutcome | undefined {
  const rows = array(snapshot.precision ?? [], "pricing precision rows");
  for (const row of rows) {
    const entry = record(row, "pricing precision row");
    if (entry.id === requestId) {
      return { ...(entry.amountOut === undefined ? {} : { amountOut: uint(entry.amountOut, "precision amountOut") }),
        ...(entry.failure === undefined ? {} : { failure: String(entry.failure) }) };
    }
  }
  return undefined;
}
function routeRequestId(descriptor: Data, route: Data, amountIn: bigint): string {
  return ["univ4-precision", String(amountIn), String(route.direction)].join(":");
}
function probeAmount(descriptor: Data, snapshot: Data, route: Data): bigint | null {
  return q96PrecisionProbeAmount({
    sqrtPriceX96: uint(snapshot.sqrtPriceX96, "sqrtPriceX96"),
    liquidity: uint(snapshot.liquidity, "liquidity"),
    token0: address(descriptor.graphToken0, "graphToken0"),
    token1: address(descriptor.graphToken1, "graphToken1"),
    edge: {
      adapterId: "univ4-unlock",
      instanceKey: String(route.instanceKey ?? "univ4-pricing"),
      target: address(descriptor.managerBinding.manager, "manager"),
      tokenIn: address(route.tokenIn, "tokenIn"),
      tokenOut: address(route.tokenOut, "tokenOut"),
      slotKind: "swap",
      edgeKind: "swap",
      leavesStandingPosition: false,
    },
    maxAmountIn: MAX_UINT128,
  });
}
function directedReserves(descriptor: Data, snapshot: Data, route: Data) {
  const amountIn = probeAmount(descriptor, snapshot, route);
  if (amountIn === null) {
    // Integer reserve proxies retain scanner precision; no probe is needed.
  } else {
    const outcome = precisionOutcome(snapshot, routeRequestId(descriptor, route, amountIn));
    if (outcome === undefined) throw new Error("univ4 math: precision result missing");
    if (outcome.failure !== undefined || outcome.amountOut === undefined || outcome.amountOut === 0n) return null;
  }
  return q96DirectedReserves({
    sqrtPriceX96: uint(snapshot.sqrtPriceX96, "sqrtPriceX96"),
    liquidity: uint(snapshot.liquidity, "liquidity"),
    token0: address(descriptor.graphToken0, "graphToken0"),
    token1: address(descriptor.graphToken1, "graphToken1"),
    edge: {
      adapterId: "univ4-unlock",
      instanceKey: String(route.instanceKey ?? "univ4-pricing"),
      target: address(descriptor.managerBinding.manager, "manager"),
      tokenIn: address(route.tokenIn, "tokenIn"),
      tokenOut: address(route.tokenOut, "tokenOut"),
      slotKind: "swap",
      edgeKind: "swap",
      leavesStandingPosition: false,
    },
    ...(amountIn === null ? {} : { precisionQuote: { amountIn,
      amountOut: precisionOutcome(snapshot, routeRequestId(descriptor, route, amountIn))!.amountOut! } }),
  });
}

/** Available-route price rows. Ratios stay integer; the common projection
 * boundary performs the only floating-point conversion. `feeBps` is the
 * production lpFee in hundredths of a bip rounded down to whole bps. */
export const univ4PricingMathModel: DeclarativeMathModel = {
  id: "univ4:pricing",
  version: 1,
  validateInput(value) { pricingInput(value); },
  evaluate(value) {
    const { snapshot, descriptor, routes } = pricingInput(value);
    if (unavailableReason(snapshot) !== null) return [];
    const rows: Data[] = [];
    for (const route of routes) {
      const directed = directedReserves(descriptor, snapshot, route);
      if (directed === null) continue;
      const zeroForOne = route.direction === "zero-for-one";
      const numerator = zeroForOne ? uint(snapshot.sqrtPriceX96, "sqrt") ** 2n : Q192;
      const denominator = zeroForOne ? Q192 : uint(snapshot.sqrtPriceX96, "sqrt") ** 2n;
      const mid = bigintRatio(numerator, denominator);
      if (!Number.isFinite(mid) || mid <= 0) throw new Error("univ4 math: nonfinite mid");
      const depth = directed.reserveIn < directed.reserveOut ? directed.reserveIn : directed.reserveOut;
      rows.push({
        routeKey: String(route.routeKey),
        numerator,
        denominator,
        depth,
        reserveA: directed.reserveIn,
        reserveB: directed.reserveOut,
        feeBps: uint(snapshot.lpFee, "lpFee") / 100n,
      });
    }
    return rows;
  },
  validateOutput(value) {
    array(value, "pricing rows");
  },
};

/** Unavailable-route reasons, declared as [routeKey, reason] pairs. Inactive
 * pools mark every direction; otherwise a failed/zero precision probe only
 * removes that direction. */
export const univ4UnavailableMathModel: DeclarativeMathModel = {
  id: "univ4:unavailable",
  version: 1,
  validateInput(value) { pricingInput(value); },
  evaluate(value) {
    const { snapshot, descriptor, routes } = pricingInput(value);
    const inactive = unavailableReason(snapshot);
    const rows: Data[] = [];
    for (const route of routes) {
      const key = String(route.routeKey);
      if (inactive !== null) { rows.push([key, inactive]); continue; }
      const amountIn = probeAmount(descriptor, snapshot, route);
      if (amountIn === null) continue;
      const outcome = precisionOutcome(snapshot, routeRequestId(descriptor, route, amountIn));
      if (outcome === undefined) throw new Error("univ4 math: precision result missing");
      if (outcome.failure !== undefined) {
        rows.push([key, `univ4 direction ${route.tokenIn}->${route.tokenOut} current-source precision witness failed: ${outcome.failure}`]);
      } else if (outcome.amountOut === 0n) {
        rows.push([key, `univ4 direction ${route.tokenIn}->${route.tokenOut} returned zero at its current-source scanner ceiling ${amountIn}`]);
      }
    }
    return rows;
  },
  validateOutput(value) { array(value, "unavailable rows"); },
};

/** Victim exact landed post-state. PoolManager replay is represented by its
 * exact post-state; there is no Family-owned transaction overlay. */
export const univ4VictimExactPostMathModel: DeclarativeMathModel = {
  id: "univ4:victim-exact-post",
  version: 1,
  validateInput(value) {
    const input = record(value, "victim input");
    const impact = record(input.impact, "victim impact");
    const descriptor = record(input.descriptor, "victim descriptor");
    if (impact.pool === undefined || descriptor.poolId === undefined) throw new Error("univ4 math: victim impact scope");
    const post = impact.exactPostState;
    if (post === undefined || post === null) return;
    const state = record(post, "victim post-state");
    uint(state.sqrtPriceX96, "sqrtPriceX96");
    uint(state.liquidity, "liquidity");
    uint(state.lpFee, "lpFee");
    integer(state.tick, "tick", -0x80_0000, 0x7f_ffff);
    if (state.poolId !== undefined && String(state.poolId).toLowerCase() !== String(descriptor.poolId).toLowerCase()) {
      throw new Error("univ4 math: victim post-state poolId mismatch");
    }
  },
  evaluate(value) {
    const input = record(value, "victim input");
    const impact = record(input.impact, "victim impact");
    const descriptor = record(input.descriptor, "victim descriptor");
    const post = impact.exactPostState;
    if (post === undefined || post === null) return null;
    const state = record(post, "victim post-state");
    if (state.poolId !== undefined && String(state.poolId).toLowerCase() !== String(descriptor.poolId).toLowerCase()) {
      return null;
    }
    return {
      kind: "v4",
      poolManager: String(descriptor.managerBinding.manager),
      poolId: String(descriptor.poolId),
      sqrtPriceX96: uint(state.sqrtPriceX96, "sqrtPriceX96"),
      tick: integer(state.tick, "tick", -0x80_0000, 0x7f_ffff),
      liquidity: uint(state.liquidity, "liquidity"),
      lpFee: integer(state.lpFee, "lpFee", 0, 0xff_ffff),
      blockNumber: integer(input.source?.number, "source block", 0, Number.MAX_SAFE_INTEGER),
    };
  },
  validateOutput(value) {
    if (value === null) return;
    const output = record(value, "victim post-state output");
    if (output.kind !== "v4") throw new Error("univ4 math: victim post-state kind");
  },
};

export const univ4MathModels: readonly DeclarativeMathModel[] = [
  univ4PoolIdMathModel,
  univ4PrecisionAmountMathModel,
  univ4PricingMathModel,
  univ4UnavailableMathModel,
  univ4VictimExactPostMathModel,
];

/** Runtime signed negation of the invocation input. The VM negates a
 * nonnegative magnitude below 2^255; the high-word output lets JSON assert
 * the production < 2^127 bound without a hardcoded register. */
export const univ4NegateRuntimeMathModel: RuntimeMathModel = {
  id: "univ4:negate",
  version: 1,
  inputs: ["amount"],
  outputs: ["negative", "high"],
  operations: [
    { name: "high", op: "shr", left: { input: "amount" }, right: { constant: "127" } },
    { name: "negative", op: "neg", left: { input: "amount" }, right: { constant: "0" } },
  ],
};

/** Swap BalanceDelta decode for zeroForOne: amount0 (input debit) is the upper
 * 128-bit word, amount1 (output credit) is the lower one. */
export const univ4DeltaZeroForOneRuntimeMathModel: RuntimeMathModel = {
  id: "univ4:delta-zero-for-one",
  version: 1,
  inputs: ["delta"],
  outputs: ["output", "debt", "outputHigh"],
  operations: [
    { name: "high", op: "shr", left: { input: "delta" }, right: { constant: "128" } },
    { name: "output", op: "and", left: { input: "delta" }, right: { constant: MAX_UINT128.toString() } },
    { name: "debtRaw", op: "and", left: { local: "high" }, right: { constant: MAX_UINT128.toString() } },
    { name: "debtBase", op: "sub", left: { constant: (1n << 128n).toString() }, right: { local: "debtRaw" } },
    { name: "debt", op: "and", left: { local: "debtBase" }, right: { constant: MAX_UINT128.toString() } },
    { name: "outputHigh", op: "shr", left: { local: "output" }, right: { constant: "127" } },
  ],
};

/** Swap BalanceDelta decode for oneForZero: amount1 is the input debit and
 * amount0 the output credit. */
export const univ4DeltaOneForZeroRuntimeMathModel: RuntimeMathModel = {
  id: "univ4:delta-one-for-zero",
  version: 1,
  inputs: ["delta"],
  outputs: ["output", "debt", "outputHigh"],
  operations: [
    { name: "high", op: "shr", left: { input: "delta" }, right: { constant: "128" } },
    { name: "low", op: "and", left: { input: "delta" }, right: { constant: MAX_UINT128.toString() } },
    { name: "output", op: "and", left: { local: "high" }, right: { constant: MAX_UINT128.toString() } },
    { name: "debtBase", op: "sub", left: { constant: (1n << 128n).toString() }, right: { local: "low" } },
    { name: "debt", op: "and", left: { local: "debtBase" }, right: { constant: MAX_UINT128.toString() } },
    { name: "outputHigh", op: "shr", left: { local: "output" }, right: { constant: "127" } },
  ],
};

export const univ4RuntimeMathModels: readonly RuntimeMathModel[] = [
  univ4NegateRuntimeMathModel,
  univ4DeltaZeroForOneRuntimeMathModel,
  univ4DeltaOneForZeroRuntimeMathModel,
];

