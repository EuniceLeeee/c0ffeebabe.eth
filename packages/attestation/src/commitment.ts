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
} from "./internal-authority.ts";
import type { CanonicalCutoffV1, CandidateRecordV1 } from "../../discovery/src/index.ts";
import {
  decodeAttestationIdentityObservationV1,
  decodeAttestationIdentityOriginV1,
} from "./internal/identity-commitment-codec.ts";

const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;

export const ATTESTATION_COMMITMENT_DOMAINS_V1 = Object.freeze({
  identityPayload: "aloha/attestation-identity-commitment/payload/v1",
  identityId: "aloha/attestation-identity-commitment/id/v1",
  outcomePayload: "aloha/attestation-outcome-commitment/payload/v1",
  outcomeId: "aloha/attestation-outcome-commitment/id/v1",
});

export interface AttestationIdentityCommitmentPayloadV1 {
  readonly kind: "aloha.attestation-identity-commitment";
  readonly version: "1";
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly identityObservation: AttestationIdentityObservationCommitmentV1;
  readonly identitySubjectHash: Hash;
  readonly identitySemanticHash: Hash;
  readonly identityOrigin: AttestationIdentityOriginV1;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly sequence: string;
}

export interface AttestationIdentityObservationCommitmentV1 {
  readonly kind: "identityVerified";
  readonly familyInstanceKey: string;
  readonly identityMemo: import("../../canonical-codec/src/index.ts").CanonicalJson;
  readonly identityMemoHash: Hash;
  readonly descriptorHash: Hash;
  readonly evidenceRoot: Hash;
}

export interface AttestationIdentityCommitmentIssueInputV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly candidate: Pick<CandidateRecordV1, "familyDefinitionHash" | "familyCandidateKey" | "candidateSubjectHash">;
  readonly identityObservation: AttestationIdentityObservationCommitmentV1;
  readonly identitySubjectHash: Hash;
  readonly identitySemanticHash: Hash;
  readonly identityOrigin: AttestationIdentityOriginV1;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
}

export interface AttestationOutcomeCommitmentIssueInputV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly candidate: Pick<CandidateRecordV1, "familyDefinitionHash" | "familyCandidateKey" | "candidateSubjectHash">;
  readonly outcomeBodyHash: Hash;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
}

export interface AttestationIdentityCommitmentV1
  extends AttestationIdentityCommitmentPayloadV1 {
  readonly payloadHash: Hash;
  readonly commitmentHash: Hash;
}

