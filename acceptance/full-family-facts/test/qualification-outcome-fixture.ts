/**
 * Qualification corpus only. These records exercise the frozen neutral wire
 * validator with structurally complete signed-proof shapes. They are not a
 * production observer, Checkpoint reader, release signer, or live pass fact.
 */
import {
  encodeCanonicalBytes,
  hashCanonicalPartition,
  hashDomain,
  hashDomainBytes,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  identityObservationSemanticHash,
  verifiedIdentitySubjectHash,
  type CandidateFinalOutcomeV1,
  type IdentityVerifiedObservationV1,
  type RejectionEvidenceBundleV2,
} from "../../../packages/attestation/src/index.ts";
import type { InstancePublicationV1 } from "../../../packages/catalog/src/index.ts";
import { issueIdentityIssuerProof } from "../../../packages/attestation/src/internal/identity-proof.ts";
import { issueOutcomeIssuerProof } from "../../../packages/attestation/src/internal/outcome-proof.ts";
import {
  candidateFinalOutcomeBodyHash,
  validateCandidateFinalOutcomeV1,
  type CandidateFinalOutcomeBodyWireV1,
  type CandidateFinalOutcomeWireV1,
} from "../../../specs/candidate-final-outcome/src/index.ts";
import type {
  CandidateRecordV1,
  CanonicalCutoffV1,
} from "../../../specs/candidate-partition-authority/src/index.ts";

const signature = `0x${"11".repeat(64)}` as `0x${string}`;

export interface QualificationOutcomeAuthorityV1 {
  readonly attestationAuthorityRoot: Hash;
  readonly releaseAuthorityRoot: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly attestationProofIssuerKeyId: Hash;
  readonly workerEpoch: string;
  readonly executorSessionHash: Hash;
}

function bytesHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function runCandidateKey(runId: string, familyCandidateKey: Hash): Hash {
  return hashDomain("aloha/run-candidate/v1", { runId, familyCandidateKey });
}

function attachOutcomeProof(
  runId: string,
  cutoff: CanonicalCutoffV1,
  candidatePartitionRoot: Hash,
  candidate: CandidateRecordV1,
  authority: QualificationOutcomeAuthorityV1,
  body: Omit<CandidateFinalOutcomeV1, "outcomeIssuerProof"> & CandidateFinalOutcomeBodyWireV1,
): CandidateFinalOutcomeWireV1 {
  const outcomeBodyHash = candidateFinalOutcomeBodyHash(body);
  const outcomeIssuerProof = issueOutcomeIssuerProof({
    runId,
    cutoff,
    candidatePartitionRoot,
    candidate,
    outcomeBodyHash,
    releaseProvenanceHash: authority.releaseProvenanceHash,
    attestationAuthorityRoot: authority.attestationAuthorityRoot,
    frameworkAuthorityRoot: authority.frameworkAuthorityRoot,
    executorAuthorityRoot: authority.executorAuthorityRoot,
    releaseAuthorityRoot: authority.releaseAuthorityRoot,
    attestationProofIssuerKeyId: authority.attestationProofIssuerKeyId,
  }, authority.attestationProofIssuerKeyId, "1", () => signature);
  const outcome = Object.freeze({ ...body, outcomeIssuerProof }) as CandidateFinalOutcomeV1;
  return validateCandidateFinalOutcomeV1({ runId, cutoff, candidatePartitionRoot, candidate }, outcome);
}

