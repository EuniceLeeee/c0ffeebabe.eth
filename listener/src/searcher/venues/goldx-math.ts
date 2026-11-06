import { MaxUint256 } from "ethers";
import type { DeclarativeMathModel, MathValue } from "./declarative-math.js";

const MAX_UINT256 = MaxUint256;
const GOLDX_WAD = 10n ** 18n;

type UnitQuoteInput = { readonly amountIn: bigint; readonly unit: bigint };

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

function input(value: MathValue): UnitQuoteInput {
  const source = plain(value, ["amountIn", "unit"], "GOLDx unit quote input");
  return Object.freeze({
    amountIn: uint(source.amountIn!, "GOLDx unit quote amountIn"),
    unit: uint(source.unit!, "GOLDx unit quote unit"),
  });
}

/**
 * Source-faithful GOLDx unit conversion: floor(amountIn * unit / 1e18) with the
 * same zero-unit rejection and product overflow bound as the Family codec.
 * The unit itself is read from the instance; this model performs no transport,
 * ABI, state or settlement work.
 */
export const goldxUnitQuoteMathModel: DeclarativeMathModel = Object.freeze({
  id: "goldx:unit-quote",
  version: 1,
  validateInput(value: MathValue): void {
    const source = input(value);
    if (source.unit <= 0n) throw new Error(`GOLDx unit() returned ${source.unit}`);
    if (source.amountIn * source.unit > MAX_UINT256) throw new Error("GOLDx multiplication overflow");
  },
  evaluate(value: MathValue): MathValue {
    const source = input(value);
    if (source.unit <= 0n) throw new Error(`GOLDx unit() returned ${source.unit}`);
    const product = source.amountIn * source.unit;
    if (product > MAX_UINT256) throw new Error("GOLDx multiplication overflow");
    return product / GOLDX_WAD;
  },
  validateOutput(value: MathValue): void {
    uint(value, "GOLDx unit quote output");
  },
});
