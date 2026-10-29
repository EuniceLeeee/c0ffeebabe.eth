import assert from "node:assert/strict";
import test from "node:test";
import { withdrawOut } from "../pricing.js";

// Real tx 0x0bff8c15… at N=26184075: shares from the univ4 leg, accountant
// rate in base units, and the vault exit amount observed in the trace.
const SHARES = 1_247_507_673_610_103_657_860n;
const RATE = 0x0eb0101fd136e06an;
const OUT = 1_320_316_763_956_915_293_227n;

test("boring vault withdraw matches the original exit amount exactly", () => {
  assert.equal(withdrawOut({ shares: SHARES, rate: RATE, shareDecimals: 18 }), OUT);
});

test("boring vault withdraw floors and rejects empty inputs", () => {
  assert.equal(withdrawOut({ shares: 1n, rate: 1n, shareDecimals: 0 }), 1n);
  assert.equal(withdrawOut({ shares: 1n, rate: 1n, shareDecimals: 18 }), 0n);
  assert.throws(() => withdrawOut({ shares: 0n, rate: RATE, shareDecimals: 18 }));
  assert.throws(() => withdrawOut({ shares: SHARES, rate: 0n, shareDecimals: 18 }));
  assert.throws(() => withdrawOut({ shares: SHARES, rate: RATE, shareDecimals: 37 }));
});
