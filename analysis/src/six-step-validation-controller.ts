import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import {
  loadPoolUniverseCoverageMetadata, poolUniverseCanonicalAnchorMatches,
  type PoolUniverseCoverageMetadata,
} from "../../listener/src/searcher/pool-universe.js";
import {
  createSemanticSixStepEvidence, semanticExactQuoteCommitmentSha256,
  semanticFinalSimCommitmentSha256, semanticJsonSha256,
  semanticRouteMembershipProofSha256, type SemanticJson,
  type SemanticSixStepEvidence,
} from "../../listener/src/shared/evidence/semantic-six-step.js";
import {
  familyOwnershipSourceSkeletonSha256,
  type FamilyOwnershipManifest,
} from "../../listener/src/searcher/test/family-ownership-manifest.js";
import {
  EMPTY_SHA256, SIX_STEP_VALIDATION_LIFECYCLE_GATE,
  SIX_STEP_VALIDATION_LIFECYCLE_SCHEMA_VERSION, createGitInspector,
  sixStepLifecycleEnvelopeSha256, sixStepStateAnchorSha256,
  validateSixStepValidationLifecycle, type SixStepCheckpointEvidence,
  type SixStepFinalEvidence, type SixStepStateAnchor,
  type SixStepValidationEvidence,
} from "./six-step-validation-lifecycle.js";
import {
  canonicalTrustedSixStepInputSnapshotPayloadSha256,
  canonicalTrustedSixStepRuntimePayloadSha256,
  fetchTrustedSixStepRuntimeAttestation, openTrustedSixStepRpcTransport,
  validateTrustedSixStepInputSnapshot,
  type TrustedSixStepInputSnapshot, type TrustedSixStepRuntimeAttestation,
  type TrustedSixStepRpcTransport,
} from "./trusted-six-step-runtime-attestation.js";

export const SIX_STEP_VALIDATION_REQUEST_SCHEMA_VERSION = 1 as const;
export const SIX_STEP_VALIDATION_REQUEST =
  "trusted-six-step-validation-request" as const;
export const SIX_STEP_CONTROLLER_ID =
  "trusted-production-replay-controller" as const;

const CONTROLLER_PATH = fileURLToPath(import.meta.url);
const PRODUCER = "listener/src/searcher/test/production-replay.ts";
const MANIFEST = "listener/src/searcher/test/family-ownership-manifest.ts";
const GRAPH_BUILDER = "listener/src/searcher/planner/token-graph.ts";
const REGISTRY = "listener/src/searcher/venues/production-registry.ts";
const ACTION_INDEX = "listener/src/adapters/index.ts";
const TSX = import.meta.resolve("tsx");
const SHA40 = /^[a-f0-9]{40}$/;
const HASH32 = /^0x[a-f0-9]{64}$/;
const DEFAULT_WALL_TIMEOUT_MS = 30 * 60 * 1_000;
const TRUSTED_SURFACES = [
  "analysis/src/cli/six-step-validation-gate.ts",
  "analysis/src/six-step-validation-controller.ts",
  "analysis/src/six-step-validation-lifecycle.ts",
  "analysis/src/trusted-six-step-runtime-attestation.ts",
  PRODUCER,
  MANIFEST,
  "listener/src/searcher/test/blockscan-hunt.ts",
  "listener/src/shared/evidence/canonical-edge-set.ts",
  "listener/src/shared/evidence/semantic-six-step.ts",
] as const;

interface CommonRequest {
  schema_version: 1; request: typeof SIX_STEP_VALIDATION_REQUEST;
  branch: string; rollback_commit: string; sample_tx_hash: string;
  lane: "block_scan_standing";
  runner_overrides?: { wall_clock_timeout_ms?: number };
}
interface CheckpointRequest extends CommonRequest {
  mode: "checkpoint"; input_snapshot_path: string;
}
interface FinalRequest extends CommonRequest {
  mode: "final"; universe_path: string; universe_manifest_path: string;
  checkpoint_receipt_path: string; review_commit: string;
  review_artifact_path: string;
}
export type SixStepValidationRequest = CheckpointRequest | FinalRequest;
export interface SixStepInputFreezeRequest {
  schema_version: 1; request: "trusted-six-step-input-freeze-request";
  sample_tx_hash: string; lane: "block_scan_standing";
  universe_path: string; universe_manifest_path: string;
}
export interface ProductionRunnerConfig {
  maxPools: number; maxHops: number; maxCandidates: number;
  refineCandidates: number; topK: number; minSpreadBps: number;
  prewarmBudgetMs: number; scanBudgetMs: number; passBudgetMs: number;
  largeGraphPassBudgetMs: number; largeGraphEdgeThreshold: number;
  refineFamilyTimeoutMs: number;
}
interface RouteEdge {
  adapterId: string; target: string; tokenIn: string; tokenOut: string;
  slotKind: string; edgeKind: string; leavesStandingPosition: boolean;
  poolId?: string;
}
type RawReplay = Record<string, any>;
interface ReviewArtifact {
  schema_version: 1; artifact: "six-step-independent-review";
  reviewer_email: string; rollback_commit: string;
  reviewed_candidate_commit: string; reviewed_merge_commit: string;
  diff_sha256: string; reviewed_at: string; evidence: string; verdict: "pass";
}
interface ReviewContext {
  review: ReviewArtifact; bytes: Buffer; path: string; commit: string;
}
export interface SixStepControllerResult {
  evidence: SixStepValidationEvidence; evidencePath: string;
  rawProducerPath: string;
}

