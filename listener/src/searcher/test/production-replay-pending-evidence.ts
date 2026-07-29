import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ethers } from "ethers";
import type {
  PendingExecutionEvidence,
  PendingTransactionEvidenceInput,
} from "../venues/route-leg-adapter.js";
import type {
  PendingTransactionEvidenceFailure,
  PendingTransactionEvidenceProjection,
  PendingTransactionEvidenceTransport,
} from "../venues/adapter-family-registry.js";

export const FROZEN_PENDING_EXECUTION_EVIDENCE_SCHEMA = 1 as const;
export const PENDING_EXECUTION_EVIDENCE_REPORT_SCHEMA = 1 as const;
const MAX_PENDING_EVIDENCE_PAYLOAD_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const PENDING_EVIDENCE_FAILURE_CODES = new Set([
  "matcher_error",
  "deadline",
  "aborted",
  "read_budget",
  "backend",
  "observer_error",
  "invalid_result",
]);

interface RouteEvidenceOwner {
  readonly id: PendingExecutionEvidence["familyId"];
  readonly pendingTransactionEvidence?: {
    readonly routeActivation?: unknown;
  };
}

interface RouteEvidenceResolver {
  forEdge(edgeAdapterId: string): RouteEvidenceOwner;
}

export interface FrozenPendingExecutionEvidence {
  readonly schemaVersion: typeof FROZEN_PENDING_EXECUTION_EVIDENCE_SCHEMA;
  readonly freezePoint: "before-natural-route-scan";
  readonly txHash: string;
  readonly headBlockNumber: number;
  readonly headHash: string;
  readonly candidateFamilyIds:
    readonly PendingExecutionEvidence["familyId"][];
  readonly attemptedFamilyIds:
    readonly PendingExecutionEvidence["familyId"][];
  readonly successfulFamilyIds:
    readonly PendingExecutionEvidence["familyId"][];
  readonly evidence: readonly PendingExecutionEvidence[];
  readonly failures: readonly PendingTransactionEvidenceFailure[];
}

export interface PendingExecutionEvidenceCommitment {
  readonly familyId: PendingExecutionEvidence["familyId"];
  readonly txHash: string;
  readonly headBlockNumber: number;
  readonly headHash: string;
  readonly canonicalPayload: string;
  readonly payloadHash: string;
  readonly evidenceHash: string;
}

export interface PendingExecutionEvidenceReport {
  readonly schemaVersion: typeof PENDING_EXECUTION_EVIDENCE_REPORT_SCHEMA;
  readonly freezePoint: FrozenPendingExecutionEvidence["freezePoint"];
  readonly artifactSha256: string;
  readonly candidateFamilyIds:
    readonly PendingExecutionEvidence["familyId"][];
  readonly attemptedFamilyIds:
    readonly PendingExecutionEvidence["familyId"][];
  readonly requiredFamilyIds:
    readonly PendingExecutionEvidence["familyId"][];
  readonly commitments: readonly PendingExecutionEvidenceCommitment[];
}

/**
 * Derive the evidence-capable families from a naturally enumerated route.
 * No family, pool, amount, or expected route is accepted as an external hint.
 */
export function pendingExecutionEvidenceFamilyIds(
  route: readonly { readonly adapterId: string }[],
  routes: RouteEvidenceResolver,
): readonly PendingExecutionEvidence["familyId"][] {
  return Object.freeze([
    ...new Set(route.flatMap((edge) => {
      const owner = routes.forEdge(edge.adapterId);
      return owner.pendingTransactionEvidence?.routeActivation ===
          "current-head-block-scan"
        ? [owner.id]
        : [];
    })),
  ].sort());
}

/**
 * Freeze every registry-derived candidate observer at the canonical head
 * before the natural route scan starts. Observer failures remain family-local;
 * they fail validation only when the selected route actually requires that
 * family.
 */
