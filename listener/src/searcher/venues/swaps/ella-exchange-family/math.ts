import type { DeclarativeMathModel, MathValue } from "../../declarative-math.js";

/**
 * Ella Exchange integer quote model shared by the declarative JSON.
 *
 * The verified EllaExchangeService runtime (solc 0.6.0) prices every swap from
 * the pool-stored `tokenPrice` and applies `getFees()/getSystemCut()` exactly
 * as SafeDecimalMath: both `mul` sites keep their checked uint256 bound and the
 * two `* UNIT / UNIT` steps stay separate. This module only evaluates already
 * read state; it never reads a transport, encodes a call or decides admission.
 */
const MAX_UINT256 = (1n << 256n) - 1n;
const UNIT = 10n ** 18n;
const DIRECTIONS = new Set(["buy-token", "sell-token"]);

function uint(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT256) {
    throw new Error(`ella math: ${label} must be uint256`);
  }
  return value;
}

function record(value: MathValue, label: string): Record<string, MathValue> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Map) {
    throw new Error(`ella math: ${label} must be a record`);
  }
  return value as Record<string, MathValue>;
}

function direction(value: unknown): "buy-token" | "sell-token" {
  if (typeof value !== "string" || !DIRECTIONS.has(value)) {
    throw new Error("ella math: unsupported swap direction");
  }
  return value as "buy-token" | "sell-token";
}

/** Exact SafeDecimalMath.mul semantics: truncating division after a checked
 * product. Overflow rejects instead of silently widening past uint256. */
function mul(a: bigint, b: bigint): bigint {
  const out = a * b;
  if (a < 0n || b < 0n || out > MAX_UINT256) throw new Error("ella checked multiplication overflow");
  return out;
}

const INPUT_FIELDS = [
  "price", "fee", "systemCut", "tokenBalance", "nativeBalance",
  "baseFeesGenerated", "feesGenerated", "amountIn", "direction",
] as const;

const quote: DeclarativeMathModel = {
  id: "ella:source-quote",
  version: 1,
  validateInput(value) {
    const input = record(value, "quote input");
    if (Object.keys(input).some(key => !(INPUT_FIELDS as readonly string[]).includes(key))) {
      throw new Error("ella math: unknown quote input field");
    }
    for (const key of [
      "price", "fee", "systemCut", "tokenBalance", "nativeBalance",
      "baseFeesGenerated", "feesGenerated", "amountIn",
    ] as const) uint(input[key], key);
    direction(input.direction);
  },
  evaluate(value) {
    const input = record(value, "quote input");
    const state = {
      price: uint(input.price, "price"),
      fee: uint(input.fee, "fee"),
      systemCut: uint(input.systemCut, "systemCut"),
      tokenBalance: uint(input.tokenBalance, "tokenBalance"),
      nativeBalance: uint(input.nativeBalance, "nativeBalance"),
      baseFeesGenerated: uint(input.baseFeesGenerated, "baseFeesGenerated"),
      feesGenerated: uint(input.feesGenerated, "feesGenerated"),
    };
    const amountIn = uint(input.amountIn, "amountIn");
    const side = direction(input.direction);
    const buy = side === "buy-token";
    if (amountIn === 0n) {
      return Object.freeze({ amountOut: 0n, grossOut: 0n, fee: 0n, systemFee: 0n, unavailableReason: null });
    }
    if (state.price <= 0n || state.fee >= UNIT || state.systemCut > UNIT) {
      throw new Error("ella invalid quote state");
    }
    const due = buy ? mul(amountIn, UNIT) / state.price : mul(state.price, amountIn) / UNIT;
    const grossOut = mul(due, UNIT) / UNIT;
    const fee = mul(state.fee, grossOut) / UNIT;
    const systemFee = mul(state.systemCut, fee) / UNIT;
    const feesGenerated = buy ? state.feesGenerated : state.baseFeesGenerated;
    const balance = buy ? state.tokenBalance : state.nativeBalance;
    const unavailableReason = grossOut > balance ? "gross-output-exceeds-inventory"
      : feesGenerated + fee - systemFee > MAX_UINT256 ? "fee-counter-overflow"
      : grossOut - fee <= 0n ? "zero-output" : null;
    return Object.freeze({
      amountOut: unavailableReason ? 0n : grossOut - fee,
      grossOut, fee, systemFee, unavailableReason,
    });
  },
  validateOutput(value) {
    const output = record(value, "quote output");
    if (Object.keys(output).some(key =>
      !["amountOut", "grossOut", "fee", "systemFee", "unavailableReason"].includes(key))) {
      throw new Error("ella math: unknown quote output field");
    }
    for (const key of ["amountOut", "grossOut", "fee", "systemFee"] as const) uint(output[key], key);
    if (output.unavailableReason !== null && typeof output.unavailableReason !== "string") {
      throw new Error("ella math: invalid quote unavailability");
    }
    if (output.unavailableReason === null && output.amountOut === 0n) {
      // amountIn=0 is the only zero-output success; the quote layer rejects it
      // before evidence, so a zero result must carry an explicit reason.
      if (output.grossOut !== 0n) throw new Error("ella math: zero output requires an unavailable reason");
    }
  },
};

export const ellaMathModels: readonly DeclarativeMathModel[] = Object.freeze([quote]);