export async function freezeTrustedSixStepInputs(input: {
  request: unknown; snapshotPath: string;
  cwd?: string;
}): Promise<TrustedSixStepInputSnapshot> {
  const cwd = trustedRoot(input.cwd ?? process.cwd());
  const request = parseFreezeRequest(input.request, cwd);
  const main = gitOut(cwd, ["rev-parse", "refs/remotes/origin/main^{commit}"]);
  const attestation =
    await fetchTrustedSixStepRuntimeAttestation(request.sample_tx_hash);
  if (attestation.runtime_commit !== main) {
    throw new Error("input snapshot requires the running origin/main commit");
  }
  const universe = readFileSync(request.universe_path);
  const manifest = readFileSync(request.universe_manifest_path);
  const coverage = validateUniverse(request, universe, manifest, attestation);
  const transport = await openTrustedSixStepRpcTransport();
  try {
    const provider = new ethers.JsonRpcProvider(transport.rpcUrl);
    const anchor = await standingAnchor(provider, request.sample_tx_hash, attestation);
    await assertCanonicalUniverse(provider, coverage);
    provider.destroy();
    const payload = {
      schema_version: 1 as const,
      kind: "trusted-six-step-input-snapshot" as const,
      sample_tx_hash: request.sample_tx_hash,
      lane: "block_scan_standing" as const,
      source_runtime_commit: main,
      local_universe: { path: request.universe_path, sha256: sha256(universe) },
      local_universe_manifest: {
        path: request.universe_manifest_path,
        sha256: sha256(manifest),
      },
      runtime_attestation: attestation,
      state_anchor: {
        ...anchor,
        lane: "block_scan_standing" as const,
        applied_prefix_tx_hashes: [] as const,
        trigger_tx_hash: null,
        target_tx_index: null,
      },
      created_at: new Date().toISOString(),
    };
    const snapshot: TrustedSixStepInputSnapshot = {
      ...payload,
      payload_sha256:
        canonicalTrustedSixStepInputSnapshotPayloadSha256(payload),
    };
    writeJson(input.snapshotPath, snapshot);
    return snapshot;
  } finally {
    await transport.close();
  }
}

