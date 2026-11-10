import assert from "node:assert/strict";
import test from "node:test";
import { redeemOut } from "../math.js";

test("ondo redeem matches the tx1 USDY->USDC formula", () => {
  const out = redeemOut({
    amount: 1_000_000_000_000_000_000n,
    priceRwa: 1_115_700_000_000_000_000n,
    priceReceive: 1_000_000_000_000_000_000n,
    normalizer: 1_000_000_000_000_000_000n,
    receiveDecimals: 6,
    feeFlat: 0n,
    feeBps: 0n,
    feePrecision: 10_000n,
  });
  assert.equal(out, 1_115_700n);
});

test("ondo redeem deducts flat and bps fees", () => {
  const out = redeemOut({
    amount: 1_000_000_000_000_000_000n,
    priceRwa: 1_000_000_000_000_000_000n,
    priceReceive: 1_000_000_000_000_000_000n,
    normalizer: 1_000_000_000_000_000_000n,
    receiveDecimals: 6,
    feeFlat: 0n,
    feeBps: 100n,
    feePrecision: 10_000n,
  });
  assert.equal(out, 990_000n);
});
