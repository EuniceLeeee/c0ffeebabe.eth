import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import { erc20AssetPortBindingV1 } from "../../asset-ref/src/index.ts";
import { sealInstancePublication } from "../../catalog/src/index.ts";
import { mergeAndDedupeNominations, type CandidateRecordV1 } from "../../discovery/src/index.ts";
import {
  CandidatePartitionCapabilityRegistryV1,
  type CandidatePartitionRawEvidenceSourceV1,
} from "../../checkpoint/src/candidate-partition.ts";
import type { FamilyRawEvidenceReadPortV1 } from "../../family-sdk/runtime/index.ts";
import {
  assertPromotablePartition,
  identityMemoHash,
  validateCandidateFinalOutcome,
  validateRejectionEvidenceBundle,
  verifiedIdentitySubjectHash,
  type AttestationProgramPort,
  type ChainProvenRejectedDecisionV1,
  type FrozenRequestRecordV1,
  type FrozenProgramExecutionViewV1,
  type IdentityVerifiedV1,
  type IdentityVerifiedObservationV1,
  type InstanceDecisionV1,
  type InstanceLifecycleSingleFlightPort,
  type RawEffectObservationV1,
  type RawTransportExecutionRecordV1,
  type RejectionFactContextV1,
  type RejectionEvidenceBundleV2,
  type RejectionExecutorCapabilityV1,
  type RejectionTransportExecutorV1,
  type TransportFactKindV1,
} from "../src/index.ts";
import {
  createAttestationService,
  createFrameworkFailureRuntime,
  createRejectionExecutorAuthorityIssuer,
  createRejectionFactRuntime,
} from "../src/internal/composition.ts";
import {
  issueCandidatePartitionFixture,
  releaseApproval,
  revokeReleaseApproval,
  rotateReleaseApproval,
  type CandidatePartitionFixtureV1,
} from "./authority-fixture.ts";

const h = (value: string): Hash => hashDomain("test/attestation", value);
const identityMemo = (value: string) => ({ kind: "test-identity-memo", value } as const);
const memoHash = (value: string): Hash => identityMemoHash(identityMemo(value));
const cutoff = { chainId: "1", number: "10", hash: h("block"), stateRoot: h("state") };
const inputAsset = erc20AssetPortBindingV1("1", `0x${h("in").slice(-40)}`);
const outputAsset = erc20AssetPortBindingV1("1", `0x${h("out").slice(-40)}`);

const candidate = (
  nominationKey: string,
  rawLocatorHash: Hash = h(`raw:${nominationKey}`),
): CandidateRecordV1 => mergeAndDedupeNominations([{
  kind: "aloha.candidate-nomination",
  version: "2",
  familyId: "family-a",
  familyDefinitionHash: h("definition"),
  instanceNominationKey: nominationKey,
  evidence: {
    kind: "recent-log",
    version: 1,
    sourcePlanRef: null,
    ownerRef: null,
    blockNumber: "10",
    blockHash: cutoff.hash,
    txHash: h(`tx:${nominationKey}`),
    logIndex: "0",
    address: "0xabc",
    topic: h("topic"),
    rawLocatorHash,
  },
}])[0]!;

const defaultApproval = () => releaseApproval(h("framework-authority"), h("executor-authority"), "epoch-1", h("executor-session"));

const frameworkRuntime = (approval = defaultApproval()) => createFrameworkFailureRuntime(approval, {
  classify(thrown) { return thrown; },
});

const publication = (value: CandidateRecordV1, identity: IdentityVerifiedV1) => sealInstancePublication({
  familyId: value.familyId,
  familyDefinitionHash: value.familyDefinitionHash,
  familyCandidateKey: value.familyCandidateKey,
  instanceKey: identity.familyInstanceKey,
  cutoff,
  identityMemo: identity.identityMemo,
  identityMemoHash: identity.identityMemoHash,
  descriptorHash: identity.descriptorHash,
  staticProjectionMemoHash: h("projection-memo"),
  requestedArtifactDependencyRoot: h("dependencies"),
  validityDependencyRoot: h("validity"),
  transitions: [{
    inputAssetPorts: [{ ...inputAsset, portRef: h("in-port"), ordinal: "0" }],
    outputAssetPorts: [{ ...outputAsset, portRef: h("out-port"), ordinal: "0" }],
    opaqueTransitionRef: h("transition"),
    constraintRefs: [],
    staticProjectionHash: h("projection"),
  }],
  evidenceRoot: identity.evidenceRoot,
});

class SingleFlight implements InstanceLifecycleSingleFlightPort {
  readonly calls = new Map<Hash, number>();
  readonly values = new Map<Hash, Promise<InstanceDecisionV1>>();
  getOrBuild(key: Hash, build: () => Promise<InstanceDecisionV1>): Promise<InstanceDecisionV1> {
    const existing = this.values.get(key);
    if (existing) return existing;
    this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
    const value = build().finally(() => this.values.delete(key));
    this.values.set(key, value);
    return value;
  }
}

interface RejectionProgramInput {
  readonly context: RejectionFactContextV1;
  readonly request: FrozenRequestRecordV1;
}

interface RejectionExecutorFixture {
  readonly executor: RejectionTransportExecutorV1;
  readonly capability: RejectionExecutorCapabilityV1;
  readonly calls: FrozenProgramExecutionViewV1[];
  readonly rawData: Uint8Array;
}

function rejectionProgramInput(
  value: CandidateRecordV1,
  stage: "identity" | "materialization" | "projection" = "identity",
  identitySubjectHash: Hash | null = null,
) : RejectionProgramInput {
  const requestRecord = { method: "eth_call", to: "0xabc", data: "0x1234", block: cutoff.number };
  const request: FrozenRequestRecordV1 = {
    requestId: h(`request:${value.instanceNominationKey}:${stage}`),
    record: requestRecord,
  };
  return {
    context: { runId: "run-a", candidate: value, cutoff, stage, identitySubjectHash },
    request,
  };
}

function rejectionExecutor(
  kind: TransportFactKindV1 = "returned",
  approval = defaultApproval(),
): RejectionExecutorFixture {
  const calls: FrozenProgramExecutionViewV1[] = [];
  const rawData = kind === "reverted"
    ? Uint8Array.from([0x08, 0xc3, 0x79, 0xa0])
    : Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
  const binding = approval.resolver.resolve(approval.capability).provenance.runtimeBinding;
  const source = {
    chainId: cutoff.chainId,
    blockNumber: cutoff.number,
    blockHash: cutoff.hash,
    stateRoot: cutoff.stateRoot,
    executorAuthorityRoot: binding.executorAuthorityRoot,
    workerEpoch: binding.workerEpoch,
    executorSessionHash: binding.executorSessionHash,
  };
  const executor: RejectionTransportExecutorV1 = {
    async execute(program) {
      calls.push(program);
      const transport: RawTransportExecutionRecordV1 = {
        requestId: program.request.requestId,
        kind,
        data: rawData,
        source,
      };
      const effect: RawEffectObservationV1 = {
        requestId: program.request.requestId,
        source,
        observation: { token: "0xtoken", account: "0xabc", delta: kind === "reverted" ? "0" : "7" },
      };
      return { transport: [transport], effects: [effect] };
    },
  };
  const authority = createRejectionExecutorAuthorityIssuer(approval);
  return { executor, capability: authority.issue(executor), calls, rawData };
}