export async function runTrustedSixStepValidation(input: {
  request: unknown; evidencePath: string;
  cwd?: string;
}): Promise<SixStepControllerResult> {
  const cwd = trustedRoot(input.cwd ?? process.cwd());
  const request = parseRequest(input.request, cwd);
  const main = gitOut(cwd, ["rev-parse", "refs/remotes/origin/main^{commit}"]);
  const tip = gitOut(cwd, ["rev-parse", `refs/heads/${request.branch}^{commit}`]);
  if (request.mode === "checkpoint") {
    if (request.rollback_commit !== main || tip === main) {
      throw new Error("checkpoint rollback must be the strict origin/main ancestor");
    }
    ancestor(cwd, main, tip);
  } else {
    ancestor(cwd, request.rollback_commit, tip);
    ancestor(cwd, tip, main);
  }
  const trustedDiff = gitOut(cwd, [
    "diff", "--name-only", `${request.rollback_commit}..${tip}`, "--",
    ...TRUSTED_SURFACES,
  ]);
  if (trustedDiff) throw new Error(`candidate modifies trusted gate: ${trustedDiff}`);

  const snapshot = request.mode === "checkpoint"
    ? loadSnapshot(request.input_snapshot_path, request.sample_tx_hash) : null;
  if (snapshot && snapshot.source_runtime_commit !== request.rollback_commit) {
    throw new Error("snapshot does not bind rollback_commit");
  }
  const review = request.mode === "final"
    ? loadReview(request, cwd, tip, main) : null;
  const universePath = snapshot?.local_universe.path ??
    (request as FinalRequest).universe_path;
  const manifestPath = snapshot?.local_universe_manifest.path ??
    (request as FinalRequest).universe_manifest_path;
  const universe = readFileSync(universePath);
  const universeManifest = readFileSync(manifestPath);
  const temp = mkdtempSync(resolve(tmpdir(), "six-step-"));
  const rawPath = resolve(temp, "producer.json");
  let worktree: string | null = null;
  let transport: TrustedSixStepRpcTransport | null = null;
  try {
    const before = snapshot?.runtime_attestation ??
      await fetchTrustedSixStepRuntimeAttestation(request.sample_tx_hash);
    const deployed = request.mode === "checkpoint"
      ? request.rollback_commit : review!.review.reviewed_merge_commit;
    if (before.runtime_commit !== deployed) {
      throw new Error("attested live commit differs from expected deployed commit");
    }
    const coverage = validateUniverse(
      { universe_path: universePath, universe_manifest_path: manifestPath },
      universe, universeManifest, before,
    );
    transport = await openTrustedSixStepRpcTransport();
    const env = {
      ...before.searcher_config,
      SEARCHER_POOL_UNIVERSE_PATH: universePath,
      SEARCHER_POOL_UNIVERSE_MANIFEST_PATH: manifestPath,
      MAINNET_RPC_URL: transport.rpcUrl,
      SEARCHER_LIVE_RPC_URL: transport.rpcUrl,
    };
    const runner = productionRunnerConfig(env);
    worktree = createWorktree(cwd, temp,
      request.mode === "checkpoint" ? tip : deployed);
    await runProducer(request, rawPath, universePath,
      universeFromBlock(universe), runner, env, worktree);
    const rawBytes = readFileSync(rawPath);
    const raw = parseRaw(rawBytes, request, runner);
    const familyManifest = loadFamilyManifest(worktree);
    const route = raw.selected.route.map(normalizeEdge) as RouteEdge[];
    const routeHash = semanticJsonSha256(route as unknown as SemanticJson);
    if (!raw.producerOutput.naturalRouteSet.routeSha256s.includes(routeHash)) {
      throw new Error("selected route is absent from natural route set");
    }
    const isolation = classifyDiff(cwd, request.rollback_commit, tip, familyManifest);
    if (isolation.diffClass !== "family_local") {
      throw new Error("framework/systemic changes require cohort/Hermes validation");
    }
    const required = routeFamilies(route, familyManifest);
    assertShardCompleteness(raw, required);
    const complete = raw.discovery.shardCompleteness.familyShards
      .filter((shard: any) => shard.status === "complete")
      .map((shard: any) => shard.familyId).sort();
    const impacted = [...new Set([...isolation.impacted, ...required])].sort();
    const provider = new ethers.JsonRpcProvider(transport.rpcUrl);
    await assertCanonicalUniverse(provider, coverage);
    const anchor = await standingAnchor(provider, request.sample_tx_hash, before);
    provider.destroy();
    if (snapshot && stableJson(anchor) !== stableJson(snapshot.state_anchor)) {
      throw new Error("checkpoint replay state differs from frozen snapshot");
    }
    if (raw.stateAnchor.blockNumber !== anchor.base_block ||
        raw.sourceWindow.toBlock !== anchor.base_block) {
      throw new Error("producer does not bind the sample parent block");
    }
    const anchorHash = sixStepStateAnchorSha256(
      anchor as unknown as Readonly<Record<string, unknown>>,
    );
    const rawHash = sha256(rawBytes);
    const runId = semanticJsonSha256({
      candidate_commit: tip,
      raw_producer_receipt_sha256: rawHash,
      sample_tx_hash: request.sample_tx_hash,
      state_anchor_sha256: anchorHash,
      target_route_sha256: routeHash,
    });
    const stages = semanticStages(raw, runId, anchorHash, routeHash);
    const after = request.mode === "final"
      ? await fetchTrustedSixStepRuntimeAttestation(request.sample_tx_hash) : null;
    if (after) assertStable(before, after);
    const configHash = semanticJsonSha256({
      searcher_config: before.searcher_config,
      runner: runner as unknown as SemanticJson,
      validation_policy: raw.validationPolicy,
    });
    const common = {
      schema_version: SIX_STEP_VALIDATION_LIFECYCLE_SCHEMA_VERSION,
      gate: SIX_STEP_VALIDATION_LIFECYCLE_GATE,
      mode: request.mode,
      status: request.mode === "checkpoint" ?
        "checkpoint_pass" as const : "final_validated" as const,
      branch: request.branch,
      branch_tip: tip,
      candidate_commit: tip,
      rollback_commit: request.rollback_commit,
      sample_tx_hash: request.sample_tx_hash,
      target_route_sha256: routeHash,
      controller: {
        id: SIX_STEP_CONTROLLER_ID,
        controller_sha256: sha256(readFileSync(CONTROLLER_PATH)),
        raw_producer_receipt_sha256: rawHash,
      },
      state_anchor: anchor,
      state_anchor_sha256: anchorHash,
      frozen_inputs: {
        universe_sha256: sha256(universe),
        universe_manifest_sha256: sha256(universeManifest),
        config_sha256: configHash,
        graph_sha256: raw.producerOutput.materializedGraph.sha256,
        family_manifest_sha256:
          semanticJsonSha256(familyManifest as unknown as SemanticJson),
        graph_builder_sha256: sha256(readFileSync(resolve(worktree, GRAPH_BUILDER))),
        graph_snapshot_source_sha256:
          raw.producerOutput.frozenHuntArtifact.sha256,
        producer_sha256: sha256(readFileSync(resolve(cwd, PRODUCER))),
        comparator_sha256: sha256(readFileSync(CONTROLLER_PATH)),
        ...(snapshot
          ? { input_snapshot_sha256: snapshot.payload_sha256 }
          : {
              runtime_attestation_before_sha256:
                canonicalTrustedSixStepRuntimePayloadSha256(before),
              runtime_attestation_after_sha256:
                canonicalTrustedSixStepRuntimePayloadSha256(after!),
            }),
        graph_snapshot_kind: "honest_reconstruction" as const,
        target_injected: false,
        graph_reduced: false,
      },
      route_scope: routeScope(required, familyManifest),
      diff_class: isolation.diffClass,
      impacted_family_ids: impacted,
      required_family_ids: required,
      complete_family_ids: complete,
      central_behavior_diff_sha256: EMPTY_SHA256,
      other_family_source_set_baseline_sha256: isolation.otherBaseline,
      other_family_source_set_challenger_sha256: isolation.otherCandidate,
      exact_production_caps: true,
      runner_overrides: request.runner_overrides?.wall_clock_timeout_ms
        ? { wall_clock_timeout_ms: request.runner_overrides.wall_clock_timeout_ms }
        : {},
      production_route_stage: stages,
    };
    const evidence = request.mode === "checkpoint"
      ? checkpointEvidence(common, snapshot!)
      : finalEvidence(common, request, review!, before, after!, cwd);
    const errors = validateSixStepValidationLifecycle(
      evidence, createGitInspector(cwd),
    );
    if (errors.length) throw new Error(`generated lifecycle invalid: ${errors.join("; ")}`);
    writeJson(input.evidencePath, evidence);
    const durableRaw = `${input.evidencePath}.producer.json`;
    writeFileSync(durableRaw, rawBytes, { mode: 0o600 });
    return { evidence, evidencePath: input.evidencePath, rawProducerPath: durableRaw };
  } finally {
    await transport?.close();
    if (worktree) git(cwd, ["worktree", "remove", "--force", worktree]);
    rmSync(temp, { recursive: true, force: true });
  }
}

function checkpointEvidence(
  common: Record<string, unknown>,
  snapshot: TrustedSixStepInputSnapshot,
): SixStepCheckpointEvidence {
  const draft = {
    ...common,
    mode: "checkpoint" as const,
    status: "checkpoint_pass" as const,
    input_snapshot: snapshot,
  };
  return {
    ...draft,
    checkpoint_evidence_sha256: sixStepLifecycleEnvelopeSha256(draft),
  } as unknown as SixStepCheckpointEvidence;
}

