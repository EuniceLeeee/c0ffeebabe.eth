import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  blockScanActivityAtBlock,
  blockScanActivityFromLog,
  blockScanEvidenceForTarget,
  blockScanSubmissionCycleTokenSets,
  blockScanSourceBlockForTarget,
  competitorArbTokenSet,
} from "../cli/bundle-postmortem.js";

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f";

const completePassLog = [
  "2026-07-12T00:00:00Z [searcher/blockscan] block=99 warm=full reason=startup",
  `[searcher/blockscan]   solve ring=${WETH}->${USDC}->${WETH} net=42 standing=false protoRing=false`,
  // A head notification can arrive while block 99 is still solving. It must
  // not steal the following untagged ring from the active pass.
  "[searcher/blockscan] block=100 skipped=busy",
  `[searcher/blockscan] block=99 solve ring=${WETH}->${DAI}->${WETH} net=null error=no_quote standing=false protoRing=false`,
  "[searcher/blockscan] block=99 submitted atomic via eth_sendBundle targetBlock=100 profit=42 route=x",
  "[searcher/blockscan] block=99 scannedPairs=568 candidates=8 quotePositive=1 bestNet=42 warmedV2V3=9 protocolMids=2 skippedVenues=0 ms=900",
  "[searcher/blockscan] block=99 stage warm_plan=1ms solve=2ms total=900ms",
  "[searcher/blockscan] block=101 warm=incremental changed=1 changedCurve=0 range=100-101 logs=1",
  "[searcher/blockscan] block=101 scannedPairs=2 candidates=0 quotePositive=0 bestNet=null warmedV2V3=1 protocolMids=0 skippedVenues=0 ms=3",
  "[searcher/blockscan] block=101 stage warm_plan=1ms solve=1ms total=3ms",
].join("\n");

test("block-scan text parser keeps untagged rings on the active pass across skipped-busy heads", () => {
  const activity = blockScanActivityAtBlock(completePassLog, 99);

  assert.equal(activity.status, "complete");
  assert.equal(activity.ran, true);
  assert.equal(activity.detailComplete, true);
  assert.equal(activity.ringCount, 2);
  assert.equal(activity.anySubmitted, true);
  assert.deepEqual([...activity.scannedTokens].sort(), [DAI, USDC, WETH].sort());
  assert.deepEqual(activity.rings.map((ring) => ring.net), ["42", null]);
  assert.equal(activity.rings[1]?.error, "no_quote");
  assert.equal(activity.minBlock, 99);
  assert.equal(activity.maxBlock, 101);
});

test("competitor target block joins the preceding source pass", () => {
  assert.equal(blockScanSourceBlockForTarget(100), 99);
  assert.equal(blockScanSourceBlockForTarget(0), 0);
});

test("token join keeps net-zero intermediary tokens from flow steps", () => {
  const tokens = competitorArbTokenSet(
    [{ token: USDC }, { token: DAI }],
    [{ token: WETH, raw: 1n, symbol: "WETH", decimals: 18 }],
    [],
  );
  assert.deepEqual([...tokens].sort(), [DAI, USDC, WETH].sort());
});

test("submission cycle tokens distinguish related from pass-global submissions", () => {
  const cycles = blockScanSubmissionCycleTokenSets([
    {
      type: "bundle_submitted",
      opportunity_kind: "block-scan-arb",
      target_block: 100,
      cycle_id: `${WETH}|${USDC}`,
    },
    {
      type: "bundle_submitted",
      opportunity_kind: "block-scan-arb",
      target_block: 101,
      cycle_id: `${WETH}|${DAI}`,
    },
    {
      type: "bundle_submitted",
      opportunity_kind: "backrun-arb",
      target_block: 100,
      cycle_id: `${WETH}|${DAI}`,
    },
  ], 100);

  assert.equal(cycles.length, 1);
  assert.deepEqual([...cycles[0]!].sort(), [USDC, WETH].sort());
  assert.equal([...new Set([WETH, DAI])].every((token) => cycles[0]!.has(token)), false);
});

test("block-scan log coverage distinguishes busy, rotation, future, absence, and partial passes", () => {
  assert.equal(blockScanActivityAtBlock(completePassLog, 100).status, "skipped_busy");
  assert.equal(blockScanActivityAtBlock(completePassLog, 98).status, "unknown_log_rotated");
  assert.equal(blockScanActivityAtBlock(completePassLog, 102).status, "unknown_log_not_covered");

  const inWindowAbsent = [
    "[searcher/blockscan] block=99 warm=full reason=startup",
    "[searcher/blockscan] block=99 scannedPairs=1 candidates=0 quotePositive=0 bestNet=null warmedV2V3=0 protocolMids=0 skippedVenues=0 ms=1",
    "[searcher/blockscan] block=99 stage total=1ms",
    "[searcher/blockscan] block=101 warm=full reason=periodic",
    "[searcher/blockscan] block=101 scannedPairs=1 candidates=0 quotePositive=0 bestNet=null warmedV2V3=0 protocolMids=0 skippedVenues=0 ms=1",
    "[searcher/blockscan] block=101 stage total=1ms",
  ].join("\n");
  assert.equal(blockScanActivityAtBlock(inWindowAbsent, 100).status, "not_running");

  const copyTruncated = [
    `[searcher/blockscan]   solve ring=${WETH}->${USDC}->${WETH} net=1 standing=false protoRing=false`,
    "[searcher/blockscan] block=100 stage total=5ms",
  ].join("\n");
  const partial = blockScanActivityAtBlock(copyTruncated, 100);
  assert.equal(partial.status, "incomplete");
  assert.equal(partial.detailComplete, false);
  assert.equal(partial.ringCount, 0, "an unanchored pre-truncation ring is never attributed");
});

