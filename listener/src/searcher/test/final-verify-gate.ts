import {
  defaultFinalVerifyFloorBps,
  floorAmount,
  shouldRunFinalVerify,
} from "../solver/final-verify-gate.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function main(): void {
  const flashAmount = 1_000_000n;
  const floorBps = defaultFinalVerifyFloorBps(9_999n, 3);
  assert(floorBps === 4n, `default floor should be 4bps, got ${floorBps}`);
  assert(floorAmount(flashAmount, floorBps) === 400n, "floor amount should be 400");

  const cases: Array<{ label: string; quoteProfit: bigint; expected: boolean }> = [
    { label: "+5bps", quoteProfit: 500n, expected: true },
    { label: "flat", quoteProfit: 0n, expected: true },
    { label: "-4bps", quoteProfit: -400n, expected: true },
    { label: "-4bps minus one", quoteProfit: -401n, expected: false },
    { label: "-20bps", quoteProfit: -2_000n, expected: false },
    { label: "-50bps", quoteProfit: -5_000n, expected: false },
  ];

  let finalVerifyCalls = 0;
  let skipped = 0;
  for (const item of cases) {
    const admitted = shouldRunFinalVerify(item.quoteProfit, flashAmount, floorBps);
    assert(admitted === item.expected, `${item.label}: expected ${item.expected}, got ${admitted}`);
    if (admitted) {
      finalVerifyCalls++;
    } else {
      skipped++;
    }
  }

  assert(finalVerifyCalls === 3, `expected 3 final verify calls, got ${finalVerifyCalls}`);
  assert(skipped === 3, `expected 3 skipped candidates, got ${skipped}`);
  console.log("[finalverifygate] floor admission/skips: PASS");
}

main();
