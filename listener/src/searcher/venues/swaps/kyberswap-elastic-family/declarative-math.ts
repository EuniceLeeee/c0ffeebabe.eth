import type { DeclarativeMathModel, MathValue } from "../../declarative-math.js";
import { KYSWAP_FEE_UNITS, KYSWAP_TWO_POW_96 } from "./abi.js";
import {
  quoteExactInput,
  stepTargetTick,
  virtualReserves,
} from "./math.js";
import type {
  KyberSwapPoolState,
  KyberSwapTickState,
} from "./types.js";

/**
 * Pure declarative-Swap math for KyberSwap Elastic. Inputs are already-read
 * pool/tick facts; this module never performs transport, encoding, admission
 * or settlement. It adapts the family's verified integer quote (and raw
 * virtual-reserve mid inputs) to lossless JSON data so the declarative read
 * flow and pricing projection can call the same arithmetic the handwritten
 * production family uses.
 */
type Data = Readonly<Record<string, any>>;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_INT256 = (1n << 255n) - 1n;
const DUMMY_SOURCE = Object.freeze({
  number: 0,
  hash: `0x${"00".repeat(32)}`,
  generation: 0,
});

function record(value: MathValue, label: string): Data {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Map) {
    throw new Error(`kyberswap elastic math: ${label} must be a record`);
  }
  return value as Data;
}

function array(value: MathValue, label: string): readonly MathValue[] {
  if (!Array.isArray(value)) throw new Error(`kyberswap elastic math: ${label} must be an array`);
  return value;
}

function uint(value: MathValue, label: string): bigint {
  const parsed = typeof value === "bigint" ? value
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value)
    : null;
  if (parsed === null || parsed < 0n || parsed > MAX_UINT256) {
    throw new Error(`kyberswap elastic math: ${label} must be uint256`);
  }
  return parsed;
}

