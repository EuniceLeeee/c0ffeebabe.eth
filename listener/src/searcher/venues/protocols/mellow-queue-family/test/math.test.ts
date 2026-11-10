import assert from "node:assert/strict";
import test from "node:test";
import { depositShares, redeemAssets } from "../math.js";

const USDT_PRICE = 965393997509138974644718027830n;
const USDC_PRICE = 965490546563795354180136041435n;

test("mellow deposit matches N=26183616 mint exactly", () => {
  assert.equal(
    depositShares({ assets: 2_000_000_000n, priceD18: USDT_PRICE, penaltyD6: 0n }),
    1_930_787_995_018_277_949_289n,
  );
});

test("mellow redeem matches N=26183616 USDC out exactly", () => {
  assert.equal(
    redeemAssets({ shares: 1_930_787_995_018_277_949_288n, priceD18: USDC_PRICE, penaltyD6: 0n }),
    1_999_799_999n,
  );
});

test("penalty and fee reduce output predictably", () => {
  const gross = depositShares({ assets: 1_000_000n, priceD18: USDT_PRICE, penaltyD6: 0n });
  const withPenalty = depositShares({ assets: 1_000_000n, priceD18: USDT_PRICE, penaltyD6: 1_000n });
  assert(withPenalty < gross);
  const withFee = depositShares({ assets: 1_000_000n, priceD18: USDT_PRICE, penaltyD6: 0n, feeShares: 1n });
  assert.equal(withFee, gross - 1n);
});

test("rejects zero and out-of-range inputs", () => {
  assert.throws(() => depositShares({ assets: 0n, priceD18: USDT_PRICE, penaltyD6: 0n }));
  assert.throws(() => redeemAssets({ shares: 0n, priceD18: USDC_PRICE, penaltyD6: 0n }));
  assert.throws(() => depositShares({ assets: 1n, priceD18: 0n, penaltyD6: 0n }));
  assert.throws(() => depositShares({ assets: 1n, priceD18: USDT_PRICE, penaltyD6: 500_001n }));
});
