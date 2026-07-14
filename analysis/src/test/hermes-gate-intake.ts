import assert from "node:assert/strict";
import {
  fails,
  validateAbExternalCalibration,
  validateIntakeAudit,
  validateTxRecord,
} from "../cli/hermes-gate.js";
import { runCompetitorCalibration } from "../competitor-calibration.js";

const WIN = { from: 100, to: 200 };
const EOA = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"a".repeat(64)}`;
const POOL = "0x2222222222222222222222222222222222222222";
const CALIBRATION_SAMPLES = runCompetitorCalibration().checks.length;

const checks: Array<() => void> = [
  () => expectPass("valid public backrun tx", () => {
    validateTxRecord(validBackrunTx(), EOA, WIN);
  }),
  () => expectPass("valid atomic tx without source_flow", () => {
    validateTxRecord(validAtomicTx(), EOA, WIN);
  }),
  () => expectPass("explicit non-comparable unknown tx may have no pools", () => {
    validateTxRecord({
      hash: HASH,
      block: 150,
      class: "unknown",
      comparable: false,
      winner_style: "keeper_claim",
      pools: [],
      gap_class: "excluded_non_comparable_keeper",
    }, EOA, WIN);
  }),
  () => expectFail("unknown tx without explicit non-comparable evidence remains invalid", () => {
    validateTxRecord(validAtomicTx({ class: "unknown", pools: [] }), EOA, WIN);
  }, `tx ${HASH} missing/invalid class (atomic|backrun)`),
  () => expectFail("comparable atomic tx still requires pools", () => {
    validateTxRecord(validAtomicTx({ comparable: true, pools: [] }), EOA, WIN);
  }, `tx ${HASH} has no pools[] classified in/out of graph`),
  () => expectFail("non-comparable tx must name winner style", () => {
    validateTxRecord({
      hash: HASH,
      block: 150,
      class: "unknown",
      comparable: false,
      pools: [],
      gap_class: "excluded_non_comparable",
    }, EOA, WIN);
  }, `tx ${HASH} comparable=false but winner_style missing`),
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
  () => expectPass("A/B calibration accepts only a conserving atomic loop", () => {
    validateAbExternalCalibration(validAbCalibration());
  }),
  () => expectFail("A/B calibration rejects inventory mislabeled as comparable", () => {
    const value = validAbCalibration();
    value.findings[0].txs[0].position_conserving = false;
    value.findings[0].txs[0].winner_style = "one_leg_inventory";
    validateAbExternalCalibration(value);
  }, `ab_external_calibration tx ${HASH} is not a conserving atomic_loop`),
  () => expectFail("A/B calibration requires the classifier gate result", () => {
    const value = validAbCalibration();
    delete value.ab_external_calibration.classifier_calibration;
    validateAbExternalCalibration(value);
  }, "ab_external_calibration.classifier_calibration missing"),
  () => expectFail("A/B calibration rejects a fabricated sample count", () => {
    const value = validAbCalibration();
    value.ab_external_calibration.classifier_calibration.samples = CALIBRATION_SAMPLES - 1;
    validateAbExternalCalibration(value);
  }, `ab_external_calibration.classifier_calibration.samples must be ${CALIBRATION_SAMPLES}`),
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

function validAbCalibration(): any {
  return {
    findings: [{
      eoa: "0xc0ffeebabe5d496b2dde509f9fa189c25cf29671",
      txs: [{ hash: HASH, winner_style: "atomic_loop", position_conserving: true }],
    }],
    ab_external_calibration: {
      competitor: "0xc0ffeebabe5d496b2dde509f9fa189c25cf29671",
      strategy_kind: "block-scan",
      comparable_filter: "atomic_loop",
      tool_artifact: "docs/research/reports/step1-test.json",
      tool_manifest: "step1-test-tools.json",
      tool_manifest_sha256: "a".repeat(64),
      classifier_calibration: {
        command: "npm run competitor-calibration",
        status: "pass",
        samples: CALIBRATION_SAMPLES,
      },
      comparable_txs: [HASH],
      excluded_counts: {
        inventory: 1,
        sandwich: 0,
        keeper_or_liquidation: 0,
        jit_lp: 0,
        standing_credit: 0,
      },
      gap_counts: {
        not_seen: 0,
        pool: 1,
        path: 0,
        adapter: 0,
        quote_or_sim: 0,
        execution: 0,
        economics: 0,
      },
      next_problem_id: "LC-next",
    },
  };
}