function int(value: MathValue, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`kyberswap elastic math: ${label} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function bool(value: MathValue, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`kyberswap elastic math: ${label} must be a boolean`);
  return value;
}

export const KYSWAP_MATH_MIN_TICK = -887_272;
export const KYSWAP_MATH_MAX_TICK = 887_272;

function poolState(value: MathValue): KyberSwapPoolState {
  const state = record(value, "pool state");
  return Object.freeze({
    source: DUMMY_SOURCE,
    sqrtP: uint(state.sqrtP, "sqrtP"),
    currentTick: int(state.currentTick, "currentTick", KYSWAP_MATH_MIN_TICK, KYSWAP_MATH_MAX_TICK),
    nearestCurrentTick: int(state.nearestCurrentTick, "nearestCurrentTick", KYSWAP_MATH_MIN_TICK, KYSWAP_MATH_MAX_TICK),
    locked: bool(state.locked, "locked"),
    baseL: uint(state.baseL, "baseL"),
    reinvestL: uint(state.reinvestL, "reinvestL"),
    feeUnits: uint(state.feeUnits, "feeUnits"),
    previousTick: state.previousTick === null || state.previousTick === undefined
      ? null : int(state.previousTick, "previousTick", KYSWAP_MATH_MIN_TICK, KYSWAP_MATH_MAX_TICK),
    nextTick: state.nextTick === null || state.nextTick === undefined
      ? null : int(state.nextTick, "nextTick", KYSWAP_MATH_MIN_TICK, KYSWAP_MATH_MAX_TICK),
  });
}

function tickState(value: MathValue): KyberSwapTickState {
  const tick = record(value, "tick state");
  if (tick.previous === null || tick.previous === undefined || tick.next === null || tick.next === undefined) {
    throw new Error("kyberswap elastic math: tick neighbours are required");
  }
  const net = typeof tick.liquidityNet === "bigint" ? tick.liquidityNet
    : typeof tick.liquidityNet === "string" && /^-?(0|[1-9][0-9]*)$/.test(tick.liquidityNet)
      ? BigInt(tick.liquidityNet) : null;
  if (net === null || net > MAX_INT256 || net < -MAX_INT256) {
    throw new Error("kyberswap elastic math: liquidityNet must be int128");
  }
  return Object.freeze({
    tick: int(tick.tick, "tick", KYSWAP_MATH_MIN_TICK, KYSWAP_MATH_MAX_TICK),
    liquidityGross: uint(tick.liquidityGross, "liquidityGross"),
    liquidityNet: net,
    previous: int(tick.previous, "previous", KYSWAP_MATH_MIN_TICK, KYSWAP_MATH_MAX_TICK),
    next: int(tick.next, "next", KYSWAP_MATH_MIN_TICK, KYSWAP_MATH_MAX_TICK),
  });
}

function tickMap(value: MathValue): ReadonlyMap<number, KyberSwapTickState> {
  const rows = array(value, "ticks");
  const ticks = new Map<number, KyberSwapTickState>();
  for (const row of rows) {
    const tick = tickState(row);
    if (ticks.has(tick.tick)) throw new Error("kyberswap elastic math: duplicate crossing tick");
    ticks.set(tick.tick, tick);
  }
  return ticks;
}

const quoteProbe: DeclarativeMathModel = {
  id: "kyberswap:quote-probe",
  version: 1,
  validateInput(value) {
    const input = record(value, "quote probe input");
    poolState(input.state);
    bool(input.isToken0, "isToken0");
    uint(input.amountIn, "amountIn");
    tickMap(input.ticks);
  },
  evaluate(value) {
    const input = record(value, "quote probe input");
    const state = poolState(input.state);
    const isToken0 = bool(input.isToken0, "isToken0");
    const amountIn = uint(input.amountIn, "amountIn");
    const ticks = tickMap(input.ticks);
    const liquidity = state.baseL + state.reinvestL;
    const outcome = quoteExactInput({ state, isToken0, amountIn, ticks });
    if (outcome.ok) {
      return Object.freeze({
        ok: true,
        refusal: null,
        missingTick: null,
        unavailableReason: null,
        amountOut: outcome.quote.amountOut,
        sqrtPBefore: state.sqrtP,
        sqrtPAfter: outcome.quote.sqrtPAfter,
        liquidity,
        deltaL: outcome.quote.deltaL,
        targetTick: outcome.quote.targetTick,
        steps: outcome.quote.steps,
        crossedTicks: Object.freeze([...outcome.quote.crossedTicks]),
      });
    }
    return Object.freeze({
      ok: false,
      refusal: outcome.refusal,
      missingTick: outcome.missingTick ?? null,
      unavailableReason: outcome.missingTick === undefined ? outcome.refusal : "crossing-state-unavailable",
      amountOut: 0n,
      sqrtPBefore: state.sqrtP,
      sqrtPAfter: state.sqrtP,
      liquidity,
      deltaL: 0n,
      targetTick: stepTargetTick(state, isToken0),
      steps: 0,
      crossedTicks: Object.freeze([]),
    });
  },
  validateOutput(value) {
    const output = record(value, "quote probe output");
    if (typeof output.ok !== "boolean" || typeof output.refusal !== "string" && output.refusal !== null) {
      throw new Error("kyberswap elastic math: invalid quote probe outcome");
    }
    if (output.missingTick !== null && (typeof output.missingTick !== "number" || !Number.isSafeInteger(output.missingTick))) {
      throw new Error("kyberswap elastic math: invalid missing tick");
    }
    if (output.unavailableReason !== null && (typeof output.unavailableReason !== "string" || !output.unavailableReason)) {
      throw new Error("kyberswap elastic math: invalid unavailable reason");
    }
    for (const key of ["amountOut", "sqrtPBefore", "sqrtPAfter", "liquidity", "deltaL"] as const) {
      uint(output[key], key);
    }
    if (output.targetTick !== null && (typeof output.targetTick !== "number" || !Number.isSafeInteger(output.targetTick))) {
      throw new Error("kyberswap elastic math: invalid target tick");
    }
    if (typeof output.steps !== "number" || !Number.isSafeInteger(output.steps) || output.steps < 0) {
      throw new Error("kyberswap elastic math: invalid step count");
    }
    for (const tick of array(output.crossedTicks, "crossedTicks")) {
      int(tick, "crossedTick", KYSWAP_MATH_MIN_TICK, KYSWAP_MATH_MAX_TICK);
    }
    if (output.ok && (output.amountOut === 0n || output.refusal !== null)) {
      throw new Error("kyberswap elastic math: successful probe requires positive output");
    }
    if (!output.ok && (output.amountOut !== 0n || typeof output.refusal !== "string")) {
      throw new Error("kyberswap elastic math: refused probe requires a reason");
    }
  },
};

const pricingState: DeclarativeMathModel = {
  id: "kyberswap:pricing-state",
  version: 1,
  validateInput(value) {
    const input = record(value, "pricing input");
    poolState(input.state);
    bool(input.isToken0, "isToken0");
  },
  evaluate(value) {
    const input = record(value, "pricing input");
    const state = poolState(input.state);
    const isToken0 = bool(input.isToken0, "isToken0");
    const reserves = virtualReserves(state);
    const locked = state.locked;
    const noLiquidity = state.baseL + state.reinvestL <= 0n;
    const reason = locked ? "kyberswap_elastic_pool_locked"
      : noLiquidity ? "kyberswap_elastic_no_active_liquidity"
      : reserves.token0 <= 0n || reserves.token1 <= 0n
        ? "kyberswap_elastic_raw_depth_below_one_unit" : null;
    const square = state.sqrtP * state.sqrtP;
    const q192 = KYSWAP_TWO_POW_96 * KYSWAP_TWO_POW_96;
    const netFee = KYSWAP_FEE_UNITS - state.feeUnits;
    const reserveIn = isToken0 ? reserves.token0 : reserves.token1;
    const reserveOut = isToken0 ? reserves.token1 : reserves.token0;
    return Object.freeze({
      unavailableReason: reason,
      numerator: (isToken0 ? square : q192) * netFee,
      denominator: (isToken0 ? q192 : square) * KYSWAP_FEE_UNITS,
      reserveA: reserveIn,
      reserveB: reserveOut,
      depth: reserveIn < reserveOut ? reserveIn : reserveOut,
      feeBps: 0n,
    });
  },
  validateOutput(value) {
    const output = record(value, "pricing output");
    if (output.unavailableReason !== null && (typeof output.unavailableReason !== "string" || !output.unavailableReason)) {
      throw new Error("kyberswap elastic math: invalid pricing unavailability");
    }
    for (const key of ["numerator", "denominator", "reserveA", "reserveB", "depth", "feeBps"] as const) {
      uint(output[key], key);
    }
    if (output.numerator === 0n || output.denominator === 0n) {
      throw new Error("kyberswap elastic math: zero pricing ratio");
    }
    if (output.unavailableReason === null && output.depth === 0n) {
      throw new Error("kyberswap elastic math: available pricing requires depth");
    }
  },
};

export const kyberswapElasticMathModels: readonly DeclarativeMathModel[] = Object.freeze([
  quoteProbe,
  pricingState,
]);