export interface AttestationOutcomeCommitmentPayloadV1 {
  readonly kind: "aloha.attestation-outcome-commitment";
  readonly version: "1";
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

export interface AttestationOutcomeCommitmentV1
  extends AttestationOutcomeCommitmentPayloadV1 {
  readonly payloadHash: Hash;
  readonly commitmentHash: Hash;
}

function nonZeroHash(value: unknown, path: string): Hash {
  const hash = assertHash(value, path);
  if (hash === ZERO_HASH) throw new TypeError(`${path} must be non-zero`);
  return hash;
}

function runtimeAuthority(value: unknown, path: string): RuntimeAuthorityProjectionV1 {
  try {
    return decodeRuntimeAuthorityProjectionV1(value);
  } catch (error) {
    throw new TypeError(`${path} is invalid`, { cause: error });
  }
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

function identityPayload(value: unknown): AttestationIdentityCommitmentPayloadV1 {
  assertExactKeys(value, [
    "kind", "version", "runtimeAuthority", "runId", "cutoff",
    "candidatePartitionRoot", "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash",
    "identityObservation", "identitySubjectHash", "identitySemanticHash", "identityOrigin",
    "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot", "sequence",
  ], "attestationIdentityCommitmentPayload");
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "aloha.attestation-identity-commitment" || raw.version !== "1") {
    throw new TypeError("attestation identity commitment kind/version is invalid");
  }
  const observation = decodeAttestationIdentityObservationV1(
    raw.identityObservation,
    "attestationIdentityCommitment.identityObservation",
  );
  const origin = decodeAttestationIdentityOriginV1(
    raw.identityOrigin,
    "attestationIdentityCommitment.identityOrigin",
  );
  return deepFreeze({
    kind: raw.kind,
    version: raw.version,
    runtimeAuthority: runtimeAuthority(raw.runtimeAuthority, "attestationIdentityCommitment.runtimeAuthority"),
    runId: assertNonEmptyString(raw.runId, "attestationIdentityCommitment.runId"),
    cutoff: cutoff(raw.cutoff, "attestationIdentityCommitment.cutoff"),
    candidatePartitionRoot: nonZeroHash(raw.candidatePartitionRoot, "attestationIdentityCommitment.candidatePartitionRoot"),
    familyDefinitionHash: nonZeroHash(raw.familyDefinitionHash, "attestationIdentityCommitment.familyDefinitionHash"),
    familyCandidateKey: nonZeroHash(raw.familyCandidateKey, "attestationIdentityCommitment.familyCandidateKey"),
    candidateSubjectHash: nonZeroHash(raw.candidateSubjectHash, "attestationIdentityCommitment.candidateSubjectHash"),
    identityObservation: observation,
    identitySubjectHash: nonZeroHash(raw.identitySubjectHash, "attestationIdentityCommitment.identitySubjectHash"),
    identitySemanticHash: nonZeroHash(raw.identitySemanticHash, "attestationIdentityCommitment.identitySemanticHash"),
    identityOrigin: origin,
    attestationAuthorityRoot: nonZeroHash(raw.attestationAuthorityRoot, "attestationIdentityCommitment.attestationAuthorityRoot"),
    frameworkAuthorityRoot: nonZeroHash(raw.frameworkAuthorityRoot, "attestationIdentityCommitment.frameworkAuthorityRoot"),
    executorAuthorityRoot: nonZeroHash(raw.executorAuthorityRoot, "attestationIdentityCommitment.executorAuthorityRoot"),
    sequence: assertDecimalString(raw.sequence, "attestationIdentityCommitment.sequence"),
  });
}

function outcomePayload(value: unknown): AttestationOutcomeCommitmentPayloadV1 {
  assertExactKeys(value, [
    "kind", "version", "runtimeAuthority", "runId", "cutoff",
    "candidatePartitionRoot", "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash",
    "outcomeBodyHash", "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot", "sequence",
  ], "attestationOutcomeCommitmentPayload");
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "aloha.attestation-outcome-commitment" || raw.version !== "1") {
    throw new TypeError("attestation outcome commitment kind/version is invalid");
  }
  return deepFreeze({
    kind: raw.kind,
    version: raw.version,
    runtimeAuthority: runtimeAuthority(raw.runtimeAuthority, "attestationOutcomeCommitment.runtimeAuthority"),
    runId: assertNonEmptyString(raw.runId, "attestationOutcomeCommitment.runId"),
    cutoff: cutoff(raw.cutoff, "attestationOutcomeCommitment.cutoff"),
    candidatePartitionRoot: nonZeroHash(raw.candidatePartitionRoot, "attestationOutcomeCommitment.candidatePartitionRoot"),
    familyDefinitionHash: nonZeroHash(raw.familyDefinitionHash, "attestationOutcomeCommitment.familyDefinitionHash"),
    familyCandidateKey: nonZeroHash(raw.familyCandidateKey, "attestationOutcomeCommitment.familyCandidateKey"),
    candidateSubjectHash: nonZeroHash(raw.candidateSubjectHash, "attestationOutcomeCommitment.candidateSubjectHash"),
    outcomeBodyHash: nonZeroHash(raw.outcomeBodyHash, "attestationOutcomeCommitment.outcomeBodyHash"),
    attestationAuthorityRoot: nonZeroHash(raw.attestationAuthorityRoot, "attestationOutcomeCommitment.attestationAuthorityRoot"),
    frameworkAuthorityRoot: nonZeroHash(raw.frameworkAuthorityRoot, "attestationOutcomeCommitment.frameworkAuthorityRoot"),
    executorAuthorityRoot: nonZeroHash(raw.executorAuthorityRoot, "attestationOutcomeCommitment.executorAuthorityRoot"),
    sequence: assertDecimalString(raw.sequence, "attestationOutcomeCommitment.sequence"),
  });
}

