import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { encodeCanonicalJson, hashCanonicalPartition, hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { sealInstanceCatalog } from "../../catalog/src/index.ts";
import {
  recentObservationRange,
  sealSourceCoverage,
  sourcePlanEvidenceRoot,
  sourcePlanExecutionRoot,
  sourcePlanIdentity,
  SOURCE_EVIDENCE_VERSION_V1,
  type SourcePlanExecutionV1,
} from "../../discovery/src/index.ts";
import { buildPersistedGraph } from "../../graph/src/index.ts";
import { issueCheckpointSealedRunReader } from "../../sealed-run-runtime/src/internal/reader-issuer.ts";
import type { SealedRunBindingV1, SealedRunCapabilityV1, SealedRunReaderPortV1, SealedRunSnapshotV1 } from "../../sealed-run-runtime/src/contract.ts";
import {
  createRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../runtime-authority/src/index.ts";
import {
  sealNominationClosureV1,
  sealQualifiedSourcePlanNominationReceiptV1,
} from "../../../specs/nomination-authority/src/index.ts";
import { ReadyGenerationServiceV1, createReadyPromotionAuthority, readyGenerationBaseHash, type CanonicalFencePort, type ReadyActivationInputV1, type ReadyGenerationV1, type ReadyStageInputV1, type ReadyStorePort } from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/ready-capability", value);
const cutoff = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") };
const policy = { observationWindowBlocks: "50" as const, targetRefreshAgeBlocks: "20", maxServingAgeBlocks: "50", minPromotionMarginBlocks: "2", maxInProgressRuns: "1" as const };
const plan = { ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: h("definition"), completeness: "complete-snapshot" as const, historyStartBlock: null };
const sourceEvidenceRefs = Object.freeze([]);
const rawLocatorHashes = Object.freeze([]);
const sourceEvidenceRoot = sourcePlanEvidenceRoot({ plan, cutoff, refs: sourceEvidenceRefs, rawLocatorHashes });
const sourceExecutionWithoutRoot: Omit<SourcePlanExecutionV1, "executionRoot"> = Object.freeze({
  kind: "source-plan-execution",
  version: SOURCE_EVIDENCE_VERSION_V1,
  plan,
  cutoff,
  outcome: "complete",
  from: "100",
  through: "100",
  previousAppliedThrough: null,
  resultPartitionRoot: h("results"),
  opaqueResult: Object.freeze({ kind: "ready-generation-test-empty" }),
  sourceEvidenceRefs,
  rawLocatorHashes,
  sourceEvidenceRoot,
});
const coverage = sealSourceCoverage(cutoff, [plan], [{
  ...sourceExecutionWithoutRoot,
  executionRoot: sourcePlanExecutionRoot(sourceExecutionWithoutRoot),
}]);
const instanceCatalog = sealInstanceCatalog(cutoff, []);
const graph = buildPersistedGraph(instanceCatalog);
const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(
  createRuntimeAuthorityDescriptorV1({
    runtimeBindingId: h("runtime-binding"),
    implementationCommit: "a".repeat(40),
  }),
);
const runtimeAuthorityPort = Object.freeze({
  readCurrent: () => Object.freeze({ runtimeAuthority }),
});
const candidateRoot = hashCanonicalPartition("aloha/candidate-partition/v2", []);
const nominationReceipt = sealQualifiedSourcePlanNominationReceiptV1({
  cutoff,
  familyId: "family.empty",
  familyDefinitionHash: plan.familyDefinitionHash,
  sourcePlanIdentity: sourcePlanIdentity(plan),
  sourcePlanLeafDigest: h("source-plan-leaf"),
  nominationProgramRoot: h("nomination-program"),
  nominationProgramProposalLeafDigest: h("nomination-program-proposal"),
  qualificationRoot: h("nomination-qualification"),
  denominator: {
    kind: "complete-source-result",
    persistedExecutionRoot: h("persisted-execution"),
    resultPartitionRoot: sourceExecutionWithoutRoot.resultPartitionRoot,
  },
  claims: [],
});
const nominationClosure = sealNominationClosureV1({
  cutoff,
  recentObservationRoot: h("recent-observation"),
  sourceExecutionSetRoot: h("source-execution-set"),
  sourceCoverageRoot: coverage.sourceCoverageRoot,
  sourcePlanIdentities: [sourcePlanIdentity(plan)],
  receipts: [nominationReceipt],
  candidates: [],
  candidatePartitionRoot: candidateRoot,
});

function binding(): SealedRunBindingV1 {
  const base = {
    runId: "run-a", parentGenerationId: null, cutoff, recentObservationRange: recentObservationRange(cutoff.number),
    definitionCatalogRoot: h("definitions"), sourceCoverageRoot: coverage.sourceCoverageRoot,
    candidatePartitionRoot: candidateRoot, candidatePartitionStorageHash: h("candidate-storage"),
    candidatePartitionCommitmentStorageHash: h("candidate-commitment"),
    nominationClosureRoot: nominationClosure.root,
    nominationClosureStorageHash: h("nomination-storage"),
    verifiedMemoSetRoot: h("memos"), checkpointRevision: "7", runtimeAuthority,
    attestationAuthorityRoot: h("attestation"), frameworkAuthorityRoot: h("framework"),
    executorAuthorityRoot: h("executor"),
  };
  const exactOutcomePartitionRoot = hashDomain("aloha/exact-outcome-partition/v1", {
    runId: base.runId, cutoff: base.cutoff, candidatePartitionRoot: base.candidatePartitionRoot,
    runtimeAuthority: base.runtimeAuthority,
    attestationAuthorityRoot: base.attestationAuthorityRoot,
    frameworkAuthorityRoot: base.frameworkAuthorityRoot,
    executorAuthorityRoot: base.executorAuthorityRoot,
    outcomesRoot: hashCanonicalPartition("aloha/candidate-outcomes/v1", []),
  });
  return { ...base, exactOutcomePartitionRoot };
}

function snapshot(value = binding()): SealedRunSnapshotV1 {
  return { ...value, sourceCoverage: coverage, candidateKeys: [], partition: {
    runId: value.runId, cutoff: value.cutoff, candidatePartitionRoot: value.candidatePartitionRoot, outcomes: [],
    runtimeAuthority: value.runtimeAuthority,
    attestationAuthorityRoot: value.attestationAuthorityRoot,
    frameworkAuthorityRoot: value.frameworkAuthorityRoot,
    executorAuthorityRoot: value.executorAuthorityRoot,
    accounting: { pending: "0", verified: "0", chainProvenRejected: "0", retryable: "0", invalidProgram: "0" },
    exactOutcomePartitionRoot: value.exactOutcomePartitionRoot,
  } };
}

function snapshotBinding(value: SealedRunSnapshotV1): SealedRunBindingV1 {
  const { sourceCoverage: _coverage, candidateKeys: _keys, partition: _partition, ...rest } = value;
  return rest;
}

function issuedReader(initial = snapshot()) {
  const capability = Object.freeze({}) as SealedRunCapabilityV1;
  let current = initial;
  const expected = binding();
  const reader = issueCheckpointSealedRunReader(Object.freeze({
    binding(value: SealedRunCapabilityV1) {
      if (value !== capability) throw new TypeError("sealed-run-capability-not-issued");
      return expected;
    },
    readForPromotion(value: SealedRunCapabilityV1) {
      if (value !== capability) throw new TypeError("sealed-run-capability-not-issued");
      if (encodeCanonicalJson(snapshotBinding(current)) !== encodeCanonicalJson(expected)) throw new TypeError("sealed-run-capability-binding-mismatch");
      return current;
    },
  } satisfies SealedRunReaderPortV1));
  return { capability, reader, set(value: SealedRunSnapshotV1) { current = value; } };
}

class Canonical implements CanonicalFencePort {
  age = "1"; events: string[] = [];
  async assertStillCanonical() {} async ageInBlocks() { return this.age; }
  recentObservationRange(value: typeof cutoff) { return recentObservationRange(value.number); }
  async withCanonicalFence<T>(value: typeof cutoff, work: (fence: { token: string; journalEpoch: string; canonicalJournalRoot: Hash; cutoff: typeof cutoff }) => Promise<T>) { return work({ token: "fence", journalEpoch: "1", canonicalJournalRoot: h("journal"), cutoff: value }); }
  async observePromotionFreshness(fence: { journalEpoch: string; canonicalJournalRoot: Hash }, request: { cutoff: typeof cutoff; maxPromotionAgeBlocks: string; generationRefreshPolicyHash: Hash }) {
    this.events.push("freshness");
    if (BigInt(this.age) > BigInt(request.maxPromotionAgeBlocks)) throw new Error("promotion-cutoff-too-old");
    const observedHead = {
      ...request.cutoff,
      number: (BigInt(request.cutoff.number) + BigInt(this.age)).toString(),
      hash: h(`observed-head:${this.age}`),
      parentHash: h(`observed-parent:${this.age}`),
      stateRoot: h(`observed-state:${this.age}`),
    };
    const payload = { cutoff: request.cutoff, observedHead, observedAgeBlocks: this.age, maxPromotionAgeBlocks: request.maxPromotionAgeBlocks, generationRefreshPolicyHash: request.generationRefreshPolicyHash, journalEpoch: fence.journalEpoch, canonicalJournalRoot: fence.canonicalJournalRoot };
    return { token: "fresh", receipt: { ...payload, freshnessReceiptHash: hashDomain("aloha/promotion-freshness-receipt/v1", payload) } };
  }
  assertPromotionFreshness() {}
}

class Store implements ReadyStorePort {
  staged: ReadyStageInputV1 | null = null; activated: ReadyActivationInputV1 | null = null; active: ReadyGenerationV1 | null = null; events: string[] = [];
  async putContentAndFsync(kind: "instance-catalog" | "persisted-graph", value: object): Promise<Hash> { return kind === "instance-catalog" ? (value as typeof instanceCatalog).instanceCatalogRoot : (value as typeof graph).graphRoot; }
  async stageReadyCAS(value: ReadyStageInputV1) {
    this.events.push("stage"); this.staged = value;
    return { stage: { stageStorageHash: h("stage-storage"), runId: value.expectedInProgressRunId, expectedRevision: value.expectedRevision, sealedRevision: value.expectedRevision, stageRevision: (BigInt(value.expectedRevision) + 1n).toString(), stageRecordHash: h("stage"), readyBaseHash: readyGenerationBaseHash(value.ready), cutoff: value.ready.cutoff, generationRefreshPolicyHash: value.ready.generationRefreshPolicyHash, definitionCatalogRoot: value.ready.definitionCatalogRoot, runtimeAuthority: value.ready.runtimeAuthority, candidatePartitionCommitmentStorageHash: value.ready.candidatePartitionCommitmentStorageHash, nominationClosureRoot: value.ready.nominationClosureRoot, nominationClosureStorageHash: value.ready.nominationClosureStorageHash }, stageRevision: "8", stageRecordHash: h("stage") };
  }
  async activateReadyCAS(value: ReadyActivationInputV1) {
    this.activated = value; const promotionRevision = "9";
    const readyPayload = { ...this.staged!.ready, promotionFreshness: value.freshness.receipt, promotedAtMonotonicNs: value.promotedAtMonotonicNs, promotionRevision };
    const readyRecordHash = hashDomain("aloha/ready-generation/v1", readyPayload);
    this.active = { ...readyPayload, readyRecordHash };
    return { promotionRevision, readyRecordHash };
  }
  async loadActiveReady() { return this.active; }
  async loadReadyClosure() { return { sourceCoverage: coverage, nominationClosure, instanceCatalog, graph }; }
  async assertContentRoot() {} assertReadyAuthorityActive() {}
}

function makeService(reader: SealedRunReaderPortV1, store = new Store(), canonical = new Canonical()) {
  const caller = {};
  const authority = createReadyPromotionAuthority(() => ({ definitionCatalogRoot: h("definitions"), policy }), runtimeAuthorityPort);
  return { caller, store, canonical, service: new ReadyGenerationServiceV1(caller, store, canonical, () => "1000", () => ({ definitionCatalogRoot: h("definitions"), declaredSourcePlans: [plan] }), authority, reader, runtimeAuthorityPort) };
}

const promotionInput = (sealedRun: SealedRunCapabilityV1) => ({ sealedRun, instanceCatalog, parentGenerationId: null, policy });

test("public ReadyGeneration API does not re-export the durable sealed-run snapshot", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const file = source.replace(/import\s+[\s\S]*?from\s+["'][^"']+["'];?/g, "");
  assert.doesNotMatch(file, /export\s+(?:type\s+)?\{[^}]*\bSealedRunSnapshotV1\b[^}]*\}/s);
  assert.doesNotMatch(file, /export\s+(?:interface|type|class|const|function)\s+SealedRunSnapshotV1\b/);
});

