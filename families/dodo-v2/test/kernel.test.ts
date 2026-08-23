import assert from "node:assert/strict";
import test from "node:test";
import { DODO_DECIMAL_ONE, quoteDodoPmmExactInput } from "../src/kernel/math.ts";

const balanced = { i: 2n * DODO_DECIMAL_ONE, K: 0n, B: 1_000n, Q: 2_000n, B0: 1_000n, Q0: 2_000n, R: 0 as const };
test("K=0 matches the independent linear oracle and subtracts fees independently", () => {
  const result = quoteDodoPmmExactInput({ state: balanced, sellBase: true, payAmount: 10n, lpFeeRate: DODO_DECIMAL_ONE / 10n, mtFeeRate: DODO_DECIMAL_ONE / 20n });
  assert.deepEqual(result, { status: "quote", grossAmountOut: 20n, lpFee: 2n, mtFee: 1n, amountOut: 17n });
});
test("direction, R state and uint256 bounds are load-bearing", () => {
  const reverse = quoteDodoPmmExactInput({ state: balanced, sellBase: false, payAmount: 20n, lpFeeRate: 0n, mtFeeRate: 0n });
  assert.equal(reverse.status, "quote"); if (reverse.status === "quote") assert.equal(reverse.amountOut, 10n);
  assert.throws(() => quoteDodoPmmExactInput({ state: { ...balanced, K: DODO_DECIMAL_ONE + 1n }, sellBase: true, payAmount: 1n, lpFeeRate: 0n, mtFeeRate: 0n }), /invalid PMM/);
  assert.throws(() => quoteDodoPmmExactInput({ state: balanced, sellBase: true, payAmount: -1n, lpFeeRate: 0n, mtFeeRate: 0n }), /uint256/);
});
