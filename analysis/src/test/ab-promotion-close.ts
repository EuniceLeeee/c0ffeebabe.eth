import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closePromotion, pushPromotionAtomically, rewriteAbExperiment } from "../ab-promotion-close.js";
import { parseAbExperiment, type AbExperiment } from "../ab-canary.js";
import { discoverToolIndex, toolDescriptorSha256, type ToolExecutionManifest } from "../tool-index.js";

const sourceRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const HASH = "d".repeat(64);

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function experiment(
  base: string,
  challenger: string,
  verdict: "win" | "lose" | "needs_escalation",
  manualHash: string,
  toolManifestHash: string,
): AbExperiment {
  const manual = verdict === "needs_escalation" ? "inconclusive" : verdict;
  const script = verdict === "win" ? "supports" : verdict === "lose" ? "contradicts" : "inconclusive";
  return {
    schema_version: 3,
    lane_mode: "dual",
    experiment_id: `ab-close-${verdict}`,
    problem_id: `gap-${verdict}`,
    branch: `ab/close-${verdict}`,
    base_commit: base,
    challenger_commit: challenger,
    change_class: "capability",
    hypothesis: "advance one pinned production sample",
    input_mode: "shared",
    expected_runtime_view_delta: false,
    allowed_config_delta: [],
    a: {
      commit: base,
      config_hash: HASH,
      universe_hash: HASH,
      discovery_to_block: 123,
      blockscan_view_hash: HASH,
      blockscan_graph_hash: HASH,
    },
    b: {
      commit: challenger,
      config_hash: HASH,
      universe_hash: HASH,
      discovery_to_block: 123,
      blockscan_view_hash: HASH,
      blockscan_graph_hash: HASH,
    },
    window: {
      min_paired_blocks: 2,
      warmup_blocks: 0,
      measured_from_block: 1,
      measured_to_block: 2,
    },
    fairness: {
      same_block_window: true,
      paired_blocks: 2,
      champion_restart_delta: 0,
      champion_pid_changed: false,
      challenger_restarts: 0,
      a_universe_hash_after: HASH,
      b_universe_hash_after: HASH,
      a_blockscan_view_hash_after: HASH,
      b_blockscan_view_hash_after: HASH,
      a_blockscan_graph_hash_after: HASH,
      b_blockscan_graph_hash_after: HASH,
    },
    deterministic_gate: { result: "pass", evidence: "pinned sample advanced one stage" },
    analysis: {
      agent_manual_author: "manual-agent",
      agent_manual_verdict: manual,
      agent_manual_evidence: "manual route and stage analysis completed before tools",
      agent_manual_written_at: "2026-07-14T01:00:00.000Z",
      agent_manual_artifact: "manual.json",
      agent_manual_artifact_sha256: manualHash,
      comparator_started_at: "2026-07-14T01:05:00.000Z",
      script_exit_code: 0,
      script_assessment: script,
      script_artifact: "compare.json",
      reconciliation: verdict === "needs_escalation" ? "inconclusive" : "agree",
      tool_selection: {
        capability_query: [
          "single-transaction", "causality", "pnl", "competitor-window",
          "classification", "block-scan", "ab", "comparison",
        ],
        selected_tools: [
          "analysis:bundle-postmortem",
          "repo:scripts/census-gap.sh",
          "analysis:ab-canary-compare",
        ],
        catalog_check_exit_code: 0,
        evidence_manifest: "tools.json",
        evidence_manifest_sha256: toolManifestHash,
      },
      ...(verdict === "win" || verdict === "needs_escalation" ? {
        adversarial_review: {
          verdict: manual,
          evidence: "fresh non-author checked the causal interpretation",
          reviewer: "review-agent",
        },
      } : {}),
    },
    final_verdict: verdict,
    branch_action: verdict === "win" ? "pending_merge" : verdict === "lose" ? "pending_delete" : "retained",
    b_stopped: true,
    evidence_bundle: "redacted evidence bundle",
    mergeability: {
      current_main_commit: base,
      tested_base_is_current: true,
      evidence: "origin/main equals the tested base",
    },
    resolution_replay: {
      cwd: "analysis",
      argv: ["npm", "run", "test:ab-canary"],
      timeout_seconds: 1200,
      expected_transition: "same pinned sample advances one production stage",
    },
    ...(verdict === "win" ? {
      production_evidence: {
        searcher_behavior_change: true,
        strategy_kind: "block-scan" as const,
        trigger_kind: "standing-state" as const,
        route_scope: "dex-permissionless-protocol" as const,
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
          evidence: "priced terminal deltas prove positive net profit and no victim dependency",
          expected_route: [
            {
              adapterId: "univ3-swap",
              slotKind: "swap" as const,
              target: `0x${"2".repeat(40)}`,
              poolId: `0x${"2".repeat(40)}`,
              tokenIn: `0x${"3".repeat(40)}`,
              tokenOut: `0x${"4".repeat(40)}`,
            },
            {
              adapterId: "erc4626-deposit",
              slotKind: "protocol" as const,
              target: `0x${"5".repeat(40)}`,
              tokenIn: `0x${"4".repeat(40)}`,
              tokenOut: `0x${"6".repeat(40)}`,
            },
            {
              adapterId: "univ3-swap",
              slotKind: "swap" as const,
              target: `0x${"7".repeat(40)}`,
              poolId: `0x${"7".repeat(40)}`,
              tokenIn: `0x${"6".repeat(40)}`,
              tokenOut: `0x${"3".repeat(40)}`,
            },
          ],
        },
        classification_review: {
          verdict: "pass" as const,
          reviewer: "classification-reviewer",
          evidence: "fresh trace confirms a conserving standing-state closed loop",
        },
        baseline_stage: "not_admitted" as const,
        challenger_stage: "path_found" as const,
        replay: {
          result: "pass" as const,
          cwd: "listener",
          argv: ["node", "--import", "tsx", "src/searcher/test/blockscan-hunt.ts"],
          evidence: "trusted replay advances the same sample",
        },
      },
    } : {}),
  };
}

