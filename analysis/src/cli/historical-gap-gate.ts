#!/usr/bin/env node
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";
import {
  semanticSixStepSequenceError,
  type SemanticSixStepEvidence,
} from "../../../listener/src/shared/evidence/semantic-six-step.js";
import { parseAbExperiment } from "../ab-canary.js";
import { familyReplayFailureFingerprint } from "../family-execution-evidence.js";
import { cloneHistoricalGapValidationRoot } from "../historical-gap-git.js";
import {
  HISTORICAL_PRODUCTION_INSTANCE_ID,
  historicalValidationTrack,
  isHistoricalCandidateWorktree,
  normalizeHistoricalReportArtifactPath,
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
  type HistoricalGatePhase,
  type HistoricalProductionUniverseAttestation,
  type HistoricalUniverseProvenance,
  type HistoricalValidationTrack,
} from "../historical-gap.js";

const args = process.argv.slice(2);
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
  env: trustedCommandEnv(),
}).trim();
const gitCommonDir = execFileSync(
  "git",
  ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  { encoding: "utf8", cwd: repoRoot, env: trustedCommandEnv() },
).trim();
const sharedToolchainRoot = path.dirname(gitCommonDir);
const SHA40_RE = /^[a-f0-9]{40}$/i;
const SHA64_RE = /^[a-f0-9]{64}$/i;
const AWS_REGION = "us-east-1";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const remoteInventoryCommits = new Map<string, string>();
const candidateReadOnlyRoots = new Set<string>();
const candidateWritableRoots = new Set<string>();
const candidateSandboxHome = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "historical-gap-candidate-home-")),
);
const candidateRuntimeHome = path.join(candidateSandboxHome, "runtime-home");
fs.mkdirSync(candidateRuntimeHome, { mode: 0o700 });
process.once("exit", () => fs.rmSync(candidateSandboxHome, { recursive: true, force: true }));

interface HistoricalPrepareReceipt {
  schema_version: 1;
  gate: "historical-gap-prepare";
  gap_id: string;
  branch: string;
  origin_main_commit: string;
  refs_sha256: string;
  created_at: string;
  auth_tag: string;
  auth_command_id: string;
}

interface HistoricalPromotionReceipt {
  schema_version: 1;
  gate: "historical-gap-gate";
  gap_id: string;
  branch: string;
  track: HistoricalValidationTrack;
  base_commit: string;
  challenger_commit: string;
  artifact_commit: string;
  artifact_report_path: string;
  artifact_report_sha256: string;
  record_identity_sha256: string;
  diff_sha256: string;
  branch_audit_sha256: string;
  review_artifact: { path: string; sha256: string };
  toolchain_sha256: string;
  lockfiles: { analysis: string; listener: string };
  candidate_artifacts: Array<{
    report_path: string;
    report_sha256: string;
    manifest_path: string;
    manifest_sha256: string;
  }>;
  family_execution_artifacts?: HistoricalFamilyExecutionArtifact[];
  family_conformance?: HistoricalFamilyConformanceAttestation;
  family_replay_environment?: {
    rpc_attestation_before: HistoricalRpcAttestation;
    rpc_attestation_after: HistoricalRpcAttestation;
  };
  replay_environment?: {
    universe_sha256: string;
    provenance_path: string;
    provenance_sha256: string;
    pool_universe_top_n: number;
    production_attestation_before: HistoricalProductionUniverseAttestation;
    production_attestation_after: HistoricalProductionUniverseAttestation;
    rpc_attestation_before: HistoricalRpcAttestation;
    rpc_attestation_after: HistoricalRpcAttestation;
  };
  smoke?: { log_sha256: string; duration_seconds: number; posture_sha256: string };
  created_at: string;
  auth_tag: string;
  auth_command_id: string;
  closed_at?: string;
  merge_commit?: string;
}

interface ValidatedReplayEnvironment {
  universe: string;
  universeSha256: string;
  provenancePath: string;
  provenanceSha256: string;
  poolUniverseTopN: number;
  provenance: HistoricalUniverseProvenance;
  productionAttestationBefore: HistoricalProductionUniverseAttestation;
  productionAttestationAfter?: HistoricalProductionUniverseAttestation;
  rpcAttestationBefore: HistoricalRpcAttestation;
  rpcAttestationAfter?: HistoricalRpcAttestation;
  rpcUrl: string;
  wsUrl: string;
  transport: TrustedReplayTransport;
}

interface ValidatedFamilyReplayEnvironment {
  rpcAttestationBefore: HistoricalRpcAttestation;
  rpcAttestationAfter?: HistoricalRpcAttestation;
  rpcUrl: string;
  wsUrl: string;
  transport: TrustedReplayTransport;
}

interface AdapterFamilyRegistryProbe {
  schemaVersion: 1;
  executionFamilyId: string;
  registered: boolean;
}

interface AdapterFamilyReplayResult {
  schemaVersion: 2;
  fixtureId: string;
  fixturePath: string;
  fixtureSha256: string;
  referenceTx: string;
  landedEvidencePath: string;
  landedEvidenceSha256: string;
  executionFamilyId: string;
  routeExecutionFamilies: string[];
  stateAnchor: Record<string, unknown>;
  anchorBlockHash: string | null;
  anchorStateRoot: string | null;
  anchorReconstruction: Record<string, unknown> | null;
  baseCommit: string | null;
  adapterCommit: string | null;
  familySourceSha256: string;
  sharedApiSha256: string;
  runtimeSourceSha256: string;
  harnessSha256: string;
  botVmArtifactSha256: string;
  replayFlash: Record<string, unknown>;
  routeHash: string;
  referenceRouteHash: string | null;
  stages: Record<string, boolean>;
  sixStepEvidence: SemanticSixStepEvidence[];
  verdict: "adapter_replay_pass" | "implemented_not_validated";
  failureOwnerFamilyId: string | null;
  failure: string | null;
  [key: string]: unknown;
}

interface HistoricalFamilyExecutionSideResult {
  status: "family_not_registered" | "implemented_not_validated" | "adapter_replay_pass";
  probe: AdapterFamilyRegistryProbe;
  replay: AdapterFamilyReplayResult | null;
  output_sha256: string;
  failure_fingerprint_sha256?: string;
  confirmation_replay?: AdapterFamilyReplayResult;
  confirmation_output_sha256?: string;
  confirmation_failure_fingerprint_sha256?: string;
}

interface HistoricalFamilyExecutionArtifact {
  fixture_path: string;
  fixture_sha256: string;
  evidence_path: string;
  evidence_sha256: string;
  reference_tx: string;
  execution_family_id: string;
  baseline: HistoricalFamilyExecutionSideResult;
  challenger: HistoricalFamilyExecutionSideResult;
}

interface HistoricalFamilyConformanceAttestation {
  schema_version: 1;
  checks: Array<{
    script_path: string;
    source_sha256: string;
    output_sha256: string;
  }>;
}

interface MaterializedFamilyExecutionSample {
  fixturePath: string;
  fixtureSha256: string;
  evidencePath: string;
  evidenceSha256: string;
  referenceTx: string;
  executionFamilyId: string;
}

interface HistoricalRpcAttestation {
  schema_version: 1;
  kind: "trusted-reth-sample-identity";
  instance_id: string;
  chain_id: string;
  rpc_port: number;
  ws_port: number;
  samples: Array<{
    tx_hash: string;
    block_hash: string;
    block_number: string;
    transaction_index: string;
    status: string;
    parent_block_hash: string;
  }>;
  observed_at: string;
  command_id: string;
}

interface TrustedReplayTransport {
  rpcUrl: string;
  wsUrl: string;
  close: () => Promise<void>;
}

interface SmokeResult {
  logSha256: string;
  durationSeconds: number;
  postureSha256: string;
}

await main();

