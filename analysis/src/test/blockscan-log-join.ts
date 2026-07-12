import assert from "node:assert/strict";
import test from "node:test";
import {
  blockScanActivityAtBlock,
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
