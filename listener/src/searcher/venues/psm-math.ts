import { MaxUint256 } from "ethers";
import type { DeclarativeMathModel, MathValue } from "./declarative-math.js";
import type { RuntimeMathModel } from "./declarative-runtime-math.js";

const MAX_UINT256 = MaxUint256;
const PSM_WAD = 10n ** 18n;

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

/** Source-faithful DssLitePsm integer fee semantics from the Family codec. */
function sellQuote(amountIn: bigint, fee: bigint, scale: bigint): bigint {
  if (amountIn < 0n) throw new Error("PSM amountIn cannot be negative");
  if (fee < 0n || fee > PSM_WAD) throw new Error(`PSM tin returned invalid fee ${fee}`);
  const scaled = amountIn * scale;
  if (scale <= 0n || scaled > MAX_UINT256 || scaled * fee > MAX_UINT256) {
    throw new Error("PSM scaling or fee multiplication overflow");
  }
  return scaled - (scaled * fee) / PSM_WAD;
}

function buyCost(gemAmount: bigint, fee: bigint, scale: bigint): bigint {
  const scaled = gemAmount * scale;
  if (gemAmount < 0n || scale <= 0n || fee < 0n || fee > PSM_WAD ||
      scaled > MAX_UINT256 || scaled * fee > MAX_UINT256) {
    throw new Error("PSM invalid buy amount or fee overflow");
  }
  const cost = scaled + (scaled * fee) / PSM_WAD;
  if (cost > MAX_UINT256) throw new Error("PSM buy cost overflow");
  return cost;
}

function buyQuote(amountIn: bigint, fee: bigint, scale: bigint): bigint {
  if (amountIn < 0n || amountIn > MAX_UINT256 || scale <= 0n || fee < 0n || fee > PSM_WAD) {
    throw new Error("PSM invalid buy input or fee");
  }
  const gemAmount = (((amountIn + 1n) * PSM_WAD - 1n) / (PSM_WAD + fee)) / scale;
  if (buyCost(gemAmount, fee, scale) > amountIn) throw new Error("PSM buy exceeds input");
  return gemAmount;
}

type ConversionInput =
  | { readonly operation: "sell-quote"; readonly amount: bigint; readonly fee: bigint; readonly scale: bigint }
  | { readonly operation: "buy-quote"; readonly amount: bigint; readonly fee: bigint; readonly scale: bigint }
  | { readonly operation: "buy-cost"; readonly amount: bigint; readonly fee: bigint; readonly scale: bigint };

function conversionInput(value: MathValue): ConversionInput {
  const source = plain(value, ["operation", "amount", "fee", "scale"], "PSM conversion input");
  const operation = source.operation;
  if (operation !== "sell-quote" && operation !== "buy-quote" && operation !== "buy-cost") {
    throw new Error("PSM conversion operation is unsupported");
  }
  return Object.freeze({
    operation,
    amount: uint(source.amount!, "PSM conversion amount"),
    fee: uint(source.fee!, "PSM conversion fee"),
    scale: uint(source.scale!, "PSM conversion scale"),
  });
}

/**
 * Pure LitePSM fee/quote math bound by the PSM JSON `math` module: sell uses
 * the floored `tin` deduction; buy inverts the exact integer `buyGem` cost
 * instead of extrapolating a spot price. The model performs no transport, ABI,
 * state or settlement work.
 */
