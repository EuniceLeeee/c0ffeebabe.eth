import { MaxUint256 } from "ethers";
import type { DeclarativeMathModel, MathValue } from "./declarative-math.js";
import type { RuntimeMathModel } from "./declarative-runtime-math.js";

const MAX_UINT256 = MaxUint256;
/** Olympus V3 staking INDEX_SCALE: gOHM (18 decimals) -> OHM (9 decimals). */
const OLYMPUS_INDEX_SCALE = 10n ** 18n;

function plain(
  value: MathValue,
  fields: readonly string[],
  label: string,
): Readonly<Record<string, MathValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
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

function uint(value: MathValue, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT256) {
    throw new Error(`${label} must be a uint256`);
  }
  return value;
}

type IndexQuoteInput = {
  readonly amountIn: bigint;
  readonly index: bigint;
};

function input(value: MathValue): IndexQuoteInput {
  const source = plain(value, ["amountIn", "index"], "Olympus index quote input");
  return Object.freeze({
    amountIn: uint(source.amountIn!, "Olympus index quote amountIn"),
    index: uint(source.index!, "Olympus index quote index"),
  });
}

/**
 * Source-faithful Olympus V3 unstake quote: floor(amountIn * index / 1e18)
 * with the same non-negative amount, positive index and uint256 product bound
 * as `olympusQuote` in `protocols/olympus-family/codec.ts`. The model performs
 * no transport, ABI, state or settlement work; `index()` is read by the JSON
 * read/quote flow and passed in.
 */
function quote(amountIn: bigint, index: bigint): bigint {
  if (amountIn < 0n) throw new Error("Olympus amountIn cannot be negative");
  if (index <= 0n) throw new Error(`Olympus index() returned ${index}`);
  const product = amountIn * index;
  if (product > MAX_UINT256) {
    throw new Error("Olympus gOHM/index multiplication overflow");
  }
  return product / OLYMPUS_INDEX_SCALE;
}

export const olympusIndexQuoteMathModel: DeclarativeMathModel = Object.freeze({
  id: "olympus:index-quote",
  version: 1,
  validateInput(value: MathValue): void {
    const source = input(value);
    quote(source.amountIn, source.index);
  },
  evaluate(value: MathValue): MathValue {
    const source = input(value);
    return quote(source.amountIn, source.index);
  },
  validateOutput(value: MathValue): void {
    uint(value, "Olympus index quote output");
  },
});

/**
 * The same floor formula as in-transaction runtime terms. The shared VM's
 * Solidity arithmetic reverts on the multiplication overflow and on division
 * by a zero index, so the model needs no extra branch; the JSON math step also
 * declares `index >= 1` before the division so a zero read fails closed.
 */
const runtimeOperations: RuntimeMathModel["operations"] = Object.freeze([
  { name: "product", op: "mul", left: { input: "amountIn" }, right: { input: "index" } },
  { name: "amountOut", op: "div", left: { local: "product" }, right: { constant: "1000000000000000000" } },
]);

export const olympusIndexRuntimeMathModel: RuntimeMathModel = Object.freeze({
  id: "olympus:index-runtime-quote",
  version: 1,
  inputs: Object.freeze(["amountIn", "index"]),
  outputs: Object.freeze(["amountOut"]),
  operations: runtimeOperations,
});
