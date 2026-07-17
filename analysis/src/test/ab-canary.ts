import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compareBlockScanLogs,
  parseAbExperiment,
  parseBlockScanLog,
  readAbLocalReportArtifact,
  resolveAbLocalReportArtifactPath,
  resolveAbReportArtifactPath,
  validateAbExperiment,
  validateAbProductionCandidate,
  type AbCompareResult,
  type AbExperiment,
} from "../ab-canary.js";

function log(totalBase: number, candidateOffset = 0): string {
  const lines: string[] = [];
  for (let block = 100; block < 106; block++) {
    lines.push(`[searcher/blockscan] block=${block} scannedPairs=10 candidates=${8 + candidateOffset} quotePositive=0 bestNet=null warmedV2V3=3 protocolMids=2 skippedVenues=0 ms=${totalBase}`);
    lines.push(`[searcher/blockscan] block=${block} stage warm_curve=2ms solve=${totalBase - 2}ms total=${totalBase}ms solve_planner=0ms solve_solver=${totalBase - 2}ms solve_submit=0ms`);
  }
  return lines.join("\n");
}

test("challenger universe mode prepares an immutable input before candidate replay", () => {
  const analysisRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const repoRoot = path.resolve(analysisRoot, "..");
  const wrapper = fs.readFileSync(path.join(repoRoot, "scripts/deploy-ab-challenger.sh"), "utf8");
  const gate = fs.readFileSync(path.join(analysisRoot, "src/cli/ab-canary-gate.ts"), "utf8");

  assert.doesNotMatch(wrapper, /B_UNIVERSE="\$WT\/listener\/searcher\/pools\/active-pools\.json"/);
  assert.match(wrapper, /prepare_candidate_universes "\$experiment" "\$requested_input_mode"/);
  assert.match(wrapper, /POOL_UNIVERSE_FROM_BLOCK="\$from_block"/);
  assert.match(wrapper, /POOL_UNIVERSE_TO_BLOCK="\$to_block"/);
  assert.match(wrapper, /timeout 900 env -i/);
  assert.match(wrapper, /POOL_UNIVERSE_V4_BACKFILL_LOOKBACK_BLOCKS=0/);
  assert.match(wrapper, /active-pools-\$universe_hash\.json/);
  assert.match(wrapper, /--baseline-universe "\$A_REPLAY_UNIVERSE"/);
  assert.match(wrapper, /--challenger-universe "\$B_UNIVERSE"/);

  assert.match(gate, /candidateUniverseArg\("baseline"\)/);
  assert.match(gate, /candidateUniverseArg\("challenger"\)/);
  assert.match(gate, /"baseline", baseRoot, 8568, baselineUniverse/);
  assert.match(gate, /"challenger", challengerRoot, 8569, challengerUniverse/);
});

