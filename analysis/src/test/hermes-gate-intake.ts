import assert from "node:assert/strict";
import {
  fails,
  validateIntakeAudit,
  validateTxRecord,
} from "../cli/hermes-gate.js";

const WIN = { from: 100, to: 200 };
const EOA = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"a".repeat(64)}`;
const POOL = "0x2222222222222222222222222222222222222222";

const checks: Array<() => void> = [
  () => expectPass("valid public backrun tx", () => {
    validateTxRecord(validBackrunTx(), EOA, WIN);
  }),
  () => expectPass("valid atomic tx without source_flow", () => {
    validateTxRecord(validAtomicTx(), EOA, WIN);
  }),
  () => expectFail("missing class", () => {
    validateTxRecord(validBackrunTx({ class: undefined }), EOA, WIN);
  }, `tx ${HASH} missing/invalid class (atomic|backrun)`),
  () => expectFail("invalid class", () => {
    validateTxRecord(validBackrunTx({ class: "weird" }), EOA, WIN);
  }, `tx ${HASH} missing/invalid class (atomic|backrun)`),
  () => expectFail("public backrun missing feed visibility", () => {
    const tx = validBackrunTx();
    delete tx.seen_in_our_feed;
    validateTxRecord(tx, EOA, WIN);
  }, `tx ${HASH} is a public backrun but missing seen_in_our_feed:boolean (did our mempool admission SEE the source swap?)`),
  () => expectPass("valid intake audit", () => {
    validateIntakeAudit(validIntakeAudit());
  }),
  () => expectFail("intake audit missing mevshare_enabled", () => {
    validateIntakeAudit({
      intake_audit: {
        pending_received: 10,
        pending_filtered: 2,
      },
    });
  }, "intake_audit.mevshare_enabled must be boolean"),
  () => expectFail("intake audit non-number pending_filtered", () => {
    validateIntakeAudit({
      intake_audit: {
        pending_received: 10,
        pending_filtered: "lots",
        mevshare_enabled: false,
      },
    });
  }, "intake_audit.pending_filtered must be a finite number >= 0"),
];

try {
  for (const check of checks) check();
  console.log(`hermes-gate-intake PASS (${checks.length}/${checks.length})`);
  console.log("verdict: fixed");
} catch (err) {
  console.error(`FAIL: ${(err as Error).message}`);
  process.exit(1);
}

function expectPass(label: string, fn: () => void): void {
  fails.length = 0;
  fn();
  assert.deepEqual(fails, [], label);
}

function expectFail(label: string, fn: () => void, expected: string): void {
  fails.length = 0;
  fn();
  assert.ok(
    fails.includes(expected),
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(fails)}`,
  );
}

function validBackrunTx(overrides: Record<string, unknown> = {}): any {
  return {
    hash: HASH,
    block: 150,
    class: "backrun",
    source_flow: "public",
    seen_in_our_feed: false,
    pools: [{ addr: POOL, inGraph: true }],
    gap_class: "path_gap",
    ...overrides,
  };
}

function validAtomicTx(overrides: Record<string, unknown> = {}): any {
  return {
    hash: HASH,
    block: 150,
    class: "atomic",
    pools: [{ addr: POOL, inGraph: true }],
    gap_class: "pool_gap",
    ...overrides,
  };
}

function validIntakeAudit(): any {
  return {
    intake_audit: {
      pending_received: 10,
      pending_filtered: 2,
      mevshare_enabled: false,
    },
  };
}
