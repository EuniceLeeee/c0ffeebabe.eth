import { MaxUint256 } from "ethers";
import type { DeclarativeMathModel, MathValue } from "./declarative-math.js";

const MAX_UINT256 = MaxUint256;

type ArcInput = {
  readonly amount: bigint;
  readonly tokenDecimals: number;
  readonly tokenTwapValue: bigint;
  readonly tokenMultiplier: bigint;
  readonly multiplierScale: bigint;
};

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

function uint(value: MathValue, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT256) {
    throw new Error(`${label} must be a uint256`);
  }
  return value;
}

function decimals(value: MathValue, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

/** Decode the declared model input without reading state or transport. */
function input(value: MathValue): ArcInput {
  const source = plain(value, ["amount", "tokenDecimals", "tokenTwapValue", "tokenMultiplier", "multiplierScale"],
    "Arcana conversion input");
  const parsed = {
    amount: uint(source.amount!, "Arcana conversion amount"),
    tokenDecimals: decimals(source.tokenDecimals!, "Arcana conversion tokenDecimals"),
    tokenTwapValue: uint(source.tokenTwapValue!, "Arcana conversion tokenTwapValue"),
    tokenMultiplier: uint(source.tokenMultiplier!, "Arcana conversion tokenMultiplier"),
    multiplierScale: uint(source.multiplierScale!, "Arcana conversion multiplierScale"),
  };
  if (parsed.amount <= 0n) throw new Error("arcana amount must be positive");
  if (parsed.tokenTwapValue <= 0n || parsed.tokenMultiplier <= 0n || parsed.multiplierScale <= 0n) {
    throw new Error("arcana conversion constants must be positive");
  }
  return parsed;
}

function convert(value: MathValue): bigint {
  const source = input(value);
  const scaled = source.amount * source.tokenTwapValue * source.tokenMultiplier;
  const scale = 10n ** BigInt(source.tokenDecimals) * source.multiplierScale;
  if (scaled % scale !== 0n) throw new Error("arcana conversion has remainder");
  return scaled / scale;
}

/**
 * Source-faithful ArcanaMigrationSource._convertExact: the preview output must
 * equal amount * tokenTwapValue * tokenMultiplier / (10**tokenDecimals *
 * multiplierScale) with the implementation's exact-remainder rejection. The
 * model performs no transport, ABI, state or settlement work.
 */
export const arcanaAmountMathModel: DeclarativeMathModel = Object.freeze({
  id: "arcana-migration:arc-amount",
  version: 1,
  validateInput(value: MathValue): void {
    input(value);
  },
  evaluate(value: MathValue): MathValue {
    return convert(value);
  },
  validateOutput(value: MathValue): void {
    if (typeof value !== "bigint" || value < 0n) {
      throw new Error("Arcana conversion output must be a non-negative integer");
    }
  },
});
