import {
  assertDecimalString,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalBytes,
  hashCanonicalPartition,
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
  type RuntimeAuthorityProjectionV1,
} from "../../../packages/runtime-authority/src/index.ts";

export interface CanonicalCutoffV1 {
  readonly chainId: string;
  readonly number: string;
  readonly hash: Hash;
  readonly stateRoot: Hash;
}

const CANDIDATE_EVIDENCE_VERSION_V1 = 1 as const;

export interface RecentLogEvidenceRefV1 {
  readonly kind: "recent-log";
  readonly version: typeof CANDIDATE_EVIDENCE_VERSION_V1;
  readonly sourcePlanRef: null;
  readonly ownerRef: null;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly txHash: Hash;
  readonly logIndex: string;
  readonly address: string;
  readonly topic: Hash;
  readonly rawLocatorHash: Hash;
}

export interface SourcePlanEvidenceRefV1 {
  readonly kind: "source-plan";
  readonly version: typeof CANDIDATE_EVIDENCE_VERSION_V1;
  readonly ownerRef: Hash;
  readonly sourcePlanRef: Hash;
  readonly evidenceRef: Hash;
  readonly rawLocatorHash: Hash;
}

export type CandidateEvidenceRefV1 = RecentLogEvidenceRefV1 | SourcePlanEvidenceRefV1;

export interface CandidateRecordV1 {
  readonly kind: "aloha.candidate-record";
  readonly version: "2";
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly instanceNominationKey: string;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly evidence: readonly CandidateEvidenceRefV1[];
}

function cutoff(value: unknown, path: string): CanonicalCutoffV1 {
  return decodeExactObject(value, {
    chainId: (field, fieldPath) => assertNonEmptyString(field, fieldPath),
    number: (field, fieldPath) => assertDecimalString(field, fieldPath),
    hash: (field, fieldPath) => assertHash(field, fieldPath),
    stateRoot: (field, fieldPath) => assertHash(field, fieldPath),
  }, path);
}

function nonZeroHash(value: unknown, path: string): Hash {
  const hash = assertHash(value, path);
  if (hash === `0x${"0".repeat(64)}`) throw new TypeError(`zero hash is not allowed at ${path}`);
  return hash;
}

export const CANDIDATE_PARTITION_COMMITMENT_KIND =
  "aloha.candidate-partition-commitment" as const;
export const CANDIDATE_PARTITION_COMMITMENT_VERSION = "1" as const;
export const CANDIDATE_PARTITION_COMMITMENT_DOMAINS = Object.freeze({
  payload: "aloha/candidate-partition-commitment/payload/v1",
  id: "aloha/candidate-partition-commitment/id/v1",
});

export interface CandidatePartitionCommitmentPayloadV1 {
  readonly kind: typeof CANDIDATE_PARTITION_COMMITMENT_KIND;
  readonly version: typeof CANDIDATE_PARTITION_COMMITMENT_VERSION;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly candidatePartitionStorageHash: Hash;
  readonly nominationClosureRoot: Hash;
  readonly nominationClosureStorageHash: Hash;
  readonly recordCount: string;
  readonly candidateKeysRoot: Hash;
  readonly recentObservationRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly checkpointRevision: string;
}

export interface CandidatePartitionCommitmentV1 extends CandidatePartitionCommitmentPayloadV1 {
  readonly payloadHash: Hash;
  readonly commitmentHash: Hash;
}

/** Process-local handle; cloneable commitment bytes never grant authority. */
export type CandidatePartitionCapabilityV1 = object;

export interface CandidatePartitionReaderPortV1 {
  binding(capability: CandidatePartitionCapabilityV1): CandidatePartitionCommitmentV1;
  listKeys(capability: CandidatePartitionCapabilityV1): readonly Hash[];
  readCandidate(
    capability: CandidatePartitionCapabilityV1,
    familyCandidateKey: Hash,
  ): CandidateRecordV1;
  readRawEvidence(
    capability: CandidatePartitionCapabilityV1,
    familyCandidateKey: Hash,
    rawLocatorHash: Hash,
  ): Uint8Array;
}