function finalEvidence(
  common: Record<string, unknown>,
  request: FinalRequest,
  context: ReviewContext,
  before: TrustedSixStepRuntimeAttestation,
  after: TrustedSixStepRuntimeAttestation,
  cwd: string,
): SixStepFinalEvidence {
  const checkpointBytes = readFileSync(request.checkpoint_receipt_path);
  const checkpoint = JSON.parse(checkpointBytes.toString()) as Record<string, unknown>;
  const errors = validateSixStepValidationLifecycle(checkpoint, createGitInspector(cwd));
  if (checkpoint.mode !== "checkpoint" || errors.length) {
    throw new Error(`retained checkpoint is invalid: ${errors.join("; ")}`);
  }
  for (const field of [
    "branch", "candidate_commit", "rollback_commit", "sample_tx_hash",
    "target_route_sha256", "state_anchor_sha256", "route_scope",
    "required_family_ids", "impacted_family_ids",
  ]) {
    if (stableJson(checkpoint[field]) !== stableJson(common[field])) {
      throw new Error(`final does not match checkpoint ${field}`);
    }
  }
  const review = context.review;
  const draft = {
    ...common,
    mode: "final" as const,
    status: "final_validated" as const,
    runtime_attestations: { before, after },
    merge_commit: review.reviewed_merge_commit,
    deployed_commit: review.reviewed_merge_commit,
    review: {
      reviewer_email: review.reviewer_email,
      review_commit: context.commit,
      artifact_path: context.path,
      rollback_commit: review.rollback_commit,
      reviewed_candidate_commit: review.reviewed_candidate_commit,
      reviewed_merge_commit: review.reviewed_merge_commit,
      diff_sha256: review.diff_sha256,
      reviewed_at: review.reviewed_at,
      evidence: review.evidence,
      verdict: "pass" as const,
      artifact_sha256: sha256(context.bytes),
    },
    checkpoint_receipt_sha256: sha256(checkpointBytes),
    deployment_receipt_sha256: semanticJsonSha256(
      { before: before.payload_sha256, after: after.payload_sha256 },
    ),
    config_receipt_sha256:
      String((common.frozen_inputs as Record<string, unknown>).config_sha256),
  };
  return {
    ...draft,
    full_evidence_sha256: sixStepLifecycleEnvelopeSha256(draft),
  } as unknown as SixStepFinalEvidence;
}

function semanticStages(
  raw: RawReplay, runId: string, anchorHash: string, routeHash: string,
): SemanticSixStepEvidence[] {
  const selected = raw.selected;
  const common = {
    run_id: runId,
    state_anchor_sha256: anchorHash,
    target_route_sha256: routeHash,
  };
  const membership = {
    ...common,
    route_set_sha256: raw.producerOutput.naturalRouteSet.sha256,
    route_set_size: raw.producerOutput.naturalRouteSet.routeCount,
    target_present: true,
  };
  const quote = {
    ...common,
    source_block: raw.stateAnchor.blockNumber,
    route_sha256: routeHash,
    quote_status: "positive",
    probe_amount_in: selected.solverAmount,
    quoted_amount_out: selected.hopAmounts.at(-1).rawAmountOut,
    leg_quotes: selected.hopAmounts.map((hop: any) => ({
      amount_in: hop.amountIn, amount_out: hop.amountOut,
      raw_amount_out: hop.rawAmountOut,
    })),
  };
  const quoteHash = semanticExactQuoteCommitmentSha256(quote);
  const sim = {
    ...common, input_resolved_plan_sha256: selected.resolvedPlanSha256,
    success: true, profit_token: selected.profitToken,
    gross_profit: selected.grossProfit, net_profit: selected.netProfit,
    gas_used: selected.gasUsed, calldata_sha256: selected.calldataHash,
    repayment_and_conservation: selected.repaymentAndConservation,
    leaves_standing_position: selected.leavesStandingPosition,
  };
  const simHash = semanticFinalSimCommitmentSha256(sim);
  const graph = raw.producerOutput.materializedGraph;
  const shards = raw.discovery.shardCompleteness;
  const outputs: Record<number, Record<string, SemanticJson>> = {
    1: {
      ...common, source_block: raw.stateAnchor.blockNumber,
      materialized_graph: {
        scope: graph.scope, edge_count: graph.edgeCount, sha256: graph.sha256,
        family_edges: graph.familyEdges.map((entry: any) => ({
          family_id: entry.familyId, edge_count: entry.edgeCount, sha256: entry.sha256,
        })),
        target_injected: graph.targetInjected,
        graph_reduced: graph.graphReduced, cap_mode: graph.capMode,
      },
      shard_completeness: semanticShards(shards),
      edge_set_sha256: graph.sha256, edge_set_size: graph.edgeCount,
      target_membership: "present",
    },
    2: {
      ...membership,
      target_route_membership_proof_sha256:
        semanticRouteMembershipProofSha256(membership),
    },
    3: { ...quote, selected_exact_quote_sha256: quoteHash },
    4: {
      ...common, route_sha256: routeHash, input_exact_quote_sha256: quoteHash,
      selected_by_solve_policy: true, solve_succeeded: true,
      solver_selected_amount: selected.solverAmount,
      resolved_plan_sha256: selected.resolvedPlanSha256,
      hop_amounts: selected.hopAmounts.map((hop: any) => ({
        amount_in: hop.amountIn, amount_out: hop.amountOut,
      })),
    },
    5: { ...sim, final_sim_sha256: simHash },
    6: {
      ...common, input_final_sim_sha256: simHash, execution_status: "pass",
      decision: "allow", decision_reason: "positive_ev",
      net_ev_wei: selected.ev.netEvWei, gas_cost_eth: selected.ev.gasCostEth,
      bid_eth: selected.ev.bidEth,
      valuation_available: selected.ev.valuationAvailable,
      gas_measurement_available: selected.ev.gasMeasurementAvailable,
      fee_state_available: selected.ev.feeStateAvailable,
    },
  };
  return [1, 2, 3, 4, 5, 6].map((step) => createSemanticSixStepEvidence({
    profile: "production_route_stage",
    step: step as 1 | 2 | 3 | 4 | 5 | 6,
    status: "pass", output: outputs[step],
  }));
}

