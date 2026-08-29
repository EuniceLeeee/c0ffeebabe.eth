import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import type {
  AttestationIdentityOriginV1,
  AttestationIdentityIssuerProofV1,
  AttestationIdentityProofIssueInputV1,
  AttestationIdentityProofVerificationContextV1,
} from "../internal-authority.ts";

const PROOF_KIND = "aloha.attestation-identity-issuer-proof" as const;
const PROOF_VERSION = "2" as const;
const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
const ZERO_SIGNATURE = `0x${"00".repeat(64)}`;

export const IDENTITY_PROOF_DOMAINS = Object.freeze({
  payload: "aloha/attestation-identity-issuer-proof/payload/v2",
  id: "aloha/attestation-identity-issuer-proof/id/v2",
  signing: "aloha/attestation-identity-issuer-proof/signing/v2",
});

type ProofCore = Omit<
  AttestationIdentityIssuerProofV1,
  "proofHash" | "payloadHash" | "signatureAlgorithm" | "issuerKeyId" | "signatureHex"
>;

type IdentityObservation = AttestationIdentityProofIssueInputV1["identityObservation"];

function cutoff(value: unknown, context: string) {
  assertExactKeys(value, ["chainId", "number", "hash", "stateRoot"], context);
  const raw = value as Record<string, unknown>;
  return deepFreeze({
    chainId: assertNonEmptyString(raw.chainId, `${context}.chainId`),
    number: assertDecimalString(raw.number, `${context}.number`),
    hash: nonZeroHash(raw.hash, `${context}.hash`),
    stateRoot: nonZeroHash(raw.stateRoot, `${context}.stateRoot`),
  });
}

function identityOrigin(value: unknown, context: string): AttestationIdentityOriginV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind === "fresh") {
    assertExactKeys(value, ["kind"], context);
    return deepFreeze({ kind: "fresh" as const });
  }
  assertExactKeys(value, ["kind", "verifiedMemoSetRoot", "proof"], context);
  if (raw.kind !== "verified-memo-reuse") throw new TypeError(`${context}.kind is invalid`);
  const proofValue = raw.proof;
  assertExactKeys(proofValue, [
    "kind", "familyId", "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash",
    "instanceNominationKey", "cutoff", "oldInstancePublicationHash", "requestedArtifactDependencyRoot",
    "descriptorHash", "validityDependencyRoot", "candidateToCanonicalIdentityBindingProof",
    "identityMemo", "identityMemoHash", "evidenceRoot", "proofHash",
  ], `${context}.proof`);
  const proofRaw = proofValue as Record<string, unknown>;
  if (proofRaw.kind !== "verifiedMemoReuseProof") throw new TypeError(`${context}.proof.kind is invalid`);
  const identityMemo = decodeCanonicalJson(encodeCanonicalJson(proofRaw.identityMemo));
  const identityMemoHash = nonZeroHash(proofRaw.identityMemoHash, `${context}.proof.identityMemoHash`);
  if (identityMemoHash !== hashDomain("aloha/identity-memo/v1", identityMemo)) {
    throw new TypeError(`${context}.proof.identityMemoHash does not match identityMemo`);
  }
  const proofCore = deepFreeze({
    kind: "verifiedMemoReuseProof" as const,
    familyId: assertNonEmptyString(proofRaw.familyId, `${context}.proof.familyId`),
    familyDefinitionHash: nonZeroHash(proofRaw.familyDefinitionHash, `${context}.proof.familyDefinitionHash`),
    familyCandidateKey: nonZeroHash(proofRaw.familyCandidateKey, `${context}.proof.familyCandidateKey`),
    candidateSubjectHash: nonZeroHash(proofRaw.candidateSubjectHash, `${context}.proof.candidateSubjectHash`),
    instanceNominationKey: assertNonEmptyString(proofRaw.instanceNominationKey, `${context}.proof.instanceNominationKey`),
    cutoff: cutoff(proofRaw.cutoff, `${context}.proof.cutoff`),
    oldInstancePublicationHash: nonZeroHash(proofRaw.oldInstancePublicationHash, `${context}.proof.oldInstancePublicationHash`),
    requestedArtifactDependencyRoot: nonZeroHash(proofRaw.requestedArtifactDependencyRoot, `${context}.proof.requestedArtifactDependencyRoot`),
    descriptorHash: nonZeroHash(proofRaw.descriptorHash, `${context}.proof.descriptorHash`),
    validityDependencyRoot: nonZeroHash(proofRaw.validityDependencyRoot, `${context}.proof.validityDependencyRoot`),
    candidateToCanonicalIdentityBindingProof: nonZeroHash(proofRaw.candidateToCanonicalIdentityBindingProof, `${context}.proof.candidateToCanonicalIdentityBindingProof`),
    identityMemo: identityMemo as CanonicalJson,
    identityMemoHash,
    evidenceRoot: nonZeroHash(proofRaw.evidenceRoot, `${context}.proof.evidenceRoot`),
  });
  const expectedBinding = hashDomain("aloha/candidate-to-canonical-identity-binding/v1", {
    familyId: proofCore.familyId,
    familyDefinitionHash: proofCore.familyDefinitionHash,
    familyCandidateKey: proofCore.familyCandidateKey,
    candidateSubjectHash: proofCore.candidateSubjectHash,
    instanceNominationKey: proofCore.instanceNominationKey,
    cutoff: proofCore.cutoff,
    oldInstancePublicationHash: proofCore.oldInstancePublicationHash,
    identityMemoHash: proofCore.identityMemoHash,
    descriptorHash: proofCore.descriptorHash,
  });
  if (proofCore.candidateToCanonicalIdentityBindingProof !== expectedBinding) {
    throw new TypeError(`${context}.proof identity binding mismatch`);
  }
  const proofHash = nonZeroHash(proofRaw.proofHash, `${context}.proof.proofHash`);
  if (proofHash !== hashDomain("aloha/verified-memo-reuse-proof/v1", proofCore)) {
    throw new TypeError(`${context}.proof hash mismatch`);
  }
  return deepFreeze({
    kind: "verified-memo-reuse" as const,
    verifiedMemoSetRoot: nonZeroHash(raw.verifiedMemoSetRoot, `${context}.verifiedMemoSetRoot`),
    proof: deepFreeze({ ...proofCore, proofHash }),
  });
}

