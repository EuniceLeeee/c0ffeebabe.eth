import assert from "node:assert/strict";
import test from "node:test";
import { resolveBlockScanActivitySettings } from "../blockscan-activity-mode.js";

const diagnostic = { dryRun: true, blockScanSubmit: false, enabled: true,
  nMinusOne: false, blindProductionAudit: false };
const env = { SEARCHER_BLOCKSCAN_ACTIVITY_MODE: "logs-shadow" };

test("ordinary blockscan defaults to logs with background trace in both live and dry-run", () => {
  for (const dryRun of [true, false]) {
    for (const blockScanSubmit of [true, false]) {
      const context = { ...diagnostic, dryRun, blockScanSubmit };
      for (const settings of [{}, env]) {
        assert.deepEqual(resolveBlockScanActivitySettings(settings, context), {
          mode: "logs-shadow", shadowTimeoutMs: 20_000, shadowMaxConcurrent: 1,
        });
      }
    }
  }
  assert.throws(() => resolveBlockScanActivitySettings({ SEARCHER_BLOCKSCAN_ACTIVITY_MODE: "logs" }, diagnostic), /must be trace or logs-shadow/);
});

test("explicit trace preserves the original foreground path and its continuation support", () => {
  assert.equal(resolveBlockScanActivitySettings({ SEARCHER_BLOCKSCAN_ACTIVITY_MODE: "trace",
    SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_ENABLED: "1" },
  { ...diagnostic, dryRun: false, blockScanSubmit: true }).mode, "trace");
});

test("ordinary-live defaults do not change disabled blockscan or historical audit contexts", () => {
  for (const changes of [{ enabled: false }, { nMinusOne: true }, { blindProductionAudit: true }]) {
    assert.equal(resolveBlockScanActivitySettings({}, { ...diagnostic, ...changes }).mode, "trace");
  }
  assert.throws(() => resolveBlockScanActivitySettings(env, { ...diagnostic, enabled: false }), /requires SEARCHER_ENABLE_BLOCK_SCAN/);
  for (const changes of [{ nMinusOne: true }, { blindProductionAudit: true }, { subsetPriceMode: "fresh" as const }, { subsetPriceMode: "resume" as const }]) {
    assert.throws(() => resolveBlockScanActivitySettings(env, { ...diagnostic, ...changes }), /ordinary source-N/);
  }
});

test("unproven log coverage cannot enter a durable price continuation", () => {
  for (const [key, value] of Object.entries({
    SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_ENABLED: "1",
    SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_DIR: "/tmp/round",
    SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_COMPATIBILITY: "/tmp/compatibility",
    SEARCHER_BLOCKSCAN_LIVE_SUBSET_PARENT_DIR: "/tmp/parent",
    SEARCHER_BLOCKSCAN_LIVE_SUBSET_PARENT_COMPATIBILITY: "/tmp/parent-compatibility",
  })) {
    assert.throws(() => resolveBlockScanActivitySettings({ ...env, [key]: value }, diagnostic), /cannot import or export/);
  }
  assert.equal(resolveBlockScanActivitySettings({ ...env, SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_ENABLED: "0",
    SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_DIR: "" }, diagnostic).mode, "logs-shadow");
});

test("shadow resource limits are finite and explicitly bounded", () => {
  assert.deepEqual(resolveBlockScanActivitySettings({ ...env,
    SEARCHER_BLOCKSCAN_TRACE_SHADOW_TIMEOUT_MS: "1000", SEARCHER_BLOCKSCAN_TRACE_SHADOW_MAX_CONCURRENT: "2" }, diagnostic),
  { mode: "logs-shadow", shadowTimeoutMs: 1000, shadowMaxConcurrent: 2 });
  for (const value of ["0", "-1", "NaN", "Infinity", "1.5", "120001"]) {
    assert.throws(() => resolveBlockScanActivitySettings({ ...env, SEARCHER_BLOCKSCAN_TRACE_SHADOW_TIMEOUT_MS: value }, diagnostic));
  }
  assert.throws(() => resolveBlockScanActivitySettings({ ...env, SEARCHER_BLOCKSCAN_TRACE_SHADOW_MAX_CONCURRENT: "5" }, diagnostic));
});