async function executeFamilyRejection(
  runtime: ReturnType<typeof createRejectionFactRuntime>,
  value: CandidateRecordV1,
  stage: "identity" | "materialization" | "projection" = "identity",
  identitySubjectHash: Hash | null = null,
) {
  const input = rejectionProgramInput(value, stage, identitySubjectHash);
  const program = runtime.workPlane.builder.freezeProgram(input);
  const result = await runtime.workPlane.executeAndInterpret(
    program,
    async (facts, token): Promise<ChainProvenRejectedDecisionV1> => {
      // This is the Family-side interpreter: it can only decide from the
      // immutable facts emitted by the framework executor.
      assert.equal(facts.programId, program.programId);
      assert.equal(facts.request.requestId, input.request.requestId);
      assert.equal(facts.transportFacts.length, 1);
      assert.equal(facts.effectObservations.length, 1);
      const transportKind = facts.transportFacts[0]?.kind;
      const decisionCode = transportKind === "reverted" ? "chain-revert" : "chain-absence";
      return {
        kind: "chainProvenRejected",
        rejectionFacts: token,
        decisionCode,
        decisionBytes: encodeCanonicalBytes({
          code: decisionCode,
          transportKind,
          effectCount: String(facts.effectObservations.length),
        }),
      };
    },
    new AbortController().signal,
  );
  const decision = result.decision as ChainProvenRejectedDecisionV1;
  if (decision.kind !== "chainProvenRejected" || result.rejectionEvidence === null) {
    throw new Error("expected executor-backed rejection");
  }
  return { ...input, program, decision, evidence: result.rejectionEvidence };
}

function rejectionDecisionInput(decision: ChainProvenRejectedDecisionV1) {
  return {
    rejectionFacts: decision.rejectionFacts,
    decisionCode: decision.decisionCode,
    decisionBytes: decision.decisionBytes,
  };
}

function attestArgs(
  rejection?: ReturnType<typeof createRejectionFactRuntime>,
  composition = defaultApproval(),
) {
  const framework = frameworkRuntime(composition);
  const actualRejection = rejection ?? createRejectionFactRuntime(rejectionExecutor("returned", composition).capability);
  const lifecycle = new SingleFlight();
  const registry = new CandidatePartitionCapabilityRegistryV1();
  return {
    framework,
    rejection: actualRejection,
    composition,
    registry,
    partitionFor(
      candidates: readonly CandidateRecordV1[],
      runId = "run-a",
      checkpointRevision = "1",
      rawEvidence?: CandidatePartitionRawEvidenceSourceV1,
    ): CandidatePartitionFixtureV1 {
      return issueCandidatePartitionFixture(composition, registry, candidates, cutoff, runId, checkpointRevision, rawEvidence);
    },
    serviceFor(programs: AttestationProgramPort) {
      return createAttestationService({
        composition,
        frameworkRuntime: framework,
        rejectionRuntime: actualRejection,
        programs,
        instanceLifecycle: lifecycle,
        candidatePartitionReader: registry.reader,
      });
    },
  };
}

function openSession(
  args: ReturnType<typeof attestArgs>,
  programs: AttestationProgramPort,
  candidates: readonly CandidateRecordV1[],
  runId = "run-a",
) {
  const partition = args.partitionFor(candidates, runId);
  const service = args.serviceFor(programs);
  const session = service.openRunSession({ candidatePartition: partition.capability });
  return { partition, service, session };
}

async function attestPartition(
  args: ReturnType<typeof attestArgs>,
  programs: AttestationProgramPort,
  candidates: readonly CandidateRecordV1[],
  runId = "run-a",
) {
  const { partition, service, session } = openSession(args, programs, candidates, runId);
  const outcomeHashes: Hash[] = [];
  for (const key of partition.reader.listKeys(partition.capability)) {
    const identity = await session.resolveIdentityOrReuseProofOnce(key, new AbortController().signal);
    if (identity.kind === "identityVerified") {
      const partialClaim = service.validationAuthority.claimWriterCapabilities(session.writerCapability, [identity.persistenceCapability]);
      partialClaim.commit();
      const final = await session.materializeAndProjectOnce(identity.continuation, new AbortController().signal);
      const finalClaim = service.validationAuthority.claimWriterCapabilities(session.writerCapability, [final.persistenceCapability]);
      finalClaim.commit();
      outcomeHashes.push(final.persistenceCapability.outcomeHash);
    } else {
      const finalClaim = service.validationAuthority.claimWriterCapabilities(session.writerCapability, [identity.persistenceCapability]);
      finalClaim.commit();
      outcomeHashes.push(identity.persistenceCapability.outcomeHash);
    }
  }
  const sealed = session.sealExactPartition(outcomeHashes);
  return service.validationAuthority.validatePartitionCapability(sealed, candidates);
}

async function partitionForIdentityDecision(
  args: ReturnType<typeof attestArgs>,
  value: CandidateRecordV1,
  decision: unknown,
) {
  const programs: AttestationProgramPort = {
    async attestIdentity() { return decision as never; },
    async materializeAndProject() { throw new Error("unused"); },
  };
  return attestPartition(args, programs, [value]);
}

