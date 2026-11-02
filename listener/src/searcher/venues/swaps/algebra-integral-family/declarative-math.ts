import { ethers } from "ethers";
import type { DeclarativeMathModel, MathValue } from "../../declarative-math.js";
import { ALGEBRA_BOUND_QUOTER, ALGEBRA_POOL_INIT_CODE_HASH, ALGEBRA_QUOTER_CODE_HASH, bindCypherPluginCode } from "./quoter-model.js";
import { quoteAlgebraExactInput, sqrtRatioAtTick } from "./math.js";
import { ALGEBRA_FEE_DENOMINATOR, ALGEBRA_MAX_SQRT_RATIO, ALGEBRA_MIN_SQRT_RATIO, ALGEBRA_PLUGIN_DYNAMIC_FEE_FLAG } from "./abi.js";

/**
 * Pure declarative-Swap adapters for Algebra Integral. Inputs are already-read
 * chain facts; these models never perform transport, encode a call or decide
 * admission. The integer quote, tick math and Quoter/plugin code binding
 * delegate to the verified handwritten family functions so the JSON and the
 * retained TS entry cannot drift into two different implementations.
 */
type Data = Readonly<Record<string, any>>;
const MAX_UINT256 = (1n << 256n) - 1n;
const Q96 = 1n << 96n;
const Q192 = Q96 * Q96;
const MIN_VENUE_RESERVE_IN = 36n;

function record(value: MathValue, label: string): Data {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Map) {
    throw new Error(`algebra-integral math: ${label} must be a record`);
  }
  return value as Data;
}
function array(value: MathValue, label: string): readonly MathValue[] {
  if (!Array.isArray(value)) throw new Error(`algebra-integral math: ${label} must be an array`);
  return value;
}
function uint(value: MathValue, label: string): bigint {
  const parsed = typeof value === "bigint" ? value
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value)
    : null;
  if (parsed === null || parsed < 0n || parsed > MAX_UINT256) throw new Error(`algebra-integral math: ${label} must be uint256`);
  return parsed;
}
function signed(value: MathValue, label: string): bigint {
  const parsed = typeof value === "bigint" ? value
    : typeof value === "string" && /^-?(0|[1-9][0-9]*)$/.test(value) ? BigInt(value)
    : null;
  if (parsed === null || parsed < -(1n << 255n) || parsed >= (1n << 255n)) throw new Error(`algebra-integral math: ${label} must be int256`);
  return parsed;
}
function int24(value: MathValue, label: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > 8388607) {
    throw new Error(`algebra-integral math: ${label} must be an int24 in [${min}, 8388607]`);
  }
  return value;
}
function bool(value: MathValue, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`algebra-integral math: ${label} must be a boolean`);
  return value;
}
function text(value: MathValue, label: string): string {
  if (typeof value !== "string") throw new Error(`algebra-integral math: ${label} must be a string`);
  return value;
}
function addr(value: MathValue, label: string): string {
  try { return ethers.getAddress(text(value, label)); }
  catch { throw new Error(`algebra-integral math: ${label} must be an address`); }
}
function hex(value: MathValue, label: string): string {
  const encoded = text(value, label);
  if (!ethers.isHexString(encoded)) throw new Error(`algebra-integral math: ${label} must be hex data`);
  return encoded;
}
function kind(value: MathValue): "global-state-last-fee" | "cypher-bound-quoter" {
  if (value !== "global-state-last-fee" && value !== "cypher-bound-quoter") {
    throw new Error("algebra-integral math: invalid executed-fee kind");
  }
  return value;
}
function direction(value: MathValue): "zero-for-one" | "one-for-zero" {
  if (value !== "zero-for-one" && value !== "one-for-zero") throw new Error("algebra-integral math: invalid direction");
  return value;
}
function canonicalSource(value: MathValue) {
  const source = record(value, "source");
  if (!Number.isSafeInteger(source.number) || source.number < 0 || !Number.isSafeInteger(source.generation) ||
      source.generation < 0 || typeof source.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(source.hash)) {
    throw new Error("algebra-integral math: invalid canonical source");
  }
  return Object.freeze({ number: source.number, hash: source.hash.toLowerCase(), generation: source.generation });
}

