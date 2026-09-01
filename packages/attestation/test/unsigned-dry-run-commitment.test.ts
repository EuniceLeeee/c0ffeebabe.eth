import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  createUnsignedDryRunRuntimeAuthorityDescriptorV1,
  createSignedReleaseRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../runtime-authority/src/index.ts";
import {
  createUnsignedDryRunIdentityCommitmentV1,
  createUnsignedDryRunOutcomeCommitmentV1,
  decodeUnsignedDryRunIdentityCommitmentV1,
  decodeUnsignedDryRunOutcomeCommitmentV1,
} from "../src/index.ts";
import {
  createUnsignedDryRunCandidatePartitionCommitmentV1,
  candidatePartitionKeysRoot,
  decodeUnsignedDryRunCandidatePartitionCommitmentV1,
} from "../../../specs/candidate-partition-authority/src/index.ts";
import { candidatePartitionRoot, mergeAndDedupeNominations } from "../../discovery/src/index.ts";
import { UnsignedDryRunCandidatePartitionCapabilityRegistryV1 } from "../../checkpoint/src/index.ts";

const h = (label: string): Hash => hashDomain("test/unsigned-dry-run-commitment", label);
const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(
  createUnsignedDryRunRuntimeAuthorityDescriptorV1({
    authorityClass: "unsigned-dry-run",
    runtimeBindingId: h("runtime-binding"),
    implementationCommit: "1".repeat(40),
  }),
);
const cutoff = Object.freeze({ chainId: "1", number: "22000000", hash: h("block"), stateRoot: h("state") });
const identityMemo = Object.freeze({ factory: "0x1234" });

test("unsigned dry-run identity/outcome commitments exact-bind runtime and bodies without signed fields", () => {
  const identity = createUnsignedDryRunIdentityCommitmentV1({
    kind: "aloha.unsigned-dry-run-attestation-identity-commitment",
    version: "1",
    authorityClass: "unsigned-dry-run",
    runtimeAuthority,
    runId: "run-1",
    cutoff,
    candidatePartitionRoot: h("partition"),
    familyDefinitionHash: h("family"),
    familyCandidateKey: h("candidate"),
    candidateSubjectHash: h("subject"),
    identityObservation: {
      kind: "identityVerified",
      familyInstanceKey: "instance-1",
      identityMemo,
      identityMemoHash: hashDomain("aloha/identity-memo/v1", identityMemo),
      descriptorHash: h("descriptor"),
      evidenceRoot: h("evidence"),
    },
    identitySubjectHash: h("identity-subject"),
    identitySemanticHash: h("identity-semantic"),
    identityOrigin: { kind: "fresh" },
    attestationAuthorityRoot: h("attestation"),
    frameworkAuthorityRoot: h("framework"),
    executorAuthorityRoot: h("executor"),
    sequence: "1",
  });
  const identityClone = JSON.parse(JSON.stringify(identity));
  assert.deepEqual(decodeUnsignedDryRunIdentityCommitmentV1(identityClone), identity);
  assert.equal("issuerKeyId" in identity, false);
  assert.equal("signatureAlgorithm" in identity, false);
  assert.equal("signatureHex" in identity, false);
  assert.equal("releaseAuthorityRoot" in identity, false);
  assert.equal("releaseProvenanceHash" in identity, false);
  assert.throws(() => decodeUnsignedDryRunIdentityCommitmentV1({
    ...identityClone,
    identitySemanticHash: h("tampered"),
  }), /hash mismatch/);

  const outcome = createUnsignedDryRunOutcomeCommitmentV1({
    kind: "aloha.unsigned-dry-run-attestation-outcome-commitment",
    version: "1",
    authorityClass: "unsigned-dry-run",
    runtimeAuthority,
    runId: "run-1",
    cutoff,
    candidatePartitionRoot: h("partition"),
    familyDefinitionHash: h("family"),
    familyCandidateKey: h("candidate"),
    candidateSubjectHash: h("subject"),
    outcomeBodyHash: h("outcome-body"),
    attestationAuthorityRoot: h("attestation"),
    frameworkAuthorityRoot: h("framework"),
    executorAuthorityRoot: h("executor"),
    sequence: "2",
  });
  assert.deepEqual(decodeUnsignedDryRunOutcomeCommitmentV1(JSON.parse(JSON.stringify(outcome))), outcome);
  assert.throws(() => decodeUnsignedDryRunOutcomeCommitmentV1({
    ...outcome,
    outcomeBodyHash: h("tampered-outcome"),
  }), /hash mismatch/);
});