test("active signed runtime binding is checked for every proof issue and verify, including revoke and rotate", async () => {
  const value = candidate("active-runtime-binding");
  const args = attestArgs();
  const identity: IdentityVerifiedObservationV1 = {
    kind: "identityVerified",
    familyInstanceKey: "instance:active-runtime-binding",
    identityMemo: identityMemo("active-identity"),
    identityMemoHash: memoHash("active-identity"),
    descriptorHash: h("active-descriptor"),
    evidenceRoot: h("active-evidence"),
  };
  const programs: AttestationProgramPort = {
    async attestIdentity() { return identity; },
    async materializeAndProject(candidateValue, identityValue) {
      return { kind: "verified", publication: publication(candidateValue, identityValue) };
    },
  };
  const firstRun = openSession(args, programs, [value]);
  const { service, session } = firstRun;
  const first = await session.resolveIdentityOrReuseProofOnce(value.familyCandidateKey, new AbortController().signal);
  assert.equal(first.kind, "identityVerified");
  const final = await session.materializeAndProjectOnce(first.continuation, new AbortController().signal);
  assert.equal(final.outcome.kind, "verified");

  const revokedPartition = args.partitionFor([value], "run-a-revoked");
  revokeReleaseApproval(args.composition);
  const revokedSession = service.openRunSession({ candidatePartition: revokedPartition.capability });
  await assert.rejects(
    () => revokedSession.resolveIdentityOrReuseProofOnce(value.familyCandidateKey, new AbortController().signal),
    /revoked|active binding/i,
  );
  assert.throws(
    () => service.validationAuthority.validateOutcomeCapability(final.outcome, {
      runId: "run-a",
      cutoff,
      candidatePartitionRoot: firstRun.partition.binding.candidatePartitionRoot,
      candidate: value,
    }),
    /revoked|active binding/i,
  );

  const rotatedApproval = releaseApproval(h("rotate-framework"), h("rotate-executor"));
  const rotatedArgs = attestArgs(undefined, rotatedApproval);
  const rotatedPrograms: AttestationProgramPort = {
    async attestIdentity() { return identity; },
    async materializeAndProject(candidateValue, identityValue) {
      return { kind: "verified", publication: publication(candidateValue, identityValue) };
    },
  };
  const rotatedRun = openSession(rotatedArgs, rotatedPrograms, [value]);
  const { service: rotatedService, session: rotatedSession } = rotatedRun;
  const rotatedIdentity = await rotatedSession.resolveIdentityOrReuseProofOnce(value.familyCandidateKey, new AbortController().signal);
  assert.equal(rotatedIdentity.kind, "identityVerified");
  const rotatedFinal = await rotatedSession.materializeAndProjectOnce(rotatedIdentity.continuation, new AbortController().signal);
  rotateReleaseApproval(rotatedApproval, {
    workerEpoch: "epoch-2",
    executorSessionHash: h("rotated-session"),
  });
  assert.throws(
    () => rotatedService.validationAuthority.validateOutcomeCapability(rotatedFinal.outcome, {
      runId: "run-a",
      cutoff,
      candidatePartitionRoot: rotatedRun.partition.binding.candidatePartitionRoot,
      candidate: value,
    }),
    /stale|active binding/i,
  );
  assert.throws(
    () => rotatedArgs.partitionFor([value], "run-a-stale"),
    /stale|active binding/i,
  );
});

test("Attestation composition accepts only the exact runtime-release issued binding", () => {
  const approval = defaultApproval();
  const classifier: Parameters<typeof createFrameworkFailureRuntime>[1] = {
    classify(thrown) { return thrown; },
  };
  const rawBinding = approval.resolver.resolve(approval.capability).provenance.runtimeBinding;
  const fakeResolver = {
    resolve() {
      return approval.resolver.resolve(approval.capability);
    },
  };
  const cases: readonly unknown[] = [
    rawBinding,
    { ...approval },
    { capability: { ...approval.capability }, resolver: approval.resolver },
    { capability: JSON.parse(JSON.stringify(approval.capability)), resolver: approval.resolver },
    { capability: approval.capability, resolver: fakeResolver },
  ];
  for (const value of cases) {
    assert.throws(
      () => createFrameworkFailureRuntime(value as never, classifier),
      /composition|runtime release|not issued|capability/i,
    );
  }
  const resolved = approval.resolver.resolve(approval.capability);
  assert.equal(Object.isFrozen(resolved.provenance), true);
});

test("candidate partition capability is not cloneable and a fake reader cannot authorize it", () => {
  const value = candidate("partition-capability-boundary");
  const args = attestArgs();
  const fixture = args.partitionFor([value]);
  const programs: AttestationProgramPort = {
    async attestIdentity() { throw new Error("unused"); },
    async materializeAndProject() { throw new Error("unused"); },
  };
  const service = args.serviceFor(programs);
  assert.throws(
    () => service.openRunSession({ candidatePartition: { ...fixture.capability } }),
    /not checkpoint-issued|capability/i,
  );
  assert.throws(
    () => service.openRunSession({ candidatePartition: JSON.parse(JSON.stringify(fixture.capability)) }),
    /not checkpoint-issued|capability/i,
  );
  const fakeReader = {
    binding: () => fixture.binding,
    listKeys: () => [value.familyCandidateKey],
    readCandidate: () => value,
    readRawEvidence: () => { throw new Error("unused"); },
  };
  assert.throws(
    () => createAttestationService({
      composition: args.composition,
      frameworkRuntime: args.framework,
      rejectionRuntime: args.rejection,
      programs,
      instanceLifecycle: new SingleFlight(),
      candidatePartitionReader: fakeReader,
    }).openRunSession({ candidatePartition: fixture.capability }),
    /reader|issuer|capability|checkpoint/i,
  );
  assert.throws(
    () => service.openRunSession({ candidatePartition: fixture.capability }).resolveIdentityOrReuseProofOnce(h("wrong-partition-key"), new AbortController().signal),
    /absent|candidate|key/i,
  );
});

test("each Attestation candidate receives only its hash-verified raw evidence", async () => {
  const firstBytes = new TextEncoder().encode("candidate-a-raw-evidence");
  const secondBytes = new TextEncoder().encode("candidate-b-raw-evidence");
  const first = candidate("raw-a", sha256Hex(firstBytes));
  const second = candidate("raw-b", sha256Hex(secondBytes));
  const values = new Map<string, Uint8Array>([
    [`${first.familyCandidateKey}:${first.evidence[0]!.rawLocatorHash}`, firstBytes],
    [`${second.familyCandidateKey}:${second.evidence[0]!.rawLocatorHash}`, secondBytes],
  ]);
  const source: CandidatePartitionRawEvidenceSourceV1 = Object.freeze({
    read(familyCandidateKey: Hash, rawLocatorHash: Hash): Uint8Array {
      const value = values.get(`${familyCandidateKey}:${rawLocatorHash}`);
      if (value === undefined) throw new TypeError("test raw evidence is absent");
      return value;
    },
  });
  const ports = new Map<Hash, FamilyRawEvidenceReadPortV1>();
  const expected = new Map<Hash, Uint8Array>([
    [first.familyCandidateKey, firstBytes],
    [second.familyCandidateKey, secondBytes],
  ]);
  const programs: AttestationProgramPort = {
    async attestIdentity(value, _cutoff, _signal, rawEvidence) {
      ports.set(value.familyCandidateKey, rawEvidence);
      const locator = value.evidence[0]!.rawLocatorHash;
      const observed = rawEvidence.read(locator);
      assert.deepEqual(observed, expected.get(value.familyCandidateKey));
      observed[0] = observed[0]! ^ 0xff;
      assert.deepEqual(rawEvidence.read(locator), expected.get(value.familyCandidateKey));
      return {
        kind: "identityVerified",
        familyInstanceKey: `instance:${value.instanceNominationKey}`,
        identityMemo: identityMemo(`raw:${value.instanceNominationKey}`),
        identityMemoHash: memoHash(`raw:${value.instanceNominationKey}`),
        descriptorHash: h("raw-descriptor"),
        evidenceRoot: value.candidateEvidenceRoot,
      };
    },
    async materializeAndProject() { throw new Error("unused"); },
  };
  const args = attestArgs();
  const partition = args.partitionFor([first, second], "run-raw-evidence", "1", source);
  const session = args.serviceFor(programs).openRunSession({ candidatePartition: partition.capability });
  await session.resolveIdentityOrReuseProofOnce(first.familyCandidateKey, new AbortController().signal);
  await session.resolveIdentityOrReuseProofOnce(second.familyCandidateKey, new AbortController().signal);
  assert.throws(
    () => ports.get(first.familyCandidateKey)!.read(second.evidence[0]!.rawLocatorHash),
    /outside the exact candidate record/,
  );
});

