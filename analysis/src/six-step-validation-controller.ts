import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
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
  type FamilyOwnershipManifest,
} from "../../listener/src/searcher/test/family-ownership-manifest.js";
import {
  EMPTY_SHA256, SIX_STEP_VALIDATION_LIFECYCLE_GATE,
  SIX_STEP_VALIDATION_LIFECYCLE_SCHEMA_VERSION, createGitInspector,
  sixStepLifecycleEnvelopeSha256, sixStepStateAnchorSha256,
  validateSixStepValidationLifecycle, type SixStepCheckpointEvidence,
  type BaselineRouteOutcome, type SixStepFinalEvidence,
  type SixStepStateAnchor,
  type SixStepValidationEvidence,
} from "./six-step-validation-lifecycle.js";
import {
  canonicalTrustedSixStepInputSnapshotPayloadSha256,
  canonicalTrustedSixStepRuntimePayloadSha256,
  fetchTrustedSixStepRuntimeAttestation,
  fetchTrustedSixStepRuntimeJsonInputs,
  openTrustedSixStepRpcTransport,
  validateTrustedSixStepInputSnapshot,
  type TrustedSixStepInputSnapshot, type TrustedSixStepRuntimeAttestation,
  type TrustedSixStepRpcTransport,
} from "./trusted-six-step-runtime-attestation.js";
import {
  evaluateAdapterFamilyBoundary,
  type AdapterFamilyBoundaryResult,
} from "./adapter-family-boundary.js";

export const SIX_STEP_VALIDATION_REQUEST_SCHEMA_VERSION = 2 as const;
export const SIX_STEP_VALIDATION_REQUEST =
  "trusted-six-step-validation-request" as const;
export const SIX_STEP_CONTROLLER_ID =
  "trusted-production-replay-controller" as const;

const CONTROLLER_PATH = fileURLToPath(import.meta.url);
const PRODUCER = "listener/src/searcher/test/production-replay.ts";
const PENDING_EVIDENCE_PRODUCER =
  "listener/src/searcher/test/production-replay-pending-evidence.ts";
const MANIFEST = "listener/src/searcher/test/family-ownership-manifest.ts";
const GRAPH_BUILDER = "listener/src/searcher/planner/token-graph.ts";
const TSX = import.meta.resolve("tsx");
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const HASH32 = /^0x[a-f0-9]{64}$/;
const DEFAULT_WALL_TIMEOUT_MS = 30 * 60 * 1_000;
const TRUSTED_SURFACES = [
  "analysis/src/cli/six-step-validation-gate.ts",
  "analysis/src/six-step-validation-controller.ts",
  "analysis/src/six-step-validation-lifecycle.ts",
  "analysis/src/trusted-six-step-runtime-attestation.ts",
  PRODUCER,
  PENDING_EVIDENCE_PRODUCER,
  MANIFEST,
  "listener/src/searcher/test/adapter-replay.ts",
  "listener/src/searcher/test/blockscan-hunt.ts",
  "listener/src/searcher/test/blockscan-hunt-protocol-cache.ts",
  "listener/src/searcher/test/blockscan-hunt-selection.ts",
  "listener/src/searcher/test/historical-replay-anchor.ts",
  "listener/src/searcher/test/production-replay-artifact.ts",
  "listener/src/searcher/test/production-replay-preload.ts",
  "listener/src/searcher/test/route-execution-witness.ts",
  "listener/src/shared/evidence/canonical-edge-set.ts",
  "listener/src/shared/evidence/semantic-six-step.ts",
] as const;

interface CommonRequest {
  schema_version: 2; request: typeof SIX_STEP_VALIDATION_REQUEST;
  branch: string; rollback_commit: string; sample_tx_hash: string;
  lane: "block_scan_standing";
  trusted_reference_path: string;
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
export interface ProducerExplicitInputBindings {
  universeSha256: string;
  universeManifestSha256: string;
  runtimeJsonInputs: Array<{ key: string; sha256: string }>;
  sha256: string;
}
interface ReviewArtifact {
  schema_version: 2; artifact: "six-step-independent-review";
  reviewer_email: string; rollback_commit: string;
  reviewed_candidate_commit: string; reviewed_merge_commit: string;
  integration_base_commit: string;
  diff_sha256: string; merge_patch_sha256: string;
  candidate_tree_delta_sha256: string;
  overlap_paths: string[];
  reviewed_at: string; evidence: string; verdict: "pass";
}
interface ReviewContext {
  review: ReviewArtifact; bytes: Buffer; path: string; commit: string;
}
export interface SixStepControllerResult {
  evidence: SixStepValidationEvidence; evidencePath: string;
  rawProducerPath: string;
  baselineRawProducerPath: string;
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
  const request = parseSixStepValidationRequest(input.request, cwd);
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

  // The family boundary is deliberately evaluated before live attestation,
  // RPC transport, universe reads, or the production producer. A family that
  // needs central behavior stops here and must continue on a separate branch.
  const temp = realpathSync(mkdtempSync(resolve(tmpdir(), "six-step-")));
  let worktree: string | null = null;
  let boundaryBaseWorktree: string | null = null;
  let boundaryCandidateWorktree: string | null = null;
  let boundary: AdapterFamilyBoundaryResult;
  try {
    boundaryBaseWorktree = createWorktree(
      cwd,
      temp,
      request.rollback_commit,
      "boundary-base",
    );
    const baseManifest = loadFamilyManifest(boundaryBaseWorktree);
    git(cwd, ["worktree", "remove", "--force", boundaryBaseWorktree]);
    boundaryBaseWorktree = null;
    boundaryCandidateWorktree = createWorktree(
      cwd,
      temp,
      tip,
      "boundary-candidate",
    );
    hideTrustedReferencesFromProducerWorktree(boundaryCandidateWorktree);
    const candidateManifest = loadFamilyManifest(boundaryCandidateWorktree);
    boundary = evaluateAdapterFamilyBoundary({
      baseCommit: request.rollback_commit,
      candidateCommit: tip,
      changedPaths: gitOut(cwd, [
        "diff", "--name-only", `${request.rollback_commit}..${tip}`,
      ]).split(/\r?\n/).filter(Boolean),
      baseManifest,
      candidateManifest,
      sourceAt: (commit, path) => gitShowOptional(cwd, commit, path),
    });
    if (boundary.classification !== "family_local") {
      throw new Error(
        `adapter changes left the family boundary: ` +
          `${boundary.reasons.join("; ")}`,
      );
    }
    if (request.mode === "checkpoint") {
      worktree = boundaryCandidateWorktree;
      boundaryCandidateWorktree = null;
    } else {
      git(cwd, [
        "worktree", "remove", "--force", boundaryCandidateWorktree,
      ]);
      boundaryCandidateWorktree = null;
    }
  } catch (error) {
    if (boundaryBaseWorktree) {
      git(cwd, ["worktree", "remove", "--force", boundaryBaseWorktree]);
    }
    if (boundaryCandidateWorktree) {
      git(cwd, ["worktree", "remove", "--force", boundaryCandidateWorktree]);
    }
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }

  const snapshot = request.mode === "checkpoint"
    ? loadSnapshot(request.input_snapshot_path, request.sample_tx_hash) : null;
  if (snapshot && snapshot.source_runtime_commit !== request.rollback_commit) {
    throw new Error("snapshot does not bind rollback_commit");
  }
  const review = request.mode === "final"
    ? loadReview(request, cwd, tip, main) : null;
  if (review) {
    const deployedBoundary = evaluateDeployedMergeBoundary({
      cwd,
      temp,
      review: review.review,
    });
    if (deployedBoundary.classification !== "family_local") {
      throw new Error(
        `deployed merge left the family boundary: ` +
          `${deployedBoundary.reasons.join("; ")}`,
      );
    }
    if (
      stableJson(deployedBoundary.impactedFamilyIds) !==
        stableJson(boundary.impactedFamilyIds)
    ) {
      throw new Error(
        "deployed merge impacted family differs from checkpoint candidate",
      );
    }
    boundary = deployedBoundary;
  }
  const universePath = snapshot?.local_universe.path ??
    (request as FinalRequest).universe_path;
  const manifestPath = snapshot?.local_universe_manifest.path ??
    (request as FinalRequest).universe_manifest_path;
  const universe = readFileSync(universePath);
  const universeManifest = readFileSync(manifestPath);
  const sealedUniversePath = resolve(
    temp,
    `universe-${sha256(universe)}.json`,
  );
  const sealedUniverseManifestPath = resolve(
    temp,
    `universe-manifest-${sha256(universeManifest)}.json`,
  );
  writeReadOnlyInput(sealedUniversePath, universe);
  writeReadOnlyInput(sealedUniverseManifestPath, universeManifest);
  const producerPendingPath = resolve(temp, "natural-output.pending.json");
  const producerSealedPath = resolve(temp, "natural-output.sealed.json");
  const baselineProducerPendingPath = resolve(
    temp,
    "baseline-natural-output.pending.json",
  );
  const baselineProducerSealedPath = resolve(
    temp,
    "baseline-natural-output.sealed.json",
  );
  const rawPath = resolve(temp, "trusted-verifier.json");
  const baselineRawPath = resolve(temp, "baseline-trusted-verifier.json");
  let transport: TrustedSixStepRpcTransport | null = null;
  let baselineWorktree: string | null = null;
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
    const runtimeJsonInputs = await fetchTrustedSixStepRuntimeJsonInputs(before);
    const localRuntimeInputEnv: Record<string, string> = {};
    const localRuntimeInputBindings: Array<{
      key: string;
      path: string;
      sha256: string;
    }> = [];
    for (const [key, bytes] of Object.entries(runtimeJsonInputs)) {
      const attested = before.runtime_json_inputs[key];
      if (!attested) throw new Error(`runtime JSON input is not attested: ${key}`);
      const localPath = resolve(temp, `runtime-input-${attested.sha256}.json`);
      writeFileSync(localPath, bytes, { mode: 0o400 });
      localRuntimeInputEnv[key] = localPath;
      localRuntimeInputBindings.push({
        key,
        path: localPath,
        sha256: attested.sha256,
      });
    }
    transport = await openTrustedSixStepRpcTransport();
    const env = {
      ...before.searcher_config,
      ...localRuntimeInputEnv,
      SEARCHER_POOL_UNIVERSE_PATH: sealedUniversePath,
      SEARCHER_POOL_UNIVERSE_MANIFEST_PATH: sealedUniverseManifestPath,
      PRODUCTION_REPLAY_FROZEN_RUNTIME_JSON_KEYS:
        localRuntimeInputBindings.map((item) => item.key).sort().join(","),
      MAINNET_RPC_URL: transport.rpcUrl,
      SEARCHER_LIVE_RPC_URL: transport.rpcUrl,
    };
    const runner = productionRunnerConfig(env);
    worktree ??= createWorktree(cwd, temp, deployed);
    hideTrustedReferencesFromProducerWorktree(worktree);
    const provider = new ethers.JsonRpcProvider(transport.rpcUrl);
    await assertCanonicalUniverse(provider, coverage);
    const anchor = await standingAnchor(
      provider,
      request.sample_tx_hash,
      before,
    );
    provider.destroy();
    if (snapshot && stableJson(anchor) !== stableJson(snapshot.state_anchor)) {
      throw new Error("checkpoint replay state differs from frozen snapshot");
    }
    baselineWorktree = createWorktree(
      cwd,
      temp,
      request.rollback_commit,
      "baseline-producer",
    );
    hideTrustedReferencesFromProducerWorktree(baselineWorktree);
    const baselineProducerPort = await allocatePort();
    await runTargetBlindProducer({
      request,
      out: baselineProducerPendingPath,
      universe: sealedUniversePath,
      fromBlock: universeFromBlock(universe),
      config: runner,
      runtimeEnv: env,
      cwd: baselineWorktree,
      anchor,
      workspace: resolve(temp, "baseline-target-blind-producer"),
      anvilPort: baselineProducerPort,
    });
    const frozenBaselineProducerSha256 = sealArtifact(
      baselineProducerPendingPath,
      baselineProducerSealedPath,
    );
    const producerPort = await allocatePort();
    await runTargetBlindProducer({
      request,
      out: producerPendingPath,
      universe: sealedUniversePath,
      fromBlock: universeFromBlock(universe),
      config: runner,
      runtimeEnv: env,
      cwd: worktree,
      anchor,
      workspace: resolve(temp, "target-blind-producer"),
      anvilPort: producerPort,
    });
    // The producer process is gone before the controller makes the natural
    // result durable. Only after this same-directory fsync+rename barrier may
    // the target/reference be exposed to rollback/main verification.
    const frozenProducerSha256 = sealArtifact(
      producerPendingPath,
      producerSealedPath,
    );
    // The rollback/main verifier tree is intentionally absent until after the
    // candidate producer has exited and its output is durably sealed.
    boundaryBaseWorktree = createWorktree(
      cwd,
      temp,
      request.rollback_commit,
      "verifier-base",
    );
    const trustedReferencePath = resolve(
      boundaryBaseWorktree,
      request.trusted_reference_path,
    );
    const trustedReferenceSha256 = sha256(
      readFileSync(trustedReferencePath),
    );
    const verifierPort = await allocatePort();
    await runTargetAwareVerifier({
      request,
      out: rawPath,
      producerArtifact: producerSealedPath,
      producerArtifactSha256: frozenProducerSha256,
      trustedReference: trustedReferencePath,
      trustedReferenceSha256,
      runtimeEnv: env,
      cwd: boundaryBaseWorktree,
      anvilPort: verifierPort,
    });
    const baselineVerifierPort = await allocatePort();
    await runTargetAwareVerifier({
      request,
      out: baselineRawPath,
      producerArtifact: baselineProducerSealedPath,
      producerArtifactSha256: frozenBaselineProducerSha256,
      trustedReference: trustedReferencePath,
      trustedReferenceSha256,
      runtimeEnv: env,
      cwd: boundaryBaseWorktree,
      anvilPort: baselineVerifierPort,
    });
    assertFrozenArtifactsUnchanged([
      {
        path: producerSealedPath,
        sha256: frozenProducerSha256,
      },
      {
        path: trustedReferencePath,
        sha256: trustedReferenceSha256,
      },
      {
        path: baselineProducerSealedPath,
        sha256: frozenBaselineProducerSha256,
      },
    ]);
    for (const binding of localRuntimeInputBindings) {
      if (sha256(readFileSync(binding.path)) !== binding.sha256) {
        throw new Error("candidate mutated a frozen runtime JSON input");
      }
    }
    assertFrozenArtifactsUnchanged([
      { path: sealedUniversePath, sha256: sha256(universe) },
      {
        path: sealedUniverseManifestPath,
        sha256: sha256(universeManifest),
      },
    ]);
    const expectedExplicitInputBindings =
      expectedProducerExplicitInputBindings({
        universeSha256: sha256(universe),
        universeManifestSha256: sha256(universeManifest),
        runtimeJsonInputs: localRuntimeInputBindings,
      });
    const rawBytes = readFileSync(rawPath);
    const raw = parseRaw(
      rawBytes,
      request,
      runner,
      expectedExplicitInputBindings,
    );
    const baselineRawBytes = readFileSync(baselineRawPath);
    const baselineOutcome = parseBaselineRouteOutcome(
      baselineRawBytes,
      request,
      runner,
      {
        baselineCommit: request.rollback_commit,
        producerArtifactSha256: frozenBaselineProducerSha256,
        trustedReferenceArtifactSha256: trustedReferenceSha256,
        targetRouteSha256: raw.reference.trustedRouteSha256,
        explicitInputBindings: expectedExplicitInputBindings,
      },
    );
    if (
      raw.reference.trustedReferenceArtifactSha256 !==
        trustedReferenceSha256
    ) {
      throw new Error("trusted verifier receipt does not bind reference bytes");
    }
    const familyManifest = loadFamilyManifest(worktree);
    const route = raw.selected.route.map(normalizeEdge) as RouteEdge[];
    const routeHash = semanticJsonSha256(route as unknown as SemanticJson);
    if (!raw.producerOutput.naturalRouteSet.routeSha256s.includes(routeHash)) {
      throw new Error("selected route is absent from natural route set");
    }
    const required = routeFamilies(route, familyManifest);
    assertImpactedFamilyParticipates(
      boundary.impactedFamilyIds,
      required,
    );
    assertRouteExecutionOwnership(
      raw.selected,
      route,
      familyManifest,
    );
    assertShardCompleteness(raw, required, familyManifest);
    const complete = raw.discovery.shardCompleteness.familyShards
      .filter((shard: any) => shard.status === "complete")
      .map((shard: any) => shard.familyId).sort();
    const impacted = [...boundary.impactedFamilyIds].sort();
    assertPendingExecutionEvidence(
      raw,
      required,
      familyManifest,
      request.sample_tx_hash,
      anchor,
    );
    if (raw.stateAnchor.blockNumber !== anchor.base_block ||
        raw.sourceWindow.toBlock !== anchor.base_block) {
      throw new Error("producer does not bind the sample parent block");
    }
    const anchorHash = sixStepStateAnchorSha256(
      anchor as unknown as Readonly<Record<string, unknown>>,
    );
    const rawHash = sha256(rawBytes);
    const baselineRawHash = sha256(baselineRawBytes);
    const runId = semanticJsonSha256({
      baseline_raw_producer_receipt_sha256: baselineRawHash,
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
        baseline_raw_producer_receipt_sha256: baselineRawHash,
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
        target_blind_producer_artifact_sha256: frozenProducerSha256,
        baseline_target_blind_producer_artifact_sha256:
          frozenBaselineProducerSha256,
        trusted_reference_artifact_sha256: trustedReferenceSha256,
        producer_sha256: executedTrustedSourceSha256(
          cwd,
          worktree,
          PRODUCER,
        ),
        pending_evidence_producer_sha256:
          executedTrustedSourceSha256(
            cwd,
            worktree,
            PENDING_EVIDENCE_PRODUCER,
          ),
        pending_evidence_artifact_sha256:
          raw.executionEvidence.artifactSha256,
        pending_evidence_required_sha256:
          requiredPendingExecutionEvidenceSha256(raw.executionEvidence),
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
      diff_class: boundary.classification,
      impacted_family_ids: impacted,
      required_family_ids: required,
      complete_family_ids: complete,
      central_behavior_diff_sha256: EMPTY_SHA256,
      other_family_source_set_baseline_sha256:
        boundary.otherFamilySourceSetBaselineSha256,
      other_family_source_set_challenger_sha256:
        boundary.otherFamilySourceSetCandidateSha256,
      exact_production_caps: true,
      runner_overrides: request.runner_overrides?.wall_clock_timeout_ms
        ? { wall_clock_timeout_ms: request.runner_overrides.wall_clock_timeout_ms }
        : {},
      production_route_stage: stages,
      baseline_route_outcome: baselineOutcome,
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
    const durableBaselineRaw =
      `${input.evidencePath}.baseline.producer.json`;
    writeFileSync(durableBaselineRaw, baselineRawBytes, { mode: 0o600 });
    return {
      evidence,
      evidencePath: input.evidencePath,
      rawProducerPath: durableRaw,
      baselineRawProducerPath: durableBaselineRaw,
    };
  } finally {
    await transport?.close();
    if (worktree) git(cwd, ["worktree", "remove", "--force", worktree]);
    if (boundaryBaseWorktree) {
      git(cwd, ["worktree", "remove", "--force", boundaryBaseWorktree]);
    }
    if (boundaryCandidateWorktree) {
      git(cwd, ["worktree", "remove", "--force", boundaryCandidateWorktree]);
    }
    if (baselineWorktree) {
      git(cwd, ["worktree", "remove", "--force", baselineWorktree]);
    }
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
  const checkpointBaseline = checkpoint.baseline_route_outcome as
    Record<string, unknown>;
  const finalBaseline = common.baseline_route_outcome as
    Record<string, unknown>;
  for (const field of [
    "baseline_commit",
    "target_route_sha256",
    "highest_passed_step",
    "first_unpassed_step",
    "natural_route_set_sha256",
    "materialized_graph_sha256",
  ]) {
    if (checkpointBaseline[field] !== finalBaseline[field]) {
      throw new Error(`final does not match checkpoint baseline ${field}`);
    }
  }
  const checkpointFrozen = checkpoint.frozen_inputs as
    Record<string, unknown>;
  const finalFrozen = common.frozen_inputs as Record<string, unknown>;
  for (const field of [
    "producer_sha256",
    "pending_evidence_producer_sha256",
    "pending_evidence_required_sha256",
    "trusted_reference_artifact_sha256",
  ]) {
    if (checkpointFrozen[field] !== finalFrozen[field]) {
      throw new Error(`final does not match checkpoint frozen_inputs.${field}`);
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
      integration_base_commit: review.integration_base_commit,
      diff_sha256: review.diff_sha256,
      merge_patch_sha256: review.merge_patch_sha256,
      candidate_tree_delta_sha256:
        review.candidate_tree_delta_sha256,
      overlap_paths: review.overlap_paths,
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
    execution_evidence: raw.executionEvidence,
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

async function runTargetBlindProducer(input: {
  request: SixStepValidationRequest;
  out: string;
  universe: string;
  fromBlock: number;
  config: ProductionRunnerConfig;
  runtimeEnv: Record<string, string>;
  cwd: string;
  anchor: SixStepStateAnchor;
  workspace: string;
  anvilPort: number;
}): Promise<void> {
  const {
    request,
    out,
    universe,
    fromBlock,
    config,
    runtimeEnv,
    cwd,
    anchor,
    workspace,
    anvilPort,
  } = input;
  const args = targetBlindProducerArgs({
    producerPath: resolve(cwd, PRODUCER),
    anchor,
    fromBlock,
    universe,
    anvilPort,
    workspace,
    config,
    out,
  });
  assertTargetAbsentFromProcessInput(
    request.sample_tx_hash,
    args,
    runtimeEnv,
    "target-blind producer",
  );
  const env = isolatedChildEnvironment(runtimeEnv);
  const timeout = request.runner_overrides?.wall_clock_timeout_ms ??
    DEFAULT_WALL_TIMEOUT_MS;
  await runReplayChild({
    args,
    cwd,
    env,
    timeout,
    label: "target-blind producer",
  });
}

export function targetBlindProducerArgs(input: {
  producerPath: string;
  anchor: Pick<
    SixStepStateAnchor,
    "base_block" | "base_block_hash" | "base_state_root"
  >;
  fromBlock: number;
  universe: string;
  anvilPort: number;
  workspace: string;
  config: ProductionRunnerConfig;
  out: string;
}): string[] {
  return [
    "--import", TSX, input.producerPath,
    "--phase", "produce",
    "--base-block", String(input.anchor.base_block),
    "--base-block-hash", input.anchor.base_block_hash,
    "--base-state-root", input.anchor.base_state_root,
    "--source-from-block", String(input.fromBlock),
    "--universe", input.universe,
    "--anvil-port", String(input.anvilPort),
    "--workspace", input.workspace,
    "--max-pools", String(input.config.maxPools),
    "--max-hops", String(input.config.maxHops),
    "--max-candidates", String(input.config.maxCandidates),
    "--top-k", String(input.config.topK),
    "--min-spread-bps", String(input.config.minSpreadBps),
    "--prewarm-budget-ms", String(input.config.prewarmBudgetMs),
    "--scan-budget-ms", String(input.config.scanBudgetMs),
    "--pass-budget-ms", String(input.config.passBudgetMs),
    "--large-graph-pass-budget-ms",
    String(input.config.largeGraphPassBudgetMs),
    "--large-graph-edge-threshold",
    String(input.config.largeGraphEdgeThreshold),
    "--refine-candidates", String(input.config.refineCandidates),
    "--refine-family-timeout-ms",
    String(input.config.refineFamilyTimeoutMs),
    "--out", input.out,
  ];
}

async function runTargetAwareVerifier(input: {
  request: SixStepValidationRequest;
  out: string;
  producerArtifact: string;
  producerArtifactSha256: string;
  trustedReference: string;
  trustedReferenceSha256: string;
  runtimeEnv: Record<string, string>;
  cwd: string;
  anvilPort: number;
}): Promise<void> {
  const args = [
    "--import", TSX, resolve(input.cwd, PRODUCER),
    "--phase", "verify",
    "--winner-tx", input.request.sample_tx_hash,
    "--producer-artifact", input.producerArtifact,
    "--producer-artifact-sha256", input.producerArtifactSha256,
    "--trusted-reference", input.trustedReference,
    "--trusted-reference-sha256", input.trustedReferenceSha256,
    "--anvil-port", String(input.anvilPort),
    "--out", input.out,
  ];
  const timeout =
    input.request.runner_overrides?.wall_clock_timeout_ms ??
      DEFAULT_WALL_TIMEOUT_MS;
  await runReplayChild({
    args,
    cwd: input.cwd,
    env: isolatedChildEnvironment(input.runtimeEnv),
    timeout,
    label: "rollback/main target-aware verifier",
  });
}

async function runReplayChild(input: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  label: string;
}): Promise<void> {
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(
        `${input.label} exceeded outer timeout ${input.timeout}ms`,
      ));
    }, input.timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? done()
        : reject(new Error(`${input.label} exited ${code}`));
    });
  });
}

