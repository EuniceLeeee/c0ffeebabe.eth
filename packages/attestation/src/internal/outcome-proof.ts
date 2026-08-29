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
  AttestationOutcomeIssuerProofV1,
  AttestationOutcomeProofIssueInputV1,
  AttestationOutcomeProofVerificationContextV1,
} from "../internal-authority.ts";

const PROOF_KIND = "aloha.attestation-outcome-issuer-proof" as const;
const PROOF_VERSION = "2" as const;
const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
const ZERO_SIGNATURE = `0x${"00".repeat(64)}`;

export const OUTCOME_PROOF_DOMAINS = Object.freeze({
  payload: "aloha/attestation-outcome-issuer-proof/payload/v2",
  id: "aloha/attestation-outcome-issuer-proof/id/v2",
  signing: "aloha/attestation-outcome-issuer-proof/signing/v2",
});

type ProofCore = Omit<
  AttestationOutcomeIssuerProofV1,
  "proofHash" | "payloadHash" | "signatureAlgorithm" | "issuerKeyId" | "signatureHex"
>;

function nonZeroHash(value: unknown, context: string): Hash {
  const hash = assertHash(value, context);
  if (hash === ZERO_HASH) throw new TypeError(`${context} must be non-zero`);
  return hash;
}

function cutoffCore(input: AttestationOutcomeProofIssueInputV1 | AttestationOutcomeIssuerProofV1) {
  return deepFreeze({
    chainId: assertNonEmptyString(input.cutoff.chainId, "outcomeProof.cutoff.chainId"),
    number: assertDecimalString(input.cutoff.number, "outcomeProof.cutoff.number"),
    hash: nonZeroHash(input.cutoff.hash, "outcomeProof.cutoff.hash"),
    stateRoot: nonZeroHash(input.cutoff.stateRoot, "outcomeProof.cutoff.stateRoot"),
  });
}

function proofCore(input: AttestationOutcomeProofIssueInputV1, sequence: string): ProofCore {
  return deepFreeze({
    kind: PROOF_KIND,
    version: PROOF_VERSION,
    runId: assertNonEmptyString(input.runId, "outcomeProof.runId"),
    cutoff: cutoffCore(input),
    candidatePartitionRoot: nonZeroHash(input.candidatePartitionRoot, "outcomeProof.candidatePartitionRoot"),
    familyDefinitionHash: nonZeroHash(input.candidate.familyDefinitionHash, "outcomeProof.familyDefinitionHash"),
    familyCandidateKey: nonZeroHash(input.candidate.familyCandidateKey, "outcomeProof.familyCandidateKey"),
    candidateSubjectHash: nonZeroHash(input.candidate.candidateSubjectHash, "outcomeProof.candidateSubjectHash"),
    outcomeBodyHash: nonZeroHash(input.outcomeBodyHash, "outcomeProof.outcomeBodyHash"),
    releaseProvenanceHash: nonZeroHash(input.releaseProvenanceHash, "outcomeProof.releaseProvenanceHash"),
    attestationAuthorityRoot: nonZeroHash(input.attestationAuthorityRoot, "outcomeProof.attestationAuthorityRoot"),
    frameworkAuthorityRoot: nonZeroHash(input.frameworkAuthorityRoot, "outcomeProof.frameworkAuthorityRoot"),
    executorAuthorityRoot: nonZeroHash(input.executorAuthorityRoot, "outcomeProof.executorAuthorityRoot"),
    releaseAuthorityRoot: nonZeroHash(input.releaseAuthorityRoot, "outcomeProof.releaseAuthorityRoot"),
    sequence: assertDecimalString(sequence, "outcomeProof.sequence"),
  });
}

function proofCoreFromRecord(value: AttestationOutcomeIssuerProofV1): ProofCore {
  return deepFreeze({
    kind: PROOF_KIND,
    version: PROOF_VERSION,
    runId: assertNonEmptyString(value.runId, "outcomeProof.runId"),
    cutoff: cutoffCore(value),
    candidatePartitionRoot: nonZeroHash(value.candidatePartitionRoot, "outcomeProof.candidatePartitionRoot"),
    familyDefinitionHash: nonZeroHash(value.familyDefinitionHash, "outcomeProof.familyDefinitionHash"),
    familyCandidateKey: nonZeroHash(value.familyCandidateKey, "outcomeProof.familyCandidateKey"),
    candidateSubjectHash: nonZeroHash(value.candidateSubjectHash, "outcomeProof.candidateSubjectHash"),
    outcomeBodyHash: nonZeroHash(value.outcomeBodyHash, "outcomeProof.outcomeBodyHash"),
    releaseProvenanceHash: nonZeroHash(value.releaseProvenanceHash, "outcomeProof.releaseProvenanceHash"),
    attestationAuthorityRoot: nonZeroHash(value.attestationAuthorityRoot, "outcomeProof.attestationAuthorityRoot"),
    frameworkAuthorityRoot: nonZeroHash(value.frameworkAuthorityRoot, "outcomeProof.frameworkAuthorityRoot"),
    executorAuthorityRoot: nonZeroHash(value.executorAuthorityRoot, "outcomeProof.executorAuthorityRoot"),
    releaseAuthorityRoot: nonZeroHash(value.releaseAuthorityRoot, "outcomeProof.releaseAuthorityRoot"),
    sequence: assertDecimalString(value.sequence, "outcomeProof.sequence"),
  });
}