function semanticShards(shards: any): SemanticJson {
  return {
    schema_version: shards.schemaVersion, selection: shards.selection,
    dex_shard: snakeShard(shards.dexShard),
    family_shards: shards.familyShards.map((shard: any) => ({
      ...snakeShard(shard), family_id: shard.familyId,
      disposition: shard.disposition,
      source_coverage: shard.sourceCoverage.map((source: any) => ({
        source_id: source.sourceId, complete: source.complete, issues: source.issues,
      })),
    })),
    required_family_ids: shards.requiredFamilyIds,
    required_complete: shards.requiredComplete,
    isolated_incomplete_family_ids: shards.isolatedIncompleteFamilyIds,
    cache_reuse: {
      status: shards.cacheReuse.status, claimed_hit: shards.cacheReuse.claimedHit,
    },
  };
}
function snakeShard(shard: any): Record<string, SemanticJson> {
  return {
    shard_id: shard.shardId, source_kind: shard.sourceKind,
    status: shard.status, required: shard.required,
    edge_count: shard.edgeCount, sha256: shard.sha256, issues: shard.issues,
  };
}

async function runProducer(
  request: SixStepValidationRequest, out: string, universe: string,
  fromBlock: number, config: ProductionRunnerConfig,
  runtimeEnv: Record<string, string>, cwd: string,
): Promise<void> {
  const args = [
    "--import", TSX, resolve(cwd, PRODUCER),
    "--winner-tx", request.sample_tx_hash,
    "--source-from-block", String(fromBlock), "--universe", universe,
    "--max-pools", String(config.maxPools), "--max-hops", String(config.maxHops),
    "--max-candidates", String(config.maxCandidates), "--top-k", String(config.topK),
    "--min-spread-bps", String(config.minSpreadBps),
    "--prewarm-budget-ms", String(config.prewarmBudgetMs),
    "--scan-budget-ms", String(config.scanBudgetMs),
    "--pass-budget-ms", String(config.passBudgetMs),
    "--large-graph-pass-budget-ms", String(config.largeGraphPassBudgetMs),
    "--large-graph-edge-threshold", String(config.largeGraphEdgeThreshold),
    "--refine-candidates", String(config.refineCandidates),
    "--refine-family-timeout-ms", String(config.refineFamilyTimeoutMs),
    "--out", out,
  ];
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SEARCHER_") || key.startsWith("HUNT_") ||
        key.startsWith("AB_EXPECTED_")) delete env[key];
  }
  Object.assign(env, runtimeEnv);
  const timeout = request.runner_overrides?.wall_clock_timeout_ms ??
    DEFAULT_WALL_TIMEOUT_MS;
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, args, {
      cwd, env, stdio: ["ignore", "inherit", "inherit"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`production replay exceeded outer timeout ${timeout}ms`));
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? done() : reject(new Error(`production replay exited ${code}`));
    });
  });
}

function parseRaw(
  bytes: Buffer,
  request: SixStepValidationRequest,
  runner: ProductionRunnerConfig,
): RawReplay {
  const raw = JSON.parse(bytes.toString()) as RawReplay;
  if (raw.schemaVersion !== 4 ||
      raw.evidenceClass !== "candidate-authored-diagnostic" ||
      raw.trustedAcceptance !== false ||
      raw.laneCoverage !== "parent-block-blockscan" ||
      raw.triggerTx !== null || raw.stateAnchor.kind !== "parent-block" ||
      raw.winnerTx !== request.sample_tx_hash) {
    throw new Error("producer receipt identity/lane is invalid");
  }
  if (raw.inputs.explicitRouteInjected || raw.inputs.explicitAmountInjected ||
      raw.inputs.explicitRouteInputs.length || raw.inputs.explicitAmountInputs.length ||
      raw.inputs.amountSource !== "solver") {
    throw new Error("producer received a target route/amount oracle");
  }
  const expected = {
    ...runner,
    basePassBudgetMs: runner.passBudgetMs,
    passBudgetMs: productionPassBudgetMs(
      runner, raw.producerOutput.fullGraph.edgeCount,
    ),
  };
  if (stableJson(raw.actualRunnerConfig) !== stableJson(expected)) {
    throw new Error("producer did not use exact production caps");
  }
  if (stableJson(raw.stages) !== stableJson({
    sourceAndIdentity: "pass", graphProjection: "pass", enumeration: "pass",
    solver: "pass", finalSim: "pass", ev: "allow",
  }) || raw.failure !== null || !raw.selected) {
    throw new Error(`production replay failed: ${raw.failure ?? "stage mismatch"}`);
  }
  const gates = raw.terminalGates;
  if (!gates.finalVerifyAdmission?.allowed || !gates.phantomProfit?.allowed ||
      !gates.standingGuard?.allowed ||
      gates.standingGuard.containsStandingPosition ||
      !gates.repaymentAndConservation?.allowed ||
      raw.selected.leavesStandingPosition ||
      BigInt(raw.selected.grossProfit) <= 0n ||
      BigInt(raw.selected.netProfit) <= 0n ||
      BigInt(raw.selected.ev.netEvWei) <= 0n) {
    throw new Error("producer failed a safety/+EV invariant");
  }
  const graph = raw.producerOutput.materializedGraph;
  const routeHash = semanticJsonSha256(
    raw.selected.route.map(normalizeEdge) as SemanticJson,
  );
  if (raw.selected.routeSha256 !== routeHash) {
    throw new Error("selected route hash is invalid");
  }
  return raw;
}

function loadReview(
  request: FinalRequest, cwd: string, tip: string, main: string,
): ReviewContext {
  if (request.review_commit !== main) {
    throw new Error("review_commit must equal origin/main");
  }
  const shown = git(cwd, ["show", `${main}:${request.review_artifact_path}`]);
  if (shown.status !== 0) throw new Error("review artifact is not committed");
  const bytes = Buffer.from(shown.stdout);
  const review = parseReview(JSON.parse(bytes.toString()));
  if (review.rollback_commit !== request.rollback_commit ||
      review.reviewed_candidate_commit !== tip) {
    throw new Error("review does not bind candidate lifecycle");
  }
  const patch = git(cwd, [
    "diff", "--binary", "--full-index", `${request.rollback_commit}..${tip}`,
  ]);
  if (review.diff_sha256 !== sha256(patch.stdout)) {
    throw new Error("review does not bind exact candidate patch");
  }
  ancestor(cwd, tip, review.reviewed_merge_commit);
  ancestor(cwd, review.reviewed_merge_commit, main);
  const changed = gitOut(cwd, [
    "diff", "--name-only", `${review.reviewed_merge_commit}..${main}`,
  ]).split(/\r?\n/).filter(Boolean);
  if (!changed.includes(request.review_artifact_path) ||
      changed.some((path) => !reportPath(path))) {
    throw new Error("post-merge review descendant is not report-only");
  }
  const reviewer = review.reviewer_email.toLowerCase();
  if (!gitOut(cwd, ["show", "-s", "--format=%ae%n%ce", main])
      .toLowerCase().split(/\r?\n/).includes(reviewer) ||
      gitOut(cwd, ["log", "--format=%ae%n%ce",
        `${request.rollback_commit}..${tip}`])
        .toLowerCase().split(/\r?\n/).includes(reviewer)) {
    throw new Error("reviewer Git attribution is not independent");
  }
  return { review, bytes, path: request.review_artifact_path, commit: main };
}