test("historical candidate replay preserves production shape without using its live deadline", () => {
  const analysisRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const gate = fs.readFileSync(path.join(analysisRoot, "src/cli/ab-canary-gate.ts"), "utf8");

  assert.match(gate, /HUNT_SCAN_BUDGET_MS: "120000"/);
  assert.match(gate, /HUNT_PASS_BUDGET_MS: "600000"/);
  assert.match(gate, /HUNT_MAX_CANDIDATES: "100"/);
  assert.match(gate, /HUNT_TOP_K: "8"/);
  assert.match(gate, /timeout: 20 \* 60 \* 1000/);
  assert.match(gate, /candidateContext\?\.requireStageAdvance === false/);
  assert.match(gate, /baseline_stage === "final_sim_success"/);
  assert.match(gate, /challenger_stage === "final_sim_success"/);
  assert.match(gate, /runEquivalenceResolutionReplayPair\(observation\)/);
  assert.match(gate, /validateHuntResult\([\s\S]*"baseline resolution replay"/);
  assert.match(gate, /TX149_RESOLUTION_RESULT=/);
  assert.match(gate, /equivalence candidate must use the trusted tx149 resolution replay/);
  assert.match(gate, /"--runtime-listener-root", replayCwd/);
  assert.match(gate, /"--hunt-pass-budget-ms", "600000"/);
  assert.match(gate, /equivalence resolution replay machine results differ/);
  assert.match(gate, /must emit exactly one TX149 machine result/);
});

test("paired comparator excludes warmup and detects a guarded performance win", () => {
  const result = compareBlockScanLogs(log(100), log(80), {
    metric: "total_ms",
    direction: "lower",
    aggregate: "p50",
    minPairedBlocks: 4,
    warmupBlocks: 2,
    minImprovementPct: 10,
    minAbsoluteDelta: 10,
    maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  assert.equal(result.paired_blocks, 4);
  assert.equal(result.output_mismatches, 0);
  assert.equal(result.script_assessment, "supports");
});

test("disabled absolute threshold does not turn sub-percent noise into a regression", () => {
  const options = {
    metric: "total_ms",
    direction: "lower" as const,
    aggregate: "p50" as const,
    minPairedBlocks: 4,
    warmupBlocks: 2,
    minImprovementPct: 5,
    minAbsoluteDelta: 0,
    maxRegressionPct: 5,
    requireOutputMatch: false,
  };
  const noise = compareBlockScanLogs(log(100), log(101), options);
  const regression = compareBlockScanLogs(log(100), log(106), options);
  assert.equal(noise.script_assessment, "inconclusive");
  assert.equal(regression.script_assessment, "contradicts");
});

test("performance comparator rejects output drift", () => {
  const result = compareBlockScanLogs(log(100), log(80, 1), {
    metric: "total_ms",
    direction: "lower",
    aggregate: "p50",
    minPairedBlocks: 4,
    warmupBlocks: 2,
    minImprovementPct: 10,
    minAbsoluteDelta: 10,
    maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  assert.equal(result.script_assessment, "contradicts");
  assert.equal(result.output_mismatches, 4);
});

test("comparator can use per-block semantic event counts without turning them into a verdict", () => {
  const a = log(100).split("\n").flatMap((line) => line.includes("scannedPairs=")
    ? [line, "[searcher/blockscan]   final sim rejected ring=x route=y error=z"]
    : [line]).join("\n");
  const b = log(100);
  const result = compareBlockScanLogs(a, b, {
    metric: "event.finalSimRejected",
    direction: "lower",
    aggregate: "mean",
    minPairedBlocks: 4,
    warmupBlocks: 2,
    minImprovementPct: 0,
    minAbsoluteDelta: 1,
    maxRegressionPct: 5,
    requireOutputMatch: false,
  });
  assert.equal(result.script_assessment, "supports");
});

test("solvePositive counts only strictly positive net profit", () => {
  const text = [
    "[searcher/blockscan] block=100 scannedPairs=10 candidates=2 quotePositive=1 bestNet=5 warmedV2V3=3 protocolMids=2 skippedVenues=0 ms=10",
    "[searcher/blockscan]   solve ring=negative net=-7 standing=false protoRing=false",
    "[searcher/blockscan]   solve ring=zero net=0 standing=false protoRing=false",
    "[searcher/blockscan]   solve ring=positive net=5 standing=false protoRing=false",
  ].join("\n");
  assert.equal(parseBlockScanLog(text).get(100)?.events.solvePositive, 1);
});

test("block labels and busy notifications preserve active-pass attribution", () => {
  const text = [
    "[searcher/blockscan] block=100 warm=incremental changed=1 changedCurve=0 range=100-100 logs=1",
    "[searcher/blockscan]   solve ring=legacy>A>legacy net=null error=no_quote standing=false protoRing=false",
    "[searcher/blockscan] block=101 skipped=busy",
    "[searcher/blockscan] block=100 solve ring=labeled>B>labeled net=5 standing=false protoRing=false",
    "[searcher/blockscan] block=100 submitted atomic via eth_sendBundle targetBlock=101 profit=5 route=x",
    "[searcher/blockscan] block=100 scannedPairs=10 candidates=2 quotePositive=1 bestNet=5 warmedV2V3=3 protocolMids=2 skippedVenues=0 ms=10",
    "[searcher/blockscan] block=100 stage warm_curve=2ms solve=8ms total=10ms",
  ].join("\n");

  const parsed = parseBlockScanLog(text);
  assert.deepEqual([...parsed.get(100)!.rings].sort(), [
    "labeled>B>labeled",
    "legacy>A>legacy",
  ]);
  assert.equal(parsed.get(100)?.events.solvePositive, 1);
  assert.equal(parsed.get(100)?.events.submitted, 1);
  assert.equal(parsed.get(101)?.rings.size ?? 0, 0);
});

test("legacy warmedV2V3 marker still starts an unlabelled pass", () => {
  const text = [
    "[searcher/blockscan] block=200 warmedV2V3=3 warmedCurve=1 v3TickMeta=2 protocolMids=2",
    "[searcher/blockscan]   solve ring=A>B>A net=null error=no_quote standing=false protoRing=false",
    "[searcher/blockscan] block=201 skipped=busy",
    "[searcher/blockscan] block=200 scannedPairs=10 candidates=1 quotePositive=0 bestNet=null warmedV2V3=3 protocolMids=2 skippedVenues=0 ms=10",
    "[searcher/blockscan] block=200 stage warm_curve=2ms solve=8ms total=10ms",
  ].join("\n");

  assert.deepEqual([...parseBlockScanLog(text).get(200)!.rings], ["A>B>A"]);
});

test("event regression from a zero A baseline contradicts instead of becoming inconclusive", () => {
  const b = log(100).split("\n").flatMap((line) => line.includes("scannedPairs=")
    ? [line, "[searcher/blockscan]   final sim rejected ring=x route=y error=z"]
    : [line]).join("\n");
  const result = compareBlockScanLogs(log(100), b, {
    metric: "event.finalSimRejected",
    direction: "lower",
    aggregate: "mean",
    minPairedBlocks: 4,
    warmupBlocks: 2,
    minImprovementPct: 0,
    minAbsoluteDelta: 1,
    maxRegressionPct: 5,
    requireOutputMatch: false,
  });
  assert.equal(result.script_assessment, "contradicts");
});

test("comparator catches solve-ring drift even when aggregate summaries match", () => {
  const a = log(100).split("\n").flatMap((line) => line.includes("scannedPairs=")
    ? [line, "[searcher/blockscan]   solve ring=A>B>A net=null error=no_quote standing=false protoRing=false"]
    : [line]).join("\n");
  const b = log(100).split("\n").flatMap((line) => line.includes("scannedPairs=")
    ? [line, "[searcher/blockscan]   solve ring=A>C>A net=null error=no_quote standing=false protoRing=false"]
    : [line]).join("\n");
  const result = compareBlockScanLogs(a, b, {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 0, minAbsoluteDelta: 0, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  assert.equal(result.script_assessment, "contradicts");
  assert.deepEqual(result.ring_set_mismatch_blocks, [102, 103, 104, 105]);
  assert.equal(result.output_mismatches, 4);
});

test("next-block busy logs do not steal solve lines from the active pass", () => {
  const shared = [
    "[searcher/blockscan] block=100 warm=incremental changed=1 changedCurve=0 range=100-100 logs=1",
    "[searcher/blockscan]   solve ring=A>B>A net=null error=no_quote standing=false protoRing=false",
  ];
  const tail = [
    "[searcher/blockscan]   solve ring=A>C>A net=null error=no_quote standing=false protoRing=false",
    "[searcher/blockscan] block=100 scannedPairs=10 candidates=2 quotePositive=0 bestNet=null warmedV2V3=3 protocolMids=2 skippedVenues=0 ms=100",
    "[searcher/blockscan] block=100 stage warm_curve=2ms solve=98ms total=100ms solve_planner=0ms solve_solver=98ms solve_submit=0ms",
  ];
  const a = [...shared, "[searcher/blockscan] block=101 skipped=busy", ...tail].join("\n");
  const b = [...shared, ...tail].join("\n");
  const parsed = parseBlockScanLog(a);
  assert.deepEqual([...parsed.get(100)!.rings].sort(), ["A>B>A", "A>C>A"]);
  assert.equal(parsed.get(101)?.rings.size ?? 0, 0);

  const result = compareBlockScanLogs(a, b, {
    goal: "equivalence",
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 1,
    warmupBlocks: 0, minImprovementPct: 0, minAbsoluteDelta: 0, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  assert.equal(result.script_assessment, "supports");
  assert.deepEqual(result.ring_set_mismatch_blocks, []);
});

test("legacy warmedV2V3 pass markers keep pre-summary solve attribution", () => {
  const legacy = (ring: string) => [
    "[searcher/blockscan] block=100 warmedV2V3=3 warmedCurve=1 v3TickMeta=2 protocolMids=2",
    `[searcher/blockscan]   solve ring=${ring} net=null error=no_quote standing=false protoRing=false`,
    "[searcher/blockscan] block=101 skipped=busy",
    "[searcher/blockscan] block=100 scannedPairs=10 candidates=1 quotePositive=0 bestNet=null warmedV2V3=3 protocolMids=2 skippedVenues=0 ms=100",
    "[searcher/blockscan] block=100 stage warm_curve=2ms solve=98ms total=100ms solve_planner=0ms solve_solver=98ms solve_submit=0ms",
  ].join("\n");
  const result = compareBlockScanLogs(legacy("A>B>A"), legacy("DIFFERENT"), {
    goal: "equivalence",
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 1,
    warmupBlocks: 0, minImprovementPct: 0, minAbsoluteDelta: 0, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  assert.equal(result.script_assessment, "contradicts");
  assert.deepEqual(result.ring_set_mismatch_blocks, [100]);
});

test("comparator excludes budget-censored blocks before warmup and pairing", () => {
  const a = [
    log(100),
    "[searcher/blockscan] block=102 pass_budget_exceeded stage=solve elapsed=11001ms budget=11000ms",
  ].join("\n");
  const result = compareBlockScanLogs(a, log(80), {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 3,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  assert.deepEqual(result.budget_censored_blocks, [102]);
  assert.equal(result.warmup_blocks_excluded, 2);
  assert.equal(result.paired_blocks, 3);
  assert.deepEqual(result.paired_block_range, { from: 103, to: 105 });
});

test("comparator excludes catch-up and full-warm blocks with unequal cache history", () => {
  const withWarm = (text: string, catchupBlock?: number, fullWarmBlock?: number) => text
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/block=(\d+) scannedPairs=/);
      if (!match) return [line];
      const block = Number(match[1]);
      if (block === catchupBlock) {
        return [
          `[searcher/blockscan] block=${block} warm=incremental changed=2 changedCurve=0 range=${block - 1}-${block} logs=2`,
          line.replace("skippedVenues=0", "skippedVenues=10"),
        ];
      }
      if (block === fullWarmBlock) {
        return [`[searcher/blockscan] block=${block} warm=full reason=interval`, line];
      }
      return [`[searcher/blockscan] block=${block} warm=incremental changed=1 changedCurve=0 range=${block}-${block} logs=1`, line];
    })
    .join("\n");
  const result = compareBlockScanLogs(
    withWarm(log(100)),
    withWarm(log(100), 102, 103),
    {
      goal: "equivalence",
      metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 2,
      warmupBlocks: 2, minImprovementPct: 0, minAbsoluteDelta: 0, maxRegressionPct: 5,
      requireOutputMatch: true,
    },
  );
  assert.deepEqual(result.catchup_censored_blocks, [102]);
  assert.deepEqual(result.full_warm_censored_blocks, [103]);
  assert.equal(result.paired_blocks, 2);
  assert.equal(result.script_assessment, "supports");
  assert.equal(result.output_mismatches, 0);
});

test("equivalence mode supports identical semantic outputs without metric cherry-picking", () => {
  const result = compareBlockScanLogs(log(100), log(101), {
    goal: "equivalence",
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  assert.equal(result.comparison_goal, "equivalence");
  assert.equal(result.script_assessment, "supports");
  assert.equal(result.output_mismatches, 0);
});

test("comparison CLI binds its output to a manual verdict written first", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-manual-first-"));
  const a = path.join(tmp, "a.log");
  const b = path.join(tmp, "b.log");
  const manualPath = path.join(tmp, "manual.json");
  const out = path.join(tmp, "compare.json");
  fs.writeFileSync(a, log(100));
  fs.writeFileSync(b, log(80));
  const guard = path.resolve("../scripts/hooks/guard-ab-manual-first.py");
  const comparatorCommand = `npm run ab-canary-compare -- --a-log ${a} --b-log ${b} --manual-verdict ${manualPath} --out ${out}`;
  const blocked = spawnSync("python3", [guard], {
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: comparatorCommand } }),
  });
  assert.equal(blocked.status, 2, "canonical comparator must be blocked before the manual seal exists");
  const sealed = spawnSync(process.execPath, [
    "--import", "tsx", "src/cli/ab-manual-verdict.ts",
    "--experiment", "manual-first", "--author", "agent", "--verdict", "win",
    "--evidence", "independent causal analysis", "--a-log", a, "--b-log", b, "--out", manualPath,
  ], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(sealed.status, 0, sealed.stderr);
  const manual = JSON.parse(fs.readFileSync(manualPath, "utf8"));
  const allowed = spawnSync("python3", [guard], {
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: comparatorCommand } }),
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "src/cli/ab-canary-compare.ts",
    "--a-log", a, "--b-log", b, "--manual-verdict", manualPath, "--out", out,
    "--min-paired-blocks", "4", "--warmup-blocks", "0",
  ], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const artifact = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(artifact.manual_verdict_written_at, manual.written_at);
  assert.match(artifact.manual_verdict_sha256, /^[a-f0-9]{64}$/);
  assert.ok(Date.parse(artifact.comparator_started_at) > Date.parse(manual.written_at));
  assert.equal(artifact.a_log_sha256, manual.a_log_sha256);
  assert.equal(artifact.b_log_sha256, manual.b_log_sha256);

  const rewrite = spawnSync(process.execPath, [
    "--import", "tsx", "src/cli/ab-manual-verdict.ts",
    "--experiment", "manual-first", "--author", "agent", "--verdict", "win",
    "--evidence", "rewrite", "--a-log", a, "--b-log", b, "--out", manualPath,
  ], { cwd: path.resolve("."), encoding: "utf8" });
  assert.notEqual(rewrite.status, 0, "trusted manual artifact must be write-once");

  const missing = spawnSync(process.execPath, [
    "--import", "tsx", "src/cli/ab-canary-compare.ts", "--a-log", a, "--b-log", b, "--out", out,
  ], { cwd: path.resolve("."), encoding: "utf8" });
  assert.notEqual(missing.status, 0);
});

function experiment(tmp: string, artifact: AbCompareResult): AbExperiment {
  fs.writeFileSync(path.join(tmp, "compare.json"), JSON.stringify(artifact));
  return {
    schema_version: 2,
    experiment_id: "ab-test-1",
    problem_id: "LC-123",
    branch: "ab/test-1",
    base_commit: "a".repeat(40),
    challenger_commit: "b".repeat(40),
    change_class: "performance",
    hypothesis: "reduce total block-scan time",
    input_mode: "shared",
    expected_runtime_view_delta: false,
    allowed_config_delta: [],
    a: {
      commit: "a".repeat(40),
      config_hash: "c".repeat(64),
      universe_hash: "d".repeat(64),
      discovery_to_block: 100,
      blockscan_view_hash: "e".repeat(64),
      blockscan_graph_hash: "f".repeat(64),
    },
    b: {
      commit: "b".repeat(40),
      config_hash: "c".repeat(64),
      universe_hash: "d".repeat(64),
      discovery_to_block: 100,
      blockscan_view_hash: "e".repeat(64),
      blockscan_graph_hash: "f".repeat(64),
    },
    window: { min_paired_blocks: 4, warmup_blocks: 2 },
    fairness: {
      same_block_window: true,
      paired_blocks: artifact.paired_blocks,
      champion_restart_delta: 0,
      champion_pid_changed: false,
      challenger_restarts: 0,
      a_universe_hash_after: "d".repeat(64),
      b_universe_hash_after: "d".repeat(64),
      a_blockscan_view_hash_after: "e".repeat(64),
      b_blockscan_view_hash_after: "e".repeat(64),
      a_blockscan_graph_hash_after: "f".repeat(64),
      b_blockscan_graph_hash_after: "f".repeat(64),
    },
    deterministic_gate: { result: "not_applicable", evidence: "metrics-only performance change" },
    analysis: {
      agent_manual_author: "orchestrator-fable",
      agent_manual_verdict: "win",
      agent_manual_evidence: "paired stage lines agree with the measured improvement",
      agent_manual_written_at: "2026-07-14T01:00:00.000Z",
      agent_manual_artifact: "manual.json",
      agent_manual_artifact_sha256: "a".repeat(64),
      comparator_started_at: "2026-07-14T01:05:00.000Z",
      script_exit_code: 0,
      script_assessment: artifact.script_assessment,
      script_artifact: "compare.json",
      reconciliation: "agree",
      tool_selection: {
        capability_query: ["single-transaction", "causality"],
        selected_tools: ["analysis:bundle-postmortem"],
        catalog_check_exit_code: 0,
        evidence_manifest: "tools.json",
        evidence_manifest_sha256: "a".repeat(64),
      },
    },
    final_verdict: "win",
    branch_action: "pending_merge",
    b_stopped: true,
    evidence_bundle: "redacted A/B report and compare.json",
    mergeability: {
      current_main_commit: "a".repeat(40),
      tested_base_is_current: true,
      evidence: "origin/main still equals the tested base",
    },
  };
}

function productionCandidate(tmp: string): AbExperiment {
  const artifact = compareBlockScanLogs(log(100), log(80), {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  const value = experiment(tmp, artifact);
  value.schema_version = 3;
  value.window.measured_from_block = 100;
  value.window.measured_to_block = 109;
  value.change_class = "capability";
  value.lane_mode = "dual";
  value.deterministic_gate = { result: "pass", evidence: "pinned block-scan replay advances the same sample" };
  value.production_evidence = {
    searcher_behavior_change: true,
    strategy_kind: "block-scan",
    trigger_kind: "standing-state",
    route_scope: "dex-permissionless-protocol",
    position_conserving: true,
    posture: {
      victim_dependent: false,
      keeper: false,
      inventory: false,
      private_path: false,
      credit: false,
      sandwich: false,
      jit_lp: false,
    },
    sample: {
      tx_hash: `0x${"1".repeat(64)}`,
      block_number: 25_519_817,
      expected_net_profit_usd: 1.65,
      evidence: "priced terminal deltas prove positive net profit and no preceding victim dependency",
      expected_route: [
        {
          adapterId: "univ3-swap", slotKind: "swap", tokenIn: "0x01", tokenOut: "0x02", target: "0x03",
        },
        {
          adapterId: "protocol-redeem", slotKind: "protocol", tokenIn: "0x02", tokenOut: "0x01", target: "0x04",
        },
      ],
    },
    classification_review: {
      verdict: "pass",
      reviewer: "fresh-non-author",
      evidence: "independent trace confirms standing-state block-scan, conservation, and current route scope",
    },
    baseline_stage: "not_admitted",
    challenger_stage: "path_found",
    replay: {
      result: "pass",
      cwd: "listener",
      argv: ["node", "--import", "tsx", "src/searcher/test/blockscan-hunt.ts"],
      evidence: "the same tx/block changes not_admitted to path_found",
    },
  };
  value.resolution_replay = {
    cwd: "listener",
    argv: ["node", "src/searcher/test/pinned-production-gap.mjs"],
    timeout_seconds: 1200,
    expected_transition: "same pinned sample advances one production stage",
  };
  return value;
}

test("production candidate schema accepts a dual-lane stage-advancing block-scan declaration", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-production-gate-"));
  assert.deepEqual(validateAbProductionCandidate(productionCandidate(tmp)), []);
});

test("production candidate requires one complete closed route for scanner and backrun", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-production-route-"));
  const missing = productionCandidate(tmp);
  delete missing.production_evidence!.sample.expected_route;
  assert.ok(validateAbProductionCandidate(missing)
    .some((error) => error.includes("expected_route with 2..8")));

  const wrongScope = productionCandidate(tmp);
  wrongScope.production_evidence!.route_scope = "dex-dex";
  assert.ok(validateAbProductionCandidate(wrongScope)
    .some((error) => error.includes("slot kinds")));

  const brokenLoop = productionCandidate(tmp);
  brokenLoop.production_evidence!.sample.expected_route![1].tokenOut = "0x05";
  assert.ok(validateAbProductionCandidate(brokenLoop)
    .some((error) => error.includes("closed token loop")));
});

test("production candidate gate rejects blockscan-only Hermes deployment", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-production-gate-"));
  const value = productionCandidate(tmp);
  value.lane_mode = "blockscan-only";
  assert.ok(validateAbProductionCandidate(value, { laneMode: "blockscan-only" })
    .some((error) => error.includes("requires lane_mode=dual")));
});

test("production candidate gate rejects victim-dependent backrun and keeper postures", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-production-gate-"));
  const value = productionCandidate(tmp);
  value.production_evidence!.trigger_kind = "standing-state";
  value.production_evidence!.posture.victim_dependent = true;
  value.production_evidence!.posture.keeper = true;
  const errors = validateAbProductionCandidate(value);
  assert.ok(errors.some((error) => error.includes("victim_dependent")));
  assert.ok(errors.some((error) => error.includes("keeper")));
});

test("production candidate schema accepts a reviewed oracle-triggered backrun in dual mode", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-production-gate-"));
  const value = productionCandidate(tmp);
  value.lane_mode = "dual";
  value.production_evidence!.strategy_kind = "backrun";
  value.production_evidence!.trigger_kind = "oracle-update";
  value.production_evidence!.posture.victim_dependent = true;
  value.production_evidence!.challenger_stage = "final_sim_success";
  value.production_evidence!.sample.victim_tx_hash = `0x${"2".repeat(64)}`;
  value.production_evidence!.sample.expected_route = [
    { adapterId: "univ3-swap", slotKind: "swap", tokenIn: "0x01", tokenOut: "0x02", target: "0x03" },
    { adapterId: "protocol-redeem", slotKind: "protocol", tokenIn: "0x02", tokenOut: "0x01", target: "0x04" },
  ];
  value.production_evidence!.sample.oracle_route_edge_index = 1;
  value.production_evidence!.replay.argv = ["node", "--import", "tsx", "src/searcher/test/backrun-hunt.ts"];
  assert.deepEqual(validateAbProductionCandidate(value, { laneMode: "dual" }), []);
});

test("oracle-triggered backrun requires a route-bound oracle edge", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-production-gate-"));
  const value = productionCandidate(tmp);
  value.lane_mode = "dual";
  value.production_evidence!.strategy_kind = "backrun";
  value.production_evidence!.trigger_kind = "oracle-update";
  value.production_evidence!.posture.victim_dependent = true;
  value.production_evidence!.challenger_stage = "final_sim_success";
  value.production_evidence!.sample.victim_tx_hash = `0x${"2".repeat(64)}`;
  value.production_evidence!.sample.expected_route = [
    { adapterId: "univ3-swap", slotKind: "swap", tokenIn: "0x01", tokenOut: "0x02", target: "0x03" },
    { adapterId: "protocol-redeem", slotKind: "protocol", tokenIn: "0x02", tokenOut: "0x01", target: "0x04" },
  ];
  value.production_evidence!.replay.argv = ["node", "--import", "tsx", "src/searcher/test/backrun-hunt.ts"];
  assert.ok(validateAbProductionCandidate(value, { laneMode: "dual" })
    .some((error) => error.includes("oracle_route_edge_index")));
});

test("backrun candidate is rejected outside the explicit dual lane", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-production-gate-"));
  const value = productionCandidate(tmp);
  value.production_evidence!.strategy_kind = "backrun";
  value.production_evidence!.trigger_kind = "victim-swap";
  value.production_evidence!.posture.victim_dependent = true;
  value.production_evidence!.sample.victim_tx_hash = `0x${"2".repeat(64)}`;
  value.production_evidence!.sample.expected_route = [
    { adapterId: "univ2-swap", slotKind: "swap", tokenIn: "0x01", tokenOut: "0x02", target: "0x03" },
    { adapterId: "univ3-swap", slotKind: "swap", tokenIn: "0x02", tokenOut: "0x01", target: "0x04" },
  ];
  value.production_evidence!.replay.argv = ["node", "--import", "tsx", "src/searcher/test/backrun-hunt.ts"];
  const errors = validateAbProductionCandidate(value, { laneMode: "blockscan-only" });
  assert.ok(errors.some((error) => error.includes("lane_mode=dual")));
});

test("identical-code infrastructure shakedown has a separate fail-closed candidate path", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-production-gate-"));
  const value = productionCandidate(tmp);
  value.lane_mode = "dual";
  value.infrastructure_shakedown = true;
  value.deterministic_gate = { result: "not_applicable", evidence: "identical runtime tree" };
  delete value.production_evidence;
  assert.deepEqual(validateAbProductionCandidate(value, { laneMode: "dual", shakedown: true }), []);
  value.input_mode = "challenger";
  assert.ok(validateAbProductionCandidate(value, { laneMode: "dual", shakedown: true })
    .some((error) => error.includes("input_mode=shared")));
  value.input_mode = "shared";
  value.allowed_config_delta = ["SEARCHER_MAX_CANDIDATES"];
  assert.ok(validateAbProductionCandidate(value, { laneMode: "dual", shakedown: true })
    .some((error) => error.includes("allowed_config_delta=[]")));
  value.allowed_config_delta = [];
  value.expected_runtime_view_delta = true;
  assert.ok(validateAbProductionCandidate(value, { laneMode: "dual", shakedown: true })
    .some((error) => error.includes("expected_runtime_view_delta=false")));
});

test("successful infrastructure shakedown can close without pretending to be a production change", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-shakedown-close-"));
  const artifact = compareBlockScanLogs(log(100), log(101), {
    goal: "equivalence",
    metric: "total_ms",
    direction: "lower",
    aggregate: "p50",
    minPairedBlocks: 4,
    warmupBlocks: 2,
    minImprovementPct: 0,
    minAbsoluteDelta: 0,
    maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  const value = experiment(tmp, artifact);
  value.schema_version = 3;
  value.change_class = "performance";
  value.lane_mode = "dual";
  value.infrastructure_shakedown = true;
  value.deterministic_gate = { result: "not_applicable", evidence: "identical runtime tree" };
  value.window.measured_from_block = 100;
  value.window.measured_to_block = 103;
  value.final_verdict = "win";
  value.branch_action = "pending_merge";
  value.mergeability = {
    current_main_commit: value.base_commit,
    tested_base_is_current: true,
    evidence: "origin/main still equals the tested base",
  };
  assert.deepEqual(validateAbExperiment(value, path.join(tmp, "report.md"), "decision"), []);
  const outside = path.join(path.dirname(tmp), `${path.basename(tmp)}-outside.json`);
  fs.writeFileSync(outside, JSON.stringify(artifact));
  value.analysis.script_artifact = outside;
  assert.ok(validateAbExperiment(value, path.join(tmp, "report.md"), "decision")
    .some((error) => error.includes("schema-v3 report artifact must be report-relative")));
});

test("production candidate gate rejects analysis-only or metric-only challengers", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-production-gate-"));
  const value = productionCandidate(tmp);
  value.production_evidence!.searcher_behavior_change = false;
  value.production_evidence!.challenger_stage = value.production_evidence!.baseline_stage;
  const errors = validateAbProductionCandidate(value);
  assert.ok(errors.some((error) => error.includes("analysis-only")));
  assert.ok(errors.some((error) => error.includes("advance at least one production stage")));
});

test("stage-advance switch defaults on and can disable only that assertion", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-stage-switch-"));
  const defaultOn = productionCandidate(tmp);
  defaultOn.production_evidence!.challenger_stage = defaultOn.production_evidence!.baseline_stage;
  assert.ok(validateAbProductionCandidate(defaultOn)
    .some((error) => error.includes("advance at least one production stage")));

  const disabled = productionCandidate(tmp);
  disabled.require_stage_advance = false;
  disabled.production_evidence!.challenger_stage = disabled.production_evidence!.baseline_stage;
  assert.deepEqual(
    validateAbProductionCandidate(disabled, { requireStageAdvance: false }),
    [],
  );

  disabled.deterministic_gate.result = "fail";
  assert.ok(validateAbProductionCandidate(disabled, { requireStageAdvance: false })
    .some((error) => error.includes("deterministic_gate.result=pass")));
  disabled.deterministic_gate.result = "pass";

  assert.ok(validateAbProductionCandidate(disabled, { requireStageAdvance: true })
    .some((error) => error.includes("require_stage_advance does not match")));
});

