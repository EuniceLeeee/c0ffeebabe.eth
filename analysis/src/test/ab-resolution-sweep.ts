import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseAbExperiment, type AbExperiment, type ResolutionReplaySpec } from "../ab-canary.js";
import {
  runResolutionSweep,
  updateResolvedReport,
  validateResolutionClaim,
  type AbResolutionClaim,
} from "../ab-resolution-sweep.js";

const sourceRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function experiment(
  base = "a".repeat(40),
  challenger = "b".repeat(40),
  replay: ResolutionReplaySpec = {
    cwd: ".",
    argv: ["node", "replay-check.mjs"],
    timeout_seconds: 30,
    expected_transition: "missing fixed marker -> fixed marker present",
  },
): AbExperiment {
  return {
    schema_version: 1,
    experiment_id: "ab-old-gap",
    problem_id: "gap-old",
    branch: "ab/old-gap",
    base_commit: base,
    challenger_commit: challenger,
    change_class: "capability",
    hypothesis: "close a pinned production gap",
    input_mode: "shared",
    allowed_config_delta: [],
    a: { commit: base, config_hash: "c".repeat(64), universe_hash: "d".repeat(64) },
    b: { commit: challenger, config_hash: "c".repeat(64), universe_hash: "d".repeat(64) },
    window: { min_paired_blocks: 1, warmup_blocks: 0 },
    fairness: {
      same_block_window: true,
      paired_blocks: 1,
      champion_restart_delta: 0,
      champion_pid_changed: false,
      challenger_restarts: 0,
      a_universe_hash_after: "d".repeat(64),
      b_universe_hash_after: "d".repeat(64),
    },
    deterministic_gate: { result: "pass", evidence: "old pinned replay" },
    analysis: {
      agent_manual_author: "manual",
      agent_manual_verdict: "inconclusive",
      agent_manual_evidence: "old gap remained unresolved",
      script_exit_code: 1,
      script_assessment: "inconclusive",
      script_artifact: "compare.json",
      reconciliation: "inconclusive",
      adversarial_review: {
        verdict: "inconclusive",
        evidence: "fresh reviewer could not prove the old attempt",
        reviewer: "non-author",
      },
    },
    final_verdict: "needs_escalation",
    branch_action: "retained",
    b_stopped: true,
    evidence_bundle: "redacted evidence",
    resolution_replay: replay,
  };
}

function claim(branchTip = "d".repeat(40), resolvedBy = "c".repeat(40)): AbResolutionClaim {
  return {
    schema_version: 1,
    problem_id: "gap-old",
    branch: "ab/old-gap",
    report_path: "docs/research/reports/ab-old-gap-hermes.md",
    retained_branch_tip: branchTip,
    resolved_by_commit: resolvedBy,
    evidence: "later main commit flips the old pinned fixture",
  };
}

interface FixtureRepo {
  tmp: string;
  remote: string;
  repo: string;
  base: string;
  reportPath: string;
  branchTip: string;
}

function fixtureRepo(replay?: ResolutionReplaySpec): FixtureRepo {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-resolution-"));
  const remote = path.join(tmp, "remote.git");
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "A/B Sweep Test"]);
  git(repo, ["remote", "add", "origin", remote]);

  fs.mkdirSync(path.join(repo, "analysis"), { recursive: true });
  fs.cpSync(path.join(sourceRoot, "analysis/src"), path.join(repo, "analysis/src"), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, "analysis/package.json"), path.join(repo, "analysis/package.json"));
  fs.copyFileSync(path.join(sourceRoot, "analysis/tsconfig.json"), path.join(repo, "analysis/tsconfig.json"));
  fs.symlinkSync(fs.realpathSync(path.join(sourceRoot, "analysis/node_modules")), path.join(repo, "analysis/node_modules"), "junction");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  fs.writeFileSync(path.join(repo, "replay-check.mjs"), [
    "import fs from 'node:fs';",
    "const ok = fs.existsSync('fixed.txt') && fs.readFileSync('fixed.txt', 'utf8') === 'later fix\\n';",
    "process.exit(ok ? 0 : 1);",
    "",
  ].join("\n"));
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["push", "-u", "origin", "main"]);

  git(repo, ["switch", "-c", "ab/old-gap"]);
  const reportPath = "docs/research/reports/ab-old-gap-hermes.md";
  fs.mkdirSync(path.join(repo, path.dirname(reportPath)), { recursive: true });
  fs.writeFileSync(
    path.join(repo, reportPath),
    `# retained predeclaration\n\n\`\`\`ab_experiment\n${JSON.stringify(experiment(base, "0".repeat(40), replay), null, 2)}\n\`\`\`\n`,
  );
  git(repo, ["add", reportPath]);
  git(repo, ["commit", "-m", "predeclare retained replay"]);
  fs.writeFileSync(path.join(repo, "challenger.txt"), "unresolved attempt\n");
  git(repo, ["add", "challenger.txt"]);
  git(repo, ["commit", "-m", "attempt old gap"]);
  const challenger = git(repo, ["rev-parse", "HEAD"]);
  fs.writeFileSync(
    path.join(repo, reportPath),
    `# retained\n\n\`\`\`ab_experiment\n${JSON.stringify(experiment(base, challenger, replay), null, 2)}\n\`\`\`\n`,
  );
  git(repo, ["add", reportPath]);
  git(repo, ["commit", "-m", "record retained gap"]);
  const branchTip = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["push", "-u", "origin", "ab/old-gap"]);
  git(repo, ["switch", "main"]);
  return { tmp, remote, repo, base, reportPath, branchTip };
}

