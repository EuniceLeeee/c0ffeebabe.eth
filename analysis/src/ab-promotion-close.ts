import fs from "node:fs";
import path from "node:path";
import { parseAbExperiment, type AbExperiment } from "./ab-canary.js";
import {
  assertBranchPinned,
  assertMain,
  deletePinnedBranch,
  fileAtRef,
  git,
  gitSucceeds,
  refSha,
  remoteBranchSha,
  runAbGate,
  runHermesGate,
  withDetachedWorktree,
} from "./ab-resolution-sweep.js";

const REPORT_RE = /^docs\/research\/reports\/[A-Za-z0-9._/-]+\.md$/;
const SHA_RE = /^[a-f0-9]{40}$/i;

export interface PromotionCloseResult {
  branch: string;
  verdict: "win" | "lose";
  status: "merged_deleted" | "deleted_unmerged";
  challenger_commit: string;
  merge_commit: string | null;
  archive_commit: string;
  report_path: string;
}

export function pushPromotionAtomically(
  worktree: string,
  expectedMain: string,
  branch: string,
  expectedBranchTip: string,
): void {
  git(worktree, [
    "push",
    "--atomic",
    `--force-with-lease=refs/heads/main:${expectedMain}`,
    `--force-with-lease=refs/heads/${branch}:${expectedBranchTip}`,
    "origin",
    "HEAD:refs/heads/main",
    `${expectedBranchTip}:refs/heads/${branch}`,
  ]);
}

export function rewriteAbExperiment(md: string, experiment: AbExperiment): string {
  const replacement = `\`\`\`ab_experiment\n${JSON.stringify(experiment, null, 2)}\n\`\`\``;
  if (!/```ab_experiment\s*\n[\s\S]*?\n```/.test(md)) {
    throw new Error("missing ```ab_experiment JSON block");
  }
  return md.replace(/```ab_experiment\s*\n[\s\S]*?\n```/, replacement);
}

function safeRepoPath(value: string, label: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must stay inside the repository`);
  }
  return normalized;
}

function artifactPath(reportPath: string, experiment: AbExperiment): string | null {
  if (experiment.analysis.script_exit_code !== 0) return null;
  const artifact = experiment.analysis.script_artifact?.trim();
  if (!artifact) throw new Error("successful comparison requires analysis.script_artifact");
  return relativeReportArtifact(reportPath, artifact, "analysis.script_artifact");
}

function relativeReportArtifact(reportPath: string, value: string | undefined, label: string): string {
  if (!value?.trim() || path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be relative to the report directory for automatic promotion`);
  }
  const relative = path.posix.normalize(value.replaceAll("\\", "/"));
  if (relative === ".." || relative.startsWith("../") || !relative.endsWith(".json")) {
    throw new Error(`${label} must be a JSON artifact inside the report directory`);
  }
  const reportDirectory = path.posix.dirname(reportPath);
  const artifact = safeRepoPath(path.posix.join(reportDirectory, relative), label);
  if (!artifact.startsWith(`${reportDirectory}/`)) {
    throw new Error(`${label} must stay inside the report directory`);
  }
  return artifact;
}

function step1Artifact(md: string): string {
  const block = md.match(/```step1\s*\n([\s\S]*?)\n```/)?.[1];
  const value = block?.match(/^artifact:\s*(\S+)\s*$/m)?.[1];
  if (!value || !/^docs\/research\/reports\/[A-Za-z0-9._/-]+\.json$/.test(value)) {
    throw new Error("Step-1 artifact must be a tracked docs/research/reports/*.json path");
  }
  return safeRepoPath(value, "step1.artifact");
}

function evidencePaths(reportPath: string, md: string, experiment: AbExperiment): string[] {
  const paths = new Set<string>([reportPath, step1Artifact(md)]);
  const artifact = artifactPath(reportPath, experiment);
  if (artifact) paths.add(artifact);
  paths.add(relativeReportArtifact(reportPath, experiment.analysis.agent_manual_artifact, "agent_manual_artifact"));
  paths.add(relativeReportArtifact(reportPath, experiment.analysis.tool_selection?.evidence_manifest, "tool_selection.evidence_manifest"));
  return [...paths];
}

function writeRefFile(repoRoot: string, sourceRef: string, worktree: string, repoPath: string): void {
  const destination = path.join(worktree, repoPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, fileAtRef(repoRoot, sourceRef, repoPath));
}

function materializeReport(
  repoRoot: string,
  sourceRef: string,
  worktree: string,
  reportPath: string,
  md: string,
  experiment: AbExperiment,
): string[] {
  const paths = evidencePaths(reportPath, md, experiment);
  const destination = path.join(worktree, reportPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, md);
  for (const artifact of paths) {
    if (artifact !== reportPath) writeRefFile(repoRoot, sourceRef, worktree, artifact);
  }
  return paths;
}

function tryFileAtRef(repoRoot: string, ref: string, repoPath: string): string | null {
  try {
    return fileAtRef(repoRoot, ref, repoPath);
  } catch {
    return null;
  }
}