test("production candidate gate requires indexed tool selection evidence", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-production-gate-"));
  const value = productionCandidate(tmp);
  delete value.analysis.tool_selection;
  assert.ok(validateAbProductionCandidate(value).some((error) => error.includes("tool_selection")));
});

test("production candidate gate binds deployment identity and requires a passing deterministic gate", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-production-gate-"));
  const value = productionCandidate(tmp);
  value.deterministic_gate.result = "fail";
  const errors = validateAbProductionCandidate(value, {
    experimentId: "different-experiment",
    branch: "ab/different-branch",
    baseCommit: "f".repeat(40),
    challengerCommit: "e".repeat(40),
    expectedRuntimeViewDelta: true,
    inputMode: "challenger",
    allowedConfigDelta: ["SEARCHER_BLOCKSCAN_MAX_CANDIDATES"],
  });
  assert.ok(errors.some((error) => error.includes("deterministic_gate.result=pass")));
  assert.ok(errors.some((error) => error.includes("experiment_id")));
  assert.ok(errors.some((error) => error.includes("branch")));
  assert.ok(errors.some((error) => error.includes("base_commit")));
  assert.ok(errors.some((error) => error.includes("challenger_commit")));
  assert.ok(errors.some((error) => error.includes("expected_runtime_view_delta")));
  assert.ok(errors.some((error) => error.includes("input_mode")));
  assert.ok(errors.some((error) => error.includes("allowed_config_delta")));
});

