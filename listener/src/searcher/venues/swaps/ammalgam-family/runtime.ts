import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import {
  BIPS_Q64,
  BORROW_X,
  BORROW_Y,
  DEPOSIT_X,
  DEPOSIT_Y,
  FEE_SLOPE_Q64,
  MIN_FEE_Q64,
  PAIR,
  TOKEN,
  address,
  amount,
} from "./codec.js";

export interface SwapProgramInput {
  readonly pair: string;
  readonly tokenX: string;
  readonly tokenY: string;
  /** true: tokenX in, tokenY out. */
  readonly xForY: boolean;
  readonly executor: string;
  readonly recipient: string;
  readonly minimum: bigint;
}

/**
 * Quote-free runtime program for one Ammalgam pair swap.
 *
 * The pair's `swap` takes the requested output and measures the input from its
 * balance delta, so the program derives the largest accepted output from pair
 * state and then executes the same input-first flow the pair itself documents:
 *
 *   1. read build state:  getReserves / referenceReserves /
 *      totalAssetsAndShares(false) / both pair token balances
 *   2. require  balance + BORROW - DEPOSIT == reserve  on both sides, which is
 *      the assumption the pair's own `calculateAmountIn` relies on
 *   3. transfer the working input r0 to the pair
 *   4. compute the QuadraticSwapFees fee for this input and invert the pair's
 *      non-depleted K check:  out = reserveOut - ceil(reserveIn*reserveOut /
 *      balanceAfterFeesIn). This is exact for the quadratic fee branch and a
 *      conservative (never over-quoting) bound in the linear branch.
 *   5. call swap(amountXOut, amountYOut, recipient, "0x") with the computed
 *      output; the pair transfers output first and then verifies K itself.
 *
 * Registers: r0 input, r1 reserveIn, r2 reserveOut, r3 referenceReserveIn,
 * r4 fee slope, r5..r8 deposit/borrow asset totals, r9/r10 pair balances,
 * r11..r15 scratch.
 */
export function swapProgram(input: SwapProgramInput): RuntimeAmountProgram {
  const pair = address(input.pair);
  const tokenX = address(input.tokenX);
  const tokenY = address(input.tokenY);
  const tokenIn = input.xForY ? tokenX : tokenY;
  const tokenOut = input.xForY ? tokenY : tokenX;
  const executor = runtimeExecutor(input.executor, pair, tokenIn, tokenOut);
  const recipient = runtimeExecutor(input.recipient, pair, tokenIn, tokenOut);
  amount(input.minimum);
  const inIndex = input.xForY ? 0 : 1;
  const outIndex = 1 - inIndex;
  const depositIn = 32 * (input.xForY ? DEPOSIT_X : DEPOSIT_Y);
  const depositOut = 32 * (input.xForY ? DEPOSIT_Y : DEPOSIT_X);
  const borrowIn = 32 * (input.xForY ? BORROW_X : BORROW_Y);
  const borrowOut = 32 * (input.xForY ? BORROW_Y : BORROW_X);
  // swap(uint256 amountXOut, uint256 amountYOut, address to, bytes data)
  const outPatchOffset = input.xForY ? 36 : 4;
  void executor;

  return new RuntimeAmountProgram()
    .call(pair, PAIR.encodeFunctionData("getReserves"), { static: true })
    .load(1, 32 * inIndex)
    .load(2, 32 * outIndex)
    .call(pair, PAIR.encodeFunctionData("referenceReserves"), { static: true })
    .load(3, 32 * inIndex)
    .call(pair, PAIR.encodeFunctionData("totalAssetsAndShares", [false]), { static: true })
    .load(5, depositIn)
    .load(6, depositOut)
    .load(7, borrowIn)
    .load(8, borrowOut)
    .call(tokenIn, TOKEN.encodeFunctionData("balanceOf", [pair]), { static: true })
    .load(9, 0)
    .call(tokenOut, TOKEN.encodeFunctionData("balanceOf", [pair]), { static: true })
    .load(10, 0)
    // The pair measures input as netBalance - (reserve - output); that is only
    // this program's amountIn when the pair's net balance equals its reserve.
    .math("add", 11, 9, 7)
    .math("sub", 11, 11, 5)
    .equal(11, 1)
    .math("add", 12, 10, 8)
    .math("sub", 12, 12, 6)
    .equal(12, 2)
    // Pre-pay the input exactly like the observed transaction.
    .call(tokenIn, TOKEN.encodeFunctionData("transfer", [pair, 0n]), { patches: [{ offset: 36, reg: 0 }] })
    .constant(4, FEE_SLOPE_Q64)
    // feeA = slope * (input + 2*max(0, reserve-reference)) / reference.
    // `max(0, x)` is `x - min(x, reference)` so no intermediate underflows.
    .constant(14, 0n)
    .math("min", 13, 1, 3)
    .math("sub", 13, 1, 13)
    .math("eq", 11, 13, 14)
    .math("add", 13, 13, 13)
    .math("add", 13, 13, 0)
    .math("mul", 13, 13, 4)
    .math("div", 13, 13, 3)
    // feeB = quadratic(pastBy, reference, reference) * pastBy / input with
    // pastBy = max(0, input + reserve - reference): the reference-crossing branch.
    .math("add", 15, 0, 1)
    .math("min", 12, 15, 3)
    .math("sub", 15, 15, 12)
    .math("mul", 12, 15, 4)
    .math("div", 12, 12, 3)
    .math("mul", 12, 12, 15)
    .math("div", 12, 12, 0)
    // Select the branch: reserve <= reference (sign = 1) uses feeB; otherwise
    // feeA. At equality both expressions agree. Selection is two masked adds so
    // no branch difference is ever subtracted through zero.
    .constant(14, 1n)
    .math("sub", 15, 14, 11)
    .math("mul", 12, 12, 11)
    .math("mul", 13, 13, 15)
    .math("add", 13, 13, 12)
    // max(fee, MIN_FEE_Q64)
    .constant(14, MIN_FEE_Q64)
    .math("min", 15, 13, 14)
    .math("add", 13, 13, 14)
    .math("sub", 13, 13, 15)
    // balanceAfterFeesIn = (balanceIn * BIPS_Q64 - input * fee) / BIPS_Q64
    .constant(14, BIPS_Q64)
    .math("add", 15, 1, 0)
    .math("mul", 15, 15, 14)
    .math("mul", 12, 0, 13)
    .math("sub", 15, 15, 12)
    .math("div", 15, 15, 14)
    // out = reserveOut - ceil(reserveIn * reserveOut / balanceAfterFeesIn)
    .math("mul", 12, 1, 2)
    .math("add", 12, 12, 15)
    .constant(14, 1n)
    .math("sub", 12, 12, 14)
    .math("div", 12, 12, 15)
    .math("sub", 12, 2, 12)
    // Require the computed output to meet this leg's minimum before spending gas.
    .constant(13, input.minimum)
    .math("min", 14, 12, 13)
    .equal(14, 13)
    .call(pair, PAIR.encodeFunctionData("swap", [0n, 0n, recipient, "0x"]), {
      patches: [{ offset: outPatchOffset, reg: 12 }],
    });
}

/** The executor this program must run as, validated against the pair and tokens. */
export function swapProgramExecutor(input: SwapProgramInput): string {
  return runtimeExecutor(
    input.executor,
    address(input.pair),
    address(input.xForY ? input.tokenX : input.tokenY),
    address(input.xForY ? input.tokenY : input.tokenX),
  );
}