export function issueQualificationVerifiedOutcome(input: Readonly<{
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly candidate: CandidateRecordV1;
  readonly publication: InstancePublicationV1;
  readonly authority: QualificationOutcomeAuthorityV1;
}>): CandidateFinalOutcomeWireV1 {
  const identityObservation: IdentityVerifiedObservationV1 = Object.freeze({
    kind: "identityVerified",
    familyInstanceKey: input.publication.instanceKey,
    identityMemo: input.publication.identityMemo,
    identityMemoHash: input.publication.identityMemoHash,
    descriptorHash: input.publication.descriptorHash,
    evidenceRoot: input.publication.evidenceRoot,
  });
  const identityOrigin = Object.freeze({ kind: "fresh" as const });
  const identitySubjectHash = verifiedIdentitySubjectHash(input.candidate, identityObservation);
  const identitySemanticHash = identityObservationSemanticHash(
    input.runId,
    input.cutoff,
    input.candidatePartitionRoot,
    input.candidate,
    identityObservation,
    identityOrigin,
    input.authority,
  );
  const identityProof = issueIdentityIssuerProof({
    runId: input.runId,
    cutoff: input.cutoff,
    candidatePartitionRoot: input.candidatePartitionRoot,
    candidate: input.candidate,
    identityObservation,
    identitySubjectHash,
    identitySemanticHash,
    identityOrigin,
    releaseProvenanceHash: input.authority.releaseProvenanceHash,
    attestationAuthorityRoot: input.authority.attestationAuthorityRoot,
    frameworkAuthorityRoot: input.authority.frameworkAuthorityRoot,
    executorAuthorityRoot: input.authority.executorAuthorityRoot,
    releaseAuthorityRoot: input.authority.releaseAuthorityRoot,
    attestationProofIssuerKeyId: input.authority.attestationProofIssuerKeyId,
  }, input.authority.attestationProofIssuerKeyId, "1", () => signature);
  return attachOutcomeProof(
    input.runId,
    input.cutoff,
    input.candidatePartitionRoot,
    input.candidate,
    input.authority,
    Object.freeze({
      kind: "verified",
      runCandidateKey: runCandidateKey(input.runId, input.candidate.familyCandidateKey),
      familyCandidateKey: input.candidate.familyCandidateKey,
      instanceKey: input.publication.instanceKey,
      publication: input.publication,
      identityProof,
      attestationAuthorityRoot: input.authority.attestationAuthorityRoot,
      releaseAuthorityRoot: input.authority.releaseAuthorityRoot,
      releaseProvenanceHash: input.authority.releaseProvenanceHash,
      executorAuthorityRoot: input.authority.executorAuthorityRoot,
    }),
  );
}

