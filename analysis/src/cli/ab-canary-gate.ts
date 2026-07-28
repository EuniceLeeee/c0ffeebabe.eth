#!/usr/bin/env node
import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import {
  parseAbExperiment,
  parseAbSixStepDiagnostics,
  readAbLocalReportArtifact,
  resolveAbReportArtifactPath,
  sixStepDiagnosticsError,
  sixStepEquivalenceError,
  validateAbExperiment,
  validateAbDeploymentBinding,
  validateAbProductionCandidate,
  type AbExperiment,
  type AbSixStepDiagnostic,
  type ManualVerdictArtifact,
} from "../ab-canary.js";
import {
  verifyOnchainProductionSample,
  validateExactProductionSwapPath,
  type ProductionRouteStep,
  type ProductionSampleObservation,
} from "../ab-production-evidence.js";
import {
  validateBackrunCausalReplay,
  type BackrunCausalReplayResult,
} from "../backrun-causal-replay.js";
import {
  isStrictPositiveBackrunEv,
  type BackrunEvEvidence,
} from "../backrun-ev-evidence.js";
import {
  discoverToolIndex,
  PRODUCTION_CANDIDATE_CAPABILITIES,
  PRODUCTION_DECISION_CAPABILITIES,
  validateRecordedToolSelection,
  validateToolIndex,
  type ToolExecutionManifest,
} from "../tool-index.js";

const CLOSED_LOOP_EQUIVALENCE_LIMITS = Object.freeze({
  maxPools: 20_000,
  maxCandidates: 300,
  refineCandidates: 512,
  scanBudgetMs: 600_000,
  passBudgetMs: 1_200_000,
  childTimeoutSeconds: 3_600,
});
const FORMAL_BLOCKSCAN_HUNT_INHERITED_ENV_PREFIXES = Object.freeze([
  "HUNT_",
  "AB_EXPECTED_",
  "POOL_UNIVERSE_",
  "SEARCHER_POOL_UNIVERSE_",
  "SEARCHER_BLOCKSCAN_STATE_",
  "SEARCHER_BLOCKSCAN_HUNT_ANVIL_",
  "SEARCHER_PROTOCOL_DISCOVERY_",
  "PRODUCTION_REPLAY_DISCOVERY_ARTIFACT",
] as const);

const args = process.argv.slice(2);
const report = args[0];
const gateTmpRoot = process.env.MEV_GATE_TMPDIR || "/tmp";
if (!path.isAbsolute(gateTmpRoot)) throw new Error("MEV_GATE_TMPDIR must be absolute");
const phaseIndex = args.indexOf("--phase");
const phase = phaseIndex >= 0 ? args[phaseIndex + 1] : "decision";
const isAcceptancePhase = phase === "acceptance" || phase === "candidate";
if (!report || (!isAcceptancePhase && phase !== "binding" && phase !== "decision" && phase !== "close")) {
  throw new Error(
    "usage: ab-canary-gate <report.md> --phase binding|acceptance|candidate|decision|close [identity args]",
  );
}
const md = fs.readFileSync(report, "utf8");
const experiment = parseAbExperiment(md);
const candidateContext = (isAcceptancePhase || phase === "binding") ? {
  experimentId: requiredArg("--expected-experiment"),
  branch: requiredArg("--expected-branch"),
  baseCommit: requiredArg("--expected-base"),
  challengerCommit: requiredArg("--expected-challenger"),
  expectedRuntimeViewDelta: requiredArg("--expected-runtime-view-delta") === "1",
  inputMode: requiredArg("--expected-input-mode") as "shared" | "challenger",
  allowedConfigDelta: csvArg("--expected-config-delta"),
  laneMode: requiredArg("--expected-lane-mode") as "blockscan-only" | "dual",
  shakedown: args.includes("--shakedown"),
  ...(isAcceptancePhase
    ? { requireStageAdvance: binaryArg("--require-stage-advance", true) }
    : {}),
} : undefined;
const errors = phase === "binding"
  ? validateAbDeploymentBinding(experiment, candidateContext)
  : isAcceptancePhase
    ? validateAbProductionCandidate(experiment, candidateContext)
    : validateAbExperiment(experiment, report, phase);
let onchainObservation: ProductionSampleObservation | undefined;
if (phase !== "binding" && experiment.schema_version === 3 && errors.length === 0) {
  const repoRoot = gitOutput(["rev-parse", "--show-toplevel"]);
  if (experiment.infrastructure_shakedown !== true) {
    const tools = discoverToolIndex(repoRoot);
    errors.push(...validateToolIndex(repoRoot, tools));
    let executionManifest: ToolExecutionManifest | undefined;
    try {
      const manifestSource = readReportArtifact(repoRoot, experiment.analysis.tool_selection?.evidence_manifest ?? "", "tool execution manifest");
      const manifestHash = createHash("sha256").update(manifestSource).digest("hex");
      if (manifestHash !== experiment.analysis.tool_selection?.evidence_manifest_sha256) {
        errors.push("tool execution manifest SHA-256 does not match the A/B journal");
      }
      executionManifest = JSON.parse(manifestSource.toString("utf8")) as ToolExecutionManifest;
    } catch (error) {
      errors.push(`tool execution manifest validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    errors.push(...validateRecordedToolSelection(
      experiment.analysis.tool_selection,
      tools,
      isAcceptancePhase ? PRODUCTION_CANDIDATE_CAPABILITIES : PRODUCTION_DECISION_CAPABILITIES,
      executionManifest,
      isAcceptancePhase ? undefined : {
        from: experiment.window.measured_from_block!,
        to: experiment.window.measured_to_block!,
      },
    ));
  }
  if (!isAcceptancePhase && errors.length === 0) {
    errors.push(...validateAnalysisArtifacts(repoRoot));
  }
}
if (isAcceptancePhase && errors.length === 0 && !candidateContext?.shakedown) {
  const onchain = await verifyOnchainProductionSample(
    experiment,
    requiredArg("--rpc"),
    candidateUniverseArg("challenger"),
  );
  errors.push(...onchain.errors);
  onchainObservation = onchain.observation;
  if (onchain.observation) {
    console.log(`candidate_onchain=${JSON.stringify(onchain.observation)}`);
  }
}
if (isAcceptancePhase && errors.length === 0 && !candidateContext?.shakedown) {
  runCandidateReplay(onchainObservation!);
}
if (errors.length > 0) {
  for (const error of errors) console.error(`FAIL: ${error}`);
  process.exit(1);
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredArg(name: string): string {
  const value = option(name);
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${name} is required for acceptance/candidate phase`);
  }
  return value;
}

function candidateUniverseArg(role: "baseline" | "challenger"): string {
  const roleSpecific = option(`--${role}-universe`);
  const shared = option("--universe");
  const value = roleSpecific ?? shared;
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`--${role}-universe or --universe is required for acceptance/candidate phase`);
  }
  return value;
}

