import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  deepFreeze,
  encodeCanonicalBytes,
  hashDomain,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
  type RuntimeAuthorityProjectionV1,
} from "../../runtime-authority/src/index.ts";
import type {
  AttestationIdentityOriginV1,
  AttestationIdentityProofIssueInputV1,
  AttestationOutcomeProofIssueInputV1,
} from "./internal-authority.ts";
import type { CanonicalCutoffV1, CandidateRecordV1 } from "../../discovery/src/index.ts";
import {
  decodeAttestationIdentityObservationV1,
  decodeAttestationIdentityOriginV1,
} from "./internal/identity-proof.ts";

const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;

export const UNSIGNED_DRY_RUN_ATTESTATION_COMMITMENT_DOMAINS_V1 = Object.freeze({
  identityPayload: "aloha/unsigned-dry-run-attestation-identity-commitment/payload/v1",
  identityId: "aloha/unsigned-dry-run-attestation-identity-commitment/id/v1",
  outcomePayload: "aloha/unsigned-dry-run-attestation-outcome-commitment/payload/v1",
  outcomeId: "aloha/unsigned-dry-run-attestation-outcome-commitment/id/v1",
});

export interface UnsignedDryRunIdentityCommitmentPayloadV1 {
  readonly kind: "aloha.unsigned-dry-run-attestation-identity-commitment";
  readonly version: "1";
  readonly authorityClass: "unsigned-dry-run";
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly identityObservation: AttestationIdentityProofIssueInputV1["identityObservation"];
  readonly identitySubjectHash: Hash;
  readonly identitySemanticHash: Hash;
  readonly identityOrigin: AttestationIdentityOriginV1;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly sequence: string;
}

export interface UnsignedDryRunIdentityCommitmentV1
  extends UnsignedDryRunIdentityCommitmentPayloadV1 {
  readonly payloadHash: Hash;
  readonly commitmentHash: Hash;
}

export interface UnsignedDryRunOutcomeCommitmentPayloadV1 {
  readonly kind: "aloha.unsigned-dry-run-attestation-outcome-commitment";
  readonly version: "1";
  readonly authorityClass: "unsigned-dry-run";
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly outcomeBodyHash: Hash;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly sequence: string;
}

export interface UnsignedDryRunOutcomeCommitmentV1
  extends UnsignedDryRunOutcomeCommitmentPayloadV1 {
  readonly payloadHash: Hash;
  readonly commitmentHash: Hash;
}

function nonZeroHash(value: unknown, path: string): Hash {
  const hash = assertHash(value, path);
  if (hash === ZERO_HASH) throw new TypeError(`${path} must be non-zero`);
  return hash;
}

function runtimeAuthority(value: unknown, path: string): RuntimeAuthorityProjectionV1 {
  const projection = decodeRuntimeAuthorityProjectionV1(value);
  if (projection.authorityClass !== "unsigned-dry-run") {
    throw new TypeError(`${path} must carry unsigned-dry-run authority`);
  }
  return projection;
}

function cutoff(value: unknown, path: string): CanonicalCutoffV1 {
  assertExactKeys(value, ["chainId", "number", "hash", "stateRoot"], path);
  const raw = value as Record<string, unknown>;
  return deepFreeze({
    chainId: assertNonEmptyString(raw.chainId, `${path}.chainId`),
    number: assertDecimalString(raw.number, `${path}.number`),
    hash: nonZeroHash(raw.hash, `${path}.hash`),
    stateRoot: nonZeroHash(raw.stateRoot, `${path}.stateRoot`),
  });
}

