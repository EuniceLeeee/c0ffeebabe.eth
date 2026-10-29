import { MaxUint256 } from "ethers";
import type { DeclarativeMathModel, MathValue } from "./declarative-math.js";

type FeeParameters = {
  readonly parts: bigint;
  readonly rate: bigint;
  readonly min: bigint;
  readonly max: bigint;
};
type FeeInput = { readonly amountIn: bigint; readonly fees: FeeParameters };
type FeeOutput = { readonly fee: bigint; readonly amountOut: bigint };

const MAX_UINT256 = MaxUint256;

function plain(value: MathValue, fields: readonly string[], label: string): Record<string, MathValue> {
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

function input(value: MathValue): FeeInput {
  const source = plain(value, ["amountIn", "fees"], "self-burn native fee input");
  const fees = plain(source.fees!, ["parts", "rate", "min", "max"], "self-burn native fee parameters");
  return Object.freeze({
    amountIn: uint(source.amountIn!, "self-burn native fee amountIn"),
    fees: Object.freeze({
      parts: uint(fees.parts!, "self-burn native fee parts"),
      rate: uint(fees.rate!, "self-burn native fee rate"),
      min: uint(fees.min!, "self-burn native fee min"),
      max: uint(fees.max!, "self-burn native fee max"),
    }),
  });
}

/**
 * Source-faithful `WrapFee._calcWrapFee`: a checked multiply happens before the
 * caps; `min`/`max` are mutually exclusive branches; a zero rate bypasses both;
 * and a fee larger than the input is clipped to the input.
 */
function calculate(source: FeeInput): FeeOutput {
  const { amountIn, fees } = source;
  if (fees.parts === 0n || fees.rate > fees.parts) {
    throw new Error("self-burn native fee parts or rate are invalid");
  }
  if (fees.rate === 0n) return Object.freeze({ fee: 0n, amountOut: amountIn });
  const product = amountIn * fees.rate;
  if (product > MAX_UINT256) {
    throw new Error("self-burn native fee multiplication overflow");
  }
  let fee = product / fees.parts;
  if (fee < fees.min) fee = fees.min;
  else if (fee > fees.max) fee = fees.max;
  if (fee > amountIn) fee = amountIn;
  return Object.freeze({ fee, amountOut: amountIn - fee });
}

/**
 * Pure, versioned WrapFee conversion math bound by the self-burn-native JSON
 * `math` module. JSON carries only the model identity and input sources; the
 * protocol formula stays here. This model performs no transport, ABI, state or
 * settlement work.
 */
export const selfBurnNativeWrapFeeMathModel: DeclarativeMathModel = Object.freeze({
  id: "self-burn-native:wrap-fee",
  version: 1,
  validateInput(value: MathValue): void {
    input(value);
  },
  evaluate(value: MathValue): MathValue {
    return calculate(input(value));
  },
  validateOutput(value: MathValue): void {
    const output = plain(value, ["fee", "amountOut"], "self-burn native fee output");
    uint(output.fee!, "self-burn native fee output fee");
    uint(output.amountOut!, "self-burn native fee output amountOut");
  },
});