export function isolatedChildEnvironment(
  runtimeEnv: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowedSearcherKeys: string[] = [];
  for (const key of [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TZ",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(runtimeEnv)) {
    const upper = key.toUpperCase();
    if (
      upper.startsWith("AB_") ||
      upper.startsWith("HUNT_") ||
      upper.includes("EXPECTED") ||
      upper.includes("TARGET") ||
      upper.includes("WINNER") ||
      upper.includes("REFERENCE")
    ) {
      continue;
    }
    env[key] = value;
    if (/^SEARCHER_[A-Z0-9_]+$/.test(key)) {
      allowedSearcherKeys.push(key);
    }
  }
  env.PRODUCTION_REPLAY_ALLOWED_SEARCHER_CONFIG_KEYS =
    [...new Set(allowedSearcherKeys)].sort().join(",");
  env.SEARCHER_TEST_DISABLE_DOTENV = "1";
  return env;
}

export function assertTargetAbsentFromProcessInput(
  targetTxHash: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  label: string,
): void {
  const needle = targetTxHash.toLowerCase();
  if (
    args.some((entry) => entry.toLowerCase().includes(needle)) ||
    Object.entries(env).some(([key, value]) =>
      key.toLowerCase().includes(needle) ||
      value.toLowerCase().includes(needle))
  ) {
    throw new Error(`${label} process input contains target transaction`);
  }
}

export function sealArtifact(
  pendingPath: string,
  sealedPath: string,
): string {
  if (resolve(pendingPath) === resolve(sealedPath) ||
      resolve(pendingPath, "..") !== resolve(sealedPath, "..")) {
    throw new Error("artifact seal requires distinct same-directory paths");
  }
  const pendingFd = openSync(pendingPath, "r");
  try {
    fsyncSync(pendingFd);
  } finally {
    closeSync(pendingFd);
  }
  renameSync(pendingPath, sealedPath);
  chmodSync(sealedPath, 0o400);
  const directoryFd = openSync(resolve(sealedPath, ".."), "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
  return sha256(readFileSync(sealedPath));
}

export function assertFrozenArtifactsUnchanged(
  artifacts: readonly { path: string; sha256: string }[],
): void {
  for (const artifact of artifacts) {
    if (sha256(readFileSync(artifact.path)) !== artifact.sha256) {
      throw new Error(
        `frozen artifact mutated during verification: ${artifact.path}`,
      );
    }
  }
}

export function hideTrustedReferencesFromProducerWorktree(
  worktree: string,
): void {
  const references = resolve(
    worktree,
    "docs/research/references/production-routes",
  );
  rmSync(references, { recursive: true, force: true });
  if (existsSync(references)) {
    throw new Error("target-blind producer worktree still exposes references");
  }
}

function writeReadOnlyInput(path: string, bytes: Buffer): void {
  writeFileSync(path, bytes, { mode: 0o400, flag: "wx" });
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() =>
          reject(new Error("could not allocate loopback port")));
        return;
      }
      server.close((error) =>
        error ? reject(error) : done(address.port));
    });
  });
}