function classifyDiff(
  cwd: string,
  base: string,
  candidate: string,
  manifest: FamilyOwnershipManifest,
): { diffClass: "family_local" | "framework"; impacted: string[];
  otherBaseline: string; otherCandidate: string } {
  const changed = gitOut(cwd, ["diff", "--name-only", `${base}..${candidate}`])
    .split(/\r?\n/).filter(isRuntimeFile);
  const impacted = manifest.families.filter((family) =>
    family.source_files.some((file) => changed.includes(`listener/${file}`)))
    .map((family) => family.id).sort();
  const owned = new Set(manifest.families
    .filter((family) => impacted.includes(family.id))
    .flatMap((family) => family.source_files.map((file) => `listener/${file}`)));
  let framework = impacted.length === 0 ||
    changed.some((file) => !owned.has(file) &&
      file !== REGISTRY && file !== ACTION_INDEX);
  for (const [file, kind] of [
    [REGISTRY, "production-registry"], [ACTION_INDEX, "action-index"],
  ] as const) {
    if (changed.includes(file) &&
        familyOwnershipSourceSkeletonSha256(kind,
          gitOut(cwd, ["show", `${base}:${file}`])) !==
        familyOwnershipSourceSkeletonSha256(kind,
          gitOut(cwd, ["show", `${candidate}:${file}`]))) framework = true;
  }
  const otherFiles = [...new Set(manifest.families
    .filter((family) => !impacted.includes(family.id))
    .flatMap((family) => family.source_files.map((file) => `listener/${file}`)))]
    .sort();
  const closure = (commit: string): string => semanticJsonSha256(otherFiles.map(
    (file) => ({ file, sha256: sha256(gitOut(cwd, ["show", `${commit}:${file}`])) }),
  ) as SemanticJson);
  const otherBaseline = closure(base);
  const otherCandidate = closure(candidate);
  if (otherBaseline !== otherCandidate) framework = true;
  return {
    diffClass: framework ? "framework" : "family_local",
    impacted, otherBaseline, otherCandidate,
  };
}

function routeFamilies(
  route: RouteEdge[],
  manifest: FamilyOwnershipManifest,
): string[] {
  const result = new Set<string>();
  for (const edge of route) {
    const matches = manifest.families.filter((family) =>
      family.pool_adapter_ids.includes(edge.adapterId) ||
      family.edge_adapter_ids.includes(edge.adapterId) ||
      family.owned_action_adapter_ids.includes(edge.adapterId));
    if (matches.length !== 1) {
      throw new Error(`route adapter ${edge.adapterId} has ${matches.length} owners`);
    }
    result.add(matches[0].id);
  }
  return [...result].sort();
}

function assertShardCompleteness(raw: RawReplay, required: string[]): void {
  const proof = raw.discovery.shardCompleteness;
  if (stableJson([...proof.requiredFamilyIds].sort()) !== stableJson(required)) {
    throw new Error("shard proof does not bind route families");
  }
  for (const family of required) {
    const shard = proof.familyShards.find((entry: any) => entry.familyId === family);
    if (!shard || shard.status !== "complete" || !shard.required ||
        shard.disposition !== "required" ||
        shard.sourceCoverage.some((source: any) => !source.complete)) {
      throw new Error(`required family ${family} lacks a complete shard`);
    }
  }
}

function createWorktree(cwd: string, temp: string, commit: string): string {
  const target = resolve(temp, "runtime");
  const added = git(cwd, ["worktree", "add", "--detach", target, commit]);
  if (added.status !== 0) throw new Error(added.stderr || "worktree add failed");
  for (const path of ["analysis/node_modules", "listener/node_modules"]) {
    const source = resolve(cwd, path);
    if (!existsSync(source)) throw new Error(`missing trusted toolchain ${path}`);
    symlinkSync(source, resolve(target, path), "dir");
  }
  if (gitOut(target, ["rev-parse", "HEAD"]) !== commit) {
    throw new Error("runtime worktree has wrong commit");
  }
  return target;
}

function loadFamilyManifest(cwd: string): FamilyOwnershipManifest {
  const result = spawnSync(process.execPath, [
    "--import", TSX, resolve(cwd, MANIFEST), "--json",
  ], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "manifest failed");
  const prefix = "ADAPTER_FAMILY_OWNERSHIP_MANIFEST=";
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith(prefix));
  if (!line) throw new Error("family manifest was not emitted");
  return JSON.parse(line.slice(prefix.length)) as FamilyOwnershipManifest;
}