interface Fixture {
  tmp: string;
  repo: string;
  remote: string;
  reportPath: string;
  branch: string;
  challenger: string;
}

function fixture(verdict: "win" | "lose" | "needs_escalation", hermesPass = true): Fixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-promotion-"));
  const remote = path.join(tmp, "remote.git");
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "A/B Promotion Test"]);
  git(repo, ["remote", "add", "origin", remote]);
  fs.mkdirSync(path.join(repo, "analysis"), { recursive: true });
  fs.cpSync(path.join(sourceRoot, "analysis/src"), path.join(repo, "analysis/src"), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, "analysis/package.json"), path.join(repo, "analysis/package.json"));
  fs.copyFileSync(path.join(sourceRoot, "analysis/tsconfig.json"), path.join(repo, "analysis/tsconfig.json"));
  fs.cpSync(path.join(sourceRoot, "scripts"), path.join(repo, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(repo, "listener"), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, "listener/package.json"), path.join(repo, "listener/package.json"));
  fs.symlinkSync(fs.realpathSync(path.join(sourceRoot, "analysis/node_modules")), path.join(repo, "analysis/node_modules"), "junction");
  const packageJson = JSON.parse(fs.readFileSync(path.join(repo, "analysis/package.json"), "utf8"));
  packageJson.scripts["hermes-gate"] = "node hermes-gate-stub.mjs src/cli/hermes-gate.ts";
  fs.writeFileSync(path.join(repo, "analysis/package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  fs.writeFileSync(path.join(repo, "analysis/hermes-gate-stub.mjs"), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "if (fs.existsSync('../hermes.fail')) process.exit(1);",
    "const report = process.argv.at(-1);",
    "const md = fs.readFileSync(report, 'utf8');",
    "const artifact = md.match(/^artifact:\\s*(\\S+)\\s*$/m)?.[1];",
    "if (!artifact || !fs.existsSync(path.resolve('..', artifact))) process.exit(2);",
    "process.exit(0);",
    "",
  ].join("\n"));
  if (!hermesPass) fs.writeFileSync(path.join(repo, "hermes.fail"), "fail\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["push", "-u", "origin", "main"]);

  const branch = `ab/close-${verdict}`;
  git(repo, ["switch", "-c", branch]);
  const reportPath = `docs/research/reports/ab-close-${verdict}-hermes.md`;
  const reportDir = path.join(repo, path.dirname(reportPath));
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(repo, reportPath), "# Predeclared A/B report\n");
  git(repo, ["add", reportPath]);
  git(repo, ["commit", "-m", "predeclare A/B experiment"]);
  fs.writeFileSync(path.join(repo, "feature.txt"), `${verdict} challenger behavior\n`);
  git(repo, ["add", "feature.txt"]);
  git(repo, ["commit", "-m", "challenger behavior"]);
  const challenger = git(repo, ["rev-parse", "HEAD"]);
  const manual = {
    schema_version: 2,
    experiment_id: `ab-close-${verdict}`,
    author: "manual-agent",
    verdict: verdict === "needs_escalation" ? "inconclusive" : verdict,
    evidence: "manual route and stage analysis completed before tools",
    written_at: "2026-07-14T01:00:00.000Z",
    a_log_sha256: HASH,
    b_log_sha256: HASH,
    a_log_bytes: 1,
    b_log_bytes: 1,
    seal_nonce: "e".repeat(48),
  };
  const manualSource = `${JSON.stringify(manual, null, 2)}\n`;
  const manualHash = createHash("sha256").update(manualSource).digest("hex");
  fs.writeFileSync(path.join(reportDir, "manual.json"), manualSource);
  fs.writeFileSync(path.join(reportDir, "compare.json"), `${JSON.stringify({
    script_assessment: verdict === "win" ? "supports" : verdict === "lose" ? "contradicts" : "inconclusive",
    paired_blocks: 2,
    require_output_match: false,
    output_mismatches: 0,
    comparator_started_at: "2026-07-14T01:05:00.000Z",
    manual_verdict_sha256: manualHash,
    manual_verdict_written_at: "2026-07-14T01:00:00.000Z",
    manual_seal_nonce: "e".repeat(48),
    a_log_sha256: HASH,
    b_log_sha256: HASH,
  })}\n`);
  const indexed = discoverToolIndex(repo);
  const selectedIds = [
    "analysis:bundle-postmortem",
    "repo:scripts/census-gap.sh",
    "analysis:ab-canary-compare",
  ];
  const capabilities = [
    "single-transaction", "causality", "pnl", "competitor-window",
    "classification", "block-scan", "ab", "comparison",
  ];
  const toolsManifest: ToolExecutionManifest = {
    schema_version: 2,
    repo_root: repo,
    pending_nonce: null,
    requested_capabilities: capabilities,
    recommended_tools: indexed.filter((tool) => selectedIds.includes(tool.id)),
    related_tools: [],
    executions: selectedIds.map((toolId) => {
      const tool = indexed.find((entry) => entry.id === toolId)!;
      const argv = toolId === "repo:scripts/census-gap.sh"
        ? ["bash", tool.implementation ?? tool.script, "1", "2"]
        : ["npm", "run", tool.script, "--"];
      return {
        schema_version: 1 as const,
        tool_id: toolId,
        descriptor_sha256: toolDescriptorSha256(tool),
        started_at: "2026-07-14T00:59:00.000Z",
        finished_at: "2026-07-14T00:59:59.000Z",
        exit_code: 0,
        cwd: tool.package,
        argv_sha256: HASH,
        argv_redacted: argv,
        ...(tool.capabilities.includes("competitor-window") ? { window: { from: 1, to: 2 } } : {}),
        stdout_sha256: HASH,
        stderr_sha256: HASH,
        stdout_bytes: 1,
        stderr_bytes: 0,
      };
    }),
    generated_at: "2026-07-14T00:58:00.000Z",
    updated_at: "2026-07-14T00:59:59.000Z",
  };
  const toolsSource = `${JSON.stringify(toolsManifest, null, 2)}\n`;
  const toolsHash = createHash("sha256").update(toolsSource).digest("hex");
  fs.writeFileSync(path.join(reportDir, "tools.json"), toolsSource);
  const step1Path = `docs/research/reports/step1-ab-close-${verdict}.json`;
  fs.writeFileSync(path.join(repo, step1Path), `${JSON.stringify({ schema_version: 1 })}\n`);
  fs.writeFileSync(
    path.join(repo, reportPath),
    `# A/B close fixture\n\n\`\`\`ab_experiment\n${JSON.stringify(experiment(base, challenger, verdict, manualHash, toolsHash), null, 2)}\n\`\`\`\n\n`
      + `\`\`\`step1\nrun_id: ab-close-${verdict}\nwindow_blocks: 1..2\nwatchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671\nartifact: ${step1Path}\nmethod: manual-onchain-trace\nfable_manual: no\n\`\`\`\n`,
  );
  git(repo, ["add", "docs"]);
  git(repo, ["commit", "-m", "record agent/tool decision"]);
  git(repo, ["push", "-u", "origin", branch]);
  git(repo, ["switch", "main"]);
  return { tmp, repo, remote, reportPath, branch, challenger };
}

