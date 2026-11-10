import assert from "node:assert/strict";
import test from "node:test";
import { arcAmount } from "../math.js";

test("arcana conversion matches tx1 previewArcAmount exactly", () => {
  assert.equal(
    arcAmount({
      amount: 1_521_420_467_986_403_112n,
      tokenDecimals: 18,
      tokenTwapValue: 1_900_000_000_000_000_000_000n,
      tokenMultiplier: 1_000_000_000_000_000_000n,
      multiplierScale: 1_000_000_000_000_000_000n,
    }),
    2_890_698_889_174_165_912_800n,
  );
});

test("arcana conversion rejects remainder and zero", () => {
  assert.throws(() => arcAmount({
    amount: 1n, tokenDecimals: 18,
    tokenTwapValue: 1_900_000_000_000_000_000_001n,
    tokenMultiplier: 1_000_000_000_000_000_000n,
    multiplierScale: 1_000_000_000_000_000_000n,
  }));
  assert.throws(() => arcAmount({
    amount: 0n, tokenDecimals: 18,
    tokenTwapValue: 1n, tokenMultiplier: 1n, multiplierScale: 1n,
  }));
});