test("budget-censored complete pass remains explicit instead of claiming a coverage gap", () => {
  const log = [
    "[searcher/blockscan] block=200 warm=full reason=startup",
    "[searcher/blockscan] block=200 pass_budget_exceeded stage=solve ms=11001 budgetMs=11000",
    "[searcher/blockscan] block=200 scannedPairs=10 candidates=1 quotePositive=0 bestNet=null warmedV2V3=1 protocolMids=0 skippedVenues=0 ms=11001",
    "[searcher/blockscan] block=200 stage warm_plan=1ms solve=11000ms total=11001ms",
  ].join("\n");
  const activity = blockScanActivityAtBlock(log, 200);
  assert.equal(activity.detailComplete, true);
  assert.equal(activity.status, "budget_exceeded");
});

const modernTiming = {
  type: "block_scan_timing",
  source_block: 99,
  outcome: "degraded",
  candidates: 10,
  planned: 10,
  quote_positive: 0,
  decision: "no_positive_quote",
  total_ms: 3297.963736000005,
  stages: {
    state: { status: "ran", stage_ms: 2490.108351000119 },
    enumeration: { status: "ran", stage_ms: 458.5091989999637 },
    planner_solver: { status: "ran", stage_ms: 237.87733300030231 },
    final_sim: { status: "not-run", stage_ms: 0 },
    ev: { status: "not-run", stage_ms: 0 },
  },
};
const timingLine = (record: Record<string, unknown> = modernTiming): string => `[searcher/blockscan-family] ${JSON.stringify(record)}`;

test("modern timing binds the source pass and preserves stage evidence without inventing route coverage", () => {
  const log = [timingLine(), timingLine({ ...modernTiming, source_block: 100, decision: "different-pass" })].join("\n");
  const activity = blockScanActivityAtBlock(log, 99);
  assert.equal(activity.status, "incomplete");
  assert.equal(activity.ran, true);
  assert.equal(activity.detailComplete, false);
  assert.equal(activity.timing?.source_block, 99);
  assert.equal(activity.timing?.decision, "no_positive_quote");
  assert.equal(activity.timing?.total_ms, modernTiming.total_ms);
  assert.deepEqual(activity.timing?.stages, modernTiming.stages);
  assert.equal(activity.minBlock, 99);
  assert.equal(activity.maxBlock, 100);
  assert.equal(blockScanActivityAtBlock(timingLine().slice(0, -10), 99).status, "unknown_log_empty");
  assert.equal(blockScanActivityAtBlock(timingLine({ ...modernTiming, stages: {} }), 99).ran, false);
});

test("streaming preserves legacy attribution across read chunks, CRLF and an unterminated final line", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "postmortem-blockscan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "live.log");
  const text = "x".repeat(65520) + "\r\n" + completePassLog.replaceAll("\n", "\r\n");
  await writeFile(path, text);
  assert.deepEqual(await blockScanActivityFromLog(path, 99), blockScanActivityAtBlock(text, 99));
  const evidence = await blockScanEvidenceForTarget(path, 100, new Set([WETH, USDC]), []);
  assert.equal(evidence.status, "complete");
  assert.equal(evidence.solve_ring_count, 2);
  assert.equal(evidence.token_overlap_count, 2);
});

test("modern timing and unavailable logs report unknown ring counts rather than zero", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "postmortem-blockscan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "live.log");
  await writeFile(path, `${completePassLog}\n${timingLine()}`);
  const evidence = await blockScanEvidenceForTarget(path, 100, new Set([WETH, USDC]), []);
  assert.equal(evidence.source_block, 99);
  assert.equal(evidence.ran, true);
  assert.equal(evidence.detail_complete, false);
  assert.equal(evidence.solve_ring_count, null);
  assert.equal(evidence.solve_ring_token_count, null);
  assert.equal(evidence.token_overlap_count, null);
  assert.equal(evidence.fully_covered_by_ring_count, null);
  assert.equal(evidence.timing?.stages?.final_sim?.status, "not-run");
  assert.match(evidence.limitations.join(" "), /unknown without route sidecars/);
  const missing = await blockScanEvidenceForTarget(join(directory, "missing.log"), 100, new Set(), []);
  assert.equal(missing.status, "log_unavailable");
  assert.equal(missing.solve_ring_count, null);
  assert.match(missing.log_error ?? "", /ENOENT/);
});