function parseRaw(
  bytes: Buffer,
  request: SixStepValidationRequest,
  runner: ProductionRunnerConfig,
  expectedExplicitInputBindings: ProducerExplicitInputBindings,
): RawReplay {
  const raw = JSON.parse(bytes.toString()) as RawReplay;
  if (raw.schemaVersion !== 5 ||
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
  if (!record(raw.executionEvidence)) {
    throw new Error("producer execution evidence report is missing");
  }
  assertProducerExplicitInputBindings(
    raw.inputs?.explicitInputBindings,
    expectedExplicitInputBindings,
  );
  assertCompleteNaturalScan(raw);
  if (raw.discovery?.evaluationComplete !== true) {
    throw new Error(
      "producer scanner evaluation is incomplete",
    );
  }
  const expected = expectedRunnerEvidence(raw, runner);
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
  if (
    raw.selected.routeSha256 !== routeHash ||
    raw.reference.targetInputVerified !== true ||
    raw.reference.trustedRouteSha256 !== routeHash ||
    raw.reference.frozenHuntArtifactSha256 !==
      raw.producerOutput.frozenHuntArtifact.sha256 ||
    typeof raw.reference.targetInputSha256 !== "string" ||
    !SHA256.test(raw.reference.targetInputSha256) ||
    typeof raw.reference.trustedReferenceArtifactSha256 !== "string" ||
    !SHA256.test(raw.reference.trustedReferenceArtifactSha256)
  ) {
    throw new Error("selected route hash is invalid");
  }
  const first = raw.selected.route[0];
  const last = raw.selected.route.at(-1);
  if (
    !first ||
    !last ||
    first.tokenIn.toLowerCase() !== last.tokenOut.toLowerCase() ||
    raw.selected.profitToken.toLowerCase() !== first.tokenIn.toLowerCase()
  ) {
    throw new Error("selected route does not close in the profit token");
  }
  return raw;
}

function parseBaselineRouteOutcome(
  bytes: Buffer,
  request: SixStepValidationRequest,
  runner: ProductionRunnerConfig,
  expected: {
    baselineCommit: string;
    producerArtifactSha256: string;
    trustedReferenceArtifactSha256: string;
    targetRouteSha256: string;
    explicitInputBindings: ProducerExplicitInputBindings;
  },
): BaselineRouteOutcome {
  const raw = JSON.parse(bytes.toString()) as RawReplay;
  assertProducerExplicitInputBindings(
    raw.inputs?.explicitInputBindings,
    expected.explicitInputBindings,
  );
  assertCompleteNaturalScan(raw);
  if (
    raw.schemaVersion !== 5 ||
    raw.evidenceClass !== "candidate-authored-diagnostic" ||
    raw.trustedAcceptance !== false ||
    raw.laneCoverage !== "parent-block-blockscan" ||
    raw.triggerTx !== null ||
    raw.stateAnchor?.kind !== "parent-block" ||
    raw.winnerTx !== request.sample_tx_hash ||
    raw.inputs?.explicitRouteInjected !== false ||
    raw.inputs?.explicitAmountInjected !== false ||
    raw.inputs?.explicitRouteInputs?.length !== 0 ||
    raw.inputs?.explicitAmountInputs?.length !== 0 ||
    raw.inputs?.amountSource !== "solver" ||
    raw.discovery?.evaluationComplete !== true ||
    stableJson(raw.actualRunnerConfig) !==
      stableJson(expectedRunnerEvidence(raw, runner)) ||
    raw.reference?.trustedReferenceArtifactSha256 !==
      expected.trustedReferenceArtifactSha256 ||
    raw.reference?.targetInputVerified !== true ||
    raw.reference?.trustedRouteSha256 !== expected.targetRouteSha256 ||
    !SHA256.test(String(raw.producerOutput?.naturalRouteSet?.sha256 ?? "")) ||
    !SHA256.test(String(raw.producerOutput?.materializedGraph?.sha256 ?? ""))
  ) {
    throw new Error("baseline replay identity/config binding is invalid");
  }
  const exactCycle =
    raw.reference.exactCycleMatched === true &&
    raw.reference.cycleCandidates === 1;
  const solver = raw.stages?.solver === "pass";
  const finalSim = raw.stages?.finalSim === "pass";
  const ev = raw.stages?.ev === "allow";
  if (
    (solver && !exactCycle) ||
    (finalSim && !solver) ||
    (ev && !finalSim)
  ) {
    throw new Error("baseline replay stages are not monotonic");
  }
  const highestPassedStep = ev
    ? 6
    : finalSim
    ? 5
    : solver
    ? 4
    : exactCycle
    ? 2
    : 0;
  if (highestPassedStep === 6) {
    throw new Error(
      "rollback baseline already passes the target route through final EV",
    );
  }
  if (solver || finalSim) {
    throw new Error(
      "rollback failure after natural solve lacks a typed deterministic " +
        "domain witness",
    );
  }
  if (typeof raw.failure !== "string" || raw.failure.length === 0) {
    throw new Error("baseline replay failure is not recorded");
  }
  const firstUnpassedStep = highestPassedStep + 1;
  return Object.freeze({
    baseline_commit: expected.baselineCommit,
    target_route_sha256: expected.targetRouteSha256,
    highest_passed_step: highestPassedStep,
    first_unpassed_step: firstUnpassedStep,
    raw_producer_receipt_sha256: sha256(bytes),
    target_blind_producer_artifact_sha256:
      expected.producerArtifactSha256,
    natural_route_set_sha256:
      raw.producerOutput.naturalRouteSet.sha256,
    materialized_graph_sha256:
      raw.producerOutput.materializedGraph.sha256,
    failure_sha256: sha256(Buffer.from(raw.failure)),
  });
}

function assertCompleteNaturalScan(raw: RawReplay): void {
  const scan = raw.producerOutput?.scanCompleteness;
  if (!record(scan)) {
    throw new Error(
      "producer scanner output is budget-censored or incomplete",
    );
  }
  exactKeys(scan, [
    "outcome",
    "rankComplete",
    "refinementDeadlineHit",
    "evaluationComplete",
    "enumeratedCount",
    "selectedCount",
    "forcedSelectionCount",
    "scannedPairs",
  ], "producer scan completeness");
  if (
    scan.outcome !== "ran" ||
    scan.rankComplete !== true ||
    scan.refinementDeadlineHit !== false ||
    scan.evaluationComplete !== true ||
    !Number.isSafeInteger(scan.enumeratedCount) ||
    Number(scan.enumeratedCount) < 0 ||
    !Number.isSafeInteger(scan.selectedCount) ||
    Number(scan.selectedCount) < 0 ||
    Number(scan.selectedCount) > Number(scan.enumeratedCount) ||
    scan.forcedSelectionCount !== 0 ||
    !Number.isSafeInteger(scan.scannedPairs) ||
    Number(scan.scannedPairs) < 0
  ) {
    throw new Error(
      "producer scanner output is budget-censored or incomplete",
    );
  }
}

export function expectedProducerExplicitInputBindings(input: {
  universeSha256: string;
  universeManifestSha256: string;
  runtimeJsonInputs: readonly {
    key: string;
    sha256: string;
  }[];
}): ProducerExplicitInputBindings {
  if (
    !SHA256.test(input.universeSha256) ||
    !SHA256.test(input.universeManifestSha256)
  ) {
    throw new Error("expected producer input hash is invalid");
  }
  const runtimeJsonInputs = input.runtimeJsonInputs
    .map(({ key, sha256: digest }) => ({ key, sha256: digest }))
    .sort((left, right) => left.key.localeCompare(right.key));
  if (
    new Set(runtimeJsonInputs.map((item) => item.key)).size !==
      runtimeJsonInputs.length ||
    runtimeJsonInputs.some((item) =>
      !/^SEARCHER_[A-Z0-9_]+$/.test(item.key) ||
      !SHA256.test(item.sha256)
    )
  ) {
    throw new Error("expected runtime JSON input binding is invalid");
  }
  const payload = {
    universeSha256: input.universeSha256,
    universeManifestSha256: input.universeManifestSha256,
    runtimeJsonInputs,
  };
  return {
    ...payload,
    sha256: semanticJsonSha256(payload as unknown as SemanticJson),
  };
}

export function assertProducerExplicitInputBindings(
  value: unknown,
  expected: ProducerExplicitInputBindings,
): void {
  if (!record(value)) {
    throw new Error("producer explicit input binding is missing");
  }
  exactKeys(value, [
    "universeSha256",
    "universeManifestSha256",
    "runtimeJsonInputs",
    "sha256",
  ], "producer explicit input binding");
  if (
    stableJson(value) !== stableJson(expected)
  ) {
    throw new Error(
      "producer did not consume the frozen universe/manifest/runtime inputs",
    );
  }
}

function expectedRunnerEvidence(
  raw: RawReplay,
  runner: ProductionRunnerConfig,
): Record<string, number> {
  const edgeCount = raw.producerOutput?.fullGraph?.edgeCount;
  if (!Number.isSafeInteger(edgeCount) || edgeCount < 0) {
    throw new Error("producer full graph edge count is invalid");
  }
  return {
    ...runner,
    basePassBudgetMs: runner.passBudgetMs,
    passBudgetMs: productionPassBudgetMs(runner, edgeCount),
  };
}

export function assertPendingExecutionEvidence(
  raw: RawReplay,
  requiredFamilyIds: readonly string[],
  familyManifest: FamilyOwnershipManifest,
  sampleTxHash: string,
  anchor: SixStepStateAnchor,
): void {
  const report = raw.executionEvidence as Record<string, unknown>;
  exactKeys(report, [
    "schemaVersion", "freezePoint", "artifactSha256",
    "candidateFamilyIds", "attemptedFamilyIds", "requiredFamilyIds",
    "commitments",
  ], "producer execution evidence report");
  if (
    report.schemaVersion !== 1 ||
    report.freezePoint !== "before-natural-route-scan" ||
    typeof report.artifactSha256 !== "string" ||
    !SHA256.test(report.artifactSha256)
  ) {
    throw new Error("producer execution evidence report identity is invalid");
  }
  const pendingFamilies = new Set(
    familyManifest.families
      .filter((family) =>
        family.requires_current_head_execution_evidence === true
      )
      .map((family) => family.id),
  );
  const candidates = exactSortedStringSet(
    report.candidateFamilyIds,
    "candidate execution evidence families",
  );
  const attempted = exactSortedStringSet(
    report.attemptedFamilyIds,
    "attempted execution evidence families",
  );
  if (
    stableJson(candidates) !== stableJson(attempted) ||
    candidates.some((familyId) => !pendingFamilies.has(familyId))
  ) {
    throw new Error(
      "producer execution evidence candidate/attempted set is invalid",
    );
  }
  const expectedRequired = requiredFamilyIds
    .filter((familyId) => pendingFamilies.has(familyId))
    .sort();
  const declaredRequired = exactSortedStringSet(
    report.requiredFamilyIds,
    "required execution evidence families",
  );
  if (
    stableJson(declaredRequired) !== stableJson(expectedRequired) ||
    declaredRequired.some((familyId) => !candidates.includes(familyId))
  ) {
    throw new Error("producer execution evidence required set is invalid");
  }
  if (!Array.isArray(report.commitments)) {
    throw new Error("producer execution evidence commitments are missing");
  }
  const commitments = report.commitments as unknown[];
  if (commitments.length !== expectedRequired.length) {
    throw new Error("producer execution evidence set is incomplete");
  }
  const normalizedTxHash = String(sampleTxHash).toLowerCase();
  const normalizedHeadHash = anchor.base_block_hash.toLowerCase();
  const seen = new Set<string>();
  for (let index = 0; index < commitments.length; index += 1) {
    if (!record(commitments[index])) {
      throw new Error("producer execution evidence commitment is invalid");
    }
    const item = commitments[index] as Record<string, unknown>;
    exactKeys(item, [
      "familyId", "txHash", "headBlockNumber", "headHash",
      "canonicalPayload", "payloadHash", "evidenceHash",
    ], "producer execution evidence commitment");
    const familyId =
      typeof item.familyId === "string" ? item.familyId : "";
    if (
      familyId !== expectedRequired[index] ||
      seen.has(familyId) ||
      typeof item.txHash !== "string" ||
      item.txHash.toLowerCase() !== normalizedTxHash ||
      typeof item.headBlockNumber !== "number" ||
      !Number.isSafeInteger(item.headBlockNumber) ||
      item.headBlockNumber !== anchor.base_block ||
      typeof item.headHash !== "string" ||
      item.headHash.toLowerCase() !== normalizedHeadHash
    ) {
      throw new Error(
        "producer execution evidence family/tx/head binding is invalid",
      );
    }
    seen.add(familyId);
    const canonicalPayload =
      typeof item.canonicalPayload === "string"
        ? item.canonicalPayload
        : "";
    if (
      !ethers.isHexString(canonicalPayload) ||
      ethers.dataLength(canonicalPayload) === 0 ||
      ethers.dataLength(canonicalPayload) > 64 * 1024
    ) {
      throw new Error(
        `producer execution evidence payload is invalid: ${familyId}`,
      );
    }
    const payloadHash = ethers.keccak256(canonicalPayload).toLowerCase();
    if (
      typeof item.payloadHash !== "string" ||
      item.payloadHash.toLowerCase() !== payloadHash
    ) {
      throw new Error(
        `producer execution evidence payload hash is invalid: ${familyId}`,
      );
    }
    const evidenceHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "bytes32", "uint256", "bytes32", "bytes32"],
        [
          familyId,
          normalizedTxHash,
          anchor.base_block,
          normalizedHeadHash,
          payloadHash,
        ],
      ),
    ).toLowerCase();
    if (
      typeof item.evidenceHash !== "string" ||
      item.evidenceHash.toLowerCase() !== evidenceHash
    ) {
      throw new Error(
        `producer execution evidence binding hash is invalid: ${familyId}`,
      );
    }
  }
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
  const parents = gitOut(cwd, [
    "show", "-s", "--format=%P", review.reviewed_merge_commit,
  ]).split(/\s+/).filter(Boolean);
  if (
    parents.length !== 2 ||
    parents[0] !== review.integration_base_commit ||
    parents[1] !== tip
  ) {
    throw new Error(
      "reviewed merge must have integration base first and exact candidate second",
    );
  }
  ancestor(cwd, request.rollback_commit, review.integration_base_commit);
  ancestor(cwd, review.reviewed_merge_commit, main);
  const mergePatch = git(cwd, [
    "diff", "--binary", "--full-index",
    `${review.integration_base_commit}..${review.reviewed_merge_commit}`,
  ]);
  const candidateTreeDelta = git(cwd, [
    "diff", "--binary", "--full-index",
    `${tip}..${review.reviewed_merge_commit}`,
  ]);
  if (
    review.merge_patch_sha256 !== sha256(mergePatch.stdout) ||
    review.candidate_tree_delta_sha256 !==
      sha256(candidateTreeDelta.stdout)
  ) {
    throw new Error("review does not bind actual merge trees");
  }
  const integrationPaths = new Set(changedPaths(
    cwd,
    request.rollback_commit,
    review.integration_base_commit,
  ));
  const overlapPaths = changedPaths(
    cwd,
    request.rollback_commit,
    tip,
  ).filter((path) => integrationPaths.has(path));
  if (stableJson(review.overlap_paths) !== stableJson(overlapPaths)) {
    throw new Error("review does not bind exact integration overlap paths");
  }
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