function exactMergeCommit(repoRoot: string, mainRef: string, base: string, challenger: string): string | null {
  const commits = git(repoRoot, ["rev-list", "--merges", mainRef]).split(/\r?\n/).filter(Boolean);
  for (const commit of commits) {
    const parents = git(repoRoot, ["rev-list", "--parents", "-n", "1", commit]).split(/\s+/);
    if (parents.length === 3 && parents[1] === base && parents[2] === challenger) return commit;
  }
  return null;
}

function expectedCloseAction(verdict: "win" | "lose"): AbExperiment["branch_action"] {
  return verdict === "win" ? "merged_deleted" : "deleted_unmerged";
}

function decisionAction(verdict: "win" | "lose"): AbExperiment["branch_action"] {
  return verdict === "win" ? "pending_merge" : "pending_delete";
}

function assertOnlyDecisionEvidenceAfterFrozen(
  repoRoot: string,
  reportPath: string,
  experiment: AbExperiment,
  branchTip: string,
): void {
  const allowed = new Set([reportPath]);
  for (const artifact of evidencePaths(reportPath, fileAtRef(repoRoot, `origin/${experiment.branch}`, reportPath), experiment)) {
    allowed.add(artifact);
  }
  const changed = git(repoRoot, ["diff", "--name-only", experiment.challenger_commit, branchTip])
    .split(/\r?\n/)
    .filter(Boolean);
  const unexpected = changed.filter((repoPath) => !allowed.has(repoPath));
  if (unexpected.length > 0) {
    throw new Error(`challenger branch changed after frozen SHA outside decision evidence: ${unexpected.join(", ")}`);
  }
}

function validateIdentity(experiment: AbExperiment, reportPath: string): "win" | "lose" {
  if (!REPORT_RE.test(reportPath)) throw new Error("report_path must be docs/research/reports/*.md");
  if (experiment.schema_version !== 3) {
    throw new Error("automatic promotion requires schema_version=3 evidence binding");
  }
  if (experiment.final_verdict !== "win" && experiment.final_verdict !== "lose") {
    throw new Error("promotion closer accepts only an agent-decided win or lose; needs_escalation must retain");
  }
  if (experiment.branch_action !== decisionAction(experiment.final_verdict)) {
    throw new Error(`decision report branch_action must be ${decisionAction(experiment.final_verdict)}`);
  }
  if (!SHA_RE.test(experiment.base_commit) || !SHA_RE.test(experiment.challenger_commit)) {
    throw new Error("base_commit and challenger_commit must be full SHAs");
  }
  return experiment.final_verdict;
}

function authorizeAndDelete(
  repoRoot: string,
  mainWorktree: string,
  mainRef: string,
  reportPath: string,
  closedMd: string,
  closed: AbExperiment,
  branchTip: string,
): void {
  const authorization: AbExperiment = {
    ...closed,
    branch_action: decisionAction(closed.final_verdict as "win" | "lose"),
  };
  const authorizationMd = rewriteAbExperiment(closedMd, authorization);
  materializeReport(repoRoot, mainRef, mainWorktree, reportPath, authorizationMd, authorization);
  runAbGate(mainWorktree, reportPath, "decision", true);
  materializeReport(repoRoot, mainRef, mainWorktree, reportPath, closedMd, closed);
  const dirty = git(mainWorktree, ["status", "--porcelain"]);
  if (dirty) throw new Error(`promotion worktree changed while authorizing cleanup: ${dirty}`);
  deletePinnedBranch(repoRoot, closed.branch, branchTip);
  runAbGate(mainWorktree, reportPath, "close", false);
  runHermesGate(mainWorktree, reportPath);
}

function finishArchivedClose(
  repoRoot: string,
  mainAtStart: string,
  reportPath: string,
  md: string,
  experiment: AbExperiment,
): PromotionCloseResult {
  const verdict = experiment.final_verdict;
  if (verdict !== "win" && verdict !== "lose") throw new Error("archived decisive report has invalid verdict");
  if (experiment.branch_action !== expectedCloseAction(verdict)) {
    throw new Error("origin/main report is not a completed decisive archive");
  }
  if (!SHA_RE.test(experiment.closing_branch_tip ?? "")) {
    throw new Error("archived decisive report is missing closing_branch_tip");
  }
  const expectedTip = experiment.closing_branch_tip!;
  const remote = remoteBranchSha(repoRoot, experiment.branch);
  const local = refSha(repoRoot, `refs/heads/${experiment.branch}`);
  withDetachedWorktree(repoRoot, mainAtStart, (mainWorktree) => {
    materializeReport(repoRoot, mainAtStart, mainWorktree, reportPath, md, experiment);
    if (remote !== null || local !== null) {
      assertBranchPinned(repoRoot, experiment.branch, expectedTip);
      authorizeAndDelete(repoRoot, mainWorktree, mainAtStart, reportPath, md, experiment, expectedTip);
    } else {
      runAbGate(mainWorktree, reportPath, "close", false);
      runHermesGate(mainWorktree, reportPath);
    }
    assertMain(repoRoot, mainAtStart);
  });
  return {
    branch: experiment.branch,
    verdict,
    status: expectedCloseAction(verdict) as PromotionCloseResult["status"],
    challenger_commit: experiment.challenger_commit,
    merge_commit: experiment.merge_commit ?? null,
    archive_commit: mainAtStart,
    report_path: reportPath,
  };
}

