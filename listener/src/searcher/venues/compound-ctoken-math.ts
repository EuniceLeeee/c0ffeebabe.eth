import { MaxUint256 } from "ethers";
import type { DeclarativeMathModel, MathValue } from "./declarative-math.js";

/** Compound V2 cTokens carry a mantissa-scaled exchange rate:
 * underlying = shares * exchangeRate / 1e18. */
const EXCHANGE_RATE_SCALE = 10n ** 18n;
/** The Family's own decimals bound; identity rejects anything larger. */
const MAX_DECIMALS = 36n;

type RedemptionInput = {
  readonly operation: "redemption";
  readonly shares: bigint;
  readonly rate: bigint;
};
type ProbeSharesInput = {
  readonly operation: "probe-shares";
  readonly rate: bigint;
  readonly cash: bigint;
  readonly supply: bigint;
  readonly decimals: bigint;
};
type ModelInput = RedemptionInput | ProbeSharesInput;
type ModelOutput = { readonly amountOut: bigint } | { readonly shares: bigint };

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
  if (typeof value !== "bigint" || value < 0n || value > MaxUint256) {
    throw new Error(`${label} must be a uint256`);
  }
  return value;
}

function input(value: MathValue): ModelInput {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("compound cToken exchange-rate input must be a plain object");
  }
  const operation = (value as Record<string, MathValue>).operation;
  if (operation === "redemption") {
    const record = plain(value, ["operation", "shares", "rate"], "compound cToken redemption input");
    return Object.freeze({
      operation,
      shares: uint(record.shares!, "compound cToken redemption shares"),
      rate: uint(record.rate!, "compound cToken redemption rate"),
    });
  }
  if (operation === "probe-shares") {
    const record = plain(value, ["operation", "rate", "cash", "supply", "decimals"], "compound cToken probe input");
    const decimals = uint(record.decimals!, "compound cToken probe decimals");
    if (decimals > MAX_DECIMALS) {
      throw new Error("compound cToken probe decimals exceed the family bound");
    }
    return Object.freeze({
      operation,
      rate: uint(record.rate!, "compound cToken probe rate"),
      cash: uint(record.cash!, "compound cToken probe cash"),
      supply: uint(record.supply!, "compound cToken probe supply"),
      decimals,
    });
  }
  throw new Error("unknown compound cToken exchange-rate operation");
}

/**
 * Compound's checked Exp multiplication followed by integer truncation.
 * A negative or zero rate is not a redeemable state and is rejected, never
 * treated as a zero quote.
 */
function redemption(source: RedemptionInput): { readonly amountOut: bigint } {
  if (source.rate <= 0n) {
    throw new Error("compound cToken exchange rate must be positive");
  }
  if (source.shares * source.rate > MaxUint256) {
    throw new Error("compound cToken redemption multiplication out of range");
  }
  return Object.freeze({ amountOut: (source.shares * source.rate) / EXCHANGE_RATE_SCALE });
}

/**
 * Positive funded redemption probe size, identical to the Family's behaviour
 * sample: at least one underlying base unit out, never more than the market's
 * cash, share supply or the checked uint256 product. A state that cannot
 * produce one base unit yields zero; callers must treat that as no probe.
 */
function probeShares(source: ProbeSharesInput): { readonly shares: bigint } {
  if (source.rate <= 0n || source.cash <= 0n || source.supply <= 0n) {
    return Object.freeze({ shares: 0n });
  }
  const firstNonzero = (EXCHANGE_RATE_SCALE + source.rate - 1n) / source.rate;
  const unit = 10n ** source.decimals;
  const desired = unit > firstNonzero ? unit : firstNonzero;
  // floor(shares * rate / scale) <= cash, with the contract's checked uint256
  // intermediate multiplication. Rounding must not reject a legal 1-unit out.
  const liquid = ((source.cash + 1n) * EXCHANGE_RATE_SCALE - 1n) / source.rate;
  const productLimit = MaxUint256 / source.rate;
  const available = [source.supply, liquid, productLimit].reduce((left, right) =>
    left < right ? left : right);
  const sample = desired < available ? desired : available;
  return Object.freeze({ shares: sample >= firstNonzero ? sample : 0n });
}

function output(value: MathValue): ModelOutput {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("compound cToken exchange-rate output must be a plain object");
  }
  const record = value as Record<string, MathValue>;
  if (Object.hasOwn(record, "amountOut")) {
    const checked = plain(value, ["amountOut"], "compound cToken redemption output");
    return Object.freeze({ amountOut: uint(checked.amountOut!, "compound cToken redemption amountOut") });
  }
  const checked = plain(value, ["shares"], "compound cToken probe output");
  return Object.freeze({ shares: uint(checked.shares!, "compound cToken probe shares") });
}

/**
 * Pure, versioned Compound V2 cToken exchange-rate math bound by the
 * compound-ctoken JSON `math` module. JSON carries only the model identity and
 * input sources; both protocol formulas (share->underlying redemption and the
 * positive probe size) stay here. This model performs no transport, ABI, state
 * or settlement work.
 */
export const compoundCTokenExchangeRateMathModel: DeclarativeMathModel = Object.freeze({
  id: "compound-ctoken:exchange-rate",
  version: 1,
  validateInput(value: MathValue): void {
    input(value);
  },
  evaluate(value: MathValue): MathValue {
    const parsed = input(value);
    return parsed.operation === "redemption" ? redemption(parsed) : probeShares(parsed);
  },
  validateOutput(value: MathValue): void {
    output(value);
  },
});