export async function observeFrozenTransactionExecutionEvidence(input: {
  readonly projection: PendingTransactionEvidenceProjection;
  readonly transaction: PendingTransactionEvidenceInput;
  readonly familyRequiresCurrentHeadEvidence: (
    familyId: PendingExecutionEvidence["familyId"],
  ) => boolean;
  readonly transport: PendingTransactionEvidenceTransport;
  readonly timeoutMs: number;
  readonly maxReadsPerFamily: number;
}): Promise<FrozenPendingExecutionEvidence> {
  const candidateFamilyIds = exactUniqueSortedFamilyIds(
    input.projection.candidateFamilyIds(input.transaction).filter(
      input.familyRequiresCurrentHeadEvidence,
    ),
    "candidate",
  );
  const result = await input.projection.observe(
    input.transaction,
    input.transport,
    {
      familyIds: candidateFamilyIds,
      timeoutMs: input.timeoutMs,
      maxReadsPerFamily: input.maxReadsPerFamily,
    },
  );
  const attemptedFamilyIds = exactUniqueSortedFamilyIds(
    result.attemptedFamilyIds,
    "attempted",
  );
  if (!sameStrings(attemptedFamilyIds, candidateFamilyIds)) {
    throw new Error("pending_execution_evidence_attempted_set_mismatch");
  }
  const successfulFamilyIds = exactUniqueSortedFamilyIds(
    result.successfulFamilyIds,
    "successful",
  );
  const candidateSet = new Set(candidateFamilyIds);
  const successfulSet = new Set(successfulFamilyIds);
  if (successfulFamilyIds.some((familyId) => !candidateSet.has(familyId))) {
    throw new Error("pending_execution_evidence_unrequested_success");
  }

  const failureFamilies = new Set<string>();
  const failures = result.failures.map((failure) => {
    if (
      !candidateSet.has(failure.familyId) ||
      failureFamilies.has(failure.familyId)
    ) {
      throw new Error("pending_execution_evidence_failure_set_invalid");
    }
    failureFamilies.add(failure.familyId);
    return Object.freeze({ familyId: failure.familyId, code: failure.code });
  }).sort((a, b) => a.familyId.localeCompare(b.familyId));
  if (
    candidateFamilyIds.some((familyId) =>
      successfulSet.has(familyId) === failureFamilies.has(familyId)
    )
  ) {
    throw new Error("pending_execution_evidence_outcome_partition_invalid");
  }

  const evidenceFamilies = new Set<string>();
  const evidence = result.evidence.map((item) => {
    if (
      !candidateSet.has(item.familyId) ||
      !successfulSet.has(item.familyId) ||
      evidenceFamilies.has(item.familyId)
    ) {
      throw new Error("pending_execution_evidence_result_set_invalid");
    }
    evidenceFamilies.add(item.familyId);
    validatePendingExecutionEvidence(item, {
      txHash: input.transaction.hash,
      headBlockNumber: input.transport.head.number,
      headHash: input.transport.head.hash,
    });
    return freezeEvidence(item);
  }).sort((a, b) => a.familyId.localeCompare(b.familyId));
  if (result.matched !== (evidence.length > 0)) {
    throw new Error("pending_execution_evidence_matched_flag_invalid");
  }

  return Object.freeze({
    schemaVersion: FROZEN_PENDING_EXECUTION_EVIDENCE_SCHEMA,
    freezePoint: "before-natural-route-scan",
    txHash: normalizeHash32(input.transaction.hash, "transaction hash"),
    headBlockNumber: input.transport.head.number,
    headHash: normalizeHash32(input.transport.head.hash, "head hash"),
    candidateFamilyIds,
    attemptedFamilyIds,
    successfulFamilyIds,
    evidence: Object.freeze(evidence),
    failures: Object.freeze(failures),
  });
}

/**
 * Select the exact evidence set required by a naturally enumerated route.
 * Empty, failed, duplicate, or prefilter-unmatched required families fail
 * closed; unrelated observer failures remain isolated.
 */
