import {
  assertDecimalString,
  assertExactKeys,
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

/**
 * Candidate-partition is a frozen wire contract.  Keep the small projections
 * it needs here instead of importing the discovery implementation package;
 * otherwise a discovery/runtime change could silently change the durable
 * proof schema or pull a producer authority into the spec closure.
 */
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

function decodeCanonicalCutoff(value: unknown, name = "canonicalCutoff"): CanonicalCutoffV1 {
  return decodeExactObject(value, {
    chainId: (field, path) => assertNonEmptyString(field, path),
    number: (field, path) => assertDecimalString(field, path),
    hash: (field, path) => assertHash(field, path),
    stateRoot: (field, path) => assertHash(field, path),
  }, name);
}

/**
 * This package is the neutral wire/port contract for the candidate partition.
 * It deliberately does not contain a signer, a private key, a SQLite reader,
 * or a production release resolver.  The release packaging process supplies a
 * signed issuer/verifier port; checkpoint only calls that port.
 */

export const CANDIDATE_PARTITION_PROOF_KIND = "aloha.candidate-partition-proof" as const;
export const CANDIDATE_PARTITION_PROOF_VERSION = "2" as const;
export const CANDIDATE_PARTITION_PROOF_DOMAINS = Object.freeze({
  payload: "aloha/candidate-partition-proof/payload/v2",
  id: "aloha/candidate-partition-proof/id/v2",
  signing: "aloha/candidate-partition-proof/signing/v2",
  capability: "aloha/candidate-partition-capability/v2",
  keys: "aloha/candidate-partition-keys/v2",
});

const signaturePattern = /^0x[0-9a-f]{128}$/;

function signature(value: unknown, path: string): `0x${string}` {
  if (typeof value !== "string" || !signaturePattern.test(value)) {
    throw new TypeError(`expected lowercase Ed25519 signature at ${path}`);
  }
  return value as `0x${string}`;
}

function sameCutoff(left: CanonicalCutoffV1, right: CanonicalCutoffV1): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function nonZeroHash(value: unknown, path: string): Hash {
  const hash = assertHash(value, path);
  if (hash === `0x${"0".repeat(64)}`) throw new TypeError(`zero hash is not allowed at ${path}`);
  return hash;
}

function decimal(value: unknown, path: string): string {
  return assertDecimalString(value, path);
}

export interface CandidatePartitionBindingV1 {
  readonly schemaVersion: "2";
  readonly kind: "aloha.candidate-partition-binding";
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  /** Durable content-envelope hash for the exact candidate manifest. */
  readonly candidatePartitionStorageHash: Hash;
  /** Exact durable nomination-denominator closure that produced this partition. */
  readonly nominationClosureRoot: Hash;
  readonly nominationClosureStorageHash: Hash;
  readonly recordCount: string;
  readonly candidateKeysRoot: Hash;
  readonly recentObservationRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly checkpointRevision: string;
  readonly releaseProvenanceHash: Hash;
  /** Must equal RuntimeReleaseBindingV1.candidatePartitionProofIssuerKeyId. */
  readonly issuerKeyId: Hash;
}

export interface CandidatePartitionProofPayloadV1 extends CandidatePartitionBindingV1 {
  readonly proofVersion: "2";
}

export interface CandidatePartitionProofV1 extends CandidatePartitionProofPayloadV1 {
  readonly proofId: Hash;
  readonly payloadHash: Hash;
  readonly signatureAlgorithm: "ed25519";
  readonly signerKeyId: Hash;
  readonly signatureHex: `0x${string}`;
}

/**
 * Checkpoint never needs the complete signed runtime-release binding.  This
 * is the exact release-owned projection needed to bind a candidate proof;
 * the issuer/verifier keeps any raw release artifact outside this package.
 */
export interface CandidatePartitionProofReleaseBindingV1 {
  readonly releaseProvenanceHash: Hash;
  readonly releaseAuthorityRoot: Hash;
  readonly candidatePartitionProofIssuerKeyId: Hash;
}

/** Exact receipt projection checked by the release owner against its generated
 * source-plan binding and externally signed nomination qualification set. */
export interface CandidateNominationQualificationBindingV1 {
  readonly sourcePlanIdentity: Hash;
  readonly sourcePlanLeafDigest: Hash;
  readonly nominationProgramRoot: Hash;
  readonly nominationProgramProposalLeafDigest: Hash;
  readonly qualificationLeafDigest: Hash;
}

export interface CandidatePartitionProofVerificationContextV1 {
  readonly binding: CandidatePartitionBindingV1;
  readonly release: CandidatePartitionProofReleaseBindingV1;
}

export interface CandidatePartitionProofIssuerPortV1 {
  /** Return only the current release projection required by Checkpoint. */
  currentRelease(): CandidatePartitionProofReleaseBindingV1;
  /** Fail unless every exact receipt binding belongs to the current release's
   * generated plan map and externally signed qualification set. */
  assertNominationQualificationsQualified(
    bindings: readonly CandidateNominationQualificationBindingV1[],
  ): void;
  /** The external release issuer signs the exact payload bytes. */
  issue(payload: CandidatePartitionProofPayloadV1): CandidatePartitionProofV1;
  /** Verify current release binding, key rotation and the Ed25519 signature. */
  verify(
    proof: unknown,
    context: CandidatePartitionProofVerificationContextV1,
  ): CandidatePartitionProofV1;
}

/** A capability is an uninspectable process-local handle, never durable data. */
export type CandidatePartitionCapabilityV1 = object;

export interface CandidatePartitionReaderPortV1 {
  /** Verify capability membership and return the exact frozen binding. */
  binding(capability: CandidatePartitionCapabilityV1): CandidatePartitionBindingV1;
  /** Return the issuer-owned, canonical key list. */
  listKeys(capability: CandidatePartitionCapabilityV1): readonly Hash[];
  /** Read one candidate from the issuer-owned frozen partition by key. */
  readCandidate(
    capability: CandidatePartitionCapabilityV1,
    familyCandidateKey: Hash,
  ): CandidateRecordV1;
  /** Read one immutable raw envelope only when it is referenced by the exact
   * candidate record.  The reader returns a copy; callers never receive a
   * partition-wide byte map or a storage locator. */
  readRawEvidence(
    capability: CandidatePartitionCapabilityV1,
    familyCandidateKey: Hash,
    rawLocatorHash: Hash,
  ): Uint8Array;
}

export interface CandidatePartitionAuthorityPortV1 extends CandidatePartitionProofIssuerPortV1 {}

export function candidatePartitionKeysRoot(keys: readonly Hash[]): Hash {
  const normalized = keys.map((value, index) => assertHash(value, `candidateKeys[${index}]`));
  const sorted = [...normalized].sort();
  if (new Set(sorted).size !== sorted.length) throw new TypeError("candidate keys must be unique");
  return hashCanonicalPartition(CANDIDATE_PARTITION_PROOF_DOMAINS.keys, sorted);
}

export function candidatePartitionBindingPayload(
  input: Omit<CandidatePartitionProofPayloadV1, "proofVersion">,
): CandidatePartitionProofPayloadV1 {
  return deepFreeze({
    ...decodeBinding(input),
    proofVersion: "2" as const,
  });
}

function decodeBinding(value: unknown): CandidatePartitionBindingV1 {
  return decodeExactObject(value, {
    schemaVersion: (field, path) => {
      if (field !== "2") throw new TypeError(`${path} must be \"2\"`);
      return "2" as const;
    },
    kind: (field, path) => {
      if (field !== "aloha.candidate-partition-binding") throw new TypeError(`${path} has invalid kind`);
      return "aloha.candidate-partition-binding" as const;
    },
    runId: (field, path) => assertNonEmptyString(field, path),
    cutoff: (field, path) => decodeCanonicalCutoff(field, path),
    candidatePartitionRoot: (field, path) => nonZeroHash(field, path),
    candidatePartitionStorageHash: (field, path) => nonZeroHash(field, path),
    nominationClosureRoot: (field, path) => nonZeroHash(field, path),
    nominationClosureStorageHash: (field, path) => nonZeroHash(field, path),
    recordCount: (field, path) => decimal(field, path),
    candidateKeysRoot: (field, path) => nonZeroHash(field, path),
    recentObservationRoot: (field, path) => nonZeroHash(field, path),
    sourceCoverageRoot: (field, path) => nonZeroHash(field, path),
    checkpointRevision: (field, path) => decimal(field, path),
    releaseProvenanceHash: (field, path) => nonZeroHash(field, path),
    issuerKeyId: (field, path) => nonZeroHash(field, path),
  }, "candidatePartitionBinding");
}

function decodePayload(value: unknown): CandidatePartitionProofPayloadV1 {
  return decodeExactObject(value, {
    schemaVersion: (field, path) => {
      if (field !== "2") throw new TypeError(`${path} must be \"2\"`);
      return "2" as const;
    },
    kind: (field, path) => {
      if (field !== "aloha.candidate-partition-binding") throw new TypeError(`${path} has invalid kind`);
      return "aloha.candidate-partition-binding" as const;
    },
    runId: (field, path) => assertNonEmptyString(field, path),
    cutoff: (field, path) => decodeCanonicalCutoff(field, path),
    candidatePartitionRoot: (field, path) => nonZeroHash(field, path),
    candidatePartitionStorageHash: (field, path) => nonZeroHash(field, path),
    nominationClosureRoot: (field, path) => nonZeroHash(field, path),
    nominationClosureStorageHash: (field, path) => nonZeroHash(field, path),
    recordCount: (field, path) => decimal(field, path),
    candidateKeysRoot: (field, path) => nonZeroHash(field, path),
    recentObservationRoot: (field, path) => nonZeroHash(field, path),
    sourceCoverageRoot: (field, path) => nonZeroHash(field, path),
    checkpointRevision: (field, path) => decimal(field, path),
    releaseProvenanceHash: (field, path) => nonZeroHash(field, path),
    issuerKeyId: (field, path) => nonZeroHash(field, path),
    proofVersion: (field, path) => {
      if (field !== "2") throw new TypeError(`${path} must be \"2\"`);
      return "2" as const;
    },
  }, "candidatePartitionProofPayload");
}

export function decodeCandidatePartitionBindingV1(value: unknown): CandidatePartitionBindingV1 {
  return deepFreeze(decodeBinding(value));
}

export function decodeCandidatePartitionProofV1(value: unknown): CandidatePartitionProofV1 {
  const decoded = decodeExactObject(value, {
    schemaVersion: (field, path) => {
      if (field !== "2") throw new TypeError(`${path} must be \"2\"`);
      return "2" as const;
    },
    kind: (field, path) => {
      if (field !== "aloha.candidate-partition-binding") throw new TypeError(`${path} has invalid kind`);
      return "aloha.candidate-partition-binding" as const;
    },
    runId: (field, path) => assertNonEmptyString(field, path),
    cutoff: (field, path) => decodeCanonicalCutoff(field, path),
    candidatePartitionRoot: (field, path) => nonZeroHash(field, path),
    candidatePartitionStorageHash: (field, path) => nonZeroHash(field, path),
    nominationClosureRoot: (field, path) => nonZeroHash(field, path),
    nominationClosureStorageHash: (field, path) => nonZeroHash(field, path),
    recordCount: (field, path) => decimal(field, path),
    candidateKeysRoot: (field, path) => nonZeroHash(field, path),
    recentObservationRoot: (field, path) => nonZeroHash(field, path),
    sourceCoverageRoot: (field, path) => nonZeroHash(field, path),
    checkpointRevision: (field, path) => decimal(field, path),
    releaseProvenanceHash: (field, path) => nonZeroHash(field, path),
    issuerKeyId: (field, path) => nonZeroHash(field, path),
    proofVersion: (field, path) => {
      if (field !== "2") throw new TypeError(`${path} must be \"2\"`);
      return "2" as const;
    },
    proofId: (field, path) => nonZeroHash(field, path),
    payloadHash: (field, path) => nonZeroHash(field, path),
    signatureAlgorithm: (field, path) => {
      if (field !== "ed25519") throw new TypeError(`${path} must be ed25519`);
      return "ed25519" as const;
    },
    signerKeyId: (field, path) => nonZeroHash(field, path),
    signatureHex: (field, path) => signature(field, path),
  }, "candidatePartitionProof");
  const payload = payloadFromProof(decoded);
  const expectedPayloadHash = candidatePartitionProofPayloadHash(payload);
  if (decoded.payloadHash !== expectedPayloadHash) throw new TypeError("candidate partition proof payload hash mismatch");
  const expectedId = candidatePartitionProofId(expectedPayloadHash);
  if (decoded.proofId !== expectedId) throw new TypeError("candidate partition proof id mismatch");
  if (decoded.issuerKeyId !== decoded.signerKeyId) throw new TypeError("candidate partition proof issuer/signer key mismatch");
  return deepFreeze(decoded);
}

function payloadFromProof(value: CandidatePartitionProofV1): CandidatePartitionProofPayloadV1 {
  return deepFreeze({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    runId: value.runId,
    cutoff: value.cutoff,
    candidatePartitionRoot: value.candidatePartitionRoot,
    candidatePartitionStorageHash: value.candidatePartitionStorageHash,
    nominationClosureRoot: value.nominationClosureRoot,
    nominationClosureStorageHash: value.nominationClosureStorageHash,
    recordCount: value.recordCount,
    candidateKeysRoot: value.candidateKeysRoot,
    recentObservationRoot: value.recentObservationRoot,
    sourceCoverageRoot: value.sourceCoverageRoot,
    checkpointRevision: value.checkpointRevision,
    releaseProvenanceHash: value.releaseProvenanceHash,
    issuerKeyId: value.issuerKeyId,
    proofVersion: value.proofVersion,
  });
}

export function candidatePartitionBindingFromProof(
  value: CandidatePartitionProofV1,
): CandidatePartitionBindingV1 {
  const proof = decodeCandidatePartitionProofV1(value);
  return deepFreeze({
    schemaVersion: proof.schemaVersion,
    kind: "aloha.candidate-partition-binding" as const,
    runId: proof.runId,
    cutoff: proof.cutoff,
    candidatePartitionRoot: proof.candidatePartitionRoot,
    candidatePartitionStorageHash: proof.candidatePartitionStorageHash,
    nominationClosureRoot: proof.nominationClosureRoot,
    nominationClosureStorageHash: proof.nominationClosureStorageHash,
    recordCount: proof.recordCount,
    candidateKeysRoot: proof.candidateKeysRoot,
    recentObservationRoot: proof.recentObservationRoot,
    sourceCoverageRoot: proof.sourceCoverageRoot,
    checkpointRevision: proof.checkpointRevision,
    releaseProvenanceHash: proof.releaseProvenanceHash,
    issuerKeyId: proof.issuerKeyId,
  });
}

export function candidatePartitionProofPayloadHash(value: CandidatePartitionProofPayloadV1): Hash {
  return hashDomain(CANDIDATE_PARTITION_PROOF_DOMAINS.payload, decodePayload(value));
}

export function candidatePartitionProofId(payloadHash: Hash): Hash {
  return hashDomain(CANDIDATE_PARTITION_PROOF_DOMAINS.id, { payloadHash: nonZeroHash(payloadHash, "payloadHash") });
}

export function candidatePartitionProofSigningBytes(
  value: CandidatePartitionProofV1 | CandidatePartitionProofPayloadV1,
  signerKeyId?: Hash,
): Uint8Array {
  const payload = "proofId" in value ? payloadFromProof(decodeCandidatePartitionProofV1(value)) : decodePayload(value);
  const payloadHash = candidatePartitionProofPayloadHash(payload);
  const proofId = candidatePartitionProofId(payloadHash);
  const signer = signerKeyId ?? ("proofId" in value ? value.signerKeyId : payload.issuerKeyId);
  return encodeCanonicalBytes({
    domain: CANDIDATE_PARTITION_PROOF_DOMAINS.signing,
    version: 2,
    proofId,
    payloadHash,
    signerKeyId: nonZeroHash(signer, "signerKeyId"),
    ...payload,
  });
}

export function candidatePartitionProofHash(value: CandidatePartitionProofV1): Hash {
  const proof = decodeCandidatePartitionProofV1(value);
  return hashDomain("aloha/candidate-partition-proof/record/v2", proof);
}

export function validateCandidatePartitionProof(
  value: unknown,
  context: CandidatePartitionProofVerificationContextV1,
): CandidatePartitionProofV1 {
  const proof = decodeCandidatePartitionProofV1(value);
  const binding = decodeCandidatePartitionBindingV1(context.binding);
  const releaseBinding = context.release;
  if (proof.runId !== binding.runId
    || !sameCutoff(proof.cutoff, binding.cutoff)
    || proof.candidatePartitionRoot !== binding.candidatePartitionRoot
    || proof.candidatePartitionStorageHash !== binding.candidatePartitionStorageHash
    || proof.nominationClosureRoot !== binding.nominationClosureRoot
    || proof.nominationClosureStorageHash !== binding.nominationClosureStorageHash
    || proof.recordCount !== binding.recordCount
    || proof.candidateKeysRoot !== binding.candidateKeysRoot
    || proof.recentObservationRoot !== binding.recentObservationRoot
    || proof.sourceCoverageRoot !== binding.sourceCoverageRoot
    || proof.checkpointRevision !== binding.checkpointRevision
    || proof.releaseProvenanceHash !== binding.releaseProvenanceHash
    || proof.issuerKeyId !== binding.issuerKeyId
  ) throw new TypeError("candidate partition proof binding mismatch");
  if (releaseBinding.releaseProvenanceHash !== proof.releaseProvenanceHash) {
    throw new TypeError("candidate partition proof release provenance is not current");
  }
  if (releaseBinding.candidatePartitionProofIssuerKeyId !== proof.issuerKeyId) {
    throw new TypeError("candidate partition proof issuer key is not current release key");
  }
  if (releaseBinding.releaseAuthorityRoot === `0x${"0".repeat(64)}` || releaseBinding.candidatePartitionProofIssuerKeyId === `0x${"0".repeat(64)}`) {
    throw new TypeError("candidate partition proof release binding is unavailable");
  }
  return proof;
}

export function encodeCandidatePartitionProofV1(value: CandidatePartitionProofV1): Uint8Array {
  return encodeCanonicalBytes(decodeCandidatePartitionProofV1(value));
}

export function decodeCandidatePartitionProofBytes(value: Uint8Array): CandidatePartitionProofV1 {
  return decodeCandidatePartitionProofV1(decodeCanonicalJson(value));
}

/** Utility used by checkpoint to make its proof payload from the durable run. */
export function makeCandidatePartitionProofPayload(input: {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly candidatePartitionStorageHash: Hash;
  readonly nominationClosureRoot: Hash;
  readonly nominationClosureStorageHash: Hash;
  readonly candidates: readonly CandidateRecordV1[];
  readonly recentObservationRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly checkpointRevision: string;
  readonly releaseProvenanceHash: Hash;
  readonly issuerKeyId: Hash;
}): CandidatePartitionProofPayloadV1 {
  const candidates = [...input.candidates];
  const keys = candidates.map(candidate => candidate.familyCandidateKey);
  return candidatePartitionBindingPayload({
    schemaVersion: "2",
    kind: "aloha.candidate-partition-binding",
    runId: assertNonEmptyString(input.runId, "candidatePartition.runId"),
    cutoff: decodeCanonicalCutoff(input.cutoff, "candidatePartition.cutoff"),
    candidatePartitionRoot: nonZeroHash(input.candidatePartitionRoot, "candidatePartition.candidatePartitionRoot"),
    candidatePartitionStorageHash: nonZeroHash(input.candidatePartitionStorageHash, "candidatePartition.candidatePartitionStorageHash"),
    nominationClosureRoot: nonZeroHash(input.nominationClosureRoot, "candidatePartition.nominationClosureRoot"),
    nominationClosureStorageHash: nonZeroHash(input.nominationClosureStorageHash, "candidatePartition.nominationClosureStorageHash"),
    recordCount: decimal(candidates.length.toString(), "candidatePartition.recordCount"),
    candidateKeysRoot: candidatePartitionKeysRoot(keys),
    recentObservationRoot: nonZeroHash(input.recentObservationRoot, "candidatePartition.recentObservationRoot"),
    sourceCoverageRoot: nonZeroHash(input.sourceCoverageRoot, "candidatePartition.sourceCoverageRoot"),
    checkpointRevision: decimal(input.checkpointRevision, "candidatePartition.checkpointRevision"),
    releaseProvenanceHash: nonZeroHash(input.releaseProvenanceHash, "candidatePartition.releaseProvenanceHash"),
    issuerKeyId: nonZeroHash(input.issuerKeyId, "candidatePartition.issuerKeyId"),
  });
}

export function assertCandidatePartitionCapability(value: unknown): asserts value is CandidatePartitionCapabilityV1 {
  if (value === null || typeof value !== "object") throw new TypeError("candidate partition capability is not an object");
}

export function assertCandidatePartitionBinding(value: unknown): CandidatePartitionBindingV1 {
  return decodeCandidatePartitionBindingV1(value);
}

// Keep this assertion local to the contract package. It is intentionally not
// exported as a way to mint or validate capabilities; only the issuer-owned
// reader port may do that.
export function assertCandidatePartitionProofShape(value: unknown): void {
  if (value === null || typeof value !== "object") throw new TypeError("candidate partition proof is not an object");
  assertExactKeys(value, [
    "schemaVersion", "kind", "runId", "cutoff", "candidatePartitionRoot",
    "candidatePartitionStorageHash", "nominationClosureRoot", "nominationClosureStorageHash", "recordCount", "candidateKeysRoot",
    "recentObservationRoot", "sourceCoverageRoot", "checkpointRevision",
    "releaseProvenanceHash", "issuerKeyId", "proofVersion", "proofId",
    "payloadHash", "signatureAlgorithm", "signerKeyId", "signatureHex",
  ], "candidatePartitionProof");
}

/**
 * Unsigned dry-run durability is deliberately a different wire protocol from
 * the release-signed proof above.  It is a content commitment, never release
 * qualification: there is no issuer identity, signature, release authority,
 * or release provenance field that a production decoder could mistake for a
 * signed fact.
 */
export const UNSIGNED_DRY_RUN_CANDIDATE_PARTITION_COMMITMENT_KIND =
  "aloha.unsigned-dry-run-candidate-partition-commitment" as const;
export const UNSIGNED_DRY_RUN_CANDIDATE_PARTITION_COMMITMENT_VERSION = "1" as const;
export const UNSIGNED_DRY_RUN_CANDIDATE_PARTITION_COMMITMENT_DOMAINS = Object.freeze({
  payload: "aloha/unsigned-dry-run-candidate-partition-commitment/payload/v1",
  id: "aloha/unsigned-dry-run-candidate-partition-commitment/id/v1",
});

export interface UnsignedDryRunCandidatePartitionCommitmentPayloadV1 {
  readonly kind: typeof UNSIGNED_DRY_RUN_CANDIDATE_PARTITION_COMMITMENT_KIND;
  readonly version: typeof UNSIGNED_DRY_RUN_CANDIDATE_PARTITION_COMMITMENT_VERSION;
  readonly authorityClass: "unsigned-dry-run";
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

export interface UnsignedDryRunCandidatePartitionCommitmentV1
  extends UnsignedDryRunCandidatePartitionCommitmentPayloadV1 {
  readonly payloadHash: Hash;
  readonly commitmentHash: Hash;
}

/** Process-local handle; the cloneable commitment is never itself authority. */
export type UnsignedDryRunCandidatePartitionCapabilityV1 = object;

export interface UnsignedDryRunCandidatePartitionReaderPortV1 {
  binding(
    capability: UnsignedDryRunCandidatePartitionCapabilityV1,
  ): UnsignedDryRunCandidatePartitionCommitmentV1;
  listKeys(capability: UnsignedDryRunCandidatePartitionCapabilityV1): readonly Hash[];
  readCandidate(
    capability: UnsignedDryRunCandidatePartitionCapabilityV1,
    familyCandidateKey: Hash,
  ): CandidateRecordV1;
  readRawEvidence(
    capability: UnsignedDryRunCandidatePartitionCapabilityV1,
    familyCandidateKey: Hash,
    rawLocatorHash: Hash,
  ): Uint8Array;
}

function decodeUnsignedDryRunCandidatePartitionPayload(
  value: unknown,
): UnsignedDryRunCandidatePartitionCommitmentPayloadV1 {
  return decodeExactObject(value, {
    kind: (field, path) => {
      if (field !== UNSIGNED_DRY_RUN_CANDIDATE_PARTITION_COMMITMENT_KIND) {
        throw new TypeError(`${path} has invalid kind`);
      }
      return UNSIGNED_DRY_RUN_CANDIDATE_PARTITION_COMMITMENT_KIND;
    },
    version: (field, path) => {
      if (field !== UNSIGNED_DRY_RUN_CANDIDATE_PARTITION_COMMITMENT_VERSION) {
        throw new TypeError(`${path} has invalid version`);
      }
      return UNSIGNED_DRY_RUN_CANDIDATE_PARTITION_COMMITMENT_VERSION;
    },
    authorityClass: (field, path) => {
      if (field !== "unsigned-dry-run") throw new TypeError(`${path} must be unsigned-dry-run`);
      return "unsigned-dry-run" as const;
    },
    runtimeAuthority: (field, path) => {
      const projection = decodeRuntimeAuthorityProjectionV1(field);
      if (projection.authorityClass !== "unsigned-dry-run") {
        throw new TypeError(`${path} must carry unsigned-dry-run authority`);
      }
      return projection;
    },
    runId: (field, path) => assertNonEmptyString(field, path),
    cutoff: (field, path) => decodeCanonicalCutoff(field, path),
    candidatePartitionRoot: (field, path) => nonZeroHash(field, path),
    candidatePartitionStorageHash: (field, path) => nonZeroHash(field, path),
    nominationClosureRoot: (field, path) => nonZeroHash(field, path),
    nominationClosureStorageHash: (field, path) => nonZeroHash(field, path),
    recordCount: (field, path) => decimal(field, path),
    candidateKeysRoot: (field, path) => nonZeroHash(field, path),
    recentObservationRoot: (field, path) => nonZeroHash(field, path),
    sourceCoverageRoot: (field, path) => nonZeroHash(field, path),
    checkpointRevision: (field, path) => decimal(field, path),
  }, "unsignedDryRunCandidatePartitionCommitmentPayload");
}

export function unsignedDryRunCandidatePartitionCommitmentPayloadHashV1(
  value: UnsignedDryRunCandidatePartitionCommitmentPayloadV1,
): Hash {
  return hashDomain(
    UNSIGNED_DRY_RUN_CANDIDATE_PARTITION_COMMITMENT_DOMAINS.payload,
    decodeUnsignedDryRunCandidatePartitionPayload(value),
  );
}

export function createUnsignedDryRunCandidatePartitionCommitmentV1(
  value: UnsignedDryRunCandidatePartitionCommitmentPayloadV1,
): UnsignedDryRunCandidatePartitionCommitmentV1 {
  const payload = decodeUnsignedDryRunCandidatePartitionPayload(value);
  const payloadHash = unsignedDryRunCandidatePartitionCommitmentPayloadHashV1(payload);
  return deepFreeze({
    ...payload,
    payloadHash,
    commitmentHash: hashDomain(
      UNSIGNED_DRY_RUN_CANDIDATE_PARTITION_COMMITMENT_DOMAINS.id,
      { payloadHash },
    ),
  });
}

export function decodeUnsignedDryRunCandidatePartitionCommitmentV1(
  value: unknown,
): UnsignedDryRunCandidatePartitionCommitmentV1 {
  const decoded = decodeExactObject(value, {
    kind: field => field,
    version: field => field,
    authorityClass: field => field,
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
    payloadHash: (field, path) => nonZeroHash(field, path),
    commitmentHash: (field, path) => nonZeroHash(field, path),
  }, "unsignedDryRunCandidatePartitionCommitment");
  const { payloadHash, commitmentHash, ...payloadInput } = decoded;
  const payload = decodeUnsignedDryRunCandidatePartitionPayload(payloadInput);
  const expectedPayloadHash = unsignedDryRunCandidatePartitionCommitmentPayloadHashV1(payload);
  if (payloadHash !== expectedPayloadHash) {
    throw new TypeError("unsigned dry-run candidate partition payload hash mismatch");
  }
  const expectedCommitmentHash = hashDomain(
    UNSIGNED_DRY_RUN_CANDIDATE_PARTITION_COMMITMENT_DOMAINS.id,
    { payloadHash },
  );
  if (commitmentHash !== expectedCommitmentHash) {
    throw new TypeError("unsigned dry-run candidate partition commitment hash mismatch");
  }
  return deepFreeze({ ...payload, payloadHash, commitmentHash });
}

export function encodeUnsignedDryRunCandidatePartitionCommitmentV1(
  value: UnsignedDryRunCandidatePartitionCommitmentV1,
): Uint8Array {
  return encodeCanonicalBytes(decodeUnsignedDryRunCandidatePartitionCommitmentV1(value));
}

export function decodeUnsignedDryRunCandidatePartitionCommitmentBytesV1(
  value: Uint8Array,
): UnsignedDryRunCandidatePartitionCommitmentV1 {
  return decodeUnsignedDryRunCandidatePartitionCommitmentV1(decodeCanonicalJson(value));
}
