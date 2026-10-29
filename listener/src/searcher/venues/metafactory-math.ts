import { MaxUint256 } from "ethers";
import type { DeclarativeMathModel, MathValue } from "./declarative-math.js";

const MAX_UINT256 = MaxUint256;

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

type RedeemInput = {
  readonly amountIn: bigint;
  readonly totalEthAllocated: bigint;
  readonly circulatingSupply: bigint;
};

function input(value: MathValue): RedeemInput {
  const source = plain(
    value,
    ["amountIn", "totalEthAllocated", "circulatingSupply"],
    "MetaFactory redeem input",
  );
  return Object.freeze({
    amountIn: uint(source.amountIn!, "MetaFactory redeem amountIn"),
    totalEthAllocated: uint(source.totalEthAllocated!, "MetaFactory redeem totalEthAllocated"),
    circulatingSupply: uint(source.circulatingSupply!, "MetaFactory redeem circulatingSupply"),
  });
}

/**
 * Source-faithful MetaFactoryV1Composter redemption:
 *   floor(amount * totalEthAllocated / circulatingSupply)
 * with solc 0.8 checked multiplication and a non-zero divisor. The two state
 * reads and the composter's own `calculateRedemptionAmount` cross-check belong
 * to the JSON read flow; this model performs no transport, ABI or state work.
 */
function redeem(source: RedeemInput): bigint {
  if (source.circulatingSupply <= 0n) {
    throw new Error("metafactory circulatingSupply is not redeemable");
  }
  if (source.amountIn !== 0n &&
      source.totalEthAllocated > MAX_UINT256 / source.amountIn) {
    throw new Error("metafactory redemption multiplication overflow");
  }
  return (source.amountIn * source.totalEthAllocated) / source.circulatingSupply;
}

export const metafactoryRedeemMathModel: DeclarativeMathModel = Object.freeze({
  id: "metafactory:pro-rata-redeem",
  version: 1,
  validateInput(value: MathValue): void {
    redeem(input(value));
  },
  evaluate(value: MathValue): MathValue {
    return redeem(input(value));
  },
  validateOutput(value: MathValue): void {
    uint(value, "MetaFactory redeem output");
  },
});