export function selectFrozenRouteExecutionEvidence(
  frozen: FrozenPendingExecutionEvidence,
  requiredFamilyIds:
    readonly PendingExecutionEvidence["familyId"][],
): readonly PendingExecutionEvidence[] {
  validateFrozenPendingExecutionEvidence(frozen);
  const required = exactUniqueSortedFamilyIds(requiredFamilyIds, "required");
  if (required.length === 0) return Object.freeze([]);
  const candidateSet = new Set(frozen.candidateFamilyIds);
  const evidenceByFamily = new Map(
    frozen.evidence.map((item) => [item.familyId, item]),
  );
  const failuresByFamily = new Map(
    frozen.failures.map((failure) => [failure.familyId, failure.code]),
  );
  const prefilterMisses = required.filter(
    (familyId) => !candidateSet.has(familyId),
  );
  if (prefilterMisses.length > 0) {
    throw new Error(
      `pending_execution_evidence_prefilter_unmatched:${prefilterMisses.join(",")}`,
    );
  }
  const failures = required.flatMap((familyId) => {
    const code = failuresByFamily.get(familyId);
    return code === undefined ? [] : [`${familyId}/${code}`];
  });
  if (failures.length > 0) {
    throw new Error(
      `pending_execution_evidence_observer_failed:${failures.join(",")}`,
    );
  }
  const selected = required.map((familyId) => {
    const evidence = evidenceByFamily.get(familyId);
    if (!evidence) {
      throw new Error(`pending_execution_evidence_cardinality:${familyId}/0`);
    }
    return evidence;
  });
  return Object.freeze(selected);
}

export function writeFrozenPendingExecutionEvidenceArtifact(
  path: string,
  frozen: FrozenPendingExecutionEvidence,
): string {
  validateFrozenPendingExecutionEvidence(frozen);
  const bytes = `${JSON.stringify(frozen, null, 2)}\n`;
  writeFileSync(path, bytes, { encoding: "utf8", mode: 0o600 });
  return sha256(bytes);
}

export function loadFrozenPendingExecutionEvidenceArtifact(
  path: string,
  expectedSha256: string,
): FrozenPendingExecutionEvidence {
  if (!SHA256.test(expectedSha256)) {
    throw new Error("pending execution evidence artifact SHA-256 is invalid");
  }
  const bytes = readFileSync(path);
  if (sha256(bytes) !== expectedSha256) {
    throw new Error("pending execution evidence artifact SHA-256 mismatch");
  }
  const frozen = JSON.parse(bytes.toString("utf8")) as
    FrozenPendingExecutionEvidence;
  validateFrozenPendingExecutionEvidence(frozen);
  return freezeFrozenPendingExecutionEvidence(frozen);
}

export function pendingExecutionEvidenceReport(
  frozen: FrozenPendingExecutionEvidence,
  requiredFamilyIds:
    readonly PendingExecutionEvidence["familyId"][],
  artifactSha256: string,
): PendingExecutionEvidenceReport {
  if (!SHA256.test(artifactSha256)) {
    throw new Error("pending execution evidence report artifact SHA-256 is invalid");
  }
  const required = exactUniqueSortedFamilyIds(requiredFamilyIds, "required");
  const selected = selectFrozenRouteExecutionEvidence(frozen, required);
  return Object.freeze({
    schemaVersion: PENDING_EXECUTION_EVIDENCE_REPORT_SCHEMA,
    freezePoint: frozen.freezePoint,
    artifactSha256,
    candidateFamilyIds: frozen.candidateFamilyIds,
    attemptedFamilyIds: frozen.attemptedFamilyIds,
    requiredFamilyIds: required,
    commitments: pendingExecutionEvidenceCommitments(selected),
  });
}

export function pendingExecutionEvidenceCommitments(
  evidence: readonly PendingExecutionEvidence[],
): readonly PendingExecutionEvidenceCommitment[] {
  return Object.freeze(evidence.map((item) => {
    validatePendingExecutionEvidence(item);
    return Object.freeze({
      familyId: item.familyId,
      txHash: item.txHash.toLowerCase(),
      headBlockNumber: item.headBlockNumber,
      headHash: item.headHash.toLowerCase(),
      canonicalPayload: ethers.hexlify(ethers.getBytes(item.canonicalPayload)),
      payloadHash: item.payloadHash.toLowerCase(),
      evidenceHash: item.evidenceHash.toLowerCase(),
    });
  }));
}

