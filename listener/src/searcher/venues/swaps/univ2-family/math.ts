import type { DeclarativeMathModel, MathValue } from "../../declarative-math.js";
import type { RuntimeMathModel } from "../../declarative-runtime-math.js";

/**
 * UniV2 constant-product quote/transition math shared by the declarative JSON.
 * Entries are pure integer functions of already-read state; they never read a
 * transport, encode a call, or decide admission.
 *
 * The quote is the production `quoteV2ExactInput` formula:
 *   receivedIn * (10000 - fee) * reserveOut
 *   --------------------------------------
 *   reserveIn * 10000 + receivedIn * (10000 - fee)
 * with the verified transfer-tax credit applied to the pair's received input
 * and to the executor's net output. `inputBalance` is the pair's actual token
 * balance, not the stored reserve, because pair._update stores balances in the
 * uint112 slots.
 */
const BPS = 10_000n;
const MAX_RESERVE = (1n << 112n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

function uint(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT256) {
    throw new Error(`univ2 math: ${label} must be uint256`);
  }
  return value;
}

function record(value: MathValue, label: string): Record<string, MathValue> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Map) {
    throw new Error(`univ2 math: ${label} must be a record`);
  }
  return value as Record<string, MathValue>;
}

/** Net credit of an ordinary ERC20 transfer under an optional verified model. */
function received(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  if (numerator === 0n) return amount;
  if (numerator < 0n || denominator <= numerator) throw new Error("univ2 math: invalid transfer-tax rule");
  if (amount > MAX_UINT256 / numerator) throw new Error("univ2 math: transfer-tax multiplication overflow");
  return amount - amount * numerator / denominator;
}

function capacity(balance: bigint): bigint {
  return balance >= MAX_RESERVE ? 0n : MAX_RESERVE - balance;
}

function quote(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feeBps: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  if (feeBps < 0n || feeBps >= BPS) throw new Error("univ2 math: fee outside constant-bps range");
  const amountInWithFee = amountIn * (BPS - feeBps);
  return amountInWithFee * reserveOut / (reserveIn * BPS + amountInWithFee);
}

function directionOf(value: unknown): "zero-for-one" | "one-for-zero" {
  if (value !== "zero-for-one" && value !== "one-for-zero") throw new Error("univ2 math: invalid direction");
  return value;
}

