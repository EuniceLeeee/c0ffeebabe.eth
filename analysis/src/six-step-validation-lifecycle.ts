import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  SEMANTIC_SIX_STEP_SCHEMA_VERSION,
  semanticProductionRouteChainError,
  type SemanticJson,
  type SemanticSixStepEvidence,
} from "../../listener/src/shared/evidence/semantic-six-step.js";
import {
  canonicalTrustedSixStepRuntimePayloadSha256,
  validateTrustedSixStepInputSnapshot,
  validateTrustedSixStepRuntimeAttestation,
  type TrustedSixStepInputSnapshot,
  type TrustedSixStepRuntimeAttestation,
} from "./trusted-six-step-runtime-attestation.js";

export const SIX_STEP_VALIDATION_LIFECYCLE_SCHEMA_VERSION = 1 as const;
export const SIX_STEP_VALIDATION_LIFECYCLE_GATE =
  "six-step-validation-lifecycle" as const;
export const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export type SixStepValidationMode = "checkpoint" | "final";
export type SixStepDiffClass = "family_local" | "framework" | "systemic_live";
export interface SixStepStateAnchor {
  lane: "block_scan_standing" | "backrun" | "post_block_scan";
  opportunity_block: number; base_block: number; base_block_hash: string;
  base_state_root: string; applied_prefix_tx_hashes: readonly string[];
  trigger_tx_hash: string | null; target_tx_index: number | null;
  effective_state_hash: string;
}

interface CommonEvidence {
  schema_version: 1; gate: typeof SIX_STEP_VALIDATION_LIFECYCLE_GATE;
  mode: SixStepValidationMode; status: "checkpoint_pass" | "final_validated";
  branch: string; branch_tip: string; candidate_commit: string;
  rollback_commit: string; sample_tx_hash: string; target_route_sha256: string;
  controller: {
    id: "trusted-production-replay-controller";
    controller_sha256: string;
    raw_producer_receipt_sha256: string;
  };
  state_anchor: SixStepStateAnchor; state_anchor_sha256: string;
  frozen_inputs: Record<string, unknown>;
  route_scope: "dex-dex" | "dex-permissionless-protocol";
  diff_class: SixStepDiffClass; impacted_family_ids: readonly string[];
  required_family_ids: readonly string[]; complete_family_ids: readonly string[];
  central_behavior_diff_sha256: string;
  other_family_source_set_baseline_sha256: string;
  other_family_source_set_challenger_sha256: string; exact_production_caps: boolean;
  runner_overrides: Readonly<Record<string, SemanticJson>>;
  production_route_stage: readonly SemanticSixStepEvidence[];
}

export interface SixStepCheckpointEvidence extends CommonEvidence {
  mode: "checkpoint"; status: "checkpoint_pass";
  input_snapshot: TrustedSixStepInputSnapshot;
  checkpoint_evidence_sha256: string;
}

export interface SixStepFinalEvidence extends CommonEvidence {
  mode: "final"; status: "final_validated";
  runtime_attestations: {
    before: TrustedSixStepRuntimeAttestation;
    after: TrustedSixStepRuntimeAttestation;
  };
  merge_commit: string; deployed_commit: string; full_evidence_sha256: string;
  review: {
    reviewer_email: string; review_commit: string; artifact_path: string;
    rollback_commit: string; reviewed_candidate_commit: string;
    reviewed_merge_commit: string; diff_sha256: string; reviewed_at: string;
    evidence: string; verdict: "pass"; artifact_sha256: string;
  };
  checkpoint_receipt_sha256: string; deployment_receipt_sha256: string;
  config_receipt_sha256: string;
}

export type SixStepValidationEvidence =
  | SixStepCheckpointEvidence
  | SixStepFinalEvidence;

export interface GitInspector {
  resolveRef(ref: string): string | null;
  isAncestor(ancestor: string, descendant: string): boolean;
  commitEmails(commit: string): readonly string[];
  commitRangeEmails(base: string, head: string): readonly string[];
  pathLastCommit(ref: string, path: string): string | null;
  changedPaths(base: string, head: string): readonly string[];
  isValidBranchName(branch: string): boolean;
}

export interface BranchCleanupResult {
  branch: string; branch_tip: string; remote_deleted: true; local_deleted: true;
}

const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const HASH32 = /^0x[a-f0-9]{64}$/;