function evaluateDeployedMergeBoundary(input: {
  cwd: string;
  temp: string;
  review: ReviewArtifact;
}): AdapterFamilyBoundaryResult {
  let baseWorktree: string | null = null;
  let mergeWorktree: string | null = null;
  try {
    baseWorktree = createWorktree(
      input.cwd,
      input.temp,
      input.review.integration_base_commit,
      "merge-boundary-base",
    );
    const baseManifest = loadFamilyManifest(baseWorktree);
    git(input.cwd, ["worktree", "remove", "--force", baseWorktree]);
    baseWorktree = null;
    mergeWorktree = createWorktree(
      input.cwd,
      input.temp,
      input.review.reviewed_merge_commit,
      "merge-boundary-deployed",
    );
    hideTrustedReferencesFromProducerWorktree(mergeWorktree);
    const candidateManifest = loadFamilyManifest(mergeWorktree);
    return evaluateAdapterFamilyBoundary({
      baseCommit: input.review.integration_base_commit,
      candidateCommit: input.review.reviewed_merge_commit,
      changedPaths: changedPaths(
        input.cwd,
        input.review.integration_base_commit,
        input.review.reviewed_merge_commit,
      ),
      baseManifest,
      candidateManifest,
      sourceAt: (commit, path) =>
        gitShowOptional(input.cwd, commit, path),
    });
  } finally {
    if (baseWorktree) {
      git(input.cwd, ["worktree", "remove", "--force", baseWorktree]);
    }
    if (mergeWorktree) {
      git(input.cwd, ["worktree", "remove", "--force", mergeWorktree]);
    }
  }
}

