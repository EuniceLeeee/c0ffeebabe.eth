import { MaxUint256 } from "ethers";
import type { DeclarativeMathModel, MathValue } from "./declarative-math.js";

const MAX_UINT256 = MaxUint256;

type QuoteInput = {
  readonly amountIn: bigint;
  readonly totalSupply: bigint;
  readonly backing: bigint;
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

function input(value: MathValue): QuoteInput {
  const source = plain(value, ["amountIn", "totalSupply", "backing"], "Default collateral quote input");
  return Object.freeze({
    amountIn: uint(source.amountIn!, "default-collateral amountIn"),
    totalSupply: uint(source.totalSupply!, "default-collateral totalSupply"),
    backing: uint(source.backing!, "default-collateral backing"),
  });
}

/**
 * Source-faithful verified share-vault redemption: the implementation redeems
 * 1:1 only while the vault is fully backed, so any read pair that does not prove
 * `backing === totalSupply`, or an amount above the proven supply, refuses the
 * quote with the Family's reason instead of inventing a pro-rata rate. The model
 * performs no transport, ABI, state or settlement work.
 */
export const defaultCollateralQuoteMathModel: DeclarativeMathModel = Object.freeze({
  id: "default-collateral:quote",
  version: 1,
  validateInput(value: MathValue): void {
    const source = input(value);
    if (source.amountIn === 0n) return;
    if (source.totalSupply <= 0n || source.backing <= 0n) {
      throw new Error("default-collateral supply/backing is empty: rate not proven");
    }
    if (source.backing !== source.totalSupply) {
      throw new Error("default-collateral backing differs from totalSupply: 1:1 rate not proven");
    }
    if (source.amountIn > source.totalSupply) {
      throw new Error("default-collateral amount exceeds the proven share supply");
    }
    if (source.amountIn * source.backing / source.totalSupply !== source.amountIn) {
      throw new Error("default-collateral conversion is not 1:1 at this state");
    }
  },
  evaluate(value: MathValue): MathValue {
    const source = input(value);
    if (source.amountIn === 0n) return 0n;
    if (source.totalSupply <= 0n || source.backing <= 0n) {
      throw new Error("default-collateral supply/backing is empty: rate not proven");
    }
    if (source.backing !== source.totalSupply) {
      throw new Error("default-collateral backing differs from totalSupply: 1:1 rate not proven");
    }
    if (source.amountIn > source.totalSupply) {
      throw new Error("default-collateral amount exceeds the proven share supply");
    }
    const amountOut = source.amountIn * source.backing / source.totalSupply;
    if (amountOut !== source.amountIn) {
      throw new Error("default-collateral conversion is not 1:1 at this state");
    }
    return amountOut;
  },
  validateOutput(value: MathValue): void {
    uint(value, "Default collateral quote output");
  },
});
