import assert from "node:assert/strict";
import test from "node:test";
import { classicBaseExchangeAmount, classicBaseMintAmount, type ClassicBasePoolState } from "../base-pool-math.js";

// Offline arithmetic-domain regression against the checked operation order in
// deployed 3pool Vyper 0.2.4. No compiler/EVM/RPC execution is performed here.
const MAX = (1n << 256n) - 1n;
const SCALE = 10n ** 18n;
const STATE: ClassicBasePoolState = {
  balances: [48584016423561599164952509n, 47983845606201n, 63151726663480n],
  precisions: [1n, 10n ** 12n, 10n ** 12n], amplification: 4000n,
  fee: 1500000n, lpTotalSupply: 153602243283618865987372153n,
};

for (const i of [0, 1, 2]) {
  test(`coin ${i}: reject RATES multiplication overflow even when cancelled normalization fits`, () => {
    const rate = STATE.precisions[i] * SCALE, limit = MAX / rate, amount = limit + 1n;
    assert(amount <= MAX && amount * STATE.precisions[i] <= MAX);
    assert(amount * rate > MAX);
    assert(classicBaseExchangeAmount(STATE, i, (i + 1) % 3, limit) > 0n,
      "the adjacent checked-multiplication boundary still admits a numerical quote");
    assert.throws(() => classicBaseExchangeAmount(STATE, i, (i + 1) % 3, amount), /uint256/);
    assert.throws(() => classicBaseExchangeAmount(STATE, i, (i + 1) % 3,
      10n ** 60n / STATE.precisions[i]), /uint256/, "original reviewer reproduction");
  });

  test(`coin ${i}: _xp_mem checks balance * RATES before cancelling its scale`, () => {
    const balances = [...STATE.balances];
    balances[i] = MAX / (STATE.precisions[i] * SCALE) + 1n;
    assert(balances[i] * STATE.precisions[i] <= MAX);
    const invalid = { ...STATE, balances };
    // Zero input isolates normalization from the later invariant solver: the old
    // cancelled multiplication accepted this invalid state and returned zero.
    assert.throws(() => classicBaseExchangeAmount(invalid, i, (i + 1) % 3, 0n), /uint256/);
    assert.throws(() => classicBaseMintAmount(invalid, i, 0n), /uint256/);
  });
}

test("saved normal-sized mint and execution rounding controls remain exact", () => {
  assert.equal(classicBaseMintAmount(STATE, 0, 5215439882447199582n), 5015417355582850964n);
  assert.equal(classicBaseExchangeAmount(STATE, 0, 2, 52154398824471995820n), 52149952n);
  assert.equal(classicBaseExchangeAmount(STATE, 1, 2, 5216204n), 5215777n);
});