function csvArg(name: string): string[] {
  const value = option(name);
  if (value === undefined) throw new Error(`${name} is required for acceptance/candidate phase`);
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function binaryArg(name: string, defaultValue: boolean): boolean {
  const value = option(name);
  if (value === undefined) return defaultValue;
  if (value === "1") return true;
  if (value === "0") return false;
  throw new Error(`${name} must be 0|1`);
}

function reportArtifactRelative(repoRoot: string, artifact: string, label: string): string {
  const reportRelative = option("--report-repo-path") ?? path.relative(repoRoot, path.resolve(report!));
  return resolveAbReportArtifactPath(reportRelative, artifact, label);
}

function readReportArtifact(repoRoot: string, artifact: string, label: string): Buffer {
  const relative = reportArtifactRelative(repoRoot, artifact, label);
  const artifactRef = option("--artifact-ref");
  if (artifactRef) {
    return execFileSync("git", ["show", `${artifactRef}:${relative}`], { cwd: repoRoot });
  }
  return readAbLocalReportArtifact(repoRoot, relative);
}

function validateAnalysisArtifacts(repoRoot: string): string[] {
  const artifactErrors: string[] = [];
  try {
    const manualSource = readReportArtifact(repoRoot, experiment.analysis.agent_manual_artifact ?? "", "agent_manual_artifact");
    const manual = JSON.parse(manualSource.toString("utf8")) as ManualVerdictArtifact;
    const compare = JSON.parse(readReportArtifact(repoRoot, experiment.analysis.script_artifact ?? "", "script_artifact").toString("utf8")) as Record<string, unknown>;
    const manualHash = createHash("sha256").update(manualSource).digest("hex");
    if (manual.schema_version !== 2 || manual.experiment_id !== experiment.experiment_id
        || manual.author !== experiment.analysis.agent_manual_author
        || manual.verdict !== experiment.analysis.agent_manual_verdict
        || manual.evidence !== experiment.analysis.agent_manual_evidence
        || manual.written_at !== experiment.analysis.agent_manual_written_at) {
      artifactErrors.push("manual verdict artifact does not exactly match the A/B journal");
    }
    if (manualHash !== experiment.analysis.agent_manual_artifact_sha256) {
      artifactErrors.push("manual verdict artifact hash does not match the A/B journal");
    }
    if (compare.manual_verdict_sha256 !== manualHash
        || compare.manual_verdict_written_at !== manual.written_at
        || compare.comparator_started_at !== experiment.analysis.comparator_started_at
        || compare.manual_seal_nonce !== manual.seal_nonce
        || compare.a_log_sha256 !== manual.a_log_sha256
        || compare.b_log_sha256 !== manual.b_log_sha256) {
      artifactErrors.push("comparison artifact is not cryptographically bound to the earlier manual verdict");
    }
    if (compare.script_assessment !== experiment.analysis.script_assessment) {
      artifactErrors.push("comparison artifact assessment does not match the A/B journal");
    }
  } catch (error) {
    artifactErrors.push(`analysis artifact validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return artifactErrors;
}

interface HuntResult {
  schema_version: number;
  fork_block: number;
  stage: string;
  expected_pool_ids: string[];
  matched_pool_ids: string[];
  has_protocol_edge: boolean;
  closed_route: boolean;
  final_sim_success: boolean;
  net_profit_raw: string | null;
}

/**
 * Block-scan emits the semantic schema. Backrun remains the legacy shape until
 * its trigger/full-prefix envelope can be represented without pretending that
 * the old fourth, fifth, and sixth slots are plan/sim/EV.
 */
type SixStepDiagnostic = AbSixStepDiagnostic;

type ProductionEvidence = NonNullable<AbExperiment["production_evidence"]>;
type ProductionSample = NonNullable<ProductionEvidence["sample"]>;
type AcceptanceEvidence = ProductionEvidence & {
  sample: ProductionSample;
  classification_review: NonNullable<ProductionEvidence["classification_review"]>;
  baseline_stage: NonNullable<ProductionEvidence["baseline_stage"]>;
  challenger_stage: NonNullable<ProductionEvidence["challenger_stage"]>;
  replay: NonNullable<ProductionEvidence["replay"]>;
};

function acceptanceEvidence(): AcceptanceEvidence {
  const evidence = experiment.production_evidence;
  if (!evidence?.sample || !evidence.classification_review
      || !evidence.baseline_stage || !evidence.challenger_stage || !evidence.replay) {
    throw new Error("six-step acceptance requires complete sample/classification/stage/replay evidence");
  }
  return evidence as AcceptanceEvidence;
}

interface BlockscanHuntResult extends HuntResult {
  expected_swap_path: Array<{ pool_id: string; direction: "0for1" | "1for0" }>;
  matched_swap_path: Array<{ pool_id: string; direction: "0for1" | "1for0" }>;
  expected_route: ProductionRouteStep[];
  matched_route: ProductionRouteStep[];
  six_step_diagnostics?: SixStepDiagnostic[];
}

interface BlockscanHuntRun {
  result: BlockscanHuntResult | null;
  diagnostics: SixStepDiagnostic[];
}

interface BackrunHuntResult extends HuntResult, BackrunCausalReplayResult {
  winner_tx_hash: string;
  winner_transaction_index: number;
  victim_tx_hash: string;
  pre_gross_raw: string | null;
  post_gross_raw: string | null;
  pre_execution_success: boolean | null;
  pre_execution_net_raw: string | null;
  post_execution_success: boolean | null;
  post_execution_net_raw: string | null;
  pre_execution_block: number | null;
  pre_execution_index: number | null;
  post_execution_block: number | null;
  post_execution_index: number | null;
  pre_state_anchor_kind: "parent-block" | "previous-tx";
  pre_state_anchor_hash: string | null;
  post_state_anchor_kind: "victim-tx";
  post_state_anchor_hash: string;
  victim_effect_kind: "swap" | "oracle" | null;
  expected_route: ProductionRouteStep[];
  matched_route: ProductionRouteStep[];
  oracle_route_edge_index: number | null;
  oracle_probe_amount_in_raw: string | null;
  oracle_before_amount_out_raw: string | null;
  oracle_after_amount_out_raw: string | null;
  trigger_route_signature: string | null;
  full_prefix_route_signature: string | null;
  full_prefix_gross_raw: string | null;
  full_prefix_execution_success: boolean | null;
  full_prefix_execution_net_raw: string | null;
  full_prefix_execution_block: number | null;
  full_prefix_execution_index: number | null;
  trigger_ev_bucket: "positive" | "non_positive" | "unverified";
  full_prefix_ev_bucket: "positive" | "non_positive" | "unverified";
  trigger_ev: BackrunEvEvidence | null;
  full_prefix_ev: BackrunEvEvidence | null;
  full_vs_trigger: "match" | "diverge" | "unverified";
  causal_replay_error: string | null;
}

function runCandidateReplay(observation: ProductionSampleObservation): void {
  const evidence = acceptanceEvidence();
  if (candidateContext?.requireStageAdvance === false
      && evidence.strategy_kind === "block-scan"
      && evidence.baseline_stage === "final_sim_success"
      && evidence.challenger_stage === "final_sim_success") {
    runEquivalenceResolutionReplayPair(observation);
    return;
  }
  if (evidence.strategy_kind === "backrun") {
    runBackrunCandidateReplay(observation);
    return;
  }
  const replay = evidence.replay;
  if (JSON.stringify(replay.argv)
      !== JSON.stringify(["node", "--import", "tsx", "src/searcher/test/blockscan-hunt.ts"])
      || replay.cwd !== "listener") {
    throw new Error("candidate replay must use the trusted direct-node blockscan-hunt harness");
  }
  const baseRoot = fs.realpathSync(requiredArg("--base-root"));
  const challengerRoot = fs.realpathSync(requiredArg("--challenger-root"));
  const sample = evidence.sample;
  const baselineUniverse = fs.realpathSync(candidateUniverseArg("baseline"));
  const challengerUniverse = fs.realpathSync(candidateUniverseArg("challenger"));
  const expectedPools = observation.arb_pools.map((pool) => pool.toLowerCase()).sort();
  const expectedSwapPath = observation.arb_swap_path.map((step) => ({
    pool_id: step.pool_id.toLowerCase(),
    direction: step.direction,
  }));
  const expectedRoute = normalizeProductionRoute(sample.expected_route ?? []);
  const maxPools = Number(requiredArg("--pool-universe-top-n"));
  if (!Number.isSafeInteger(maxPools) || maxPools <= 0) throw new Error("--pool-universe-top-n must be a positive integer");
  const baseline = runHunt(
    "baseline", baseRoot, 8568, baselineUniverse, sample.block_number - 1,
    expectedPools, expectedSwapPath, expectedRoute, maxPools,
  );
  const challenger = runHunt(
    "challenger", challengerRoot, 8569, challengerUniverse, sample.block_number - 1,
    expectedPools, expectedSwapPath, expectedRoute, maxPools,
  );
  validateHuntRun(
    "baseline", baseline, evidence.baseline_stage,
    sample.block_number - 1, expectedPools, expectedSwapPath, expectedRoute,
  );
  validateHuntRun(
    "challenger", challenger, evidence.challenger_stage,
    sample.block_number - 1, expectedPools, expectedSwapPath, expectedRoute,
  );
  if (isAcceptancePhase) {
    const baselineDiagnostics = baseline.diagnostics;
    const challengerDiagnostics = challenger.diagnostics;
    emitSixStepDiagnostics("baseline", baselineDiagnostics);
    emitSixStepDiagnostics("challenger", challengerDiagnostics);
  }
  console.log(`candidate_replay=pass baseline=${JSON.stringify(baseline)} challenger=${JSON.stringify(challenger)}`);
}

function runEquivalenceResolutionReplayPair(observation: ProductionSampleObservation): void {
  const evidence = acceptanceEvidence();
  const baselineUniverse = fs.realpathSync(candidateUniverseArg("baseline"));
  const challengerUniverse = fs.realpathSync(candidateUniverseArg("challenger"));
  if (candidateContext?.inputMode === "shared"
      && sha256File(baselineUniverse) !== sha256File(challengerUniverse)) {
    throw new Error("shared equivalence replay universes must be byte-identical");
  }
  const baseline = runDeclaredResolutionReplay(
    "baseline",
    fs.realpathSync(requiredArg("--base-root")),
    baselineUniverse,
  );
  const challenger = runDeclaredResolutionReplay(
    "challenger",
    fs.realpathSync(requiredArg("--challenger-root")),
    challengerUniverse,
  );
  const sample = evidence.sample;
  const expectedPools = observation.arb_pools.map((pool) => pool.toLowerCase()).sort();
  const expectedSwapPath = observation.arb_swap_path.map((step) => ({
    pool_id: step.pool_id.toLowerCase(),
    direction: step.direction,
  }));
  const expectedRoute = normalizeProductionRoute(sample.expected_route ?? []);
  validateHuntResult(
    "baseline resolution replay", baseline.result, "final_sim_success",
    sample.block_number - 1, expectedPools, expectedSwapPath, expectedRoute,
  );
  validateHuntResult(
    "challenger resolution replay", challenger.result, "final_sim_success",
    sample.block_number - 1, expectedPools, expectedSwapPath, expectedRoute,
  );
  if (baseline.machine !== challenger.machine) {
    throw new Error("equivalence resolution replay machine results differ between baseline and challenger");
  }
  if (isAcceptancePhase) {
    const equivalenceError = sixStepEquivalenceError(baseline.diagnostics, challenger.diagnostics);
    if (equivalenceError) throw new Error(`resolution replay ${equivalenceError}`);
    emitSixStepDiagnostics("baseline", baseline.diagnostics);
    emitSixStepDiagnostics("challenger", challenger.diagnostics);
  }
  console.log(`candidate_resolution_replay=pass machine=${baseline.machine}`);
}

function runDeclaredResolutionReplay(
  label: string,
  root: string,
  universe: string,
): { machine: string; result: BlockscanHuntResult; diagnostics: SixStepDiagnostic[] } {
  const replay = experiment.resolution_replay!;
  if (replay.cwd !== "listener"
      || JSON.stringify(replay.argv)
        !== JSON.stringify(["npm", "run", "searcher:blockscan-hunt-tx149"])) {
    throw new Error("equivalence candidate must use the trusted tx149 resolution replay");
  }
  if ((replay.timeout_seconds ?? 0) < CLOSED_LOOP_EQUIVALENCE_LIMITS.childTimeoutSeconds) {
    throw new Error("equivalence resolution replay must declare timeout_seconds=3600");
  }
  const replayCwd = fs.realpathSync(path.resolve(root, replay.cwd));
  if (replayCwd !== root && !replayCwd.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} resolution replay cwd escapes the frozen runtime root`);
  }
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("HUNT_") || key.startsWith("POOL_UNIVERSE_") || key.startsWith("AB_EXPECTED_")) {
      delete childEnv[key];
    }
  }
  delete childEnv.NODE_OPTIONS;
  delete childEnv.npm_config_script_shell;
  delete childEnv.NPM_CONFIG_SCRIPT_SHELL;
  delete childEnv.TX149_REPLAY_RPC_URL;
  childEnv.SEARCHER_LIVE_RPC_URL = requiredArg("--rpc");
  childEnv.MAINNET_RPC_URL = requiredArg("--rpc");
  const trustedRoot = fs.realpathSync(gitOutput(["rev-parse", "--show-toplevel"]));
  const trustedListener = fs.realpathSync(path.join(trustedRoot, "listener"));
  const diagnosticArgs = isAcceptancePhase
    ? [
        "--diagnostic-max-candidates", String(CLOSED_LOOP_EQUIVALENCE_LIMITS.maxCandidates),
        "--diagnostic-scan-budget-ms", String(CLOSED_LOOP_EQUIVALENCE_LIMITS.scanBudgetMs),
        "--diagnostic-pass-budget-ms", String(CLOSED_LOOP_EQUIVALENCE_LIMITS.passBudgetMs),
      ]
    : [];
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "src/searcher/test/blockscan-hunt-tx149.ts",
    "--runtime-listener-root", replayCwd,
    "--universe-path", universe,
    "--hunt-max-pools", String(CLOSED_LOOP_EQUIVALENCE_LIMITS.maxPools),
    "--hunt-max-candidates", String(CLOSED_LOOP_EQUIVALENCE_LIMITS.maxCandidates),
    "--hunt-refine-candidates", String(CLOSED_LOOP_EQUIVALENCE_LIMITS.refineCandidates),
    "--hunt-scan-budget-ms", String(CLOSED_LOOP_EQUIVALENCE_LIMITS.scanBudgetMs),
    "--hunt-pass-budget-ms", String(CLOSED_LOOP_EQUIVALENCE_LIMITS.passBudgetMs),
    ...diagnosticArgs,
  ], {
    cwd: trustedListener,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: replay.timeout_seconds! * 1_000,
    maxBuffer: 32 * 1024 * 1024,
    env: childEnv,
  });
  if (result.error) {
    throw new Error(`${label} resolution replay failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-4_000);
    throw new Error(`${label} resolution replay exited ${result.status ?? "signal"}: ${output}`);
  }
  const machine = String(result.stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("TX149_RESOLUTION_RESULT="));
  if (machine.length !== 1) {
    throw new Error(`${label} resolution replay must emit exactly one TX149 machine result`);
  }
  let parsed: BlockscanHuntResult;
  try {
    parsed = JSON.parse(machine[0].slice("TX149_RESOLUTION_RESULT=".length)) as BlockscanHuntResult;
  } catch (error) {
    throw new Error(
      `${label} resolution replay machine result is invalid JSON: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    machine: machine[0],
    result: parsed,
    diagnostics: parseSixStepDiagnostics(String(result.stdout ?? ""), label),
  };
}