export function validateSixStepValidationLifecycle(
  value: unknown,
  git?: GitInspector,
): string[] {
  if (!record(value)) return ["six-step lifecycle evidence must be an object"];
  const errors: string[] = [];
  require(errors, value.schema_version === 1, "schema_version must be 1");
  require(errors, value.gate === SIX_STEP_VALIDATION_LIFECYCLE_GATE,
    `gate must be ${SIX_STEP_VALIDATION_LIFECYCLE_GATE}`);
  const checkpoint = value.mode === "checkpoint";
  require(errors, checkpoint || value.mode === "final",
    "mode must be checkpoint or final");
  require(errors, value.status === (checkpoint ? "checkpoint_pass" : "final_validated"),
    "status does not match mode");
  validateGit(value, git, errors);
  require(errors, typeof value.sample_tx_hash === "string" &&
    HASH32.test(value.sample_tx_hash), "sample_tx_hash must be a transaction hash");
  require(errors, sha(value.target_route_sha256),
    "target_route_sha256 must be a SHA-256 digest");
  const controller = record(value.controller) ? value.controller : null;
  require(errors, Boolean(controller), "controller must be an object");
  if (controller) {
    require(errors,
      controller.id === "trusted-production-replay-controller" &&
      sha(controller.controller_sha256) &&
      sha(controller.raw_producer_receipt_sha256),
      "controller identity/hashes are invalid");
  }
  validateAnchor(value, errors);
  validateFrozenInputs(value, checkpoint, errors);
  require(errors, value.route_scope === "dex-dex" ||
    value.route_scope === "dex-permissionless-protocol", "route_scope is invalid");
  require(errors, value.diff_class === "family_local",
    value.diff_class === "framework"
      ? "framework changes require an independently frozen cross-family cohort"
      : "systemic/live changes require Hermes");
  validateFamilyIsolation(value, errors);
  require(errors, value.exact_production_caps === true,
    "exact_production_caps must be true");
  validateRunnerOverrides(value.runner_overrides, errors);
  validateStages(value, errors);
  if (checkpoint) validateCheckpoint(value, errors);
  else validateFinal(value, git, errors);
  return errors;
}

function validateGit(
  value: Record<string, unknown>,
  git: GitInspector | undefined,
  errors: string[],
): void {
  for (const field of ["branch_tip", "candidate_commit", "rollback_commit"] as const) {
    require(errors, typeof value[field] === "string" && SHA40.test(value[field]),
      `${field} must be a full git SHA`);
  }
  require(errors, typeof value.branch === "string" &&
    /^codex\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value.branch),
    "branch must be a codex/* branch");
  require(errors, value.branch_tip === value.candidate_commit,
    "branch_tip must exactly equal candidate_commit");
  if (!git || typeof value.branch !== "string") return;
  require(errors, git.isValidBranchName(value.branch), "branch name is invalid");
  require(errors, git.resolveRef(`refs/heads/${value.branch}`) === value.branch_tip,
    "branch ref does not exactly equal branch_tip");
  if (typeof value.rollback_commit === "string" &&
      typeof value.candidate_commit === "string") {
    require(errors, git.isAncestor(value.rollback_commit, value.candidate_commit),
      "rollback_commit is not an ancestor of candidate_commit");
  }
}

function validateAnchor(value: Record<string, unknown>, errors: string[]): void {
  const anchor = record(value.state_anchor) ? value.state_anchor : null;
  require(errors, Boolean(anchor), "state_anchor must be an object");
  if (!anchor) return;
  require(errors, anchor.lane === "block_scan_standing",
    "only block_scan_standing is supported");
  require(errors, Number.isSafeInteger(anchor.opportunity_block) &&
    anchor.base_block === Number(anchor.opportunity_block) - 1,
    "standing state must use canonical N-1");
  require(errors, HASH32.test(String(anchor.base_block_hash ?? "")) &&
    HASH32.test(String(anchor.base_state_root ?? "")),
    "state anchor hashes are invalid");
  require(errors, Array.isArray(anchor.applied_prefix_tx_hashes) &&
    anchor.applied_prefix_tx_hashes.length === 0 &&
    anchor.trigger_tx_hash === null && anchor.target_tx_index === null,
    "standing state cannot contain a backrun prefix");
  require(errors, sha(anchor.effective_state_hash),
    "effective_state_hash must be a SHA-256 digest");
  require(errors, sha(value.state_anchor_sha256) &&
    value.state_anchor_sha256 === sixStepStateAnchorSha256(anchor),
    "state_anchor_sha256 does not bind state_anchor");
}

