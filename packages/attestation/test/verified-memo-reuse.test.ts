import assert from "node:assert/strict";
import test from "node:test";
import { decodeCanonicalJson, encodeCanonicalBytes, hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { sealInstancePublication, type InstancePublicationV1 } from "../../catalog/src/index.ts";
import { CandidatePartitionCapabilityRegistryV1 } from "../../checkpoint/src/candidate-partition.ts";
import {
  mergeAndDedupeNominations,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
} from "../../discovery/src/index.ts";
import {
  createAttestationService,
  createFrameworkFailureRuntime,
  createRejectionExecutorAuthorityIssuer,
  createRejectionFactRuntime,
} from "../src/internal/composition.ts";
import {
  rehydrateIdentityResumeCapabilityForCheckpoint,
  rehydrateVerifiedMemoReuseCapabilityForCheckpoint,
} from "../src/internal/validation-authority-rehydrator.ts";
import {
  identityMemoHash,
  type AttestationProgramPort,
  type IdentityVerifiedObservationV1,
  type InstanceLifecycleSingleFlightPort,
  type VerifiedMemoReuseProofV1,
} from "../src/index.ts";
import { issueCandidatePartitionFixture, releaseApproval } from "./authority-fixture.ts";

const h = (value: string): Hash => hashDomain("test/attestation-verified-memo-reuse", value);
const cutoff: CanonicalCutoffV1 = { chainId: "1", number: "50", hash: h("block-50"), stateRoot: h("state-50") };

function candidate(instance: string, candidateCutoff: CanonicalCutoffV1 = cutoff): CandidateRecordV1 {
  return mergeAndDedupeNominations([{
    kind: "aloha.candidate-nomination",
    version: "2",
    familyId: "family-reuse",
    familyDefinitionHash: h("family-definition"),
    instanceNominationKey: instance,
    evidence: {
      kind: "recent-log",
      version: 1,
      sourcePlanRef: null,
      ownerRef: null,
      blockNumber: candidateCutoff.number,
      blockHash: candidateCutoff.hash,
      txHash: h(`tx:${instance}:${candidateCutoff.number}`),
      logIndex: "0",
      address: "0x0000000000000000000000000000000000000001",
      topic: h("topic"),
      rawLocatorHash: h(`raw:${instance}:${candidateCutoff.number}`),
    },
  }])[0]!;
}

function observation(value: CandidateRecordV1, suffix: string): IdentityVerifiedObservationV1 {
  const memo = { kind: "reuse-identity-memo", instance: value.instanceNominationKey, suffix } as const;
  return {
    kind: "identityVerified",
    familyInstanceKey: value.instanceNominationKey,
    identityMemo: memo,
    identityMemoHash: identityMemoHash(memo),
    descriptorHash: h(`descriptor:${value.instanceNominationKey}`),
    evidenceRoot: value.candidateEvidenceRoot,
  };
}

function priorPublication(value: CandidateRecordV1): InstancePublicationV1 {
  const identity = observation(value, "prior");
  return sealInstancePublication({
    familyId: value.familyId,
    familyDefinitionHash: value.familyDefinitionHash,
    familyCandidateKey: value.familyCandidateKey,
    instanceKey: value.instanceNominationKey,
    cutoff: { ...cutoff, number: "49", hash: h("block-49"), stateRoot: h("state-49") },
    identityMemo: identity.identityMemo,
    identityMemoHash: identity.identityMemoHash,
    descriptorHash: identity.descriptorHash,
    staticProjectionMemoHash: h(`projection:${value.instanceNominationKey}`),
    requestedArtifactDependencyRoot: h("requested-dependencies"),
    validityDependencyRoot: h(`validity:${value.instanceNominationKey}`),
    transitions: [],
    evidenceRoot: h(`prior-evidence:${value.instanceNominationKey}`),
  });
}

function reuseProof(
  value: CandidateRecordV1,
  publication: InstancePublicationV1,
  identity: IdentityVerifiedObservationV1,
  currentCutoff: CanonicalCutoffV1,
): VerifiedMemoReuseProofV1 {
  const core = {
    kind: "verifiedMemoReuseProof" as const,
    familyId: value.familyId,
    familyDefinitionHash: value.familyDefinitionHash,
    familyCandidateKey: value.familyCandidateKey,
    candidateSubjectHash: value.candidateSubjectHash,
    instanceNominationKey: value.instanceNominationKey,
    cutoff: currentCutoff,
    oldInstancePublicationHash: publication.instancePublicationHash,
    requestedArtifactDependencyRoot: publication.requestedArtifactDependencyRoot,
    descriptorHash: publication.descriptorHash,
    validityDependencyRoot: publication.validityDependencyRoot,
    candidateToCanonicalIdentityBindingProof: hashDomain("aloha/candidate-to-canonical-identity-binding/v1", {
      familyId: value.familyId,
      familyDefinitionHash: value.familyDefinitionHash,
      familyCandidateKey: value.familyCandidateKey,
      candidateSubjectHash: value.candidateSubjectHash,
      instanceNominationKey: value.instanceNominationKey,
      cutoff: currentCutoff,
      oldInstancePublicationHash: publication.instancePublicationHash,
      identityMemoHash: identity.identityMemoHash,
      descriptorHash: publication.descriptorHash,
    }),
    identityMemo: identity.identityMemo,
    identityMemoHash: identity.identityMemoHash,
    evidenceRoot: identity.evidenceRoot,
  };
  return { ...core, proofHash: hashDomain("aloha/verified-memo-reuse-proof/v1", core) };
}

function harness(options: {
  readonly approval?: ReturnType<typeof releaseApproval>;
  readonly registry?: CandidatePartitionCapabilityRegistryV1;
} = {}) {
  const approval = options.approval ?? releaseApproval(h("framework"), h("executor"), "epoch-1", h("session"));
  const framework = createFrameworkFailureRuntime(approval, { classify() { return null; } });
  const rejectionAuthority = createRejectionExecutorAuthorityIssuer(approval);
  const rejection = createRejectionFactRuntime(rejectionAuthority.issue({
    async execute() { return { transport: [], effects: [] }; },
  }));
  const registry = options.registry ?? new CandidatePartitionCapabilityRegistryV1();
  const identityCalls: string[] = [];
  const reuseCalls: string[] = [];
  const materializationCalls: string[] = [];
  const programs: AttestationProgramPort = {
    async attestIdentity(value) {
      identityCalls.push(value.instanceNominationKey);
      return observation(value, "attested");
    },
    async reuseVerifiedMemo(value, publication, currentCutoff) {
      reuseCalls.push(value.instanceNominationKey);
      if (value.instanceNominationKey === "changed") return { kind: "requiresAttestation" };
      const identity = observation(value, "reused");
      return { kind: "reusable", identity, proof: reuseProof(value, publication, identity, currentCutoff) };
    },
    async materializeAndProject(value, identity, currentCutoff) {
      materializationCalls.push(value.instanceNominationKey);
      return {
        kind: "verified",
        publication: sealInstancePublication({
          familyId: value.familyId,
          familyDefinitionHash: value.familyDefinitionHash,
          familyCandidateKey: value.familyCandidateKey,
          instanceKey: identity.familyInstanceKey,
          cutoff: currentCutoff,
          identityMemo: identity.identityMemo,
          identityMemoHash: identity.identityMemoHash,
          descriptorHash: identity.descriptorHash,
          staticProjectionMemoHash: h(`current-projection:${value.instanceNominationKey}`),
          requestedArtifactDependencyRoot: h("requested-dependencies"),
          validityDependencyRoot: h(`validity:${value.instanceNominationKey}`),
          transitions: [],
          evidenceRoot: identity.evidenceRoot,
        }),
      };
    },
  };
  const lifecycle: InstanceLifecycleSingleFlightPort = {
    async getOrBuild(_key, build) { return build(); },
  };
  const service = createAttestationService({
    composition: approval,
    frameworkRuntime: framework,
    rejectionRuntime: rejection,
    programs,
    instanceLifecycle: lifecycle,
    candidatePartitionReader: registry.reader,
  });
  return { service, programs, registry, approval, identityCalls, reuseCalls, materializationCalls };
}

test("verified memo reuse skips unchanged identity and attests only the differential", async () => {
  const fixture = harness();
  const candidates = [candidate("unchanged"), candidate("changed"), candidate("added")];
  const partition = issueCandidatePartitionFixture(fixture.approval, fixture.registry, candidates, cutoff, "run-current");
  const memoCapabilities = candidates.slice(0, 2).map(value => rehydrateVerifiedMemoReuseCapabilityForCheckpoint(
    fixture.service.validationAuthority,
    {
      runId: "run-current",
      cutoff,
      candidatePartition: partition.capability,
      candidatePartitionReader: fixture.registry.reader,
      familyCandidateKey: value.familyCandidateKey,
      publication: priorPublication(value),
      verifiedMemoSetRoot: h("prior-memo-set"),
    },
  ));
  const session = fixture.service.openRunSession({
    candidatePartition: partition.capability,
    verifiedMemoReuseCapabilities: memoCapabilities,
  });
  const origins: string[] = [];
  const resolvedIdentities = [];
  for (const value of candidates) {
    const identity = await session.resolveIdentityOrReuseProofOnce(value.familyCandidateKey, new AbortController().signal);
    assert.equal(identity.kind, "identityVerified");
    if (identity.kind !== "identityVerified") throw new Error("expected verified identity");
    origins.push(identity.identity.issuerProof.identityOrigin.kind);
    if (value.instanceNominationKey === "unchanged") {
      assert.equal(identity.identity.issuerProof.identityOrigin.kind, "verified-memo-reuse");
      if (identity.identity.issuerProof.identityOrigin.kind !== "verified-memo-reuse") throw new Error("expected memo origin");
      assert.equal(identity.identity.issuerProof.identityOrigin.verifiedMemoSetRoot, h("prior-memo-set"));
      assert.equal(identity.identity.issuerProof.identityOrigin.proof.familyCandidateKey, value.familyCandidateKey);
    }
    resolvedIdentities.push(identity);
  }
  for (const identity of resolvedIdentities) {
    const final = await session.materializeAndProjectOnce(identity.continuation, new AbortController().signal);
    assert.equal(final.outcome.kind, "verified");
  }
  assert.deepEqual(fixture.reuseCalls, ["unchanged", "changed"]);
  assert.deepEqual(fixture.identityCalls, ["changed", "added"]);
  assert.deepEqual(fixture.materializationCalls, ["unchanged", "changed", "added"]);
  assert.deepEqual(origins, ["verified-memo-reuse", "fresh", "fresh"]);
});

test("signed memo-reuse origin survives durable round-trip and restart; clone, splice, and stale release fail", async () => {
  const fixture = harness();
  const value = candidate("durable-reuse");
  const partition = issueCandidatePartitionFixture(fixture.approval, fixture.registry, [value], cutoff, "run-current");
  const memo = rehydrateVerifiedMemoReuseCapabilityForCheckpoint(fixture.service.validationAuthority, {
    runId: "run-current",
    cutoff,
    candidatePartition: partition.capability,
    candidatePartitionReader: fixture.registry.reader,
    familyCandidateKey: value.familyCandidateKey,
    publication: priorPublication(value),
    verifiedMemoSetRoot: h("prior-memo-set"),
  });
  const session = fixture.service.openRunSession({
    candidatePartition: partition.capability,
    verifiedMemoReuseCapabilities: [memo],
  });
  const resolved = await session.resolveIdentityOrReuseProofOnce(value.familyCandidateKey, new AbortController().signal);
  if (resolved.kind !== "identityVerified") throw new Error("expected verified identity");
  const claim = fixture.service.validationAuthority.claimWriterCapabilities(
    session.writerCapability,
    [resolved.persistenceCapability],
  );
  const persisted = claim.entries[0]!;
  claim.commit();
  assert.equal(persisted.kind, "partial-identity");
  assert.ok(persisted.identity);
  const durableIdentity = decodeCanonicalJson(
    encodeCanonicalBytes(persisted.identity),
  ) as unknown as NonNullable<typeof persisted.identity>;
  assert.equal(durableIdentity.issuerProof.identityOrigin.kind, "verified-memo-reuse");

  const restarted = harness({ approval: fixture.approval, registry: fixture.registry });
  const resume = rehydrateIdentityResumeCapabilityForCheckpoint(restarted.service.validationAuthority, {
    runId: "run-current",
    cutoff,
    candidatePartition: partition.capability,
    candidatePartitionReader: fixture.registry.reader,
    familyCandidateKey: value.familyCandidateKey,
    identity: durableIdentity,
    outcomeHash: persisted.outcomeHash,
    attestationAuthorityRoot: persisted.attestationAuthorityRoot,
    releaseAuthorityRoot: persisted.releaseAuthorityRoot,
    releaseProvenanceHash: persisted.releaseProvenanceHash,
    executorAuthorityRoot: persisted.executorAuthorityRoot,
  });
  const resumed = restarted.service.openRunSession({
    candidatePartition: partition.capability,
    identityResumeCapabilities: [resume],
  });
  const restartedIdentity = await resumed.resolveIdentityOrReuseProofOnce(value.familyCandidateKey, new AbortController().signal);
  if (restartedIdentity.kind !== "identityVerified") throw new Error("expected restarted identity");
  assert.deepEqual(restartedIdentity.identity.issuerProof.identityOrigin, durableIdentity.issuerProof.identityOrigin);

  assert.throws(() => rehydrateIdentityResumeCapabilityForCheckpoint(restarted.service.validationAuthority, {
    runId: "run-current",
    cutoff,
    candidatePartition: partition.capability,
    candidatePartitionReader: fixture.registry.reader,
    familyCandidateKey: value.familyCandidateKey,
    identity: {
      ...durableIdentity,
      issuerProof: { ...durableIdentity.issuerProof, identityOrigin: { kind: "fresh" } },
    },
    outcomeHash: persisted.outcomeHash,
    attestationAuthorityRoot: persisted.attestationAuthorityRoot,
    releaseAuthorityRoot: persisted.releaseAuthorityRoot,
    releaseProvenanceHash: persisted.releaseProvenanceHash,
    executorAuthorityRoot: persisted.executorAuthorityRoot,
  }), /proof|hash|signature|context|origin/i);

  const stale = harness({
    registry: fixture.registry,
    approval: releaseApproval(h("framework-stale"), h("executor-stale"), "epoch-stale", h("session-stale")),
  });
  assert.throws(() => rehydrateIdentityResumeCapabilityForCheckpoint(stale.service.validationAuthority, {
    runId: "run-current",
    cutoff,
    candidatePartition: partition.capability,
    candidatePartitionReader: fixture.registry.reader,
    familyCandidateKey: value.familyCandidateKey,
    identity: durableIdentity,
    outcomeHash: persisted.outcomeHash,
    attestationAuthorityRoot: persisted.attestationAuthorityRoot,
    releaseAuthorityRoot: persisted.releaseAuthorityRoot,
    releaseProvenanceHash: persisted.releaseProvenanceHash,
    executorAuthorityRoot: persisted.executorAuthorityRoot,
  }), /proof|authority|release|context|mismatch/i);
});

test("verified memo reuse handles are opaque, lineage-bound, and globally one-shot", async () => {
  const fixture = harness();
  const value = candidate("one-shot");
  const partition = issueCandidatePartitionFixture(fixture.approval, fixture.registry, [value], cutoff, "run-current");
  const capability = rehydrateVerifiedMemoReuseCapabilityForCheckpoint(fixture.service.validationAuthority, {
    runId: "run-current",
    cutoff,
    candidatePartition: partition.capability,
    candidatePartitionReader: fixture.registry.reader,
    familyCandidateKey: value.familyCandidateKey,
    publication: priorPublication(value),
    verifiedMemoSetRoot: h("prior-memo-set"),
  });
  assert.throws(() => fixture.service.openRunSession({
    candidatePartition: partition.capability,
    verifiedMemoReuseCapabilities: [{ ...capability }],
  }), /capability|issued/i);

  const first = fixture.service.openRunSession({ candidatePartition: partition.capability, verifiedMemoReuseCapabilities: [capability] });
  const racing = fixture.service.openRunSession({ candidatePartition: partition.capability, verifiedMemoReuseCapabilities: [capability] });
  const reused = await first.resolveIdentityOrReuseProofOnce(value.familyCandidateKey, new AbortController().signal);
  assert.equal(reused.kind, "identityVerified");
  await assert.rejects(
    racing.resolveIdentityOrReuseProofOnce(value.familyCandidateKey, new AbortController().signal),
    /consumed/,
  );

  const otherValue = candidate("other");
  const otherPartition = issueCandidatePartitionFixture(fixture.approval, fixture.registry, [otherValue], cutoff, "run-current");
  assert.throws(() => fixture.service.openRunSession({
    candidatePartition: otherPartition.capability,
    verifiedMemoReuseCapabilities: [capability],
  }), /consumed|lineage|candidate|capability/i);

  const nextCutoff = { ...cutoff, number: "51", hash: h("block-51"), stateRoot: h("state-51") };
  const nextValue = candidate("one-shot", nextCutoff);
  const nextPartition = issueCandidatePartitionFixture(fixture.approval, fixture.registry, [nextValue], nextCutoff, "run-next");
  assert.throws(() => fixture.service.openRunSession({
    candidatePartition: nextPartition.capability,
    verifiedMemoReuseCapabilities: [capability],
  }), /consumed|lineage|run|capability/i);
  assert.equal(fixture.identityCalls.length, 0);
  assert.deepEqual(fixture.reuseCalls, ["one-shot"]);
});
