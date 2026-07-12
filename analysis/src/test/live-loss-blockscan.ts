import assert from "node:assert/strict";
import {
  buildBackrunSeenByBlock,
  buildWatchBlockScanAudit,
  classifyWatchVisibility,
  defaultBlockScanLogPath,
  isWatchNotSeen,
  readWatchBlockScanLog,
  type WatchBlockScanAudit,
} from "../cli/live-loss.js";

const TOKEN_A = "0x1111111111111111111111111111111111111111";
const TOKEN_B = "0x2222222222222222222222222222222222222222";
const POOL_A = "0x3333333333333333333333333333333333333333";

const completeLog = [
  "[searcher/blockscan] block=99 warm=full warmedV2V3=20",
  `[searcher/blockscan] block=99 solve ring=${TOKEN_A}>${TOKEN_B}>${TOKEN_A} net=10`,
  "[searcher/blockscan] block=99 submitted atomic via relay-a",
  "[searcher/blockscan] block=99 scannedPairs=10 candidates=1 quotePositive=1 bestNet=10 warmedV2V3=20 protocolMids=1 skippedVenues=0 ms=5",
  "[searcher/blockscan] block=99 stage warm_ms=1 scan_ms=2 solve_ms=1 submit_ms=1 total_ms=5",
  "[searcher/blockscan] block=100 skipped=busy",
].join("\n");

const complete = buildWatchBlockScanAudit(
  100,
  [TOKEN_A],
  { path: "/tmp/mev-live.log", text: completeLog },
);
assert.equal(complete.target_block, 100);
assert.equal(complete.source_block, 99, "competitor target N must join blockscan source N-1");
assert.equal(complete.status, "complete");
assert.equal(complete.ran, true);
assert.equal(complete.detail_complete, true);
assert.equal(complete.solve_ring_count, 1);
assert.deepEqual(complete.candidate_ring_token_overlap_tokens, [TOKEN_A]);
assert.equal(complete.any_submission_in_source_pass, true);
assert.equal(complete.route_match_proven, false, "token overlap and pass-wide submission are not route proof");

const sourcePassCache = new Map();
const cachedA = buildWatchBlockScanAudit(100, [TOKEN_A], { path: "/tmp/mev-live.log", text: completeLog }, sourcePassCache);
const cachedB = buildWatchBlockScanAudit(100, [TOKEN_B], { path: "/tmp/mev-live.log", text: completeLog }, sourcePassCache);
assert.equal(sourcePassCache.size, 1, "multi-tx target blocks parse their shared source pass once");
assert.deepEqual(cachedA.candidate_ring_token_overlap_tokens, [TOKEN_A]);
assert.deepEqual(cachedB.candidate_ring_token_overlap_tokens, [TOKEN_B]);
assert.deepEqual(classifyWatchVisibility("none", complete), {
  primaryReason: "blockscan_ran_no_jsonl_signal",
  primaryReasonBasis: "blockscan_source_pass_complete",
});
assert.deepEqual(classifyWatchVisibility("same_pool", complete), {
  primaryReason: "seen_but_lost",
  primaryReasonBasis: "backrun_event_overlap",
});

const notRunningLog = [
  "[searcher/blockscan] block=98 skipped=busy",
  "[searcher/blockscan] block=100 skipped=busy",
].join("\n");
const notRunning = buildWatchBlockScanAudit(
  100,
  [TOKEN_A],
  { path: "/tmp/mev-live.log", text: notRunningLog },
);
assert.equal(notRunning.status, "not_running");
assert.deepEqual(classifyWatchVisibility("none", notRunning), {
  primaryReason: "not_seen",
  primaryReasonBasis: "blockscan_source_pass_absent",
});

const skippedBusy = buildWatchBlockScanAudit(
  100,
  [TOKEN_A],
  { path: "/tmp/mev-live.log", text: "[searcher/blockscan] block=99 skipped=busy" },
);
assert.equal(skippedBusy.status, "skipped_busy");
assert.equal(classifyWatchVisibility("block_only", skippedBusy).primaryReason, "not_seen");

const unavailable = buildWatchBlockScanAudit(
  100,
  [TOKEN_A],
  { path: "/missing/mev-live.log", text: null, error: "ENOENT" },
);
assert.equal(unavailable.status, "log_unavailable");
assert.equal(unavailable.log_error, "ENOENT");
assert.deepEqual(classifyWatchVisibility("none", unavailable), {
  primaryReason: "unknown_without_blockscan_evidence",
  primaryReasonBasis: "blockscan_evidence_unavailable_or_incomplete",
});
for (const status of [
  "log_unavailable",
  "budget_exceeded",
  "error",
  "incomplete",
  "unknown_log_rotated",
  "unknown_log_not_covered",
  "unknown_log_empty",
] as const) {
  const audit: WatchBlockScanAudit = { ...unavailable, status };
  assert.equal(
    classifyWatchVisibility("none", audit).primaryReason,
    "unknown_without_blockscan_evidence",
    `${status} must not be rolled up as not_seen`,
  );
}
assert.equal(isWatchNotSeen("not_seen"), true);
assert.equal(isWatchNotSeen("blockscan_ran_no_jsonl_signal"), false);
assert.equal(isWatchNotSeen("unknown_without_blockscan_evidence"), false);
assert.equal(isWatchNotSeen("seen_but_lost"), false);

const budgetLog = [
  "[searcher/blockscan] block=99 warm=full warmedV2V3=20",
  "[searcher/blockscan] block=99 pass_budget_exceeded elapsed_ms=100",
  "[searcher/blockscan] block=99 scannedPairs=10 candidates=0 quotePositive=0 bestNet=null warmedV2V3=20 protocolMids=1 skippedVenues=0 ms=100",
  "[searcher/blockscan] block=99 stage warm_ms=1 scan_ms=99 solve_ms=0 submit_ms=0 total_ms=100",
].join("\n");
const budget = buildWatchBlockScanAudit(
  100,
  [TOKEN_A],
  { path: "/tmp/mev-live.log", text: budgetLog },
);
assert.equal(budget.status, "budget_exceeded");
assert.equal(classifyWatchVisibility("none", budget).primaryReason, "unknown_without_blockscan_evidence");

const backrun = buildBackrunSeenByBlock([
  {
    type: "pipeline_dropped",
    opportunity_kind: "block-scan-arb",
    target_block: 100,
    pool: POOL_A,
    tokens: [TOKEN_A],
  },
  {
    type: "pipeline_dropped",
    opportunity_kind: "backrun-arb",
    target_block: 100,
    pool: TOKEN_B,
    tokens: [TOKEN_B],
  },
]);
assert.equal(backrun.get(100)?.pools.has(POOL_A), false, "atomic JSONL must not contaminate backrun seen scope");
assert.equal(backrun.get(100)?.tokens.has(TOKEN_A), false);
assert.equal(backrun.get(100)?.tokens.has(TOKEN_B), true);

assert.equal(defaultBlockScanLogPath(), "/var/log/mev-live.log");
const missingRead = await readWatchBlockScanLog(`/tmp/live-loss-blockscan-missing-${process.pid}.log`);
assert.equal(missingRead.text, null);
assert.match(missingRead.error ?? "", /ENOENT/);

console.log("LIVE LOSS BLOCKSCAN: PASS");