test("identity and instance lifecycle execute exactly once per candidate/instance", async () => {
  const candidates = [candidate("a"), candidate("b")];
  let identityCalls = 0;
  let lifecycleCalls = 0;
  const programs: AttestationProgramPort = {
    async attestIdentity(value) {
      identityCalls += 1;
      return {
        kind: "identityVerified",
        familyInstanceKey: `instance:${value.instanceNominationKey}`,
        identityMemo: identityMemo(`identity:${value.instanceNominationKey}`),
        identityMemoHash: memoHash(`identity:${value.instanceNominationKey}`),
        descriptorHash: h("descriptor"),
        evidenceRoot: h(`evidence:${value.instanceNominationKey}`),
      };
    },
    async materializeAndProject(value, identity) {
      lifecycleCalls += 1;
      return { kind: "verified", publication: publication(value, identity) };
    },
  };
  const args = attestArgs();
  const partition = await attestPartition(args, programs, candidates);
  assert.equal(identityCalls, 2);
  assert.equal(lifecycleCalls, 2);
  assertPromotablePartition(partition, candidates.map(value => value.familyCandidateKey));
});

test("central identity memo commitment rejects an opaque value/hash mismatch", async () => {
  const value = candidate("memo-binding");
  const memoValue = identityMemo("memo-binding");
  const programs: AttestationProgramPort = {
    async attestIdentity() {
      return {
        kind: "identityVerified" as const,
        familyInstanceKey: "instance:memo-binding",
        identityMemo: { ...memoValue, value: "tampered" },
        identityMemoHash: memoHash("memo-binding"),
        descriptorHash: h("descriptor"),
        evidenceRoot: h("evidence"),
      };
    },
    async materializeAndProject() { throw new Error("memo mismatch must not materialize"); },
  };
  const partition = await attestPartition(attestArgs(), programs, [value]);
  assert.equal(partition.outcomes[0]?.kind, "invalidProgram");
});

test("constructor-bound run sessions separate partial identity persistence and seal only after writer drain", async () => {
  const value = candidate("session");
  const identity: IdentityVerifiedObservationV1 = {
    kind: "identityVerified",
    familyInstanceKey: "instance:session",
    identityMemo: identityMemo("session-identity"),
    identityMemoHash: memoHash("session-identity"),
    descriptorHash: h("session-descriptor"),
    evidenceRoot: h("session-evidence"),
  };
  const args = attestArgs();
  const programs: AttestationProgramPort = {
    async attestIdentity() { return identity; },
    async materializeAndProject(candidateValue, identityValue) {
      return { kind: "verified", publication: publication(candidateValue, identityValue) };
    },
  };
  const { service, session } = openSession(args, programs, [value]);
  const identified = await session.resolveIdentityOrReuseProofOnce(value.familyCandidateKey, new AbortController().signal);
  assert.equal(identified.kind, "identityVerified");
  const partialClaim = service.validationAuthority.claimWriterCapabilities(session.writerCapability, [identified.persistenceCapability]);
  const partial = partialClaim.entries[0]!;
  partialClaim.commit();
  assert.equal(partial.kind, "partial-identity");
  assert.equal(partial.identity?.familyInstanceKey, identity.familyInstanceKey);
  assert.equal(partial.outcome, null);

  const final = await session.materializeAndProjectOnce(
    identified.continuation,
    new AbortController().signal,
  );
  assert.throws(
    () => session.sealExactPartition([final.persistenceCapability.outcomeHash]),
    /writer-not-drained/,
  );
  const finalClaim = service.validationAuthority.claimWriterCapabilities(session.writerCapability, [final.persistenceCapability]);
  const persisted = finalClaim.entries[0]!;
  finalClaim.commit();
  assert.equal(persisted.kind, "final");
  assert.equal(persisted.outcome?.kind, "verified");
  const partition = session.sealExactPartition([persisted.outcomeHash]);
  assert.equal(partition.outcomes.length, 1);
});

test("raw candidate or hand-written identity cannot cross the continuation boundary", async () => {
  const value = candidate("continuation-boundary");
  let materializationCalls = 0;
  const identity: IdentityVerifiedObservationV1 = {
    kind: "identityVerified",
    familyInstanceKey: "instance:continuation-boundary",
    identityMemo: identityMemo("continuation-identity"),
    identityMemoHash: memoHash("continuation-identity"),
    descriptorHash: h("continuation-descriptor"),
    evidenceRoot: h("continuation-evidence"),
  };
  const args = attestArgs();
  const programs: AttestationProgramPort = {
    async attestIdentity() { return identity; },
    async materializeAndProject(candidateValue, identityValue) {
      materializationCalls += 1;
      return { kind: "verified", publication: publication(candidateValue, identityValue) };
    },
  };
  const firstRun = openSession(args, programs, [value]);
  const { service, session } = firstRun;
  const identified = await session.resolveIdentityOrReuseProofOnce(value.familyCandidateKey, new AbortController().signal);
  assert.equal(identified.kind, "identityVerified");
  const forgedIdentity = { ...identified.identity, familyInstanceKey: "forged" };
  assert.throws(
    () => session.materializeAndProjectOnce({ candidate: value, identity: forgedIdentity } as never, new AbortController().signal),
    /continuation/i,
  );
  assert.throws(
    () => session.materializeAndProjectOnce({ ...identified.continuation } as never, new AbortController().signal),
    /continuation/i,
  );
  const otherPartition = args.partitionFor([value], "run-a-other");
  const otherSession = service.openRunSession({ candidatePartition: otherPartition.capability });
  assert.throws(
    () => otherSession.materializeAndProjectOnce(identified.continuation, new AbortController().signal),
    /continuation/i,
  );
  assert.throws(
    () => session.resolveIdentityOrReuseProofOnce(h("raw-candidate-mutation"), new AbortController().signal),
    /absent|candidate|key/i,
  );
  assert.equal(materializationCalls, 0);
});

test("collision admission requires two same-session continuations and cannot consume raw identity data", async () => {
  const first = candidate("collision-a");
  const second = candidate("collision-b");
  let materializationCalls = 0;
  const args = attestArgs();
  const programs: AttestationProgramPort = {
    async attestIdentity() {
      return {
        kind: "identityVerified" as const,
        familyInstanceKey: "same-instance",
        identityMemo: identityMemo("collision-identity"),
        identityMemoHash: memoHash("collision-identity"),
        descriptorHash: h("collision-descriptor"),
        evidenceRoot: h("collision-evidence"),
      };
    },
    async materializeAndProject() {
      materializationCalls += 1;
      throw new Error("collision must not materialize");
    },
  };
  const { session } = openSession(args, programs, [first, second]);
  const firstIdentity = await session.resolveIdentityOrReuseProofOnce(first.familyCandidateKey, new AbortController().signal);
  const secondIdentity = await session.resolveIdentityOrReuseProofOnce(second.familyCandidateKey, new AbortController().signal);
  assert.equal(firstIdentity.kind, "identityVerified");
  assert.equal(secondIdentity.kind, "identityVerified");
  assert.throws(
    () => session.issueNominationKeyCollision([{ candidate: first, identity: firstIdentity.identity }, { candidate: second, identity: secondIdentity.identity }] as never),
    /continuation/i,
  );
  assert.throws(
    () => session.issueNominationKeyCollision([firstIdentity.continuation]),
    /too-small|collision/i,
  );
  const outcomes = session.issueNominationKeyCollision([firstIdentity.continuation, secondIdentity.continuation]);
  assert.deepEqual(outcomes.map(result => result.outcome.kind), ["invalidProgram", "invalidProgram"]);
  assert.equal(materializationCalls, 0);
});

