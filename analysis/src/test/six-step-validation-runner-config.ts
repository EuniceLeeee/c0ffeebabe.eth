import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseSixStepValidationRequest,
  productionPassBudgetMs,
  productionRunnerConfig,
  SIX_STEP_VALIDATION_REQUEST_SCHEMA_VERSION,
} from "../six-step-validation-controller.js";

const COMMIT = "a".repeat(40);
const SAMPLE = `0x${"b".repeat(64)}`;

test("six-step runner mirrors current live refinement and large-graph defaults", () => {
  const liveMain = readFileSync("../listener/src/searcher/main.ts", "utf8");
  const liveLoop = readFileSync(
    "../listener/src/searcher/blockscan-runtime-loop.ts",
    "utf8",
  );
  assert.match(
    liveMain,
    /SEARCHER_BLOCKSCAN_REFINE_CANDIDATES \?\? "512"/,
  );
  assert.match(
    liveMain,
    /SEARCHER_BLOCKSCAN_LARGE_GRAPH_PASS_BUDGET_MS \?\? "30000"/,
  );
  assert.match(
    liveMain,
    /SEARCHER_BLOCKSCAN_LARGE_GRAPH_EDGE_THRESHOLD \?\? "20000"/,
  );
  assert.match(
    liveLoop,
    /blockScanGraph\.length >= this\.deps\.largeGraphEdgeThreshold\s*\?\s*this\.deps\.largeGraphPassBudgetMs\s*:\s*this\.deps\.passBudgetMs/,
  );
  const config = productionRunnerConfig({});
  assert.equal(config.maxCandidates, 100);
  assert.equal(config.refineCandidates, 512);
  assert.equal(config.passBudgetMs, 11_000);
  assert.equal(config.largeGraphPassBudgetMs, 30_000);
  assert.equal(config.largeGraphEdgeThreshold, 20_000);
  assert.equal(productionPassBudgetMs(config, 19_999), 11_000);
  assert.equal(productionPassBudgetMs(config, 20_000), 30_000);
});

test("validation request accepts schema v2 and rejects stale schema v1", () => {
  const request = {
    schema_version: SIX_STEP_VALIDATION_REQUEST_SCHEMA_VERSION,
    request: "trusted-six-step-validation-request",
    mode: "checkpoint",
    branch: "codex/example-family",
    rollback_commit: COMMIT,
    sample_tx_hash: SAMPLE,
    lane: "block_scan_standing",
    trusted_reference_path:
      "docs/research/references/production-routes/example.json",
    input_snapshot_path: "snapshot.json",
  };
  assert.equal(
    parseSixStepValidationRequest(request, "/tmp").schema_version,
    SIX_STEP_VALIDATION_REQUEST_SCHEMA_VERSION,
  );
  assert.throws(
    () => parseSixStepValidationRequest(
      { ...request, schema_version: 1 },
      "/tmp",
    ),
    /validation request identity is invalid/,
  );
});

test("stacked bootstrap request binds one exact framework parent", () => {
  const request = {
    schema_version: SIX_STEP_VALIDATION_REQUEST_SCHEMA_VERSION,
    request: "trusted-six-step-validation-request",
    mode: "bootstrap",
    branch: "codex/example-family",
    rollback_commit: COMMIT,
    framework_parent_commit: COMMIT,
    sample_tx_hash: SAMPLE,
    lane: "block_scan_standing",
    trusted_reference_path:
      "docs/research/references/production-routes/example.json",
    input_snapshot_path: "snapshot.json",
  };
  const parsed = parseSixStepValidationRequest(request, "/tmp");
  assert.equal(parsed.mode, "bootstrap");
  assert.equal(
    parsed.mode === "bootstrap" ? parsed.framework_parent_commit : null,
    COMMIT,
  );
  assert.throws(
    () => parseSixStepValidationRequest(
      {
        ...request,
        framework_parent_commit: "c".repeat(40),
      },
      "/tmp",
    ),
    /framework_parent_commit equal to rollback_commit/,
  );
});

