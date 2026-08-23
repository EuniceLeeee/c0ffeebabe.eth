import assert from "node:assert/strict";
import test from "node:test";
import { curveNgGetDy, curvePlainGetDy, getD } from "../src/kernel/math.ts";

test("balanced invariant equals the independent N*x identity", () => {
  for (const count of [2, 3, 4]) { const xp = Array.from({ length: count }, () => 10n ** 18n); assert.equal(getD(xp, 100n), BigInt(count) * 10n ** 18n); }
});

test("plain quote is positive, bounded, and fee monotone", () => {
  const base = { A: 200n, fee: 0n, balances: [10n ** 21n, 10n ** 21n], rates: [10n ** 18n, 10n ** 18n] };
  const noFee = curvePlainGetDy(base, 0, 1, 10n ** 18n), withFee = curvePlainGetDy({ ...base, fee: 4_000_000n }, 0, 1, 10n ** 18n);
  assert.ok(noFee > 0n && noFee < 10n ** 18n); assert.ok(withFee < noFee);
  assert.throws(() => curvePlainGetDy({ ...base, rates: [10n ** 18n] }, 0, 1, 1n), /rates|count mismatch/);
  assert.throws(() => curvePlainGetDy({ ...base, A: 0n }, 0, 1, 0n), /amplification/);
});

test("NG off-peg multiplier cannot improve the same off-peg quote", () => {
  const state = { A: 100n, fee: 4_000_000n, balances: [2n * 10n ** 21n, 5n * 10n ** 20n], rates: [10n ** 18n, 10n ** 18n], offpegFeeMultiplier: 10n ** 10n };
  const base = curveNgGetDy(state, 0, 1, 10n ** 18n), amplified = curveNgGetDy({ ...state, offpegFeeMultiplier: 5n * 10n ** 10n }, 0, 1, 10n ** 18n);
  assert.ok(base > 0n); assert.ok(amplified <= base);
});