function commitFixAndClaim(fixture: FixtureRepo): { resolvedBy: string; claimPath: string } {
  const { repo, branchTip } = fixture;
  fs.writeFileSync(path.join(repo, "fixed.txt"), "later fix\n");
  git(repo, ["add", "fixed.txt"]);
  git(repo, ["commit", "-m", "later fix"]);
  const resolvedBy = git(repo, ["rev-parse", "HEAD"]);
  const claimPath = "docs/research/resolutions/gap-old.json";
  fs.mkdirSync(path.join(repo, path.dirname(claimPath)), { recursive: true });
  fs.writeFileSync(path.join(repo, claimPath), `${JSON.stringify(claim(branchTip, resolvedBy), null, 2)}\n`);
  git(repo, ["add", claimPath]);
  git(repo, ["commit", "-m", "claim old gap resolution"]);
  git(repo, ["push", "origin", "main"]);
  return { resolvedBy, claimPath };
}

test("claim cannot choose its own replay or omit the retained branch tip", () => {
  const value = claim() as AbResolutionClaim & { replay?: unknown };
  value.replay = { cwd: ".", argv: ["node", "-e", "process.exit(0)"] };
  value.retained_branch_tip = "short";
  value.report_path = "../outside.md";
  const errors = validateResolutionClaim(value);
  assert.ok(errors.some((error) => error.includes("unexpected claim field replay")));
  assert.ok(errors.some((error) => error.includes("retained_branch_tip")));
  assert.ok(errors.some((error) => error.includes("report_path")));
});

test("resolved report binds evidence to the replay stored in the old report", () => {
  const md = `# report\n\n\`\`\`ab_experiment\n${JSON.stringify(experiment(), null, 2)}\n\`\`\`\n`;
  const updated = updateResolvedReport(md, claim());
  const parsed = parseAbExperiment(updated);
  assert.equal(parsed.branch_action, "resolved_deleted");
  assert.equal(parsed.resolution?.resolved_by_commit, "c".repeat(40));
  assert.match(parsed.resolution?.evidence ?? "", /replay-check\.mjs/);
  assert.match(parsed.resolution?.evidence ?? "", /missing fixed marker/);
});

test("resolution cannot be applied to a different problem", () => {
  const md = `# report\n\n\`\`\`ab_experiment\n${JSON.stringify(experiment(), null, 2)}\n\`\`\`\n`;
  const value = claim();
  value.problem_id = "other-gap";
  assert.throws(() => updateResolvedReport(md, value), /problem_id/);
});

test("scan refuses a local claim that is not committed on origin/main", { timeout: 30_000 }, () => {
  const fixture = fixtureRepo();
  const claimPath = "docs/research/resolutions/gap-old.json";
  fs.mkdirSync(path.join(fixture.repo, path.dirname(claimPath)), { recursive: true });
  fs.writeFileSync(path.join(fixture.repo, claimPath), `${JSON.stringify(claim(fixture.branchTip, fixture.base), null, 2)}\n`);
  assert.throws(() => runResolutionSweep(fixture.repo, "scan"), /must be committed on origin\/main/);
});

test("apply runs the old pinned replay, archives, exact-deletes, and is idempotent", { timeout: 60_000 }, () => {
  const fixture = fixtureRepo();
  const { resolvedBy } = commitFixAndClaim(fixture);
  const result = runResolutionSweep(fixture.repo, "apply");
  assert.equal(result.find((entry) => entry.branch === "ab/old-gap")?.status, "resolved_deleted");
  assert.equal(git(fixture.repo, ["ls-remote", "--heads", "origin", "refs/heads/ab/old-gap"]), "");
  const archived = execFileSync("git", ["--git-dir", fixture.remote, "show", `main:${fixture.reportPath}`], { encoding: "utf8" });
  assert.equal(parseAbExperiment(archived).resolution?.resolved_by_commit, resolvedBy);

  const retry = runResolutionSweep(fixture.repo, "apply");
  assert.equal(retry.find((entry) => entry.branch === "ab/old-gap")?.status, "resolved_deleted");
});

