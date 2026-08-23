import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  deepFreeze,
  encodeCanonicalBytes,
  hashDomain,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import type {
  AttestationIdentityIssuerProofV1,
  AttestationIdentityProofIssueInputV1,
  AttestationIdentityProofVerificationContextV1,
} from "../internal-authority.ts";

const PROOF_KIND = "aloha.attestation-identity-issuer-proof" as const;
const PROOF_VERSION = "1" as const;
const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
const ZERO_SIGNATURE = `0x${"00".repeat(64)}`;

export const IDENTITY_PROOF_DOMAINS = Object.freeze({
  payload: "aloha/attestation-identity-issuer-proof/payload/v1",
  id: "aloha/attestation-identity-issuer-proof/id/v1",
  signing: "aloha/attestation-identity-issuer-proof/signing/v1",
});

type ProofCore = Omit<
  AttestationIdentityIssuerProofV1,
  "proofHash" | "payloadHash" | "signatureAlgorithm" | "issuerKeyId" | "signatureHex"
>;

type IdentityObservation = AttestationIdentityProofIssueInputV1["identityObservation"];

function nonZeroHash(value: unknown, context: string): Hash {
  const hash = assertHash(value, context);
  if (hash === ZERO_HASH) throw new TypeError(`${context} must be non-zero`);
  return hash;
}

function identityObservation(value: unknown, context: string): IdentityObservation {
  assertExactKeys(value, [
    "kind", "familyInstanceKey", "identityMemoHash", "descriptorHash", "evidenceRoot",
  ], context);
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "identityVerified") throw new TypeError(`${context}.kind is invalid`);
  return deepFreeze({
    kind: "identityVerified" as const,
    familyInstanceKey: assertNonEmptyString(raw.familyInstanceKey, `${context}.familyInstanceKey`),
    identityMemoHash: nonZeroHash(raw.identityMemoHash, `${context}.identityMemoHash`),
    descriptorHash: nonZeroHash(raw.descriptorHash, `${context}.descriptorHash`),
    evidenceRoot: nonZeroHash(raw.evidenceRoot, `${context}.evidenceRoot`),
  });
}

function proofCore(input: AttestationIdentityProofIssueInputV1, sequence: string): ProofCore {
  return deepFreeze({
    kind: PROOF_KIND,
    version: PROOF_VERSION,
    runId: assertNonEmptyString(input.runId, "identityProof.runId"),
    cutoff: deepFreeze({
      chainId: assertNonEmptyString(input.cutoff.chainId, "identityProof.cutoff.chainId"),
      number: assertDecimalString(input.cutoff.number, "identityProof.cutoff.number"),
      hash: nonZeroHash(input.cutoff.hash, "identityProof.cutoff.hash"),
      stateRoot: nonZeroHash(input.cutoff.stateRoot, "identityProof.cutoff.stateRoot"),
    }),
    candidatePartitionRoot: nonZeroHash(input.candidatePartitionRoot, "identityProof.candidatePartitionRoot"),
    familyDefinitionHash: nonZeroHash(input.candidate.familyDefinitionHash, "identityProof.familyDefinitionHash"),
    familyCandidateKey: nonZeroHash(input.candidate.familyCandidateKey, "identityProof.familyCandidateKey"),
    candidateSnapshotHash: nonZeroHash(input.candidate.candidateSnapshotHash, "identityProof.candidateSnapshotHash"),
    identityObservation: identityObservation(input.identityObservation, "identityProof.identityObservation"),
    identitySubjectHash: nonZeroHash(input.identitySubjectHash, "identityProof.identitySubjectHash"),
    identitySemanticHash: nonZeroHash(input.identitySemanticHash, "identityProof.identitySemanticHash"),
    releaseProvenanceHash: nonZeroHash(input.releaseProvenanceHash, "identityProof.releaseProvenanceHash"),
    attestationAuthorityRoot: nonZeroHash(input.attestationAuthorityRoot, "identityProof.attestationAuthorityRoot"),
    frameworkAuthorityRoot: nonZeroHash(input.frameworkAuthorityRoot, "identityProof.frameworkAuthorityRoot"),
    executorAuthorityRoot: nonZeroHash(input.executorAuthorityRoot, "identityProof.executorAuthorityRoot"),
    releaseAuthorityRoot: nonZeroHash(input.releaseAuthorityRoot, "identityProof.releaseAuthorityRoot"),
    sequence: assertDecimalString(sequence, "identityProof.sequence"),
  });
}

function proofPayload(value: ProofCore): ProofCore {
  return value;
}

function proofHashes(core: ProofCore, issuerKeyId: Hash): { readonly payloadHash: Hash; readonly proofHash: Hash } {
  const payloadHash = hashDomain(IDENTITY_PROOF_DOMAINS.payload, proofPayload(core));
  const proofHash = hashDomain(IDENTITY_PROOF_DOMAINS.id, { payloadHash, issuerKeyId });
  return { payloadHash, proofHash };
}

export function identityProofSigningBytes(
  value: AttestationIdentityIssuerProofV1 | ProofCore,
  issuerKeyId?: Hash,
): Uint8Array {
  const core = "proofHash" in value
    ? proofCoreFromRecord(value)
    : value;
  const keyId = issuerKeyId ?? ("issuerKeyId" in value ? value.issuerKeyId : null);
  if (keyId === null) throw new TypeError("identity proof issuerKeyId is required");
  const normalizedKeyId = nonZeroHash(keyId, "identityProof.issuerKeyId");
  const { payloadHash, proofHash } = proofHashes(core, normalizedKeyId);
  return encodeCanonicalBytes({
    domain: IDENTITY_PROOF_DOMAINS.signing,
    proofHash,
    payloadHash,
    issuerKeyId: normalizedKeyId,
    ...core,
  });
}

