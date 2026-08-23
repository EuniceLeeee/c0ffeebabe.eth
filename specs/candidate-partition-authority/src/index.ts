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
  decodeCanonicalCutoff,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
} from "../../../packages/discovery/src/index.ts";

/**
 * This package is the neutral wire/port contract for the candidate partition.
 * It deliberately does not contain a signer, a private key, a SQLite reader,
 * or a production release resolver.  The release packaging process supplies a
 * signed issuer/verifier port; checkpoint only calls that port.
 */

export const CANDIDATE_PARTITION_PROOF_KIND = "aloha.candidate-partition-proof" as const;
export const CANDIDATE_PARTITION_PROOF_VERSION = "1" as const;
export const CANDIDATE_PARTITION_PROOF_DOMAINS = Object.freeze({
  payload: "aloha/candidate-partition-proof/payload/v1",
  id: "aloha/candidate-partition-proof/id/v1",
  signing: "aloha/candidate-partition-proof/signing/v1",
  capability: "aloha/candidate-partition-capability/v1",
  keys: "aloha/candidate-partition-keys/v1",
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
  readonly schemaVersion: "1";
  readonly kind: "aloha.candidate-partition-binding";
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  /** Durable content-envelope hash for the exact candidate manifest. */
  readonly candidatePartitionStorageHash: Hash;
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
  readonly proofVersion: "1";
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

export interface CandidatePartitionProofVerificationContextV1 {
  readonly binding: CandidatePartitionBindingV1;
  readonly release: CandidatePartitionProofReleaseBindingV1;
}

export interface CandidatePartitionProofIssuerPortV1 {
  /** Return only the current release projection required by Checkpoint. */
  currentRelease(): CandidatePartitionProofReleaseBindingV1;
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
    proofVersion: "1" as const,
  });
}

function decodeBinding(value: unknown): CandidatePartitionBindingV1 {
  return decodeExactObject(value, {
    schemaVersion: (field, path) => {
      if (field !== "1") throw new TypeError(`${path} must be \"1\"`);
      return "1" as const;
    },
    kind: (field, path) => {
      if (field !== "aloha.candidate-partition-binding") throw new TypeError(`${path} has invalid kind`);
      return "aloha.candidate-partition-binding" as const;
    },
    runId: (field, path) => assertNonEmptyString(field, path),
    cutoff: (field, path) => decodeCanonicalCutoff(field, path),
    candidatePartitionRoot: (field, path) => nonZeroHash(field, path),
    candidatePartitionStorageHash: (field, path) => nonZeroHash(field, path),
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
      if (field !== "1") throw new TypeError(`${path} must be \"1\"`);
      return "1" as const;
    },
    kind: (field, path) => {
      if (field !== "aloha.candidate-partition-binding") throw new TypeError(`${path} has invalid kind`);
      return "aloha.candidate-partition-binding" as const;
    },
    runId: (field, path) => assertNonEmptyString(field, path),
    cutoff: (field, path) => decodeCanonicalCutoff(field, path),
    candidatePartitionRoot: (field, path) => nonZeroHash(field, path),
    candidatePartitionStorageHash: (field, path) => nonZeroHash(field, path),
    recordCount: (field, path) => decimal(field, path),
    candidateKeysRoot: (field, path) => nonZeroHash(field, path),
    recentObservationRoot: (field, path) => nonZeroHash(field, path),
    sourceCoverageRoot: (field, path) => nonZeroHash(field, path),
    checkpointRevision: (field, path) => decimal(field, path),
    releaseProvenanceHash: (field, path) => nonZeroHash(field, path),
    issuerKeyId: (field, path) => nonZeroHash(field, path),
    proofVersion: (field, path) => {
      if (field !== "1") throw new TypeError(`${path} must be \"1\"`);
      return "1" as const;
    },
  }, "candidatePartitionProofPayload");
}

export function decodeCandidatePartitionBindingV1(value: unknown): CandidatePartitionBindingV1 {
  return deepFreeze(decodeBinding(value));
}

export function decodeCandidatePartitionProofV1(value: unknown): CandidatePartitionProofV1 {
  const decoded = decodeExactObject(value, {
    schemaVersion: (field, path) => {
      if (field !== "1") throw new TypeError(`${path} must be \"1\"`);
      return "1" as const;
    },
    kind: (field, path) => {
      if (field !== "aloha.candidate-partition-binding") throw new TypeError(`${path} has invalid kind`);
      return "aloha.candidate-partition-binding" as const;
    },
    runId: (field, path) => assertNonEmptyString(field, path),
    cutoff: (field, path) => decodeCanonicalCutoff(field, path),
    candidatePartitionRoot: (field, path) => nonZeroHash(field, path),
    candidatePartitionStorageHash: (field, path) => nonZeroHash(field, path),
    recordCount: (field, path) => decimal(field, path),
    candidateKeysRoot: (field, path) => nonZeroHash(field, path),
    recentObservationRoot: (field, path) => nonZeroHash(field, path),
    sourceCoverageRoot: (field, path) => nonZeroHash(field, path),
    checkpointRevision: (field, path) => decimal(field, path),
    releaseProvenanceHash: (field, path) => nonZeroHash(field, path),
    issuerKeyId: (field, path) => nonZeroHash(field, path),
    proofVersion: (field, path) => {
      if (field !== "1") throw new TypeError(`${path} must be \"1\"`);
      return "1" as const;
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
    version: 1,
    proofId,
    payloadHash,
    signerKeyId: nonZeroHash(signer, "signerKeyId"),
    ...payload,
  });
}

export function candidatePartitionProofHash(value: CandidatePartitionProofV1): Hash {
  const proof = decodeCandidatePartitionProofV1(value);
  return hashDomain("aloha/candidate-partition-proof/record/v1", proof);
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
    schemaVersion: "1",
    kind: "aloha.candidate-partition-binding",
    runId: assertNonEmptyString(input.runId, "candidatePartition.runId"),
    cutoff: decodeCanonicalCutoff(input.cutoff, "candidatePartition.cutoff"),
    candidatePartitionRoot: nonZeroHash(input.candidatePartitionRoot, "candidatePartition.candidatePartitionRoot"),
    candidatePartitionStorageHash: nonZeroHash(input.candidatePartitionStorageHash, "candidatePartition.candidatePartitionStorageHash"),
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
    "candidatePartitionStorageHash", "recordCount", "candidateKeysRoot",
    "recentObservationRoot", "sourceCoverageRoot", "checkpointRevision",
    "releaseProvenanceHash", "issuerKeyId", "proofVersion", "proofId",
    "payloadHash", "signatureAlgorithm", "signerKeyId", "signatureHex",
  ], "candidatePartitionProof");
}