test("session resolve and materialize are single-flight and share one continuation and final capability", async () => {
  const value = candidate("concurrent-session");
  let identityCalls = 0;
  let materializationCalls = 0;
  let releaseIdentity!: () => void;
  let releaseMaterialization!: () => void;
  const identityGate = new Promise<void>(resolve => { releaseIdentity = resolve; });
  const materializationGate = new Promise<void>(resolve => { releaseMaterialization = resolve; });
  const args = attestArgs();
  const programs: AttestationProgramPort = {
    async attestIdentity() {
      identityCalls += 1;
      await identityGate;
      return {
        kind: "identityVerified" as const,
        familyInstanceKey: "concurrent-instance",
        identityMemo: identityMemo("concurrent-identity"),
        identityMemoHash: memoHash("concurrent-identity"),
        descriptorHash: h("concurrent-descriptor"),
        evidenceRoot: h("concurrent-evidence"),
      };
    },
    async materializeAndProject(candidateValue, identityValue) {
      materializationCalls += 1;
      await materializationGate;
      return { kind: "verified" as const, publication: publication(candidateValue, identityValue) };
    },
  };
  const { session } = openSession(args, programs, [value]);
  const resolveA = session.resolveIdentityOrReuseProofOnce(value.familyCandidateKey, new AbortController().signal);
  const resolveB = session.resolveIdentityOrReuseProofOnce(value.familyCandidateKey, new AbortController().signal);
  assert.strictEqual(resolveA, resolveB);
  assert.equal(identityCalls, 1);
  releaseIdentity();
  const [identityA, identityB] = await Promise.all([resolveA, resolveB]);
  assert.equal(identityA.kind, "identityVerified");
  assert.equal(identityB.kind, "identityVerified");
  assert.strictEqual(identityA.continuation, identityB.continuation);

  const materializeA = session.materializeAndProjectOnce(identityA.continuation, new AbortController().signal);
  const materializeB = session.materializeAndProjectOnce(identityB.continuation, new AbortController().signal);
  assert.strictEqual(materializeA, materializeB);
  assert.equal(materializationCalls, 1);
  releaseMaterialization();
  const [finalA, finalB] = await Promise.all([materializeA, materializeB]);
  assert.strictEqual(finalA, finalB);
  assert.strictEqual(finalA.persistenceCapability, finalB.persistenceCapability);
});

test("two nomination keys resolving to one instance are invalid, never silently merged", async () => {
  const candidates = [candidate("a"), candidate("b")];
  let lifecycleCalls = 0;
  const args = attestArgs();
  const programs: AttestationProgramPort = {
    async attestIdentity() {
      return { kind: "identityVerified", familyInstanceKey: "same", identityMemo: identityMemo("identity"), identityMemoHash: memoHash("identity"), descriptorHash: h("descriptor"), evidenceRoot: h("evidence") };
    },
    async materializeAndProject() {
      lifecycleCalls += 1;
      throw new Error("must not run");
    },
  };
  const { session } = openSession(args, programs, candidates);
  const firstIdentity = await session.resolveIdentityOrReuseProofOnce(candidates[0]!.familyCandidateKey, new AbortController().signal);
  const secondIdentity = await session.resolveIdentityOrReuseProofOnce(candidates[1]!.familyCandidateKey, new AbortController().signal);
  assert.equal(firstIdentity.kind, "identityVerified");
  assert.equal(secondIdentity.kind, "identityVerified");
  if (firstIdentity.kind !== "identityVerified" || secondIdentity.kind !== "identityVerified") throw new Error("expected identity results");
  const partition = session.issueNominationKeyCollision([firstIdentity.continuation, secondIdentity.continuation]);
  const outcomes = partition.map(result => result.outcome);
  assert.equal(lifecycleCalls, 0);
  assert.deepEqual(outcomes.map(value => value.kind), ["invalidProgram", "invalidProgram"]);
});

test("plugin explicit retryable remains retryable without framework transport binding", async () => {
  const value = candidate("a");
  const args = attestArgs();
  const programs: AttestationProgramPort = {
    async attestIdentity(candidateValue) {
      return {
        kind: "retryable",
        failure: {
          stage: "identity",
          failureCode: "rpc-deadline",
          attemptCount: "3",
          candidateSubjectHash: candidateValue.candidateSubjectHash,
          evidenceRoot: h("evidence"),
          frameworkBinding: null,
        },
      };
    },
    async materializeAndProject() { throw new Error("unused"); },
  };
  const partition = await attestPartition(args, programs, [value]);
  assert.equal(partition.outcomes[0]?.kind, "retryable");
  assert.equal(partition.accounting.chainProvenRejected, "0");
});

test("only an issuer token classified by the injected classifier becomes retryable", async () => {
  const value = candidate("a");
  const args = attestArgs();
  const token = args.framework.issuer.issue({
    context: { runId: "run-a", candidate: value, cutoff, stage: "identity" },
    failureClass: "rpc",
    failureCode: "rpc-deadline",
    attemptCount: "3",
    evidenceRoot: h("evidence"),
  });
  const programs: AttestationProgramPort = {
    async attestIdentity() { throw token; },
    async materializeAndProject() { throw new Error("unused"); },
  };
  const partition = await attestPartition(args, programs, [value]);
  assert.equal(partition.outcomes[0]?.kind, "retryable");
  assert.equal(partition.outcomes[0]?.kind === "retryable" && partition.outcomes[0].failure.frameworkBinding?.failureClass, "rpc");
});

test("framework retryability rejects cloned tokens, wrong candidate/stage, authority, and ordinary throws", async () => {
  const value = candidate("a");
  const runtime = frameworkRuntime();
  const token = runtime.issuer.issue({
    context: { runId: "run-a", candidate: value, cutoff, stage: "identity" },
    failureClass: "queue",
    failureCode: "queue-full",
    attemptCount: "1",
    evidenceRoot: h("queue-evidence"),
  });
  assert.throws(() => runtime.issuer.validate({ ...token }, { runId: "run-a", candidate: value, cutoff, stage: "identity" }), /not-issued/);
  assert.throws(() => runtime.issuer.validate(token, { runId: "run-a", candidate: candidate("b"), cutoff, stage: "identity" }), /context-mismatch/);
  assert.throws(() => runtime.issuer.validate(token, { runId: "run-a", candidate: value, cutoff, stage: "materialization" }), /context-mismatch/);
  const otherRuntime = createFrameworkFailureRuntime(
    releaseApproval(h("other-framework-authority"), h("executor-authority")),
    { classify(thrown) { return thrown; } },
  );
  const otherToken = otherRuntime.issuer.issue({
    context: { runId: "run-a", candidate: value, cutoff, stage: "identity" },
    failureClass: "storage",
    failureCode: "storage-unavailable",
    attemptCount: "1",
    evidenceRoot: h("storage-evidence"),
  });
  assert.throws(() => runtime.issuer.validate(otherToken, { runId: "run-a", candidate: value, cutoff, stage: "identity" }), /not-issued|authority-mismatch/);

  const args = attestArgs();
  const programs: AttestationProgramPort = {
    async attestIdentity() { throw new Error("rpc deadline"); },
    async materializeAndProject() { throw new Error("unused"); },
  };
  const ordinaryThrowPartition = await attestPartition(args, programs, [value]);
  assert.equal(ordinaryThrowPartition.outcomes[0]?.kind, "invalidProgram");
});