export function issueQualificationChainRejectedOutcome(input: Readonly<{
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly candidate: CandidateRecordV1;
  readonly authority: QualificationOutcomeAuthorityV1;
}>): CandidateFinalOutcomeWireV1 {
  const requestId = hashDomain("qualification/full-family/rejection-request/v1", input.candidate.familyCandidateKey);
  const requestRecord = Object.freeze({ method: "eth_call", to: "0x0000000000000000000000000000000000000001", data: "0x", block: input.cutoff.number });
  const requestBytes = encodeCanonicalBytes(requestRecord);
  const request = Object.freeze({ requestId, record: requestRecord, canonicalBytesHex: bytesHex(requestBytes) });
  const source = Object.freeze({
    chainId: input.cutoff.chainId,
    blockNumber: input.cutoff.number,
    blockHash: input.cutoff.hash,
    stateRoot: input.cutoff.stateRoot,
    executorAuthorityRoot: input.authority.executorAuthorityRoot,
    workerEpoch: input.authority.workerEpoch,
    executorSessionHash: input.authority.executorSessionHash,
  });
  const fact = Object.freeze({ requestId, ordinal: "0", kind: "returned", dataHex: "0x", source });
  const transportFacts = Object.freeze([Object.freeze({
    ordinal: "0",
    requestId,
    kind: "returned" as const,
    fact,
    canonicalBytesHex: bytesHex(encodeCanonicalBytes(fact)),
  })]);
  const effectObservations = Object.freeze([]);
  const decisionBytesHex = bytesHex(encodeCanonicalBytes({ code: "chain-absence" }));
  const withoutRoot = Object.freeze({
    kind: "aloha.rejection-evidence-bundle" as const,
    version: "2" as const,
    issuerId: "aloha/attestation-rejection-facts/v2" as const,
    runId: input.runId,
    chainId: input.cutoff.chainId,
    cutoffNumber: input.cutoff.number,
    cutoffHash: input.cutoff.hash,
    cutoffStateRoot: input.cutoff.stateRoot,
    stage: "identity" as const,
    familyDefinitionHash: input.candidate.familyDefinitionHash,
    familyCandidateKey: input.candidate.familyCandidateKey,
    candidateSubjectHash: input.candidate.candidateSubjectHash,
    identitySubjectHash: null,
    instanceNominationKey: input.candidate.instanceNominationKey,
    executorAuthorityRoot: input.authority.executorAuthorityRoot,
    workerEpoch: input.authority.workerEpoch,
    executorSessionHash: input.authority.executorSessionHash,
    executionSessionHash: hashDomain("qualification/full-family/rejection-execution-session/v1", input.candidate.familyCandidateKey),
    request,
    transportFacts,
    effectObservations,
    decisionCode: "chain-absence",
    decisionBytesHex,
    requestFingerprint: hashDomainBytes("aloha/rejection-request-fingerprint/v1", requestBytes),
    orderedTransportFactsRoot: hashCanonicalPartition("aloha/rejection-ordered-transport-facts/v1", transportFacts),
    effectObservationRoot: hashCanonicalPartition("aloha/rejection-effect-observations/v1", effectObservations),
    decisionBytesHash: hashDomainBytes("aloha/rejection-decision-bytes/v1", Uint8Array.from(Buffer.from(decisionBytesHex.slice(2), "hex"))),
  });
  const rejectionEvidence: RejectionEvidenceBundleV2 = Object.freeze({
    ...withoutRoot,
    evidenceBundleRoot: hashDomain("aloha/rejection-evidence-bundle/v2", withoutRoot),
  });
  const proofWithoutHash = Object.freeze({
    stage: rejectionEvidence.stage,
    chainId: rejectionEvidence.chainId,
    cutoffNumber: rejectionEvidence.cutoffNumber,
    familyDefinitionHash: rejectionEvidence.familyDefinitionHash,
    familyCandidateKey: rejectionEvidence.familyCandidateKey,
    candidateSubjectHash: rejectionEvidence.candidateSubjectHash,
    identitySubjectHash: rejectionEvidence.identitySubjectHash,
    instanceNominationKey: rejectionEvidence.instanceNominationKey,
    executorAuthorityRoot: rejectionEvidence.executorAuthorityRoot,
    workerEpoch: rejectionEvidence.workerEpoch,
    executorSessionHash: rejectionEvidence.executorSessionHash,
    executionSessionHash: rejectionEvidence.executionSessionHash,
    cutoffHash: rejectionEvidence.cutoffHash,
    cutoffStateRoot: rejectionEvidence.cutoffStateRoot,
    orderedTransportFactsRoot: rejectionEvidence.orderedTransportFactsRoot,
    effectObservationRoot: rejectionEvidence.effectObservationRoot,
    decisionCode: rejectionEvidence.decisionCode,
    decisionBytesHash: rejectionEvidence.decisionBytesHash,
    requestFingerprint: rejectionEvidence.requestFingerprint,
    evidenceBundleRoot: rejectionEvidence.evidenceBundleRoot,
    authorityRoot: hashDomain("aloha/chain-rejection-authority/v2", { familyDefinitionHash: input.candidate.familyDefinitionHash, stage: "identity" }),
  });
  const proof = Object.freeze({ ...proofWithoutHash, proofHash: hashDomain("aloha/chain-rejection-proof/v4", proofWithoutHash) });
  return attachOutcomeProof(
    input.runId,
    input.cutoff,
    input.candidatePartitionRoot,
    input.candidate,
    input.authority,
    Object.freeze({
      kind: "chainProvenRejected",
      runCandidateKey: runCandidateKey(input.runId, input.candidate.familyCandidateKey),
      familyCandidateKey: input.candidate.familyCandidateKey,
      proof,
      rejectionEvidence,
      identityProof: null,
      attestationAuthorityRoot: input.authority.attestationAuthorityRoot,
      releaseAuthorityRoot: input.authority.releaseAuthorityRoot,
      releaseProvenanceHash: input.authority.releaseProvenanceHash,
      executorAuthorityRoot: input.authority.executorAuthorityRoot,
    }),
  );
}