export function closePromotion(repoRoot: string, reportPathInput: string): PromotionCloseResult {
  const reportPath = safeRepoPath(reportPathInput, "report_path");
  if (!REPORT_RE.test(reportPath)) throw new Error("report_path must be docs/research/reports/*.md");
  git(repoRoot, ["fetch", "origin", "--prune", "--quiet"]);
  const mainAtStart = git(repoRoot, ["rev-parse", "origin/main"]);

  const mainMd = tryFileAtRef(repoRoot, mainAtStart, reportPath);
  if (mainMd) {
    const mainExperiment = parseAbExperiment(mainMd);
    if (mainExperiment.branch_action === "merged_deleted" || mainExperiment.branch_action === "deleted_unmerged") {
      return finishArchivedClose(repoRoot, mainAtStart, reportPath, mainMd, mainExperiment);
    }
  }

  const candidateRefs = git(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/ab/"])
    .split(/\r?\n/)
    .filter(Boolean);
  const matches = candidateRefs.flatMap((ref) => {
    const source = tryFileAtRef(repoRoot, ref, reportPath);
    if (!source) return [];
    try {
      return [{ ref, source, experiment: parseAbExperiment(source) }];
    } catch {
      return [];
    }
  });
  if (matches.length !== 1) {
    throw new Error(`expected exactly one remote ab/* report at ${reportPath}, found ${matches.length}`);
  }
  const { ref: branchRef, source: decisionMd, experiment: decision } = matches[0];
  const verdict = validateIdentity(decision, reportPath);
  if (branchRef !== `origin/${decision.branch}`) throw new Error("report branch does not match its remote ref");
  const branchTip = remoteBranchSha(repoRoot, decision.branch);
  if (!branchTip) throw new Error(`remote challenger ${decision.branch} is missing`);
  assertBranchPinned(repoRoot, decision.branch, branchTip);
  if (!gitSucceeds(repoRoot, ["merge-base", "--is-ancestor", decision.challenger_commit, branchTip])) {
    throw new Error("frozen challenger_commit is not an ancestor of the report branch tip");
  }
  assertOnlyDecisionEvidenceAfterFrozen(repoRoot, reportPath, decision, branchTip);
  if (verdict === "win" && mainAtStart !== decision.base_commit) {
    throw new Error("win promotion refused: origin/main no longer equals the tested base; retain and retest");
  }

  withDetachedWorktree(repoRoot, mainAtStart, (gateWorktree) => {
    materializeReport(repoRoot, branchRef, gateWorktree, reportPath, decisionMd, decision);
    runAbGate(gateWorktree, reportPath, "decision", false);
  });

  return withDetachedWorktree(repoRoot, mainAtStart, (mainWorktree) => {
    let mergeCommit: string | null = null;
    if (verdict === "win") {
      git(mainWorktree, ["merge", "--no-ff", "-m", `promote A/B challenger ${decision.experiment_id}`, decision.challenger_commit]);
      mergeCommit = git(mainWorktree, ["rev-parse", "HEAD"]);
    }
    const closed: AbExperiment = {
      ...decision,
      branch_action: expectedCloseAction(verdict),
      b_stopped: true,
      closing_branch_tip: branchTip,
      ...(mergeCommit ? { merge_commit: mergeCommit } : {}),
    };
    const closedMd = rewriteAbExperiment(decisionMd, closed);
    const archivePaths = materializeReport(repoRoot, branchRef, mainWorktree, reportPath, closedMd, closed);
    git(mainWorktree, ["add", "--", ...archivePaths]);
    if (git(mainWorktree, ["diff", "--cached", "--name-only"])) {
      git(mainWorktree, ["commit", "-m", `archive A/B ${verdict} ${decision.experiment_id}`]);
    }
    const archiveCommit = git(mainWorktree, ["rev-parse", "HEAD"]);
    runHermesGate(mainWorktree, reportPath);
    assertMain(repoRoot, mainAtStart);
    pushPromotionAtomically(mainWorktree, mainAtStart, decision.branch, branchTip);
    assertMain(repoRoot, archiveCommit);

    authorizeAndDelete(repoRoot, mainWorktree, archiveCommit, reportPath, closedMd, closed, branchTip);
    assertMain(repoRoot, archiveCommit);
    const exactMerge = verdict === "win"
      ? exactMergeCommit(repoRoot, archiveCommit, decision.base_commit, decision.challenger_commit)
      : null;
    if (verdict === "win" && exactMerge !== mergeCommit) {
      throw new Error("promoted merge no longer has the exact tested base/challenger parents");
    }
    return {
      branch: decision.branch,
      verdict,
      status: expectedCloseAction(verdict) as PromotionCloseResult["status"],
      challenger_commit: decision.challenger_commit,
      merge_commit: mergeCommit,
      archive_commit: archiveCommit,
      report_path: reportPath,
    };
  });
}
