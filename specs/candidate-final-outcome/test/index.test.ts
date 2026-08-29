import assert from "node:assert/strict";
import test from "node:test";
import {
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  candidateFinalOutcomeBodyHash,
  decodeCandidateRecordV1,
  exactOutcomePartitionRootV1,
  validateCandidateFinalOutcomeV1,
  type CandidateFinalOutcomeWireV1,
} from "../src/index.ts";

const h = (label: string): Hash => hashDomain("test/candidate-final-outcome/v1", label);
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });

function candidate() {
  const familyDefinitionHash = h("family-definition");
  const instanceNominationKey = "qualification:candidate";
  const evidence = Object.freeze([Object.freeze({
    kind: "source-plan" as const,
    version: 1 as const,
    ownerRef: h("owner"),
    sourcePlanRef: h("plan"),
    evidenceRef: h("evidence"),
    rawLocatorHash: h("locator"),
  })]);
  return Object.freeze({
    kind: "aloha.candidate-record" as const,
    version: "2" as const,
    familyId: "qualification-family",
    familyDefinitionHash,
    instanceNominationKey,
    familyCandidateKey: hashDomain("aloha/family-candidate/v2", { familyDefinitionHash, instanceNominationKey }),
    candidateSubjectHash: hashDomain("aloha/candidate-subject/v2", { familyDefinitionHash, instanceNominationKey }),
    candidateEvidenceRoot: hashDomain("aloha/candidate-evidence-set/v2", evidence),
    evidence,
  });
}

test("candidate wire decoder recomputes identity and evidence lineage", () => {
  const value = candidate();
  assert.deepEqual(decodeCandidateRecordV1(value), value);
  assert.throws(() => decodeCandidateRecordV1({ ...value, candidateSubjectHash: h("foreign-subject") }));
  assert.throws(() => decodeCandidateRecordV1({ ...value, candidateEvidenceRoot: h("foreign-evidence") }));
  assert.throws(() => decodeCandidateRecordV1({ ...value, evidence: [] }));
  assert.throws(() => decodeCandidateRecordV1({
    ...value,
    evidence: [{ ...value.evidence[0], extra: true }],
  }));
});

test("exact outcome partition root binds every authority and partition coordinate", () => {
  const outcome = Object.freeze({
    kind: "retryable",
    runCandidateKey: h("run-candidate"),
    familyCandidateKey: candidate().familyCandidateKey,
    attestationAuthorityRoot: h("attestation"),
    releaseAuthorityRoot: h("release"),
    releaseProvenanceHash: h("provenance"),
    executorAuthorityRoot: h("executor"),
    outcomeIssuerProof: Object.freeze({ proofHash: h("proof") }),
  }) as CandidateFinalOutcomeWireV1;
  const input = Object.freeze({
    runId: "qualification-run",
    cutoff,
    candidatePartitionRoot: h("candidate-partition"),
    attestationAuthorityRoot: outcome.attestationAuthorityRoot,
    releaseAuthorityRoot: outcome.releaseAuthorityRoot,
    releaseProvenanceHash: outcome.releaseProvenanceHash,
    executorAuthorityRoot: outcome.executorAuthorityRoot,
    outcomes: [outcome],
  });
  const root = exactOutcomePartitionRootV1(input);
  for (const mutation of [
    { ...input, runId: "foreign-run" },
    { ...input, cutoff: { ...cutoff, hash: h("foreign-block") } },
    { ...input, candidatePartitionRoot: h("foreign-candidates") },
    { ...input, outcomes: [] },
  ]) assert.notEqual(exactOutcomePartitionRootV1(mutation), root);
  assert.throws(() => exactOutcomePartitionRootV1({ ...input, releaseProvenanceHash: h("foreign-provenance") }));
  assert.throws(() => exactOutcomePartitionRootV1({ ...input, executorAuthorityRoot: h("foreign-executor") }));
  assert.throws(() => exactOutcomePartitionRootV1({ ...input, outcomes: [outcome, outcome] }));
});