test("current runtime authority accepts one exact implementation projection", () => {
  const exactAuthority = projectRuntimeAuthorityDescriptorV1(
    createRuntimeAuthorityDescriptorV1({
      runtimeBindingId: h("exact-runtime-binding"),
      implementationCommit: "a".repeat(40),
    }),
  );
  const exactPort = Object.freeze({
    readCurrent: () => Object.freeze({ runtimeAuthority: exactAuthority }),
  });
  const issued = issuedReader();
  const authority = createReadyPromotionAuthority(
    () => ({ definitionCatalogRoot: h("definitions"), policy }),
    exactPort,
  );
  const service = new ReadyGenerationServiceV1(
    {},
    new Store(),
    new Canonical(),
    () => "1000",
    () => ({ definitionCatalogRoot: h("definitions"), declaredSourcePlans: [plan] }),
    authority,
    issued.reader,
    exactPort,
  );
  assert.doesNotThrow(() => service.assertOwnerCurrent());
  const badPort = Object.freeze({
    readCurrent: () => Object.freeze({ runtimeAuthority: exactAuthority, unexpectedMode: "legacy" }),
  });
  assert.throws(
    () => createReadyPromotionAuthority(
      () => ({ definitionCatalogRoot: h("definitions"), policy }),
      badPort as never,
    ).assertConfiguration({
      definitionCatalogRoot: h("definitions"),
      generationRefreshPolicyHash: hashDomain("aloha/generation-refresh-policy/v1", policy),
      runtimeAuthority: exactAuthority,
    }),
    /unknown field/,
  );
});

