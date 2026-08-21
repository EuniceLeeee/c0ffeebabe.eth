import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import type { AttestationPartitionV1 } from "../../attestation/src/index.ts";
import { sealInstanceCatalog, sealInstancePublication } from "../../catalog/src/index.ts";
import { recentObservationRange, sealSourceCoverage } from "../../discovery/src/index.ts";
import {
  ReadyGenerationServiceV1,
  generationRefreshPolicyHash,
  type CanonicalPromotionPort,
  type ReadyCommitInputV1,
  type ReadyStorePort,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/ready", value);
const cutoff = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") };
const policy = {
  observationWindowBlocks: "50" as const,
  targetRefreshAgeBlocks: "20",
  maxServingAgeBlocks: "50",
  minPromotionMarginBlocks: "2",
  maxInProgressRuns: "1" as const,
};

const publication = sealInstancePublication({
  familyId: "family-a",
  familyDefinitionHash: h("definition"),
  familyCandidateKey: h("candidate"),
  instanceKey: "instance-a",
  cutoff,
  identityMemoHash: h("identity"),
  descriptorHash: h("descriptor"),
  staticProjectionMemoHash: h("projection-memo"),
  requestedArtifactDependencyRoot: h("dependencies"),
  validityDependencyRoot: h("validity"),
  transitions: [{
    inputAssetPorts: [{ assetRef: h("in"), portRef: h("in-port"), ordinal: "0" }],
    outputAssetPorts: [{ assetRef: h("out"), portRef: h("out-port"), ordinal: "0" }],
    opaqueTransitionRef: h("transition"),
    constraintRefs: [],
    staticProjectionHash: h("projection"),
  }],
  evidenceRoot: h("evidence"),
});

const partitionBody: Omit<AttestationPartitionV1, "exactOutcomePartitionRoot"> = {
  runId: "run-a",
  cutoff,
  outcomes: [{
    kind: "verified",
    runCandidateKey: hashDomain("aloha/run-candidate/v1", { runId: "run-a", familyCandidateKey: publication.familyCandidateKey }),
    familyCandidateKey: publication.familyCandidateKey,
    instanceKey: publication.instanceKey,
    publication,
  }],
  accounting: { pending: "0", verified: "1", chainProvenRejected: "0", retryable: "0", invalidProgram: "0" },
};
const partition: AttestationPartitionV1 = {
  ...partitionBody,
  exactOutcomePartitionRoot: hashDomain("aloha/exact-outcome-partition/v1", {
    runId: partitionBody.runId,
    cutoff: partitionBody.cutoff,
    outcomes: partitionBody.outcomes,
  }),
};

const coverageExecution = {
  plan: { ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: h("definition"), completeness: "complete-snapshot" },
  cutoff,
  outcome: "complete",
  from: "100",
  through: "100",
  previousAppliedThrough: null,
  resultPartitionRoot: h("partition"),
} as const;
const coverage = sealSourceCoverage(cutoff, [coverageExecution.plan], [coverageExecution]);
const currentCatalog = () => ({
  definitionCatalogRoot: h("definitions"),
  declaredSourcePlans: [coverageExecution.plan],
});

const input = {
  run: {
    runId: "run-a",
    parentGenerationId: null,
    cutoff,
    recentObservationRange: recentObservationRange(cutoff.number),
    definitionCatalogRoot: h("definitions"),
    sourceCoverage: coverage,
    candidatePartitionRoot: h("candidates"),
    candidateKeys: [publication.familyCandidateKey],
    verifiedMemoSetRoot: h("memos"),
    checkpointRevision: "7",
    partition,
  },
  instanceCatalog: sealInstanceCatalog(cutoff, [publication]),
  parentGenerationId: null,
  policy,
};

class Canonical implements CanonicalPromotionPort {
  age = "1";
  canonical = true;
  async assertStillCanonical(): Promise<void> { if (!this.canonical) throw new Error("reorg"); }
  async ageInBlocks(): Promise<string> { return this.age; }
  async withPromotionFence<T>(cutoffValue: typeof cutoff, work: (fence: { journalEpoch: string; cutoff: typeof cutoff }) => Promise<T>): Promise<T> {
    return work({ journalEpoch: "epoch-a", cutoff: cutoffValue });
  }
}

class Store implements ReadyStorePort {
  ready: ReadyCommitInputV1 | null = null;
  failCommit = false;
  async putContentAndFsync(kind: "instance-catalog" | "persisted-graph", value: object): Promise<Hash> {
    return kind === "instance-catalog"
      ? (value as { instanceCatalogRoot: Hash }).instanceCatalogRoot
      : (value as { graphRoot: Hash }).graphRoot;
  }
  async commitReadyCAS(value: ReadyCommitInputV1) {
    if (this.failCommit) throw new Error("cas-conflict");
    this.ready = value;
    const promotionRevision = "8";
    return {
      promotionRevision,
      readyRecordHash: hashDomain("aloha/ready-generation/v1", { ...value.ready, promotionRevision }),
    };
  }
  async loadReadyClosure() {
    if (!this.ready) throw new Error("ready-missing");
    return { sourceCoverage: coverage, instanceCatalog: this.ready.instanceCatalog, graph: this.ready.graph };
  }
  async assertContentRoot(_kind: "candidate-partition" | "verified-memo-set", root: Hash) {
    if (root.length === 0) throw new Error("content-root-missing");
  }
}

test("one CAS binds cutoff, catalog, Graph and policy into ready authority", async () => {
  const token = {};
  const store = new Store();
  const canonical = new Canonical();
  const service = new ReadyGenerationServiceV1(token, store, canonical, () => "1000", currentCatalog);
  const ready = await service.promote(token, input);
  assert.equal(ready.promotionRevision, "8");
  assert.equal(ready.instanceCatalogRoot, input.instanceCatalog.instanceCatalogRoot);
  assert.equal(ready.graphRoot, store.ready?.graph.graphRoot);
  assert.equal(ready.generationRefreshPolicyHash, generationRefreshPolicyHash(policy));
  assert.equal(store.ready?.expectedRevision, "7");
});

test("unauthorized caller and unresolved partition fail before promotion", async () => {
  const token = {};
  const store = new Store();
  const service = new ReadyGenerationServiceV1(token, store, new Canonical(), () => "1000", currentCatalog);
  await assert.rejects(() => service.promote({}, input), /unauthorized/);
  await assert.rejects(() => service.promote(token, {
    ...input,
    run: { ...input.run, partition: { ...partition, accounting: { ...partition.accounting, retryable: "1", verified: "0" } } },
  }), /retryable-outcomes/);
  assert.equal(store.ready, null);
});

test("content written before a failed CAS never becomes visible ready authority", async () => {
  const token = {};
  const store = new Store();
  store.failCommit = true;
  const service = new ReadyGenerationServiceV1(token, store, new Canonical(), () => "1000", currentCatalog);
  await assert.rejects(() => service.promote(token, input), /cas-conflict/);
  assert.equal(store.ready, null);
});

test("every serving admission rechecks canonical age and policy", async () => {
  const token = {};
  const store = new Store();
  const canonical = new Canonical();
  const service = new ReadyGenerationServiceV1(token, store, canonical, () => "1000", currentCatalog);
  const ready = await service.promote(token, input);
  canonical.age = "51";
  await assert.rejects(() => service.validateServing({ ready, expectedDefinitionCatalogRoot: h("definitions"), policy }), /stale/);
});
