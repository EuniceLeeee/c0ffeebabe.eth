#!/usr/bin/env node
import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseAbExperiment, validateAbExperiment } from "../ab-canary.js";

const args = process.argv.slice(2);
const report = args.find((arg) => !arg.startsWith("--"));
const phaseIndex = args.indexOf("--phase");
const phase = phaseIndex >= 0 ? args[phaseIndex + 1] : "decision";
if (!report || (phase !== "decision" && phase !== "close")) {
  throw new Error("usage: ab-canary-gate <report.md> --phase decision|close");
}
const md = fs.readFileSync(report, "utf8");
const experiment = parseAbExperiment(md);
const errors = validateAbExperiment(experiment, report, phase);
if (errors.length > 0) {
  for (const error of errors) console.error(`FAIL: ${error}`);
  process.exit(1);
}

function gitOutput(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function isAncestor(commit: string, target: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, target], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function verifyWinningMerge(): void {
  if (!/^[a-f0-9]{40}$/i.test(experiment.merge_commit ?? "")) {
    throw new Error("win cleanup requires merge_commit after the challenger was merged and pushed");
  }
  execFileSync("git", ["fetch", "origin", "main", "--quiet"], { stdio: "inherit" });
  if (!isAncestor(experiment.challenger_commit, "origin/main")
      || !isAncestor(experiment.merge_commit!, "origin/main")) {
    throw new Error("win cleanup refused: challenger and merge commit must both be ancestors of origin/main");
  }
  const parents = gitOutput(["rev-list", "--parents", "-n", "1", experiment.merge_commit!]).split(/\s+/);
  if (parents.length !== 3 || parents[1] !== experiment.base_commit || parents[2] !== experiment.challenger_commit) {
    throw new Error("win cleanup refused: merge must be --no-ff with tested base as parent 1 and challenger as parent 2");
  }
}

function remoteBranchExists(): boolean {
  return gitOutput(["ls-remote", "--heads", "origin", `refs/heads/${experiment.branch}`]).length > 0;
}

function localBranchExists(): boolean {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${experiment.branch}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const marker = path.join("/tmp", `mev-ab-cleanup-${createHash("sha256").update(experiment.branch).digest("hex")}`);
if (args.includes("--authorize-cleanup")) {
  if (phase !== "decision" || experiment.final_verdict === "needs_escalation") {
    throw new Error("cleanup authorization is only valid for a decisive decision-phase win/lose");
  }
  if (experiment.final_verdict === "win") {
    verifyWinningMerge();
  }
  fs.writeFileSync(marker, `${JSON.stringify({ branch: experiment.branch, verdict: experiment.final_verdict, created_at: Date.now() })}\n`, { mode: 0o600 });
}
if (phase === "close") {
  if (experiment.final_verdict === "win") verifyWinningMerge();
  const localExists = localBranchExists();
  const remoteExists = remoteBranchExists();
  if (experiment.final_verdict === "needs_escalation") {
    if (!remoteExists) throw new Error("retained challenger must still exist on origin for stronger-model review");
  } else if (localExists || remoteExists) {
    throw new Error("decisive challenger cleanup incomplete: local and remote ab/* branch must both be absent");
  }
  if (fs.existsSync(marker)) fs.unlinkSync(marker);
}
console.log(`PASS: ${experiment.experiment_id} phase=${phase} verdict=${experiment.final_verdict}`);