async function main(): Promise<void> {
  if (args.includes("--print-ref-inventory")) {
    const branch = requiredArg("--branch");
    const gapId = requiredArg("--gap-id");
    fetchOrigin();
    await assertNoOpenPromotionReceipts();
    assertCandidateBranchAbsent(branch);
    const inventory = refInventory(branch);
    const prepareReceiptSha256 = await writePrepareReceipt(gapId, branch, inventory);
    console.log(JSON.stringify({
      ...inventory,
      prepare_receipt_sha256: prepareReceiptSha256,
    }, null, 2));
    return;
  }

  const reportArg = args[0];
  const phase = option("--phase") as HistoricalGatePhase | undefined;
  if (!reportArg || !phase || !["classify", "promote", "close"].includes(phase)) {
    throw new Error(
      "usage: historical-gap-gate <report.md> --phase classify|promote|close "
        + "--artifact-ref <report-tip> --report-repo-path docs/research/reports/<report>.md [replay args]",
    );
  }
  const reportPath = path.resolve(reportArg);
  const reportMd = fs.readFileSync(reportPath, "utf8");
  const record = parseHistoricalGap(reportMd);
  const errors = validateHistoricalGap(record, phase);
  const track = historicalValidationTrack(record.components);

  fetchOrigin();
  if (phase !== "close") await assertNoOpenPromotionReceipts();
  const artifactCommit = phase === "close" ? null : resolveArtifactCommit(requiredArg("--artifact-ref"));
  const reportRepoPath = reportRepositoryPath(reportPath);
  if (artifactCommit) validateReportArtifact(reportMd, reportRepoPath, artifactCommit, errors);
  if (phase === "promote" && artifactCommit) validateReviewArtifact(record, artifactCommit, errors);
  validateGitIdentity(record, phase, artifactCommit, errors);
  if (phase !== "close" && track !== "direct-main") {
    await validatePrepareReceipt(record, errors);
    validateBranchAudit(record, errors);
  }
  validateDiffScope(record, track, phase, errors);
  const trustedToolchainInputs = track === "direct-main"
    ? ["analysis/node_modules", "listener/node_modules"]
    : ["analysis/node_modules", "listener/node_modules", "out/BotVM.sol/BotVM.json"];
  if (phase === "close") assertTrustedGateRoot([]);
  const trustedToolchainDigest = phase !== "close"
    ? assertTrustedGateRoot(trustedToolchainInputs)
    : null;
  if (phase === "promote" && trustedToolchainDigest !== record.validation.toolchain_sha256) {
    errors.push("current trusted toolchain SHA-256 differs from the independently reviewed toolchain");
  }

  let pendingPromotionReceipt: HistoricalPromotionReceipt | null = null;
  if (phase === "promote" && errors.length === 0) {
    const suppliedValidationRoot = fs.realpathSync(requiredArg("--challenger-root"));
    const suppliedBaselineRoot = fs.realpathSync(requiredArg("--base-root"));
    const validationInputs = track === "direct-main"
      ? ["analysis/node_modules", "listener/node_modules"]
      : ["analysis/node_modules", "listener/node_modules", "out/BotVM.sol/BotVM.json"];
    assertFrozenWorktree(
      suppliedValidationRoot,
      record.challenger_commit,
      "supplied validation worktree",
      validationInputs,
    );
    const baselineInputs = track === "direct-main"
      ? ["listener/node_modules"]
      : ["listener/node_modules", "out/BotVM.sol/BotVM.json"];
    assertFrozenWorktree(suppliedBaselineRoot, record.base_commit, "supplied baseline worktree", baselineInputs);
    const validationInputsDigest = inputSetDigest(suppliedValidationRoot, validationInputs);
    const baselineInputsDigest = inputSetDigest(suppliedBaselineRoot, baselineInputs);
    const repositoryGateWorktrees = createCandidateValidationWorktrees(
      record,
      artifactCommit!,
      validationInputs,
      baselineInputs,
      true,
    );
    let familyConformance: HistoricalFamilyConformanceAttestation | undefined;
    try {
      const validationRoot = repositoryGateWorktrees.challengerRoot;
      const baselineRoot = repositoryGateWorktrees.baselineRoot;
      assertFrozenWorktree(validationRoot, record.challenger_commit, "sandboxed validation worktree", validationInputs);
      assertFrozenWorktree(baselineRoot, record.base_commit, "sandboxed baseline worktree", baselineInputs);
      familyConformance = runRepositoryGates(validationRoot, baselineRoot, track);
      assertFrozenWorktree(validationRoot, record.challenger_commit, "post-test validation worktree", validationInputs);
      assertFrozenWorktree(baselineRoot, record.base_commit, "post-test baseline worktree", baselineInputs);
    } finally {
      removeCandidateValidationWorktrees(repositoryGateWorktrees);
    }
    resetCandidateRuntimeHome();
    const replayWorktrees = createCandidateValidationWorktrees(
      record,
      artifactCommit!,
      validationInputs,
      baselineInputs,
      false,
    );
    try {
      const validationRoot = replayWorktrees.challengerRoot;
      const baselineRoot = replayWorktrees.baselineRoot;
      assertFrozenWorktree(validationRoot, record.challenger_commit, "read-only replay worktree", validationInputs);
      assertFrozenWorktree(baselineRoot, record.base_commit, "read-only replay baseline", baselineInputs);
      let candidateArtifacts: HistoricalPromotionReceipt["candidate_artifacts"] = [];
      let familyExecutionArtifacts: HistoricalFamilyExecutionArtifact[] = [];
      let replayEnvironment: ValidatedReplayEnvironment | undefined;
      let familyReplayEnvironment: ValidatedFamilyReplayEnvironment | undefined;
      let smoke: SmokeResult | undefined;
      if (track === "historical-replay") {
        replayEnvironment = await validateReplayEnvironment(record, artifactCommit!);
        try {
          candidateArtifacts = runCandidateReplays(
            record,
            artifactCommit!,
            replayEnvironment,
            baselineRoot,
            validationRoot,
          );
          smoke = await runTrustedSmoke(record, validationRoot, replayEnvironment);
          if (sha256(fs.readFileSync(replayEnvironment.universe)) !== replayEnvironment.universeSha256) {
            throw new Error("production universe snapshot changed while replay/smoke was running");
          }
          await assertProductionUniverseStillMatches(record, replayEnvironment);
          await assertTrustedRpcStillMatches(record, replayEnvironment);
        } finally {
          await replayEnvironment.transport.close();
        }
      } else if (track === "family-execution") {
        familyReplayEnvironment = await validateFamilyReplayEnvironment(record);
        try {
          familyExecutionArtifacts = runFamilyExecutionReplays(
            record,
            artifactCommit!,
            familyReplayEnvironment,
            baselineRoot,
            validationRoot,
          );
          await assertTrustedRpcStillMatches(record, familyReplayEnvironment);
        } finally {
          await familyReplayEnvironment.transport.close();
        }
      }
      assertFrozenWorktree(validationRoot, record.challenger_commit, "post-gate validation worktree", validationInputs);
      assertFrozenWorktree(baselineRoot, record.base_commit, "post-gate baseline worktree", baselineInputs);
      if (validationInputsDigest !== inputSetDigest(suppliedValidationRoot, validationInputs)
          || baselineInputsDigest !== inputSetDigest(suppliedBaselineRoot, baselineInputs)) {
        throw new Error("base/challenger external inputs changed while repository gates were running");
      }
      if (track !== "hermes-ab") {
        pendingPromotionReceipt = buildPromotionReceipt({
          record,
          track: track!,
          artifactCommit: artifactCommit!,
          reportRepoPath,
          reportMd,
          trustedToolchainDigest: trustedToolchainDigest!,
          validationRoot,
          candidateArtifacts,
          familyExecutionArtifacts,
          familyConformance,
          replayEnvironment,
          familyReplayEnvironment,
          smoke,
        });
      }
    } finally {
      removeCandidateValidationWorktrees(replayWorktrees);
    }
  }
  let closeReceipt: HistoricalPromotionReceipt | null = null;
  if (phase === "close" && errors.length === 0) {
    closeReceipt = await readPromotionReceipt(record, errors);
    if (closeReceipt) validateClose(record, reportPath, reportMd, closeReceipt, errors);
  }
  if (trustedToolchainDigest
      && trustedToolchainDigest !== externalToolchainDigest(sharedToolchainRoot, trustedToolchainInputs)) {
    errors.push("trusted external toolchain changed while the gate was running");
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`FAIL: ${error}`);
    process.exitCode = 1;
    return;
  }
  if (pendingPromotionReceipt) {
    const receiptDigest = await writePromotionReceipt(pendingPromotionReceipt);
    console.log(`historical_gap_promotion_receipt_sha256=${receiptDigest} path=${promotionReceiptPath(record)}`);
  }
  if (phase === "close" && closeReceipt) await markPromotionReceiptClosed(record, closeReceipt);
  console.log(`historical_gap_branch_audit_sha256=${branchAuditSha256(record)}`);
  console.log(`historical_gap_gate=PASS phase=${phase} track=${track} gap_id=${record.gap_id}`);
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredArg(name: string): string {
  const value = option(name);
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function git(gitArgs: string[], cwd = repoRoot): string {
  return execFileSync("git", ["-C", cwd, ...gitArgs], {
    encoding: "utf8",
    env: trustedCommandEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitSucceeds(gitArgs: string[]): boolean {
  try {
    execFileSync("git", ["-C", repoRoot, ...gitArgs], { env: trustedCommandEnv(), stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function fetchOrigin(): void {
  execFileSync("git", [
    "-C", repoRoot, "fetch", "--prune", "origin",
    "+refs/heads/*:refs/remotes/origin/*",
  ], {
    env: trustedCommandEnv(),
    stdio: "inherit",
  });
}

function originBranchCommit(branch: string): string {
  const output = git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
  const matches = output.split(/\r?\n/).filter(Boolean);
  if (matches.length === 0) return "";
  if (matches.length !== 1) throw new Error(`origin branch lookup is ambiguous for ${branch}`);
  const [commit, ref] = matches[0].split(/\s+/);
  if (ref !== `refs/heads/${branch}` || !SHA40_RE.test(commit)) {
    throw new Error(`origin branch lookup returned malformed identity for ${branch}`);
  }
  return commit;
}

function resolveArtifactCommit(ref: string): string {
  const commit = safeGit(["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!SHA40_RE.test(commit)) throw new Error(`--artifact-ref is not an available commit: ${ref}`);
  return commit;
}

function reportRepositoryPath(reportPath: string): string {
  const explicit = option("--report-repo-path");
  if (explicit) return safeRelative(explicit, "--report-repo-path");
  const relative = path.relative(repoRoot, reportPath).split(path.sep).join("/");
  if (relative === ".." || relative.startsWith("../")) {
    throw new Error("report is outside the trusted repository; --report-repo-path is required");
  }
  return safeRelative(relative, "report path");
}

function validateReportArtifact(
  reportMd: string,
  reportRepoPath: string,
  artifactCommit: string,
  validationErrors: string[],
): void {
  if (!normalizeHistoricalReportArtifactPath(reportRepoPath, [".md"])) {
    validationErrors.push("historical report must be a docs/research/reports/*.md artifact");
    return;
  }
  const committed = safeGit(["show", `${artifactCommit}:${reportRepoPath}`], false);
  if (!committed || committed !== reportMd) {
    validationErrors.push("local historical report does not exactly match --artifact-ref");
  }
}

function validateReviewArtifact(
  record: HistoricalGapRecord,
  artifactCommit: string,
  validationErrors: string[],
): void {
  const review = record.validation?.review;
  if (!review?.artifact) return;
  const artifactPath = normalizeHistoricalReportArtifactPath(review.artifact, [".json"]);
  if (!artifactPath) {
    validationErrors.push("fresh review artifact must remain under docs/research/reports");
    return;
  }
  const source = safeGit(["show", `${artifactCommit}:${artifactPath}`], false);
  if (!source || sha256(source) !== review.artifact_sha256) {
    validationErrors.push("fresh review artifact is absent from --artifact-ref or its SHA-256 differs");
    return;
  }
  try {
    const parsed = JSON.parse(source) as Record<string, unknown>;
    if (parsed.schema_version !== 1
        || parsed.reviewer !== review.reviewer
        || parsed.reviewed_at !== review.reviewed_at
        || parsed.base_commit !== record.base_commit
        || parsed.challenger_commit !== record.challenger_commit
        || parsed.diff_sha256 !== review.diff_sha256
        || parsed.toolchain_sha256 !== record.validation.toolchain_sha256
        || parsed.verdict !== review.verdict
        || parsed.live_distribution_verdict !== (review.live_distribution_verdict ?? null)
        || parsed.branch_audit_sha256 !== branchAuditSha256(record)
        || parsed.evidence !== review.evidence
        || typeof parsed.evidence !== "string"
        || parsed.evidence.trim().length === 0) {
      validationErrors.push("fresh review artifact identity does not match the exact report/diff/branch audit");
    }
  } catch {
    validationErrors.push("fresh review artifact must be valid structured JSON");
  }
}

async function validateReplayEnvironment(
  record: HistoricalGapRecord,
  artifactCommit: string,
): Promise<ValidatedReplayEnvironment> {
  if (args.includes("--rpc") || args.includes("--ws")) {
    throw new Error("historical replay does not accept caller-supplied RPC/WS; the gate owns SSM tunnels");
  }
  const declared = record.validation.replay_environment;
  if (!declared) throw new Error("historical replay environment is missing");
  const suppliedUniverse = fs.realpathSync(requiredArg("--universe"));
  const universeBytes = fs.readFileSync(suppliedUniverse);
  const universeSha256 = sha256(universeBytes);
  const provenancePath = normalizeHistoricalReportArtifactPath(
    declared.universe_provenance_artifact,
    [".json"],
  );
  if (!provenancePath) throw new Error("universe provenance artifact must remain under docs/research/reports");
  const provenance = safeGit(["show", `${artifactCommit}:${provenancePath}`], false);
  const provenanceSha256 = sha256(provenance);
  if (!provenance || provenanceSha256 !== declared.universe_provenance_sha256) {
    throw new Error("production universe provenance artifact is absent or its SHA-256 differs");
  }
  let parsed: HistoricalUniverseProvenance;
  try {
    parsed = JSON.parse(provenance) as HistoricalUniverseProvenance;
  } catch {
    throw new Error("production universe provenance artifact is malformed");
  }
  const productionAttestationBefore = await fetchProductionUniverseAttestation();
  const rpcAttestationBefore = await fetchTrustedRpcAttestation(record);
  const transport = await openTrustedReplayTransport(rpcAttestationBefore);
  try {
    await assertLocalRpcMatchesAttestation(record, transport.rpcUrl, rpcAttestationBefore);
    await assertLocalWsMatchesAttestation(record, transport.wsUrl, rpcAttestationBefore);
  } catch (error) {
    await transport.close();
    throw error;
  }
  const bindingErrors = validateHistoricalUniverseBinding(
    record.base_commit,
    declared,
    parsed,
    productionAttestationBefore,
    universeSha256,
  );
  if (bindingErrors.length > 0) throw new Error(bindingErrors.join("; "));
  const universe = path.join(candidateSandboxHome, `production-universe-${universeSha256}.json`);
  if (!fs.existsSync(universe)) fs.writeFileSync(universe, universeBytes, { mode: 0o600, flag: "wx" });
  if (sha256(fs.readFileSync(universe)) !== universeSha256) {
    throw new Error("gate-owned production universe copy differs from the attested input");
  }
  return {
    universe,
    universeSha256,
    provenancePath,
    provenanceSha256,
    poolUniverseTopN: productionAttestationBefore.pool_universe_top_n,
    provenance: parsed,
    productionAttestationBefore,
    rpcAttestationBefore,
    rpcUrl: transport.rpcUrl,
    wsUrl: transport.wsUrl,
    transport,
  };
}

async function validateFamilyReplayEnvironment(
  record: HistoricalGapRecord,
): Promise<ValidatedFamilyReplayEnvironment> {
  if (args.includes("--rpc") || args.includes("--ws")) {
    throw new Error("family execution replay does not accept caller-supplied RPC/WS; the gate owns SSM tunnels");
  }
  const rpcAttestationBefore = await fetchTrustedRpcAttestation(record);
  const transport = await openTrustedReplayTransport(rpcAttestationBefore);
  try {
    await assertLocalRpcMatchesAttestation(record, transport.rpcUrl, rpcAttestationBefore);
    await assertLocalWsMatchesAttestation(record, transport.wsUrl, rpcAttestationBefore);
  } catch (error) {
    await transport.close();
    throw error;
  }
  return {
    rpcAttestationBefore,
    rpcUrl: transport.rpcUrl,
    wsUrl: transport.wsUrl,
    transport,
  };
}

async function assertProductionUniverseStillMatches(
  record: HistoricalGapRecord,
  environment: ValidatedReplayEnvironment,
): Promise<void> {
  const after = await fetchProductionUniverseAttestation();
  const bindingErrors = validateHistoricalUniverseBinding(
    record.base_commit,
    record.validation.replay_environment!,
    environment.provenance,
    after,
    environment.universeSha256,
  );
  const before = environment.productionAttestationBefore;
  if (after.runtime_commit !== before.runtime_commit
      || after.universe_path !== before.universe_path
      || after.universe_sha256 !== before.universe_sha256
      || after.pool_universe_top_n !== before.pool_universe_top_n) {
    bindingErrors.push("production champion universe/runtime changed during replay or smoke");
  }
  if (bindingErrors.length > 0) throw new Error(bindingErrors.join("; "));
  environment.productionAttestationAfter = after;
}

async function assertTrustedRpcStillMatches(
  record: HistoricalGapRecord,
  environment: ValidatedReplayEnvironment | ValidatedFamilyReplayEnvironment,
): Promise<void> {
  const after = await fetchTrustedRpcAttestation(record);
  await assertLocalRpcMatchesAttestation(record, environment.rpcUrl, after);
  await assertLocalWsMatchesAttestation(record, environment.wsUrl, after);
  if (rpcAttestationIdentity(after) !== rpcAttestationIdentity(environment.rpcAttestationBefore)) {
    throw new Error("trusted reth sample identities changed during replay or smoke");
  }
  environment.rpcAttestationAfter = after;
}

function rpcAttestationIdentity(attestation: HistoricalRpcAttestation): string {
  return JSON.stringify({
    chain_id: attestation.chain_id,
    rpc_port: attestation.rpc_port,
    ws_port: attestation.ws_port,
    samples: attestation.samples,
  });
}

async function openTrustedReplayTransport(
  attestation: HistoricalRpcAttestation,
): Promise<TrustedReplayTransport> {
  const rpcLocalPort = await availableLoopbackPort();
  let wsLocalPort = await availableLoopbackPort();
  while (wsLocalPort === rpcLocalPort) wsLocalPort = await availableLoopbackPort();
  const processes = [
    startSsmPortForward(attestation.rpc_port, rpcLocalPort, "RPC"),
    startSsmPortForward(attestation.ws_port, wsLocalPort, "WebSocket"),
  ];
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.all(processes.map(stopTunnelProcess));
  };
  try {
    await Promise.all([
      waitForTunnelPort(processes[0], rpcLocalPort, "RPC"),
      waitForTunnelPort(processes[1], wsLocalPort, "WebSocket"),
    ]);
    return {
      rpcUrl: `http://127.0.0.1:${rpcLocalPort}`,
      wsUrl: `ws://127.0.0.1:${wsLocalPort}`,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function startSsmPortForward(remotePort: number, localPort: number, label: string): ChildProcess {
  if (!Number.isSafeInteger(remotePort) || remotePort <= 0 || remotePort > 65_535) {
    throw new Error(`trusted ${label} port is invalid`);
  }
  const child = spawn("aws", [
    "ssm", "start-session",
    "--region", AWS_REGION,
    "--target", HISTORICAL_PRODUCTION_INSTANCE_ID,
    "--document-name", "AWS-StartPortForwardingSession",
    "--parameters", JSON.stringify({
      portNumber: [String(remotePort)],
      localPortNumber: [String(localPort)],
    }),
  ], {
    cwd: repoRoot,
    env: trustedCommandEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk: Buffer | string): void => {
    output = `${output}${chunk.toString()}`.slice(-4_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.once("error", (error) => append(error.message));
  Object.assign(child, { historicalTunnelOutput: () => output });
  return child;
}

async function availableLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate a loopback tunnel port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForTunnelPort(child: ChildProcess, port: number, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const output = (child as ChildProcess & { historicalTunnelOutput?: () => string })
      .historicalTunnelOutput?.() ?? "";
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`trusted ${label} SSM tunnel exited before readiness: ${output}`);
    }
    if (trustedSsmTunnelReady(output, port) && await canConnectLoopback(port)) return;
    await sleep(250);
  }
  const output = (child as ChildProcess & { historicalTunnelOutput?: () => string })
    .historicalTunnelOutput?.() ?? "";
  throw new Error(`trusted ${label} SSM tunnel did not prove ownership within 30 seconds: ${output}`);
}

async function canConnectLoopback(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function stopTunnelProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const graceful = await Promise.race([
    exited.then(() => true),
    sleep(5_000).then(() => false),
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, sleep(2_000)]);
  }
}

async function assertLocalRpcMatchesAttestation(
  record: HistoricalGapRecord,
  rpcUrl: string,
  attestation: HistoricalRpcAttestation,
): Promise<void> {
  if (attestation.schema_version !== 1
      || attestation.kind !== "trusted-reth-sample-identity"
      || attestation.instance_id !== HISTORICAL_PRODUCTION_INSTANCE_ID
      || !validIsoDate(attestation.observed_at)
      || !/^[0-9a-f-]{36}$/i.test(attestation.command_id)) {
    throw new Error("trusted reth sample attestation is malformed");
  }
  const expectedHashes = sampleHashes(record);
  if (attestation.samples.map((sample) => sample.tx_hash).join(",") !== expectedHashes.join(",")) {
    throw new Error("trusted reth sample attestation does not cover the exact winner/trigger set");
  }
  const chainId = await jsonRpc<string>(rpcUrl, "eth_chainId", []);
  if (chainId.toLowerCase() !== attestation.chain_id.toLowerCase()) {
    throw new Error("local replay RPC chainId differs from trusted reth");
  }
  for (const expected of attestation.samples) {
    const receipt = await jsonRpc<Record<string, string> | null>(rpcUrl, "eth_getTransactionReceipt", [expected.tx_hash]);
    if (!receipt) throw new Error(`local replay RPC is missing trusted sample ${expected.tx_hash}`);
    const parentNumber = `0x${(BigInt(expected.block_number) - 1n).toString(16)}`;
    const parent = await jsonRpc<Record<string, string> | null>(rpcUrl, "eth_getBlockByNumber", [parentNumber, false]);
    const actual = {
      tx_hash: String(receipt.transactionHash ?? "").toLowerCase(),
      block_hash: String(receipt.blockHash ?? "").toLowerCase(),
      block_number: String(receipt.blockNumber ?? "").toLowerCase(),
      transaction_index: String(receipt.transactionIndex ?? "").toLowerCase(),
      status: String(receipt.status ?? "").toLowerCase(),
      parent_block_hash: String(parent?.hash ?? "").toLowerCase(),
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`local replay RPC identity differs from trusted reth for ${expected.tx_hash}`);
    }
  }
}

async function assertLocalWsMatchesAttestation(
  record: HistoricalGapRecord,
  wsUrl: string,
  attestation: HistoricalRpcAttestation,
): Promise<void> {
  const provider = new ethers.WebSocketProvider(wsUrl);
  try {
    const chainId = await provider.send("eth_chainId", []) as string;
    if (chainId.toLowerCase() !== attestation.chain_id.toLowerCase()) {
      throw new Error("local replay WebSocket chainId differs from trusted reth");
    }
    const parentByBlock = new Map(attestation.samples.map((sample) => [
      `0x${(BigInt(sample.block_number) - 1n).toString(16)}`,
      sample.parent_block_hash,
    ]));
    for (const [blockNumber, expectedHash] of parentByBlock) {
      const block = await provider.send("eth_getBlockByNumber", [blockNumber, false]) as { hash?: string } | null;
      if (String(block?.hash ?? "").toLowerCase() !== expectedHash) {
        throw new Error(`local replay WebSocket parent block differs from trusted reth at ${blockNumber}`);
      }
    }
    if (parentByBlock.size === 0 || sampleHashes(record).length === 0) {
      throw new Error("local replay WebSocket attestation has no pinned sample blocks");
    }
  } finally {
    await provider.destroy();
  }
}

async function jsonRpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`local replay RPC returned HTTP ${response.status} for ${method}`);
  const payload = await response.json() as { result?: T; error?: { message?: string } };
  if (payload.error || payload.result === undefined) {
    throw new Error(`local replay RPC ${method} failed: ${payload.error?.message ?? "missing result"}`);
  }
  return payload.result;
}

function sampleHashes(record: HistoricalGapRecord): string[] {
  const hashes: string[] = [];
  for (const sample of record.samples) {
    hashes.push(sample.tx_hash.toLowerCase());
    if (sample.victim_tx_hash) hashes.push(sample.victim_tx_hash.toLowerCase());
  }
  return [...new Set(hashes)];
}

async function fetchTrustedRpcAttestation(record: HistoricalGapRecord): Promise<HistoricalRpcAttestation> {
  const hashesJson = JSON.stringify(sampleHashes(record));
  const script = String.raw`set -eu
pid_before=$(systemctl show -p MainPID --value mev-searcher)
test -n "$pid_before" && test "$pid_before" != 0
test "$(systemctl is-active mev-searcher)" = active
payload=$(python3 - "$pid_before" <<'PY'
import datetime, json, os, sys, urllib.parse, urllib.request
pid = sys.argv[1]
raw = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
env = {}
for item in raw:
    if b"=" in item:
        key, value = item.split(b"=", 1)
        env[key.decode()] = value.decode()
url = env.get("SEARCHER_LIVE_RPC_URL") or env.get("MAINNET_RPC_URL")
ws_url = env.get("SEARCHER_LIVE_WS_URL") or env.get("MAINNET_WS_URL")
parsed = urllib.parse.urlparse(url or "")
ws_parsed = urllib.parse.urlparse(ws_url or "")
if parsed.scheme != "http" or parsed.hostname not in ("localhost", "127.0.0.1", "::1") or not parsed.port:
    raise SystemExit("production searcher RPC is not local reth")
if ws_parsed.scheme != "ws" or ws_parsed.hostname not in ("localhost", "127.0.0.1", "::1") or not ws_parsed.port:
    raise SystemExit("production searcher WebSocket is not local reth")
counter = 0
def rpc(method, params):
    global counter
    counter += 1
    body = json.dumps({"jsonrpc":"2.0","id":counter,"method":method,"params":params}).encode()
    req = urllib.request.Request(url, data=body, headers={"content-type":"application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        payload = json.load(response)
    if payload.get("error") or "result" not in payload:
        raise SystemExit(f"RPC {method} failed: {payload.get('error')}")
    return payload["result"]
samples = []
for tx_hash in ${hashesJson}:
    receipt = rpc("eth_getTransactionReceipt", [tx_hash])
    if not receipt:
        raise SystemExit(f"missing receipt {tx_hash}")
    parent_number = hex(int(receipt["blockNumber"], 16) - 1)
    parent = rpc("eth_getBlockByNumber", [parent_number, False])
    samples.append({
        "tx_hash": receipt["transactionHash"].lower(),
        "block_hash": receipt["blockHash"].lower(),
        "block_number": receipt["blockNumber"].lower(),
        "transaction_index": receipt["transactionIndex"].lower(),
        "status": receipt["status"].lower(),
        "parent_block_hash": parent["hash"].lower(),
    })
print(json.dumps({
    "schema_version": 1,
    "kind": "trusted-reth-sample-identity",
    "instance_id": "${HISTORICAL_PRODUCTION_INSTANCE_ID}",
    "chain_id": rpc("eth_chainId", []).lower(),
    "rpc_port": parsed.port,
    "ws_port": ws_parsed.port,
    "samples": samples,
    "observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
}, separators=(",", ":")))
PY
)
pid_after=$(systemctl show -p MainPID --value mev-searcher)
test "$pid_before" = "$pid_after"
printf '%s\n' "$payload"`;
  const commandId = sendSsmScript(script);
  const parsed = await readSsmJson<Omit<HistoricalRpcAttestation, "command_id">>(commandId, "trusted reth sample");
  return { ...parsed, command_id: commandId };
}

function sendSsmScript(script: string): string {
  const commandId = execFileSync("aws", [
    "ssm", "send-command",
    "--region", AWS_REGION,
    "--instance-ids", HISTORICAL_PRODUCTION_INSTANCE_ID,
    "--document-name", "AWS-RunShellScript",
    "--parameters", JSON.stringify({ commands: [script] }),
    "--query", "Command.CommandId",
    "--output", "text",
  ], {
    encoding: "utf8",
    env: trustedCommandEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
  if (!/^[0-9a-f-]{36}$/i.test(commandId)) throw new Error("AWS SSM did not return a command id");
  return commandId;
}

async function readSsmJson<T>(commandId: string, label: string): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt++) {
    let invocation: Record<string, unknown>;
    try {
      invocation = JSON.parse(execFileSync("aws", [
        "ssm", "get-command-invocation",
        "--region", AWS_REGION,
        "--command-id", commandId,
        "--instance-id", HISTORICAL_PRODUCTION_INSTANCE_ID,
        "--output", "json",
      ], {
        encoding: "utf8",
        env: trustedCommandEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      })) as Record<string, unknown>;
    } catch {
      await sleep(2_000);
      continue;
    }
    const status = String(invocation.Status ?? "");
    if (["Pending", "InProgress", "Delayed"].includes(status)) {
      await sleep(2_000);
      continue;
    }
    if (status !== "Success") {
      throw new Error(`${label} SSM attestation failed status=${status}: `
        + String(invocation.StandardErrorContent ?? "").slice(-2000));
    }
    try {
      return JSON.parse(String(invocation.StandardOutputContent ?? "").trim()) as T;
    } catch {
      throw new Error(`${label} SSM attestation returned malformed JSON`);
    }
  }
  throw new Error(`${label} SSM attestation timed out`);
}

async function requestTrustedReceiptAuth(payload: string): Promise<{ authTag: string; commandId: string }> {
  const encoded = Buffer.from(payload, "utf8").toString("base64");
  const script = String.raw`set -eu
key_file=/root/.mev-historical-gap-hmac-v1
lock_file=/root/.mev-historical-gap-hmac-v1.lock
(
  flock -x 9
  umask 077
  if [ ! -f "$key_file" ]; then
    tmp="$key_file.$$"
    python3 - <<'PY' > "$tmp"
import secrets
print(secrets.token_hex(32))
PY
    chmod 600 "$tmp"
    mv -n "$tmp" "$key_file" 2>/dev/null || rm -f "$tmp"
  fi
) 9>"$lock_file"
test "$(stat -c '%U:%a' "$key_file")" = "root:600"
python3 - "$key_file" "${encoded}" <<'PY'
import base64, hashlib, hmac, json, pathlib, re, sys
key_text = pathlib.Path(sys.argv[1]).read_text().strip()
if not re.fullmatch(r"[0-9a-f]{64}", key_text):
    raise SystemExit("invalid receipt authentication key")
payload = base64.b64decode(sys.argv[2], validate=True)
tag = hmac.new(bytes.fromhex(key_text), payload, hashlib.sha256).hexdigest()
print(json.dumps({"schema_version":1,"kind":"historical-gap-root-hmac","auth_tag":tag}, separators=(",", ":")))
PY`;
  const commandId = sendSsmScript(script);
  const result = await readSsmJson<{ schema_version: number; kind: string; auth_tag: string }>(
    commandId,
    "historical gap receipt authentication",
  );
  if (result.schema_version !== 1 || result.kind !== "historical-gap-root-hmac" || !SHA64_RE.test(result.auth_tag)) {
    throw new Error("trusted receipt authentication returned malformed evidence");
  }
  return { authTag: result.auth_tag, commandId };
}

async function verifyTrustedReceiptAuth(authTag: string, payload: string): Promise<boolean> {
  if (!SHA64_RE.test(authTag ?? "")) return false;
  const expected = Buffer.from((await requestTrustedReceiptAuth(payload)).authTag, "hex");
  const actual = Buffer.from(authTag, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function fetchProductionUniverseAttestation(): Promise<HistoricalProductionUniverseAttestation> {
  const script = String.raw`set -eu
pid_before=$(systemctl show -p MainPID --value mev-searcher)
test -n "$pid_before" && test "$pid_before" != 0
test "$(systemctl is-active mev-searcher)" = active
payload=$(python3 - "$pid_before" <<'PY'
import datetime, hashlib, json, os, sys
pid = sys.argv[1]
raw = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
env = {}
for item in raw:
    if b"=" not in item:
        continue
    key, value = item.split(b"=", 1)
    env[key.decode()] = value.decode()
required = ["SEARCHER_RUNTIME_COMMIT", "SEARCHER_POOL_UNIVERSE_PATH", "SEARCHER_POOL_UNIVERSE_TOP_N"]
for key in required:
    if not env.get(key):
        raise SystemExit(f"missing {key}")
universe = env["SEARCHER_POOL_UNIVERSE_PATH"]
digest = hashlib.sha256()
with open(universe, "rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
print(json.dumps({
    "schema_version": 1,
    "kind": "production-pool-universe",
    "instance_id": "${HISTORICAL_PRODUCTION_INSTANCE_ID}",
    "runtime_commit": env["SEARCHER_RUNTIME_COMMIT"],
    "universe_path": universe,
    "universe_sha256": digest.hexdigest(),
    "pool_universe_top_n": int(env["SEARCHER_POOL_UNIVERSE_TOP_N"]),
    "observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
}, separators=(",", ":")))
PY
)
pid_after=$(systemctl show -p MainPID --value mev-searcher)
test "$pid_before" = "$pid_after"
printf '%s\n' "$payload"`;
  const commandId = execFileSync("aws", [
    "ssm", "send-command",
    "--region", AWS_REGION,
    "--instance-ids", HISTORICAL_PRODUCTION_INSTANCE_ID,
    "--document-name", "AWS-RunShellScript",
    "--parameters", JSON.stringify({ commands: [script] }),
    "--query", "Command.CommandId",
    "--output", "text",
  ], {
    encoding: "utf8",
    env: trustedCommandEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
  if (!/^[0-9a-f-]{36}$/i.test(commandId)) throw new Error("AWS SSM did not return a command id");

  for (let attempt = 0; attempt < 60; attempt++) {
    let invocation: Record<string, unknown>;
    try {
      invocation = JSON.parse(execFileSync("aws", [
        "ssm", "get-command-invocation",
        "--region", AWS_REGION,
        "--command-id", commandId,
        "--instance-id", HISTORICAL_PRODUCTION_INSTANCE_ID,
        "--output", "json",
      ], {
        encoding: "utf8",
        env: trustedCommandEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      })) as Record<string, unknown>;
    } catch {
      await sleep(2_000);
      continue;
    }
    const status = String(invocation.Status ?? "");
    if (["Pending", "InProgress", "Delayed"].includes(status)) {
      await sleep(2_000);
      continue;
    }
    if (status !== "Success") {
      throw new Error(
        `production universe SSM attestation failed status=${status}: `
          + String(invocation.StandardErrorContent ?? "").slice(-2000),
      );
    }
    try {
      const parsed = JSON.parse(
        String(invocation.StandardOutputContent ?? "").trim(),
      ) as Omit<HistoricalProductionUniverseAttestation, "command_id">;
      return { ...parsed, command_id: commandId };
    } catch {
      throw new Error("production universe SSM attestation returned malformed JSON");
    }
  }
  throw new Error("production universe SSM attestation timed out");
}

function branchAuditSha256(record: HistoricalGapRecord): string {
  return sha256(`${JSON.stringify(record.branch_audit ?? null)}\n`);
}

function prepareReceiptPath(gapId: string, branch: string): string {
  const safeGap = gapId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(
    gitCommonDir,
    "mev-historical-prepares",
    `${safeGap}-${sha256(branch).slice(0, 16)}.json`,
  );
}

function prepareReceiptDigest(receipt: HistoricalPrepareReceipt): string {
  return sha256(`${JSON.stringify(receipt)}\n`);
}

function prepareReceiptAuthPayload(receipt: HistoricalPrepareReceipt): string {
  const { auth_tag: _authTag, auth_command_id: _authCommandId, ...unsigned } = receipt;
  return `${JSON.stringify(unsigned)}\n`;
}

async function writePrepareReceipt(
  gapId: string,
  branch: string,
  inventory: HistoricalAuditInventory,
): Promise<string> {
  const unsigned: HistoricalPrepareReceipt = {
    schema_version: 1,
    gate: "historical-gap-prepare",
    gap_id: gapId,
    branch,
    origin_main_commit: git(["rev-parse", "origin/main"]),
    refs_sha256: inventory.refs_sha256,
    created_at: new Date().toISOString(),
    auth_tag: "",
    auth_command_id: "",
  };
  const auth = await requestTrustedReceiptAuth(prepareReceiptAuthPayload(unsigned));
  const receipt = { ...unsigned, auth_tag: auth.authTag, auth_command_id: auth.commandId };
  const receiptPath = prepareReceiptPath(gapId, branch);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, receiptPath);
  return prepareReceiptDigest(receipt);
}

async function validatePrepareReceipt(record: HistoricalGapRecord, validationErrors: string[]): Promise<void> {
  const expectedDigest = record.branch_audit?.prepare_receipt_sha256 ?? "";
  const receiptPath = prepareReceiptPath(record.gap_id, record.branch);
  if (!SHA64_RE.test(expectedDigest) || !fs.existsSync(receiptPath)) {
    validationErrors.push("searcher branch requires the trusted pre-branch inventory receipt");
    return;
  }
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as HistoricalPrepareReceipt;
    if (receipt.schema_version !== 1 || receipt.gate !== "historical-gap-prepare"
        || receipt.gap_id !== record.gap_id || receipt.branch !== record.branch
        || receipt.origin_main_commit !== record.base_commit
        || receipt.refs_sha256 !== record.branch_audit?.refs_sha256
        || !validIsoDate(receipt.created_at)
        || !/^[0-9a-f-]{36}$/i.test(receipt.auth_command_id ?? "")
        || !await verifyTrustedReceiptAuth(receipt.auth_tag, prepareReceiptAuthPayload(receipt))
        || prepareReceiptDigest(receipt) !== expectedDigest) {
      validationErrors.push("trusted pre-branch inventory receipt does not match this gap/base/audit");
    }
  } catch {
    validationErrors.push("trusted pre-branch inventory receipt is malformed");
  }
}

function historicalRecordIdentitySha256(record: HistoricalGapRecord): string {
  const { decision: _decision, ...identity } = record;
  return sha256(`${JSON.stringify(identity)}\n`);
}

function validIsoDate(value: unknown): boolean {
  return typeof value === "string" && value.includes("T") && Number.isFinite(Date.parse(value));
}

function assertCandidateBranchAbsent(branch: string): void {
  const collisions: string[] = [];
  if (safeGit(["rev-parse", "--verify", `refs/heads/${branch}`])) collisions.push(`refs/heads/${branch}`);
  if (originBranchCommit(branch)) collisions.push(`refs/heads/${branch}@origin`);
  for (const worktree of worktreeInventory()) {
    if (worktree.branch === `refs/heads/${branch}`) collisions.push(`worktree:${worktree.path}`);
  }
  if (collisions.length > 0) {
    throw new Error(
      `candidate branch already exists (${collisions.join(",")}); inspect it as prior work and choose a fresh `
        + "literal ab/* branch so the old ref remains in the auditable inventory",
    );
  }
}

function refInventory(excludedBranch: string): HistoricalAuditInventory {
  const refs: HistoricalAuditInventory["refs"] = [];
  remoteInventoryCommits.clear();
  for (const line of git([
    "for-each-ref",
    "--format=%(refname)\t%(objectname)",
    "refs",
  ]).split(/\r?\n/).filter(Boolean)) {
    const [ref, commit] = line.split("\t");
    if (ref === "refs/remotes/origin/HEAD"
        || ref === `refs/heads/${excludedBranch}`
        || ref === `refs/remotes/origin/${excludedBranch}`) continue;
    refs.push({
      ref: `git-ref:${ref}`,
      kind: "git-ref",
      fingerprint: sha256(`${ref}\0${commit}\n`),
    });
  }

  for (const remote of git(["remote"]).split(/\r?\n/).filter(Boolean).sort()) {
    const output = execFileSync("git", ["ls-remote", "--refs", remote], {
      cwd: repoRoot,
      encoding: "utf8",
      env: trustedCommandEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const [commit, ref] = line.split(/\s+/);
      if (!SHA40_RE.test(commit) || !ref?.startsWith("refs/")) {
        throw new Error(`remote ref inventory returned malformed identity for ${remote}`);
      }
      if (remote === "origin" && ref === `refs/heads/${excludedBranch}`) continue;
      const identity = `remote:${remote}:${ref}`;
      remoteInventoryCommits.set(`git-ref:${identity}`, commit);
      refs.push({
        ref: `git-ref:${identity}`,
        kind: "git-ref",
        fingerprint: sha256(`${identity}\0${commit}\n`),
      });
    }
  }

  for (const worktree of worktreeInventory()) {
    if (worktree.branch === `refs/heads/${excludedBranch}`) continue;
    refs.push({
      ref: `worktree:${worktree.path}`,
      kind: "worktree",
      fingerprint: worktreeFingerprint(worktree.path, worktree.head, worktree.branch),
    });
    const evidence = worktreeEvidenceFingerprint(worktree.path);
    if (evidence) {
      refs.push({
        ref: `worktree-evidence:${worktree.path}`,
        kind: "worktree-evidence",
        fingerprint: evidence,
      });
    }
  }

  refs.push({
    ref: "origin-main-reports",
    kind: "origin-main-reports",
    fingerprint: originMainEvidenceFingerprint("docs/research/reports"),
  });
  refs.push({
    ref: "origin-main-resolutions",
    kind: "origin-main-resolutions",
    fingerprint: originMainEvidenceFingerprint("docs/research/resolutions"),
  });
  refs.sort((a, b) => a.ref.localeCompare(b.ref));
  return {
    schema_version: 1,
    refs_sha256: sha256(`${JSON.stringify(refs)}\n`),
    refs,
  };
}

function worktreeInventory(): Array<{ path: string; head: string; branch: string }> {
  const result: Array<{ path: string; head: string; branch: string }> = [];
  for (const block of git(["worktree", "list", "--porcelain"]).split(/\n\s*\n/)) {
    let worktreePath = "";
    let head = "";
    let branch = "detached";
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) worktreePath = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length);
    }
    if (worktreePath && SHA40_RE.test(head)) result.push({ path: worktreePath, head, branch });
  }
  return result;
}

function worktreeFingerprint(worktreePath: string, head: string, branch: string): string {
  const hash = createHash("sha256");
  hash.update(`${worktreePath}\0${head}\0${branch}\n`);
  hash.update(safeGitAt(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"], false));
  hash.update(safeGitAt(worktreePath, ["diff", "--binary", "HEAD"], false));
  hash.update(safeGitAt(worktreePath, ["diff", "--cached", "--binary", "HEAD"], false));
  hashUntrackedFiles(hash, worktreePath, safeGitAt(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"], false));
  return hash.digest("hex");
}

function worktreeEvidenceFingerprint(worktreePath: string): string | null {
  const paths = ["docs/research/reports", "docs/research/resolutions"];
  const status = safeGitAt(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all", "--", ...paths], false);
  if (!status.trim()) return null;
  const hash = createHash("sha256");
  hash.update(status);
  hash.update(safeGitAt(worktreePath, ["diff", "--binary", "HEAD", "--", ...paths], false));
  hash.update(safeGitAt(worktreePath, ["diff", "--cached", "--binary", "HEAD", "--", ...paths], false));
  hashUntrackedFiles(
    hash,
    worktreePath,
    safeGitAt(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths], false),
  );
  return hash.digest("hex");
}

function hashUntrackedFiles(hash: ReturnType<typeof createHash>, cwd: string, entries: string): void {
  for (const relative of entries.split("\0").filter(Boolean).sort()) {
    const absolute = path.join(cwd, relative);
    hash.update(`${relative}\0`);
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isFile()) hash.update(fs.readFileSync(absolute));
      else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(absolute));
    } catch {
      hash.update("missing");
    }
  }
}

function originMainEvidenceFingerprint(directory: string): string {
  return sha256(safeGit(["ls-tree", "-r", "--full-tree", "origin/main", "--", directory], false));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateGitIdentity(
  record: HistoricalGapRecord,
  phase: HistoricalGatePhase,
  artifactCommit: string | null,
  validationErrors: string[],
): void {
  const originMain = git(["rev-parse", "origin/main"]);
  if (phase !== "close" && originMain !== record.base_commit) {
    validationErrors.push(`origin/main drifted from tested base: ${originMain} != ${record.base_commit}`);
  }
  if (!gitSucceeds(["cat-file", "-e", `${record.challenger_commit}^{commit}`])) {
    validationErrors.push("challenger_commit is not available locally");
  }
  if (!gitSucceeds(["merge-base", "--is-ancestor", record.base_commit, record.challenger_commit])) {
    validationErrors.push("base_commit must be an ancestor of challenger_commit");
  }
  if (phase === "close") return;
  const artifactAvailable = artifactCommit !== null
    && gitSucceeds(["cat-file", "-e", `${artifactCommit}^{commit}`]);
  const artifactDescends = artifactAvailable && artifactCommit !== null
    && gitSucceeds(["merge-base", "--is-ancestor", record.challenger_commit, artifactCommit]);
  const artifactOnlyFiles = artifactCommit
    ? safeGit(["diff", "--name-only", record.challenger_commit, artifactCommit]).split(/\r?\n/).filter(Boolean)
    : [];
  validationErrors.push(...validateHistoricalArtifactCommit(
    artifactAvailable,
    artifactDescends,
    artifactOnlyFiles,
  ));
  const localBranch = safeGit(["rev-parse", `refs/heads/${record.branch}`]);
  const remoteBranch = originBranchCommit(record.branch);
  if (localBranch && localBranch !== artifactCommit) {
    validationErrors.push("local branch tip does not equal --artifact-ref");
  }
  if (remoteBranch && remoteBranch !== artifactCommit) {
    validationErrors.push("origin branch tip does not equal --artifact-ref");
  }
  if (!localBranch && !remoteBranch) {
    validationErrors.push("candidate branch is absent locally and on origin");
  }
}

function validateBranchAudit(record: HistoricalGapRecord, validationErrors: string[]): void {
  if (!record.branch_audit) {
    validationErrors.push("branch_audit is required for searcher behavior work");
    return;
  }
  const inventory = refInventory(record.branch);
  validationErrors.push(...validateHistoricalBranchAuditCoverage(
    record.branch_audit,
    inventory,
    discoverSameGapEvidence(record.gap_id, record.branch, inventory),
    discoverRuntimeOverlapEvidence(record, record.branch, inventory),
  ));
  validateReusablePriorCommits(record, validationErrors);
}

function validateReusablePriorCommits(record: HistoricalGapRecord, validationErrors: string[]): void {
  for (const match of (record.branch_audit?.matches ?? []).filter((entry) => entry.disposition === "reusable")) {
    const commit = match.reused_commit ?? "";
    if (!SHA40_RE.test(commit)) continue;
    if (!gitSucceeds(["cat-file", "-e", `${commit}^{commit}`])) {
      validationErrors.push(`reused_commit is unavailable for ${match.ref}`);
      continue;
    }
    if (gitSucceeds(["merge-base", "--is-ancestor", commit, record.base_commit])) {
      validationErrors.push(`reused_commit for ${match.ref} is already contained in base_commit`);
    }
    if (!gitSucceeds(["merge-base", "--is-ancestor", commit, record.challenger_commit])) {
      validationErrors.push(`challenger_commit does not contain reusable prior commit for ${match.ref}`);
    }
    const sourceCommit = reusableSourceCommit(match.ref);
    if (!sourceCommit || !gitSucceeds(["merge-base", "--is-ancestor", commit, sourceCommit])) {
      validationErrors.push(`reused_commit is not reachable from inventoried source ${match.ref}`);
    }
  }
}

function reusableSourceCommit(ref: string): string | null {
  if (ref.startsWith("git-ref:remote:")) {
    const identity = parseRemoteInventoryRef(ref);
    if (!identity) return null;
    const { remote, remoteRef } = identity;
    const inventoried = remoteInventoryCommits.get(ref);
    if (inventoried) return inventoried;
    const line = execFileSync("git", ["ls-remote", "--refs", remote, remoteRef], {
      cwd: repoRoot,
      encoding: "utf8",
      env: trustedCommandEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    }).trim();
    const commit = line.split(/\s+/)[0] ?? "";
    return SHA40_RE.test(commit) ? commit : null;
  }
  if (ref.startsWith("git-ref:")) return safeGit(["rev-parse", "--verify", ref.slice("git-ref:".length)]) || null;
  if (ref.startsWith("worktree:")) {
    const worktreePath = ref.slice("worktree:".length);
    const worktree = worktreeInventory().find((entry) => entry.path === worktreePath);
    return worktree?.head ?? null;
  }
  return null;
}

function discoverSameGapEvidence(
  gapId: string,
  excludedBranch: string,
  inventory: HistoricalAuditInventory,
): string[] {
  const found = new Set<string>();
  fetchMissingRemoteInventoryObjects(inventory);
  for (const entry of inventory.refs.filter((candidate) => candidate.kind === "git-ref")) {
    const ref = entry.ref.slice("git-ref:".length);
    if (ref === `refs/heads/${excludedBranch}` || ref === `refs/remotes/origin/${excludedBranch}`) continue;
    const commit = ref.startsWith("remote:") ? reusableSourceCommit(entry.ref) : ref;
    if (!commit || !gitSucceeds(["cat-file", "-e", `${commit}^{commit}`])) continue;
    const files = safeGit(["ls-tree", "-r", "--name-only", commit, "docs/research/reports"]);
    for (const file of files.split(/\r?\n/).filter((entry) => entry.endsWith(".md"))) {
      const source = safeGit(["show", `${commit}:${file}`], false);
      if (!source) continue;
      if (reportGapId(source) === gapId) {
        if (ref === "refs/heads/main" || ref === "refs/remotes/origin/main") found.add("origin-main-reports");
        else found.add(entry.ref);
      }
    }
  }
  const resolutionFiles = safeGit([
    "ls-tree", "-r", "--name-only", "origin/main", "docs/research/resolutions",
  ]).split(/\r?\n/).filter((entry) => entry.endsWith(".json"));
  for (const file of resolutionFiles) {
    const source = safeGit(["show", `origin/main:${file}`], false);
    try {
      const parsed = JSON.parse(source) as { problem_id?: string };
      if (parsed.problem_id === gapId) found.add("origin-main-resolutions");
    } catch {
      // Invalid resolution files are rejected by their own gate; they cannot prove same-gap reuse here.
    }
  }
  for (const worktree of worktreeInventory()) {
    if (worktree.branch === `refs/heads/${excludedBranch}`) continue;
    const evidenceRef = `worktree-evidence:${worktree.path}`;
    if (!inventory.refs.some((entry) => entry.ref === evidenceRef)) continue;
    for (const file of modifiedEvidenceFiles(worktree.path)) {
      try {
        const source = fs.readFileSync(path.join(worktree.path, file), "utf8");
        if ((file.endsWith(".md") && reportGapId(source) === gapId)
            || (file.endsWith(".json") && JSON.parse(source).problem_id === gapId)) {
          found.add(evidenceRef);
        }
      } catch {
        // Deleted or malformed local evidence cannot prove reuse.
      }
    }
  }
  return [...found].sort();
}

function discoverRuntimeOverlapEvidence(
  record: HistoricalGapRecord,
  excludedBranch: string,
  inventory: HistoricalAuditInventory,
): string[] {
  const candidateFiles = new Set(
    safeGit(["diff", "--name-only", record.base_commit, record.challenger_commit], false)
      .split(/\r?\n/)
      .filter((file) => file.startsWith("listener/src/") && file.endsWith(".ts")),
  );
  if (candidateFiles.size === 0) return [];
  const found = new Set<string>();
  fetchMissingRemoteInventoryObjects(inventory);
  for (const entry of inventory.refs.filter((candidate) => candidate.kind === "git-ref")) {
    const ref = entry.ref.slice("git-ref:".length);
    if (ref === "refs/heads/main" || ref === "refs/remotes/origin/main"
        || ref === `refs/heads/${excludedBranch}` || ref === `refs/remotes/origin/${excludedBranch}`
        || ref === `remote:origin:refs/heads/${excludedBranch}`) continue;
    const commit = ref.startsWith("remote:") ? reusableSourceCommit(entry.ref) : ref;
    if (!commit || !gitSucceeds(["cat-file", "-e", `${commit}^{commit}`])
        || gitSucceeds(["merge-base", "--is-ancestor", commit, record.base_commit])) continue;
    const mergeBase = safeGit(["merge-base", record.base_commit, commit]);
    if (!SHA40_RE.test(mergeBase)) {
      found.add(entry.ref);
      continue;
    }
    const changed = safeGit(["diff", "--name-only", mergeBase, commit], false).split(/\r?\n/);
    if (changed.some((file) => candidateFiles.has(file))) found.add(entry.ref);
  }
  for (const worktree of worktreeInventory()) {
    if (worktree.branch === `refs/heads/${excludedBranch}`) continue;
    const ref = `worktree:${worktree.path}`;
    if (!inventory.refs.some((entry) => entry.ref === ref)
        || gitSucceeds(["merge-base", "--is-ancestor", worktree.head, record.base_commit])) continue;
    const mergeBase = safeGitAt(worktree.path, ["merge-base", record.base_commit, worktree.head]);
    const committed = SHA40_RE.test(mergeBase)
      ? safeGitAt(worktree.path, ["diff", "--name-only", mergeBase, worktree.head], false).split(/\r?\n/)
      : [...candidateFiles];
    const dirty = safeGitAt(worktree.path, [
      "status", "--porcelain=v1", "--untracked-files=all", "--", "listener/src",
    ], false).split(/\r?\n/).filter(Boolean).map((line) => {
      const value = line.slice(3);
      const renameIndex = value.lastIndexOf(" -> ");
      return renameIndex >= 0 ? value.slice(renameIndex + 4) : value;
    });
    if ([...committed, ...dirty].some((file) => candidateFiles.has(file))) found.add(ref);
  }
  return [...found].sort();
}

function parseRemoteInventoryRef(ref: string): { remote: string; remoteRef: string } | null {
  const prefix = "git-ref:remote:";
  if (!ref.startsWith(prefix)) return null;
  const identity = ref.slice(prefix.length);
  const separator = identity.indexOf(":refs/");
  if (separator <= 0) return null;
  const remote = identity.slice(0, separator);
  const remoteRef = identity.slice(separator + 1);
  if (!git(["remote"]).split(/\r?\n/).includes(remote) || !remoteRef.startsWith("refs/")) return null;
  return { remote, remoteRef };
}

function fetchMissingRemoteInventoryObjects(inventory: HistoricalAuditInventory): void {
  const byRemote = new Map<string, string[]>();
  for (const entry of inventory.refs.filter((candidate) => candidate.ref.startsWith("git-ref:remote:"))) {
    const identity = parseRemoteInventoryRef(entry.ref);
    const commit = remoteInventoryCommits.get(entry.ref) ?? reusableSourceCommit(entry.ref);
    if (!identity || !commit || gitSucceeds(["cat-file", "-e", `${commit}^{object}`])) continue;
    const refs = byRemote.get(identity.remote) ?? [];
    refs.push(identity.remoteRef);
    byRemote.set(identity.remote, refs);
  }
  for (const [remote, refs] of byRemote) {
    for (let offset = 0; offset < refs.length; offset += 100) {
      execFileSync("git", [
        "fetch", "--no-tags", "--force", "--no-write-fetch-head", remote,
        ...refs.slice(offset, offset + 100),
      ], {
        cwd: repoRoot,
        env: trustedCommandEnv(),
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 300_000,
      });
    }
  }
  for (const entry of inventory.refs.filter((candidate) => candidate.ref.startsWith("git-ref:remote:"))) {
    const commit = remoteInventoryCommits.get(entry.ref) ?? reusableSourceCommit(entry.ref);
    if (!commit || !gitSucceeds(["cat-file", "-e", `${commit}^{object}`])) {
      throw new Error(`remote inventory object is unavailable for inspection: ${entry.ref}`);
    }
  }
}

function reportGapId(source: string): string | null {
  try {
    return parseHistoricalGap(source).gap_id;
  } catch {
    try {
      return parseAbExperiment(source).problem_id;
    } catch {
      return null;
    }
  }
}

function modifiedEvidenceFiles(worktreePath: string): string[] {
  const status = safeGitAt(worktreePath, [
    "status", "--porcelain=v1", "--untracked-files=all", "--",
    "docs/research/reports", "docs/research/resolutions",
  ], false);
  return status.split(/\r?\n/).filter(Boolean).map((line) => {
    const value = line.slice(3);
    const renameIndex = value.lastIndexOf(" -> ");
    return renameIndex >= 0 ? value.slice(renameIndex + 4) : value;
  }).filter((file) => file.endsWith(".md") || file.endsWith(".json"));
}

function validateDiffScope(
  record: HistoricalGapRecord,
  track: ReturnType<typeof historicalValidationTrack>,
  phase: HistoricalGatePhase,
  validationErrors: string[],
): void {
  const changed = git(["diff", "--name-only", record.base_commit, record.challenger_commit])
    .split(/\r?\n/).filter(Boolean);
  const patch = safeGit(["diff", "--unified=0", record.base_commit, record.challenger_commit], false);
  if (track !== null) validationErrors.push(...validateHistoricalDiffScope(changed, track, patch));
  if (track === "direct-main" && changed.includes("analysis/package.json")) {
    validationErrors.push(...validateDirectMainPackageManifest(
      safeGit(["show", `${record.base_commit}:analysis/package.json`], false),
      safeGit(["show", `${record.challenger_commit}:analysis/package.json`], false),
    ));
  }
  if (phase !== "classify" && record.validation?.review?.diff_sha256 !== sha256(patch)) {
    validationErrors.push("fresh review diff_sha256 does not match the exact base..challenger patch");
  }
}

const FAMILY_CONFORMANCE_SCRIPTS = [
  "src/searcher/test/adapter-descriptors.ts",
  "src/searcher/test/route-adapters.ts",
  "src/searcher/test/token-graph-family-isolation.ts",
  "src/searcher/test/adapter-family-shared-surface-conformance.ts",
] as const;

function runRepositoryGates(
  validationRoot: string,
  baselineRoot: string,
  track: ReturnType<typeof historicalValidationTrack>,
): HistoricalFamilyConformanceAttestation | undefined {
  const analysisRoot = validationRoot;
  runTypeScriptBuild(analysisRoot, "analysis", "analysis build");
  runAnalysisTests(analysisRoot);
  runTypeScriptBuild(validationRoot, "listener", "listener build");
  runBoundaryDelta(baselineRoot, validationRoot);
  return track === "family-execution"
    ? runFamilyConformanceGates(validationRoot, baselineRoot)
    : undefined;
}

function runFamilyConformanceGates(
  validationRoot: string,
  baselineRoot: string,
): HistoricalFamilyConformanceAttestation {
  const listenerRoot = path.join(validationRoot, "listener");
  const baselineListenerRoot = path.join(baselineRoot, "listener");
  const checks = FAMILY_CONFORMANCE_SCRIPTS.map((scriptPath) => {
    const sourcePath = path.join(listenerRoot, scriptPath);
    const baselineSourcePath = path.join(baselineListenerRoot, scriptPath);
    if (!fs.existsSync(sourcePath) || !fs.existsSync(baselineSourcePath)) {
      throw new Error(`family conformance script is missing: ${scriptPath}`);
    }
    const sourceSha256 = sha256(fs.readFileSync(sourcePath));
    if (sourceSha256 !== sha256(fs.readFileSync(baselineSourcePath))) {
      throw new Error(
        `family conformance script differs from the frozen baseline: ${scriptPath}`,
      );
    }
    const result = capture(
      process.execPath,
      ["--import", packageModule(listenerRoot, "tsx"), scriptPath],
      listenerRoot,
    );
    if (result.status !== 0) {
      throw new Error(
        `family conformance ${scriptPath} exited ${result.status ?? "signal"}:\n`
          + result.output.slice(-4000),
      );
    }
    return {
      script_path: scriptPath,
      source_sha256: sourceSha256,
      output_sha256: sha256(result.output),
    };
  });
  return { schema_version: 1, checks };
}

function runTypeScriptBuild(root: string, packageDirectory: "analysis" | "listener", label: string): void {
  const packageRoot = path.join(root, packageDirectory);
  run(process.execPath, [packageModule(packageRoot, "typescript/bin/tsc"), "--noEmit"], packageRoot, label);
}

function runAnalysisTests(root: string): void {
  const packageRoot = path.join(root, "analysis");
  const testRoot = path.join(packageRoot, "src", "test");
  const tests = fs.readdirSync(testRoot)
    .filter((file) => file.endsWith(".ts"))
    .sort()
    .map((file) => path.join("src", "test", file));
  if (tests.length === 0) throw new Error("analysis test inventory is empty");
  run(
    process.execPath,
    ["--import", packageModule(packageRoot, "tsx"), "--test", ...tests],
    packageRoot,
    "analysis tests",
  );
  run(
    process.execPath,
    ["--import", packageModule(packageRoot, "tsx"), "src/cli/competitor-calibration.ts"],
    packageRoot,
    "competitor calibration",
  );
}

function runBoundaryDelta(baselineRoot: string, challengerRoot: string): void {
  const baselinePackage = path.join(baselineRoot, "listener");
  const challengerPackage = path.join(challengerRoot, "listener");
  const baseline = capture(
    process.execPath,
    ["--import", packageModule(baselinePackage, "tsx"), "src/searcher/test/boundary.ts"],
    baselinePackage,
  );
  const challenger = capture(
    process.execPath,
    ["--import", packageModule(challengerPackage, "tsx"), "src/searcher/test/boundary.ts"],
    challengerPackage,
  );
  if (challenger.status === 0) return;
  if (baseline.status === challenger.status && normalizeOutput(baseline.output) === normalizeOutput(challenger.output)) {
    console.log("listener_boundary_lint=preexisting_equal");
    return;
  }
  throw new Error(`listener boundary lint regressed:\n${challenger.output.slice(-4000)}`);
}

function capture(command: string, commandArgs: string[], cwd: string): { status: number | null; output: string } {
  const result = spawnSync(SANDBOX_EXEC, ["-p", candidateSandboxProfile(), command, ...commandArgs], {
    cwd,
    env: candidateCommandEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30 * 60 * 1000,
  });
  if (result.error) throw new Error(`failed to run ${command}: ${result.error.message}`);
  return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim() };
}

function packageModule(packageRoot: string, specifier: string): string {
  return createRequire(path.join(packageRoot, "package.json")).resolve(specifier);
}

function normalizeOutput(output: string): string {
  return output.split(/\r?\n/)
    .filter((line) => !/^>\s/.test(line) && !/^\s*$/.test(line))
    .join("\n");
}

function runFamilyExecutionReplays(
  record: HistoricalGapRecord,
  artifactCommit: string,
  replayEnvironment: ValidatedFamilyReplayEnvironment,
  baseRoot: string,
  challengerRoot: string,
): HistoricalFamilyExecutionArtifact[] {
  const artifactRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(candidateSandboxHome, "family-execution-artifacts-")),
  );
  try {
    const samples = record.samples.map((sample, index) =>
      materializeFamilyExecutionSample(
        sample,
        index,
        artifactCommit,
        artifactRoot,
        challengerRoot,
      ));
    return samples.map((sample, index) => {
      const baselineProbe = runAdapterFamilyProbe(baseRoot, sample.executionFamilyId, `baseline family probe ${index}`);
      let baseline: HistoricalFamilyExecutionSideResult;
      if (!baselineProbe.probe.registered) {
        baseline = {
          status: "family_not_registered",
          probe: baselineProbe.probe,
          replay: null,
          output_sha256: baselineProbe.outputSha256,
        };
      } else {
        const replay = runAdapterFamilyReplay(
          baseRoot,
          artifactRoot,
          sample,
          replayEnvironment.rpcUrl,
          record.base_commit,
          `baseline family replay ${index}`,
        );
        if (replay.report.verdict !== "implemented_not_validated"
            || !replay.report.failure
            || replay.report.failureOwnerFamilyId !== sample.executionFamilyId
            || replay.report.stages.chainAnchor !== true
            || replay.status === 0) {
          throw new Error(
            `baseline family replay ${index} must emit registered+implemented_not_validated `
              + "after proving the chain anchor, with a typed failure owned by the subject family "
              + "and a nonzero exit",
          );
        }
        baseline = {
          status: "implemented_not_validated",
          probe: baselineProbe.probe,
          replay: replay.report,
          output_sha256: sha256(`${baselineProbe.output}\0${replay.output}`),
          failure_fingerprint_sha256: familyReplayFailureFingerprint(replay.report),
        };
      }

      const challengerProbe = runAdapterFamilyProbe(
        challengerRoot,
        sample.executionFamilyId,
        `challenger family probe ${index}`,
      );
      if (!challengerProbe.probe.registered) {
        throw new Error(`challenger family probe ${index} reports family_not_registered`);
      }
      const challengerReplay = runAdapterFamilyReplay(
        challengerRoot,
        artifactRoot,
        sample,
        replayEnvironment.rpcUrl,
        record.challenger_commit,
        `challenger family replay ${index}`,
      );
      if (challengerReplay.status !== 0
          || challengerReplay.report.verdict !== "adapter_replay_pass"
          || challengerReplay.report.failureOwnerFamilyId !== null
          || challengerReplay.report.failure !== null
          || Object.values(challengerReplay.report.stages).some((passed) => passed !== true)) {
        throw new Error(
          `challenger family replay ${index} must emit adapter_replay_pass with every stage true and exit 0`,
        );
      }
      if (baseline.status === "implemented_not_validated") {
        const confirmation = runAdapterFamilyReplay(
          baseRoot,
          artifactRoot,
          sample,
          replayEnvironment.rpcUrl,
          record.base_commit,
          `baseline family replay confirmation ${index}`,
        );
        const confirmationFingerprint = familyReplayFailureFingerprint(confirmation.report);
        if (confirmation.status === 0
            || confirmation.report.verdict !== "implemented_not_validated"
            || confirmation.report.failureOwnerFamilyId !== sample.executionFamilyId
            || confirmation.report.stages.chainAnchor !== true
            || confirmationFingerprint !== baseline.failure_fingerprint_sha256) {
          throw new Error(
            `baseline family replay ${index} did not reproduce the same semantic failure after the challenger pass; `
              + "a transient runner/RPC failure cannot prove a family flip",
          );
        }
        baseline = {
          ...baseline,
          confirmation_replay: confirmation.report,
          confirmation_output_sha256: sha256(confirmation.output),
          confirmation_failure_fingerprint_sha256: confirmationFingerprint,
        };
      }
      return {
        fixture_path: sample.fixturePath,
        fixture_sha256: sample.fixtureSha256,
        evidence_path: sample.evidencePath,
        evidence_sha256: sample.evidenceSha256,
        reference_tx: sample.referenceTx,
        execution_family_id: sample.executionFamilyId,
        baseline,
        challenger: {
          status: "adapter_replay_pass",
          probe: challengerProbe.probe,
          replay: challengerReplay.report,
          output_sha256: sha256(`${challengerProbe.output}\0${challengerReplay.output}`),
        },
      };
    });
  } finally {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
}

function materializeFamilyExecutionSample(
  sample: HistoricalGapRecord["samples"][number],
  index: number,
  artifactCommit: string,
  artifactRoot: string,
  artifactObjectRoot: string,
): MaterializedFamilyExecutionSample {
  const fixturePath = normalizeHistoricalReportArtifactPath(
    sample.adapter_replay_fixture ?? "",
    [".json"],
  );
  const evidencePath = normalizeHistoricalReportArtifactPath(
    sample.adapter_replay_evidence ?? "",
    [".md", ".json"],
  );
  const fixtureSha256 = sample.adapter_replay_fixture_sha256 ?? "";
  const evidenceSha256 = sample.adapter_replay_evidence_sha256 ?? "";
  if (!fixturePath || !evidencePath || !SHA64_RE.test(fixtureSha256) || !SHA64_RE.test(evidenceSha256)) {
    throw new Error(`family execution sample ${index} artifact declaration is invalid`);
  }
  const fixtureBytes = safeGitAt(
    artifactObjectRoot,
    ["show", `${artifactCommit}:${fixturePath}`],
    false,
  );
  const evidenceBytes = safeGitAt(
    artifactObjectRoot,
    ["show", `${artifactCommit}:${evidencePath}`],
    false,
  );
  if (!fixtureBytes || sha256(fixtureBytes) !== fixtureSha256) {
    throw new Error(`family execution sample ${index} fixture is absent from --artifact-ref or its SHA-256 differs`);
  }
  if (!evidenceBytes || sha256(evidenceBytes) !== evidenceSha256) {
    throw new Error(`family execution sample ${index} evidence is absent from --artifact-ref or its SHA-256 differs`);
  }
  let fixture: Record<string, unknown>;
  try {
    fixture = JSON.parse(fixtureBytes) as Record<string, unknown>;
  } catch {
    throw new Error(`family execution sample ${index} fixture must be valid JSON`);
  }
  const landed = fixture.landedReference;
  if (fixture.schemaVersion !== 3
      || typeof fixture.executionFamilyId !== "string"
      || !fixture.executionFamilyId.trim()
      || String(fixture.referenceTx ?? "").toLowerCase() !== sample.tx_hash.toLowerCase()
      || !landed || typeof landed !== "object" || Array.isArray(landed)
      || (landed as Record<string, unknown>).evidencePath !== evidencePath
      || (landed as Record<string, unknown>).evidenceSha256 !== evidenceSha256) {
    throw new Error(
      `family execution sample ${index} fixture identity/evidence binding does not match the historical record`,
    );
  }
  materializeFamilyArtifact(artifactRoot, fixturePath, fixtureBytes);
  materializeFamilyArtifact(artifactRoot, evidencePath, evidenceBytes);
  return {
    fixturePath,
    fixtureSha256,
    evidencePath,
    evidenceSha256,
    referenceTx: sample.tx_hash.toLowerCase(),
    executionFamilyId: fixture.executionFamilyId,
  };
}

function materializeFamilyArtifact(root: string, relativePath: string, bytes: string): void {
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target).split(path.sep).join("/");
  if (!relative || relative === ".." || relative.startsWith("../")) {
    throw new Error("family execution artifact escapes the gate-owned root");
  }
  if (fs.existsSync(target)) {
    if (fs.readFileSync(target, "utf8") !== bytes) {
      throw new Error(`family execution artifact path is reused with different bytes: ${relativePath}`);
    }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
}

function runAdapterFamilyProbe(
  worktreeRoot: string,
  executionFamilyId: string,
  label: string,
): { probe: AdapterFamilyRegistryProbe; output: string; outputSha256: string } {
  const listenerRoot = path.join(worktreeRoot, "listener");
  const result = captureFamilyRunner(
    worktreeRoot,
    ["--probe-family", executionFamilyId],
    {},
    label,
    120_000,
  );
  if (result.status !== 0) throw new Error(`${label} exited ${result.status ?? "signal"} before a valid probe`);
  const probe = parseSingleStructuredMarker<AdapterFamilyRegistryProbe>(
    result.output,
    "ADAPTER_FAMILY_REGISTRY_PROBE",
    label,
  );
  if (probe.schemaVersion !== 1
      || probe.executionFamilyId !== executionFamilyId
      || typeof probe.registered !== "boolean") {
    throw new Error(`${label} emitted a malformed or mismatched registry probe`);
  }
  // Resolve tsx now so a missing candidate dependency is a gate failure, not a
  // family_not_registered result.
  packageModule(listenerRoot, "tsx");
  return { probe, output: result.output, outputSha256: sha256(result.output) };
}

function runAdapterFamilyReplay(
  worktreeRoot: string,
  artifactRoot: string,
  sample: MaterializedFamilyExecutionSample,
  rpcUrl: string,
  expectedCommit: string,
  label: string,
): { report: AdapterFamilyReplayResult; output: string; status: number | null } {
  const result = captureFamilyRunner(
    worktreeRoot,
    [
      "--fixture", sample.fixturePath,
      "--artifact-root", artifactRoot,
      "--use-existing-botvm-artifact",
    ],
    { SEARCHER_LIVE_RPC_URL: rpcUrl },
    label,
    30 * 60 * 1000,
  );
  const report = parseSingleStructuredMarker<AdapterFamilyReplayResult>(
    result.output,
    "ADAPTER_FAMILY_REPLAY_RESULT",
    label,
  );
  if (report.schemaVersion !== 2
      || report.fixturePath !== sample.fixturePath
      || report.fixtureSha256 !== sample.fixtureSha256
      || report.referenceTx.toLowerCase() !== sample.referenceTx
      || report.landedEvidencePath !== sample.evidencePath
      || report.landedEvidenceSha256 !== sample.evidenceSha256
      || report.executionFamilyId !== sample.executionFamilyId
      || !Array.isArray(report.routeExecutionFamilies)
      || report.routeExecutionFamilies.length === 0
      || report.routeExecutionFamilies.some((familyId) =>
        typeof familyId !== "string" || !familyId.trim())
      || !report.routeExecutionFamilies.includes(report.executionFamilyId)
      || !report.stateAnchor || typeof report.stateAnchor !== "object"
      || Array.isArray(report.stateAnchor)
      || (report.anchorReconstruction !== null
        && (typeof report.anchorReconstruction !== "object"
          || Array.isArray(report.anchorReconstruction)))
      || (report.anchorBlockHash !== null
        && !/^0x[a-f0-9]{64}$/i.test(report.anchorBlockHash))
      || (report.anchorStateRoot !== null
        && !/^0x[a-f0-9]{64}$/i.test(report.anchorStateRoot))
      || (report.baseCommit !== null && !SHA40_RE.test(report.baseCommit))
      || report.adapterCommit !== expectedCommit
      || !SHA64_RE.test(report.familySourceSha256)
      || !SHA64_RE.test(report.sharedApiSha256)
      || !SHA64_RE.test(report.runtimeSourceSha256)
      || !SHA64_RE.test(report.harnessSha256)
      || !SHA64_RE.test(report.botVmArtifactSha256)
      || !report.replayFlash || typeof report.replayFlash !== "object"
      || Array.isArray(report.replayFlash)
      || (report.routeHash !== "" && !SHA64_RE.test(report.routeHash))
      || (report.referenceRouteHash !== null
        && !SHA64_RE.test(report.referenceRouteHash))
      || !report.stages || typeof report.stages !== "object"
      || Array.isArray(report.stages)
      || Object.values(report.stages).length === 0
      || Object.values(report.stages).some((passed) => typeof passed !== "boolean")
      || !validFamilySemanticEvidence(report)
      || (report.verdict !== "adapter_replay_pass" && report.verdict !== "implemented_not_validated")
      || (report.failureOwnerFamilyId !== null
        && typeof report.failureOwnerFamilyId !== "string")
      || (report.failure !== null && typeof report.failure !== "string")) {
    throw new Error(`${label} emitted a malformed or mismatched structured replay result`);
  }
  return { report, output: result.output, status: result.status };
}

function captureFamilyRunner(
  worktreeRoot: string,
  runnerArgs: string[],
  environmentOverrides: NodeJS.ProcessEnv,
  label: string,
  timeout: number,
): { status: number | null; output: string } {
  const listenerRoot = path.join(worktreeRoot, "listener");
  const result = spawnSync(
    SANDBOX_EXEC,
    [
      "-p", candidateSandboxProfile(),
      process.execPath,
      "--import", packageModule(listenerRoot, "tsx"),
      "src/searcher/test/adapter-replay.ts",
      ...runnerArgs,
    ],
    {
      cwd: listenerRoot,
      env: { ...candidateCommandEnv(), ...environmentOverrides },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) throw new Error(`${label} failed to run: ${result.error.message}`);
  if (result.status === null) throw new Error(`${label} terminated by signal before a structured result`);
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
  };
}

function parseSingleStructuredMarker<T>(output: string, marker: string, label: string): T {
  const prefix = `${marker}=`;
  const values = output.split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  if (values.length !== 1) {
    throw new Error(`${label} must emit exactly one ${marker} marker`);
  }
  try {
    const parsed = JSON.parse(values[0]) as T;
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return parsed;
  } catch {
    throw new Error(`${label} emitted malformed ${marker} JSON`);
  }
}

function runCandidateReplays(
  record: HistoricalGapRecord,
  artifactCommit: string,
  replayEnvironment: ValidatedReplayEnvironment,
  baseRoot: string,
  challengerRoot: string,
): HistoricalPromotionReceipt["candidate_artifacts"] {
  const rpc = replayEnvironment.rpcUrl;
  const artifacts: HistoricalPromotionReceipt["candidate_artifacts"] = [];
  for (const [index, sample] of record.samples.entries()) {
    const candidatePath = normalizeHistoricalReportArtifactPath(sample.candidate_report ?? "", [".md"]);
    if (!candidatePath) {
      throw new Error(`samples[${index}].candidate_report must remain under docs/research/reports`);
    }
    const committedReport = safeGitAt(challengerRoot, ["show", `${artifactCommit}:${candidatePath}`], false);
    if (!committedReport) throw new Error(`sample ${index} candidate report is absent from --artifact-ref`);
    const absoluteReport = path.join(candidateSandboxHome, `candidate-report-${process.pid}-${index}.md`);
    fs.writeFileSync(absoluteReport, committedReport, { mode: 0o600, flag: "wx" });
    const trustedBackrunHarness = sample.strategy_kind === "backrun"
      ? prepareTrustedBackrunHarness(baseRoot, challengerRoot, index)
      : null;
    try {
      const experiment = parseAbExperiment(committedReport);
      const evidence = experiment.production_evidence;
      if (experiment.problem_id !== record.gap_id
          || experiment.branch !== record.branch
          || experiment.base_commit !== record.base_commit
          || experiment.challenger_commit !== record.challenger_commit) {
        throw new Error(`sample ${index} candidate report identity does not match historical gap record`);
      }
      if (!evidence?.sample || evidence.sample.tx_hash.toLowerCase() !== sample.tx_hash.toLowerCase()
          || evidence.sample.block_number !== sample.block_number
          || evidence.strategy_kind !== sample.strategy_kind
          || evidence.trigger_kind !== sample.trigger_kind
          || evidence.route_scope !== sample.route_scope
          || (evidence.sample.victim_tx_hash ?? "").toLowerCase() !== (sample.victim_tx_hash ?? "").toLowerCase()) {
        throw new Error(`sample ${index} candidate report classification does not match historical gap record`);
      }
      const manifestPath = resolveHistoricalReportArtifactPath(
        candidatePath,
        experiment.analysis.tool_selection?.evidence_manifest ?? "",
      );
      if (!manifestPath) throw new Error(`sample ${index} tool manifest must resolve under docs/research/reports`);
      const manifest = safeGitAt(challengerRoot, ["show", `${artifactCommit}:${manifestPath}`], false);
      if (!manifest) throw new Error(`sample ${index} tool manifest is absent from --artifact-ref`);
      const manifestSha256 = sha256(manifest);
      if (manifestSha256 !== experiment.analysis.tool_selection?.evidence_manifest_sha256) {
        throw new Error(`sample ${index} tool manifest SHA-256 does not match the candidate report`);
      }
      const analysisRoot = path.join(challengerRoot, "analysis");
      const replayArgs = [
        "--import", packageModule(analysisRoot, "tsx"), "src/cli/ab-canary-gate.ts", absoluteReport,
        "--phase", "candidate",
        "--expected-experiment", experiment.experiment_id,
        "--expected-branch", record.branch,
        "--expected-base", record.base_commit,
        "--expected-challenger", record.challenger_commit,
        "--expected-runtime-view-delta", experiment.expected_runtime_view_delta ? "1" : "0",
        "--expected-input-mode", experiment.input_mode,
        "--expected-config-delta", (experiment.allowed_config_delta ?? []).join(","),
        "--expected-lane-mode", experiment.lane_mode ?? "dual",
        "--rpc", rpc,
        "--base-root", baseRoot,
        "--challenger-root", challengerRoot,
        "--universe", replayEnvironment.universe,
        "--pool-universe-top-n", String(replayEnvironment.poolUniverseTopN),
        "--report-repo-path", candidatePath,
        "--artifact-ref", artifactCommit,
      ];
      if (trustedBackrunHarness) {
        replayArgs.push("--trusted-backrun-hunt-challenger", trustedBackrunHarness);
      }
      run(process.execPath, replayArgs, analysisRoot, `candidate replay ${index}`);
      artifacts.push({
        report_path: candidatePath,
        report_sha256: sha256(committedReport),
        manifest_path: manifestPath,
        manifest_sha256: manifestSha256,
      });
    } finally {
      fs.rmSync(absoluteReport, { force: true });
      if (trustedBackrunHarness) fs.rmSync(trustedBackrunHarness, { force: true });
    }
  }
  return artifacts;
}

function prepareTrustedBackrunHarness(baseRoot: string, challengerRoot: string, index: number): string {
  const trustedSource = path.join(baseRoot, "listener", "src", "searcher", "test", "backrun-hunt.ts");
  const target = path.join(
    challengerRoot,
    "listener",
    "src",
    "searcher",
    "test",
    `.ab-trusted-backrun-hunt-${process.pid}-${index}.ts`,
  );
  fs.copyFileSync(trustedSource, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, 0o400);
  if (sha256(fs.readFileSync(target)) !== sha256(fs.readFileSync(trustedSource))) {
    fs.rmSync(target, { force: true });
    throw new Error("trusted backrun harness copy does not match the frozen base harness");
  }
  return target;
}

interface CandidateValidationWorktrees {
  root: string;
  challengerRoot: string;
  baselineRoot: string;
}

function createCandidateValidationWorktrees(
  record: HistoricalGapRecord,
  artifactCommit: string,
  validationInputs: string[],
  baselineInputs: string[],
  writableForRepositoryGates: boolean,
): CandidateValidationWorktrees {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(candidateSandboxHome, "validation-worktrees-")));
  const challengerRoot = path.join(root, "challenger");
  const baselineRoot = path.join(root, "baseline");
  const added: string[] = [];
  try {
    for (const [worktree, commit, requiredCommits] of [
      [challengerRoot, record.challenger_commit, [record.challenger_commit, artifactCommit]],
      [baselineRoot, record.base_commit, [record.base_commit]],
    ] as const) {
      cloneHistoricalGapValidationRoot(
        repoRoot,
        worktree,
        commit,
        [...requiredCommits],
        trustedCommandEnv(),
      );
      added.push(worktree);
      if (writableForRepositoryGates) {
        candidateWritableRoots.add(worktree);
        candidateReadOnlyRoots.add(path.join(worktree, ".git"));
      } else {
        candidateReadOnlyRoots.add(worktree);
      }
    }
    linkTrustedInputs(challengerRoot, validationInputs);
    linkTrustedInputs(baselineRoot, baselineInputs);
    return { root, challengerRoot, baselineRoot };
  } catch (error) {
    for (const worktree of added.reverse()) removeTrustedWorktree(worktree);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function linkTrustedInputs(worktree: string, inputs: string[]): void {
  for (const relative of inputs) {
    const source = path.join(sharedToolchainRoot, relative);
    const destination = path.join(worktree, relative);
    if (!fs.existsSync(source)) throw new Error(`shared toolchain is missing ${relative}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(source, destination);
  }
}

function removeCandidateValidationWorktrees(worktrees: CandidateValidationWorktrees): void {
  const failures: string[] = [];
  for (const worktree of [worktrees.challengerRoot, worktrees.baselineRoot]) {
    try {
      removeTrustedWorktree(worktree);
    } catch (error) {
      failures.push(`${worktree}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    fs.rmSync(worktrees.root, { recursive: true, force: true });
  } catch (error) {
    failures.push(`${worktrees.root}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (failures.length > 0) {
    throw new Error(`failed to clean candidate validation worktrees:\n${failures.join("\n")}`);
  }
}

function removeTrustedWorktree(worktree: string): void {
  try {
    fs.rmSync(worktree, { recursive: true, force: true });
  } finally {
    candidateReadOnlyRoots.delete(worktree);
    candidateReadOnlyRoots.delete(path.join(worktree, ".git"));
    candidateWritableRoots.delete(worktree);
  }
}

function resetCandidateRuntimeHome(): void {
  fs.rmSync(candidateRuntimeHome, { recursive: true, force: true });
  fs.mkdirSync(candidateRuntimeHome, { mode: 0o700 });
}

function assertFrozenWorktree(
  worktreeRoot: string,
  expectedCommit: string,
  label: string,
  requiredExternalInputs: string[],
): void {
  const head = git(["rev-parse", "HEAD"], worktreeRoot);
  if (head !== expectedCommit) throw new Error(`${label} HEAD ${head} does not equal ${expectedCommit}`);
  const tracked = git(["status", "--porcelain=v1", "--untracked-files=no"], worktreeRoot);
  if (tracked) {
    throw new Error(`${label} has tracked changes; replay/smoke may only use committed bytes:\n${tracked.slice(0, 4000)}`);
  }
  const replayInputErrors = validateHistoricalReplayRootEntries(fs.readdirSync(worktreeRoot));
  if (replayInputErrors.length > 0) throw new Error(`${label}: ${replayInputErrors.join("; ")}`);
  const invalid = untrackedTopLevelEntries(worktreeRoot).filter((entry) => !isAllowedExternalInput(entry));
  if (invalid.length > 0) {
    throw new Error(`${label} has untrusted untracked inputs: ${invalid.join(",")}`);
  }
  for (const relative of requiredExternalInputs) {
    const local = path.join(worktreeRoot, relative);
    const trusted = path.join(sharedToolchainRoot, relative);
    if (!fs.existsSync(local)) throw new Error(`${label} is missing trusted external input ${relative}`);
    if (!fs.existsSync(trusted)) throw new Error(`shared toolchain is missing ${relative}`);
    if (pathContentDigest(local) !== pathContentDigest(trusted)) {
      throw new Error(`${label} external input ${relative} does not match the trusted shared toolchain`);
    }
  }
}

function assertTrustedGateRoot(inputs: string[]): string {
  const head = git(["rev-parse", "HEAD"]);
  const originMain = git(["rev-parse", "origin/main"]);
  if (head !== originMain) {
    throw new Error(`historical replay gate must execute from trusted origin/main: ${head} != ${originMain}`);
  }
  const tracked = git(["status", "--porcelain=v1", "--untracked-files=no"]);
  if (tracked) throw new Error(`trusted gate root has tracked changes:\n${tracked.slice(0, 4000)}`);
  const invalid = untrackedTopLevelEntries(repoRoot).filter((entry) => !isAllowedExternalInput(entry));
  if (invalid.length > 0) {
    throw new Error(`trusted gate root has untracked inputs: ${invalid.slice(0, 50).join(",")}`);
  }
  const digest = externalToolchainDigest(sharedToolchainRoot, inputs);
  console.log(`historical_gap_trusted_toolchain_sha256=${digest}`);
  return digest;
}

function untrackedTopLevelEntries(root: string): string[] {
  return safeGitAt(root, ["status", "--porcelain=v1", "--untracked-files=normal"], false)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).replace(/\/$/, ""));
}

function isAllowedExternalInput(entry: string): boolean {
  return entry === "analysis/node_modules" || entry === "listener/node_modules" || entry === "out";
}

function externalToolchainDigest(root: string, inputs: string[]): string {
  const hash = createHash("sha256");
  for (const relative of inputs) {
    const absolute = path.join(root, relative);
    hash.update(`${relative}\0`);
    if (!fs.existsSync(absolute)) {
      throw new Error(`trusted external toolchain missing ${relative}`);
    }
    hashPath(hash, absolute, "");
  }
  return hash.digest("hex");
}

function pathContentDigest(absolute: string): string {
  const hash = createHash("sha256");
  hashPath(hash, absolute, "");
  return hash.digest("hex");
}

function hashPath(hash: ReturnType<typeof createHash>, absolute: string, relative: string): void {
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    const target = fs.realpathSync(absolute);
    hashPath(hash, target, relative);
    return;
  }
  if (stat.isFile()) {
    hash.update(`file\0${relative}\0${stat.mode & 0o777}\0`);
    hash.update(fs.readFileSync(absolute));
    return;
  }
  if (!stat.isDirectory()) throw new Error(`unsupported trusted toolchain entry: ${absolute}`);
  hash.update(`dir\0${relative}\0`);
  for (const name of fs.readdirSync(absolute).sort()) {
    hashPath(hash, path.join(absolute, name), relative ? `${relative}/${name}` : name);
  }
}

function inputSetDigest(root: string, inputs: string[]): string {
  const hash = createHash("sha256");
  for (const relative of inputs) {
    hash.update(`${relative}\0`);
    hashPath(hash, path.join(root, relative), "");
  }
  return hash.digest("hex");
}

function buildPromotionReceipt(input: {
  record: HistoricalGapRecord;
  track: HistoricalValidationTrack;
  artifactCommit: string;
  reportRepoPath: string;
  reportMd: string;
  trustedToolchainDigest: string;
  validationRoot: string;
  candidateArtifacts: HistoricalPromotionReceipt["candidate_artifacts"];
  familyExecutionArtifacts: HistoricalFamilyExecutionArtifact[];
  familyConformance?: HistoricalFamilyConformanceAttestation;
  replayEnvironment?: ValidatedReplayEnvironment;
  familyReplayEnvironment?: ValidatedFamilyReplayEnvironment;
  smoke?: SmokeResult;
}): HistoricalPromotionReceipt {
  const replay = input.replayEnvironment;
  if (replay && !replay.productionAttestationAfter) {
    throw new Error("promotion receipt requires production universe attestations before and after replay/smoke");
  }
  const familyReplay = input.familyReplayEnvironment;
  if (familyReplay && !familyReplay.rpcAttestationAfter) {
    throw new Error("family replay receipt requires trusted RPC attestations before and after replay");
  }
  return {
    schema_version: 1,
    gate: "historical-gap-gate",
    gap_id: input.record.gap_id,
    branch: input.record.branch,
    track: input.track,
    base_commit: input.record.base_commit,
    challenger_commit: input.record.challenger_commit,
    artifact_commit: input.artifactCommit,
    artifact_report_path: input.reportRepoPath,
    artifact_report_sha256: sha256(input.reportMd),
    record_identity_sha256: historicalRecordIdentitySha256(input.record),
    diff_sha256: input.record.validation.review.diff_sha256,
    branch_audit_sha256: branchAuditSha256(input.record),
    review_artifact: {
      path: input.record.validation.review.artifact,
      sha256: input.record.validation.review.artifact_sha256,
    },
    toolchain_sha256: input.trustedToolchainDigest,
    lockfiles: {
      analysis: sha256(fs.readFileSync(path.join(input.validationRoot, "analysis", "package-lock.json"))),
      listener: sha256(fs.readFileSync(path.join(input.validationRoot, "listener", "package-lock.json"))),
    },
    candidate_artifacts: input.candidateArtifacts,
    family_execution_artifacts: input.familyExecutionArtifacts.length > 0
      ? input.familyExecutionArtifacts
      : undefined,
    family_conformance: input.familyConformance,
    family_replay_environment: familyReplay ? {
      rpc_attestation_before: familyReplay.rpcAttestationBefore,
      rpc_attestation_after: familyReplay.rpcAttestationAfter!,
    } : undefined,
    replay_environment: replay ? {
      universe_sha256: replay.universeSha256,
      provenance_path: replay.provenancePath,
      provenance_sha256: replay.provenanceSha256,
      pool_universe_top_n: replay.poolUniverseTopN,
      production_attestation_before: replay.productionAttestationBefore,
      production_attestation_after: replay.productionAttestationAfter!,
      rpc_attestation_before: replay.rpcAttestationBefore,
      rpc_attestation_after: replay.rpcAttestationAfter!,
    } : undefined,
    smoke: input.smoke ? {
      log_sha256: input.smoke.logSha256,
      duration_seconds: input.smoke.durationSeconds,
      posture_sha256: input.smoke.postureSha256,
    } : undefined,
    created_at: new Date().toISOString(),
    auth_tag: "",
    auth_command_id: "",
  };
}

function promotionReceiptPath(record: Pick<HistoricalGapRecord, "gap_id" | "challenger_commit">): string {
  const safeGap = record.gap_id.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(gitCommonDir, "mev-historical-promotions", `${safeGap}-${record.challenger_commit}.json`);
}

function promotionReceiptDigest(receipt: HistoricalPromotionReceipt): string {
  const { closed_at: _closedAt, merge_commit: _mergeCommit, ...promotion } = receipt;
  return sha256(`${JSON.stringify(promotion)}\n`);
}

function promotionReceiptAuthPayload(receipt: HistoricalPromotionReceipt): string {
  const {
    auth_tag: _authTag,
    auth_command_id: _authCommandId,
    ...promotion
  } = receipt;
  return `${JSON.stringify(promotion)}\n`;
}

async function verifyPromotionReceiptAuth(receipt: HistoricalPromotionReceipt): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(receipt.auth_command_id ?? "")) return false;
  return verifyTrustedReceiptAuth(receipt.auth_tag, promotionReceiptAuthPayload(receipt));
}

async function writePromotionReceipt(receipt: HistoricalPromotionReceipt): Promise<string> {
  const receiptPath = promotionReceiptPath(receipt);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(receiptPath)) {
    const existing = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as HistoricalPromotionReceipt;
    const comparable = (value: HistoricalPromotionReceipt): string => {
      const {
        created_at: _createdAt,
        auth_command_id: _AuthCommandId,
        closed_at: _closedAt,
        merge_commit: _mergeCommit,
        ...rest
      } = value;
      return JSON.stringify(rest);
    };
    const unsignedExisting = { ...existing, auth_tag: "" };
    const unsignedReceipt = { ...receipt, auth_tag: "" };
    if (!await verifyPromotionReceiptAuth(existing)
        || existing.closed_at || comparable(unsignedExisting) !== comparable(unsignedReceipt)) {
      throw new Error(`promotion receipt already exists with different or closed evidence: ${receiptPath}`);
    }
    return promotionReceiptDigest(existing);
  }
  const auth = await requestTrustedReceiptAuth(promotionReceiptAuthPayload(receipt));
  const signed: HistoricalPromotionReceipt = {
    ...receipt,
    auth_tag: auth.authTag,
    auth_command_id: auth.commandId,
  };
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, receiptPath);
  return promotionReceiptDigest(signed);
}

async function readPromotionReceipt(
  record: HistoricalGapRecord,
  validationErrors: string[],
): Promise<HistoricalPromotionReceipt | null> {
  const receiptPath = promotionReceiptPath(record);
  if (!fs.existsSync(receiptPath)) {
    validationErrors.push("close requires the trusted promotion receipt emitted by promote phase");
    return null;
  }
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as HistoricalPromotionReceipt;
    if (!await verifyPromotionReceiptAuth(receipt)
        || receipt.schema_version !== 1 || receipt.gate !== "historical-gap-gate"
        || receipt.gap_id !== record.gap_id || receipt.branch !== record.branch
        || receipt.track !== historicalValidationTrack(record.components)
        || receipt.base_commit !== record.base_commit || receipt.challenger_commit !== record.challenger_commit
        || receipt.artifact_commit !== record.decision.promotion_artifact_commit
        || receipt.diff_sha256 !== record.validation.review.diff_sha256
        || receipt.review_artifact.path !== record.validation.review.artifact
        || receipt.review_artifact.sha256 !== record.validation.review.artifact_sha256
        || receipt.toolchain_sha256 !== record.validation.toolchain_sha256
        || receipt.branch_audit_sha256 !== branchAuditSha256(record)
        || receipt.record_identity_sha256 !== historicalRecordIdentitySha256(record)
        || promotionReceiptDigest(receipt) !== record.decision.promotion_receipt_sha256) {
      validationErrors.push("promotion receipt identity/digest does not match the close report");
    }
    validatePromotionReceiptEvidence(record, receipt, validationErrors);
    return receipt;
  } catch {
    validationErrors.push("trusted promotion receipt is malformed");
    return null;
  }
}

function validatePromotionReceiptEvidence(
  record: HistoricalGapRecord,
  receipt: HistoricalPromotionReceipt,
  validationErrors: string[],
): void {
  const track = historicalValidationTrack(record.components);
  for (const [name, expectedPath] of [
    ["analysis", "analysis/package-lock.json"],
    ["listener", "listener/package-lock.json"],
  ] as const) {
    const source = safeGit(["show", `${record.challenger_commit}:${expectedPath}`], false);
    if (!source || receipt.lockfiles?.[name] !== sha256(source)) {
      validationErrors.push(`promotion receipt ${name} lockfile does not match frozen challenger`);
    }
  }
  if (track === "direct-main") {
    if (receipt.candidate_artifacts.length !== 0
        || receipt.family_execution_artifacts
        || receipt.family_conformance
        || receipt.family_replay_environment
        || receipt.replay_environment
        || receipt.smoke) {
      validationErrors.push("direct-main receipt must not contain searcher replay/smoke evidence");
    }
    return;
  }
  if (track === "family-execution") {
    if (receipt.candidate_artifacts.length !== 0 || receipt.replay_environment || receipt.smoke) {
      validationErrors.push("family execution receipt must not contain production hunt/universe/smoke evidence");
    }
    const artifacts = receipt.family_execution_artifacts ?? [];
    if (artifacts.length !== record.samples.length) {
      validationErrors.push("family execution receipt must bind exactly one replay artifact per sample");
    } else {
      for (const [index, sample] of record.samples.entries()) {
        const artifact = artifacts[index];
        if (!artifact
            || artifact.fixture_path !== sample.adapter_replay_fixture
            || artifact.fixture_sha256 !== sample.adapter_replay_fixture_sha256
            || artifact.evidence_path !== sample.adapter_replay_evidence
            || artifact.evidence_sha256 !== sample.adapter_replay_evidence_sha256
            || artifact.reference_tx !== sample.tx_hash.toLowerCase()
            || typeof artifact.execution_family_id !== "string"
            || !artifact.execution_family_id.trim()
            || !validStoredFamilyBaseline(artifact.baseline, artifact)
            || !validStoredFamilyChallenger(artifact.challenger, artifact)) {
          validationErrors.push(`family execution receipt sample ${index} has invalid or mismatched structured replay evidence`);
        }
      }
    }
    validateStoredFamilyConformance(record, receipt.family_conformance, validationErrors);
    const familyEnvironment = receipt.family_replay_environment;
    if (!familyEnvironment
        || rpcAttestationIdentity(familyEnvironment.rpc_attestation_before)
          !== rpcAttestationIdentity(familyEnvironment.rpc_attestation_after)
        || !storedRpcAttestationMatchesRecord(record, familyEnvironment.rpc_attestation_before)
        || !storedRpcAttestationMatchesRecord(record, familyEnvironment.rpc_attestation_after)) {
      validationErrors.push("family execution receipt trusted RPC attestations are missing or inconsistent");
    }
    return;
  }
  if (track !== "historical-replay") {
    validationErrors.push("only direct-main, family-execution, or historical-replay tracks may produce promotion receipts");
    return;
  }
  if (receipt.family_execution_artifacts || receipt.family_conformance || receipt.family_replay_environment) {
    validationErrors.push("historical replay receipt must not contain family-execution evidence");
  }
  const expectedReports = record.samples.map((sample) => sample.candidate_report).sort();
  const actualReports = receipt.candidate_artifacts.map((artifact) => artifact.report_path).sort();
  if (receipt.candidate_artifacts.length !== record.samples.length
      || new Set(actualReports).size !== actualReports.length
      || JSON.stringify(actualReports) !== JSON.stringify(expectedReports)) {
    validationErrors.push("historical replay receipt must bind exactly one candidate artifact per pinned sample");
  }
  const replay = receipt.replay_environment;
  if (!replay) {
    validationErrors.push("historical replay receipt is missing universe and trusted RPC attestations");
  } else {
    const provenance = safeGit(["show", `origin/main:${replay.provenance_path}`], false);
    try {
      const parsed = JSON.parse(provenance) as HistoricalUniverseProvenance;
      validationErrors.push(...validateHistoricalUniverseBinding(
        record.base_commit,
        record.validation.replay_environment!,
        parsed,
        replay.production_attestation_before,
        replay.universe_sha256,
      ));
      validationErrors.push(...validateHistoricalUniverseBinding(
        record.base_commit,
        record.validation.replay_environment!,
        parsed,
        replay.production_attestation_after,
        replay.universe_sha256,
      ));
    } catch {
      validationErrors.push("historical replay receipt universe provenance is missing or malformed");
    }
    if (rpcAttestationIdentity(replay.rpc_attestation_before)
        !== rpcAttestationIdentity(replay.rpc_attestation_after)
        || !storedRpcAttestationMatchesRecord(record, replay.rpc_attestation_before)
        || !storedRpcAttestationMatchesRecord(record, replay.rpc_attestation_after)) {
      validationErrors.push("historical replay receipt trusted RPC attestations are missing or inconsistent");
    }
  }
  const smoke = receipt.smoke;
  const requestedDuration = record.validation.smoke?.duration_seconds ?? 0;
  const expectedPostureSha = sha256(`${JSON.stringify(trustedSmokePosture())}\n`);
  if (!smoke || !SHA64_RE.test(smoke.log_sha256)
      || smoke.duration_seconds < requestedDuration
      || smoke.duration_seconds < 600
      || smoke.posture_sha256 !== expectedPostureSha) {
    validationErrors.push("historical replay receipt is missing the gate-owned >=10 minute smoke evidence");
  }
}

function validateStoredFamilyConformance(
  record: HistoricalGapRecord,
  attestation: HistoricalFamilyConformanceAttestation | undefined,
  validationErrors: string[],
): void {
  if (!attestation || attestation.schema_version !== 1
      || !Array.isArray(attestation.checks)
      || attestation.checks.length !== FAMILY_CONFORMANCE_SCRIPTS.length) {
    validationErrors.push("family execution receipt is missing the complete conformance/isolation attestation");
    return;
  }
  for (const [index, scriptPath] of FAMILY_CONFORMANCE_SCRIPTS.entries()) {
    const check = attestation.checks[index];
    const source = safeGit(
      ["show", `${record.challenger_commit}:listener/${scriptPath}`],
      false,
    );
    const baselineSource = safeGit(
      ["show", `${record.base_commit}:listener/${scriptPath}`],
      false,
    );
    if (!check
        || check.script_path !== scriptPath
        || !SHA64_RE.test(check.output_sha256 ?? "")
        || !source
        || !baselineSource
        || check.source_sha256 !== sha256(source)
        || check.source_sha256 !== sha256(baselineSource)) {
      validationErrors.push(
        `family execution conformance attestation is invalid for ${scriptPath}`,
      );
    }
  }
}

function validStoredFamilyBaseline(
  side: HistoricalFamilyExecutionSideResult,
  artifact: HistoricalFamilyExecutionArtifact,
): boolean {
  if (!validStoredFamilyProbe(side?.probe, artifact.execution_family_id)
      || !SHA64_RE.test(side?.output_sha256 ?? "")) return false;
  if (side.status === "family_not_registered") {
    return side.probe.registered === false
      && side.replay === null
      && side.failure_fingerprint_sha256 === undefined
      && side.confirmation_replay === undefined
      && side.confirmation_output_sha256 === undefined
      && side.confirmation_failure_fingerprint_sha256 === undefined;
  }
  return side.status === "implemented_not_validated"
    && side.probe.registered === true
    && validStoredFamilyReplay(side.replay, artifact, "implemented_not_validated")
    && side.replay!.stages.chainAnchor === true
    && side.replay!.failureOwnerFamilyId === artifact.execution_family_id
    && side.failure_fingerprint_sha256 === familyReplayFailureFingerprint(side.replay!)
    && validStoredFamilyReplay(side.confirmation_replay ?? null, artifact, "implemented_not_validated")
    && side.confirmation_failure_fingerprint_sha256 === side.failure_fingerprint_sha256
    && side.confirmation_failure_fingerprint_sha256
      === familyReplayFailureFingerprint(side.confirmation_replay!)
    && SHA64_RE.test(side.confirmation_output_sha256 ?? "");
}

function validStoredFamilyChallenger(
  side: HistoricalFamilyExecutionSideResult,
  artifact: HistoricalFamilyExecutionArtifact,
): boolean {
  return side?.status === "adapter_replay_pass"
    && SHA64_RE.test(side.output_sha256 ?? "")
    && validStoredFamilyProbe(side.probe, artifact.execution_family_id)
    && side.probe.registered === true
    && validStoredFamilyReplay(side.replay, artifact, "adapter_replay_pass")
    && side.replay!.failureOwnerFamilyId === null
    && Object.values(side.replay!.stages).every((passed) => passed === true)
    && side.failure_fingerprint_sha256 === undefined
    && side.confirmation_replay === undefined
    && side.confirmation_output_sha256 === undefined
    && side.confirmation_failure_fingerprint_sha256 === undefined;
}

function validStoredFamilyProbe(
  probe: AdapterFamilyRegistryProbe,
  executionFamilyId: string,
): boolean {
  return probe?.schemaVersion === 1
    && probe.executionFamilyId === executionFamilyId
    && typeof probe.registered === "boolean";
}

function validStoredFamilyReplay(
  replay: AdapterFamilyReplayResult | null,
  artifact: HistoricalFamilyExecutionArtifact,
  verdict: AdapterFamilyReplayResult["verdict"],
): boolean {
  return replay?.schemaVersion === 2
    && replay.fixturePath === artifact.fixture_path
    && replay.fixtureSha256 === artifact.fixture_sha256
    && replay.referenceTx.toLowerCase() === artifact.reference_tx
    && replay.landedEvidencePath === artifact.evidence_path
    && replay.landedEvidenceSha256 === artifact.evidence_sha256
    && replay.executionFamilyId === artifact.execution_family_id
    && replay.verdict === verdict
    && Boolean(replay.stages)
    && typeof replay.stages === "object"
    && !Array.isArray(replay.stages)
    && Object.values(replay.stages).length > 0
    && Object.values(replay.stages).every((value) => typeof value === "boolean")
    && validFamilySemanticEvidence(replay)
    && (verdict === "adapter_replay_pass"
      ? replay.failure === null
      : typeof replay.failure === "string" && replay.failure.length > 0);
}

function validFamilySemanticEvidence(
  replay: AdapterFamilyReplayResult,
): boolean {
  const evidence = replay.sixStepEvidence;
  if (!Array.isArray(evidence) || semanticSixStepSequenceError(evidence)) {
    return false;
  }
  if (
    evidence[0]?.status !== "bypassed" ||
    evidence[1]?.status !== "bypassed"
  ) {
    return false;
  }
  if (replay.verdict === "adapter_replay_pass") {
    return evidence.length === 6 &&
      evidence.slice(2).every((stage) => stage.status === "pass");
  }
  const decisive = evidence.at(-1);
  return evidence.length >= 3 &&
    evidence.length <= 6 &&
    decisive !== undefined &&
    (decisive.status === "fail" || decisive.status === "reject");
}

function storedRpcAttestationMatchesRecord(
  record: HistoricalGapRecord,
  attestation: HistoricalRpcAttestation,
): boolean {
  if (!attestation || attestation.schema_version !== 1
      || attestation.kind !== "trusted-reth-sample-identity"
      || attestation.instance_id !== HISTORICAL_PRODUCTION_INSTANCE_ID
      || !validIsoDate(attestation.observed_at)
      || !/^[0-9a-f-]{36}$/i.test(attestation.command_id)
      || !Number.isSafeInteger(attestation.rpc_port) || attestation.rpc_port <= 0 || attestation.rpc_port > 65_535
      || !Number.isSafeInteger(attestation.ws_port) || attestation.ws_port <= 0 || attestation.ws_port > 65_535
      || !/^0x[0-9a-f]+$/i.test(attestation.chain_id ?? "")) return false;
  if (attestation.samples.map((sample) => sample.tx_hash).join(",") !== sampleHashes(record).join(",")) return false;
  return attestation.samples.every((sample) =>
    /^0x[a-f0-9]{64}$/i.test(sample.tx_hash)
    && /^0x[a-f0-9]{64}$/i.test(sample.block_hash)
    && /^0x[a-f0-9]{64}$/i.test(sample.parent_block_hash)
    && /^0x[0-9a-f]+$/i.test(sample.block_number)
    && /^0x[0-9a-f]+$/i.test(sample.transaction_index)
    && /^0x[01]$/i.test(sample.status));
}

async function markPromotionReceiptClosed(
  record: HistoricalGapRecord,
  receipt: HistoricalPromotionReceipt,
): Promise<void> {
  if (receipt.closed_at) {
    if (receipt.merge_commit !== record.decision.merge_commit) {
      throw new Error("closed promotion receipt belongs to a different merge commit");
    }
    return;
  }
  const unsigned: HistoricalPromotionReceipt = {
    ...receipt,
    closed_at: new Date().toISOString(),
    merge_commit: record.decision.merge_commit,
    auth_tag: "",
    auth_command_id: "",
  };
  const auth = await requestTrustedReceiptAuth(promotionReceiptAuthPayload(unsigned));
  const updated: HistoricalPromotionReceipt = {
    ...unsigned,
    auth_tag: auth.authTag,
    auth_command_id: auth.commandId,
  };
  const receiptPath = promotionReceiptPath(record);
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, receiptPath);
  const persisted = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as HistoricalPromotionReceipt;
  if (!await verifyPromotionReceiptAuth(persisted)) {
    throw new Error("closed promotion receipt failed trusted authentication after persistence");
  }
}

async function assertNoOpenPromotionReceipts(): Promise<void> {
  const directory = path.join(gitCommonDir, "mev-historical-promotions");
  if (!fs.existsSync(directory)) return;
  const open: string[] = [];
  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) as HistoricalPromotionReceipt;
      if (!await verifyPromotionReceiptAuth(receipt)) open.push(`unauthenticated:${name}`);
      else if (!receipt.closed_at) open.push(`${receipt.gap_id}@${receipt.challenger_commit}`);
    } catch {
      open.push(`malformed:${name}`);
    }
  }
  if (open.length > 0) {
    throw new Error(`an earlier promoted historical gap is not closed: ${open.join(",")}`);
  }
}

async function runTrustedSmoke(
  record: HistoricalGapRecord,
  challengerRoot: string,
  replayEnvironment: ValidatedReplayEnvironment,
): Promise<SmokeResult> {
  const plan = record.validation.smoke;
  if (!plan) throw new Error("trusted smoke plan missing");
  const planErrors = validateHistoricalSmokePlan(plan);
  if (planErrors.length > 0) throw new Error(planErrors.join("; "));
  const anvilPort = parsePort(requiredArg("--smoke-anvil-port"), "--smoke-anvil-port");
  const blockscanAnvilPort = parsePort(
    requiredArg("--smoke-blockscan-anvil-port"),
    "--smoke-blockscan-anvil-port",
  );
  if (anvilPort === blockscanAnvilPort) throw new Error("smoke Anvil ports must be distinct");
  const rpc = replayEnvironment.rpcUrl;
  const ws = replayEnvironment.wsUrl;
  const botvmAddress = requiredAddressArg("--botvm-address");
  const disposablePrivateKey = `0x${randomBytes(32).toString("hex")}`;
  const smokePosture = trustedSmokePosture();
  const postureSha256 = sha256(`${JSON.stringify(smokePosture)}\n`);

  const safeGap = record.gap_id.replace(/[^A-Za-z0-9._-]/g, "_");
  const runId = `${safeGap}-${process.pid}-${Date.now()}`;
  const logPath = path.join(candidateRuntimeHome, `smoke-${runId}.log`);
  const eventsPath = path.join(candidateRuntimeHome, `smoke-${runId}.jsonl`);
  const sandboxRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(candidateRuntimeHome, `smoke-${runId}-`)),
  );
  const sandboxListener = path.join(sandboxRoot, "listener");
  fs.mkdirSync(sandboxListener, { recursive: true });
  const committedPools = path.join(challengerRoot, "listener", "searcher", "pools");
  if (fs.existsSync(committedPools)) {
    fs.cpSync(committedPools, path.join(sandboxListener, "searcher", "pools"), { recursive: true });
  }
  const log = fs.createWriteStream(logPath, { flags: "wx", mode: 0o600 });
  let output = "";
  const startedAt = Date.now();
  const challengerPackage = path.join(challengerRoot, "listener");
  const child = spawn(SANDBOX_EXEC, [
    "-p",
    candidateSandboxProfile(),
    process.execPath,
    "--import",
    packageModule(challengerPackage, "tsx"),
    path.join(challengerPackage, "src", "searcher", "main.ts"),
  ], {
    cwd: sandboxListener,
    detached: true,
    env: {
      ...candidateCommandEnv(),
      PRIVATE_KEY: disposablePrivateKey,
      BOTVM_ADDRESS: botvmAddress,
      MAINNET_RPC_URL: rpc,
      MAINNET_WS_URL: ws,
      ...smokePosture,
      SEARCHER_RECORD_LIVE_FIXTURES: "0",
      SEARCHER_EAGER_STATE_BACKEND: "0",
      SEARCHER_LIVE_RPC_URL: rpc,
      SEARCHER_LIVE_WS_URL: ws,
      SEARCHER_ANVIL_PORT: String(anvilPort),
      SEARCHER_BLOCKSCAN_ANVIL_PORT: String(blockscanAnvilPort),
      SEARCHER_POOL_UNIVERSE_PATH: replayEnvironment.universe,
      SEARCHER_POOL_UNIVERSE_TOP_N: String(replayEnvironment.poolUniverseTopN),
      SEARCHER_POOL_UNIVERSE_FORCE_INCLUDE: "",
      SEARCHER_EVENTS_PATH: eventsPath,
      SEARCHER_RUNTIME_COMMIT: record.challenger_commit,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk: Buffer | string): void => {
    const value = chunk.toString();
    output += value;
    log.write(value);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  let shutdownRequested = false;
  let exitedUnexpectedly = false;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      if (!shutdownRequested) exitedUnexpectedly = true;
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      append(`trusted smoke spawn error: ${error.message}\n`);
      if (!shutdownRequested) exitedUnexpectedly = true;
      resolve({ code: -1, signal: null });
    });
  });
  const early = await Promise.race([
    exited.then((result) => ({ kind: "exit" as const, result })),
    sleep(plan.duration_seconds * 1000).then(() => ({ kind: "duration" as const })),
  ]);
  const finishedAt = Date.now();
  if (early.kind === "exit") {
    log.end();
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
    throw new Error(`trusted smoke searcher exited early code=${early.result.code} signal=${early.result.signal}; log=${logPath}`);
  }

  if (exitedUnexpectedly || child.exitCode !== null || child.signalCode !== null) {
    log.end();
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
    throw new Error(`trusted smoke searcher exited at the duration boundary before trusted shutdown; log=${logPath}`);
  }
  shutdownRequested = true;
  terminateProcessGroup(child.pid, "SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)]);
  if (!stopped) {
    terminateProcessGroup(child.pid, "SIGKILL");
    await exited;
  }
  if (exitedUnexpectedly) {
    log.end();
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
    throw new Error(`trusted smoke searcher crashed before trusted shutdown; log=${logPath}`);
  }
  await new Promise<void>((resolve, reject) => {
    log.once("error", reject);
    log.end(resolve);
  });

  const actualSeconds = Math.floor((finishedAt - startedAt) / 1000);
  const smokeErrors = validateHistoricalSmokeOutput(
    output,
    actualSeconds,
    plan.duration_seconds,
  );
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
  if (smokeErrors.length > 0) throw new Error(`trusted smoke failed: ${smokeErrors.join("; ")}; log=${logPath}`);
  const digest = sha256(fs.readFileSync(logPath));
  console.log(
    `historical_gap_smoke=PASS mode=trusted-local-dry-run duration_seconds=${actualSeconds} `
      + `dual_lane_posture=configured posture_sha256=${postureSha256} log_sha256=${digest} log=${logPath}`,
  );
  return { logSha256: digest, durationSeconds: actualSeconds, postureSha256 };
}

function trustedSmokePosture(): Record<string, string> {
  return {
    SEARCHER_DRY_RUN: "1",
    SEARCHER_EV_GATE: "1",
    SEARCHER_ENABLE_BACKRUN: "1",
    SEARCHER_ENABLE_MEMPOOL: "1",
    SEARCHER_ENABLE_MEV_SHARE: "0",
    SEARCHER_ENABLE_BLOCK_SCAN: "1",
    SEARCHER_BLOCKSCAN_SUBMIT: "0",
    SEARCHER_ENABLE_PROTOCOL_EDGES: "1",
    SEARCHER_LIVE_BACKEND: "rpc",
  };
}

function requiredAddressArg(name: string): string {
  const value = requiredArg(name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} must be a 20-byte address`);
  return value;
}

function parsePort(value: string, label: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) throw new Error(`${label} must be 1024..65535`);
  return port;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have exited between the duration timer and shutdown.
    }
  }
}

function validateClose(
  record: HistoricalGapRecord,
  localReportPath: string,
  localReport: string,
  receipt: HistoricalPromotionReceipt,
  validationErrors: string[],
): void {
  const merge = record.decision.merge_commit!;
  const parents = safeGit(["rev-list", "--parents", "-n", "1", merge]).split(/\s+/);
  if (parents.length !== 3 || parents[1] !== record.base_commit || parents[2] !== record.challenger_commit) {
    validationErrors.push("merge_commit must be the exact no-ff merge of tested base and frozen challenger");
  }
  validationErrors.push(...validateHistoricalMergeTree(
    safeGit(["rev-parse", `${merge}^{tree}`]),
    safeGit(["rev-parse", `${record.challenger_commit}^{tree}`]),
  ));
  if (!gitSucceeds(["merge-base", "--is-ancestor", merge, "origin/main"])) {
    validationErrors.push("merge_commit is not on origin/main");
  }
  const reportRelative = path.relative(repoRoot, localReportPath).split(path.sep).join("/");
  if (reportRelative.startsWith("../") || !reportRelative.startsWith("docs/research/reports/")) {
    validationErrors.push("close report must live under docs/research/reports");
  } else {
    const committed = safeGit(["show", `origin/main:${reportRelative}`], false);
    if (committed !== localReport) validationErrors.push("origin/main report does not exactly match the close artifact");
  }
  if (receipt.artifact_report_path !== reportRelative) {
    validationErrors.push("close report path differs from the promoted report artifact path");
  }
  if (!gitSucceeds(["cat-file", "-e", `${receipt.artifact_commit}^{commit}`])
      || !gitSucceeds(["merge-base", "--is-ancestor", record.challenger_commit, receipt.artifact_commit])) {
    validationErrors.push("promotion artifact commit is unavailable or does not descend from challenger");
  } else {
    const promotedReport = safeGit(["show", `${receipt.artifact_commit}:${receipt.artifact_report_path}`], false);
    if (!promotedReport || sha256(promotedReport) !== receipt.artifact_report_sha256) {
      validationErrors.push("promotion report artifact no longer matches the trusted receipt");
    }
  }
  requireArchivedArtifact(receipt.review_artifact.path, receipt.review_artifact.sha256, validationErrors);
  for (const artifact of receipt.candidate_artifacts) {
    requireArchivedArtifact(artifact.report_path, artifact.report_sha256, validationErrors);
    requireArchivedArtifact(artifact.manifest_path, artifact.manifest_sha256, validationErrors);
  }
  for (const artifact of receipt.family_execution_artifacts ?? []) {
    requireArchivedArtifact(artifact.fixture_path, artifact.fixture_sha256, validationErrors);
    requireArchivedArtifact(artifact.evidence_path, artifact.evidence_sha256, validationErrors);
  }
  if (receipt.replay_environment) {
    requireArchivedArtifact(
      receipt.replay_environment.provenance_path,
      receipt.replay_environment.provenance_sha256,
      validationErrors,
    );
  }
  if (receipt.closed_at && receipt.merge_commit !== record.decision.merge_commit) {
    validationErrors.push("promotion receipt was closed by a different merge commit");
  }
  if (safeGit(["rev-parse", `refs/heads/${record.branch}`])) validationErrors.push("local branch still exists");
  if (originBranchCommit(record.branch)) validationErrors.push("origin branch still exists");
  for (const worktree of worktreeInventory()) {
    const descendantOutsideMain = gitSucceeds([
      "merge-base", "--is-ancestor", record.challenger_commit, worktree.head,
    ])
      && !gitSucceeds(["merge-base", "--is-ancestor", worktree.head, "origin/main"]);
    if (isHistoricalCandidateWorktree(
      worktree,
      record.branch,
      record.challenger_commit,
      receipt.artifact_commit,
      descendantOutsideMain,
    )) {
      validationErrors.push(`candidate worktree still exists: ${worktree.path}`);
    }
  }
}

function requireArchivedArtifact(pathValue: string, expectedSha256: string, validationErrors: string[]): void {
  const artifactPath = safeRelative(pathValue, "archived promotion artifact");
  if (!artifactPath.startsWith("docs/research/reports/")) {
    validationErrors.push(`promotion artifact must be archived under docs/research/reports: ${artifactPath}`);
    return;
  }
  const source = safeGit(["show", `origin/main:${artifactPath}`], false);
  if (!source || sha256(source) !== expectedSha256) {
    validationErrors.push(`origin/main is missing the byte-identical promotion artifact ${artifactPath}`);
  }
}

function run(command: string, commandArgs: string[], cwd: string, label: string): void {
  const result = spawnSync(SANDBOX_EXEC, ["-p", candidateSandboxProfile(), command, ...commandArgs], {
    cwd,
    env: candidateCommandEnv(),
    stdio: "inherit",
    timeout: 30 * 60 * 1000,
  });
  if (result.error) throw new Error(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} exited ${result.status ?? "signal"}`);
}

function trustedCommandEnv(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const allowed = new Set([
    "HOME", "LANG", "LC_ALL", "LOGNAME", "NO_COLOR", "PATH", "SHELL", "SSH_AUTH_SOCK",
    "TEMP", "TERM", "TMP", "TMPDIR", "USER",
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed.has(key)) environment[key] = value;
  }
  environment.NO_COLOR = "1";
  return environment;
}

function candidateCommandEnv(): NodeJS.ProcessEnv {
  const environment = trustedCommandEnv();
  environment.HOME = candidateRuntimeHome;
  environment.TMPDIR = candidateRuntimeHome;
  environment.TMP = candidateRuntimeHome;
  environment.TEMP = candidateRuntimeHome;
  environment.XDG_CACHE_HOME = path.join(candidateRuntimeHome, ".cache");
  environment.NPM_CONFIG_CACHE = path.join(candidateRuntimeHome, ".npm-cache");
  environment.FOUNDRY_CACHE_PATH = path.join(candidateRuntimeHome, ".foundry-cache");
  environment.MEV_GATE_TMPDIR = candidateRuntimeHome;
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.DEVELOPER_DIR = "/Library/Developer/CommandLineTools";
  environment.OPENSSL_CONF = "/dev/null";
  environment.PATH = candidateExecutablePath();
  delete environment.SSH_AUTH_SOCK;
  return environment;
}

function candidateExecutablePath(): string {
  const nodeBin = path.dirname(fs.realpathSync(process.execPath));
  const foundry = path.join(os.homedir(), ".foundry", "bin");
  return [
    nodeBin, "/Library/Developer/CommandLineTools/usr/bin",
    "/usr/bin", "/bin", "/usr/sbin", "/sbin", foundry,
  ]
    .filter((entry, index, entries) => fs.existsSync(entry) && entries.indexOf(entry) === index)
    .join(":");
}

function candidateSandboxProfile(): string {
  if (!fs.existsSync(SANDBOX_EXEC)) {
    throw new Error("historical candidate sandbox requires /usr/bin/sandbox-exec");
  }
  const allowedReadSubpaths = [
    candidateSandboxHome,
    path.join(sharedToolchainRoot, "analysis", "node_modules"),
    path.join(sharedToolchainRoot, "listener", "node_modules"),
    "/System",
    "/usr/bin",
    "/usr/lib",
    "/usr/libexec",
    "/usr/sbin",
    "/usr/share",
    "/bin",
    "/sbin",
    "/Library/Developer/CommandLineTools",
    ...candidateNodeRuntimeReadSubpaths(),
  ].filter((entry) => fs.existsSync(entry));
  const allowedReadLiterals = [
    "/",
    path.join(sharedToolchainRoot, "out", "BotVM.sol", "BotVM.json"),
    "/private/var/db/timezone/zoneinfo/Asia/Shanghai",
    "/dev/null",
    "/dev/urandom",
    "/dev/random",
    "/dev/zero",
    ...["anvil", "cast", "forge"].map((name) => path.join(os.homedir(), ".foundry", "bin", name)),
  ].filter((entry) => fs.existsSync(entry));
  const readDeny = `(deny file-read-data (require-all `
    + allowedReadSubpaths.map((entry) => `(require-not (subpath ${sandboxString(entry)}))`).join(" ")
    + " "
    + allowedReadLiterals.map((entry) => `(require-not (literal ${sandboxString(entry)}))`).join(" ")
    + "))";
  return [
    "(version 1)",
    "(allow default)",
    '(deny network-outbound (require-not (remote ip "localhost:*")))',
    `(deny file-write* (require-all `
      + [candidateRuntimeHome, ...candidateWritableRoots]
        .map((entry) => `(require-not (subpath ${sandboxString(entry)}))`).join(" ")
      + ' (require-not (literal "/dev/null"))))',
    ...[...candidateReadOnlyRoots]
      .map((entry) => `(deny file-write* (subpath ${sandboxString(entry)}))`),
    readDeny,
    '(deny mach-lookup (global-name "com.apple.SecurityServer"))',
    '(deny mach-lookup (global-name "com.apple.securityd"))',
    '(deny mach-lookup (global-name "com.apple.securityd.xpc"))',
    '(deny mach-lookup (global-name "com.apple.securityd.general"))',
  ].join("\n");
}

function candidateNodeRuntimeReadSubpaths(): string[] {
  const nodeExecutable = fs.realpathSync(process.execPath);
  const nodePrefix = path.dirname(path.dirname(nodeExecutable));
  const paths = new Set<string>([nodePrefix]);
  const npmExecutable = path.join(path.dirname(nodeExecutable), "npm");
  if (fs.existsSync(npmExecutable)) {
    const npmCli = fs.realpathSync(npmExecutable);
    paths.add(path.resolve(path.dirname(npmCli), ".."));
  }
  const pending = [nodeExecutable];
  const inspected = new Set<string>();
  while (pending.length > 0) {
    const executable = pending.pop()!;
    if (inspected.has(executable)) continue;
    inspected.add(executable);
    const linked = execFileSync("/usr/bin/otool", ["-L", executable], {
      encoding: "utf8",
      env: trustedCommandEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of linked.split(/\r?\n/).slice(1)) {
      const dependency = line.trim().split(/\s+/)[0] ?? "";
      if (!dependency.startsWith("/opt/homebrew/") || !fs.existsSync(dependency)) continue;
      const realDependency = fs.realpathSync(dependency);
      paths.add(path.dirname(realDependency));
      pending.push(realDependency);
    }
  }
  return [...paths];
}

function sandboxString(value: string): string {
  return JSON.stringify(value);
}

function safeRelative(value: string, label: string): string {
  if (!value || path.isAbsolute(value)) throw new Error(`${label} must be repository-relative`);
  const normalized = path.normalize(value).split(path.sep).join("/");
  if (normalized === ".." || normalized.startsWith("../")) throw new Error(`${label} escapes the repository`);
  return normalized;
}

function safeGit(gitArgs: string[], trim = true): string {
  return safeGitAt(repoRoot, gitArgs, trim);
}

function safeGitAt(cwd: string, gitArgs: string[], trim = true): string {
  try {
    const output = execFileSync("git", ["-C", cwd, ...gitArgs], {
      encoding: "utf8",
      env: trustedCommandEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    return trim ? output.trim() : output;
  } catch {
    return "";
  }
}