/** Same CREATE2/immutable-word proof as the handwritten Quoter binding. */
const quoterBinding: DeclarativeMathModel = {
  id: "algebra-integral:quoter-binding",
  version: 1,
  validateInput(value) {
    const input = record(value, "quoter binding input");
    for (const key of ["pool", "factory", "token0", "token1", "quoterFactory", "quoterPoolDeployer", "factoryPoolDeployer"]) addr(input[key], key);
    hex(input.quoterCode, "quoterCode"); hex(input.pluginCode, "pluginCode");
  },
  evaluate(value) {
    const input = record(value, "quoter binding input");
    const pool = addr(input.pool, "pool"), factory = addr(input.factory, "factory");
    if (ethers.keccak256(hex(input.quoterCode, "quoterCode")) !== ALGEBRA_QUOTER_CODE_HASH) return null;
    const quoterFactory = addr(input.quoterFactory, "quoterFactory");
    const poolDeployer = addr(input.quoterPoolDeployer, "quoterPoolDeployer");
    if (ethers.getAddress(factory) !== quoterFactory ||
        poolDeployer !== addr(input.factoryPoolDeployer, "factoryPoolDeployer")) return null;
    const sorted = [addr(input.token0, "token0"), addr(input.token1, "token1")]
      .sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1);
    const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], sorted));
    if (ethers.getCreate2Address(poolDeployer, salt, ALGEBRA_POOL_INIT_CODE_HASH) !== ethers.getAddress(pool)) return null;
    const pluginCode = hex(input.pluginCode, "pluginCode");
    const pluginFactory = bindCypherPluginCode(pluginCode, pool, factory);
    if (pluginFactory === null) return null;
    return Object.freeze({ quoter: ALGEBRA_BOUND_QUOTER, quoterCodeHash: ALGEBRA_QUOTER_CODE_HASH,
      poolDeployer, pluginCodeHash: ethers.keccak256(pluginCode), pluginFactory });
  },
  validateOutput(value) {
    if (value === null) return;
    const binding = record(value, "quoter binding output");
    if (typeof binding.quoter !== "string" || typeof binding.quoterCodeHash !== "string" ||
        typeof binding.poolDeployer !== "string" || typeof binding.pluginCodeHash !== "string" ||
        typeof binding.pluginFactory !== "string") throw new Error("algebra-integral math: invalid quoter binding output");
  },
};

function state(value: MathValue) {
  const raw = record(value, "pool state");
  return {
    sqrtPriceX96: uint(raw.sqrtPriceX96, "sqrtPriceX96"),
    tick: int24(raw.tick, "tick", -887272),
    lastFee: uint(raw.lastFee, "lastFee"),
    pluginConfig: int24(raw.pluginConfig, "pluginConfig", 0),
    communityFee: int24(raw.communityFee, "communityFee", 0),
    unlocked: bool(raw.unlocked, "unlocked"),
  };
}

function snapshotInput(value: MathValue) {
  const input = record(value, "snapshot input");
  const globalState = state(input.globalState);
  if (globalState.pluginConfig > 255 || globalState.communityFee > 65535) throw new Error("algebra-integral math: uint8/uint16 field range");
  return {
    source: canonicalSource(input.source),
    globalState,
    liquidity: uint(input.liquidity, "liquidity"),
    feeView: uint(input.feeView, "feeView"),
    tickSpacing: int24(input.tickSpacing, "tickSpacing", 1),
    nextTickGlobal: int24(input.nextTickGlobal, "nextTickGlobal", -887272),
    prevTickGlobal: int24(input.prevTickGlobal, "prevTickGlobal", -887272),
    admittedTickSpacing: int24(input.admittedTickSpacing, "admittedTickSpacing", 1),
    executedFeeKind: kind(input.executedFeeKind),
  };
}

/** Decoded pricing snapshot; identical fields and inactive classification as
 * the handwritten `decodeSnapshot`. */