test("only scheduler-issued executor capabilities and branded runtimes can authorize rejection", async () => {
  const fixture = rejectionExecutor();
  assert.throws(
    () => createRejectionFactRuntime(fixture.executor as never),
    /capability/,
  );
  assert.throws(
    () => createRejectionFactRuntime({ ...fixture.capability }),
    /not-issued/,
  );

  const fakeRuntime = {
    workPlane: {},
    validateDecision() { throw new Error("fake runtime must never be called"); },
  };
  assert.throws(
    () => createAttestationService({
      composition: defaultApproval(),
      frameworkRuntime: frameworkRuntime(),
      rejectionRuntime: fakeRuntime as never,
      programs: {
        async attestIdentity() { throw new Error("unused"); },
        async materializeAndProject() { throw new Error("unused"); },
      },
      instanceLifecycle: new SingleFlight(),
      candidatePartitionReader: new CandidatePartitionCapabilityRegistryV1().reader,
    }),
    /runtime-not-issued/,
  );
});

test("freezeProgram commits a deep normalized context and recomputes its program id", async () => {
  const fixture = rejectionExecutor();
  const runtime = createRejectionFactRuntime(fixture.capability);
  const value = candidate("context-freeze");
  const input = rejectionProgramInput(value);
  const mutableCandidate = {
    ...value,
    evidence: value.evidence.map(ref => ({ ...ref })),
  };
  const mutableContext = {
    ...input.context,
    candidate: mutableCandidate,
    cutoff: { ...input.context.cutoff },
  };
  const mutableRequest = {
    requestId: input.request.requestId,
    record: { ...input.request.record },
  };
  const program = runtime.workPlane.builder.freezeProgram({
    context: mutableContext,
    request: mutableRequest,
  });
  const mutableEvidence = mutableCandidate.evidence[0];
  if (mutableEvidence?.kind !== "recent-log") throw new Error("expected recent-log evidence");
  mutableEvidence.address = "0xmutated";
  mutableContext.cutoff.number = "11";
  mutableRequest.record.to = "0xmutated";
  let observed: FrozenProgramExecutionViewV1 | undefined;
  await runtime.workPlane.executeAndInterpret(
    program,
    async (facts) => {
      observed = {
        programId: facts.programId,
        context: facts.request.record as never,
        request: facts.request,
        executorAuthorityRoot: facts.executorAuthorityRoot,
        workerEpoch: facts.workerEpoch,
        executorSessionHash: facts.executorSessionHash,
      };
      return { kind: "not-terminal" };
    },
    new AbortController().signal,
  );
  assert.ok(observed);
  assert.equal(observed?.programId, program.programId);
  assert.equal(observed?.request.record.to, "0xabc");
  assert.equal(fixture.calls[0]?.context.cutoff.number, "10");
  const frozenEvidence = fixture.calls[0]?.context.candidate.evidence[0];
  assert.equal(frozenEvidence?.kind === "recent-log" ? frozenEvidence.address : undefined, "0xabc");
});

test("AttestationService snapshots mutable run inputs before Family async work", async () => {
  const args = attestArgs();
  const originalCandidate = candidate("service-input-freeze");
  const mutableCandidate = {
    ...originalCandidate,
    evidence: originalCandidate.evidence.map(ref => ({ ...ref })),
  };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let seenCandidate: CandidateRecordV1 | undefined;
  let seenCutoff: typeof cutoff | undefined;
  const programs: AttestationProgramPort = {
    async attestIdentity(value, observedCutoff) {
      seenCandidate = value;
      seenCutoff = observedCutoff;
      await gate;
      return {
        kind: "identityVerified" as const,
        familyInstanceKey: "service-input-instance",
        identityMemo: identityMemo("service-input-identity"),
        identityMemoHash: memoHash("service-input-identity"),
        descriptorHash: h("service-input-descriptor"),
        evidenceRoot: h("service-input-evidence"),
      };
    },
    async materializeAndProject(value, identity) {
      return { kind: "verified" as const, publication: publication(value, identity) };
    },
  };
  const partition = args.partitionFor([mutableCandidate]);
  const service = args.serviceFor(programs);
  const session = service.openRunSession({ candidatePartition: partition.capability });
  const identityPromise = session.resolveIdentityOrReuseProofOnce(
    mutableCandidate.familyCandidateKey,
    new AbortController().signal,
  );
  const mutableEvidence = mutableCandidate.evidence[0];
  if (mutableEvidence?.kind !== "recent-log") throw new Error("expected recent-log evidence");
  mutableEvidence.address = "0xcaller-mutated";
  release();
  const identityResult = await identityPromise;
  assert.equal(identityResult.kind, "identityVerified");
  if (identityResult.kind !== "identityVerified") throw new Error("expected identity result");
  const partialClaim = service.validationAuthority.claimWriterCapabilities(session.writerCapability, [identityResult.persistenceCapability]);
  partialClaim.commit();
  const final = await session.materializeAndProjectOnce(identityResult.continuation, new AbortController().signal);
  const finalClaim = service.validationAuthority.claimWriterCapabilities(session.writerCapability, [final.persistenceCapability]);
  finalClaim.commit();
  const sealed = session.sealExactPartition([final.persistenceCapability.outcomeHash]);
  const observedPartition = service.validationAuthority.validatePartitionCapability(sealed, [originalCandidate]);
  const seenEvidence = seenCandidate?.evidence[0];
  assert.equal(seenEvidence?.kind === "recent-log" ? seenEvidence.address : undefined, "0xabc");
  assert.equal(seenCutoff?.number, "10");
  assert.equal(observedPartition.outcomes[0]?.kind, "verified");
});

