import { MaxUint256 } from "ethers";
import type { DeclarativeMathModel, MathValue } from "./declarative-math.js";

const MAX_UINT256 = MaxUint256;

type WithdrawOutInput = {
  readonly shares: bigint;
  readonly rate: bigint;
  readonly shareDecimals: number;
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
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 36) {
    throw new Error(`${label} must be an integer share decimals value`);
  }
  return value;
}

function input(value: MathValue): WithdrawOutInput {
  const source = plain(value, ["shares", "rate", "shareDecimals"], "Boring vault withdraw input");
  const parsed = {
    shares: uint(source.shares!, "Boring vault withdraw shares"),
    rate: uint(source.rate!, "Boring vault withdraw rate"),
    shareDecimals: decimals(source.shareDecimals!, "Boring vault withdraw shareDecimals"),
  };
  if (parsed.shares <= 0n || parsed.rate <= 0n) {
    throw new Error("boring vault withdraw amounts out of range");
  }
  return parsed;
}

/**
 * Source-faithful Teller conversion: the accountant rate is quoted per
 * ONE_SHARE = 10**shareDecimals raw units, so the asset payout is
 * floor(shares * rate / 10**shareDecimals). The model performs no transport,
 * ABI, state or settlement work.
 */
export const boringWithdrawOutMathModel: DeclarativeMathModel = Object.freeze({
  id: "boring-vault-teller:withdraw-out",
  version: 1,
  validateInput(value: MathValue): void {
    input(value);
  },
  evaluate(value: MathValue): MathValue {
    const source = input(value);
    return source.shares * source.rate / (10n ** BigInt(source.shareDecimals));
  },
  validateOutput(value: MathValue): void {
    uint(value, "Boring vault withdraw output");
  },
});