function verifiedMemoOutcome() {
  const value = candidate();
  const runId = "qualification-run";
  const candidatePartitionRoot = h("candidate-partition");
  const authority = Object.freeze({
    releaseProvenanceHash: h("release-provenance"),
    attestationAuthorityRoot: h("attestation-authority"),
    releaseAuthorityRoot: h("release-authority"),
    frameworkAuthorityRoot: h("framework-authority"),
    executorAuthorityRoot: h("executor-authority"),
  });
  const identityMemo = Object.freeze({ kind: "qualification-memo" });
  const identityMemoHash = hashDomain("aloha/identity-memo/v1", identityMemo);
  const descriptorHash = h("descriptor");
  const evidenceRoot = h("identity-evidence");
  const oldInstancePublicationHash = h("old-publication");
  const memoProofCore = Object.freeze({
    kind: "verifiedMemoReuseProof" as const,
    familyId: value.familyId,
    familyDefinitionHash: value.familyDefinitionHash,
    familyCandidateKey: value.familyCandidateKey,
    candidateSubjectHash: value.candidateSubjectHash,
    instanceNominationKey: value.instanceNominationKey,
    cutoff,
    oldInstancePublicationHash,
    requestedArtifactDependencyRoot: h("requested-artifacts"),
    descriptorHash,
    validityDependencyRoot: h("validity-dependencies"),
    candidateToCanonicalIdentityBindingProof: hashDomain("aloha/candidate-to-canonical-identity-binding/v1", {
      familyId: value.familyId,
      familyDefinitionHash: value.familyDefinitionHash,
      familyCandidateKey: value.familyCandidateKey,
      candidateSubjectHash: value.candidateSubjectHash,
      instanceNominationKey: value.instanceNominationKey,
      cutoff,
      oldInstancePublicationHash,
      identityMemoHash,
      descriptorHash,
    }),
    identityMemo,
    identityMemoHash,
    evidenceRoot,
  });
  const identityOrigin = Object.freeze({
    kind: "verified-memo-reuse" as const,
    verifiedMemoSetRoot: h("verified-memo-set"),
    proof: Object.freeze({
      ...memoProofCore,
      proofHash: hashDomain("aloha/verified-memo-reuse-proof/v1", memoProofCore),
    }),
  });
  const identityObservation = Object.freeze({
    kind: "identityVerified" as const,
    familyInstanceKey: "qualification:instance",
    identityMemo,
    identityMemoHash,
    descriptorHash,
    evidenceRoot,
  });
  const identitySubjectHash = hashDomain("aloha/verified-identity-subject/v1", {
    familyDefinitionHash: value.familyDefinitionHash,
    familyInstanceKey: identityObservation.familyInstanceKey,
    identityMemo,
    identityMemoHash,
    descriptorHash,
  });
  const identitySemanticHash = (origin: unknown) => hashDomain("aloha/attestation-identity-observation/v1", {
    runId,
    cutoff,
    candidatePartitionRoot,
    candidate: value,
    identity: identityObservation,
    identityOrigin: origin,
    ...authority,
  });
  const issuerKeyId = h("issuer-key");
  const signatureHex = `0x${"11".repeat(64)}`;
  const issueIdentityProof = (origin: unknown) => {
    const core = Object.freeze({
      kind: "aloha.attestation-identity-issuer-proof",
      version: "2",
      runId,
      cutoff,
      candidatePartitionRoot,
      familyDefinitionHash: value.familyDefinitionHash,
      familyCandidateKey: value.familyCandidateKey,
      candidateSubjectHash: value.candidateSubjectHash,
      identityObservation,
      identitySubjectHash,
      identitySemanticHash: identitySemanticHash(origin),
      identityOrigin: origin,
      ...authority,
      sequence: "1",
    });
    const payloadHash = hashDomain("aloha/attestation-identity-issuer-proof/payload/v2", core);
    return Object.freeze({
      ...core,
      proofHash: hashDomain("aloha/attestation-identity-issuer-proof/id/v2", { payloadHash, issuerKeyId }),
      payloadHash,
      signatureAlgorithm: "ed25519",
      issuerKeyId,
      signatureHex,
    });
  };
  const publicationPayload = Object.freeze({
    familyId: value.familyId,
    familyDefinitionHash: value.familyDefinitionHash,
    familyCandidateKey: value.familyCandidateKey,
    instanceKey: identityObservation.familyInstanceKey,
    cutoff,
    identityMemo,
    identityMemoHash,
    descriptorHash,
    staticProjectionMemoHash: h("static-projection"),
    requestedArtifactDependencyRoot: memoProofCore.requestedArtifactDependencyRoot,
    validityDependencyRoot: memoProofCore.validityDependencyRoot,
    transitions: Object.freeze([]),
    evidenceRoot,
  });
  const publication = Object.freeze({
    ...publicationPayload,
    instancePublicationHash: hashDomain("aloha/instance-publication/v1", publicationPayload),
  });
  const issueOutcome = (origin: unknown) => {
    const body = Object.freeze({
      kind: "verified",
      runCandidateKey: hashDomain("aloha/run-candidate/v1", { runId, familyCandidateKey: value.familyCandidateKey }),
      familyCandidateKey: value.familyCandidateKey,
      instanceKey: identityObservation.familyInstanceKey,
      publication,
      identityProof: issueIdentityProof(origin),
      attestationAuthorityRoot: authority.attestationAuthorityRoot,
      releaseAuthorityRoot: authority.releaseAuthorityRoot,
      releaseProvenanceHash: authority.releaseProvenanceHash,
      executorAuthorityRoot: authority.executorAuthorityRoot,
    });
    const outcomeProofCore = Object.freeze({
      kind: "aloha.attestation-outcome-issuer-proof",
      version: "2",
      runId,
      cutoff,
      candidatePartitionRoot,
      familyDefinitionHash: value.familyDefinitionHash,
      familyCandidateKey: value.familyCandidateKey,
      candidateSubjectHash: value.candidateSubjectHash,
      outcomeBodyHash: candidateFinalOutcomeBodyHash(body),
      ...authority,
      sequence: "1",
    });
    const payloadHash = hashDomain("aloha/attestation-outcome-issuer-proof/payload/v2", outcomeProofCore);
    return Object.freeze({
      ...body,
      outcomeIssuerProof: Object.freeze({
        ...outcomeProofCore,
        proofHash: hashDomain("aloha/attestation-outcome-issuer-proof/id/v2", { payloadHash, issuerKeyId }),
        payloadHash,
        signatureAlgorithm: "ed25519",
        issuerKeyId,
        signatureHex,
      }),
    });
  };
  return Object.freeze({ context: Object.freeze({ runId, cutoff, candidatePartitionRoot, candidate: value }), identityOrigin, issueOutcome });
}

