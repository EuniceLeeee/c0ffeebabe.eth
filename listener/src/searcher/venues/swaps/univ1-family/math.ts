import type { DeclarativeMathModel, MathValue } from "../../declarative-math.js";

/**
 * UniV1 integer quote/transition models shared by the declarative JSON.
 *
 * `anyswap-v1-issuer-fee-001` is the verified Anyswap clone implementation:
 * the pool charges ceil(input / 1000) to its issuer, prices from the reserve
 * *after* that fee leaves the seller, and subtracts only `sold` from its
 * native balance. `uniswap-v1-997` is canonical V1: no issuer fee and the
 * complete input enters the curve. Entries are pure functions of already-read
 * reserves; they never read a transport, encode a call or decide admission.
 */
const MAX_UINT256 = (1n << 256n) - 1n;
/** Executor VM value/return words are uint96; checked before a native leg. */
const MAX_VALUE = (1n << 96n) - 1n;
export const UNIV1_ISSUER_MODEL = "anyswap-v1-issuer-fee-001";
export const UNIV1_STANDARD_MODEL = "uniswap-v1-997";

function uint(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT256) {
    throw new Error(`univ1 math: ${label} must be uint256`);
  }
  return value;
}

function record(value: MathValue, label: string): Record<string, MathValue> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Map) {
    throw new Error(`univ1 math: ${label} must be a record`);
  }
  return value as Record<string, MathValue>;
}

function modelName(value: unknown): string {
  if (value !== UNIV1_ISSUER_MODEL && value !== UNIV1_STANDARD_MODEL) {
    throw new Error("univ1 math: unsupported quote model");
  }
  return value;
}

function checked(n: bigint, label: string): bigint {
  if (n < 0n || n > MAX_UINT256) throw new Error(`univ1 math: ${label} overflow`);
  return n;
}

const INPUT_FIELDS = ["nativeReserve", "tokenReserve", "amountIn", "buy", "model", "sourceOk"] as const;

const quote: DeclarativeMathModel = {
  id: "univ1:quote",
  version: 1,
  validateInput(value) {
    const input = record(value, "quote input");
    if (Object.keys(input).some(key => !(INPUT_FIELDS as readonly string[]).includes(key))) {
      throw new Error("univ1 math: unknown quote input field");
    }
    for (const key of ["nativeReserve", "tokenReserve", "amountIn"] as const) uint(input[key], key);
    if (typeof input.buy !== "boolean") throw new Error("univ1 math: direction must be boolean");
    modelName(input.model);
    if (input.sourceOk !== undefined && typeof input.sourceOk !== "boolean") {
      throw new Error("univ1 math: invalid source witness");
    }
  },
  evaluate(value) {
    const input = record(value, "quote input");
    const nativeReserve = uint(input.nativeReserve, "nativeReserve");
    const tokenReserve = uint(input.tokenReserve, "tokenReserve");
    const amountIn = uint(input.amountIn, "amountIn");
    const buy = input.buy as boolean;
    const model = modelName(input.model);
    if (amountIn === 0n) {
      return Object.freeze({
        amountOut: 0n, fee: 0n, received: 0n, buy, model,
        nativeReserve, tokenReserve,
      });
    }
    // Same order as the reviewed hand-written quote: the executor uint96 bound
    // and the non-empty reserve requirement precede any fee arithmetic.
    if (buy && amountIn > MAX_VALUE) throw new Error("univ1 math: native input exceeds executor uint96");
    checked(nativeReserve, "nativeReserve");
    checked(tokenReserve, "tokenReserve");
    if (nativeReserve === 0n || tokenReserve === 0n) throw new Error("univ1 math: empty reserves");
    const fee = model === UNIV1_ISSUER_MODEL ? checked(amountIn + 999n, "issuer fee") / 1000n : 0n;
    const received = checked(amountIn - fee, "received input");
    if (buy) checked(nativeReserve + amountIn, "native reserve");
    const reserveIn = buy ? checked(nativeReserve + fee, "fee-adjusted reserve") : tokenReserve;
    const reserveOut = buy ? tokenReserve : nativeReserve;
    const adjusted = checked(received * 997n, "fee numerator");
    const numerator = checked(adjusted * reserveOut, "quote numerator");
    const denominator = checked(checked(reserveIn * 1000n, "quote denominator") + adjusted, "quote denominator");
    const amountOut = numerator / denominator;
    if (!buy && amountOut > MAX_VALUE) throw new Error("univ1 math: native output exceeds executor uint96");
    return Object.freeze({
      amountOut, fee, received, buy, model,
      nativeReserve: checked(nativeReserve + (buy ? received : -amountOut), "post native reserve"),
      tokenReserve: checked(tokenReserve + (buy ? -amountOut : received), "post token reserve"),
    });
  },
  validateOutput(value) {
    const output = record(value, "quote output");
    for (const key of ["amountOut", "fee", "received", "nativeReserve", "tokenReserve"] as const) {
      uint(output[key], key);
    }
    if (typeof output.buy !== "boolean") throw new Error("univ1 math: output direction must be boolean");
    modelName(output.model);
  },
};

export const univ1MathModels: readonly DeclarativeMathModel[] = Object.freeze([quote]);