function validateFrozenInputs(
  value: Record<string, unknown>,
  checkpoint: boolean,
  errors: string[],
): void {
  const frozen = record(value.frozen_inputs) ? value.frozen_inputs : null;
  require(errors, Boolean(frozen), "frozen_inputs must be an object");
  if (!frozen) return;
  for (const field of [
    "universe_sha256", "universe_manifest_sha256", "config_sha256",
    "graph_sha256", "family_manifest_sha256", "graph_builder_sha256",
    "graph_snapshot_source_sha256", "producer_sha256", "comparator_sha256",
  ]) require(errors, sha(frozen[field]), `${field} must be a SHA-256 digest`);
  require(errors, frozen.target_injected === false,
    "target_injected must be false");
  require(errors, frozen.graph_reduced === false, "graph_reduced must be false");
  require(errors, frozen.graph_snapshot_kind === "content_addressed" ||
    frozen.graph_snapshot_kind === "honest_reconstruction",
    "graph_snapshot_kind is invalid");
  if (checkpoint) {
    require(errors, sha(frozen.input_snapshot_sha256),
      "checkpoint must bind input_snapshot_sha256");
  } else {
    require(errors, sha(frozen.runtime_attestation_before_sha256) &&
      sha(frozen.runtime_attestation_after_sha256),
      "final must bind both runtime attestations");
  }
}

function validateFamilyIsolation(
  value: Record<string, unknown>,
  errors: string[],
): void {
  const impacted = familySet(value.impacted_family_ids, "impacted_family_ids", errors);
  const required = familySet(value.required_family_ids, "required_family_ids", errors);
  const complete = familySet(value.complete_family_ids, "complete_family_ids", errors);
  require(errors, [...required].every((id) => complete.has(id)),
    "required families are not complete");
  require(errors, [...impacted].every((id) => complete.has(id)) ||
    value.mode === "checkpoint", "impacted families are not complete");
  require(errors, value.central_behavior_diff_sha256 === EMPTY_SHA256,
    "central_behavior_diff_sha256 must prove no central behavior change");
  require(errors, sha(value.other_family_source_set_baseline_sha256) &&
    value.other_family_source_set_baseline_sha256 ===
      value.other_family_source_set_challenger_sha256,
    "other-family source closures differ");
}

function validateRunnerOverrides(value: unknown, errors: string[]): void {
  require(errors, record(value), "runner_overrides must be an object");
  if (!record(value)) return;
  require(errors, Object.keys(value).every((key) => key === "wall_clock_timeout_ms"),
    "runner_overrides may contain only wall_clock_timeout_ms");
  if (value.wall_clock_timeout_ms !== undefined) {
    require(errors, Number.isSafeInteger(value.wall_clock_timeout_ms) &&
      Number(value.wall_clock_timeout_ms) > 0,
      "wall_clock_timeout_ms must be positive");
  }
}

function validateStages(
  value: Record<string, unknown>,
  errors: string[],
): void {
  const stages = Array.isArray(value.production_route_stage)
    ? value.production_route_stage as SemanticSixStepEvidence[]
    : [];
  const chainError = semanticProductionRouteChainError(stages);
  if (chainError) errors.push(chainError);
  require(errors, stages.length === 6, "production route must contain all six stages");
  require(errors, stages.every((stage) =>
    stage.schema_version === SEMANTIC_SIX_STEP_SCHEMA_VERSION),
  `stage schema_version must be current v${SEMANTIC_SIX_STEP_SCHEMA_VERSION}`);
  require(errors, stages.every((stage) => stage.status === "pass"),
    "every stage status must be pass");
  require(errors, stages[0]?.output.state_anchor_sha256 ===
    value.state_anchor_sha256, "stages must bind state_anchor_sha256");
  require(errors, stages[0]?.output.target_route_sha256 ===
    value.target_route_sha256, "stages must bind target_route_sha256");
  const ev = stages[5]?.output;
  require(errors, ev?.decision === "allow" &&
    /^-?[0-9]+$/.test(String(ev?.net_ev_wei ?? "")) &&
    BigInt(String(ev?.net_ev_wei ?? "0")) > 0n,
    "step 6 requires decision=allow and net_ev_wei>0");
}

function validateCheckpoint(
  value: Record<string, unknown>,
  errors: string[],
): void {
  const snapshotErrors = validateTrustedSixStepInputSnapshot(
    value.input_snapshot,
    String(value.sample_tx_hash ?? ""),
  );
  errors.push(...snapshotErrors);
  const snapshot = record(value.input_snapshot) ? value.input_snapshot : null;
  const frozen = record(value.frozen_inputs) ? value.frozen_inputs : null;
  require(errors, snapshot?.payload_sha256 === frozen?.input_snapshot_sha256,
    "input_snapshot_sha256 does not bind input snapshot");
  require(errors, snapshot?.source_runtime_commit === value.rollback_commit,
    "input snapshot does not bind rollback_commit");
  require(errors, stableJson(snapshot?.state_anchor) === stableJson(value.state_anchor),
    "input_snapshot state anchor does not equal lifecycle state anchor");
  require(errors, !Object.hasOwn(value, "runtime_attestations"),
    "checkpoint must not contain runtime attestations");
  validateDigest(value, "checkpoint_evidence_sha256", errors);
}