function proofCoreFromRecord(value: AttestationIdentityIssuerProofV1): ProofCore {
  return deepFreeze({
    kind: PROOF_KIND,
    version: PROOF_VERSION,
    runId: assertNonEmptyString(value.runId, "identityProof.runId"),
    cutoff: deepFreeze({
      chainId: assertNonEmptyString(value.cutoff.chainId, "identityProof.cutoff.chainId"),
      number: assertDecimalString(value.cutoff.number, "identityProof.cutoff.number"),
      hash: nonZeroHash(value.cutoff.hash, "identityProof.cutoff.hash"),
      stateRoot: nonZeroHash(value.cutoff.stateRoot, "identityProof.cutoff.stateRoot"),
    }),
    candidatePartitionRoot: nonZeroHash(value.candidatePartitionRoot, "identityProof.candidatePartitionRoot"),
    familyDefinitionHash: nonZeroHash(value.familyDefinitionHash, "identityProof.familyDefinitionHash"),
    familyCandidateKey: nonZeroHash(value.familyCandidateKey, "identityProof.familyCandidateKey"),
    candidateSnapshotHash: nonZeroHash(value.candidateSnapshotHash, "identityProof.candidateSnapshotHash"),
    identityObservation: identityObservation(value.identityObservation, "identityProof.identityObservation"),
    identitySubjectHash: nonZeroHash(value.identitySubjectHash, "identityProof.identitySubjectHash"),
    identitySemanticHash: nonZeroHash(value.identitySemanticHash, "identityProof.identitySemanticHash"),
    releaseProvenanceHash: nonZeroHash(value.releaseProvenanceHash, "identityProof.releaseProvenanceHash"),
    attestationAuthorityRoot: nonZeroHash(value.attestationAuthorityRoot, "identityProof.attestationAuthorityRoot"),
    frameworkAuthorityRoot: nonZeroHash(value.frameworkAuthorityRoot, "identityProof.frameworkAuthorityRoot"),
    executorAuthorityRoot: nonZeroHash(value.executorAuthorityRoot, "identityProof.executorAuthorityRoot"),
    releaseAuthorityRoot: nonZeroHash(value.releaseAuthorityRoot, "identityProof.releaseAuthorityRoot"),
    sequence: assertDecimalString(value.sequence, "identityProof.sequence"),
  });
}

export function validateIdentityIssuerProof(
  value: unknown,
  context: AttestationIdentityProofVerificationContextV1 | null = null,
): AttestationIdentityIssuerProofV1 {
  assertExactKeys(value, [
    "kind", "version", "proofHash", "payloadHash", "runId", "cutoff", "candidatePartitionRoot",
    "familyDefinitionHash", "familyCandidateKey", "candidateSnapshotHash", "identityObservation", "identitySubjectHash",
    "identitySemanticHash", "releaseProvenanceHash", "attestationAuthorityRoot", "frameworkAuthorityRoot",
    "executorAuthorityRoot", "releaseAuthorityRoot", "sequence", "signatureAlgorithm", "issuerKeyId", "signatureHex",
  ], "identityProof");
  const raw = value as unknown as AttestationIdentityIssuerProofV1;
  if (raw.kind !== PROOF_KIND || raw.version !== PROOF_VERSION || raw.signatureAlgorithm !== "ed25519") {
    throw new TypeError("identity-proof-kind-version-invalid");
  }
  const core = proofCoreFromRecord(raw);
  const issuerKeyId = nonZeroHash(raw.issuerKeyId, "identityProof.issuerKeyId");
  const { payloadHash, proofHash } = proofHashes(core, issuerKeyId);
  if (raw.payloadHash !== payloadHash || raw.proofHash !== proofHash) throw new TypeError("identity-proof-hash-mismatch");
  if (typeof raw.signatureHex !== "string" || !/^0x[0-9a-f]{128}$/.test(raw.signatureHex) || raw.signatureHex === ZERO_SIGNATURE) {
    throw new TypeError("identity-proof-signature-invalid");
  }
  if (context !== null) {
    const expected = proofCore(context, raw.sequence);
    if (raw.issuerKeyId !== context.attestationProofIssuerKeyId) {
      throw new TypeError("identity-proof-issuer-key-mismatch");
    }
    const actualBytes = encodeCanonicalBytes(core);
    const expectedBytes = encodeCanonicalBytes(expected);
    if (actualBytes.length !== expectedBytes.length || actualBytes.some((byte, index) => byte !== expectedBytes[index])) {
      throw new TypeError("identity-proof-context-mismatch");
    }
  }
  return deepFreeze({ ...raw, ...core, issuerKeyId, payloadHash, proofHash });
}

export function issueIdentityIssuerProof(
  input: AttestationIdentityProofIssueInputV1,
  issuerKeyId: Hash,
  sequence: string,
  sign: (bytes: Uint8Array) => string,
): AttestationIdentityIssuerProofV1 {
  const core = proofCore(input, sequence);
  const normalizedKeyId = nonZeroHash(issuerKeyId, "identityProof.issuerKeyId");
  const { payloadHash, proofHash } = proofHashes(core, normalizedKeyId);
  const signatureHex = sign(identityProofSigningBytes(core, normalizedKeyId));
  const proof = {
    ...core,
    proofHash,
    payloadHash,
    signatureAlgorithm: "ed25519" as const,
    issuerKeyId: normalizedKeyId,
    signatureHex,
  };
  return validateIdentityIssuerProof(proof);
}