test("six-step runner applies the same live clamps before producing argv", () => {
  const config = productionRunnerConfig({
    SEARCHER_BLOCKSCAN_MAX_CANDIDATES: "200",
    SEARCHER_BLOCKSCAN_REFINE_CANDIDATES: "50",
    SEARCHER_BLOCKSCAN_PASS_BUDGET_MS: "45000",
    SEARCHER_BLOCKSCAN_LARGE_GRAPH_PASS_BUDGET_MS: "30000",
    SEARCHER_BLOCKSCAN_LARGE_GRAPH_EDGE_THRESHOLD: "25000",
  });
  assert.equal(config.refineCandidates, 200);
  assert.equal(config.passBudgetMs, 45_000);
  assert.equal(config.largeGraphPassBudgetMs, 45_000);
  assert.equal(config.largeGraphEdgeThreshold, 25_000);
  assert.equal(productionPassBudgetMs(config, 25_000), 45_000);
});

test("trusted producer passes the selected caps to the actual hunt child", () => {
  const controller = readFileSync(
    "src/six-step-validation-controller.ts",
    "utf8",
  );
  const producer = readFileSync(
    "../listener/src/searcher/test/production-replay.ts",
    "utf8",
  );
  assert.match(
    controller,
    /"--refine-candidates",\s*String\(input\.config\.refineCandidates\)/,
  );
  assert.match(
    controller,
    /"--large-graph-pass-budget-ms",\s*String\(input\.config\.largeGraphPassBudgetMs\)/,
  );
  assert.match(
    controller,
    /"--large-graph-edge-threshold",\s*String\(input\.config\.largeGraphEdgeThreshold\)/,
  );
  assert.match(
    producer,
    /const effectivePassBudgetMs = productionPassBudgetMs\(\s*cfg,\s*fullGraph\.length,\s*\)/,
  );
  assert.match(
    producer,
    /HUNT_PASS_BUDGET_MS: String\(input\.passBudgetMs\)/,
  );
  assert.match(
    producer,
    /HUNT_REFINE_CANDIDATES: String\(input\.cfg\.refineCandidates\)/,
  );
  assert.match(producer,
    /passBudgetMs: productionPassBudgetMs\(cfg, graphEdgeCount\)/);
  assert.match(producer, /basePassBudgetMs: cfg\.passBudgetMs/);
});

test("trusted producer freezes and hash-binds pending evidence before hunt", () => {
  const producer = readFileSync(
    "../listener/src/searcher/test/production-replay.ts",
    "utf8",
  );
  const hunt = readFileSync(
    "../listener/src/searcher/test/blockscan-hunt.ts",
    "utf8",
  );
  const freeze = producer.indexOf(
    "await observeFrozenTransactionExecutionEvidence",
  );
  const run = producer.indexOf("await runHunt({");
  assert(freeze >= 0 && run > freeze);
  assert.match(
    producer,
    /PRODUCTION_REPLAY_PENDING_EVIDENCE_ARTIFACT:\s*input\.pendingEvidenceArtifactPath/,
  );
  assert.match(
    producer,
    /PRODUCTION_REPLAY_PENDING_EVIDENCE_SHA256:\s*input\.pendingEvidenceArtifactSha256/,
  );
  assert.match(
    hunt,
    /loadFrozenPendingExecutionEvidenceArtifact\(\s*artifactPath,\s*artifactSha256/,
  );
  assert.match(
    hunt,
    /refineBlockScanCandidates\([\s\S]*?\{\s*familyTimeoutMs:[\s\S]*?executionEvidence,\s*\}/,
  );
  assert.match(
    hunt,
    /solver\.solve\([\s\S]*?quoteSafetyBps: 10000n,\s*executionEvidence,/,
  );
});