test("opaque sealed run promotes only through a checkpoint-issued reader", async () => {
  const issued = issuedReader(); const value = makeService(issued.reader);
  const ready = await value.service.promote(value.caller, promotionInput(issued.capability));
  assert.equal(ready.candidatePartitionRoot, binding().candidatePartitionRoot);
  assert.equal(value.store.staged?.expectedRevision, "7"); assert.ok(value.store.activated);
});

test("fake reader and fake, cloned, or foreign capability fail closed", async () => {
  assert.throws(() => makeService({ binding: (() => binding()) as never, readForPromotion: (() => snapshot()) as never }), /not checkpoint-issued/);
  const first = issuedReader(); const second = issuedReader(); const value = makeService(first.reader);
  for (const capability of [{}, { ...first.capability }, second.capability]) await assert.rejects(() => value.service.promote(value.caller, promotionInput(capability)), /not-issued/);
});

test("sealed run binding drift is rejected before stage or freshness", async () => {
  const issued = issuedReader(); issued.set(snapshot({ ...binding(), checkpointRevision: "8" })); const value = makeService(issued.reader);
  await assert.rejects(() => value.service.promote(value.caller, promotionInput(issued.capability)), /binding-mismatch/);
  assert.equal(value.store.staged, null); assert.deepEqual(value.canonical.events, []);
});