function validateFinal(
  value: Record<string, unknown>,
  git: GitInspector | undefined,
  errors: string[],
): void {
  const attestations = record(value.runtime_attestations)
    ? value.runtime_attestations : null;
  const before = attestations?.before as TrustedSixStepRuntimeAttestation | undefined;
  const after = attestations?.after as TrustedSixStepRuntimeAttestation | undefined;
  if (!before || !after) errors.push("final requires before/after runtime attestations");
  else {
    errors.push(...validateTrustedSixStepRuntimeAttestation(before,
      String(value.sample_tx_hash ?? "")));
    errors.push(...validateTrustedSixStepRuntimeAttestation(after,
      String(value.sample_tx_hash ?? "")));
    const stable = (item: TrustedSixStepRuntimeAttestation): unknown => ({
      runtime_commit: item.runtime_commit, process: item.process,
      universe: item.universe, universe_manifest: item.universe_manifest,
      pool_universe_top_n: item.pool_universe_top_n,
      searcher_config: item.searcher_config, sample_receipt: item.sample_receipt,
      parent_block: item.parent_block,
    });
    require(errors, stableJson(stable(before)) === stableJson(stable(after)),
      "runtime changed during final validation");
    require(errors, before.runtime_commit === value.deployed_commit,
      "runtime commit does not equal deployed_commit");
    const frozen = value.frozen_inputs as Record<string, unknown>;
    require(errors,
      frozen.runtime_attestation_before_sha256 ===
        canonicalTrustedSixStepRuntimePayloadSha256(before) &&
      frozen.runtime_attestation_after_sha256 ===
        canonicalTrustedSixStepRuntimePayloadSha256(after),
      "frozen inputs do not bind runtime attestations");
  }
  for (const field of ["merge_commit", "deployed_commit"]) {
    require(errors, typeof value[field] === "string" &&
      SHA40.test(value[field] as string), `${field} is invalid`);
  }
  for (const field of [
    "checkpoint_receipt_sha256", "deployment_receipt_sha256",
    "config_receipt_sha256",
  ]) require(errors, sha(value[field]),
    `${field} must be a lowercase SHA-256 digest`);
  validateReview(value, git, errors);
  validateDigest(value, "full_evidence_sha256", errors);
}

function validateReview(
  value: Record<string, unknown>,
  git: GitInspector | undefined,
  errors: string[],
): void {
  const review = record(value.review) ? value.review : null;
  require(errors, Boolean(review) && review?.verdict === "pass",
    "final requires a passing independent review");
  if (!review) return;
  require(errors, review.rollback_commit === value.rollback_commit &&
    review.reviewed_candidate_commit === value.candidate_commit &&
    review.reviewed_merge_commit === value.merge_commit,
    "review does not bind rollback/candidate/merge");
  require(errors, review.review_commit ===
    git?.resolveRef("refs/remotes/origin/main"),
    "review_commit must equal origin/main");
  require(errors, typeof review.artifact_path === "string" &&
    /^docs\/research\/reports\/[A-Za-z0-9._/-]+\.json$/.test(review.artifact_path) &&
    !review.artifact_path.includes(".."), "review artifact path is invalid");
  if (!git || typeof review.reviewer_email !== "string" ||
      typeof review.review_commit !== "string" ||
      typeof review.artifact_path !== "string") return;
  const reviewer = review.reviewer_email.toLowerCase();
  require(errors, git.commitEmails(review.review_commit).includes(reviewer),
    "reviewer is not attributed to review_commit");
  require(errors, !git.commitRangeEmails(
    String(value.rollback_commit), String(value.candidate_commit),
  ).includes(reviewer), "reviewer must be outside the entire candidate commit range");
  require(errors, git.pathLastCommit(review.review_commit, review.artifact_path) ===
    review.review_commit, "review artifact was not introduced by review_commit");
  require(errors, git.isAncestor(String(value.candidate_commit), String(value.merge_commit)) &&
    git.isAncestor(String(value.merge_commit), review.review_commit),
    "candidate/merge/review ancestry is invalid");
  const changed = git.changedPaths(String(value.merge_commit), review.review_commit);
  require(errors, changed.length > 0 && changed.includes(review.artifact_path) &&
    changed.every((path) =>
      /^docs\/research\/reports\/[A-Za-z0-9._/-]+\.json$/.test(path)),
    "merge..review commit must be report-only");
}