function changedPaths(
  cwd: string,
  base: string,
  head: string,
): string[] {
  const result = git(cwd, [
    "diff", "--name-only", `${base}..${head}`,
  ]);
  if (result.status !== 0) {
    throw new Error(result.stderr || "git diff --name-only failed");
  }
  return [...new Set(
    result.stdout.split(/\r?\n/).filter(Boolean),
  )].sort();
}

function routeFamilies(
  route: RouteEdge[],
  manifest: FamilyOwnershipManifest,
): string[] {
  const result = new Set<string>();
  for (const edge of route) {
    const matches = routeFamilyEntries(edge, manifest);
    if (matches.length !== 1) {
      throw new Error(`route adapter ${edge.adapterId} has ${matches.length} owners`);
    }
    result.add(matches[0].id);
  }
  return [...result].sort();
}

function routeFamilyEntries(
  edge: RouteEdge,
  manifest: FamilyOwnershipManifest,
): FamilyOwnershipManifest["families"][number][] {
  return manifest.families.filter((family) =>
    family.edge_adapter_ids.includes(edge.adapterId));
}

export function assertImpactedFamilyParticipates(
  impactedFamilyIds: readonly string[],
  requiredFamilyIds: readonly string[],
): void {
  if (
    impactedFamilyIds.length !== 1 ||
    impactedFamilyIds.some((familyId) =>
      !requiredFamilyIds.includes(familyId))
  ) {
    throw new Error(
      "family-local candidate is not exercised by the selected route",
    );
  }
}