async function standingAnchor(
  provider: ethers.JsonRpcProvider,
  tx: string,
  attestation: TrustedSixStepRuntimeAttestation,
): Promise<SixStepStateAnchor> {
  const receipt = await provider.getTransactionReceipt(tx);
  if (!receipt || receipt.status !== 1 ||
      receipt.blockNumber !== attestation.sample_receipt.block_number ||
      receipt.blockHash.toLowerCase() !== attestation.sample_receipt.block_hash ||
      receipt.index !== attestation.sample_receipt.transaction_index) {
    throw new Error("trusted RPC receipt differs from live attestation");
  }
  const base = receipt.blockNumber - 1;
  const header = await provider.send("eth_getBlockByNumber",
    [`0x${base.toString(16)}`, false]) as { hash: string; stateRoot: string };
  const hash = header.hash.toLowerCase();
  const root = header.stateRoot.toLowerCase();
  if (base !== attestation.parent_block.number ||
      hash !== attestation.parent_block.hash ||
      root !== attestation.parent_block.state_root) {
    throw new Error("trusted RPC parent differs from live attestation");
  }
  return {
    lane: "block_scan_standing",
    opportunity_block: receipt.blockNumber,
    base_block: base,
    base_block_hash: hash,
    base_state_root: root,
    applied_prefix_tx_hashes: [],
    trigger_tx_hash: null,
    target_tx_index: null,
    effective_state_hash: semanticJsonSha256({
      base_block_hash: hash, base_state_root: root,
      applied_prefix_tx_hashes: [],
    }),
  };
}

function validateUniverse(
  paths: { universe_path: string; universe_manifest_path: string },
  universe: Buffer,
  manifest: Buffer,
  attestation: TrustedSixStepRuntimeAttestation,
): PoolUniverseCoverageMetadata {
  if (sha256(universe) !== attestation.universe.sha256 ||
      sha256(manifest) !== attestation.universe_manifest.sha256) {
    throw new Error("local universe does not match live attestation");
  }
  const metadata = loadPoolUniverseCoverageMetadata(
    paths.universe_path, paths.universe_manifest_path,
  );
  if (!metadata.manifestVerified || metadata.source === null) {
    throw new Error("universe manifest failed content/window verification");
  }
  return metadata;
}

async function assertCanonicalUniverse(
  provider: ethers.JsonRpcProvider,
  metadata: PoolUniverseCoverageMetadata,
): Promise<void> {
  const source = metadata.source!;
  const header = await provider.send("eth_getBlockByNumber",
    [`0x${source.number.toString(16)}`, false]) as
    { number: string; hash: string; stateRoot: string };
  if (!poolUniverseCanonicalAnchorMatches(metadata, {
    number: Number(BigInt(header.number)), hash: header.hash,
    stateRoot: header.stateRoot,
  })) throw new Error("universe source is not canonical on trusted reth");
}

function loadSnapshot(path: string, tx: string): TrustedSixStepInputSnapshot {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const errors = validateTrustedSixStepInputSnapshot(value, tx);
  if (errors.length) throw new Error(`invalid input snapshot: ${errors.join("; ")}`);
  return value as TrustedSixStepInputSnapshot;
}

function assertStable(
  before: TrustedSixStepRuntimeAttestation,
  after: TrustedSixStepRuntimeAttestation,
): void {
  const stable = (value: TrustedSixStepRuntimeAttestation): unknown => ({
    runtime_commit: value.runtime_commit, process: value.process,
    universe: value.universe, universe_manifest: value.universe_manifest,
    pool_universe_top_n: value.pool_universe_top_n,
    searcher_config: value.searcher_config, sample_receipt: value.sample_receipt,
    parent_block: value.parent_block,
  });
  if (stableJson(stable(before)) !== stableJson(stable(after))) {
    throw new Error("live runtime changed during final validation");
  }
}

export function productionRunnerConfig(
  env: Readonly<Record<string, string>>,
): ProductionRunnerConfig {
  const maxCandidates = positive(env, "SEARCHER_BLOCKSCAN_MAX_CANDIDATES", 100);
  const passBudgetMs = positive(env, "SEARCHER_BLOCKSCAN_PASS_BUDGET_MS", 11_000);
  return {
    maxPools: positive(env, "SEARCHER_POOL_UNIVERSE_TOP_N", 20_000),
    maxHops: positive(env, "SEARCHER_BLOCKSCAN_MAX_HOPS", 4),
    maxCandidates,
    refineCandidates: Math.max(maxCandidates,
      nonNegative(env, "SEARCHER_BLOCKSCAN_REFINE_CANDIDATES", 512)),
    topK: maxCandidates,
    minSpreadBps: nonNegative(env, "SEARCHER_BLOCKSCAN_MIN_SPREAD_BPS", 10),
    prewarmBudgetMs: positive(env,
      "SEARCHER_BLOCKSCAN_STARTUP_PREWARM_BUDGET_MS", 120_000),
    scanBudgetMs: positive(env, "SEARCHER_BLOCKSCAN_SCAN_BUDGET_MS", 1_500),
    passBudgetMs,
    largeGraphPassBudgetMs: Math.max(passBudgetMs, positive(env,
      "SEARCHER_BLOCKSCAN_LARGE_GRAPH_PASS_BUDGET_MS", 30_000)),
    largeGraphEdgeThreshold: positive(env,
      "SEARCHER_BLOCKSCAN_LARGE_GRAPH_EDGE_THRESHOLD", 20_000),
    refineFamilyTimeoutMs: 1_000,
  };
}

export function productionPassBudgetMs(
  config: Pick<ProductionRunnerConfig,
    "passBudgetMs" | "largeGraphPassBudgetMs" | "largeGraphEdgeThreshold">,
  edges: number,
): number {
  return edges >= config.largeGraphEdgeThreshold
    ? config.largeGraphPassBudgetMs : config.passBudgetMs;
}

