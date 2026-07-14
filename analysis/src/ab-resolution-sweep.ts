import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseAbExperiment,
  validateAbExperiment,
  validateResolutionReplay,
  type AbExperiment,
  type ResolutionReplaySpec,
} from "./ab-canary.js";

export interface AbResolutionClaim {
  schema_version: 1;
  problem_id: string;
  branch: string;
  report_path: string;
  retained_branch_tip: string;
  resolved_by_commit: string;
  evidence: string;
}

export interface RetainedExperiment {
  branch: string;
  ref: string;
  tip: string;
  report_path: string | null;
  experiment: AbExperiment | null;
  issue?: string;
}

export interface ResolutionSweepEntry {
  branch: string;
  problem_id: string | null;
  report_path: string | null;
  claim_path: string | null;
  status: "retained" | "missing_report" | "ready" | "replay_passed" | "resolved_deleted";
  detail: string;
}

const BRANCH_RE = /^ab\/[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const SHA_RE = /^[a-f0-9]{40}$/i;
const REPORT_RE = /^docs\/research\/reports\/[A-Za-z0-9._/-]+\.md$/;
const CLAIM_RE = /^docs\/research\/resolutions\/[A-Za-z0-9._-]+\.json$/;
const CLAIM_KEYS = new Set([
  "schema_version",
  "problem_id",
  "branch",
  "report_path",
  "retained_branch_tip",
  "resolved_by_commit",
  "evidence",
]);

export function git(repoRoot: string, args: string[], options: { trim?: boolean } = {}): string {
  const output = execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return options.trim === false ? output : output.trim();
}

export function gitSucceeds(repoRoot: string, args: string[]): boolean {
  try {
    execFileSync("git", ["-C", repoRoot, ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function refSha(repoRoot: string, ref: string): string | null {
  try {
    return git(repoRoot, ["rev-parse", "--verify", ref]);
  } catch {
    return null;
  }
}

export function remoteBranchSha(repoRoot: string, branch: string): string | null {
  const line = git(repoRoot, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
  return line ? line.split(/\s+/)[0] : null;
}

export function remoteMainSha(repoRoot: string): string {
  const line = git(repoRoot, ["ls-remote", "--heads", "origin", "refs/heads/main"]);
  if (!line) throw new Error("origin/main is unavailable");
  return line.split(/\s+/)[0];
}

export function validateResolutionClaim(claim: AbResolutionClaim): string[] {
  const errors: string[] = [];
  if (!claim || typeof claim !== "object") return ["resolution claim must be an object"];
  for (const key of Object.keys(claim)) {
    if (!CLAIM_KEYS.has(key)) errors.push(`unexpected claim field ${key}`);
  }
  if (claim.schema_version !== 1) errors.push("schema_version must be 1");
  if (!claim.problem_id?.trim()) errors.push("problem_id is required");
  if (!BRANCH_RE.test(claim.branch ?? "")) errors.push("branch must be a literal ab/* branch");
  if (!REPORT_RE.test(claim.report_path ?? "")) errors.push("report_path must be docs/research/reports/*.md");
  if (!SHA_RE.test(claim.retained_branch_tip ?? "")) errors.push("retained_branch_tip must be a full SHA");
  if (!SHA_RE.test(claim.resolved_by_commit ?? "")) errors.push("resolved_by_commit must be a full SHA");
  if (!claim.evidence?.trim() || /[<>]/.test(claim.evidence)) errors.push("evidence is required");
  return errors;
}

export function updateResolvedReport(md: string, claim: AbResolutionClaim): string {
  const experiment = parseAbExperiment(md);
  if (experiment.branch !== claim.branch) {
    throw new Error(`claim branch ${claim.branch} does not match report branch ${experiment.branch}`);
  }
  if (experiment.problem_id !== claim.problem_id) {
    throw new Error(`claim problem_id ${claim.problem_id} does not match report ${experiment.problem_id}`);
  }
  if (experiment.final_verdict !== "needs_escalation" || experiment.branch_action !== "retained") {
    throw new Error("only retained needs_escalation reports can be resolution-swept");
  }
  const replayErrors = validateResolutionReplay(experiment.resolution_replay);
  if (replayErrors.length > 0) {
    throw new Error(`retained report has no usable pinned resolution replay: ${replayErrors.join("; ")}`);
  }
  const replay = experiment.resolution_replay!;
  const expectedTransition = replay.expected_transition.replace(/\s*->\s*/g, " to ").replace(/[<>]/g, "");
  const updated: AbExperiment = {
    ...experiment,
    branch_action: "resolved_deleted",
    b_stopped: true,
    resolution: {
      resolved_by_commit: claim.resolved_by_commit,
      evidence: `${claim.evidence}; expected_transition=${expectedTransition}; replay=${replay.cwd}/${replay.argv.join(" ")}`,
    },
  };
  const replacement = `\`\`\`ab_experiment\n${JSON.stringify(updated, null, 2)}\n\`\`\``;
  return md.replace(/```ab_experiment\s*\n[\s\S]*?\n```/, replacement);
}

function refs(repoRoot: string, prefix: string, format: string): string[] {
  const output = git(repoRoot, ["for-each-ref", `--format=${format}`, prefix]);
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function filesAtRef(repoRoot: string, ref: string, root: string, pattern: RegExp): string[] {
  const output = git(repoRoot, ["ls-tree", "-r", "--name-only", ref, root]);
  return output ? output.split(/\r?\n/).filter((file) => pattern.test(file)) : [];
}

function reportsAtRef(repoRoot: string, ref: string): string[] {
  return filesAtRef(repoRoot, ref, "docs/research/reports", REPORT_RE);
}

export function fileAtRef(repoRoot: string, ref: string, filePath: string): string {
  return git(repoRoot, ["show", `${ref}:${filePath}`], { trim: false });
}

export function discoverRetainedExperiments(repoRoot: string, mainRef = "origin/main"): RetainedExperiment[] {
  const branchRefs = new Map<string, string>();
  for (const branch of refs(repoRoot, "refs/remotes/origin/ab/", "%(refname:short)")) {
    branchRefs.set(branch.replace(/^origin\//, ""), branch);
  }
  for (const branch of refs(repoRoot, "refs/heads/ab/", "%(refname:short)")) {
    if (!branchRefs.has(branch)) branchRefs.set(branch, branch);
  }

  return [...branchRefs].sort(([a], [b]) => a.localeCompare(b)).map(([branch, branchRef]) => {
    const tip = refSha(repoRoot, branchRef);
    if (!tip) throw new Error(`cannot resolve retained branch ${branchRef}`);
    const matches: Array<{ ref: string; reportPath: string; experiment: AbExperiment }> = [];
    for (const ref of [branchRef, mainRef]) {
      for (const reportPath of reportsAtRef(repoRoot, ref)) {
        try {
          const experiment = parseAbExperiment(fileAtRef(repoRoot, ref, reportPath));
          if (experiment.branch === branch && experiment.branch_action === "retained"
              && !matches.some((match) => match.reportPath === reportPath)) {
            matches.push({ ref, reportPath, experiment });
          }
        } catch {
          // Reports for other branches are irrelevant to this retained ref.
        }
      }
    }
    if (matches.length === 1) {
      return {
        branch,
        ref: matches[0].ref,
        tip,
        report_path: matches[0].reportPath,
        experiment: matches[0].experiment,
      };
    }
    return {
      branch,
      ref: branchRef,
      tip,
      report_path: null,
      experiment: null,
      issue: matches.length === 0 ? "no retained report found on branch" : "multiple retained reports found on branch",
    };
  });
}

function localClaimPaths(repoRoot: string): string[] {
  const directory = path.join(repoRoot, "docs/research/resolutions");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => `docs/research/resolutions/${name}`);
}

export function loadResolutionClaims(
  repoRoot: string,
  mainRef = "origin/main",
): Array<{ path: string; claim: AbResolutionClaim; source: string }> {
  const committedPaths = filesAtRef(repoRoot, mainRef, "docs/research/resolutions", CLAIM_RE);
  const committed = new Map(committedPaths.map((claimPath) => [claimPath, fileAtRef(repoRoot, mainRef, claimPath)]));
  for (const claimPath of localClaimPaths(repoRoot)) {
    const local = fs.readFileSync(path.join(repoRoot, claimPath), "utf8");
    const main = committed.get(claimPath);
    if (main === undefined) {
      throw new Error(`${claimPath} must be committed on origin/main before it can authorize replay or cleanup`);
    }
    if (local !== main) {
      throw new Error(`${claimPath} differs from origin/main; refusing an uncommitted resolution claim`);
    }
  }
  return [...committed].map(([claimPath, source]) => {
    const claim = JSON.parse(source) as AbResolutionClaim;
    const errors = validateResolutionClaim(claim);
    if (errors.length > 0) throw new Error(`${claimPath}: ${errors.join("; ")}`);
    return { path: claimPath, claim, source };
  });
}

function dependencyRoot(repoRoot: string): string {
  const commonDir = git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return path.dirname(commonDir);
}

function linkDependencies(sourceRoot: string, worktree: string): void {
  const candidates = [sourceRoot, dependencyRoot(sourceRoot)];
  for (const relative of ["analysis/node_modules", "listener/node_modules", "node_modules", "contracts/lib", "listener/out"]) {
    const source = candidates.map((root) => path.join(root, relative)).find((candidate) => fs.existsSync(candidate));
    const destination = path.join(worktree, relative);
    if (!source || fs.existsSync(destination)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(fs.realpathSync(source), destination, "junction");
  }
}

export function withDetachedWorktree<T>(repoRoot: string, commit: string, action: (worktree: string) => T): T {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mev-ab-resolution-"));
  const worktree = path.join(parent, "repo");
  git(repoRoot, ["worktree", "add", "--detach", worktree, commit]);
  try {
    linkDependencies(repoRoot, worktree);
    return action(worktree);
  } finally {
    try {
      git(repoRoot, ["worktree", "remove", "--force", worktree]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }
}

function verifyCommit(
  repoRoot: string,
  retained: RetainedExperiment,
  claim: AbResolutionClaim,
  mainAtStart: string,
): void {
  if (!gitSucceeds(repoRoot, ["cat-file", "-e", `${claim.resolved_by_commit}^{commit}`])) {
    throw new Error(`${claim.resolved_by_commit} is not a commit`);
  }
  if (!gitSucceeds(repoRoot, ["merge-base", "--is-ancestor", retained.experiment!.base_commit, claim.resolved_by_commit])) {
    throw new Error("resolved_by_commit does not descend from the retained experiment base");
  }
  if (!gitSucceeds(repoRoot, ["merge-base", "--is-ancestor", claim.resolved_by_commit, mainAtStart])) {
    throw new Error("resolved_by_commit is not on the captured origin/main");
  }
}

interface ReplayOutcome {
  status: number;
  output: string;
}

function runReplay(repoRoot: string, commit: string, replay: ResolutionReplaySpec): ReplayOutcome {
  const replayErrors = validateResolutionReplay(replay);
  if (replayErrors.length > 0) throw new Error(replayErrors.join("; "));
  return withDetachedWorktree(repoRoot, commit, (worktree) => {
    const cwd = path.resolve(worktree, replay.cwd);
    if (cwd !== worktree && !cwd.startsWith(`${worktree}${path.sep}`)) {
      throw new Error("resolution replay cwd escaped the detached worktree");
    }
    if (!fs.existsSync(cwd)) throw new Error(`resolution replay cwd does not exist: ${replay.cwd}`);
    const result = spawnSync(replay.argv[0], replay.argv.slice(1), {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: (replay.timeout_seconds ?? 1_200) * 1_000,
      env: process.env,
    });
    if (result.error) throw new Error(`resolution replay failed to start: ${result.error.message}`);
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (result.status === null) throw new Error(`resolution replay ended by signal: ${output.slice(-4_000)}`);
    return { status: result.status, output: output.slice(-4_000) };
  });
}

function verifyReplayFrozenAtChallenger(repoRoot: string, retained: RetainedExperiment): void {
  let frozenSource: string;
  try {
    frozenSource = fileAtRef(repoRoot, retained.experiment!.challenger_commit, retained.report_path!);
  } catch {
    throw new Error("retained replay cannot be trusted: the predeclared report is absent at challenger_commit");
  }
  const frozen = parseAbExperiment(frozenSource).resolution_replay;
  if (JSON.stringify(frozen) !== JSON.stringify(retained.experiment!.resolution_replay)) {
    throw new Error("retained replay changed after challenger_commit; keep the branch for manual resolution");
  }
}

function verifyReplayFlip(repoRoot: string, retained: RetainedExperiment, resolvedCommit: string): string {
  const replay = retained.experiment!.resolution_replay!;
  verifyReplayFrozenAtChallenger(repoRoot, retained);
  const baseline = runReplay(repoRoot, retained.experiment!.base_commit, replay);
  if (baseline.status === 0) {
    throw new Error("resolution replay is not discriminating: it already passes at base_commit");
  }
  const resolved = runReplay(repoRoot, resolvedCommit, replay);
  if (resolved.status !== 0) {
    throw new Error(`resolution replay still fails at resolved_by_commit (exit ${resolved.status}): ${resolved.output}`);
  }
  return resolved.output || `baseline exit ${baseline.status} -> resolved exit 0`;
}

function branchWorktrees(repoRoot: string, branch: string): string[] {
  const lines = git(repoRoot, ["worktree", "list", "--porcelain"]).split(/\r?\n/);
  const result: string[] = [];
  let current: string | null = null;
  for (const line of lines) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branch}` && current) result.push(current);
  }
  return result;
}

export function assertBranchPinned(repoRoot: string, branch: string, expected: string, allowAbsent = false): void {
  const remote = remoteBranchSha(repoRoot, branch);
  const local = refSha(repoRoot, `refs/heads/${branch}`);
  const tracking = refSha(repoRoot, `refs/remotes/origin/${branch}`);
  for (const [name, actual] of [["remote", remote], ["local", local], ["tracking", tracking]] as const) {
    if (actual !== null && actual !== expected) {
      throw new Error(`refusing cleanup: ${name} ${branch} advanced or diverged (${actual} != ${expected})`);
    }
  }
  if (!allowAbsent && remote === null && local === null) {
    throw new Error(`refusing cleanup: retained branch ${branch} no longer exists`);
  }
  for (const worktree of branchWorktrees(repoRoot, branch)) {
    if (fs.realpathSync(worktree) === fs.realpathSync(repoRoot)) {
      throw new Error("refusing cleanup: run the sweep from a main checkout, not the retained branch worktree");
    }
    const head = git(worktree, ["rev-parse", "HEAD"]);
    if (head !== expected) throw new Error(`refusing cleanup: ${worktree} HEAD advanced (${head} != ${expected})`);
    const status = git(worktree, ["status", "--porcelain"]);
    if (status) throw new Error(`refusing cleanup: ${worktree} has uncommitted changes`);
  }
}

export function assertMain(repoRoot: string, expected: string): void {
  const actual = remoteMainSha(repoRoot);
  if (actual !== expected) throw new Error(`origin/main moved during resolution sweep (${actual} != ${expected})`);
}

export function runAbGate(
  mainWorktree: string,
  reportPath: string,
  phase: "decision" | "close",
  authorize: boolean,
): void {
  const args = ["run", "ab-canary-gate", "--", `../${reportPath}`, "--phase", phase];
  if (authorize) args.push("--authorize-cleanup");
  const result = spawnSync("npm", args, {
    cwd: path.join(mainWorktree, "analysis"),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (result.error) throw new Error(`ab cleanup gate failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`ab cleanup gate exited ${result.status ?? "signal"}: ${`${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim()}`);
  }
}

export function runHermesGate(mainWorktree: string, reportPath: string): void {
  const result = spawnSync("npm", ["run", "hermes-gate", "--", `../${reportPath}`], {
    cwd: path.join(mainWorktree, "analysis"),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (result.error) throw new Error(`Hermes gate failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Hermes gate exited ${result.status ?? "signal"}: ${`${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim()}`);
  }
}

function validateResolvedReport(resolvedReport: string, reportPath: string): void {
  const reportErrors = validateAbExperiment(parseAbExperiment(resolvedReport), reportPath, "close");
  if (reportErrors.length > 0) {
    throw new Error(`resolved report does not pass close validation: ${reportErrors.join("; ")}`);
  }
}

function archiveReport(
  repoRoot: string,
  mainAtStart: string,
  reportPath: string,
  claimPath: string,
  claimSource: string,
  resolvedReport: string,
  problemId: string,
): string {
  let existing: string | null = null;
  try {
    existing = fileAtRef(repoRoot, mainAtStart, reportPath);
  } catch {
    // First durable archive of this retained report.
  }
  if (existing === resolvedReport) {
    withDetachedWorktree(repoRoot, mainAtStart, (mainWorktree) => runAbGate(mainWorktree, reportPath, "close", true));
    assertMain(repoRoot, mainAtStart);
    return mainAtStart;
  }
  if (existing !== null) {
    try {
      const parsed = parseAbExperiment(existing);
      if (parsed.branch_action === "resolved_deleted") {
        throw new Error("origin/main already contains a different resolved archive for this report");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("different resolved archive")) throw error;
    }
  }

  return withDetachedWorktree(repoRoot, mainAtStart, (mainWorktree) => {
    const reportFile = path.join(mainWorktree, reportPath);
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, resolvedReport);
    git(mainWorktree, ["add", "--", reportPath]);
    const staged = git(mainWorktree, ["diff", "--cached", "--name-only"]);
    if (!staged) throw new Error("resolved archive produced no report change");
    git(mainWorktree, ["commit", "-m", `archive resolved A/B experiment ${problemId}`]);
    const archiveCommit = git(mainWorktree, ["rev-parse", "HEAD"]);
    if (fileAtRef(mainWorktree, archiveCommit, claimPath) !== claimSource) {
      throw new Error("resolution claim changed while building the durable archive");
    }
    assertMain(repoRoot, mainAtStart);
    git(mainWorktree, ["push", "origin", "HEAD:main"]);
    assertMain(repoRoot, archiveCommit);
    runAbGate(mainWorktree, reportPath, "close", true);
    assertMain(repoRoot, archiveCommit);
    return archiveCommit;
  });
}

export function deletePinnedBranch(repoRoot: string, branch: string, expected: string): void {
  assertBranchPinned(repoRoot, branch, expected);
  for (const worktree of branchWorktrees(repoRoot, branch)) {
    git(repoRoot, ["worktree", "remove", worktree]);
  }
  const remote = remoteBranchSha(repoRoot, branch);
  if (remote !== null) {
    git(repoRoot, [
      "push",
      `--force-with-lease=refs/heads/${branch}:${expected}`,
      "origin",
      `:refs/heads/${branch}`,
    ]);
  }
  const local = refSha(repoRoot, `refs/heads/${branch}`);
  if (local !== null) {
    if (local !== expected) throw new Error(`local ${branch} advanced before deletion`);
    git(repoRoot, ["update-ref", "-d", `refs/heads/${branch}`, expected]);
  }
  if (remoteBranchSha(repoRoot, branch) !== null || refSha(repoRoot, `refs/heads/${branch}`) !== null) {
    throw new Error(`challenger cleanup incomplete for ${branch}`);
  }
}

function completedClaim(
  repoRoot: string,
  mainAtStart: string,
  claimPath: string,
  claim: AbResolutionClaim,
): ResolutionSweepEntry | null {
  if (remoteBranchSha(repoRoot, claim.branch) !== null || refSha(repoRoot, `refs/heads/${claim.branch}`) !== null) {
    return null;
  }
  let source: string;
  try {
    source = fileAtRef(repoRoot, mainAtStart, claim.report_path);
  } catch {
    return null;
  }
  const report = parseAbExperiment(source);
  if (report.branch !== claim.branch || report.problem_id !== claim.problem_id
      || report.branch_action !== "resolved_deleted"
      || report.resolution?.resolved_by_commit !== claim.resolved_by_commit) {
    return null;
  }
  return {
    branch: claim.branch,
    problem_id: claim.problem_id,
    report_path: claim.report_path,
    claim_path: claimPath,
    status: "resolved_deleted",
    detail: `already archived on ${mainAtStart}`,
  };
}

export function runResolutionSweep(
  repoRoot: string,
  mode: "scan" | "verify" | "apply",
): ResolutionSweepEntry[] {
  git(repoRoot, ["fetch", "origin", "--prune", "--quiet"]);
  const mainAtStart = git(repoRoot, ["rev-parse", "origin/main"]);
  const retained = discoverRetainedExperiments(repoRoot, mainAtStart);
  const claims = loadResolutionClaims(repoRoot, mainAtStart);
  const claimsByBranch = new Map<string, (typeof claims)[number]>();
  for (const item of claims) {
    if (claimsByBranch.has(item.claim.branch)) throw new Error(`multiple resolution claims target ${item.claim.branch}`);
    claimsByBranch.set(item.claim.branch, item);
  }
  const results: ResolutionSweepEntry[] = [];
  const seen = new Set<string>();

  for (const item of retained) {
    seen.add(item.branch);
    if (!item.experiment || !item.report_path) {
      results.push({
        branch: item.branch,
        problem_id: null,
        report_path: null,
        claim_path: null,
        status: "missing_report",
        detail: item.issue ?? "retained report unavailable",
      });
      continue;
    }
    const claimed = claimsByBranch.get(item.branch);
    if (!claimed) {
      results.push({
        branch: item.branch,
        problem_id: item.experiment.problem_id,
        report_path: item.report_path,
        claim_path: null,
        status: "retained",
        detail: "no main-committed resolution claim",
      });
      continue;
    }
    const { path: claimPath, claim, source: claimSource } = claimed;
    if (claim.problem_id !== item.experiment.problem_id || claim.report_path !== item.report_path) {
      throw new Error(`${claimPath} does not identify the retained branch report exactly`);
    }
    if (item.tip !== claim.retained_branch_tip) {
      throw new Error(`${claimPath} retained_branch_tip does not match discovered branch tip`);
    }
    const replayErrors = validateResolutionReplay(item.experiment.resolution_replay);
    if (replayErrors.length > 0) {
      throw new Error(`${item.report_path}: ${replayErrors.join("; ")}`);
    }
    assertBranchPinned(repoRoot, item.branch, claim.retained_branch_tip);
    verifyCommit(repoRoot, item, claim, mainAtStart);
    if (mode === "scan") {
      results.push({
        branch: item.branch,
        problem_id: item.experiment.problem_id,
        report_path: item.report_path,
        claim_path: claimPath,
        status: "ready",
        detail: `claim resolves at ${claim.resolved_by_commit}; branch tip ${claim.retained_branch_tip}`,
      });
      continue;
    }
    const replayOutput = verifyReplayFlip(repoRoot, item, claim.resolved_by_commit);
    if (mode === "verify") {
      results.push({
        branch: item.branch,
        problem_id: item.experiment.problem_id,
        report_path: item.report_path,
        claim_path: claimPath,
        status: "replay_passed",
        detail: replayOutput,
      });
      continue;
    }

    assertMain(repoRoot, mainAtStart);
    assertBranchPinned(repoRoot, item.branch, claim.retained_branch_tip);
    const sourceReport = fileAtRef(repoRoot, item.ref, claim.report_path);
    const resolvedReport = updateResolvedReport(sourceReport, claim);
    validateResolvedReport(resolvedReport, claim.report_path);
    const archiveCommit = archiveReport(
      repoRoot,
      mainAtStart,
      claim.report_path,
      claimPath,
      claimSource,
      resolvedReport,
      claim.problem_id,
    );
    assertMain(repoRoot, archiveCommit);
    assertBranchPinned(repoRoot, item.branch, claim.retained_branch_tip);
    deletePinnedBranch(repoRoot, item.branch, claim.retained_branch_tip);
    withDetachedWorktree(repoRoot, archiveCommit, (mainWorktree) => runAbGate(mainWorktree, claim.report_path, "close", false));
    assertMain(repoRoot, archiveCommit);
    results.push({
      branch: item.branch,
      problem_id: item.experiment.problem_id,
      report_path: item.report_path,
      claim_path: claimPath,
      status: "resolved_deleted",
      detail: `archived by ${archiveCommit}`,
    });
  }

  for (const { path: claimPath, claim } of claims) {
    if (seen.has(claim.branch)) continue;
    const completed = completedClaim(repoRoot, mainAtStart, claimPath, claim);
    if (completed) {
      if (mode !== "scan") {
        withDetachedWorktree(repoRoot, mainAtStart, (mainWorktree) => runAbGate(mainWorktree, claim.report_path, "close", false));
      }
      results.push(completed);
      continue;
    }
    results.push({
      branch: claim.branch,
      problem_id: claim.problem_id,
      report_path: claim.report_path,
      claim_path: claimPath,
      status: "missing_report",
      detail: "resolution claim has neither a pinned retained branch nor a matching resolved archive",
    });
  }
  return results;
}
