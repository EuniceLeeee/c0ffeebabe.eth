import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateExactProductionSwapPath } from "../ab-production-evidence.js";
import { cloneHistoricalGapValidationRoot } from "../historical-gap-git.js";
import {
  HISTORICAL_PRODUCTION_INSTANCE_ID,
  historicalValidationTrack,
  inferLiveSensitiveDiff,
  isHistoricalCandidateWorktree,
  parseHistoricalGap,
  resolveHistoricalReportArtifactPath,
  validateHistoricalBranchAuditCoverage,
  validateDirectMainPackageManifest,
  validateHistoricalDiffScope,
  validateHistoricalArtifactCommit,
  validateHistoricalGap,
  validateHistoricalMergeTree,
  validateHistoricalReplayRootEntries,
  validateHistoricalSmokeOutput,
  validateHistoricalSmokePlan,
  validateHistoricalUniverseBinding,
  trustedSsmTunnelReady,
  type HistoricalAuditInventory,
  type HistoricalGapRecord,
  type HistoricalProductionUniverseAttestation,
  type HistoricalUniverseProvenance,
} from "../historical-gap.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const HASH = "c".repeat(64);
const TX = `0x${"d".repeat(64)}`;
const VICTIM = `0x${"e".repeat(64)}`;

function record(overrides: Partial<HistoricalGapRecord> = {}): HistoricalGapRecord {
  return {
    schema_version: 1,
    gap_id: "gap-v4-admission",
    branch: "ab/gap-v4-admission",
    author: "author-agent",
    base_commit: SHA_A,
    challenger_commit: SHA_B,
    hypothesis: "The pinned profitable loop advances from not_admitted to final_sim_success.",
    components: ["detector"],
    branch_audit: {
      origin_main_commit: SHA_A,
      refs_sha256: HASH,
      prepare_receipt_sha256: HASH,
      matches: [],
      outcome: "no_prior_fix",
      evidence: "Audited all local and origin branches plus retained reports before creating this branch.",
    },
    samples: [{
      tx_hash: TX,
      block_number: 25_000_000,
      expected_net_profit_usd: 1.25,
      strategy_kind: "backrun",
      trigger_kind: "victim-swap",
      route_scope: "dex-dex",
      position_conserving: true,
      victim_tx_hash: VICTIM,
      evidence: "Canonical PnL and causal classification passed.",
      candidate_report: "docs/research/reports/sample.md",
      posture: {
        keeper: false,
        inventory: false,
        private_path: false,
        credit: false,
        sandwich: false,
        jit_lp: false,
      },
    }],
    validation: {
      build: { exit_code: 0, evidence: "analysis and listener build passed" },
      tests: { exit_code: 0, evidence: "targeted and regression tests passed" },
      toolchain_sha256: HASH,
      review: {
        reviewer: "fresh-reviewer",
        verdict: "pass",
        live_distribution_verdict: "none",
        base_commit: SHA_A,
        challenger_commit: SHA_B,
        diff_sha256: HASH,
        artifact: "docs/research/reports/review.json",
        artifact_sha256: HASH,
        reviewed_at: "2026-07-14T00:00:00.000Z",
        evidence: "Independent diff and replay review passed",
      },
      replay_environment: {
        universe_sha256: HASH,
        universe_provenance_artifact: "docs/research/reports/universe.json",
        universe_provenance_sha256: HASH,
        pool_universe_top_n: 6000,
      },
      smoke: { mode: "trusted-local-dry-run", duration_seconds: 600 },
    },
    decision: {
      status: "promote",
      claim: "fixed",
      branch_action: "pending_merge",
      evidence: "Pinned replay flipped and the dual-lane smoke stayed healthy.",
    },
    ...overrides,
  };
}

test("validation tracks are exclusive and derived from change components", () => {
  assert.equal(historicalValidationTrack(["analysis-tool", "classifier"]), "direct-main");
  assert.equal(historicalValidationTrack(["adapter", "planner"]), "historical-replay");
  assert.equal(historicalValidationTrack(["scanner"]), "hermes-ab");
  assert.equal(historicalValidationTrack(["latency"]), "hermes-ab");
  assert.equal(historicalValidationTrack(["adapter", "latency"]), null);
});

test("systemic protocol scanner routes to cohort A/B without a transaction sample", () => {
  const value = record({
    components: ["scanner"],
    samples: [],
    decision: {
      status: "route_to_hermes",
      claim: "implemented_not_validated",
      branch_action: "retained",
      evidence: "Protocol scanner coverage needs a predeclared positive/negative cohort and live distribution check.",
    },
  });
  assert.deepEqual(validateHistoricalGap(value, "promote"), []);
});