test("mixed executor authority, worker epoch, or session source is fail-closed", async () => {
  const base = rejectionExecutor();
  const authority = createRejectionExecutorAuthorityIssuer(defaultApproval());
  const mixed: RejectionTransportExecutorV1 = {
    async execute(program, signal) {
      const result = await base.executor.execute(program, signal);
      const first = result.transport[0]!;
      return {
        transport: [
          first,
          {
            ...first,
            source: { ...first.source, workerEpoch: "stale-epoch" },
          },
        ],
        effects: result.effects,
      };
    },
  };
  const runtime = createRejectionFactRuntime(authority.issue(mixed));
  const program = runtime.workPlane.builder.freezeProgram(rejectionProgramInput(candidate("mixed-source")));
  await assert.rejects(
    runtime.workPlane.executeAndInterpret(
      program,
      async (_facts, token) => ({
        kind: "chainProvenRejected",
        rejectionFacts: token,
        decisionCode: "mixed",
        decisionBytes: encodeCanonicalBytes({ mixed: true }),
      }),
      new AbortController().signal,
    ),
    /authority|executor|session/,
  );
});

test("revoked/stale executor capability cannot execute a frozen program", async () => {
  const fixture = rejectionExecutor();
  const issuer = createRejectionExecutorAuthorityIssuer(defaultApproval());
  const capability = issuer.issue(fixture.executor);
  const runtime = createRejectionFactRuntime(capability);
  const program = runtime.workPlane.builder.freezeProgram(rejectionProgramInput(candidate("stale")));
  issuer.revoke();
  await assert.rejects(
    runtime.workPlane.executeAndInterpret(
      program,
      async (_facts, token) => ({
        kind: "chainProvenRejected",
        rejectionFacts: token,
        decisionCode: "should-not-run",
        decisionBytes: encodeCanonicalBytes({ stale: true }),
      }),
      new AbortController().signal,
    ),
    /stale|revoked/,
  );
});

test("authority lease rotation invalidates every older capability, not only one token", async () => {
  const fixture = rejectionExecutor();
  const issuer = createRejectionExecutorAuthorityIssuer(
    releaseApproval(h("framework-authority"), h("lease-authority"), "epoch-1", h("lease-session-1")),
  );
  const capabilityA = issuer.issue(fixture.executor);
  const capabilityB = issuer.issue(fixture.executor);
  const runtimeA = createRejectionFactRuntime(capabilityA);
  const runtimeB = createRejectionFactRuntime(capabilityB);
  const programA = runtimeA.workPlane.builder.freezeProgram(rejectionProgramInput(candidate("lease-a")));
  const programB = runtimeB.workPlane.builder.freezeProgram(rejectionProgramInput(candidate("lease-b")));
  issuer.rotate({ workerEpoch: "epoch-2", executorSessionHash: h("lease-session-2") });
  for (const [runtime, program] of [[runtimeA, programA], [runtimeB, programB]] as const) {
    await assert.rejects(
      runtime.workPlane.executeAndInterpret(
        program,
        async (_facts, token) => ({
          kind: "chainProvenRejected",
          rejectionFacts: token,
          decisionCode: "stale",
          decisionBytes: encodeCanonicalBytes({ stale: true }),
        }),
        new AbortController().signal,
      ),
      /stale|revoked/,
    );
  }
});

test("returned and reverted executor facts, including effects, can produce a terminal rejection", async () => {
  for (const kind of ["returned", "reverted"] as const) {
    const value = candidate(kind);
    const fixture = rejectionExecutor(kind);
    const rejection = createRejectionFactRuntime(fixture.capability);
    let generated: Awaited<ReturnType<typeof executeFamilyRejection>> | undefined;
    const args = attestArgs(rejection);
    const programs: AttestationProgramPort = {
      async attestIdentity() {
        generated = await executeFamilyRejection(rejection, value);
        return generated.decision;
      },
      async materializeAndProject() { throw new Error("unused"); },
    };
    const partition = await attestPartition(args, programs, [value]);
    assert.equal(fixture.calls.length, 1);
    assert.equal(partition.outcomes[0]?.kind, "chainProvenRejected");
    assert.equal(partition.accounting.chainProvenRejected, "1");
    const outcome = partition.outcomes[0]!;
    if (outcome.kind !== "chainProvenRejected" || !generated) throw new Error("expected chain rejection");
    assert.equal(outcome.rejectionEvidence.transportFacts[0]?.kind, kind);
    assert.equal(outcome.rejectionEvidence.effectObservations.length, 1);
    assert.equal(
      outcome.rejectionEvidence.transportFacts[0]?.fact.dataHex,
      `0x${Buffer.from(fixture.rawData).toString("hex")}`,
    );
    assert.equal(
      outcome.rejectionEvidence.request.canonicalBytesHex,
      `0x${Buffer.from(encodeCanonicalBytes(generated.request.record)).toString("hex")}`,
    );
    validateRejectionEvidenceBundle(outcome.rejectionEvidence);
    validateCandidateFinalOutcome("run-a", cutoff, value, outcome);
    assertPromotablePartition(partition, [value.familyCandidateKey]);
  }
});

test("transportFailure is never terminal chain evidence", async () => {
  const value = candidate("transport-failure");
  const fixture = rejectionExecutor("transportFailure");
  const rejection = createRejectionFactRuntime(fixture.capability);
  const args = attestArgs(rejection);
  const programs: AttestationProgramPort = {
    async attestIdentity() {
      return (await executeFamilyRejection(rejection, value)).decision;
    },
    async materializeAndProject() { throw new Error("unused"); },
  };
  const partition = await attestPartition(args, programs, [value]);
  assert.equal(partition.outcomes[0]?.kind, "invalidProgram");
  assert.equal(partition.accounting.chainProvenRejected, "0");
  assert.equal(partition.accounting.invalidProgram, "1");
});

test("bare proof/hash-only plugin output is invalidProgram, never terminal", async () => {
  const value = candidate("a");
  const args = attestArgs();
  const programs: AttestationProgramPort = {
    async attestIdentity() {
      return {
        kind: "chainProvenRejected",
        proof: { familyDefinitionHash: value.familyDefinitionHash, requestFingerprint: h("forged") },
      } as never;
    },
    async materializeAndProject() { throw new Error("unused"); },
  };
  const partition = await attestPartition(args, programs, [value]);
  assert.equal(partition.outcomes[0]?.kind, "invalidProgram");
  assert.equal(partition.accounting.chainProvenRejected, "0");
});

test("rejection token is framework-issued, context-bound, runtime-bound, and single-use", async () => {
  const value = candidate("token-binding");
  const fixture = rejectionExecutor();
  const runtime = createRejectionFactRuntime(fixture.capability);
  const generated = await executeFamilyRejection(runtime, value);
  const args = attestArgs(runtime);

  // The service consumes the exact token once. A structural clone is rejected
  // by the runtime's private WeakSet and is classified as invalidProgram.
  const cloned = {
    ...generated.decision,
    rejectionFacts: { ...generated.decision.rejectionFacts },
  };
  const clonedPartition = await partitionForIdentityDecision(args, value, cloned);
  assert.equal(clonedPartition.outcomes[0]?.kind, "invalidProgram");

  const fake = {
    ...generated.decision,
    rejectionFacts: { tokenHash: h("fake-token") },
  };
  const fakePartition = await partitionForIdentityDecision(args, value, fake);
  assert.equal(fakePartition.outcomes[0]?.kind, "invalidProgram");

  const wrongCandidatePartition = await partitionForIdentityDecision(
    args,
    candidate("other-candidate"),
    generated.decision,
  );
  assert.equal(wrongCandidatePartition.outcomes[0]?.kind, "invalidProgram");

  const otherRuntime = createRejectionFactRuntime(rejectionExecutor().capability);
  const otherArgs = attestArgs(otherRuntime);
  const crossRuntimePartition = await partitionForIdentityDecision(otherArgs, value, generated.decision);
  assert.equal(crossRuntimePartition.outcomes[0]?.kind, "invalidProgram");

  const firstPartition = await partitionForIdentityDecision(args, value, generated.decision);
  assert.equal(firstPartition.outcomes[0]?.kind, "chainProvenRejected");
  const replayPartition = await partitionForIdentityDecision(args, value, generated.decision);
  assert.equal(replayPartition.outcomes[0]?.kind, "invalidProgram");
});