test("agent-decided win merges the frozen challenger, archives, and deletes the branch", { timeout: 60_000 }, () => {
  const value = fixture("win");
  const result = closePromotion(value.repo, value.reportPath);
  assert.equal(result.status, "merged_deleted");
  assert.equal(git(value.repo, ["ls-remote", "--heads", "origin", `refs/heads/${value.branch}`]), "");
  const archived = execFileSync("git", ["--git-dir", value.remote, "show", `main:${value.reportPath}`], { encoding: "utf8" });
  const parsed = parseAbExperiment(archived);
  assert.equal(parsed.branch_action, "merged_deleted");
  assert.match(parsed.closing_branch_tip ?? "", /^[a-f0-9]{40}$/);
  assert.equal(execFileSync("git", ["--git-dir", value.remote, "show", "main:feature.txt"], { encoding: "utf8" }), "win challenger behavior\n");
  const parents = execFileSync("git", ["--git-dir", value.remote, "rev-list", "--parents", "-n", "1", parsed.merge_commit!], { encoding: "utf8" }).trim().split(/\s+/);
  assert.equal(parents.length, 3);
  assert.equal(parents[2], value.challenger);

  const retry = closePromotion(value.repo, value.reportPath);
  assert.equal(retry.status, "merged_deleted");
});