export const psmConversionMathModel: DeclarativeMathModel = Object.freeze({
  id: "psm:conversion",
  version: 1,
  validateInput(value: MathValue): void {
    const input = conversionInput(value);
    if (input.scale <= 0n) throw new Error("PSM conversion scale must be positive");
    if (input.fee > PSM_WAD) throw new Error("PSM conversion fee exceeds WAD");
    if (input.operation === "sell-quote") sellQuote(input.amount, input.fee, input.scale);
    else if (input.operation === "buy-quote") buyQuote(input.amount, input.fee, input.scale);
    else buyCost(input.amount, input.fee, input.scale);
  },
  evaluate(value: MathValue): MathValue {
    const input = conversionInput(value);
    if (input.scale <= 0n) throw new Error("PSM conversion scale must be positive");
    if (input.fee > PSM_WAD) throw new Error("PSM conversion fee exceeds WAD");
    if (input.operation === "sell-quote") return sellQuote(input.amount, input.fee, input.scale);
    if (input.operation === "buy-quote") return buyQuote(input.amount, input.fee, input.scale);
    return buyCost(input.amount, input.fee, input.scale);
  },
  validateOutput(value: MathValue): void {
    uint(value, "PSM conversion output");
  },
});

/**
 * In-transaction LitePSM terms. `isBuy` is a 0/1 selector that gates each
 * branch's input before multiplication, so the unused direction cannot
 * overflow. sell: amountIn gem units, floored tin deduction. buy: invert the
 * exact integer buyGem cost from the just-read `tout`. Outputs feed the shared
 * runtime amount program; no off-chain quote is an input.
 */
const psmRuntimeTermsOperations: RuntimeMathModel["operations"] = Object.freeze([
    { name: "isSell", op: "sub", left: { constant: "1" }, right: { input: "isBuy" } },
    { name: "sellAmount", op: "mul", left: { input: "amountIn" }, right: { local: "isSell" } },
    { name: "sellScaled", op: "mul", left: { local: "sellAmount" }, right: { input: "scale" } },
    { name: "sellFeeScaled", op: "mul", left: { local: "sellScaled" }, right: { input: "fee" } },
    { name: "sellFee", op: "div", left: { local: "sellFeeScaled" }, right: { constant: "1000000000000000000" } },
    { name: "sellOut", op: "sub", left: { local: "sellScaled" }, right: { local: "sellFee" } },
    { name: "buyBudget", op: "mul", left: { input: "amountIn" }, right: { input: "isBuy" } },
    { name: "buyNext", op: "add", left: { local: "buyBudget" }, right: { constant: "1" } },
    { name: "buyWide", op: "mul", left: { local: "buyNext" }, right: { constant: "1000000000000000000" } },
    { name: "buyNumerator", op: "sub", left: { local: "buyWide" }, right: { constant: "1" } },
    { name: "buyDenominator", op: "add", left: { constant: "1000000000000000000" }, right: { input: "fee" } },
    { name: "buyGemWide", op: "div", left: { local: "buyNumerator" }, right: { local: "buyDenominator" } },
    { name: "buyGem", op: "div", left: { local: "buyGemWide" }, right: { input: "scale" } },
    { name: "buyScaled", op: "mul", left: { local: "buyGem" }, right: { input: "scale" } },
    { name: "buyFeeScaled", op: "mul", left: { local: "buyScaled" }, right: { input: "fee" } },
    { name: "buyFee", op: "div", left: { local: "buyFeeScaled" }, right: { constant: "1000000000000000000" } },
    { name: "buyCost", op: "add", left: { local: "buyScaled" }, right: { local: "buyFee" } },
    { name: "callAmount", op: "add", left: { local: "sellAmount" }, right: { local: "buyGem" } },
    { name: "expectedOut", op: "add", left: { local: "sellOut" }, right: { local: "buyGem" } },
    { name: "expectedSpend", op: "add", left: { local: "sellAmount" }, right: { local: "buyCost" } },
    { name: "expectedReturn", op: "add", left: { local: "sellOut" }, right: { local: "buyCost" } },
  ]);
export const psmRuntimeTermsMathModel: RuntimeMathModel = Object.freeze({
  id: "psm:runtime-terms",
  version: 1,
  inputs: Object.freeze(["amountIn", "fee", "scale", "isBuy"]),
  outputs: Object.freeze(["callAmount", "expectedOut", "expectedSpend", "expectedReturn"]),
  operations: psmRuntimeTermsOperations,
});