const snapshot: DeclarativeMathModel = {
  id: "algebra-integral:snapshot",
  version: 1,
  validateInput(value) { snapshotInput(value); },
  evaluate(value) {
    const input = snapshotInput(value);
    const s = input.globalState;
    const dynamic = input.executedFeeKind === "cypher-bound-quoter";
    const unsupported: string[] = [];
    if (!dynamic && (s.pluginConfig & ALGEBRA_PLUGIN_DYNAMIC_FEE_FLAG) !== 0) unsupported.push("plugin-config dynamic-fee bit is set");
    if (!dynamic && input.feeView !== s.lastFee) unsupported.push(`fee() ${input.feeView} differs from globalState.lastFee ${s.lastFee}`);
    if (input.tickSpacing !== input.admittedTickSpacing) unsupported.push(`tickSpacing ${input.tickSpacing} differs from the admitted ${input.admittedTickSpacing}`);
    const inactive = [...unsupported];
    if (s.sqrtPriceX96 === 0n) inactive.push("sqrtPriceX96");
    if (input.liquidity === 0n) inactive.push("liquidity");
    if (!s.unlocked) inactive.push("pool is mid-swap (locked)");
    return Object.freeze({
      source: input.source,
      sqrtPriceX96: s.sqrtPriceX96,
      tick: s.tick,
      lastFee: s.lastFee,
      executedFee: dynamic ? null : input.feeView,
      rawFeeView: input.feeView,
      pluginConfig: s.pluginConfig,
      communityFee: s.communityFee,
      unlocked: s.unlocked,
      liquidity: input.liquidity,
      tickSpacing: input.tickSpacing,
      nextTickGlobal: input.nextTickGlobal,
      prevTickGlobal: input.prevTickGlobal,
      inactiveReason: inactive.length === 0 ? null
        : unsupported.length === 0 ? `algebra-integral pool has zero ${inactive.join(" and ")} at the current source`
          : `algebra-integral pool is not the supported variant: ${unsupported.join("; ")}`,
    });
  },
  validateOutput(value) {
    const output = record(value, "snapshot output");
    if (output.executedFee !== null && typeof output.executedFee !== "bigint") throw new Error("algebra-integral math: invalid snapshot fee");
    if (output.inactiveReason !== null && typeof output.inactiveReason !== "string") throw new Error("algebra-integral math: invalid snapshot reason");
    canonicalSource(output.source);
  },
};

function quoteInput(value: MathValue) {
  const input = record(value, "quote input");
  const globalState = state(input.globalState);
  return { ...snapshotInput({ ...input, source: input.source }), globalState,
    direction: direction(input.direction), amountIn: uint(input.amountIn, "amountIn") };
}

/** Single in-range step with the source-bound executed fee; declines instead of
 * extrapolating across an unread tick tree. Evidence fields match the retained
 * handwriting so execution no longer needs a second protocol quote. */
const quote: DeclarativeMathModel = {
  id: "algebra-integral:quote",
  version: 1,
  validateInput(value) { quoteInput(value); },
  evaluate(value) {
    const input = quoteInput(value);
    const s = input.globalState;
    const zeroForOne = input.direction === "zero-for-one";
    const boundTick = zeroForOne ? input.prevTickGlobal : input.nextTickGlobal;
    const declined = (reason: string) => Object.freeze({
      amountOut: 0n, sqrtPriceX96Before: s.sqrtPriceX96, sqrtPriceX96After: 0n,
      executedFee: input.feeView, pluginConfig: s.pluginConfig,
      rangeBoundTick: boundTick, rangeBoundSqrtPriceX96: sqrtRatioAtTick(boundTick),
      declinedReason: reason, unavailableReason: reason,
    });
    if ((s.pluginConfig & ALGEBRA_PLUGIN_DYNAMIC_FEE_FLAG) !== 0) return declined("pool is plugin-dynamic-fee controlled; the executed fee is not state-readable");
    if (input.feeView !== s.lastFee) return declined(`fee() ${input.feeView} differs from globalState.lastFee ${s.lastFee}`);
    const result = quoteAlgebraExactInput({
      sqrtPriceX96: s.sqrtPriceX96,
      liquidity: input.liquidity,
      fee: input.feeView,
      targetSqrtPriceX96: sqrtRatioAtTick(boundTick),
      tickSpacing: input.tickSpacing,
    }, zeroForOne, input.amountIn);
    if (result.status === "declined") return declined(result.reason);
    return Object.freeze({
      amountOut: result.amountOut, sqrtPriceX96Before: s.sqrtPriceX96,
      sqrtPriceX96After: result.sqrtPriceX96After, executedFee: input.feeView,
      pluginConfig: s.pluginConfig, rangeBoundTick: boundTick,
      rangeBoundSqrtPriceX96: sqrtRatioAtTick(boundTick), declinedReason: null,
    });
  },
  validateOutput(value) {
    const output = record(value, "quote output");
    if (typeof output.amountOut !== "bigint" || output.amountOut < 0n) throw new Error("algebra-integral math: invalid quote output");
    if (output.declinedReason !== null && typeof output.declinedReason !== "string") throw new Error("algebra-integral math: invalid decline");
  },
};

/** Integer pricing rows; the common projection turns the ratio into the graph
 * mid exactly (both endpoints stay finite at Algebra's price scale). */