test("deterministic production repair can promote after replay and smoke evidence", () => {
  assert.deepEqual(validateHistoricalGap(record(), "promote"), []);
});

test("deterministic promotion requires a non-author live-distribution attestation", () => {
  const value = record();
  delete value.validation.review.live_distribution_verdict;
  assert.ok(validateHistoricalGap(value, "promote")
    .some((error) => error.includes("no cross-opportunity live-distribution change")));
});

test("fresh review binds the exact base, challenger, and patch digest", () => {
  const value = record();
  value.validation.review.challenger_commit = SHA_A;
  value.validation.review.diff_sha256 = "not-a-digest";
  assert.ok(validateHistoricalGap(value, "promote")
    .some((error) => error.includes("exact base_commit, challenger_commit, and diff_sha256")));
});

test("fresh review and production universe require hash-bound artifacts", () => {
  const noReviewArtifact = record();
  noReviewArtifact.validation.review.artifact = "";
  assert.ok(validateHistoricalGap(noReviewArtifact, "promote")
    .some((error) => error.includes("committed report artifact")));

  const noUniverse = record();
  delete noUniverse.validation.replay_environment;
  assert.ok(validateHistoricalGap(noUniverse, "promote")
    .some((error) => error.includes("production universe provenance")));
});

test("promotion artifacts cannot traverse outside the reports root", () => {
  const escapedReview = record();
  escapedReview.validation.review.artifact = "docs/research/reports/../../../analysis/review.json";
  assert.ok(validateHistoricalGap(escapedReview, "promote")
    .some((error) => error.includes("committed report artifact")));

  const escapedUniverse = record();
  escapedUniverse.validation.replay_environment!.universe_provenance_artifact =
    "docs/research/reports/../../../analysis/universe.json";
  assert.ok(validateHistoricalGap(escapedUniverse, "promote")
    .some((error) => error.includes("production universe provenance")));

  const escapedCandidate = record();
  escapedCandidate.samples[0].candidate_report =
    "docs/research/reports/../../../analysis/candidate.md";
  assert.ok(validateHistoricalGap(escapedCandidate, "promote")
    .some((error) => error.includes("candidate_report")));
});

test("close requires the promotion receipt identity", () => {
  const value = record({
    decision: {
      status: "closed",
      claim: "fixed",
      branch_action: "merged_deleted",
      evidence: "Exact merge and artifact archive passed.",
      merge_commit: "f".repeat(40),
    },
  });
  assert.ok(validateHistoricalGap(value, "close")
    .some((error) => error.includes("promotion artifact commit")));
  value.decision.promotion_artifact_commit = "1".repeat(40);
  value.decision.promotion_receipt_sha256 = HASH;
  assert.deepEqual(validateHistoricalGap(value, "close"), []);
});

test("report commit is external and cannot self-reference inside the report", () => {
  const value = record() as HistoricalGapRecord & { evidence_commit?: string };
  value.evidence_commit = "f".repeat(40);
  assert.ok(validateHistoricalGap(value, "classify")
    .some((error) => error.includes("--artifact-ref")));
});

test("build and tests alone cannot promote a deterministic searcher repair", () => {
  const value = record({
    validation: {
      ...record().validation,
      smoke: undefined,
    },
    decision: {
      status: "implemented_not_validated",
      claim: "implemented_not_validated",
      branch_action: "retained",
      evidence: "Build passed but replay/smoke evidence is incomplete.",
    },
  });
  const errors = validateHistoricalGap(value, "promote");
  assert.ok(errors.some((error) => error.includes("short-smoke plan")));
  assert.ok(errors.some((error) => error.includes("decision.status must be promote")));
  assert.ok(errors.some((error) => error.includes("decision.claim must be fixed")));
});

test("analysis tools and gates route directly to main without occupying B", () => {
  const value = record({
    branch: "codex/fix-causal-classifier",
    components: ["classifier", "analysis-tool"],
    samples: [],
    validation: {
      build: { exit_code: 0, evidence: "analysis build passed" },
      tests: { exit_code: 0, evidence: "classifier regression passed" },
      toolchain_sha256: HASH,
      review: {
        reviewer: "fresh-reviewer",
        verdict: "pass",
        base_commit: SHA_A,
        challenger_commit: SHA_B,
        diff_sha256: HASH,
        artifact: "docs/research/reports/review.json",
        artifact_sha256: HASH,
        reviewed_at: "2026-07-14T00:00:00.000Z",
        evidence: "Independent review passed",
      },
    },
  });
  delete value.branch_audit;
  assert.deepEqual(validateHistoricalGap(value, "promote"), []);
});

