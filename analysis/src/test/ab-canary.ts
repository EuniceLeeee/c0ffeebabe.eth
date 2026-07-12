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
  validateAbExperiment,
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

function experiment(tmp: string, artifact: AbCompareResult): AbExperiment {
  fs.writeFileSync(path.join(tmp, "compare.json"), JSON.stringify(artifact));
  return {
    schema_version: 1,
    experiment_id: "ab-test-1",
    problem_id: "LC-123",
    branch: "ab/test-1",
    base_commit: "a".repeat(40),
    challenger_commit: "b".repeat(40),
    change_class: "performance",
    hypothesis: "reduce total block-scan time",
    input_mode: "shared",
    allowed_config_delta: [],
    a: { commit: "a".repeat(40), config_hash: "c".repeat(64), universe_hash: "d".repeat(64) },
    b: { commit: "b".repeat(40), config_hash: "c".repeat(64), universe_hash: "d".repeat(64) },
    window: { min_paired_blocks: 4, warmup_blocks: 2 },
    fairness: {
      same_block_window: true,
      paired_blocks: artifact.paired_blocks,
      champion_restart_delta: 0,
      champion_pid_changed: false,
      challenger_restarts: 0,
      a_universe_hash_after: "d".repeat(64),
      b_universe_hash_after: "d".repeat(64),
    },
    deterministic_gate: { result: "not_applicable", evidence: "metrics-only performance change" },
    analysis: {
      agent_manual_author: "orchestrator-fable",
      agent_manual_verdict: "win",
      agent_manual_evidence: "paired stage lines agree with the measured improvement",
      script_exit_code: 0,
      script_assessment: artifact.script_assessment,
      script_artifact: "compare.json",
      reconciliation: "agree",
    },
    final_verdict: "win",
    branch_action: "pending_merge",
    b_stopped: true,
    evidence_bundle: "redacted A/B report and compare.json",
  };
}

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
    .some((error) => error.includes("branch_action must be retained")));
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