function identityPayload(value: unknown): UnsignedDryRunIdentityCommitmentPayloadV1 {
  assertExactKeys(value, [
    "kind", "version", "authorityClass", "runtimeAuthority", "runId", "cutoff",
    "candidatePartitionRoot", "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash",
    "identityObservation", "identitySubjectHash", "identitySemanticHash", "identityOrigin",
    "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot", "sequence",
  ], "unsignedDryRunIdentityCommitmentPayload");
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "aloha.unsigned-dry-run-attestation-identity-commitment" || raw.version !== "1") {
    throw new TypeError("unsigned dry-run identity commitment kind/version is invalid");
  }
  if (raw.authorityClass !== "unsigned-dry-run") {
    throw new TypeError("unsigned dry-run identity commitment authority class is invalid");
  }
  const observation = decodeAttestationIdentityObservationV1(
    raw.identityObservation,
    "unsignedDryRunIdentityCommitment.identityObservation",
  );
  const origin = decodeAttestationIdentityOriginV1(
    raw.identityOrigin,
    "unsignedDryRunIdentityCommitment.identityOrigin",
  );
  return deepFreeze({
    kind: raw.kind,
    version: raw.version,
    authorityClass: raw.authorityClass,
    runtimeAuthority: runtimeAuthority(raw.runtimeAuthority, "unsignedDryRunIdentityCommitment.runtimeAuthority"),
    runId: assertNonEmptyString(raw.runId, "unsignedDryRunIdentityCommitment.runId"),
    cutoff: cutoff(raw.cutoff, "unsignedDryRunIdentityCommitment.cutoff"),
    candidatePartitionRoot: nonZeroHash(raw.candidatePartitionRoot, "unsignedDryRunIdentityCommitment.candidatePartitionRoot"),
    familyDefinitionHash: nonZeroHash(raw.familyDefinitionHash, "unsignedDryRunIdentityCommitment.familyDefinitionHash"),
    familyCandidateKey: nonZeroHash(raw.familyCandidateKey, "unsignedDryRunIdentityCommitment.familyCandidateKey"),
    candidateSubjectHash: nonZeroHash(raw.candidateSubjectHash, "unsignedDryRunIdentityCommitment.candidateSubjectHash"),
    identityObservation: observation,
    identitySubjectHash: nonZeroHash(raw.identitySubjectHash, "unsignedDryRunIdentityCommitment.identitySubjectHash"),
    identitySemanticHash: nonZeroHash(raw.identitySemanticHash, "unsignedDryRunIdentityCommitment.identitySemanticHash"),
    identityOrigin: origin,
    attestationAuthorityRoot: nonZeroHash(raw.attestationAuthorityRoot, "unsignedDryRunIdentityCommitment.attestationAuthorityRoot"),
    frameworkAuthorityRoot: nonZeroHash(raw.frameworkAuthorityRoot, "unsignedDryRunIdentityCommitment.frameworkAuthorityRoot"),
    executorAuthorityRoot: nonZeroHash(raw.executorAuthorityRoot, "unsignedDryRunIdentityCommitment.executorAuthorityRoot"),
    sequence: assertDecimalString(raw.sequence, "unsignedDryRunIdentityCommitment.sequence"),
  });
}