function parseSixStepDiagnostics(output: string, label: string): SixStepDiagnostic[] {
  try {
    return parseAbSixStepDiagnostics(output);
  } catch (error) {
    throw new Error(
      `${label} emitted invalid six-step evidence: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function requireSixStepPass(label: string, diagnostics: SixStepDiagnostic[]): void {
  const error = sixStepDiagnosticsError(diagnostics, "final_sim_success");
  if (error) throw new Error(`${label} ${error}`);
}

function requireStageDiagnostics(label: string, diagnostics: SixStepDiagnostic[], expectedStage: string): void {
  if (expectedStage !== "not_admitted" && expectedStage !== "path_found"
      && expectedStage !== "final_sim_success") {
    throw new Error(`${label} has unsupported declared stage ${expectedStage}`);
  }
  const error = sixStepDiagnosticsError(diagnostics, expectedStage);
  if (error) throw new Error(`${label} ${error}`);
}

function emitSixStepDiagnostics(label: string, diagnostics: SixStepDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    console.log(`SIX_STEP_ACCEPTANCE=${JSON.stringify({ role: label, ...diagnostic })}`);
  }
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function runBackrunCandidateReplay(observation: ProductionSampleObservation): void {
  const evidence = acceptanceEvidence();
  const replay = evidence.replay;
  if (JSON.stringify(replay.argv)
      !== JSON.stringify(["node", "--import", "tsx", "src/searcher/test/backrun-hunt.ts"])
      || replay.cwd !== "listener") {
    throw new Error("candidate replay must use the trusted direct-node backrun-hunt harness");
  }
  const baseRoot = fs.realpathSync(requiredArg("--base-root"));
  const challengerRoot = fs.realpathSync(requiredArg("--challenger-root"));
  const sample = evidence.sample;
  const baselineUniverse = fs.realpathSync(candidateUniverseArg("baseline"));
  const challengerUniverse = fs.realpathSync(candidateUniverseArg("challenger"));
  const maxPools = Number(requiredArg("--pool-universe-top-n"));
  if (!Number.isSafeInteger(maxPools) || maxPools <= 0) throw new Error("--pool-universe-top-n must be a positive integer");
  const expectedPools = observation.arb_pools.map((pool) => pool.toLowerCase()).sort();
  const baseline = runBackrunHunt(
    "baseline", baseRoot, baseRoot, 8570, 8572, 8574, baselineUniverse, expectedPools, maxPools,
  );
  const challenger = runBackrunHunt(
    "challenger", baseRoot, challengerRoot, 8571, 8573, 8575, challengerUniverse, expectedPools, maxPools,
  );
  validateBackrunHuntResult(
    "baseline",
    baseline,
    evidence.baseline_stage,
    sample.block_number - 1,
    expectedPools,
    observation,
  );
  validateBackrunHuntResult(
    "challenger",
    challenger,
    evidence.challenger_stage,
    sample.block_number - 1,
    expectedPools,
    observation,
  );
  if (isAcceptancePhase) {
    const baselineDiagnostics = backrunSixStepDiagnostics(baseline, expectedPools);
    const challengerDiagnostics = backrunSixStepDiagnostics(challenger, expectedPools);
    requireStageDiagnostics(
      "baseline backrun",
      baselineDiagnostics,
      evidence.baseline_stage,
    );
    requireStageDiagnostics(
      "challenger backrun",
      challengerDiagnostics,
      evidence.challenger_stage,
    );
    emitSixStepDiagnostics("baseline", baselineDiagnostics);
    emitSixStepDiagnostics("challenger", challengerDiagnostics);
  }
  console.log(`candidate_replay=pass baseline=${JSON.stringify(baseline)} challenger=${JSON.stringify(challenger)}`);
}

/** Backrun's six steps are derived by the trusted acceptance runner from the already-validated causal
 * replay result; they are not challenger-authored success claims. */
function backrunSixStepDiagnostics(
  result: BackrunHuntResult,
  expectedPools: string[],
): SixStepDiagnostic[] {
  const evidence = acceptanceEvidence();
  const expectedRoute = normalizeProductionRoute(evidence.sample.expected_route ?? []);
  const matchedPools = new Set((result.matched_pool_ids ?? []).map((pool) => pool.toLowerCase()));
  const triggerPass = result.pre_state_anchor_kind === "parent-block"
    && result.pre_state_anchor_hash === null
    && result.post_state_anchor_kind === "victim-tx"
    && result.post_state_anchor_hash.toLowerCase()
      === evidence.sample.victim_tx_hash!.toLowerCase();
  const routePass = result.closed_route
    && expectedPools.every((pool) => matchedPools.has(pool))
    && JSON.stringify(result.matched_route) === JSON.stringify(expectedRoute);
  const quotePass = rawAtMostZero(result.pre_gross_raw) && rawPositive(result.post_gross_raw);
  const simulationPass = result.final_sim_success
    && rawPositive(result.net_profit_raw)
    && result.pre_execution_success === false
    && rawAtMostZero(result.pre_execution_net_raw)
    && result.post_execution_success === true
    && rawPositive(result.post_execution_net_raw)
    && rawEqual(result.post_execution_net_raw, result.net_profit_raw)
    && result.trigger_ev !== null
    && rawPositive(result.trigger_ev.gasUsed)
    && /^[a-f0-9]{64}$/.test(result.trigger_ev.calldataHash);
  const evPass = simulationPass
    && result.trigger_ev_bucket === "positive"
    && isStrictPositiveBackrunEv(result.trigger_ev);
  const fullPrefixPass = evPass
    && result.full_prefix_execution_success === true
    && rawPositive(result.full_prefix_execution_net_raw)
    && result.full_vs_trigger === "match"
    && result.trigger_route_signature !== null
    && result.trigger_route_signature === result.full_prefix_route_signature
    && result.full_prefix_ev_bucket === "positive"
    && isStrictPositiveBackrunEv(result.full_prefix_ev)
    && result.causal_replay_error === null;
  const conditions = [triggerPass, routePass, quotePass, simulationPass, evPass, fullPrefixPass];
  const stages = [
    "trigger_and_admission",
    "route_enumeration",
    "counterfactual_quote",
    "resolved_plan_fork_sim",
    "production_ev",
    "full_prefix_replay",
  ];
  const details: Array<Record<string, unknown>> = [
    {
      preStateAnchorKind: result.pre_state_anchor_kind,
      preStateAnchorHash: result.pre_state_anchor_hash,
      postStateAnchorKind: result.post_state_anchor_kind,
      postStateAnchorHash: result.post_state_anchor_hash,
      victimEffectKind: result.victim_effect_kind,
    },
    {
      expectedPools,
      matchedPools: [...matchedPools].sort(),
      expectedRoute,
      matchedRoute: result.matched_route,
      closedRoute: result.closed_route,
    },
    {
      preGrossRaw: result.pre_gross_raw,
      postGrossRaw: result.post_gross_raw,
      oracleProbeAmountInRaw: result.oracle_probe_amount_in_raw,
      oracleBeforeAmountOutRaw: result.oracle_before_amount_out_raw,
      oracleAfterAmountOutRaw: result.oracle_after_amount_out_raw,
    },
    {
      success: result.post_execution_success,
      netProfitRaw: result.post_execution_net_raw,
      block: result.post_execution_block,
      transactionIndex: result.post_execution_index,
      gasUsed: result.trigger_ev?.gasUsed ?? null,
      calldataHash: result.trigger_ev?.calldataHash ?? null,
    },
    { ...(result.trigger_ev ?? { decision: null }) },
    {
      routeSignature: result.full_prefix_route_signature,
      triggerRouteSignature: result.trigger_route_signature,
      success: result.full_prefix_execution_success,
      netProfitRaw: result.full_prefix_execution_net_raw,
      block: result.full_prefix_execution_block,
      transactionIndex: result.full_prefix_execution_index,
      ev: result.full_prefix_ev,
      fullVsTrigger: result.full_vs_trigger,
      error: result.causal_replay_error,
    },
  ];
  let reached = true;
  return conditions.map((condition, index) => {
    const status: SixStepDiagnostic["status"] = reached
      ? condition ? "pass" : "fail"
      : "not_reached";
    reached &&= condition;
    return {
      step: (index + 1) as SixStepDiagnostic["step"],
      stage: stages[index],
      status,
      ...details[index],
    };
  });
}

function rawPositive(value: string | null): boolean {
  return value !== null && BigInt(value) > 0n;
}

function rawAtMostZero(value: string | null): boolean {
  return value !== null && BigInt(value) <= 0n;
}

function rawEqual(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && BigInt(left) === BigInt(right);
}

function runBackrunHunt(
  label: string,
  trustedRoot: string,
  targetRoot: string,
  anvilPort: number,
  preAnvilPort: number,
  fullPrefixAnvilPort: number,
  universe: string,
  expectedPools: string[],
  maxPools: number,
): BackrunHuntResult {
  const evidence = acceptanceEvidence();
  const trustedSource = path.join(trustedRoot, "listener", "src", "searcher", "test", "backrun-hunt.ts");
  const targetSource = resolveTrustedBackrunHarness(label, trustedSource, trustedRoot, targetRoot);
  const removeTargetSource = targetSource !== trustedSource
    && option(`--trusted-backrun-hunt-${label}`) === undefined;
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.npm_config_script_shell;
  delete childEnv.NPM_CONFIG_SCRIPT_SHELL;
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", path.relative(path.join(targetRoot, "listener"), targetSource)],
      {
        cwd: path.join(targetRoot, "listener"),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20 * 60 * 1000,
        env: {
          ...childEnv,
          SEARCHER_LIVE_RPC_URL: requiredArg("--rpc"),
          SEARCHER_BACKRUN_HUNT_ANVIL_PORT: String(anvilPort),
          SEARCHER_BACKRUN_HUNT_PRE_ANVIL_PORT: String(preAnvilPort),
          SEARCHER_BACKRUN_HUNT_FULL_PREFIX_ANVIL_PORT: String(fullPrefixAnvilPort),
          HUNT_SAMPLE_BLOCK: String(evidence.sample.block_number),
          HUNT_WINNER_TX_HASH: evidence.sample.tx_hash,
          HUNT_VICTIM_TX_HASH: evidence.sample.victim_tx_hash!,
          HUNT_UNIVERSE_PATH: universe,
          HUNT_MAX_POOLS: String(maxPools),
          HUNT_TRUSTED_ROOT: trustedRoot,
          AB_EXPECTED_POOL_IDS: expectedPools.join(","),
          AB_EXPECTED_ROUTE_JSON: JSON.stringify(evidence.sample.expected_route),
          AB_TRIGGER_KIND: evidence.trigger_kind,
          AB_ORACLE_ROUTE_EDGE_INDEX: evidence.sample.oracle_route_edge_index === undefined
            ? ""
            : String(evidence.sample.oracle_route_edge_index),
        },
      },
    );
    if (result.error) throw new Error(`${label} backrun hunt failed to start: ${result.error.message}`);
    if (result.status !== 0) {
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-4000);
      throw new Error(`${label} backrun hunt exited ${result.status ?? "signal"}: ${output}`);
    }
    const marker = String(result.stdout ?? "").split(/\r?\n/)
      .filter((line) => line.startsWith("BACKRUN_HUNT_RESULT="))
      .at(-1);
    if (!marker) throw new Error(`${label} backrun hunt emitted no machine result`);
    return JSON.parse(marker.slice("BACKRUN_HUNT_RESULT=".length)) as BackrunHuntResult;
  } finally {
    if (removeTargetSource) fs.rmSync(targetSource, { force: true });
  }
}

function resolveTrustedBackrunHarness(
  label: string,
  trustedSource: string,
  trustedRoot: string,
  targetRoot: string,
): string {
  if (targetRoot === trustedRoot) return trustedSource;
  const preinstalledSource = option(`--trusted-backrun-hunt-${label}`);
  if (preinstalledSource !== undefined) {
    const resolved = fs.realpathSync(preinstalledSource);
    const expectedDirectory = fs.realpathSync(path.join(targetRoot, "listener", "src", "searcher", "test"));
    if (path.dirname(resolved) !== expectedDirectory
        || !path.basename(resolved).startsWith(".ab-trusted-backrun-hunt-")) {
      throw new Error(`${label} trusted backrun harness must be preinstalled under the target test directory`);
    }
    const trustedDigest = createHash("sha256").update(fs.readFileSync(trustedSource)).digest("hex");
    const resolvedDigest = createHash("sha256").update(fs.readFileSync(resolved)).digest("hex");
    if (resolvedDigest !== trustedDigest) {
      throw new Error(`${label} trusted backrun harness does not match the frozen base harness`);
    }
    return resolved;
  }
  const targetSource = path.join(
    targetRoot,
    "listener",
    "src",
    "searcher",
    "test",
    `.ab-trusted-backrun-hunt-${process.pid}-${label}.ts`,
  );
  fs.copyFileSync(trustedSource, targetSource, fs.constants.COPYFILE_EXCL);
  return targetSource;
}

function validateBackrunHuntResult(
  label: string,
  result: BackrunHuntResult,
  expectedStage: string,
  forkBlock: number,
  expectedPools: string[],
  observation: ProductionSampleObservation,
): void {
  const evidence = acceptanceEvidence();
  const causalErrors = validateBackrunCausalReplay(result, {
    stage: expectedStage,
    parentBlock: forkBlock,
    winnerTxHash: evidence.sample.tx_hash,
    winnerTransactionIndex: observation.transaction_index,
    victimTxHash: evidence.sample.victim_tx_hash!,
    blockNumber: observation.block_number,
  });
  if (causalErrors.length > 0) {
    throw new Error(`${label} backrun causal replay invalid: ${causalErrors.join("; ")}`);
  }
  if (result.stage !== expectedStage) {
    throw new Error(`${label} backrun hunt stage ${result.stage} does not match declared ${expectedStage}`);
  }
  const reportedPools = [...(result.expected_pool_ids ?? [])].map((pool) => pool.toLowerCase()).sort();
  if (JSON.stringify(reportedPools) !== JSON.stringify(expectedPools)) {
    throw new Error(`${label} backrun hunt pool identity does not match the winner sample`);
  }
  if (expectedStage !== "not_admitted" && !result.closed_route) {
    throw new Error(`${label} backrun hunt did not find the declared closed route`);
  }
  if (expectedStage !== "not_admitted") {
    const matched = new Set((result.matched_pool_ids ?? []).map((pool) => pool.toLowerCase()));
    const missing = expectedPools.filter((pool) => !matched.has(pool));
    if (missing.length > 0) {
      throw new Error(`${label} backrun hunt route is missing on-chain DEX pools: ${missing.join(",")}`);
    }
  }
  const expectedProtocol = evidence.route_scope === "dex-permissionless-protocol";
  const expectedRoute = normalizeProductionRoute(evidence.sample.expected_route ?? []);
  if (JSON.stringify(result.expected_route) !== JSON.stringify(expectedRoute)) {
    throw new Error(`${label} backrun hunt did not bind the declared complete route`);
  }
  if (expectedStage !== "not_admitted"
      && JSON.stringify(result.matched_route) !== JSON.stringify(expectedRoute)) {
    throw new Error(`${label} backrun hunt did not match the complete adapter/slot/target/token route`);
  }
  if (expectedStage !== "not_admitted" && result.has_protocol_edge !== expectedProtocol) {
    throw new Error(`${label} backrun hunt route scope does not match the winner sample`);
  }
  if (expectedStage === "final_sim_success") {
    if (!result.final_sim_success || result.net_profit_raw === null || BigInt(result.net_profit_raw) <= 0n) {
      throw new Error(`${label} backrun hunt did not produce a positive final simulation`);
    }
    if (result.pre_gross_raw === null || result.post_gross_raw === null
        || BigInt(result.pre_gross_raw) > 0n || BigInt(result.post_gross_raw) <= 0n) {
      throw new Error(`${label} backrun hunt did not prove the victim counterfactual flip`);
    }
    if (result.pre_execution_success !== false || result.pre_execution_net_raw === null
        || BigInt(result.pre_execution_net_raw) > 0n) {
      throw new Error(`${label} backrun hunt did not prove the exact route is non-profitable before the victim`);
    }
    if (result.post_execution_success !== true || result.post_execution_net_raw === null
        || BigInt(result.post_execution_net_raw) <= 0n
        || BigInt(result.post_execution_net_raw) !== BigInt(result.net_profit_raw)) {
      throw new Error(`${label} backrun hunt did not independently execute the exact route after the victim`);
    }
    const triggerKind = evidence.trigger_kind;
    if (triggerKind === "victim-swap" && result.victim_effect_kind !== "swap") {
      throw new Error(`${label} backrun hunt did not bind the route to a swap victim effect`);
    }
    if (triggerKind === "oracle-update") {
      const expectedEdgeIndex = evidence.sample.oracle_route_edge_index!;
      if (result.victim_effect_kind !== "oracle"
          || result.oracle_route_edge_index !== expectedEdgeIndex
          || result.oracle_probe_amount_in_raw === null
          || result.oracle_before_amount_out_raw === null
          || result.oracle_after_amount_out_raw === null
          || BigInt(result.oracle_before_amount_out_raw) === BigInt(result.oracle_after_amount_out_raw)) {
        throw new Error(`${label} backrun hunt did not prove an oracle quote delta on the declared route edge`);
      }
    }
  }
}

function runHunt(
  label: string,
  root: string,
  anvilPort: number,
  universe: string,
  forkBlock: number,
  expectedPools: string[],
  expectedSwapPath: ProductionSampleObservation["arb_swap_path"],
  expectedRoute: ProductionRouteStep[],
  maxPools: number,
): BlockscanHuntRun {
  const outDir = fs.mkdtempSync(path.join(gateTmpRoot, `mev-ab-${label}-`));
  const childEnv = isolatedBlockscanHuntEnv();
  const result = spawnSync(
    process.execPath,
    [
      "--import", "tsx", "src/searcher/test/blockscan-hunt.ts",
      ...(isAcceptancePhase
        ? [
            "--diagnostic",
            "--max-candidates", "100",
            "--scan-budget-ms", "120000",
            "--pass-budget-ms", "600000",
            "--top-k", "8",
          ]
        : []),
    ],
    {
    cwd: path.join(root, "listener"),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...childEnv,
      SEARCHER_LIVE_RPC_URL: requiredArg("--rpc"),
      SEARCHER_BLOCKSCAN_HUNT_ANVIL_PORT: String(anvilPort),
      HUNT_BLOCK: String(forkBlock),
      HUNT_UNIVERSE_PATH: universe,
      HUNT_MAX_POOLS: String(maxPools),
      HUNT_MAX_HOPS: "4",
      HUNT_MIN_SPREAD_BPS: "0",
      HUNT_SCAN_BUDGET_MS: "120000",
      // Historical archive mids are transport-bound and are not the live
      // performance measurement. Keep the production candidate/refine shape,
      // but leave enough wall time for both commits to complete semantic replay.
      HUNT_PASS_BUDGET_MS: "600000",
      // Keep the trusted replay on the same generic candidate budget as
      // production. A route admitted at rank 9..100 is a production route, not
      // a replay failure. The expected route is used only to validate the
      // immutable machine output after production selection has completed.
      HUNT_MAX_CANDIDATES: "100",
      // Solve exactly the production-shaped top-K; the expected route is never
      // appended or force-selected by acceptance.
      HUNT_TOP_K: "8",
      HUNT_REFINE_CANDIDATES: "512",
      HUNT_OUT: path.join(outDir, "hunt.json"),
      AB_EXPECTED_POOL_IDS: expectedPools.join(","),
      AB_EXPECTED_SWAP_PATH_JSON: JSON.stringify(expectedSwapPath),
      AB_EXPECTED_ROUTE_JSON: JSON.stringify(expectedRoute),
      AB_EXPECTED_ROUTE_SCOPE: acceptanceEvidence().route_scope,
    },
    },
  );
  if (result.error) throw new Error(`${label} blockscan hunt failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-4000);
    throw new Error(`${label} blockscan hunt exited ${result.status ?? "signal"}: ${output}`);
  }
  const stdout = String(result.stdout ?? "");
  const diagnostics = isAcceptancePhase
    ? parseSixStepDiagnostics(stdout, label)
    : [];
  if (isAcceptancePhase && diagnostics.length === 0) {
    throw new Error(`${label} blockscan hunt emitted no six-step evidence`);
  }
  const marker = stdout.split(/\r?\n/)
    .filter((line) => line.startsWith("BLOCKSCAN_HUNT_RESULT="))
    .at(-1);
  if (!marker) {
    const legacyPrefix = diagnostics.length > 0 &&
      diagnostics.every((entry) => !("schema_version" in entry));
    if (legacyPrefix) return { result: null, diagnostics };
    throw new Error(`${label} blockscan hunt emitted no machine result`);
  }
  let parsed: BlockscanHuntResult;
  try {
    parsed = JSON.parse(
      marker.slice("BLOCKSCAN_HUNT_RESULT=".length),
    ) as BlockscanHuntResult;
  } catch (error) {
    throw new Error(`${label} blockscan hunt result is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { result: parsed, diagnostics };
}

function isolatedBlockscanHuntEnv(): NodeJS.ProcessEnv {
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.npm_config_script_shell;
  delete childEnv.NPM_CONFIG_SCRIPT_SHELL;
  for (const key of Object.keys(childEnv)) {
    if (
      FORMAL_BLOCKSCAN_HUNT_INHERITED_ENV_PREFIXES.some(
        (prefix) => key.startsWith(prefix),
      )
    ) {
      delete childEnv[key];
    }
  }
  // Formal acceptance owns every replay input. A repository-local .env may
  // still support direct operator diagnostics, but cannot reintroduce a
  // retained topology/cache artifact after the trusted gate cleared it.
  childEnv.SEARCHER_TEST_DISABLE_DOTENV = "1";
  return childEnv;
}

function validateHuntRun(
  label: string,
  run: BlockscanHuntRun,
  expectedStage: string,
  forkBlock: number,
  expectedPools: string[],
  expectedSwapPath: ProductionSampleObservation["arb_swap_path"],
  expectedRoute: ProductionRouteStep[],
): void {
  requireStageDiagnostics(label, run.diagnostics, expectedStage);
  if (run.result === null) {
    if (expectedStage === "final_sim_success") {
      throw new Error(`${label} final_sim_success requires a machine hunt result`);
    }
    return;
  }
  validateHuntResult(
    label,
    run.result,
    expectedStage,
    forkBlock,
    expectedPools,
    expectedSwapPath,
    expectedRoute,
  );
}

function validateHuntResult(
  label: string,
  result: BlockscanHuntResult,
  expectedStage: string,
  forkBlock: number,
  expectedPools: string[],
  expectedSwapPath: ProductionSampleObservation["arb_swap_path"],
  expectedRoute: ProductionRouteStep[],
): void {
  if (result.schema_version !== 1 || result.fork_block !== forkBlock) {
    throw new Error(`${label} hunt did not execute at the untouched sample parent block`);
  }
  if (result.stage !== expectedStage) {
    throw new Error(`${label} hunt stage ${result.stage} does not match declared ${expectedStage}`);
  }
  const reportedPools = [...(result.expected_pool_ids ?? [])].map((pool) => pool.toLowerCase()).sort();
  if (JSON.stringify(reportedPools) !== JSON.stringify(expectedPools)) {
    throw new Error(`${label} hunt pool identity does not match the on-chain sample`);
  }
  if (JSON.stringify(result.expected_swap_path) !== JSON.stringify(expectedSwapPath)) {
    throw new Error(`${label} hunt swap path declaration does not match the ordered on-chain sample`);
  }
  if (JSON.stringify(result.expected_route) !== JSON.stringify(expectedRoute)) {
    throw new Error(`${label} hunt route declaration does not match the complete ordered sample route`);
  }
  if (expectedStage !== "not_admitted" && result.closed_route !== true) {
    throw new Error(`${label} hunt did not find the sample pools in a closed route`);
  }
  if (expectedStage !== "not_admitted") {
    const pathErrors = validateExactProductionSwapPath(expectedSwapPath, result.matched_swap_path);
    if (pathErrors.length > 0) throw new Error(`${label} ${pathErrors.join("; ")}`);
    if (JSON.stringify(result.matched_route) !== JSON.stringify(expectedRoute)) {
      throw new Error(`${label} hunt did not match the complete ordered adapter/target/token route`);
    }
  }
  const expectedProtocol = acceptanceEvidence().route_scope === "dex-permissionless-protocol";
  if (expectedStage !== "not_admitted" && result.has_protocol_edge !== expectedProtocol) {
    throw new Error(`${label} hunt route scope does not match the on-chain sample`);
  }
  if (expectedStage === "final_sim_success"
      && (!result.final_sim_success || result.net_profit_raw === null || BigInt(result.net_profit_raw) <= 0n)) {
    throw new Error(`${label} hunt did not produce a positive final simulation`);
  }
}

function normalizeProductionRoute(
  route: NonNullable<ProductionSample["expected_route"]>,
): ProductionRouteStep[] {
  return route.map((edge) => ({
    adapterId: edge.adapterId,
    slotKind: edge.slotKind,
    target: edge.target.toLowerCase(),
    tokenIn: edge.tokenIn.toLowerCase(),
    tokenOut: edge.tokenOut.toLowerCase(),
    ...(edge.poolId ? { poolId: edge.poolId.toLowerCase() } : {}),
  }));
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

function verifyResolvedCleanup(): void {
  const resolvedBy = experiment.resolution?.resolved_by_commit;
  if (!/^[a-f0-9]{40}$/i.test(resolvedBy ?? "")) {
    throw new Error("resolved cleanup requires resolution.resolved_by_commit");
  }
  execFileSync("git", ["fetch", "origin", "main", "--quiet"], { stdio: "inherit" });
  if (!isAncestor(experiment.base_commit, resolvedBy!) || !isAncestor(resolvedBy!, "origin/main")) {
    throw new Error("resolved cleanup refused: resolved_by_commit must descend from the tested base and be an ancestor of origin/main");
  }

  const root = fs.realpathSync(gitOutput(["rev-parse", "--show-toplevel"]));
  const reportPath = fs.realpathSync(path.resolve(report!));
  const relativeReport = path.relative(root, reportPath).split(path.sep).join("/");
  if (relativeReport === "" || relativeReport === ".." || relativeReport.startsWith("../")) {
    throw new Error("resolved cleanup refused: report must live inside the repository");
  }
  let mainReport: string;
  try {
    mainReport = execFileSync("git", ["show", `origin/main:${relativeReport}`], { encoding: "utf8" });
  } catch {
    throw new Error("resolved cleanup refused: final report must be committed and pushed to origin/main first");
  }
  if (mainReport !== md) {
    throw new Error("resolved cleanup refused: local report must exactly match the copy on origin/main");
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

const marker = path.join(gateTmpRoot, `mev-ab-cleanup-${createHash("sha256").update(experiment.branch).digest("hex")}`);
const authorizeCleanup = args.includes("--authorize-cleanup");
if (authorizeCleanup) {
  const resolvedCleanup = phase === "close"
    && experiment.final_verdict === "needs_escalation"
    && experiment.branch_action === "resolved_deleted";
  const decisiveCleanup = phase === "decision" && experiment.final_verdict !== "needs_escalation";
  if (!resolvedCleanup && !decisiveCleanup) {
    throw new Error("cleanup authorization requires a decisive decision or a main-resolved escalated close");
  }
  if (resolvedCleanup) {
    verifyResolvedCleanup();
  } else if (experiment.final_verdict === "win") {
    verifyWinningMerge();
  }
  const verdict = resolvedCleanup ? "resolved" : experiment.final_verdict;
  fs.writeFileSync(marker, `${JSON.stringify({ branch: experiment.branch, verdict, created_at: Date.now() })}\n`, { mode: 0o600 });
}
if (phase === "close" && !authorizeCleanup) {
  if (experiment.final_verdict === "win") verifyWinningMerge();
  if (experiment.branch_action === "resolved_deleted") verifyResolvedCleanup();
  const localExists = localBranchExists();
  const remoteExists = remoteBranchExists();
  if (experiment.final_verdict === "needs_escalation" && experiment.branch_action === "retained") {
    if (!remoteExists) throw new Error("retained challenger must still exist on origin for stronger-model review");
  } else if (localExists || remoteExists) {
    throw new Error("challenger cleanup incomplete: local and remote ab/* branch must both be absent");
  }
  if (fs.existsSync(marker)) fs.unlinkSync(marker);
}
console.log(`PASS: ${experiment.experiment_id} phase=${phase} verdict=${experiment.final_verdict}`);