const exactQuote: DeclarativeMathModel = {
  id: "univ2:exact-quote",
  version: 1,
  validateInput(value) {
    const input = record(value, "exact quote input");
    for (const key of ["reserve0", "reserve1", "inputBalance", "amountIn", "feeBps", "taxInNumerator", "taxInDenominator", "taxOutNumerator", "taxOutDenominator"]) {
      uint(input[key], key);
    }
    if (input.outputBalance !== undefined) uint(input.outputBalance, "outputBalance");
    directionOf(input.direction);
  },
  evaluate(value) {
    const input = record(value, "exact quote input");
    const reserve0 = uint(input.reserve0, "reserve0");
    const reserve1 = uint(input.reserve1, "reserve1");
    const inputBalance = uint(input.inputBalance, "inputBalance");
    const outputBalance = input.outputBalance === undefined ? undefined : uint(input.outputBalance, "outputBalance");
    const amountIn = uint(input.amountIn, "amountIn");
    const feeBps = uint(input.feeBps, "feeBps");
    const direction = directionOf(input.direction);
    const taxInNumerator = uint(input.taxInNumerator, "taxInNumerator");
    const taxInDenominator = uint(input.taxInDenominator, "taxInDenominator");
    const taxOutNumerator = uint(input.taxOutNumerator, "taxOutNumerator");
    const taxOutDenominator = uint(input.taxOutDenominator, "taxOutDenominator");
    const forward = direction === "zero-for-one";
    const reserveIn = forward ? reserve0 : reserve1;
    const reserveOut = forward ? reserve1 : reserve0;
    const receivedAmountIn = received(amountIn, taxInNumerator, taxInDenominator);
    const maxAmountIn = capacity(inputBalance);
    const capacityExceeded = receivedAmountIn > maxAmountIn;
    const gross = capacityExceeded ? 0n : quote(reserveIn, reserveOut, receivedAmountIn, feeBps);
    const afterIn = inputBalance + receivedAmountIn;
    const checkedOut = outputBalance !== undefined;
    const afterOut = checkedOut ? outputBalance - gross : 0n;
    // Pair._update synchronizes BOTH actual balances; a negative/overflowing
    // post state or unsynced balance shortfall cannot be a valid transition.
    const invalidPostState = checkedOut && (afterOut < 0n || afterOut > MAX_RESERVE ||
      afterIn > MAX_RESERVE || inputBalance < reserveIn || outputBalance! < reserveOut);
    const poolAmountOut = capacityExceeded || invalidPostState ? 0n : gross;
    const amountOut = received(poolAmountOut, taxOutNumerator, taxOutDenominator);
    const reason = capacityExceeded ? "input-reserve-capacity"
      : invalidPostState ? "univ2-invalid-pair-post-state"
        : poolAmountOut === 0n ? "univ2-zero-curve-output" : null;
    return Object.freeze({
      reserve0, reserve1, reserveIn, reserveOut, inputBalance,
      ...(outputBalance === undefined ? {} : { outputBalance }),
      amountIn, feeBps, receivedAmountIn, maxAmountIn, capacityExceeded,
      poolAmountOut, amountOut, afterIn, afterOut, invalidPostState, reason,
    });
  },
  validateOutput(value) {
    const output = record(value, "exact quote output");
    for (const key of ["reserve0", "reserve1", "reserveIn", "reserveOut", "inputBalance", "amountIn", "feeBps", "receivedAmountIn", "maxAmountIn", "poolAmountOut", "amountOut", "afterIn", "afterOut"]) {
      uint(output[key], key);
    }
    if (output.outputBalance !== undefined) uint(output.outputBalance, "outputBalance");
    if (output.reason !== null && typeof output.reason !== "string") throw new Error("univ2 math: invalid unavailable reason");
    if (typeof output.capacityExceeded !== "boolean" || typeof output.invalidPostState !== "boolean") {
      throw new Error("univ2 math: invalid quote flags");
    }
  },
};

const postState: DeclarativeMathModel = {
  id: "univ2:post-state",
  version: 1,
  validateInput(value) {
    if (!Array.isArray(value) || value.length !== 5) throw new Error("univ2 math: post-state input");
    uint(value[0], "reserve0"); uint(value[1], "reserve1"); uint(value[2], "feeBps");
    if (typeof value[4] !== "number" || !Number.isSafeInteger(value[4]) || value[4] < 0) throw new Error("univ2 math: timestamp");
    if (!Array.isArray(value[3]) || value[3].length > 64) throw new Error("univ2 math: swap list");
    for (const swap of value[3]) {
      const row = record(swap as MathValue, "swap");
      for (const key of ["amount0In", "amount1In", "amount0Out", "amount1Out"]) uint(row[key], key);
    }
  },
  evaluate(value) {
    const rows = value as readonly MathValue[];
    let reserve0 = uint(rows[0], "reserve0");
    let reserve1 = uint(rows[1], "reserve1");
    const feeBps = uint(rows[2], "feeBps");
    for (const swap of rows[3] as readonly MathValue[]) {
      const row = record(swap, "swap");
      reserve0 += uint(row.amount0In, "amount0In") - uint(row.amount0Out, "amount0Out");
      reserve1 += uint(row.amount1In, "amount1In") - uint(row.amount1Out, "amount1Out");
      if (reserve0 < 0n || reserve1 < 0n) throw new Error("univ2 math: negative post-state");
    }
    return Object.freeze({ reserve0, reserve1, feeBps, blockTimestampLast: rows[4] as number });
  },
  validateOutput(value) {
    const output = record(value, "post-state output");
    uint(output.reserve0, "reserve0"); uint(output.reserve1, "reserve1"); uint(output.feeBps, "feeBps");
    if (typeof output.blockTimestampLast !== "number" || !Number.isSafeInteger(output.blockTimestampLast)) {
      throw new Error("univ2 math: output timestamp");
    }
  },
};