function outcomePayload(value: unknown): UnsignedDryRunOutcomeCommitmentPayloadV1 {
  assertExactKeys(value, [
    "kind", "version", "authorityClass", "runtimeAuthority", "runId", "cutoff",
    "candidatePartitionRoot", "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash",
    "outcomeBodyHash", "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot", "sequence",
  ], "unsignedDryRunOutcomeCommitmentPayload");
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "aloha.unsigned-dry-run-attestation-outcome-commitment" || raw.version !== "1") {
    throw new TypeError("unsigned dry-run outcome commitment kind/version is invalid");
  }
  if (raw.authorityClass !== "unsigned-dry-run") {
    throw new TypeError("unsigned dry-run outcome commitment authority class is invalid");
  }
  return deepFreeze({
    kind: raw.kind,
    version: raw.version,
    authorityClass: raw.authorityClass,
    runtimeAuthority: runtimeAuthority(raw.runtimeAuthority, "unsignedDryRunOutcomeCommitment.runtimeAuthority"),
    runId: assertNonEmptyString(raw.runId, "unsignedDryRunOutcomeCommitment.runId"),
    cutoff: cutoff(raw.cutoff, "unsignedDryRunOutcomeCommitment.cutoff"),
    candidatePartitionRoot: nonZeroHash(raw.candidatePartitionRoot, "unsignedDryRunOutcomeCommitment.candidatePartitionRoot"),
    familyDefinitionHash: nonZeroHash(raw.familyDefinitionHash, "unsignedDryRunOutcomeCommitment.familyDefinitionHash"),
    familyCandidateKey: nonZeroHash(raw.familyCandidateKey, "unsignedDryRunOutcomeCommitment.familyCandidateKey"),
    candidateSubjectHash: nonZeroHash(raw.candidateSubjectHash, "unsignedDryRunOutcomeCommitment.candidateSubjectHash"),
    outcomeBodyHash: nonZeroHash(raw.outcomeBodyHash, "unsignedDryRunOutcomeCommitment.outcomeBodyHash"),
    attestationAuthorityRoot: nonZeroHash(raw.attestationAuthorityRoot, "unsignedDryRunOutcomeCommitment.attestationAuthorityRoot"),
    frameworkAuthorityRoot: nonZeroHash(raw.frameworkAuthorityRoot, "unsignedDryRunOutcomeCommitment.frameworkAuthorityRoot"),
    executorAuthorityRoot: nonZeroHash(raw.executorAuthorityRoot, "unsignedDryRunOutcomeCommitment.executorAuthorityRoot"),
    sequence: assertDecimalString(raw.sequence, "unsignedDryRunOutcomeCommitment.sequence"),
  });
}

function identityHashes(payload: UnsignedDryRunIdentityCommitmentPayloadV1) {
  const payloadHash = hashDomain(UNSIGNED_DRY_RUN_ATTESTATION_COMMITMENT_DOMAINS_V1.identityPayload, payload);
  return { payloadHash, commitmentHash: hashDomain(UNSIGNED_DRY_RUN_ATTESTATION_COMMITMENT_DOMAINS_V1.identityId, { payloadHash }) };
}

function outcomeHashes(payload: UnsignedDryRunOutcomeCommitmentPayloadV1) {
  const payloadHash = hashDomain(UNSIGNED_DRY_RUN_ATTESTATION_COMMITMENT_DOMAINS_V1.outcomePayload, payload);
  return { payloadHash, commitmentHash: hashDomain(UNSIGNED_DRY_RUN_ATTESTATION_COMMITMENT_DOMAINS_V1.outcomeId, { payloadHash }) };
}

export function createUnsignedDryRunIdentityCommitmentV1(
  value: UnsignedDryRunIdentityCommitmentPayloadV1,
): UnsignedDryRunIdentityCommitmentV1 {
  const payload = identityPayload(value);
  return deepFreeze({ ...payload, ...identityHashes(payload) });
}

export function decodeUnsignedDryRunIdentityCommitmentV1(value: unknown): UnsignedDryRunIdentityCommitmentV1 {
  assertExactKeys(value, [
    "kind", "version", "authorityClass", "runtimeAuthority", "runId", "cutoff",
    "candidatePartitionRoot", "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash",
    "identityObservation", "identitySubjectHash", "identitySemanticHash", "identityOrigin",
    "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot", "sequence",
    "payloadHash", "commitmentHash",
  ], "unsignedDryRunIdentityCommitment");
  const raw = value as Record<string, unknown>;
  const { payloadHash: _payloadHash, commitmentHash: _commitmentHash, ...payloadFields } = raw;
  const payload = identityPayload(payloadFields);
  const hashes = identityHashes(payload);
  if (raw.payloadHash !== hashes.payloadHash || raw.commitmentHash !== hashes.commitmentHash) {
    throw new TypeError("unsigned dry-run identity commitment hash mismatch");
  }
  return deepFreeze({ ...payload, ...hashes });
}

export function createUnsignedDryRunOutcomeCommitmentV1(
  value: UnsignedDryRunOutcomeCommitmentPayloadV1,
): UnsignedDryRunOutcomeCommitmentV1 {
  const payload = outcomePayload(value);
  return deepFreeze({ ...payload, ...outcomeHashes(payload) });
}