test("stage is durable before freshness and stale freshness never activates", async () => {
  const issued = issuedReader(); const store = new Store(); const canonical = new Canonical(); store.events = canonical.events;
  const value = makeService(issued.reader, store, canonical); await value.service.promote(value.caller, promotionInput(issued.capability));
  assert.deepEqual(canonical.events, ["stage", "freshness"]);
  const staleStore = new Store(); const staleCanonical = new Canonical(); staleCanonical.age = "49"; const stale = makeService(issued.reader, staleStore, staleCanonical);
  await assert.rejects(() => stale.service.promote(stale.caller, promotionInput(issued.capability)), /too-old/); assert.equal(staleStore.activated, null);
});

test("caller authority cannot substitute sealed run authority", async () => {
  const issued = issuedReader(); const value = makeService(issued.reader);
  await assert.rejects(() => value.service.promote({}, promotionInput(issued.capability)), /unauthorized/);
  await assert.rejects(() => value.service.promote(value.caller, promotionInput({})), /not-issued/);
});

test("reusable ready is admitted only through the durable record and current bindings", async () => {
  const issued = issuedReader(); const store = new Store(); const canonical = new Canonical();
  const value = makeService(issued.reader, store, canonical);
  const promoted = await value.service.promote(value.caller, promotionInput(issued.capability));
  const catalog = { definitionCatalogRoot: h("definitions"), declaredSourcePlans: [plan] };
  const reusable = await value.service.findLatestReusable(catalog, policy);
  assert.equal(reusable?.readyRecordHash, promoted.readyRecordHash);

  assert.equal(await value.service.findLatestReusable({
    definitionCatalogRoot: h("definitions"),
    declaredSourcePlans: [{ ...plan, ownerRef: h("foreign-owner") }],
  }, policy), null);
  assert.equal(await value.service.findLatestReusable(catalog, { ...policy, maxServingAgeBlocks: "51" }), null);

  canonical.age = "51";
  assert.equal(await value.service.findLatestReusable(catalog, policy), null);
});