export function candidatePartitionKeysRoot(keys: readonly Hash[]): Hash {
  const normalized = keys.map((value, index) => assertHash(value, `candidateKeys[${index}]`));
  const sorted = [...normalized].sort();
  if (new Set(sorted).size !== sorted.length) throw new TypeError("candidate keys must be unique");
  return hashCanonicalPartition("aloha/candidate-partition-keys/v1", sorted);
}

function payload(value: unknown): CandidatePartitionCommitmentPayloadV1 {
  return decodeExactObject(value, {
    kind: (field, path) => {
      if (field !== CANDIDATE_PARTITION_COMMITMENT_KIND) throw new TypeError(`${path} has invalid kind`);
      return CANDIDATE_PARTITION_COMMITMENT_KIND;
    },
    version: (field, path) => {
      if (field !== CANDIDATE_PARTITION_COMMITMENT_VERSION) throw new TypeError(`${path} has invalid version`);
      return CANDIDATE_PARTITION_COMMITMENT_VERSION;
    },
    runtimeAuthority: field => decodeRuntimeAuthorityProjectionV1(field),
    runId: (field, path) => assertNonEmptyString(field, path),
    cutoff,
    candidatePartitionRoot: nonZeroHash,
    candidatePartitionStorageHash: nonZeroHash,
    nominationClosureRoot: nonZeroHash,
    nominationClosureStorageHash: nonZeroHash,
    recordCount: (field, path) => assertDecimalString(field, path),
    candidateKeysRoot: nonZeroHash,
    recentObservationRoot: nonZeroHash,
    sourceCoverageRoot: nonZeroHash,
    checkpointRevision: (field, path) => assertDecimalString(field, path),
  }, "candidatePartitionCommitmentPayload");
}

export function candidatePartitionCommitmentPayloadHashV1(
  value: CandidatePartitionCommitmentPayloadV1,
): Hash {
  return hashDomain(CANDIDATE_PARTITION_COMMITMENT_DOMAINS.payload, payload(value));
}

export function createCandidatePartitionCommitmentV1(
  value: CandidatePartitionCommitmentPayloadV1,
): CandidatePartitionCommitmentV1 {
  const exact = payload(value);
  const payloadHash = candidatePartitionCommitmentPayloadHashV1(exact);
  return deepFreeze({
    ...exact,
    payloadHash,
    commitmentHash: hashDomain(CANDIDATE_PARTITION_COMMITMENT_DOMAINS.id, { payloadHash }),
  });
}

export function decodeCandidatePartitionCommitmentV1(
  value: unknown,
): CandidatePartitionCommitmentV1 {
  const decoded = decodeExactObject(value, {
    kind: field => field,
    version: field => field,
    runtimeAuthority: field => field,
    runId: field => field,
    cutoff: field => field,
    candidatePartitionRoot: field => field,
    candidatePartitionStorageHash: field => field,
    nominationClosureRoot: field => field,
    nominationClosureStorageHash: field => field,
    recordCount: field => field,
    candidateKeysRoot: field => field,
    recentObservationRoot: field => field,
    sourceCoverageRoot: field => field,
    checkpointRevision: field => field,
    payloadHash: nonZeroHash,
    commitmentHash: nonZeroHash,
  }, "candidatePartitionCommitment");
  const { payloadHash, commitmentHash, ...payloadInput } = decoded;
  const exact = payload(payloadInput);
  const expectedPayloadHash = candidatePartitionCommitmentPayloadHashV1(exact);
  if (payloadHash !== expectedPayloadHash) throw new TypeError("candidate partition payload hash mismatch");
  const expectedCommitmentHash = hashDomain(
    CANDIDATE_PARTITION_COMMITMENT_DOMAINS.id,
    { payloadHash },
  );
  if (commitmentHash !== expectedCommitmentHash) {
    throw new TypeError("candidate partition commitment hash mismatch");
  }
  return deepFreeze({ ...exact, payloadHash, commitmentHash });
}

export function encodeCandidatePartitionCommitmentV1(
  value: CandidatePartitionCommitmentV1,
): Uint8Array {
  return encodeCanonicalBytes(decodeCandidatePartitionCommitmentV1(value));
}

export function decodeCandidatePartitionCommitmentBytesV1(
  value: Uint8Array,
): CandidatePartitionCommitmentV1 {
  return decodeCandidatePartitionCommitmentV1(decodeCanonicalJson(value));
}