export function decodeUnsignedDryRunOutcomeCommitmentV1(value: unknown): UnsignedDryRunOutcomeCommitmentV1 {
  assertExactKeys(value, [
    "kind", "version", "authorityClass", "runtimeAuthority", "runId", "cutoff",
    "candidatePartitionRoot", "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash",
    "outcomeBodyHash", "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot", "sequence",
    "payloadHash", "commitmentHash",
  ], "unsignedDryRunOutcomeCommitment");
  const raw = value as Record<string, unknown>;
  const { payloadHash: _payloadHash, commitmentHash: _commitmentHash, ...payloadFields } = raw;
  const payload = outcomePayload(payloadFields);
  const hashes = outcomeHashes(payload);
  if (raw.payloadHash !== hashes.payloadHash || raw.commitmentHash !== hashes.commitmentHash) {
    throw new TypeError("unsigned dry-run outcome commitment hash mismatch");
  }
  return deepFreeze({ ...payload, ...hashes });
}

export function unsignedDryRunIdentityCommitmentPayloadFromIssueInputV1(
  runtimeAuthorityInput: RuntimeAuthorityProjectionV1,
  input: Omit<AttestationIdentityProofIssueInputV1, "releaseProvenanceHash" | "releaseAuthorityRoot" | "attestationProofIssuerKeyId">,
  sequence: string,
): UnsignedDryRunIdentityCommitmentPayloadV1 {
  const candidate: Pick<CandidateRecordV1, "familyDefinitionHash" | "familyCandidateKey" | "candidateSubjectHash"> = input.candidate;
  return identityPayload({
    kind: "aloha.unsigned-dry-run-attestation-identity-commitment",
    version: "1",
    authorityClass: "unsigned-dry-run",
    runtimeAuthority: runtimeAuthorityInput,
    runId: input.runId,
    cutoff: input.cutoff,
    candidatePartitionRoot: input.candidatePartitionRoot,
    familyDefinitionHash: candidate.familyDefinitionHash,
    familyCandidateKey: candidate.familyCandidateKey,
    candidateSubjectHash: candidate.candidateSubjectHash,
    identityObservation: input.identityObservation,
    identitySubjectHash: input.identitySubjectHash,
    identitySemanticHash: input.identitySemanticHash,
    identityOrigin: input.identityOrigin,
    attestationAuthorityRoot: input.attestationAuthorityRoot,
    frameworkAuthorityRoot: input.frameworkAuthorityRoot,
    executorAuthorityRoot: input.executorAuthorityRoot,
    sequence,
  });
}

export function unsignedDryRunOutcomeCommitmentPayloadFromIssueInputV1(
  runtimeAuthorityInput: RuntimeAuthorityProjectionV1,
  input: Omit<AttestationOutcomeProofIssueInputV1, "releaseProvenanceHash" | "releaseAuthorityRoot" | "attestationProofIssuerKeyId">,
  sequence: string,
): UnsignedDryRunOutcomeCommitmentPayloadV1 {
  const candidate: Pick<CandidateRecordV1, "familyDefinitionHash" | "familyCandidateKey" | "candidateSubjectHash"> = input.candidate;
  return outcomePayload({
    kind: "aloha.unsigned-dry-run-attestation-outcome-commitment",
    version: "1",
    authorityClass: "unsigned-dry-run",
    runtimeAuthority: runtimeAuthorityInput,
    runId: input.runId,
    cutoff: input.cutoff,
    candidatePartitionRoot: input.candidatePartitionRoot,
    familyDefinitionHash: candidate.familyDefinitionHash,
    familyCandidateKey: candidate.familyCandidateKey,
    candidateSubjectHash: candidate.candidateSubjectHash,
    outcomeBodyHash: input.outcomeBodyHash,
    attestationAuthorityRoot: input.attestationAuthorityRoot,
    frameworkAuthorityRoot: input.frameworkAuthorityRoot,
    executorAuthorityRoot: input.executorAuthorityRoot,
    sequence,
  });
}