function nonZeroHash(value: unknown, context: string): Hash {
  const hash = assertHash(value, context);
  if (hash === ZERO_HASH) throw new TypeError(`${context} must be non-zero`);
  return hash;
}

function identityObservation(value: unknown, context: string): IdentityObservation {
  assertExactKeys(value, [
    "kind", "familyInstanceKey", "identityMemo", "identityMemoHash", "descriptorHash", "evidenceRoot",
  ], context);
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "identityVerified") throw new TypeError(`${context}.kind is invalid`);
  const identityMemo = decodeCanonicalJson(encodeCanonicalJson(raw.identityMemo));
  const identityMemoHash = nonZeroHash(raw.identityMemoHash, `${context}.identityMemoHash`);
  if (identityMemoHash !== hashDomain("aloha/identity-memo/v1", identityMemo)) {
    throw new TypeError(`${context}.identityMemoHash does not match identityMemo`);
  }
  return deepFreeze({
    kind: "identityVerified" as const,
    familyInstanceKey: assertNonEmptyString(raw.familyInstanceKey, `${context}.familyInstanceKey`),
    identityMemo: identityMemo as CanonicalJson,
    identityMemoHash,
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
    candidateSubjectHash: nonZeroHash(input.candidate.candidateSubjectHash, "identityProof.candidateSubjectHash"),
    identityObservation: identityObservation(input.identityObservation, "identityProof.identityObservation"),
    identitySubjectHash: nonZeroHash(input.identitySubjectHash, "identityProof.identitySubjectHash"),
    identitySemanticHash: nonZeroHash(input.identitySemanticHash, "identityProof.identitySemanticHash"),
    identityOrigin: identityOrigin(input.identityOrigin, "identityProof.identityOrigin"),
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
    candidateSubjectHash: nonZeroHash(value.candidateSubjectHash, "identityProof.candidateSubjectHash"),
    identityObservation: identityObservation(value.identityObservation, "identityProof.identityObservation"),
    identitySubjectHash: nonZeroHash(value.identitySubjectHash, "identityProof.identitySubjectHash"),
    identitySemanticHash: nonZeroHash(value.identitySemanticHash, "identityProof.identitySemanticHash"),
    identityOrigin: identityOrigin(value.identityOrigin, "identityProof.identityOrigin"),
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
    "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash", "identityObservation", "identitySubjectHash",
    "identitySemanticHash", "identityOrigin", "releaseProvenanceHash", "attestationAuthorityRoot", "frameworkAuthorityRoot",
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
