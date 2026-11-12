import assert from "node:assert/strict";
import test from "node:test";
import { resolveBlockScanActivitySettings } from "../blockscan-activity-mode.js";

test("logs drive touched by default; foreground trace remains an explicit rollback", () => {
  assert.deepEqual(resolveBlockScanActivitySettings({}), {
    mode: "logs-shadow", shadowTimeoutMs: 20_000, shadowMaxConcurrent: 1,
  });
  assert.equal(resolveBlockScanActivitySettings({ SEARCHER_BLOCKSCAN_ACTIVITY_MODE: "trace" }).mode, "trace");
  assert.throws(() => resolveBlockScanActivitySettings({ SEARCHER_BLOCKSCAN_ACTIVITY_MODE: "logs" }), /must be trace or logs-shadow/);
});

test("reader selection is independent of live, dry-run, replay and continuation policy", () => {
  for (const mode of ["trace", "logs-shadow"] as const) {
    for (const dryRun of ["0", "1"]) {
      assert.equal(resolveBlockScanActivitySettings({ SEARCHER_BLOCKSCAN_ACTIVITY_MODE: mode,
        SEARCHER_DRY_RUN: dryRun, SEARCHER_BLOCKSCAN_SUBMIT: "1",
        SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_ENABLED: "1", SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_DIR: "/tmp/round",
        SEARCHER_BLOCKSCAN_LIVE_SUBSET_PARENT_DIR: "/tmp/parent", SEARCHER_BLOCKSCAN_N_MINUS_ONE_FALLBACK: "1",
      }).mode, mode);
    }
  }
});

test("background resource bounds stay finite without changing foreground policy", () => {
  assert.deepEqual(resolveBlockScanActivitySettings({ SEARCHER_BLOCKSCAN_TRACE_SHADOW_TIMEOUT_MS: "1000",
    SEARCHER_BLOCKSCAN_TRACE_SHADOW_MAX_CONCURRENT: "2" }),
  { mode: "logs-shadow", shadowTimeoutMs: 1000, shadowMaxConcurrent: 2 });
  for (const value of ["0", "-1", "NaN", "Infinity", "1.5", "120001"]) {
    assert.throws(() => resolveBlockScanActivitySettings({ SEARCHER_BLOCKSCAN_TRACE_SHADOW_TIMEOUT_MS: value }));
  }
  assert.throws(() => resolveBlockScanActivitySettings({ SEARCHER_BLOCKSCAN_TRACE_SHADOW_MAX_CONCURRENT: "5" }));
});