test("admission latency and ranking changes are routed to Hermes A/B", () => {
  const value = record({
    components: ["candidate-ranking"],
    decision: {
      status: "route_to_hermes",
      claim: "implemented_not_validated",
      branch_action: "retained",
      evidence: "Candidate ordering depends on live opportunity distribution.",
    },
  });
  assert.deepEqual(validateHistoricalGap(value, "promote"), []);
});

test("out-of-scope keeper inventory and credit samples are rejected", () => {
  const value = record();
  value.samples[0].posture.keeper = true;
  value.samples[0].posture.inventory = true;
  value.samples[0].posture.credit = true;
  const errors = validateHistoricalGap(value, "classify");
  assert.ok(errors.some((error) => error.includes("posture.keeper must be false")));
  assert.ok(errors.some((error) => error.includes("posture.inventory must be false")));
  assert.ok(errors.some((error) => error.includes("posture.credit must be false")));
});

test("scanner sources require standing state while backrun sources require a real trigger tx", () => {
  const blockScan = record();
  blockScan.samples[0] = {
    ...blockScan.samples[0],
    strategy_kind: "block-scan",
    trigger_kind: "victim-swap",
    victim_tx_hash: undefined,
  };
  assert.ok(validateHistoricalGap(blockScan, "classify").some((error) => error.includes("standing-state")));

  const backrun = record();
  backrun.samples[0].victim_tx_hash = undefined;
  assert.ok(validateHistoricalGap(backrun, "classify").some((error) => error.includes("victim_tx_hash")));
});

test("smoke plan requires the trusted runner and ten real minutes", () => {
  const plan = {
    mode: "trusted-local-dry-run" as const,
    duration_seconds: 600,
  };
  assert.deepEqual(validateHistoricalSmokePlan(plan), []);
  assert.ok(validateHistoricalSmokePlan({ ...plan, duration_seconds: 599 })
    .some((error) => error.includes("600 seconds")));
  assert.ok(validateHistoricalSmokePlan({ ...plan, mode: "self-reported" as never })
    .some((error) => error.includes("trusted local dry-run")));
});

test("trusted smoke gates process liveness rather than challenger-authored lane markers", () => {
  assert.deepEqual(validateHistoricalSmokeOutput("arbitrary challenger output", 600, 600), []);
  assert.ok(validateHistoricalSmokeOutput("arbitrary challenger output", 599, 600)
    .some((error) => error.includes("wall-clock duration")));
  assert.ok(validateHistoricalSmokeOutput("fatal: startup failed", 600, 600)
    .some((error) => error.includes("fatal process error")));
});