test("unsigned candidate partition commitment has a distinct exact wire class", () => {
  const commitment = createUnsignedDryRunCandidatePartitionCommitmentV1({
    kind: "aloha.unsigned-dry-run-candidate-partition-commitment",
    version: "1",
    authorityClass: "unsigned-dry-run",
    runtimeAuthority,
    runId: "run-1",
    cutoff,
    candidatePartitionRoot: h("partition"),
    candidatePartitionStorageHash: h("partition-storage"),
    nominationClosureRoot: h("nomination"),
    nominationClosureStorageHash: h("nomination-storage"),
    recordCount: "3",
    candidateKeysRoot: h("keys"),
    recentObservationRoot: h("recent"),
    sourceCoverageRoot: h("coverage"),
    checkpointRevision: "4",
  });
  assert.deepEqual(
    decodeUnsignedDryRunCandidatePartitionCommitmentV1(JSON.parse(JSON.stringify(commitment))),
    commitment,
  );
  assert.equal("issuerKeyId" in commitment, false);
  assert.equal("releaseProvenanceHash" in commitment, false);
  assert.throws(() => decodeUnsignedDryRunCandidatePartitionCommitmentV1({
    ...commitment,
    candidatePartitionStorageHash: h("tampered-storage"),
  }), /hash mismatch/);
});

test("signed runtime authority is rejected by every unsigned commitment", () => {
  const signed = projectRuntimeAuthorityDescriptorV1(createSignedReleaseRuntimeAuthorityDescriptorV1({
    authorityClass: "signed-release",
    runtimeBindingId: h("signed-binding"),
    releaseProvenanceHash: h("release"),
    implementationCommit: "2".repeat(40),
  }));
  assert.throws(() => createUnsignedDryRunOutcomeCommitmentV1({
    kind: "aloha.unsigned-dry-run-attestation-outcome-commitment",
    version: "1",
    authorityClass: "unsigned-dry-run",
    runtimeAuthority: signed,
    runId: "run-1",
    cutoff,
    candidatePartitionRoot: h("partition"),
    familyDefinitionHash: h("family"),
    familyCandidateKey: h("candidate"),
    candidateSubjectHash: h("subject"),
    outcomeBodyHash: h("outcome"),
    attestationAuthorityRoot: h("attestation"),
    frameworkAuthorityRoot: h("framework"),
    executorAuthorityRoot: h("executor"),
    sequence: "1",
  }), /unsigned-dry-run authority/);
});

test("cloneable unsigned commitment data does not forge a candidate capability", () => {
  const candidate = mergeAndDedupeNominations([{
    kind: "aloha.candidate-nomination",
    version: "2",
    familyId: "family-1",
    familyDefinitionHash: h("family"),
    instanceNominationKey: "instance-1",
    evidence: {
      kind: "source-plan",
      version: 1,
      ownerRef: h("owner"),
      sourcePlanRef: h("source-plan"),
      evidenceRef: h("evidence"),
      rawLocatorHash: h("raw"),
    },
  }])[0]!;
  const commitment = createUnsignedDryRunCandidatePartitionCommitmentV1({
    kind: "aloha.unsigned-dry-run-candidate-partition-commitment",
    version: "1",
    authorityClass: "unsigned-dry-run",
    runtimeAuthority,
    runId: "run-capability",
    cutoff,
    candidatePartitionRoot: candidatePartitionRoot([candidate]),
    candidatePartitionStorageHash: h("partition-storage"),
    nominationClosureRoot: h("nomination"),
    nominationClosureStorageHash: h("nomination-storage"),
    recordCount: "1",
    candidateKeysRoot: candidatePartitionKeysRoot([candidate.familyCandidateKey]),
    recentObservationRoot: h("recent"),
    sourceCoverageRoot: h("coverage"),
    checkpointRevision: "1",
  });
  const registry = new UnsignedDryRunCandidatePartitionCapabilityRegistryV1();
  const capability = registry.registerVerifiedCommitment(commitment, [candidate], { read: () => new Uint8Array() });
  assert.equal(registry.reader.binding(capability).commitmentHash, commitment.commitmentHash);
  assert.throws(() => registry.reader.binding({ ...capability }), /not checkpoint-issued/);
  assert.throws(() => registry.reader.binding(JSON.parse(JSON.stringify(commitment))), /invalid|not checkpoint-issued/);
});