test("apply resumes after the report was archived but before branch deletion", { timeout: 60_000 }, () => {
  const fixture = fixtureRepo();
  const { resolvedBy } = commitFixAndClaim(fixture);
  const retained = execFileSync(
    "git",
    ["-C", fixture.repo, "show", `origin/ab/old-gap:${fixture.reportPath}`],
    { encoding: "utf8" },
  );
  fs.mkdirSync(path.join(fixture.repo, path.dirname(fixture.reportPath)), { recursive: true });
  fs.writeFileSync(path.join(fixture.repo, fixture.reportPath), updateResolvedReport(retained, claim(fixture.branchTip, resolvedBy)));
  git(fixture.repo, ["add", fixture.reportPath]);
  git(fixture.repo, ["commit", "-m", "simulate archived report before cleanup"]);
  git(fixture.repo, ["push", "origin", "main"]);

  const result = runResolutionSweep(fixture.repo, "apply");
  assert.equal(result.find((entry) => entry.branch === "ab/old-gap")?.status, "resolved_deleted");
  assert.equal(git(fixture.repo, ["ls-remote", "--heads", "origin", "refs/heads/ab/old-gap"]), "");
});

test("remote branch advancement after claim refuses cleanup", { timeout: 30_000 }, () => {
  const fixture = fixtureRepo();
  commitFixAndClaim(fixture);
  git(fixture.repo, ["switch", "ab/old-gap"]);
  fs.writeFileSync(path.join(fixture.repo, "advanced.txt"), "new branch work\n");
  git(fixture.repo, ["add", "advanced.txt"]);
  git(fixture.repo, ["commit", "-m", "advance retained branch"]);
  git(fixture.repo, ["push", "origin", "ab/old-gap"]);
  git(fixture.repo, ["switch", "main"]);
  assert.throws(() => runResolutionSweep(fixture.repo, "apply"), /retained_branch_tip|advanced or diverged/);
});

test("clean unpushed local branch commit refuses cleanup", { timeout: 30_000 }, () => {
  const fixture = fixtureRepo();
  commitFixAndClaim(fixture);
  git(fixture.repo, ["switch", "ab/old-gap"]);
  fs.writeFileSync(path.join(fixture.repo, "local-only.txt"), "unpublished work\n");
  git(fixture.repo, ["add", "local-only.txt"]);
  git(fixture.repo, ["commit", "-m", "local-only branch work"]);
  git(fixture.repo, ["switch", "main"]);
  assert.throws(() => runResolutionSweep(fixture.repo, "apply"), /local .* advanced or diverged/);
});

test("resolution rejects a replay that was changed after the frozen challenger", { timeout: 30_000 }, () => {
  const fixture = fixtureRepo();
  git(fixture.repo, ["switch", "ab/old-gap"]);
  const source = fs.readFileSync(path.join(fixture.repo, fixture.reportPath), "utf8");
  const changed = parseAbExperiment(source);
  changed.resolution_replay = {
    cwd: ".",
    argv: ["node", "replay-check.mjs", "changed"],
    timeout_seconds: 30,
    expected_transition: "changed replay",
  };
  fs.writeFileSync(
    path.join(fixture.repo, fixture.reportPath),
    source.replace(/```ab_experiment\s*\n[\s\S]*?\n```/, `\`\`\`ab_experiment\n${JSON.stringify(changed, null, 2)}\n\`\`\``),
  );
  git(fixture.repo, ["add", fixture.reportPath]);
  git(fixture.repo, ["commit", "-m", "change replay after freeze"]);
  git(fixture.repo, ["push", "origin", "ab/old-gap"]);
  git(fixture.repo, ["switch", "main"]);
  const changedTip = git(fixture.repo, ["rev-parse", "origin/ab/old-gap"]);
  const fix = commitFixAndClaim({ ...fixture, branchTip: changedTip });
  assert.ok(fix.resolvedBy);
  assert.throws(() => runResolutionSweep(fixture.repo, "verify"), /replay changed after challenger_commit/);
});

test("resolution rejects a no-op replay that already passes at the base", { timeout: 30_000 }, () => {
  const fixture = fixtureRepo({
    cwd: ".",
    argv: ["node", "--version"],
    timeout_seconds: 30,
    expected_transition: "must fail before and pass after",
  });
  commitFixAndClaim(fixture);
  assert.throws(() => runResolutionSweep(fixture.repo, "verify"), /already passes/);
});
