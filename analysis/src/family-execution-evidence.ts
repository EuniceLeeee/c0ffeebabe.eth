import { createHash } from "node:crypto";
import type {
  SemanticJson,
  SemanticSixStepEvidence,
} from "../../listener/src/shared/evidence/semantic-six-step.js";

export interface FamilyReplayFingerprintReport {
  schemaVersion: number;
  fixtureId: string;
  fixturePath: string;
  fixtureSha256: string;
  referenceTx: string;
  landedEvidencePath: string;
  landedEvidenceSha256: string;
  executionFamilyId: string;
  routeExecutionFamilies: readonly string[];
  stateAnchor: unknown;
  anchorBlockHash: string | null;
  anchorStateRoot: string | null;
  anchorReconstruction: unknown;
  baseCommit: string | null;
  adapterCommit: string | null;
  familySourceSha256: string;
  sharedApiSha256: string;
  runtimeSourceSha256: string;
  harnessSha256: string;
  botVmArtifactSha256: string;
  replayFlash: unknown;
  routeHash: string;
  referenceRouteHash: string | null;
  stages: Record<string, boolean>;
  verdict: string;
  failureOwnerFamilyId: string | null;
  failureIdentity: {
    ownerFamilyId: string;
    stageId: string;
    code: string;
  } | null;
  sixStepEvidence: readonly SemanticSixStepEvidence[];
}

/**
 * Stable identity of one deterministic family-owned failure. Process output,
 * raw error prose, timings and extension diagnostics are deliberately absent.
 */
export function familyReplayFailureFingerprint(
  report: FamilyReplayFingerprintReport,
): string {
  const semanticEvidence = report.sixStepEvidence.map((stage) => ({
    schema_version: stage.schema_version,
    profile: stage.profile,
    step: stage.step,
    stage_id: stage.stage_id,
    status: stage.status,
    output_sha256: stage.output_sha256,
    reason_code: stage.reason_code,
  }));
  return sha256(canonicalJson({
    schema_version: report.schemaVersion,
    fixture_id: report.fixtureId,
    fixture_path: report.fixturePath,
    fixture_sha256: report.fixtureSha256,
    reference_tx: report.referenceTx.toLowerCase(),
    landed_evidence_path: report.landedEvidencePath,
    landed_evidence_sha256: report.landedEvidenceSha256,
    execution_family_id: report.executionFamilyId,
    route_execution_families: [...report.routeExecutionFamilies],
    state_anchor: report.stateAnchor,
    anchor_block_hash: report.anchorBlockHash,
    anchor_state_root: report.anchorStateRoot,
    anchor_reconstruction: report.anchorReconstruction,
    base_commit: report.baseCommit,
    adapter_commit: report.adapterCommit,
    family_source_sha256: report.familySourceSha256,
    shared_api_sha256: report.sharedApiSha256,
    runtime_source_sha256: report.runtimeSourceSha256,
    harness_sha256: report.harnessSha256,
    botvm_artifact_sha256: report.botVmArtifactSha256,
    replay_flash: report.replayFlash,
    route_hash: report.routeHash,
    reference_route_hash: report.referenceRouteHash,
    stages: report.stages,
    verdict: report.verdict,
    failure_owner_family_id: report.failureOwnerFamilyId,
    failure_identity: report.failureIdentity,
    semantic_evidence: semanticEvidence,
  }));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value as SemanticJson);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