test("verified memo reuse proof is exact and context-bound before external signature qualification", () => {
  const fixture = verifiedMemoOutcome();
  assert.deepEqual(validateCandidateFinalOutcomeV1(fixture.context, fixture.issueOutcome(fixture.identityOrigin)), fixture.issueOutcome(fixture.identityOrigin));

  const wrongBinding = structuredClone(fixture.identityOrigin) as unknown as { proof: Record<string, unknown> };
  wrongBinding.proof.candidateToCanonicalIdentityBindingProof = h("forged-binding");
  assert.throws(() => validateCandidateFinalOutcomeV1(fixture.context, fixture.issueOutcome(wrongBinding)));

  const wrongProofHash = structuredClone(fixture.identityOrigin) as unknown as { proof: Record<string, unknown> };
  wrongProofHash.proof.proofHash = h("forged-memo-proof");
  assert.throws(() => validateCandidateFinalOutcomeV1(fixture.context, fixture.issueOutcome(wrongProofHash)));

  const crossCandidate = structuredClone(fixture.identityOrigin) as unknown as Record<string, unknown>;
  const currentProof = crossCandidate.proof as Record<string, unknown>;
  const proofCore: Record<string, unknown> = { ...currentProof, familyCandidateKey: h("foreign-candidate") };
  delete proofCore.proofHash;
  crossCandidate.proof = {
    ...proofCore,
    proofHash: hashDomain("aloha/verified-memo-reuse-proof/v1", proofCore),
  };
  assert.throws(() => validateCandidateFinalOutcomeV1(fixture.context, fixture.issueOutcome(crossCandidate)));
});
