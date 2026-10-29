import { MaxUint256 } from "ethers";
import type { DeclarativeMathModel, MathValue } from "./declarative-math.js";
import type { RuntimeMathModel } from "./declarative-runtime-math.js";

const MAX_UINT256 = MaxUint256;
/** Both ARM assets are 18-decimal; the verified implementation scales by 1e36. */
const ORIGIN_STETH_ARM_PRICE_SCALE = 10n ** 36n;
/** setPrices bounds both operator price words below 2e36 (malformed-state guard). */
const ORIGIN_STETH_ARM_MAX_RATE = 2n * ORIGIN_STETH_ARM_PRICE_SCALE;

function uint(value: MathValue, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT256) {
    throw new Error(`${label} must be a uint256`);
  }
  return value;
}

function plain(value: MathValue, fields: readonly string[], label: string): Readonly<Record<string, MathValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  const record = value as Record<string, MathValue>;
  const keys = Reflect.ownKeys(record);
  if (keys.some(key => typeof key !== "string") ||
      keys.some(key => typeof key === "string" && !fields.includes(key)) ||
      fields.some(key => !Object.hasOwn(record, key))) {
    throw new Error(`${label} has missing or unknown fields`);
  }
  return record;
}

interface LinearQuoteInput {
  readonly amountIn: bigint;
  readonly rate: bigint;
}

function quoteInput(value: MathValue): LinearQuoteInput {
  const source = plain(value, ["amountIn", "rate"], "Origin stETH ARM quote input");
  if (typeof source.amountIn !== "bigint" || source.amountIn < 0n) {
    throw new Error("Origin stETH ARM amountIn cannot be negative");
  }
  return Object.freeze({
    amountIn: uint(source.amountIn, "Origin stETH ARM amountIn"),
    rate: uint(source.rate!, "Origin stETH ARM rate"),
  });
}

function checkRate(rate: bigint): void {
  if (rate <= 0n || rate > ORIGIN_STETH_ARM_MAX_RATE) {
    throw new Error(`Origin stETH ARM rate is outside the supported range: ${rate}`);
  }
}

function linearQuote(value: MathValue): bigint {
  const source = quoteInput(value);
  checkRate(source.rate);
  if (source.amountIn > MAX_UINT256 / source.rate) {
    throw new Error("Origin stETH ARM amountIn * rate overflows uint256");
  }
  return source.amountIn * source.rate / ORIGIN_STETH_ARM_PRICE_SCALE;
}

/**
 * Source-faithful Origin stETH ARM swap output: `floor(amountIn * rate / 1e36)`
 * for one of the two operator price words the verified implementation reads.
 * The rate range and product-overflow guards mirror the Family codec (the
 * Solidity implementation reverts on checked-arithmetic overflow).
 */
export const originStethArmQuoteMathModel: DeclarativeMathModel = Object.freeze({
  id: "origin-steth-arm:linear-quote",
  version: 1,
  validateInput(value: MathValue): void {
    const source = quoteInput(value);
    checkRate(source.rate);
    if (source.amountIn > MAX_UINT256 / source.rate) {
      throw new Error("Origin stETH ARM amountIn * rate overflows uint256");
    }
  },
  evaluate(value: MathValue): MathValue {
    return linearQuote(value);
  },
  validateOutput(value: MathValue): void {
    uint(value, "Origin stETH ARM quote output");
  },
});

/**
 * Runtime twin of the quote above: the verified swap reads its own price word,
 * computes `amountIn * rate / 1e36`, and uses that exact integer as the swap
 * minimum output. JSON binds this opaque model/version; no formula is declared
 * in the Family document.
 */
const runtimeQuoteOperations: RuntimeMathModel["operations"] = [
  { name: "scaled", op: "mul", left: { input: "amountIn" }, right: { input: "rate" } },
  {
    name: "amountOut",
    op: "div",
    left: { local: "scaled" },
    right: { constant: "1000000000000000000000000000000000000" },
  },
];

export const originStethArmRuntimeQuoteMathModel: RuntimeMathModel = Object.freeze({
  id: "origin-steth-arm:runtime-quote",
  version: 1,
  inputs: ["amountIn", "rate"],
  outputs: ["amountOut"],
  operations: runtimeQuoteOperations,
});