function parseRequest(value: unknown, cwd: string): SixStepValidationRequest {
  if (!record(value) || value.schema_version !== 1 ||
      value.request !== SIX_STEP_VALIDATION_REQUEST ||
      (value.mode !== "checkpoint" && value.mode !== "final") ||
      typeof value.branch !== "string" ||
      !/^codex\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value.branch) ||
      typeof value.rollback_commit !== "string" ||
      !SHA40.test(value.rollback_commit) ||
      typeof value.sample_tx_hash !== "string" ||
      !HASH32.test(value.sample_tx_hash)) {
    throw new Error("validation request identity is invalid");
  }
  if (value.lane !== "block_scan_standing") {
    throw new Error("backrun is unsupported until full-prefix replay exists");
  }
  const overrides = value.runner_overrides;
  if (overrides !== undefined &&
      (!record(overrides) ||
       Object.keys(overrides).some((key) => key !== "wall_clock_timeout_ms") ||
       (overrides.wall_clock_timeout_ms !== undefined &&
        (!Number.isSafeInteger(overrides.wall_clock_timeout_ms) ||
         Number(overrides.wall_clock_timeout_ms) <= 0)))) {
    throw new Error("only a positive outer wall_clock_timeout_ms may be overridden");
  }
  const common = {
    schema_version: 1 as const, request: SIX_STEP_VALIDATION_REQUEST,
    branch: value.branch, rollback_commit: value.rollback_commit,
    sample_tx_hash: value.sample_tx_hash, lane: "block_scan_standing" as const,
    ...(overrides ? { runner_overrides: overrides } : {}),
  };
  if (value.mode === "checkpoint") {
    if (typeof value.input_snapshot_path !== "string") {
      throw new Error("checkpoint requires input_snapshot_path");
    }
    return {
      ...common, mode: "checkpoint",
      input_snapshot_path: resolve(cwd, value.input_snapshot_path),
    } as CheckpointRequest;
  }
  for (const field of [
    "universe_path", "universe_manifest_path", "checkpoint_receipt_path",
    "review_commit", "review_artifact_path",
  ]) if (typeof value[field] !== "string") {
    throw new Error(`final request requires ${field}`);
  }
  if (!SHA40.test(value.review_commit as string) ||
      !reportPath(value.review_artifact_path as string)) {
    throw new Error("final review commit/path is invalid");
  }
  return {
    ...common, mode: "final",
    universe_path: resolve(cwd, value.universe_path as string),
    universe_manifest_path: resolve(cwd, value.universe_manifest_path as string),
    checkpoint_receipt_path: resolve(cwd, value.checkpoint_receipt_path as string),
    review_commit: value.review_commit as string,
    review_artifact_path: value.review_artifact_path as string,
  } as FinalRequest;
}

function parseFreezeRequest(value: unknown, cwd: string): SixStepInputFreezeRequest {
  if (!record(value) || value.schema_version !== 1 ||
      value.request !== "trusted-six-step-input-freeze-request" ||
      value.lane !== "block_scan_standing" ||
      typeof value.sample_tx_hash !== "string" ||
      !HASH32.test(value.sample_tx_hash) ||
      typeof value.universe_path !== "string" ||
      typeof value.universe_manifest_path !== "string") {
    throw new Error("input freeze request is invalid");
  }
  return {
    schema_version: 1, request: "trusted-six-step-input-freeze-request",
    sample_tx_hash: value.sample_tx_hash, lane: "block_scan_standing",
    universe_path: resolve(cwd, value.universe_path),
    universe_manifest_path: resolve(cwd, value.universe_manifest_path),
  };
}

function parseReview(value: unknown): ReviewArtifact {
  if (!record(value) || value.schema_version !== 1 ||
      value.artifact !== "six-step-independent-review" ||
      typeof value.reviewer_email !== "string" ||
      typeof value.rollback_commit !== "string" ||
      typeof value.reviewed_candidate_commit !== "string" ||
      typeof value.reviewed_merge_commit !== "string" ||
      typeof value.diff_sha256 !== "string" ||
      typeof value.reviewed_at !== "string" ||
      typeof value.evidence !== "string" || value.evidence.length < 20 ||
      value.verdict !== "pass") {
    throw new Error("independent review artifact is invalid");
  }
  return value as unknown as ReviewArtifact;
}

function normalizeEdge(edge: RouteEdge): RouteEdge {
  return {
    ...edge, target: edge.target.toLowerCase(),
    tokenIn: edge.tokenIn.toLowerCase(), tokenOut: edge.tokenOut.toLowerCase(),
    ...(edge.poolId ? { poolId: edge.poolId.toLowerCase() } : {}),
  };
}
function routeScope(
  families: string[],
  manifest: FamilyOwnershipManifest,
): "dex-dex" | "dex-permissionless-protocol" {
  return families.every((id) =>
    manifest.families.find((family) => family.id === id)?.kind === "swap")
    ? "dex-dex" : "dex-permissionless-protocol";
}
function universeFromBlock(bytes: Buffer): number {
  const value = JSON.parse(bytes.toString()) as { fromBlock?: unknown };
  if (!Number.isSafeInteger(value.fromBlock) || Number(value.fromBlock) < 0) {
    throw new Error("universe lacks fromBlock");
  }
  return Number(value.fromBlock);
}
function isRuntimeFile(file: string): boolean {
  return file.startsWith("listener/src/") && !file.includes("/test/") &&
    !file.startsWith("listener/src/shared/evidence/");
}
function reportPath(value: string): boolean {
  return /^docs\/research\/reports\/[A-Za-z0-9._/-]+\.json$/.test(value) &&
    !value.includes("..");
}
function positive(env: Readonly<Record<string, string>>, key: string, fallback: number):
number {
  const value = nonNegative(env, key, fallback);
  if (value <= 0) throw new Error(`${key} must be positive`);
  return value;
}
function nonNegative(
  env: Readonly<Record<string, string>>,
  key: string,
  fallback: number,
): number {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}
function trustedRoot(cwd: string): string {
  const root = gitOut(cwd, ["rev-parse", "--show-toplevel"]);
  const head = gitOut(root, ["rev-parse", "HEAD"]);
  const main = gitOut(root, ["rev-parse", "refs/remotes/origin/main^{commit}"]);
  if (head !== main || gitOut(root, [
    "status", "--porcelain=v1", "--untracked-files=no",
  ])) throw new Error("gate must run from a clean origin/main checkout");
  return root;
}
function ancestor(cwd: string, base: string, head: string): void {
  if (git(cwd, ["merge-base", "--is-ancestor", base, head]).status !== 0) {
    throw new Error(`${base} is not an ancestor of ${head}`);
  }
}
function gitOut(cwd: string, args: readonly string[]): string {
  const result = git(cwd, args);
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim().toLowerCase();
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
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (record(value)) return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