export function sixStepLifecycleEnvelopeSha256(
  value: Readonly<Record<string, unknown>>,
): string {
  const payload = Object.fromEntries(Object.entries(value).filter(
    ([key]) => key !== "full_evidence_sha256" &&
      key !== "checkpoint_evidence_sha256",
  ));
  return sha256(stableJson(payload));
}

export function sixStepStateAnchorSha256(
  value: Readonly<Record<string, unknown>>,
): string {
  return sha256(stableJson(value));
}

export function createGitInspector(cwd: string): GitInspector {
  return {
    resolveRef: (ref) => gitOptional(cwd, ["rev-parse", "--verify", ref]),
    isAncestor: (base, head) =>
      git(cwd, ["merge-base", "--is-ancestor", base, head]).status === 0,
    commitEmails: (commit) => lines(git(cwd, [
      "show", "-s", "--format=%ae%n%ce", commit,
    ]).stdout).map((entry) => entry.toLowerCase()),
    commitRangeEmails: (base, head) => lines(git(cwd, [
      "log", "--format=%ae%n%ce", `${base}..${head}`,
    ]).stdout).map((entry) => entry.toLowerCase()),
    pathLastCommit: (ref, path) =>
      gitOptional(cwd, ["log", "-1", "--format=%H", ref, "--", path]),
    changedPaths: (base, head) =>
      lines(git(cwd, ["diff", "--name-only", `${base}..${head}`]).stdout),
    isValidBranchName: (branch) =>
      git(cwd, ["check-ref-format", "--branch", branch]).status === 0,
  };
}

export function cleanupFinalValidatedBranch(
  evidence: SixStepFinalEvidence,
  cwd: string,
): BranchCleanupResult {
  const inspector = createGitInspector(cwd);
  const errors = validateSixStepValidationLifecycle(evidence, inspector);
  if (errors.length) throw new Error(`final validation failed: ${errors.join("; ")}`);
  const current = gitOptional(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (current === evidence.branch) throw new Error("refusing to delete current branch");
  const ref = `refs/heads/${evidence.branch}`;
  const checkedOut = git(cwd, ["worktree", "list", "--porcelain"]).stdout
    .includes(`branch ${ref}`);
  if (checkedOut) throw new Error("refusing to delete a checked-out branch");
  const remote = git(cwd, ["ls-remote", "--heads", "origin", ref]);
  if (inspector.resolveRef(ref) !== evidence.branch_tip ||
      remote.stdout.trim().split(/\s+/)[0]?.toLowerCase() !== evidence.branch_tip) {
    throw new Error("branch ref no longer equals validated branch_tip");
  }
  const deleted = git(cwd, [
    "push", `--force-with-lease=${ref}:${evidence.branch_tip}`, "origin", `:${ref}`,
  ]);
  if (deleted.status !== 0) throw new Error(deleted.stderr || "remote delete failed");
  const local = git(cwd, ["update-ref", "-d", ref, evidence.branch_tip]);
  if (local.status !== 0) throw new Error(local.stderr || "local delete failed");
  return {
    branch: evidence.branch,
    branch_tip: evidence.branch_tip,
    remote_deleted: true,
    local_deleted: true,
  };
}

function familySet(value: unknown, label: string, errors: string[]): Set<string> {
  if (!Array.isArray(value) || value.length === 0 ||
      value.some((entry) => typeof entry !== "string" ||
        !/^[a-z0-9][a-z0-9._:-]*$/.test(entry)) ||
      new Set(value).size !== value.length) {
    errors.push(`${label} must be a non-empty unique family-id array`);
    return new Set();
  }
  return new Set(value as string[]);
}

function validateDigest(
  value: Record<string, unknown>,
  field: string,
  errors: string[],
): void {
  require(errors, sha(value[field]) &&
    value[field] === sixStepLifecycleEnvelopeSha256(value),
    `${field} does not bind the complete envelope`);
}

function git(
  cwd: string,
  args: readonly string[],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function gitOptional(cwd: string, args: readonly string[]): string | null {
  const result = git(cwd, args);
  return result.status === 0 ? result.stdout.trim().toLowerCase() || null : null;
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
}

function require(errors: string[], condition: unknown, message: string): void {
  if (!condition) errors.push(message);
}

function sha(value: unknown): value is string {
  return typeof value === "string" && SHA64.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
