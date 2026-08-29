import assert from "node:assert/strict";
import test from "node:test";
import {
  candidatePartitionRoot,
  mergeAndDedupeNominations,
  type CandidateRecordV1,
} from "../../discovery/src/index.ts";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { sealInstancePublication } from "../../catalog/src/index.ts";
import { CandidatePartitionCapabilityRegistryV1 } from "../../checkpoint/src/candidate-partition.ts";
import {
  createAttestationService,
  createFrameworkFailureRuntime,
  createRejectionExecutorAuthorityIssuer,
  createRejectionFactRuntime,
} from "../src/internal/composition.ts";
import {
  attestationAuthorityStates,
} from "../src/internal/validation-authority-state.ts";
import {
  issueAttestationOutcomeResumeCapability,
} from "../src/internal/validation-authority-issuer.ts";
import {
  issueCandidatePartitionFixture,
  releaseApproval,
} from "./authority-fixture.ts";
import {
  identityMemoHash,
  type AttestationProgramPort,
  type IdentityVerifiedObservationV1,
  type IdentityVerifiedV1,
  type InstanceLifecycleSingleFlightPort,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/attestation-outcome-resume", value);
const cutoff = { chainId: "1", number: "50", hash: h("block"), stateRoot: h("state") };

function candidate(runKey: string): CandidateRecordV1 {
  return mergeAndDedupeNominations([{
    kind: "aloha.candidate-nomination",
    version: "2",
    familyId: "family-resume",
    familyDefinitionHash: h("family-definition"),
    instanceNominationKey: `nomination:${runKey}`,
    evidence: {
      kind: "recent-log",
      version: 1,
      sourcePlanRef: null,
      ownerRef: null,
      blockNumber: cutoff.number,
      blockHash: cutoff.hash,
      txHash: h(`tx:${runKey}`),
      logIndex: "0",
      address: "0x0000000000000000000000000000000000000001",
      topic: h("topic"),
      rawLocatorHash: h(`raw:${runKey}`),
    },
  }])[0]!;
}

function makeHarness() {
  const approval = releaseApproval(h("framework"), h("executor"), "epoch-1", h("session"));
  const framework = createFrameworkFailureRuntime(approval, { classify() { return null; } });
  const executorAuthority = createRejectionExecutorAuthorityIssuer(approval);
  const rejection = createRejectionFactRuntime(executorAuthority.issue({
    async execute() { return { transport: [], effects: [] }; },
  }));
  const registry = new CandidatePartitionCapabilityRegistryV1();
  let identityCalls = 0;
  let materializationCalls = 0;
  const programs: AttestationProgramPort = {
    async attestIdentity(value): Promise<IdentityVerifiedObservationV1> {
      identityCalls += 1;
      const memo = { kind: "resume-memo", value: value.familyCandidateKey } as const;
      return {
        kind: "identityVerified",
        familyInstanceKey: `instance:${value.familyCandidateKey}`,
        identityMemo: memo,
        identityMemoHash: identityMemoHash(memo),
        descriptorHash: h("descriptor"),
        evidenceRoot: h("evidence"),
      };
    },
    async materializeAndProject(value, identity) {
      materializationCalls += 1;
      const publication = sealInstancePublication({
        familyId: value.familyId,
        familyDefinitionHash: value.familyDefinitionHash,
        familyCandidateKey: value.familyCandidateKey,
        instanceKey: identity.familyInstanceKey,
        cutoff,
        identityMemo: identity.identityMemo,
        identityMemoHash: identity.identityMemoHash,
        descriptorHash: identity.descriptorHash,
        staticProjectionMemoHash: h("projection"),
        requestedArtifactDependencyRoot: h("dependencies"),
        validityDependencyRoot: h("validity"),
        transitions: [],
        evidenceRoot: identity.evidenceRoot,
      });
      return { kind: "verified", publication };
    },
  } satisfies AttestationProgramPort;
  const lifecycle: InstanceLifecycleSingleFlightPort = {
    async getOrBuild(_key, build) { return build(); },
  };
  const serviceFor = (value: CandidateRecordV1, runId = "run-resume") => {
    const partition = issueCandidatePartitionFixture(
      approval,
      registry,
      [value],
      cutoff,
      runId,
    );
    const service = createAttestationService({
      composition: approval,
      frameworkRuntime: framework,
      rejectionRuntime: rejection,
      programs,
      instanceLifecycle: lifecycle,
      candidatePartitionReader: registry.reader,
    });
    return { partition, service, value };
  };
  return { approval, programs, registry, serviceFor, get identityCalls() { return identityCalls; }, get materializationCalls() { return materializationCalls; } };
}

test("durable final outcome resume skips both program phases", async () => {
  const harness = makeHarness();
  const first = harness.serviceFor(candidate("one"));
  const firstSession = first.service.openRunSession({ candidatePartition: first.partition.capability });
  const identity = await firstSession.resolveIdentityOrReuseProofOnce(first.value.familyCandidateKey, new AbortController().signal);
  assert.equal(identity.kind, "identityVerified");
  const final = await firstSession.materializeAndProjectOnce(identity.continuation, new AbortController().signal);
  const state = attestationAuthorityStates.get(first.service.validationAuthority as object);
  assert.ok(state);
  const resume = issueAttestationOutcomeResumeCapability(state, {
    runId: "run-resume",
    cutoff,
    candidatePartitionRoot: first.partition.binding.candidatePartitionRoot,
    candidatePartition: first.partition.capability,
    candidatePartitionReader: harness.registry.reader,
    familyCandidateKey: first.value.familyCandidateKey,
    candidate: first.value,
    outcome: final.outcome,
    outcomeHash: final.persistenceCapability.outcomeHash,
    attestationAuthorityRoot: state.authorityRoot,
    releaseAuthorityRoot: state.releaseAuthorityRoot,
    releaseProvenanceHash: state.releaseProvenanceHash,
    executorAuthorityRoot: state.executorAuthorityRoot,
  });
  const resumedSession = first.service.openRunSession({
    candidatePartition: first.partition.capability,
    outcomeResumeCapabilities: [resume],
  });
  const resumed = await resumedSession.resolveIdentityOrReuseProofOnce(first.value.familyCandidateKey, new AbortController().signal);
  assert.equal(resumed.kind, "final");
  assert.equal(resumed.durability, "durable");
  assert.equal(resumed.outcome.outcomeIssuerProof.proofHash, final.outcome.outcomeIssuerProof.proofHash);
  assert.equal(harness.identityCalls, 1);
  assert.equal(harness.materializationCalls, 1);
  const partition = resumedSession.sealExactPartition([resumed.persistenceCapability.outcomeHash]);
  assert.equal(partition.outcomes.length, 1);
});

test("final resume capability rejects clone and cross-run reuse", async () => {
  const harness = makeHarness();
  const first = harness.serviceFor(candidate("two"));
  const session = first.service.openRunSession({ candidatePartition: first.partition.capability });
  const identity = await session.resolveIdentityOrReuseProofOnce(first.value.familyCandidateKey, new AbortController().signal);
  assert.equal(identity.kind, "identityVerified");
  const final = await session.materializeAndProjectOnce(identity.continuation, new AbortController().signal);
  const state = attestationAuthorityStates.get(first.service.validationAuthority as object);
  assert.ok(state);
  const resume = issueAttestationOutcomeResumeCapability(state, {
    runId: "run-resume",
    cutoff,
    candidatePartitionRoot: first.partition.binding.candidatePartitionRoot,
    candidatePartition: first.partition.capability,
    candidatePartitionReader: harness.registry.reader,
    familyCandidateKey: first.value.familyCandidateKey,
    candidate: first.value,
    outcome: final.outcome,
    outcomeHash: final.persistenceCapability.outcomeHash,
    attestationAuthorityRoot: state.authorityRoot,
    releaseAuthorityRoot: state.releaseAuthorityRoot,
    releaseProvenanceHash: state.releaseProvenanceHash,
    executorAuthorityRoot: state.executorAuthorityRoot,
  });
  assert.throws(
    () => first.service.openRunSession({
      candidatePartition: first.partition.capability,
      outcomeResumeCapabilities: [{ ...resume }],
    }),
    /capability|issued/i,
  );
  const other = harness.serviceFor(candidate("other"), "run-other");
  assert.throws(
    () => first.service.openRunSession({
      candidatePartition: other.partition.capability,
      outcomeResumeCapabilities: [resume],
    }),
    /lineage|run|candidate|capability/i,
  );
});
