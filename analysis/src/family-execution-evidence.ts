import { createHash } from "node:crypto";
import {
  SEMANTIC_SIX_STEP_SCHEMA_VERSION,
  semanticSixStepSequenceError,
  type SemanticJson,
  type SemanticSixStepEvidence,
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

export interface FamilyExecutionPromotionJudgment {
  readonly baseCommit: string;
  readonly candidateCommit: string;
  readonly families: readonly string[];
  readonly adapterErrors: readonly string[];
  readonly mergeErrors: readonly string[];
}

/**
 * Validate the native family-execution portion of a trusted historical
 * promotion receipt. Git/deployment/branch policy intentionally lives outside.
 */
export function evaluateFamilyExecutionPromotion(
  value: unknown,
): FamilyExecutionPromotionJudgment {
  if (!record(value)) {
    return {
      baseCommit: "",
      candidateCommit: "",
      families: [],
      adapterErrors: ["promotion_receipt must be an object"],
      mergeErrors: ["family conformance and ownership are unavailable"],
    };
  }
  const baseCommit = text(value.base_commit);
  const candidateCommit = text(value.challenger_commit);
  const adapterErrors: string[] = [];
  if (
    value.schema_version !== 1 ||
    value.gate !== "historical-gap-gate" ||
    value.track !== "family-execution" ||
    !SHA40.test(baseCommit) ||
    !SHA40.test(candidateCommit) ||
    !SHA256.test(text(value.auth_tag)) ||
    !UUID.test(text(value.auth_command_id))
  ) {
    adapterErrors.push(
      "promotion_receipt is not a signed family-execution receipt",
    );
  }
  const artifacts = Array.isArray(value.family_execution_artifacts)
    ? value.family_execution_artifacts
    : [];
  if (artifacts.length === 0) {
    adapterErrors.push("family_execution_artifacts must not be empty");
  }
  const fixtureKeys = new Set<string>();
  const families = new Set<string>();
  for (const [index, artifact] of artifacts.entries()) {
    if (!record(artifact)) {
      adapterErrors.push(
        `family_execution_artifacts[${index}] must be an object`,
      );
      continue;
    }
    const family = text(artifact.execution_family_id);
    const fixture = text(artifact.fixture_sha256);
    const key = `${family}\0${fixture}`;
    if (!FAMILY.test(family) || !SHA256.test(fixture) ||
      fixtureKeys.has(key)) {
      adapterErrors.push(
        `family_execution_artifacts[${index}] identity is invalid or duplicated`,
      );
      continue;
    }
    fixtureKeys.add(key);
    families.add(family);
    adapterErrors.push(...artifactErrors(
      artifact,
      baseCommit,
      candidateCommit,
      index,
    ));
  }
  const familyList = [...families].sort();
  return {
    baseCommit,
    candidateCommit,
    families: familyList,
    adapterErrors,
    mergeErrors: [
      ...conformanceErrors(value.family_conformance),
      ...ownershipErrors(value.family_ownership, familyList),
    ],
  };
}

function artifactErrors(
  artifact: Record<string, unknown>,
  base: string,
  candidate: string,
  index: number,
): string[] {
  const prefix = `family_execution_artifacts[${index}]`;
  const family = text(artifact.execution_family_id);
  const errors = [
    ...sideErrors(artifact.baseline, artifact, family, base, "baseline"),
    ...sideErrors(
      artifact.challenger,
      artifact,
      family,
      candidate,
      "challenger",
    ),
  ];
  for (const field of ["evidence_sha256", "fixture_sha256"] as const) {
    if (!SHA256.test(text(artifact[field]))) {
      errors.push(`${field} is invalid`);
    }
  }
  if (!TX.test(text(artifact.reference_tx))) {
    errors.push("reference_tx is invalid");
  }
  return errors.map((error) => `${prefix}: ${error}`);
}

function sideErrors(
  value: unknown,
  artifact: Record<string, unknown>,
  family: string,
  commit: string,
  side: "baseline" | "challenger",
): string[] {
  if (!record(value)) return [`${side} must be an object`];
  const probe = record(value.probe) ? value.probe : {};
  if (
    probe.schemaVersion !== 1 ||
    probe.executionFamilyId !== family ||
    typeof probe.registered !== "boolean" ||
    !SHA256.test(text(value.output_sha256))
  ) {
    return [`${side} registry probe/output is invalid`];
  }
  if (side === "baseline" && value.status === "family_not_registered") {
    return probe.registered === false && value.replay === null
      ? [] : ["unregistered baseline is inconsistent"];
  }
  const expectedVerdict = side === "challenger"
    ? "adapter_replay_pass" : "implemented_not_validated";
  const replay = record(value.replay) ? value.replay : null;
  const errors = replayErrors(
    replay,
    artifact,
    family,
    commit,
    expectedVerdict,
  );
  if (probe.registered !== true || value.status !== expectedVerdict) {
    errors.push(`${side} status/probe does not match ${expectedVerdict}`);
  }
  if (side === "challenger") {
    if (
      replay?.failure !== null ||
      replay?.failureOwnerFamilyId !== null ||
      replay?.failureIdentity !== null ||
      value.failure_fingerprint_sha256 !== undefined
    ) {
      errors.push("challenger contains failure identity");
    }
    return errors;
  }
  if (!replay) return errors;
  const confirmation = record(value.confirmation_replay)
    ? value.confirmation_replay
    : null;
  const fingerprint = safeFailureFingerprint(replay);
  const confirmationFingerprint = confirmation
    ? safeFailureFingerprint(confirmation) : null;
  errors.push(...replayErrors(
    confirmation,
    artifact,
    family,
    commit,
    "implemented_not_validated",
  ).map((error) => `confirmation ${error}`));
  if (
    !typedFamilyFailure(replay, family) ||
    fingerprint === null ||
    value.failure_fingerprint_sha256 !== fingerprint ||
    value.confirmation_failure_fingerprint_sha256 !== fingerprint ||
    confirmationFingerprint !== fingerprint ||
    !SHA256.test(text(value.confirmation_output_sha256))
  ) {
    errors.push("baseline typed family failure did not reproduce");
  }
  return errors;
}

function replayErrors(
  replay: Record<string, unknown> | null,
  artifact: Record<string, unknown>,
  family: string,
  commit: string,
  verdict: "adapter_replay_pass" | "implemented_not_validated",
): string[] {
  if (!replay) return ["replay must be an object"];
  const evidence = Array.isArray(replay.sixStepEvidence)
    ? replay.sixStepEvidence as SemanticSixStepEvidence[]
    : [];
  const sequence = semanticSixStepSequenceError(evidence);
  const errors: string[] = sequence ? [sequence] : [];
  const routeHash = text(replay.routeHash);
  const referenceRouteHash = replay.referenceRouteHash;
  const routeIdentityValid = verdict === "adapter_replay_pass"
    ? SHA256.test(routeHash) && SHA256.test(text(referenceRouteHash))
    : (routeHash === "" || SHA256.test(routeHash)) &&
      (referenceRouteHash === null ||
        SHA256.test(text(referenceRouteHash)));
  if (
    replay.schemaVersion !== 3 ||
    replay.fixturePath !== artifact.fixture_path ||
    replay.fixtureSha256 !== artifact.fixture_sha256 ||
    text(replay.referenceTx).toLowerCase() !== artifact.reference_tx ||
    replay.landedEvidencePath !== artifact.evidence_path ||
    replay.landedEvidenceSha256 !== artifact.evidence_sha256 ||
    replay.executionFamilyId !== family ||
    replay.adapterCommit !== commit ||
    replay.verdict !== verdict ||
    !routeIdentityValid
  ) {
    errors.push("replay identity/commit/reference route is inconsistent");
  }
  for (const field of [
    "familySourceSha256",
    "sharedApiSha256",
    "runtimeSourceSha256",
    "harnessSha256",
    "botVmArtifactSha256",
  ] as const) {
    if (!SHA256.test(text(replay[field]))) {
      errors.push(`replay ${field} is invalid`);
    }
  }
  if (!sequence && (
    evidence.some((stage) =>
      stage.schema_version !== SEMANTIC_SIX_STEP_SCHEMA_VERSION ||
      stage.profile !== "family_execution"
    ) ||
    evidence[0]?.status !== "bypassed" ||
    evidence[1]?.status !== "bypassed"
  )) {
    errors.push("replay must use current family_execution evidence");
  }
  if (verdict === "adapter_replay_pass" && !sequence) {
    const stages = record(replay.stages) ? replay.stages : {};
    const ev = evidence[5]?.output;
    if (
      evidence.length !== 6 ||
      evidence.slice(2).some((stage) => stage.status !== "pass") ||
      Object.values(stages).length === 0 ||
      Object.values(stages).some((passed) => passed !== true) ||
      ev?.decision !== "allow" ||
      !positiveInteger(ev?.net_ev_wei)
    ) {
      errors.push("adapter replay did not pass quote through positive EV");
    }
  }
  return errors;
}

function typedFamilyFailure(
  replay: Record<string, unknown>,
  family: string,
): boolean {
  const identity = record(replay.failureIdentity)
    ? replay.failureIdentity
    : {};
  const evidence = Array.isArray(replay.sixStepEvidence)
    ? replay.sixStepEvidence as SemanticSixStepEvidence[]
    : [];
  const decisive = evidence.at(-1);
  if (!decisive) return false;
  return replay.failureOwnerFamilyId === family &&
    identity.ownerFamilyId === family &&
    typeof replay.failure === "string" &&
    SEMANTIC_STAGE_IDS.has(text(identity.stageId)) &&
    CODE.test(text(identity.code)) &&
    decisive.stage_id === identity.stageId &&
    decisive.output.failure_owner_family_id === family &&
    decisive.output.failure_stage_id === identity.stageId &&
    decisive.output.failure_code === identity.code &&
    decisive.output.failure_promotable === true;
}

function safeFailureFingerprint(
  replay: Record<string, unknown>,
): string | null {
  try {
    return familyReplayFailureFingerprint(
      replay as unknown as FamilyReplayFingerprintReport,
    );
  } catch {
    return null;
  }
}

function conformanceErrors(value: unknown): string[] {
  const receipt = record(value) ? value : {};
  const checks = Array.isArray(receipt.checks) ? receipt.checks : [];
  const paths = new Set<string>();
  if (receipt.schema_version !== 1 || checks.length === 0) {
    return ["family_conformance is missing"];
  }
  for (const check of checks) {
    if (!record(check) || !text(check.script_path) ||
      paths.has(text(check.script_path)) ||
      !SHA256.test(text(check.source_sha256)) ||
      !SHA256.test(text(check.output_sha256))) {
      return ["family_conformance contains an invalid check"];
    }
    paths.add(text(check.script_path));
  }
  return [];
}

function ownershipErrors(value: unknown, families: readonly string[]): string[] {
  const receipt = record(value) ? value : {};
  const affected = strings(receipt.affected_execution_family_ids);
  const subjects = strings(receipt.subject_execution_family_ids);
  for (const field of [
    "manifest_script_sha256",
    "baseline_manifest_sha256",
    "challenger_manifest_sha256",
    "baseline_registry_skeleton_sha256",
    "challenger_registry_skeleton_sha256",
    "baseline_action_index_skeleton_sha256",
    "challenger_action_index_skeleton_sha256",
  ] as const) {
    if (!SHA256.test(text(receipt[field]))) {
      return ["family_ownership contains an invalid digest"];
    }
  }
  return receipt.schema_version === 1 &&
      sameStrings(affected, families) &&
      sameStrings(subjects, families) &&
      receipt.baseline_registry_skeleton_sha256 ===
        receipt.challenger_registry_skeleton_sha256 &&
      receipt.baseline_action_index_skeleton_sha256 ===
        receipt.challenger_action_index_skeleton_sha256
    ? []
    : ["family_ownership does not exactly cover the replay families"];
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

function positiveInteger(value: unknown): boolean {
  return typeof value === "string" && /^[0-9]+$/.test(value) &&
    BigInt(value) > 0n;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string =>
      typeof item === "string"
    ))].sort()
    : [];
}

const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TX = /^0x[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAMILY = /^[a-z0-9][a-z0-9._:-]*$/;
const CODE = /^[a-z][a-z0-9_]{0,95}$/;
const SEMANTIC_STAGE_IDS = new Set([
  "discovery_admission_graph",
  "route_enumeration",
  "exact_quote_refine",
  "plan_and_size",
  "fork_final_sim",
  "production_ev",
]);