test("production candidates cannot hide a safety-sensitive config change", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-production-gate-"));
  const value = productionCandidate(tmp);
  value.allowed_config_delta = ["SEARCHER_MIN_NET_ETH"];
  assert.ok(validateAbProductionCandidate(value)
    .some((error) => error.includes("forbids config deltas")));
});

test("schema v3 failed replay may close honestly as needs_escalation", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-production-gate-"));
  const value = productionCandidate(tmp);
  value.production_evidence!.replay.result = "fail";
  value.deterministic_gate = { result: "fail", evidence: "pinned sample did not advance" };
  value.final_verdict = "needs_escalation";
  value.branch_action = "retained";
  value.b_stopped = true;
  const errors = validateAbExperiment(value, path.join(tmp, "report.md"), "close");
  assert.deepEqual(errors, []);
});

test("schema v3 mechanically requires manual judgment before the comparator starts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-production-gate-"));
  const value = productionCandidate(tmp);
  value.analysis.agent_manual_written_at = "2026-07-14T01:06:00.000Z";
  value.analysis.comparator_started_at = "2026-07-14T01:05:00.000Z";
  assert.ok(validateAbExperiment(value, path.join(tmp, "report.md"), "decision")
    .some((error) => error.includes("must be earlier")));
});

test("historical schema v2 remains readable but cannot deploy as a new candidate", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-production-gate-"));
  const artifact = compareBlockScanLogs(log(100), log(80), {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  const value = experiment(tmp, artifact);
  assert.ok(validateAbProductionCandidate(value).some((error) => error.includes("schema_version=3")));
  assert.deepEqual(validateAbExperiment(value, path.join(tmp, "report.md"), "decision"), []);
});

test("gate authorizes a supported win and requires cleanup at close", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-gate-"));
  const artifact = compareBlockScanLogs(log(100), log(80), {
    metric: "total_ms",
    direction: "lower",
    aggregate: "p50",
    minPairedBlocks: 4,
    warmupBlocks: 2,
    minImprovementPct: 10,
    minAbsoluteDelta: 10,
    maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  const value = experiment(tmp, artifact);
  assert.deepEqual(validateAbExperiment(value, path.join(tmp, "report.md"), "decision"), []);
  value.branch_action = "merged_deleted";
  value.merge_commit = "e".repeat(40);
  assert.deepEqual(validateAbExperiment(value, path.join(tmp, "report.md"), "close"), []);
});

test("disagreement cannot decide without a fresh non-author adversarial reviewer", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-gate-"));
  const artifact = compareBlockScanLogs(log(100), log(80), {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  const value = experiment(tmp, artifact);
  value.analysis.agent_manual_verdict = "lose";
  value.analysis.reconciliation = "disagree";
  assert.ok(validateAbExperiment(value, path.join(tmp, "report.md"), "decision")
    .some((error) => error.includes("fresh non-author adversarial review")));
});

test("agent may accept a semantic fix despite a contradictory raw metric after adversarial review", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-gate-"));
  const artifact = compareBlockScanLogs(log(100), log(120), {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: false,
  });
  assert.equal(artifact.script_assessment, "contradicts");
  const value = experiment(tmp, artifact);
  value.change_class = "correctness";
  value.deterministic_gate = { result: "pass", evidence: "pinned honeypot fixture moves final-sim reject to admission skip" };
  value.analysis.agent_manual_evidence = "B removes the known false-positive route even though total_ms rises";
  value.analysis.reconciliation = "disagree";
  value.analysis.adversarial_review = {
    verdict: "win",
    evidence: "fresh reviewer confirmed the worse timing is caused by preserving valid candidates while removing the honeypot",
    reviewer: "fresh-opus",
  };
  assert.deepEqual(validateAbExperiment(value, path.join(tmp, "report.md"), "decision"), []);
});

test("capability win always requires a fresh non-author reviewer", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-gate-"));
  const artifact = compareBlockScanLogs(log(100), log(80), {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  const value = experiment(tmp, artifact);
  value.change_class = "capability";
  value.deterministic_gate = { result: "pass", evidence: "pinned route flips to positive final sim" };
  assert.ok(validateAbExperiment(value, path.join(tmp, "report.md"), "decision")
    .some((error) => error.includes("fresh non-author adversarial review")));
  value.analysis.adversarial_review = {
    verdict: "win",
    evidence: "fresh reviewer replayed the pinned route and confirmed the new capability",
    reviewer: "fresh-opus",
  };
  assert.deepEqual(validateAbExperiment(value, path.join(tmp, "report.md"), "decision"), []);
});

test("unresolved work retains the branch and closes the B slot", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-gate-"));
  const artifact = compareBlockScanLogs(log(100), log(99), {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  const value = experiment(tmp, artifact);
  value.analysis.agent_manual_verdict = "inconclusive";
  value.analysis.script_assessment = "inconclusive";
  value.analysis.reconciliation = "inconclusive";
  value.analysis.adversarial_review = {
    verdict: "inconclusive",
    evidence: "fresh review could not separate noise from effect",
    reviewer: "fresh-opus",
  };
  value.final_verdict = "needs_escalation";
  value.branch_action = "retained";
  assert.deepEqual(validateAbExperiment(value, path.join(tmp, "report.md"), "close"), []);
  value.branch_action = "deleted_unmerged";
  assert.ok(validateAbExperiment(value, path.join(tmp, "report.md"), "close")
    .some((error) => error.includes("branch_action must be retained|resolved_deleted")));
});

test("a causally winning challenger is retained when current main is no longer the tested base", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-gate-"));
  const artifact = compareBlockScanLogs(log(100), log(120), {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: false,
  });
  const value = experiment(tmp, artifact);
  value.change_class = "capability";
  value.deterministic_gate = { result: "pass", evidence: "same failing replay flips to positive execution" };
  value.analysis.reconciliation = "disagree";
  value.analysis.adversarial_review = {
    verdict: "win",
    evidence: "the replay proves capability and paired live shows no semantic regression",
    reviewer: "fresh-non-author",
  };
  value.final_verdict = "needs_escalation";
  value.branch_action = "retained";
  value.mergeability = {
    current_main_commit: "9".repeat(40),
    tested_base_is_current: false,
    evidence: "origin/main advanced during the measurement; HERMES requires a retest",
  };
  assert.deepEqual(validateAbExperiment(value, path.join(tmp, "report.md"), "decision"), []);
});

test("schema v2 cannot authorize a win when mergeability evidence is omitted", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-gate-"));
  const artifact = compareBlockScanLogs(log(100), log(80), {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  const value = experiment(tmp, artifact);
  delete value.mergeability;
  assert.ok(validateAbExperiment(value, path.join(tmp, "report.md"), "decision")
    .some((error) => error.includes("requires mergeability evidence")));
});

test("a later main fix may archive a previously escalated branch", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-gate-"));
  const artifact = compareBlockScanLogs(log(100), log(99), {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  const value = experiment(tmp, artifact);
  value.analysis.agent_manual_verdict = "inconclusive";
  value.analysis.script_assessment = "inconclusive";
  value.analysis.reconciliation = "inconclusive";
  value.analysis.adversarial_review = {
    verdict: "inconclusive",
    evidence: "the original window could not separate noise from effect",
    reviewer: "fresh-opus",
  };
  value.final_verdict = "needs_escalation";
  value.branch_action = "resolved_deleted";
  assert.ok(validateAbExperiment(value, path.join(tmp, "report.md"), "close")
    .some((error) => error.includes("resolved_by_commit")));
  value.resolution = {
    resolved_by_commit: "9".repeat(40),
    evidence: "later identical-code replay proves the parser fix on main",
  };
  assert.deepEqual(validateAbExperiment(value, path.join(tmp, "report.md"), "close"), []);
});

test("resolved archive preserves an original escalation after later evidence becomes decisive", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-gate-"));
  const artifact = compareBlockScanLogs(log(100), log(80), {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  const value = experiment(tmp, artifact);
  value.final_verdict = "needs_escalation";
  value.branch_action = "resolved_deleted";
  value.resolution = {
    resolved_by_commit: "9".repeat(40),
    evidence: "later corrected adjudicator validates the retained experiment",
  };
  assert.deepEqual(validateAbExperiment(value, path.join(tmp, "report.md"), "close"), []);
});

test("a hard deterministic veto may retain a metric winner without falsifying the manual verdict", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-gate-"));
  const artifact = compareBlockScanLogs(log(100), log(80), {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  const value = experiment(tmp, artifact);
  value.change_class = "correctness";
  value.deterministic_gate = { result: "fail", evidence: "pinned replay still fails" };
  value.final_verdict = "needs_escalation";
  value.branch_action = "retained";
  assert.deepEqual(validateAbExperiment(value, path.join(tmp, "report.md"), "close"), []);
});

test("schema v2 rejects unplanned runtime graph drift", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-gate-"));
  const artifact = compareBlockScanLogs(log(100), log(80), {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  const value = experiment(tmp, artifact);
  value.b.blockscan_graph_hash = "0".repeat(64);
  value.fairness.b_blockscan_graph_hash_after = "0".repeat(64);
  assert.ok(validateAbExperiment(value, path.join(tmp, "report.md"), "decision")
    .some((error) => error.includes("unless a delta was predeclared")));
});

test("legacy schema v1 may retain evidence but cannot authorize a decisive verdict", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-gate-"));
  const artifact = compareBlockScanLogs(log(100), log(80), {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  const value = experiment(tmp, artifact);
  value.schema_version = 1;
  assert.ok(validateAbExperiment(value, path.join(tmp, "report.md"), "decision")
    .some((error) => error.includes("required for every decisive")));
  value.analysis.agent_manual_verdict = "inconclusive";
  value.analysis.script_exit_code = 1;
  value.analysis.script_assessment = "inconclusive";
  value.analysis.reconciliation = "inconclusive";
  value.analysis.adversarial_review = {
    verdict: "inconclusive",
    evidence: "legacy evidence remains available for escalation",
    reviewer: "fresh-opus",
  };
  value.final_verdict = "needs_escalation";
  value.branch_action = "retained";
  assert.deepEqual(validateAbExperiment(value, path.join(tmp, "report.md"), "close"), []);
});

test("schema v2 permits a predeclared capability graph delta only with replay proof", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-gate-"));
  const artifact = compareBlockScanLogs(log(100), log(80), {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  const value = experiment(tmp, artifact);
  value.change_class = "capability";
  value.expected_runtime_view_delta = true;
  value.b.blockscan_graph_hash = "0".repeat(64);
  value.fairness.b_blockscan_graph_hash_after = "0".repeat(64);
  value.deterministic_gate = { result: "pass", evidence: "pinned pool enters graph and route sim succeeds" };
  value.analysis.adversarial_review = {
    verdict: "win",
    evidence: "fresh reviewer confirmed the graph delta is exactly the pinned capability",
    reviewer: "fresh-opus",
  };
  assert.deepEqual(validateAbExperiment(value, path.join(tmp, "report.md"), "decision"), []);
  value.deterministic_gate.result = "not_applicable";
  assert.ok(validateAbExperiment(value, path.join(tmp, "report.md"), "decision")
    .some((error) => error.includes("requires deterministic_gate.result=pass")));
});

test("parser reads the machine block", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-gate-"));
  const artifact = compareBlockScanLogs(log(100), log(80), {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  const value = experiment(tmp, artifact);
  const parsed = parseAbExperiment(`x\n\`\`\`ab_experiment\n${JSON.stringify(value)}\n\`\`\`\n`);
  assert.equal(parsed.experiment_id, value.experiment_id);
});

test("malformed journals fail closed without crashing the validator", () => {
  assert.deepEqual(validateAbExperiment({} as AbExperiment, "/tmp/report.md", "decision"), [
    "analysis object missing",
  ]);
});

test("schema-v3 report artifacts cannot escape docs/research/reports", () => {
  assert.equal(
    resolveAbReportArtifactPath("docs/research/reports/ab-x.md", "tools.json", "tool manifest"),
    "docs/research/reports/tools.json",
  );
  assert.equal(
    resolveAbReportArtifactPath("docs/research/reports/nested/ab-x.md", "../tools.json", "tool manifest"),
    "docs/research/reports/tools.json",
  );
  assert.throws(
    () => resolveAbReportArtifactPath("docs/research/reports/ab-x.md", "../stale-tools.json", "tool manifest"),
    /must stay under docs\/research\/reports/,
  );
  assert.throws(
    () => resolveAbReportArtifactPath("docs/research/ab-x.md", "tools.json", "tool manifest"),
    /report path must stay under docs\/research\/reports/,
  );
});

test("local schema-v3 artifacts cannot escape reports through a symlink", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-artifact-path-"));
  const reports = path.join(repo, "docs/research/reports");
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, "tools.json"), "{}\n");
  assert.equal(
    resolveAbLocalReportArtifactPath(repo, "docs/research/reports/tools.json"),
    fs.realpathSync(path.join(reports, "tools.json")),
  );
  assert.equal(
    readAbLocalReportArtifact(repo, "docs/research/reports/tools.json").toString("utf8"),
    "{}\n",
  );
  fs.writeFileSync(path.join(repo, "docs/research/stale-tools.json"), "{}\n");
  fs.symlinkSync("../stale-tools.json", path.join(reports, "escaped.json"));
  assert.throws(
    () => resolveAbLocalReportArtifactPath(repo, "docs/research/reports/escaped.json"),
    /resolves outside docs\/research\/reports/,
  );
  assert.throws(
    () => readAbLocalReportArtifact(repo, "docs/research/reports/escaped.json"),
    /resolves outside docs\/research\/reports/,
  );
});

test("cleanup gate verifies a real no-ff merge and actual local/remote branch deletion", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-cli-"));
  const remote = path.join(tmp, "remote.git");
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  git(["config", "user.email", "ab-test@example.invalid"]);
  git(["config", "user.name", "AB Test"]);
  fs.writeFileSync(path.join(repo, "file"), "base\n");
  git(["add", "file"]); git(["commit", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]);
  git(["remote", "add", "origin", remote]); git(["push", "-u", "origin", "main"]);
  git(["checkout", "-b", "ab/cli-lifecycle"]);
  fs.appendFileSync(path.join(repo, "file"), "challenger\n");
  git(["commit", "-am", "challenger"]);
  const challenger = git(["rev-parse", "HEAD"]);
  git(["push", "-u", "origin", "ab/cli-lifecycle"]);
  git(["checkout", "main"]); git(["merge", "--no-ff", "ab/cli-lifecycle", "-m", "merge challenger"]);
  const merge = git(["rev-parse", "HEAD"]); git(["push", "origin", "main"]);

  const artifact = compareBlockScanLogs(log(100), log(80), {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  const value = experiment(repo, artifact);
  value.branch = "ab/cli-lifecycle";
  value.base_commit = base; value.a.commit = base;
  value.challenger_commit = challenger; value.b.commit = challenger;
  value.mergeability = {
    current_main_commit: base,
    tested_base_is_current: true,
    evidence: "origin/main still equals the tested base before merge",
  };
  value.merge_commit = merge;
  const report = path.join(repo, "report.md");
  const writeReport = () => fs.writeFileSync(report, `\`\`\`ab_experiment\n${JSON.stringify(value)}\n\`\`\`\n`);
  writeReport();
  const analysisRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const cli = path.join(analysisRoot, "src/cli/ab-canary-gate.ts");
  const tsx = path.join(analysisRoot, "node_modules/tsx/dist/loader.mjs");
  const runGate = (phase: "decision" | "close", authorize = false) => spawnSync(
    process.execPath,
    ["--import", tsx, cli, report, "--phase", phase, ...(authorize ? ["--authorize-cleanup"] : [])],
    { cwd: repo, encoding: "utf8" },
  );
  const decision = runGate("decision", true);
  assert.equal(decision.status, 0, decision.stderr);
  git(["branch", "-D", "ab/cli-lifecycle"]); git(["push", "origin", "--delete", "ab/cli-lifecycle"]);
  value.branch_action = "merged_deleted";
  writeReport();
  const close = runGate("close");
  assert.equal(close.status, 0, close.stderr);
});

test("cleanup gate archives main-resolved escalated work without retaining the branch", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-resolved-cli-"));
  const remote = path.join(tmp, "remote.git");
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  git(["config", "user.email", "ab-test@example.invalid"]);
  git(["config", "user.name", "AB Test"]);
  fs.writeFileSync(path.join(repo, "file"), "base\n");
  git(["add", "file"]); git(["commit", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]);
  git(["remote", "add", "origin", remote]); git(["push", "-u", "origin", "main"]);
  git(["checkout", "-b", "ab/resolved-lifecycle"]);
  fs.appendFileSync(path.join(repo, "file"), "inconclusive challenger\n");
  git(["commit", "-am", "challenger"]);
  const challenger = git(["rev-parse", "HEAD"]);
  git(["push", "-u", "origin", "ab/resolved-lifecycle"]);
  git(["checkout", "main"]);
  fs.writeFileSync(path.join(repo, "fix"), "later validated fix\n");
  git(["add", "fix"]); git(["commit", "-m", "resolve gap"]);
  const resolvedBy = git(["rev-parse", "HEAD"]);

  const artifact = compareBlockScanLogs(log(100), log(99), {
    metric: "total_ms", direction: "lower", aggregate: "p50", minPairedBlocks: 4,
    warmupBlocks: 2, minImprovementPct: 10, minAbsoluteDelta: 10, maxRegressionPct: 5,
    requireOutputMatch: true,
  });
  const value = experiment(repo, artifact);
  value.branch = "ab/resolved-lifecycle";
  value.base_commit = base; value.a.commit = base;
  value.challenger_commit = challenger; value.b.commit = challenger;
  value.mergeability = {
    current_main_commit: resolvedBy,
    tested_base_is_current: false,
    evidence: "a later validated main commit resolves the retained experiment",
  };
  value.analysis.agent_manual_verdict = "inconclusive";
  value.analysis.script_assessment = "inconclusive";
  value.analysis.reconciliation = "inconclusive";
  value.analysis.adversarial_review = {
    verdict: "inconclusive",
    evidence: "original experiment required a later deterministic fix",
    reviewer: "fresh-opus",
  };
  value.final_verdict = "needs_escalation";
  value.branch_action = "resolved_deleted";
  value.resolution = {
    resolved_by_commit: resolvedBy,
    evidence: "later main replay validates the resolved parser behavior",
  };
  const report = path.join(repo, "report.md");
  const writeReport = () => fs.writeFileSync(report, `\`\`\`ab_experiment\n${JSON.stringify(value)}\n\`\`\`\n`);
  writeReport();
  git(["add", "report.md"]); git(["commit", "-m", "archive resolved A/B evidence"]); git(["push", "origin", "main"]);

  const analysisRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const cli = path.join(analysisRoot, "src/cli/ab-canary-gate.ts");
  const tsx = path.join(analysisRoot, "node_modules/tsx/dist/loader.mjs");
  const runGate = (authorize = false) => spawnSync(
    process.execPath,
    ["--import", tsx, cli, report, "--phase", "close", ...(authorize ? ["--authorize-cleanup"] : [])],
    { cwd: repo, encoding: "utf8" },
  );
  const authorize = runGate(true);
  assert.equal(authorize.status, 0, authorize.stderr);
  git(["branch", "-D", "ab/resolved-lifecycle"]); git(["push", "origin", "--delete", "ab/resolved-lifecycle"]);
  const close = runGate();
  assert.equal(close.status, 0, close.stderr);
});