const rows: DeclarativeMathModel = {
  id: "algebra-integral:rows",
  version: 1,
  validateInput(value) {
    const input = record(value, "rows input");
    const s = record(input.snapshot, "snapshot");
    if (s.inactiveReason !== null) { array(input.routes, "routes"); return; }
    for (const key of ["sqrtPriceX96", "liquidity", "rawFeeView"]) uint(s[key], key);
    addr(s.token0, "token0"); addr(s.token1, "token1");
    array(input.routes, "routes");
  },
  evaluate(value) {
    const input = record(value, "rows input");
    const s = record(input.snapshot, "snapshot");
    if (s.inactiveReason !== null) return [];
    const sqrtPriceX96 = uint(s.sqrtPriceX96, "sqrtPriceX96"), liquidity = uint(s.liquidity, "liquidity");
    const rawFeeView = uint(s.rawFeeView, "rawFeeView"), token0 = addr(s.token0, "token0"), token1 = addr(s.token1, "token1");
    const priceNumerator = sqrtPriceX96 * sqrtPriceX96;
    const reserve0Floor = liquidity * Q96 / sqrtPriceX96;
    const reserve1Floor = liquidity * sqrtPriceX96 / Q96;
    const rows: any[] = [];
    for (const raw of array(input.routes, "routes")) {
      const route = record(raw, "route");
      const tokenIn = addr(route.tokenIn, "tokenIn"), tokenOut = addr(route.tokenOut, "tokenOut");
      if (sqrtPriceX96 <= 0n || liquidity <= 0n) throw new Error("algebra-integral math: non-positive concentrated-liquidity state");
      let reserveIn: bigint, reserveOut: bigint, numerator: bigint, denominator: bigint;
      if (tokenIn === token0 && tokenOut === token1) {
        reserveIn = reserve0Floor; reserveOut = reserve1Floor;
        numerator = priceNumerator; denominator = Q192;
      } else if (tokenIn === token1 && tokenOut === token0) {
        reserveIn = reserve1Floor; reserveOut = reserve0Floor;
        numerator = Q192; denominator = priceNumerator;
      } else {
        throw new Error(`algebra-integral math: edge ${tokenIn}->${tokenOut} does not match ${token0}/${token1}`);
      }
      if (reserveIn < MIN_VENUE_RESERVE_IN || reserveOut < MIN_VENUE_RESERVE_IN) {
        throw new Error(`algebra-integral math: concentrated-liquidity direction ${tokenIn}->${tokenOut} requires a current-source precision quote`);
      }
      if (numerator <= 0n || denominator <= 0n) throw new Error("algebra-integral math: non-positive concentrated-liquidity state");
      rows.push(Object.freeze({ routeKey: text(route.routeKey, "routeKey"), numerator, denominator,
        depth: reserveIn < reserveOut ? reserveIn : reserveOut, reserveA: reserveIn, reserveB: reserveOut,
        feeBps: rawFeeView / 100n }));
    }
    return Object.freeze(rows);
  },
  validateOutput(value) {
    for (const raw of array(value, "rows output")) {
      const row = record(raw, "row");
      if (typeof row.routeKey !== "string" || typeof row.numerator !== "bigint" || typeof row.denominator !== "bigint" ||
          typeof row.depth !== "bigint" || typeof row.reserveA !== "bigint" || typeof row.reserveB !== "bigint" ||
          typeof row.feeBps !== "bigint") throw new Error("algebra-integral math: invalid price row");
    }
  },
};

/** Key/reason pairs consumed by the common unavailable-price boundary. */
const unavailable: DeclarativeMathModel = {
  id: "algebra-integral:unavailable",
  version: 1,
  validateInput(value) {
    const input = record(value, "unavailable input");
    record(input.snapshot, "snapshot"); array(input.routes, "routes");
  },
  evaluate(value) {
    const input = record(value, "unavailable input");
    const s = record(input.snapshot, "snapshot");
    if (s.inactiveReason === null) return [];
    return Object.freeze(array(input.routes, "routes").map(raw => {
      const route = record(raw, "route");
      return Object.freeze([text(route.routeKey, "routeKey"), text(s.inactiveReason, "inactiveReason")]);
    }));
  },
  validateOutput(value) {
    for (const raw of array(value, "unavailable output")) {
      if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== "string" || typeof raw[1] !== "string") {
        throw new Error("algebra-integral math: invalid unavailable row");
      }
    }
  },
};

export const algebraIntegralMathModels: readonly DeclarativeMathModel[] = Object.freeze([
  quoterBinding, snapshot, quote, rows, unavailable,
]);