const victimLocal: DeclarativeMathModel = {
  id: "univ2:victim-local",
  version: 1,
  validateInput(value) {
    if (!Array.isArray(value) || value.length !== 5) throw new Error("univ2 math: victim input");
    uint(value[0], "reserve0"); uint(value[1], "reserve1"); uint(value[2], "amountIn"); uint(value[3], "feeBps");
    if (typeof value[4] !== "boolean") throw new Error("univ2 math: victim direction");
  },
  evaluate(value) {
    const [reserve0, reserve1, amountIn, feeBps, forward] = value as readonly MathValue[];
    const zero = reserve0 as bigint, one = reserve1 as bigint, input = amountIn as bigint, fee = feeBps as bigint;
    const reserveIn = forward ? zero : one;
    const reserveOut = forward ? one : zero;
    if (input <= 0n || input > capacity(reserveIn)) return null;
    const amountOut = quote(reserveIn, reserveOut, input, fee);
    if (amountOut <= 0n || amountOut >= reserveOut) return null;
    return Object.freeze({
      amountOut,
      postReserve0: forward ? zero + input : zero - amountOut,
      postReserve1: forward ? one - amountOut : one + input,
    });
  },
  validateOutput(value) {
    if (value === null) return;
    const output = record(value, "victim output");
    uint(output.amountOut, "amountOut"); uint(output.postReserve0, "postReserve0"); uint(output.postReserve1, "postReserve1");
  },
};

export const univ2MathModels: readonly DeclarativeMathModel[] = Object.freeze([
  exactQuote, postState, victimLocal,
]);

/**
 * Runtime quote emitted inside the settlement program. It reads the pair's
 * reserves, computes the transfer-tax received input and gross pool output,
 * and exports both the gross `poolAmountOut` (pair.swap argument) and the net
 * `amountOut` (the executor's actual credit). No call/value/approval opcode is
 * introduced by a math model; the shared execution compiler owns those.
 */
const runtimeQuoteOperations: RuntimeMathModel["operations"] = [
    { name: "feeComplement", op: "sub", left: { constant: "10000" }, right: { input: "feeBps" } },
    { name: "inputTaxMul", op: "mul", left: { input: "amountIn" }, right: { input: "taxInNumerator" } },
    { name: "inputTax", op: "div", left: { local: "inputTaxMul" }, right: { input: "taxInDenominator" } },
    { name: "receivedIn", op: "sub", left: { input: "amountIn" }, right: { local: "inputTax" } },
    { name: "inWithFee", op: "mul", left: { local: "receivedIn" }, right: { local: "feeComplement" } },
    { name: "numerator", op: "mul", left: { local: "inWithFee" }, right: { input: "reserveOut" } },
    { name: "denominatorBase", op: "mul", left: { input: "reserveIn" }, right: { constant: "10000" } },
    { name: "denominator", op: "add", left: { local: "denominatorBase" }, right: { local: "inWithFee" } },
    { name: "poolAmountOut", op: "div", left: { local: "numerator" }, right: { local: "denominator" } },
    { name: "outputTaxMul", op: "mul", left: { local: "poolAmountOut" }, right: { input: "taxOutNumerator" } },
    { name: "outputTax", op: "div", left: { local: "outputTaxMul" }, right: { input: "taxOutDenominator" } },
  { name: "amountOut", op: "sub", left: { local: "poolAmountOut" }, right: { local: "outputTax" } },
];

export const univ2RuntimeQuoteMathModel: RuntimeMathModel = Object.freeze({
  id: "univ2:runtime-quote",
  version: 1,
  inputs: ["reserveIn", "reserveOut", "amountIn", "feeBps", "taxInNumerator", "taxInDenominator", "taxOutNumerator", "taxOutDenominator"],
  outputs: ["poolAmountOut", "amountOut"],
  operations: Object.freeze(runtimeQuoteOperations),
});