export function validatePendingExecutionEvidence(
  item: PendingExecutionEvidence,
  expected?: {
    readonly txHash: string;
    readonly headBlockNumber: number;
    readonly headHash: string;
  },
): void {
  if (typeof item.familyId !== "string" || item.familyId.length === 0) {
    throw new Error("pending_execution_evidence_family_invalid");
  }
  const txHash = normalizeHash32(item.txHash, "evidence tx hash");
  const headHash = normalizeHash32(item.headHash, "evidence head hash");
  if (!Number.isSafeInteger(item.headBlockNumber) || item.headBlockNumber < 0) {
    throw new Error("pending_execution_evidence_head_number_invalid");
  }
  if (
    !ethers.isHexString(item.canonicalPayload) ||
    ethers.dataLength(item.canonicalPayload) === 0 ||
    ethers.dataLength(item.canonicalPayload) >
      MAX_PENDING_EVIDENCE_PAYLOAD_BYTES
  ) {
    throw new Error("pending_execution_evidence_payload_invalid");
  }
  const payloadHash = ethers.keccak256(item.canonicalPayload).toLowerCase();
  if (payloadHash !== normalizeHash32(item.payloadHash, "payload hash")) {
    throw new Error(`pending_execution_evidence_payload_hash_mismatch:${item.familyId}`);
  }
  const evidenceHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "bytes32", "uint256", "bytes32", "bytes32"],
      [
        item.familyId,
        txHash,
        item.headBlockNumber,
        headHash,
        payloadHash,
      ],
    ),
  ).toLowerCase();
  if (evidenceHash !== normalizeHash32(item.evidenceHash, "evidence hash")) {
    throw new Error(`pending_execution_evidence_binding_hash_mismatch:${item.familyId}`);
  }
  if (
    expected &&
    (
      txHash !== normalizeHash32(expected.txHash, "expected tx hash") ||
      item.headBlockNumber !== expected.headBlockNumber ||
      headHash !== normalizeHash32(expected.headHash, "expected head hash")
    )
  ) {
    throw new Error(`pending_execution_evidence_binding_mismatch:${item.familyId}`);
  }
}

