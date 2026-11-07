import { MaxUint256, getAddress, ZeroAddress } from "ethers";
import type { DeclarativeMathModel, MathValue } from "./declarative-math.js";

/** Verified StakedUSDat implementation bound; the identity fee witness rejects
 * anything larger before this model is bound. */
const MAX_DEPOSIT_FEE_BPS = 500n;
const FEE_DENOMINATOR = 10_000n;

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
  if (typeof value !== "bigint" || value < 0n || value > MaxUint256) throw new Error(`${label} must be a uint256`);
  return value;
}

type EventAssetsInput = { readonly grossAssets: bigint; readonly depositFeeBps: bigint; readonly feeRecipient: string };

function input(value: MathValue): EventAssetsInput {
  const source = plain(value, ["grossAssets", "depositFeeBps", "feeRecipient"], "StakedUSDat event assets input");
  if (typeof source.feeRecipient !== "string") throw new Error("StakedUSDat fee recipient must be an address");
  const feeRecipient = getAddress(source.feeRecipient);
  const depositFeeBps = uint(source.depositFeeBps!, "StakedUSDat deposit fee bps");
  if (depositFeeBps > MAX_DEPOSIT_FEE_BPS) throw new Error("StakedUSDat deposit fee exceeds verified implementation bound");
  return Object.freeze({
    grossAssets: uint(source.grossAssets!, "StakedUSDat gross assets"),
    depositFeeBps,
    feeRecipient,
  });
}

/**
 * Source-faithful StakedUSDat Deposit.assets observation: the verified
 * implementation charges ceil(gross * depositFeeBps / 10000) and discloses the
 * net assets in the event. A zero fee or zero fee recipient leaves it gross.
 * Gross quoting/debit stay unchanged; this model only binds the event field.
 */
export const stakedUsdatEventAssetsMathModel: DeclarativeMathModel = Object.freeze({
  id: "staked-usdat:event-assets",
  version: 1,
  validateInput(value: MathValue): void {
    const source = input(value);
    if (source.depositFeeBps !== 0n && source.feeRecipient !== ZeroAddress) {
      const fee = (source.grossAssets * source.depositFeeBps + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR;
      if (fee > source.grossAssets) throw new Error("StakedUSDat event fee exceeds gross assets");
    }
  },
  evaluate(value: MathValue): MathValue {
    const source = input(value);
    if (source.depositFeeBps === 0n || source.feeRecipient === ZeroAddress) return source.grossAssets;
    const fee = (source.grossAssets * source.depositFeeBps + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR;
    if (fee > source.grossAssets) throw new Error("StakedUSDat event fee exceeds gross assets");
    return source.grossAssets - fee;
  },
  validateOutput(value: MathValue): void {
    uint(value, "StakedUSDat event assets output");
  },
});