test("trusted smoke uses a disposable signer and promotion emits a durable receipt", () => {
  const source = readFileSync(new URL("../cli/historical-gap-gate.ts", import.meta.url), "utf8");
  assert.match(source, /randomBytes\(32\)/);
  assert.match(source, /postureSha256/);
  assert.doesNotMatch(source, /trustedCredential\(/);
  assert.doesNotMatch(source, /BOTVM_OWNER:\s*botvmOwner/);
  assert.match(source, /mev-historical-promotions/);
  assert.match(source, /assertNoOpenPromotionReceipts/);
  assert.match(source, /historical-gap-prepare/);
  assert.match(source, /ssm", "send-command"/);
  assert.match(source, /if \(track !== "hermes-ab"\)/);
  assert.match(source, /deny file-read-data/);
  assert.match(source, /deny file-write\* \(subpath/);
  assert.doesNotMatch(source, /allowedReadSubpaths[\s\S]*?"\/private\/etc"/);
  assert.doesNotMatch(source, /allowedReadSubpaths[\s\S]*?"\/dev"/);
  assert.doesNotMatch(source, /allowedReadSubpaths[\s\S]*?"\/opt\/homebrew"/);
  assert.doesNotMatch(source, /allowedReadSubpaths[\s\S]*?"\/usr"/);
  assert.match(source, /"\/dev\/urandom"/);
  assert.match(source, /candidateNodeRuntimeReadSubpaths\(\)/);
  assert.match(source, /execFileSync\("\/usr\/bin\/otool"/);
  assert.match(source, /environment\.OPENSSL_CONF = "\/dev\/null"/);
  assert.match(source, /fs\.realpathSync\(npmExecutable\)/);
  assert.match(source, /candidateWritableRoots\.add\(worktree\)/);
  assert.match(source, /candidateReadOnlyRoots\.add\(path\.join\(worktree, "\.git"\)\)/);
  assert.match(source, /candidateReadOnlyRoots\.add\(worktree\)/);
  assert.match(source, /resetCandidateRuntimeHome\(\)/);
  assert.match(source, /environment\.HOME = candidateRuntimeHome/);
  assert.match(source, /cloneHistoricalGapValidationRoot\(/);
  assert.match(source, /environment\.DEVELOPER_DIR = "\/Library\/Developer\/CommandLineTools"/);
});

test("candidate validation clone fetches remote-only frozen commits by exact SHA", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "historical-remote-only-"));
  const source = path.join(root, "source");
  const control = path.join(root, "control");
  const candidate = path.join(root, "candidate");
  const git = (cwd: string, args: string[]): string => execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  try {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", source], { env: process.env });
    git(source, ["config", "user.name", "historical-gap-test"]);
    git(source, ["config", "user.email", "historical-gap@example.invalid"]);
    writeFileSync(path.join(source, "runtime.ts"), "base\n");
    git(source, ["add", "runtime.ts"]);
    git(source, ["commit", "--quiet", "-m", "base"]);
    git(source, ["switch", "--quiet", "-c", "ab/remote-only"]);
    writeFileSync(path.join(source, "runtime.ts"), "candidate\n");
    git(source, ["commit", "--quiet", "-am", "candidate"]);
    const challengerCommit = git(source, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(source, "report.md"), "artifact\n");
    git(source, ["add", "report.md"]);
    git(source, ["commit", "--quiet", "-m", "artifact"]);
    const artifactCommit = git(source, ["rev-parse", "HEAD"]);
    git(source, ["update-ref", "refs/remotes/origin/ab/remote-only", artifactCommit]);
    git(source, ["switch", "--quiet", "main"]);
    git(source, ["branch", "-D", "ab/remote-only"]);

    execFileSync("git", ["clone", "--no-local", "--no-checkout", "--quiet", source, control], {
      env: process.env,
    });
    assert.throws(() => git(control, ["cat-file", "-e", `${artifactCommit}^{commit}`]));

    cloneHistoricalGapValidationRoot(
      source,
      candidate,
      challengerCommit,
      [challengerCommit, artifactCommit],
      process.env,
    );
    assert.equal(git(candidate, ["rev-parse", "HEAD"]), challengerCommit);
    assert.equal(git(candidate, ["show", `${artifactCommit}:report.md`]), "artifact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sandboxed block-scan replay writes every temporary artifact under the gate root", () => {
  const source = readFileSync(new URL("../cli/ab-canary-gate.ts", import.meta.url), "utf8");
  assert.match(source, /mkdtempSync\(path\.join\(gateTmpRoot, `mev-ab-/);
  assert.doesNotMatch(source, /mkdtempSync\(path\.join\("\/tmp"/);
});

test("read-only historical backrun replay uses a gate-preinstalled trusted harness", () => {
  const historicalGate = readFileSync(new URL("../cli/historical-gap-gate.ts", import.meta.url), "utf8");
  const candidateGate = readFileSync(new URL("../cli/ab-canary-gate.ts", import.meta.url), "utf8");
  assert.match(historicalGate, /prepareTrustedBackrunHarness\(baseRoot, challengerRoot, index\)/);
  assert.match(historicalGate, /--trusted-backrun-hunt-challenger/);
  assert.match(historicalGate, /COPYFILE_EXCL/);
  assert.match(candidateGate, /resolveTrustedBackrunHarness\(/);
  assert.match(candidateGate, /if \(targetRoot === trustedRoot\) return trustedSource/);
  assert.match(candidateGate, /resolvedDigest !== trustedDigest/);
  assert.match(candidateGate, /option\(`--trusted-backrun-hunt-\$\{label\}`\)/);
});

test("production universe binding is grounded in the live champion, not caller claims", () => {
  const sourcePath = `/opt/MEV-runtime/universe/active-pools-${HASH}.json`;
  const attestation: HistoricalProductionUniverseAttestation = {
    schema_version: 1,
    kind: "production-pool-universe",
    instance_id: HISTORICAL_PRODUCTION_INSTANCE_ID,
    runtime_commit: SHA_A,
    universe_path: sourcePath,
    universe_sha256: HASH,
    pool_universe_top_n: 6000,
    observed_at: "2026-07-14T00:00:00.000Z",
    command_id: "11111111-1111-1111-1111-111111111111",
  };
  const provenance: HistoricalUniverseProvenance = {
    schema_version: 1,
    kind: "production-pool-universe",
    instance_id: HISTORICAL_PRODUCTION_INSTANCE_ID,
    runtime_commit: SHA_A,
    source_path: sourcePath,
    universe_sha256: HASH,
    pool_universe_top_n: 6000,
    captured_at: "2026-07-14T00:00:00.000Z",
  };
  const declared = record().validation.replay_environment!;
  assert.deepEqual(validateHistoricalUniverseBinding(
    SHA_A,
    declared,
    provenance,
    attestation,
    HASH,
  ), []);

  assert.ok(validateHistoricalUniverseBinding(
    SHA_B,
    declared,
    provenance,
    attestation,
    HASH,
  ).some((error) => error.includes("runtime commit")));
  assert.ok(validateHistoricalUniverseBinding(
    SHA_A,
    { ...declared, pool_universe_top_n: 5999 },
    provenance,
    attestation,
    HASH,
  ).some((error) => error.includes("top-N")));
  assert.ok(validateHistoricalUniverseBinding(
    SHA_A,
    declared,
    provenance,
    { ...attestation, universe_path: "/tmp/caller-selected.json" },
    HASH,
  ).some((error) => error.includes("content-addressed")));
  assert.ok(validateHistoricalUniverseBinding(
    SHA_A,
    declared,
    { ...provenance, universe_sha256: "f".repeat(64) },
    attestation,
    HASH,
  ).some((error) => error.includes("provenance")));
});

test("artifact refs require an available report-only descendant", () => {
  assert.deepEqual(validateHistoricalArtifactCommit(true, true, ["docs/research/reports/gap.md"]), []);
  assert.ok(validateHistoricalArtifactCommit(false, false, [])
    .some((error) => error.includes("not available")));
  assert.ok(validateHistoricalArtifactCommit(true, false, [])
    .some((error) => error.includes("descend")));
  assert.ok(validateHistoricalArtifactCommit(true, true, ["listener/src/searcher/main.ts"])
    .some((error) => error.includes("reports only")));
});

test("report-owned artifacts resolve relative to the report and cannot escape reports", () => {
  assert.equal(
    resolveHistoricalReportArtifactPath("docs/research/reports/sample.md", "tools.json"),
    "docs/research/reports/tools.json",
  );
  assert.equal(
    resolveHistoricalReportArtifactPath("docs/research/reports/nested/sample.md", "evidence/tools.json"),
    "docs/research/reports/nested/evidence/tools.json",
  );
  assert.equal(
    resolveHistoricalReportArtifactPath("docs/research/reports/sample.md", "../tools.json"),
    null,
  );
  assert.equal(
    resolveHistoricalReportArtifactPath("docs/research/reports/sample.md", "/tmp/tools.json"),
    null,
  );
});

test("candidate cleanup targets only the branch and exact frozen artifact commits", () => {
  const branch = "ab/gap-v4-admission";
  const artifact = "f".repeat(40);
  assert.equal(isHistoricalCandidateWorktree({
    branch: `refs/heads/${branch}`,
    head: "1".repeat(40),
  }, branch, SHA_B, artifact), true);
  assert.equal(isHistoricalCandidateWorktree({
    branch: "refs/heads/detached-candidate",
    head: SHA_B,
  }, branch, SHA_B, artifact), true);
  assert.equal(isHistoricalCandidateWorktree({
    branch: "refs/heads/report-artifact",
    head: artifact,
  }, branch, SHA_B, artifact), true);
  assert.equal(isHistoricalCandidateWorktree({
    branch: "refs/heads/main",
    head: "2".repeat(40),
  }, branch, SHA_B, artifact), false);
  assert.equal(isHistoricalCandidateWorktree({
    branch: "detached",
    head: "3".repeat(40),
  }, branch, SHA_B, artifact, true), true);
  assert.equal(isHistoricalCandidateWorktree({
    branch: "refs/heads/evidence-copy",
    head: "5".repeat(40),
  }, branch, SHA_B, artifact, true), true);
  assert.equal(isHistoricalCandidateWorktree({
    branch: "detached",
    head: "4".repeat(40),
  }, branch, SHA_B, artifact, false), false);
});

test("replay ignores neither root env files nor an ours-strategy merge", () => {
  assert.deepEqual(validateHistoricalReplayRootEntries(["analysis", "listener"]), []);
  assert.ok(validateHistoricalReplayRootEntries([".env", "analysis"])
    .some((error) => error.includes("must not contain .env")));
  assert.deepEqual(validateHistoricalMergeTree(SHA_A, SHA_A), []);
  assert.ok(validateHistoricalMergeTree(SHA_A, SHA_B)
    .some((error) => error.includes("frozen challenger tree")));
});

test("block-scan replay route identity is ordered and direction-sensitive", () => {
  const expected = [
    { pool_id: "0xpool-a", direction: "0for1" as const },
    { pool_id: "0xpool-b", direction: "1for0" as const },
  ];
  assert.deepEqual(validateExactProductionSwapPath(expected, expected), []);
  assert.ok(validateExactProductionSwapPath(expected, [...expected].reverse()).length > 0);
  assert.ok(validateExactProductionSwapPath(expected, [
    { ...expected[0], direction: "1for0" },
    expected[1],
  ]).length > 0);
  assert.ok(validateExactProductionSwapPath(expected, [
    ...expected,
    { pool_id: "0xpool-c", direction: "0for1" },
  ]).length > 0);
});

test("diff classification admits adapters but rejects self-authored evidence and dependencies", () => {
  assert.deepEqual(validateHistoricalDiffScope([
    "listener/src/adapters/univ2.ts",
    "listener/src/shared/adapters/registry.ts",
  ], "historical-replay"), []);
  assert.ok(validateHistoricalDiffScope([
    "listener/src/searcher/detector/detector.ts",
    "listener/src/searcher/test/backrun-hunt.ts",
  ], "historical-replay").some((error) => error.includes("test, fixture, dependency, or runner")));
  assert.ok(validateHistoricalDiffScope([
    "listener/src/searcher/detector/backrun-detector.ts",
    "analysis/src/cli/bundle-postmortem.ts",
  ], "historical-replay").some((error) => error.includes("non-runtime")));
  assert.ok(validateHistoricalDiffScope([
    "listener/src/adapters/univ2.ts",
    "listener/package.json",
  ], "historical-replay").some((error) => error.includes("dependency")));
  assert.ok(validateHistoricalDiffScope([
    "listener/src/adapters/univ2.ts",
    "listener/src/adapters/package.json",
  ], "historical-replay").some((error) => error.includes("dependency")));
  assert.ok(validateHistoricalDiffScope([
    "listener/src/adapters/univ2.ts",
    "listener/src/adapters/tsconfig.generated.json",
  ], "historical-replay").some((error) => error.includes("dependency")));
  assert.ok(validateHistoricalDiffScope([
    "listener/src/adapters/univ2.ts",
    "listener/src/searcher/fixtures/victims.ts",
  ], "historical-replay").some((error) => error.includes("fixture")));
  for (const file of [
    "listener/src/adapters/runner.ts",
    "listener/src/adapters/dependencies/helper.ts",
    "listener/src/adapters/test-helper.ts",
    "listener/src/adapters/fixture-loader.ts",
    "listener/src/searcher/templates/replay-runner.ts",
  ]) {
    assert.ok(validateHistoricalDiffScope([file], "historical-replay")
      .some((error) => error.includes("test, fixture, dependency, or runner")), file);
  }
});

test("runtime paths and semantic diff tokens force live-distribution changes to Hermes", () => {
  assert.ok(validateHistoricalDiffScope([
    "listener/src/searcher/main.ts",
  ], "historical-replay", "+const deterministic = true;")
    .some((error) => error.includes("live-path:listener/src/searcher/main.ts")));
  assert.ok(validateHistoricalDiffScope([
    "listener/src/searcher/planner/planner.ts",
  ], "historical-replay", "+plans.sort(byScore).slice(0, maxCandidates);")
    .some((error) => error.includes("live-path:listener/src/searcher/planner/planner.ts")));
  assert.ok(validateHistoricalDiffScope([
    "listener/src/searcher/strategy-views.ts",
  ], "historical-replay", "-return scoreForSort(b)-scoreForSort(a);\n+return scoreForSort(a)-scoreForSort(b);")
    .some((error) => error.includes("live-path:listener/src/searcher/strategy-views.ts")));
  for (const patch of [
    "+candidates = candidates.filter(canUse);",
    "+const LIMIT = 16;",
    "+if (gross < 1000000n) return [];",
    "+const n = 4; if (seen >= n) return undefined;",
    "+if (gross < floor) return null;",
  ]) {
    assert.ok(validateHistoricalDiffScope([
      "listener/src/searcher/detector/detector.ts",
    ], "historical-replay", patch).some((error) => error.includes("mixed/live owners")));
  }
  for (const patch of [
    "+candidates = candidates.filter(canUse);",
    "+const n = 4; if (seen >= n) return undefined;",
    "+if (gross < floor) return null;",
    "+const ranked = values.toSorted(compareProfit);",
    "+setInterval(refresh, 1000);",
    "+if (processed >= 8) break;",
    "+let turn = 0; return ++turn % 2 === 0;",
  ]) {
    assert.ok(validateHistoricalDiffScope([
      "listener/src/adapters/univ2.ts",
    ], "historical-replay", patch).some((error) => error.includes("live-distribution behavior")));
  }
  assert.ok(inferLiveSensitiveDiff([
    "listener/src/searcher/planner/token-graph.ts",
  ], "+edges.set(id, edge);").some((error) => error.includes("live-path")));
  assert.ok(inferLiveSensitiveDiff([
    "listener/src/searcher/solver/amount-bounds.ts",
  ], "-maxTries = 12;\n+maxTries = 24;").includes("live-token:resource-attempts"));
});

test("direct-main tooling cannot hide a production or deploy-runner change", () => {
  assert.deepEqual(validateHistoricalDiffScope([
    "analysis/src/cli/bundle-postmortem.ts",
    "analysis/src/test/bundle-postmortem.ts",
  ], "direct-main"), []);
  assert.deepEqual(validateHistoricalDiffScope([
    "listener/src/searcher/test/blockscan-hunt.ts",
    "listener/src/searcher/test/backrun-hunt.ts",
  ], "direct-main"), []);
  assert.ok(validateHistoricalDiffScope([
    "listener/src/searcher/test/backrun-hunt.ts",
    "listener/src/searcher/fixtures/victims.ts",
  ], "direct-main").some((error) => error.includes("non-tooling changes")));
  assert.ok(validateHistoricalDiffScope([
    "listener/src/searcher/main.ts",
  ], "direct-main").some((error) => error.includes("production searcher")));
  assert.ok(validateHistoricalDiffScope([
    "scripts/deploy-node.sh",
  ], "direct-main").some((error) => error.includes("non-tooling changes")));
  assert.ok(validateHistoricalDiffScope([
    "docs/research/HISTORICAL-GAP.md",
  ], "direct-main").some((error) => error.includes("implementation change")));
  assert.ok(validateHistoricalDiffScope([
    "analysis/src/test/historical-gap.ts",
  ], "direct-main").some((error) => error.includes("implementation change")));
  for (const file of [
    "CLAUDE.md",
    "AGENTS.md",
    ".claude/hooks/stop.sh",
    "docs/research/HERMES.md",
    "scripts/guard-live.sh",
    "analysis/package-lock.json",
    "analysis/src/fixtures/fake-profit.ts",
  ]) {
    assert.ok(validateHistoricalDiffScope([
      "analysis/src/cli/bundle-postmortem.ts",
      file,
    ], "direct-main").some((error) => error.includes("non-tooling changes")), file);
  }
  assert.ok(validateHistoricalDiffScope([
    "analysis/src/cli/bundle-postmortem.ts",
    "analysis/src/test/unrelated.ts",
  ], "direct-main").some((error) => error.includes("same-named implementation")));
});

test("direct-main package manifest permits scripts only and forbids lifecycle hooks", () => {
  const base = JSON.stringify({ name: "analysis", scripts: { test: "node --test" }, dependencies: { ethers: "1" } });
  assert.deepEqual(validateDirectMainPackageManifest(base, JSON.stringify({
    name: "analysis",
    scripts: { test: "node --test", "historical:gap": "tsx src/cli/historical-gap-gate.ts" },
    dependencies: { ethers: "1" },
  })), []);
  assert.match(validateDirectMainPackageManifest(base, JSON.stringify({
    name: "analysis", scripts: { test: "node --test" }, dependencies: { ethers: "2" },
  })).join("\n"), /scripts only/);
  assert.match(validateDirectMainPackageManifest(base, JSON.stringify({
    name: "analysis", scripts: { test: "node --test", postinstall: "curl bad" }, dependencies: { ethers: "1" },
  })).join("\n"), /forbidden lifecycle/);
  assert.match(validateDirectMainPackageManifest(base, JSON.stringify({
    name: "analysis", scripts: { test: "true" }, dependencies: { ethers: "1" },
  })).join("\n"), /must not modify or remove existing script test/);
});

test("SSM tunnel readiness requires plugin ownership output for the exact local port", () => {
  const output = "Port 45678 opened for sessionId user-abc.\nWaiting for connections...\n";
  assert.equal(trustedSsmTunnelReady(output, 45678), true);
  assert.equal(trustedSsmTunnelReady(output, 45679), false);
  assert.equal(trustedSsmTunnelReady("Waiting for connections...", 45678), false);
  assert.equal(trustedSsmTunnelReady("Port 45678 opened for sessionId user-abc.", 45678), false);
});

test("parser reads the single structured historical gap block", () => {
  const value = record();
  const parsed = parseHistoricalGap(`# report\n\n\`\`\`historical_gap\n${JSON.stringify(value)}\n\`\`\``);
  assert.equal(parsed.gap_id, value.gap_id);
  assert.equal(parsed.samples[0].strategy_kind, "backrun");
});

test("branch audit must cover refs, worktrees, durable evidence, and same-gap sources exactly", () => {
  const inventory: HistoricalAuditInventory = {
    schema_version: 1,
    refs_sha256: HASH,
    refs: [
      { ref: "git-ref:refs/remotes/origin/main", kind: "git-ref", fingerprint: "1".repeat(64) },
      { ref: "worktree:/tmp/old", kind: "worktree", fingerprint: "2".repeat(64) },
      { ref: "origin-main-reports", kind: "origin-main-reports", fingerprint: "3".repeat(64) },
      { ref: "origin-main-resolutions", kind: "origin-main-resolutions", fingerprint: "4".repeat(64) },
      { ref: "worktree-evidence:/tmp/old", kind: "worktree-evidence", fingerprint: "5".repeat(64) },
    ],
  };
  const matches = inventory.refs.map((entry) => ({
    ...entry,
    disposition: "unrelated" as const,
    evidence: `Inspected ${entry.ref}`,
  }));
  const audit = { ...record().branch_audit!, matches };
  assert.deepEqual(validateHistoricalBranchAuditCoverage(audit, inventory, []), []);
  assert.ok(validateHistoricalBranchAuditCoverage({ ...audit, matches: matches.slice(1) }, inventory, [])
    .some((error) => error.includes("omitted inventory ref")));
  assert.ok(validateHistoricalBranchAuditCoverage(audit, inventory, ["origin-main-reports"])
    .some((error) => error.includes("reuse or explicitly supersede")));
  assert.ok(validateHistoricalBranchAuditCoverage(audit, inventory, [], ["worktree:/tmp/old"])
    .some((error) => error.includes("runtime-overlap")));
  const unresolved = matches.map((entry) => entry.ref === "origin-main-reports"
    ? { ...entry, disposition: "unresolved" as const }
    : entry);
  assert.ok(validateHistoricalBranchAuditCoverage({
    ...audit,
    matches: unresolved,
    outcome: "prior_fix_insufficient",
  }, inventory, ["origin-main-reports"])
    .some((error) => error.includes("reuse or explicitly supersede")));
  const unrelatedUnresolved = matches.map((entry) => entry.ref === "worktree:/tmp/old"
    ? { ...entry, disposition: "unresolved" as const }
    : entry);
  assert.ok(validateHistoricalBranchAuditCoverage({
    ...audit,
    matches: unrelatedUnresolved,
    outcome: "prior_fix_insufficient",
  }, inventory, []).some((error) => error.includes("resolve every inventoried source")));
  const related = matches.map((entry) => entry.ref === "origin-main-reports"
    ? { ...entry, disposition: "superseded" as const }
    : entry);
  assert.deepEqual(validateHistoricalBranchAuditCoverage({
    ...audit,
    matches: related,
    outcome: "prior_fix_insufficient",
  }, inventory, ["origin-main-reports"]), []);
  const invalidDisposition = matches.map((entry, index) => index === 0
    ? { ...entry, disposition: "not-a-real-disposition" as never }
    : entry);
  assert.ok(validateHistoricalBranchAuditCoverage({
    ...audit,
    matches: invalidDisposition,
    outcome: "reuse_prior_fix",
  }, inventory, []).some((error) => error.includes("invalid disposition")));
  const reusableWithoutCommit = matches.map((entry, index) => index === 0
    ? { ...entry, disposition: "reusable" as const }
    : entry);
  assert.ok(validateHistoricalBranchAuditCoverage({
    ...audit,
    matches: reusableWithoutCommit,
    outcome: "reuse_prior_fix",
  }, inventory, []).some((error) => error.includes("reused_commit")));
  const invalidOutcome = record();
  invalidOutcome.branch_audit!.outcome = "made-up-outcome" as never;
  assert.ok(validateHistoricalGap(invalidOutcome, "classify")
    .some((error) => error.includes("branch_audit.outcome")));
});