function validateFrozenPendingExecutionEvidence(
  frozen: FrozenPendingExecutionEvidence,
): void {
  if (
    frozen.schemaVersion !== FROZEN_PENDING_EXECUTION_EVIDENCE_SCHEMA ||
    frozen.freezePoint !== "before-natural-route-scan"
  ) {
    throw new Error("pending execution evidence artifact schema is invalid");
  }
  normalizeHash32(frozen.txHash, "artifact transaction hash");
  normalizeHash32(frozen.headHash, "artifact head hash");
  if (
    !Number.isSafeInteger(frozen.headBlockNumber) ||
    frozen.headBlockNumber < 0
  ) {
    throw new Error("pending execution evidence artifact head number is invalid");
  }
  const candidateFamilyIds = exactUniqueSortedFamilyIds(
    frozen.candidateFamilyIds,
    "candidate",
  );
  const attemptedFamilyIds = exactUniqueSortedFamilyIds(
    frozen.attemptedFamilyIds,
    "attempted",
  );
  const successfulFamilyIds = exactUniqueSortedFamilyIds(
    frozen.successfulFamilyIds,
    "successful",
  );
  if (
    !sameStrings(candidateFamilyIds, frozen.candidateFamilyIds) ||
    !sameStrings(attemptedFamilyIds, frozen.attemptedFamilyIds) ||
    !sameStrings(successfulFamilyIds, frozen.successfulFamilyIds) ||
    !sameStrings(candidateFamilyIds, attemptedFamilyIds)
  ) {
    throw new Error("pending execution evidence artifact family order is invalid");
  }
  const candidateSet = new Set(candidateFamilyIds);
  const successfulSet = new Set(successfulFamilyIds);
  if (
    successfulFamilyIds.some((familyId) => !candidateSet.has(familyId))
  ) {
    throw new Error("pending execution evidence artifact successes are invalid");
  }
  const failureSet = new Set<string>();
  for (let index = 0; index < frozen.failures.length; index += 1) {
    const failure = frozen.failures[index];
    if (
      !candidateSet.has(failure.familyId) ||
      failureSet.has(failure.familyId) ||
      !PENDING_EVIDENCE_FAILURE_CODES.has(failure.code) ||
      (
        index > 0 &&
        frozen.failures[index - 1].familyId.localeCompare(failure.familyId) >= 0
      )
    ) {
      throw new Error("pending execution evidence artifact failures are invalid");
    }
    failureSet.add(failure.familyId);
  }
  if (
    candidateFamilyIds.some((familyId) =>
      successfulSet.has(familyId) === failureSet.has(familyId)
    )
  ) {
    throw new Error("pending execution evidence artifact outcomes are invalid");
  }
  const evidenceSet = new Set<string>();
  for (const item of frozen.evidence) {
    if (
      !candidateSet.has(item.familyId) ||
      !successfulSet.has(item.familyId) ||
      evidenceSet.has(item.familyId)
    ) {
      throw new Error("pending execution evidence artifact results are invalid");
    }
    evidenceSet.add(item.familyId);
    validatePendingExecutionEvidence(item, {
      txHash: frozen.txHash,
      headBlockNumber: frozen.headBlockNumber,
      headHash: frozen.headHash,
    });
  }
}

function freezeFrozenPendingExecutionEvidence(
  frozen: FrozenPendingExecutionEvidence,
): FrozenPendingExecutionEvidence {
  return Object.freeze({
    schemaVersion: frozen.schemaVersion,
    freezePoint: frozen.freezePoint,
    txHash: frozen.txHash.toLowerCase(),
    headBlockNumber: frozen.headBlockNumber,
    headHash: frozen.headHash.toLowerCase(),
    candidateFamilyIds: Object.freeze([...frozen.candidateFamilyIds]),
    attemptedFamilyIds: Object.freeze([...frozen.attemptedFamilyIds]),
    successfulFamilyIds: Object.freeze([...frozen.successfulFamilyIds]),
    evidence: Object.freeze(frozen.evidence.map(freezeEvidence)),
    failures: Object.freeze(frozen.failures.map((failure) =>
      Object.freeze({ familyId: failure.familyId, code: failure.code })
    )),
  });
}

function freezeEvidence(
  item: PendingExecutionEvidence,
): PendingExecutionEvidence {
  return Object.freeze({
    familyId: item.familyId,
    txHash: item.txHash.toLowerCase(),
    headBlockNumber: item.headBlockNumber,
    headHash: item.headHash.toLowerCase(),
    canonicalPayload: ethers.hexlify(ethers.getBytes(item.canonicalPayload)),
    payloadHash: item.payloadHash.toLowerCase(),
    evidenceHash: item.evidenceHash.toLowerCase(),
  });
}

function exactUniqueSortedFamilyIds(
  familyIds: readonly PendingExecutionEvidence["familyId"][],
  label: string,
): readonly PendingExecutionEvidence["familyId"][] {
  if (
    !Array.isArray(familyIds) ||
    familyIds.some((familyId) =>
      typeof familyId !== "string" || familyId.length === 0
    ) ||
    new Set(familyIds).size !== familyIds.length
  ) {
    throw new Error(`pending_execution_evidence_${label}_family_set_invalid`);
  }
  return Object.freeze([...familyIds].sort());
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function normalizeHash32(value: string, label: string): string {
  if (!ethers.isHexString(value, 32)) {
    throw new Error(`pending execution evidence ${label} is invalid`);
  }
  return value.toLowerCase();
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