export function assertRouteExecutionOwnership(
  selected: RawReplay["selected"],
  route: RouteEdge[],
  manifest: FamilyOwnershipManifest,
): void {
  if (
    !record(selected) ||
    !Array.isArray(selected.executionSurfaces) ||
    selected.executionSurfaces.length !== route.length ||
    !Array.isArray(selected.supportActionAdapterIds) ||
    !Array.isArray(selected.supportExecutionCalls) ||
    typeof selected.fundingActionId !== "string"
  ) {
    throw new Error("selected route execution ownership evidence is missing");
  }
  const actionOwner = (actionAdapterId: string): string | null => {
    const owners = manifest.families.filter((family) =>
      family.owned_action_adapter_ids.includes(actionAdapterId));
    if (owners.length > 1) {
      throw new Error(
        `ActionAdapter ${actionAdapterId} has ${owners.length} owners`,
      );
    }
    return owners[0]?.id ?? null;
  };
  const fundingOwner = actionOwner(selected.fundingActionId);
  const fundingFamily = manifest.families.find(
    (family) =>
      family.id === fundingOwner &&
      family.kind === "flash-loan",
  );
  if (!fundingFamily) {
    throw new Error("selected funding ActionAdapter lacks one funding owner");
  }
  const routeFamiliesForSupport =
    new Map<string, FamilyOwnershipManifest["families"][number]>();
  for (let index = 0; index < route.length; index++) {
    const edge = route[index];
    const families = routeFamilyEntries(edge, manifest);
    if (families.length !== 1) {
      throw new Error(
        `route adapter ${edge.adapterId} has ${families.length} owners`,
      );
    }
    const family = families[0];
    routeFamiliesForSupport.set(family.id, family);
    const surface = selected.executionSurfaces[index] as
      Record<string, unknown>;
    if (
      !record(surface) ||
      surface.adapterId !== edge.adapterId ||
      surface.familyId !== family.id ||
      typeof surface.rootActionAdapterId !== "string" ||
      actionOwner(surface.rootActionAdapterId) !== family.id ||
      !Array.isArray(surface.subtreeActionAdapterIds) ||
      surface.subtreeActionAdapterIds.length === 0 ||
      surface.subtreeActionAdapterIds[0] !==
        surface.rootActionAdapterId ||
      !Array.isArray(surface.actionCalls)
    ) {
      throw new Error(
        `route leg ${index + 1} lacks a family-owned execution root`,
      );
    }
    for (const actionAdapterId of surface.subtreeActionAdapterIds) {
      if (typeof actionAdapterId !== "string") {
        throw new Error("route subtree action identity is malformed");
      }
      const owner = actionOwner(actionAdapterId);
      if (
        owner !== family.id &&
        (
          owner !== null ||
          !family.required_action_adapter_ids.includes(actionAdapterId)
        )
      ) {
        throw new Error(
          `route leg ${index + 1} uses foreign action ${actionAdapterId}`,
        );
      }
    }
    for (const call of surface.actionCalls) {
      if (
        !record(call) ||
        typeof call.actionAdapterId !== "string" ||
        !surface.subtreeActionAdapterIds.includes(call.actionAdapterId)
      ) {
        throw new Error("route execution call is outside its subtree");
      }
    }
  }
  const allowedSupport = new Set([
    ...fundingFamily.required_action_adapter_ids,
    ...[...routeFamiliesForSupport.values()].flatMap(
      (family) => family.required_action_adapter_ids,
    ),
  ]);
  for (const actionAdapterId of selected.supportActionAdapterIds) {
    if (
      typeof actionAdapterId !== "string" ||
      actionOwner(actionAdapterId) !== null ||
      !allowedSupport.has(actionAdapterId)
    ) {
      throw new Error(
        `selected plan has undeclared support action ${String(actionAdapterId)}`,
      );
    }
  }
  for (const call of selected.supportExecutionCalls) {
    if (
      !record(call) ||
      typeof call.actionAdapterId !== "string" ||
      !selected.supportActionAdapterIds.includes(call.actionAdapterId)
    ) {
      throw new Error(
        "support execution call is outside the declared support closure",
      );
    }
  }
}