test("persisted rejection evidence is independently exact and every semantic mutation fails", async () => {
  const value = candidate("a");
  const fixture = rejectionExecutor();
  const runtime = createRejectionFactRuntime(fixture.capability);
  let generated: Awaited<ReturnType<typeof executeFamilyRejection>> | undefined;
  const args = attestArgs(runtime);
  const programs: AttestationProgramPort = {
    async attestIdentity() {
      generated = await executeFamilyRejection(runtime, value);
      return generated.decision;
    },
    async materializeAndProject() { throw new Error("unused"); },
  };
  const partition = await attestPartition(args, programs, [value]);
  const outcome = partition.outcomes[0]!;
  assert.equal(outcome.kind, "chainProvenRejected");
  if (outcome.kind !== "chainProvenRejected" || !generated) throw new Error("expected chain rejection");
  assert.deepEqual(validateRejectionEvidenceBundle(outcome.rejectionEvidence), outcome.rejectionEvidence);
  const mutations: Array<[string, (bundle: RejectionEvidenceBundleV2) => RejectionEvidenceBundleV2]> = [
    ["request", bundle => ({ ...bundle, request: { ...bundle.request, record: { ...bundle.request.record, to: "0xdef" } } })],
    ["transport", bundle => ({ ...bundle, transportFacts: [{ ...bundle.transportFacts[0]!, fact: { ...bundle.transportFacts[0]!.fact, dataHex: "0x00" } }] })],
    ["effect", bundle => ({ ...bundle, effectObservations: [{ ...bundle.effectObservations[0]!, observation: { ...bundle.effectObservations[0]!.observation, value: { token: "0xtoken", account: "0xabc", delta: "1" } } }] })],
    ["source-authority", bundle => ({
      ...bundle,
      transportFacts: [{
        ...bundle.transportFacts[0]!,
        fact: {
          ...bundle.transportFacts[0]!.fact,
          source: {
            ...(bundle.transportFacts[0]!.fact.source as Record<string, unknown>),
            executorSessionHash: h("other-session"),
          },
        },
      }],
    })],
    ["decision", bundle => ({ ...bundle, decisionCode: "other" })],
    ["root", bundle => ({ ...bundle, evidenceBundleRoot: h("forged-root") })],
  ];
  for (const [name, mutate] of mutations) {
    assert.throws(() => validateCandidateFinalOutcome("run-a", cutoff, value, {
      ...outcome,
      rejectionEvidence: mutate(outcome.rejectionEvidence),
    }), /root|canonical|derived|mismatch|rejection|invalid/i, name);
  }
});

test("materialization rejection binds the exact verified identity subject", async () => {
  const value = candidate("a");
  const identity = {
    kind: "identityVerified" as const,
    familyInstanceKey: "instance:a",
    identityMemo: identityMemo("identity"),
    identityMemoHash: memoHash("identity"),
    descriptorHash: h("descriptor"),
    evidenceRoot: h("identity-evidence"),
  };
  const subject = verifiedIdentitySubjectHash(value, identity);
  const runtime = createRejectionFactRuntime(rejectionExecutor().capability);
  let generated: Awaited<ReturnType<typeof executeFamilyRejection>> | undefined;
  const args = attestArgs(runtime);
  const programs: AttestationProgramPort = {
    async attestIdentity() { return identity; },
    async materializeAndProject() {
      generated = await executeFamilyRejection(runtime, value, "materialization", subject);
      return generated.decision;
    },
  };
  const partition = await attestPartition(args, programs, [value]);
  assert.equal(partition.outcomes[0]?.kind, "chainProvenRejected");

  const wrongRuntime = createRejectionFactRuntime(rejectionExecutor().capability);
  const wrongArgs = attestArgs(wrongRuntime);
  const wrongPrograms: AttestationProgramPort = {
    async attestIdentity() { return identity; },
    async materializeAndProject() {
      return (await executeFamilyRejection(wrongRuntime, value, "materialization", h("wrong-subject"))).decision;
    },
  };
  const forgedPartition = await attestPartition(wrongArgs, wrongPrograms, [value]);
  assert.equal(forgedPartition.outcomes[0]?.kind, "invalidProgram");
  assert.equal(forgedPartition.accounting.chainProvenRejected, "0");
  assert.ok(generated);
});

test("executor bytes are copied into evidence before the Family can mutate its source buffer", async () => {
  const value = candidate("byte-copy");
  const fixture = rejectionExecutor();
  const runtime = createRejectionFactRuntime(fixture.capability);
  const generated = await executeFamilyRejection(runtime, value);
  const originalHex = `0x${Buffer.from(fixture.rawData).toString("hex")}`;
  fixture.rawData[0] = 0x00;
  fixture.rawData[1] = 0x00;
  assert.equal(generated.evidence.transportFacts[0]?.fact.dataHex, originalHex);
  validateRejectionEvidenceBundle(generated.evidence);
});

test("executor failure is diagnostic invalidProgram, never retryable or chain rejection", async () => {
  const value = candidate("executor-throw");
  const executor: RejectionTransportExecutorV1 = {
    async execute() { throw new Error("revm executor failed"); },
  };
  const authority = createRejectionExecutorAuthorityIssuer(defaultApproval());
  const runtime = createRejectionFactRuntime(authority.issue(executor));
  const args = attestArgs(runtime);
  const programs: AttestationProgramPort = {
    async attestIdentity() {
      return (await executeFamilyRejection(runtime, value)).decision;
    },
    async materializeAndProject() { throw new Error("unused"); },
  };
  const partition = await attestPartition(args, programs, [value]);
  assert.deepEqual(partition.accounting, {
    pending: "0",
    verified: "0",
    chainProvenRejected: "0",
    retryable: "0",
    invalidProgram: "1",
  });
});

test("invalid ordinary throw remains diagnostic rather than retryable or chain rejection", async () => {
  const value = candidate("a");
  const args = attestArgs();
  const programs: AttestationProgramPort = {
    async attestIdentity() { throw new Error("decode bug"); },
    async materializeAndProject() { throw new Error("unused"); },
  };
  const partition = await attestPartition(args, programs, [value]);
  assert.deepEqual(partition.accounting, { pending: "0", verified: "0", chainProvenRejected: "0", retryable: "0", invalidProgram: "1" });
});
