import { computeBribeTargetWei } from "../../submitter.js";
import { computeBidEth } from "../main.js";

function assertEq(actual: bigint, expected: bigint, msg: string): void {
  if (actual !== expected) {
    throw new Error(`FAIL: ${msg}: expected ${expected}, got ${actual}`);
  }
}

function main(): void {
  assertEq(
    computeBidEth(100n, 30n, { bribeAllAboveGas: true, bribeBps: 5000 }),
    70n,
    "bribe-all profit above gas",
  );
  assertEq(
    computeBidEth(20n, 30n, { bribeAllAboveGas: true, bribeBps: 5000 }),
    0n,
    "bribe-all zero when gas exceeds profit",
  );
  assertEq(
    computeBidEth(30n, 30n, { bribeAllAboveGas: true, bribeBps: 5000 }),
    0n,
    "bribe-all zero at breakeven",
  );
  assertEq(
    computeBidEth(100n, 30n, { bribeAllAboveGas: false, bribeBps: 5000 }),
    50n,
    "bps mode keeps margin",
  );

  assertEq(
    computeBribeTargetWei({ bribeWei: 70n, expectedProfitEth: 100n, bribeBps: 5000 }) ?? -1n,
    70n,
    "submitter absolute bribe target",
  );
  assertEq(
    computeBribeTargetWei({ expectedProfitEth: 100n, bribeBps: 5000 }) ?? -1n,
    50n,
    "submitter bps fallback target",
  );

  console.log("[bribe-mode] computeBidEth: PASS");
  console.log("[bribe-mode] submitter target: PASS");
  console.log("expected_transition: bid = bribeBps*profit -> bid = profit-gas");
  console.log("verdict: fixed");
  console.log("searcher_behavior_change: yes");
}

main();