function proofHashes(core: ProofCore, issuerKeyId: Hash): { readonly payloadHash: Hash; readonly proofHash: Hash } {
  const payloadHash = hashDomain(OUTCOME_PROOF_DOMAINS.payload, core);
  return {
    payloadHash,
    proofHash: hashDomain(OUTCOME_PROOF_DOMAINS.id, { payloadHash, issuerKeyId }),
  };
}

export function outcomeProofSigningBytes(
  value: AttestationOutcomeIssuerProofV1 | ProofCore,
  issuerKeyId?: Hash,
): Uint8Array {
  const core = "proofHash" in value ? proofCoreFromRecord(value) : value;
  const keyId = issuerKeyId ?? ("issuerKeyId" in value ? value.issuerKeyId : null);
  if (keyId === null) throw new TypeError("outcome proof issuerKeyId is required");
  const normalizedKeyId = nonZeroHash(keyId, "outcomeProof.issuerKeyId");
  const { payloadHash, proofHash } = proofHashes(core, normalizedKeyId);
  return encodeCanonicalBytes({
    domain: OUTCOME_PROOF_DOMAINS.signing,
    proofHash,
    payloadHash,
    issuerKeyId: normalizedKeyId,
    ...core,
  });
}

export function validateOutcomeIssuerProof(
  value: unknown,
  context: AttestationOutcomeProofVerificationContextV1 | null = null,
): AttestationOutcomeIssuerProofV1 {
  assertExactKeys(value, [
    "kind", "version", "proofHash", "payloadHash", "runId", "cutoff", "candidatePartitionRoot",
    "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash", "outcomeBodyHash",
    "releaseProvenanceHash", "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot",
    "releaseAuthorityRoot", "sequence", "signatureAlgorithm", "issuerKeyId", "signatureHex",
  ], "outcomeProof");
  const raw = value as unknown as AttestationOutcomeIssuerProofV1;
  if (raw.kind !== PROOF_KIND || raw.version !== PROOF_VERSION || raw.signatureAlgorithm !== "ed25519") {
    throw new TypeError("outcome-proof-kind-version-invalid");
  }
  const core = proofCoreFromRecord(raw);
  const issuerKeyId = nonZeroHash(raw.issuerKeyId, "outcomeProof.issuerKeyId");
  const { payloadHash, proofHash } = proofHashes(core, issuerKeyId);
  if (raw.payloadHash !== payloadHash || raw.proofHash !== proofHash) throw new TypeError("outcome-proof-hash-mismatch");
  if (typeof raw.signatureHex !== "string" || !/^0x[0-9a-f]{128}$/.test(raw.signatureHex) || raw.signatureHex === ZERO_SIGNATURE) {
    throw new TypeError("outcome-proof-signature-invalid");
  }
  if (context !== null) {
    const expected = proofCore(context, raw.sequence);
    if (raw.issuerKeyId !== context.attestationProofIssuerKeyId) throw new TypeError("outcome-proof-issuer-key-mismatch");
    const actualBytes = encodeCanonicalBytes(core);
    const expectedBytes = encodeCanonicalBytes(expected);
    if (actualBytes.length !== expectedBytes.length || actualBytes.some((byte, index) => byte !== expectedBytes[index])) {
      throw new TypeError("outcome-proof-context-mismatch");
    }
  }
  return deepFreeze({ ...raw, ...core, issuerKeyId, payloadHash, proofHash });
}

export function issueOutcomeIssuerProof(
  input: AttestationOutcomeProofIssueInputV1,
  issuerKeyId: Hash,
  sequence: string,
  sign: (bytes: Uint8Array) => string,
): AttestationOutcomeIssuerProofV1 {
  const core = proofCore(input, sequence);
  const normalizedKeyId = nonZeroHash(issuerKeyId, "outcomeProof.issuerKeyId");
  const { payloadHash, proofHash } = proofHashes(core, normalizedKeyId);
  const signatureHex = sign(outcomeProofSigningBytes(core, normalizedKeyId));
  return validateOutcomeIssuerProof({
    ...core,
    proofHash,
    payloadHash,
    signatureAlgorithm: "ed25519",
    issuerKeyId: normalizedKeyId,
    signatureHex,
  });
}