test("agent-decided lose archives evidence without merging challenger code and deletes the branch", { timeout: 60_000 }, () => {
  const value = fixture("lose");
  const result = closePromotion(value.repo, value.reportPath);
  assert.equal(result.status, "deleted_unmerged");
  assert.equal(git(value.repo, ["ls-remote", "--heads", "origin", `refs/heads/${value.branch}`]), "");
  assert.throws(() => execFileSync("git", ["--git-dir", value.remote, "show", "main:feature.txt"], { stdio: "pipe" }));
  const archived = execFileSync("git", ["--git-dir", value.remote, "show", `main:${value.reportPath}`], { encoding: "utf8" });
  assert.equal(parseAbExperiment(archived).branch_action, "deleted_unmerged");
});

test("lose close resumes after archive push but before branch deletion", { timeout: 60_000 }, () => {
  const value = fixture("lose");
  const branchTip = git(value.repo, ["rev-parse", `origin/${value.branch}`]);
  const decisionMd = git(value.repo, ["show", `origin/${value.branch}:${value.reportPath}`]);
  const decision = parseAbExperiment(decisionMd);
  const closed: AbExperiment = {
    ...decision,
    branch_action: "deleted_unmerged",
    closing_branch_tip: branchTip,
  };
  const reportFile = path.join(value.repo, value.reportPath);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${rewriteAbExperiment(decisionMd, closed)}\n`);
  const artifact = path.join(path.dirname(reportFile), "compare.json");
  fs.writeFileSync(artifact, git(value.repo, ["show", `origin/${value.branch}:${path.posix.join(path.posix.dirname(value.reportPath), "compare.json")}`]));
  const manual = path.join(path.dirname(reportFile), "manual.json");
  fs.writeFileSync(manual, execFileSync("git", [
    "-C", value.repo, "show", `origin/${value.branch}:${path.posix.join(path.posix.dirname(value.reportPath), "manual.json")}`,
  ]));
  const tools = path.join(path.dirname(reportFile), "tools.json");
  fs.writeFileSync(tools, execFileSync("git", [
    "-C", value.repo, "show", `origin/${value.branch}:${path.posix.join(path.posix.dirname(value.reportPath), "tools.json")}`,
  ]));
  const step1 = `docs/research/reports/step1-ab-close-lose.json`;
  fs.mkdirSync(path.join(value.repo, path.dirname(step1)), { recursive: true });
  fs.writeFileSync(path.join(value.repo, step1), git(value.repo, ["show", `origin/${value.branch}:${step1}`]));
  git(value.repo, ["add", value.reportPath, path.relative(value.repo, artifact), path.relative(value.repo, manual), path.relative(value.repo, tools), step1]);
  git(value.repo, ["commit", "-m", "archive lose before interrupted cleanup"]);
  git(value.repo, ["push", "origin", "main"]);

  const result = closePromotion(value.repo, value.reportPath);
  assert.equal(result.status, "deleted_unmerged");
  assert.equal(git(value.repo, ["ls-remote", "--heads", "origin", `refs/heads/${value.branch}`]), "");
});

test("Hermes close gate veto leaves main and challenger untouched", { timeout: 60_000 }, () => {
  const value = fixture("win", false);
  const mainBefore = git(value.repo, ["rev-parse", "origin/main"]);
  assert.throws(() => closePromotion(value.repo, value.reportPath), /Hermes gate exited/);
  assert.equal(git(value.repo, ["rev-parse", "origin/main"]), mainBefore);
  assert.notEqual(git(value.repo, ["ls-remote", "--heads", "origin", `refs/heads/${value.branch}`]), "");
});

test("atomic promotion push refuses a branch that advances after adjudication without moving main", { timeout: 30_000 }, () => {
  const value = fixture("lose");
  const mainBefore = git(value.repo, ["rev-parse", "origin/main"]);
  const expectedTip = git(value.repo, ["rev-parse", `origin/${value.branch}`]);
  const second = path.join(value.tmp, "second");
  execFileSync("git", ["clone", value.remote, second], { stdio: "ignore" });
  git(second, ["config", "user.email", "test@example.com"]);
  git(second, ["config", "user.name", "Branch Race"]);
  git(second, ["switch", value.branch]);
  fs.writeFileSync(path.join(second, "race.txt"), "advanced\n");
  git(second, ["add", "race.txt"]);
  git(second, ["commit", "-m", "advance branch during close"]);
  git(second, ["push", "origin", value.branch]);

  fs.writeFileSync(path.join(value.repo, "archive.txt"), "candidate main update\n");
  git(value.repo, ["add", "archive.txt"]);
  git(value.repo, ["commit", "-m", "candidate archive"]);
  assert.throws(() => pushPromotionAtomically(value.repo, mainBefore, value.branch, expectedTip));
  assert.equal(git(value.repo, ["ls-remote", "--heads", "origin", "refs/heads/main"]).split(/\s+/)[0], mainBefore);
});

test("needs_escalation remains an agent decision and is never auto-deleted", { timeout: 30_000 }, () => {
  const value = fixture("needs_escalation");
  assert.throws(() => closePromotion(value.repo, value.reportPath), /only an agent-decided win or lose/);
  assert.notEqual(git(value.repo, ["ls-remote", "--heads", "origin", `refs/heads/${value.branch}`]), "");
});

test("close refuses to discard non-evidence work committed after the frozen challenger", { timeout: 30_000 }, () => {
  const value = fixture("win");
  git(value.repo, ["switch", value.branch]);
  fs.writeFileSync(path.join(value.repo, "late-runtime-change.txt"), "must not be silently discarded\n");
  git(value.repo, ["add", "late-runtime-change.txt"]);
  git(value.repo, ["commit", "-m", "unexpected work after freeze"]);
  git(value.repo, ["push", "origin", value.branch]);
  git(value.repo, ["switch", "main"]);
  assert.throws(() => closePromotion(value.repo, value.reportPath), /outside decision evidence/);
  assert.notEqual(git(value.repo, ["ls-remote", "--heads", "origin", `refs/heads/${value.branch}`]), "");
});

test("close refuses evidence paths that escape the report directory", { timeout: 30_000 }, () => {
  const value = fixture("win");
  git(value.repo, ["switch", value.branch]);
  const reportFile = path.join(value.repo, value.reportPath);
  const source = fs.readFileSync(reportFile, "utf8");
  const experiment = parseAbExperiment(source);
  experiment.analysis.agent_manual_artifact = "../../../listener/src/searcher/fake-evidence.json";
  fs.writeFileSync(reportFile, rewriteAbExperiment(source, experiment));
  git(value.repo, ["add", value.reportPath]);
  git(value.repo, ["commit", "-m", "attempt evidence path escape"]);
  git(value.repo, ["push", "origin", value.branch]);
  git(value.repo, ["switch", "main"]);
  assert.throws(() => closePromotion(value.repo, value.reportPath), /inside the report directory/);
  assert.notEqual(git(value.repo, ["ls-remote", "--heads", "origin", `refs/heads/${value.branch}`]), "");
});