export function assertShardCompleteness(
  raw: RawReplay,
  required: string[],
  manifest: FamilyOwnershipManifest,
): void {
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
    if (shard.sourceKind === "dynamic-discovery") {
      const owned = manifest.families.find((entry) => entry.id === family);
      if (!owned) {
        throw new Error(`required family ${family} is absent from manifest`);
      }
      const expectedSources = [...owned.candidate_source_ids].sort();
      const actualSources = (shard.sourceCoverage as Array<{
        sourceId: string;
      }>).map((source) => source.sourceId).sort();
      if (
        stableJson(expectedSources) !== stableJson(actualSources)
      ) {
        throw new Error(
          `required family ${family} source coverage is not exact`,
        );
      }
    }
  }
}

function createWorktree(
  cwd: string,
  temp: string,
  commit: string,
  name = "runtime",
): string {
  const target = resolve(temp, name);
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

function gitShowOptional(
  cwd: string,
  commit: string,
  path: string,
): string | null {
  const shown = git(cwd, ["show", `${commit}:${path}`]);
  return shown.status === 0 ? shown.stdout : null;
}

function loadFamilyManifest(cwd: string): FamilyOwnershipManifest {
  const env: NodeJS.ProcessEnv = {
    SEARCHER_TEST_DISABLE_DOTENV: "1",
  };
  for (const key of [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TZ",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const result = spawnSync(process.execPath, [
    "--import", TSX, resolve(cwd, MANIFEST), "--json",
  ], { cwd, encoding: "utf8", env });
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
    runtime_json_inputs: value.runtime_json_inputs,
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

export function parseSixStepValidationRequest(
  value: unknown,
  cwd: string,
): SixStepValidationRequest {
  if (
      !record(value) ||
      value.schema_version !== SIX_STEP_VALIDATION_REQUEST_SCHEMA_VERSION ||
      value.request !== SIX_STEP_VALIDATION_REQUEST ||
      (value.mode !== "checkpoint" && value.mode !== "final") ||
      typeof value.branch !== "string" ||
      !/^codex\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value.branch) ||
      typeof value.rollback_commit !== "string" ||
      !SHA40.test(value.rollback_commit) ||
      typeof value.sample_tx_hash !== "string" ||
      !HASH32.test(value.sample_tx_hash) ||
      typeof value.trusted_reference_path !== "string" ||
      !trustedReferencePath(value.trusted_reference_path)) {
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
    schema_version: SIX_STEP_VALIDATION_REQUEST_SCHEMA_VERSION,
    request: SIX_STEP_VALIDATION_REQUEST,
    branch: value.branch, rollback_commit: value.rollback_commit,
    sample_tx_hash: value.sample_tx_hash, lane: "block_scan_standing" as const,
    trusted_reference_path: value.trusted_reference_path,
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
  if (!record(value) ||
      value.schema_version !== 1 ||
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
  if (!record(value) || value.schema_version !== 2 ||
      value.artifact !== "six-step-independent-review" ||
      typeof value.reviewer_email !== "string" ||
      typeof value.rollback_commit !== "string" ||
      typeof value.reviewed_candidate_commit !== "string" ||
      typeof value.reviewed_merge_commit !== "string" ||
      typeof value.integration_base_commit !== "string" ||
      typeof value.diff_sha256 !== "string" ||
      typeof value.merge_patch_sha256 !== "string" ||
      typeof value.candidate_tree_delta_sha256 !== "string" ||
      !Array.isArray(value.overlap_paths) ||
      value.overlap_paths.some((path) => typeof path !== "string") ||
      typeof value.reviewed_at !== "string" ||
      typeof value.evidence !== "string" || value.evidence.length < 20 ||
      value.verdict !== "pass") {
    throw new Error("independent review artifact is invalid");
  }
  if (
    !SHA40.test(value.integration_base_commit) ||
    !SHA40.test(value.reviewed_merge_commit) ||
    !SHA256.test(value.diff_sha256) ||
    !SHA256.test(value.merge_patch_sha256) ||
    !SHA256.test(value.candidate_tree_delta_sha256) ||
    stableJson(value.overlap_paths) !==
      stableJson([...value.overlap_paths].sort()) ||
    new Set(value.overlap_paths).size !== value.overlap_paths.length
  ) {
    throw new Error("independent review merge binding is invalid");
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
function reportPath(value: string): boolean {
  return /^docs\/research\/reports\/[A-Za-z0-9._/-]+\.json$/.test(value) &&
    !value.includes("..");
}
function trustedReferencePath(value: string): boolean {
  return /^docs\/research\/references\/production-routes\/[A-Za-z0-9._/-]+\.json$/
    .test(value) && !value.includes("..");
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
function executedTrustedSourceSha256(
  trustedRootPath: string,
  executedWorktree: string,
  path: string,
): string {
  const trusted = sha256(readFileSync(resolve(trustedRootPath, path)));
  const executed = sha256(readFileSync(resolve(executedWorktree, path)));
  if (trusted !== executed) {
    throw new Error(`executed trusted producer differs from controller source: ${path}`);
  }
  return executed;
}
function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (stableJson(actual) !== stableJson(wanted)) {
    throw new Error(`${label} fields are invalid`);
  }
}
function exactSortedStringSet(
  value: unknown,
  label: string,
): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} must be a unique string array`);
  }
  const sorted = [...value].sort();
  if (stableJson(sorted) !== stableJson(value)) {
    throw new Error(`${label} must be sorted`);
  }
  return sorted;
}
export function requiredPendingExecutionEvidenceSha256(
  report: RawReplay["executionEvidence"],
): string {
  return sha256(stableJson({
    requiredFamilyIds: report.requiredFamilyIds,
    commitments: report.commitments,
  }));
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