function identityHashes(payload: AttestationIdentityCommitmentPayloadV1) {
  const payloadHash = hashDomain(ATTESTATION_COMMITMENT_DOMAINS_V1.identityPayload, payload);
  return { payloadHash, commitmentHash: hashDomain(ATTESTATION_COMMITMENT_DOMAINS_V1.identityId, { payloadHash }) };
}

function outcomeHashes(payload: AttestationOutcomeCommitmentPayloadV1) {
  const payloadHash = hashDomain(ATTESTATION_COMMITMENT_DOMAINS_V1.outcomePayload, payload);
  return { payloadHash, commitmentHash: hashDomain(ATTESTATION_COMMITMENT_DOMAINS_V1.outcomeId, { payloadHash }) };
}

export function createAttestationIdentityCommitmentV1(
  value: AttestationIdentityCommitmentPayloadV1,
): AttestationIdentityCommitmentV1 {
  const payload = identityPayload(value);
  return deepFreeze({ ...payload, ...identityHashes(payload) });
}

export function decodeAttestationIdentityCommitmentV1(value: unknown): AttestationIdentityCommitmentV1 {
  assertExactKeys(value, [
    "kind", "version", "runtimeAuthority", "runId", "cutoff",
    "candidatePartitionRoot", "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash",
    "identityObservation", "identitySubjectHash", "identitySemanticHash", "identityOrigin",
    "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot", "sequence",
    "payloadHash", "commitmentHash",
  ], "attestationIdentityCommitment");
  const raw = value as Record<string, unknown>;
  const { payloadHash: _payloadHash, commitmentHash: _commitmentHash, ...payloadFields } = raw;
  const payload = identityPayload(payloadFields);
  const hashes = identityHashes(payload);
  if (raw.payloadHash !== hashes.payloadHash || raw.commitmentHash !== hashes.commitmentHash) {
    throw new TypeError("attestation identity commitment hash mismatch");
  }
  return deepFreeze({ ...payload, ...hashes });
}

export function createAttestationOutcomeCommitmentV1(
  value: AttestationOutcomeCommitmentPayloadV1,
): AttestationOutcomeCommitmentV1 {
  const payload = outcomePayload(value);
  return deepFreeze({ ...payload, ...outcomeHashes(payload) });
}

export function decodeAttestationOutcomeCommitmentV1(value: unknown): AttestationOutcomeCommitmentV1 {
  assertExactKeys(value, [
    "kind", "version", "runtimeAuthority", "runId", "cutoff",
    "candidatePartitionRoot", "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash",
    "outcomeBodyHash", "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot", "sequence",
    "payloadHash", "commitmentHash",
  ], "attestationOutcomeCommitment");
  const raw = value as Record<string, unknown>;
  const { payloadHash: _payloadHash, commitmentHash: _commitmentHash, ...payloadFields } = raw;
  const payload = outcomePayload(payloadFields);
  const hashes = outcomeHashes(payload);
  if (raw.payloadHash !== hashes.payloadHash || raw.commitmentHash !== hashes.commitmentHash) {
    throw new TypeError("attestation outcome commitment hash mismatch");
  }
  return deepFreeze({ ...payload, ...hashes });
}

export function attestationIdentityCommitmentPayloadFromIssueInputV1(
  runtimeAuthorityInput: RuntimeAuthorityProjectionV1,
  input: AttestationIdentityCommitmentIssueInputV1,
  sequence: string,
): AttestationIdentityCommitmentPayloadV1 {
  const candidate: Pick<CandidateRecordV1, "familyDefinitionHash" | "familyCandidateKey" | "candidateSubjectHash"> = input.candidate;
  return identityPayload({
    kind: "aloha.attestation-identity-commitment",
    version: "1",
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

export function attestationOutcomeCommitmentPayloadFromIssueInputV1(
  runtimeAuthorityInput: RuntimeAuthorityProjectionV1,
  input: AttestationOutcomeCommitmentIssueInputV1,
  sequence: string,
): AttestationOutcomeCommitmentPayloadV1 {
  const candidate: Pick<CandidateRecordV1, "familyDefinitionHash" | "familyCandidateKey" | "candidateSubjectHash"> = input.candidate;
  return outcomePayload({
    kind: "aloha.attestation-outcome-commitment",
    version: "1",
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
