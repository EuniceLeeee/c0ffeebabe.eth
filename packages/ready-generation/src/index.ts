import { deepFreeze, hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { assertPromotablePartition, type AttestationPartitionV1 } from "../../attestation/src/index.ts";
import type { InstanceCatalogV1 } from "../../catalog/src/index.ts";
import {
  recentObservationRange,
  validateSourceCoverageCertificate,
  type BlockRangeV1,
  type CanonicalCutoffV1,
  type SourceCoverageCertificateV1,
  type SourcePlanRefV1,
} from "../../discovery/src/index.ts";
import { buildPersistedGraph, type PersistedGraphV1 } from "../../graph/src/index.ts";

export interface GenerationRefreshPolicyV1 {
  readonly observationWindowBlocks: "50";
  readonly targetRefreshAgeBlocks: string;
  readonly maxServingAgeBlocks: string;
  readonly minPromotionMarginBlocks: string;
  readonly maxInProgressRuns: "1";
}

export interface ReadyGenerationV1 {
  readonly generationId: string;
  readonly parentGenerationId: string | null;
  readonly generationRefreshPolicyHash: Hash;
  readonly cutoff: CanonicalCutoffV1;
  readonly recentObservationRange: BlockRangeV1;
  readonly definitionCatalogRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly candidatePartitionRoot: Hash;
  readonly verifiedMemoSetRoot: Hash;
  readonly instanceCatalogRoot: Hash;
  readonly graphRoot: Hash;
  readonly edgeCount: string;
  readonly instanceCount: string;
  readonly promotionRevision: string;
  readonly promotedAtMonotonicNs: string;
  readonly readyRecordHash: Hash;
}

export interface SealedRunForPromotionV1 {
  readonly runId: string;
  readonly parentGenerationId: string | null;
  readonly cutoff: CanonicalCutoffV1;
  readonly recentObservationRange: BlockRangeV1;
  readonly definitionCatalogRoot: Hash;
  readonly sourceCoverage: SourceCoverageCertificateV1;
  readonly candidatePartitionRoot: Hash;
  readonly candidateKeys: readonly Hash[];
  readonly verifiedMemoSetRoot: Hash;
  readonly checkpointRevision: string;
  readonly partition: AttestationPartitionV1;
}

export interface CanonicalPromotionFenceV1 {
  readonly journalEpoch: string;
  readonly cutoff: CanonicalCutoffV1;
}

export interface CanonicalPromotionPort {
  assertStillCanonical(cutoff: CanonicalCutoffV1): Promise<void>;
  ageInBlocks(cutoff: CanonicalCutoffV1): Promise<string>;
  withPromotionFence<T>(cutoff: CanonicalCutoffV1, work: (fence: CanonicalPromotionFenceV1) => Promise<T>): Promise<T>;
}

export interface ReadyCommitInputV1 {
  readonly expectedRevision: string;
  readonly expectedInProgressRunId: string;
  readonly fence: CanonicalPromotionFenceV1;
  readonly graph: PersistedGraphV1;
  readonly instanceCatalog: InstanceCatalogV1;
  readonly ready: Omit<ReadyGenerationV1, "promotionRevision" | "readyRecordHash">;
}

export interface ReadyCommitResultV1 {
  readonly promotionRevision: string;
  readonly readyRecordHash: Hash;
}

export interface ReadyStorePort {
  putContentAndFsync(kind: "instance-catalog" | "persisted-graph", value: object): Promise<Hash>;
  commitReadyCAS(input: ReadyCommitInputV1): Promise<ReadyCommitResultV1>;
  loadReadyClosure(ready: ReadyGenerationV1): Promise<{
    readonly sourceCoverage: SourceCoverageCertificateV1;
    readonly instanceCatalog: InstanceCatalogV1;
    readonly graph: PersistedGraphV1;
  }>;
  assertContentRoot(kind: "candidate-partition" | "verified-memo-set", root: Hash): Promise<void>;
}

export interface ReadyPromotionInputV1 {
  readonly run: SealedRunForPromotionV1;
  readonly instanceCatalog: InstanceCatalogV1;
  readonly parentGenerationId: string | null;
  readonly policy: GenerationRefreshPolicyV1;
}

export interface ServingValidationInputV1 {
  readonly ready: ReadyGenerationV1;
  readonly expectedDefinitionCatalogRoot: Hash;
  readonly policy: GenerationRefreshPolicyV1;
}

export interface CurrentDefinitionCatalogV1 {
  readonly definitionCatalogRoot: Hash;
  readonly declaredSourcePlans: readonly SourcePlanRefV1[];
}

const decimal = (value: string, name: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`${name} is not canonical decimal`);
  return BigInt(value);
};

export function generationRefreshPolicyHash(policy: GenerationRefreshPolicyV1): Hash {
  if (policy.observationWindowBlocks !== "50" || policy.maxInProgressRuns !== "1") {
    throw new Error("unsupported-generation-policy");
  }
  const target = decimal(policy.targetRefreshAgeBlocks, "targetRefreshAgeBlocks");
  const maximum = decimal(policy.maxServingAgeBlocks, "maxServingAgeBlocks");
  const margin = decimal(policy.minPromotionMarginBlocks, "minPromotionMarginBlocks");
  if (target >= maximum || margin >= maximum) throw new Error("invalid-generation-policy");
  return hashDomain("aloha/generation-refresh-policy/v1", policy);
}

function sameCutoff(left: CanonicalCutoffV1, right: CanonicalCutoffV1): boolean {
  return left.chainId === right.chainId && left.number === right.number
    && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function assertPromotionInput(input: ReadyPromotionInputV1): void {
  const { run, instanceCatalog } = input;
  if (input.parentGenerationId !== run.parentGenerationId) {
    throw new Error("parent-generation-binding-mismatch");
  }
  assertPromotablePartition(run.partition, run.candidateKeys);
  if (run.partition.runId !== run.runId || !sameCutoff(run.partition.cutoff, run.cutoff)) {
    throw new Error("attestation-run-binding-mismatch");
  }
  if (!sameCutoff(run.sourceCoverage.cutoff, run.cutoff)) throw new Error("coverage-cutoff-mismatch");
  if (run.sourceCoverage.sourceCoverageRoot.length === 0) throw new Error("coverage-root-missing");
  if (!sameCutoff(instanceCatalog.cutoff, run.cutoff)) throw new Error("instance-catalog-cutoff-mismatch");
  const expectedRange = recentObservationRange(run.cutoff.number);
  if (run.recentObservationRange.from !== expectedRange.from || run.recentObservationRange.to !== expectedRange.to) {
    throw new Error("recent-observation-range-mismatch");
  }
  const verifiedPublicationHashes = run.partition.outcomes
    .filter(outcome => outcome.kind === "verified")
    .map(outcome => outcome.publication.instancePublicationHash)
    .sort();
  const catalogPublicationHashes = instanceCatalog.publications.map(value => value.instancePublicationHash).sort();
  if (
    verifiedPublicationHashes.length !== catalogPublicationHashes.length
    || verifiedPublicationHashes.some((hash, index) => hash !== catalogPublicationHashes[index])
  ) throw new Error("verified-publication-catalog-mismatch");
}

export class ReadyGenerationServiceV1 {
  readonly #expectedCaller: object;
  readonly #store: ReadyStorePort;
  readonly #canonical: CanonicalPromotionPort;
  readonly #monotonicNow: () => string;
  readonly #currentDefinitionCatalog: () => CurrentDefinitionCatalogV1;

  constructor(
    expectedCaller: object,
    store: ReadyStorePort,
    canonical: CanonicalPromotionPort,
    monotonicNow: () => string,
    currentDefinitionCatalog: () => CurrentDefinitionCatalogV1,
  ) {
    this.#expectedCaller = expectedCaller;
    this.#store = store;
    this.#canonical = canonical;
    this.#monotonicNow = monotonicNow;
    this.#currentDefinitionCatalog = currentDefinitionCatalog;
  }

  async promote(caller: object, input: ReadyPromotionInputV1): Promise<ReadyGenerationV1> {
    if (caller !== this.#expectedCaller) throw new Error("promotion-caller-unauthorized");
    assertPromotionInput(input);
    const { run, instanceCatalog, policy } = input;
    const currentCatalog = this.#currentDefinitionCatalog();
    if (run.definitionCatalogRoot !== currentCatalog.definitionCatalogRoot) {
      throw new Error("promotion-definition-catalog-mismatch");
    }
    validateSourceCoverageCertificate(run.sourceCoverage, currentCatalog.declaredSourcePlans);
    await this.#canonical.assertStillCanonical(run.cutoff);
    const age = decimal(await this.#canonical.ageInBlocks(run.cutoff), "promotionAge");
    const latest = decimal(policy.maxServingAgeBlocks, "maxServingAgeBlocks")
      - decimal(policy.minPromotionMarginBlocks, "minPromotionMarginBlocks");
    if (age > latest) throw new Error("promotion-cutoff-too-old");

    const graph = buildPersistedGraph(instanceCatalog);
    const instanceCatalogContentHash = await this.#store.putContentAndFsync("instance-catalog", instanceCatalog);
    const graphContentHash = await this.#store.putContentAndFsync("persisted-graph", graph);
    if (instanceCatalogContentHash !== instanceCatalog.instanceCatalogRoot) {
      throw new Error("instance-catalog-content-hash-mismatch");
    }
    if (graphContentHash !== graph.graphRoot) throw new Error("graph-content-hash-mismatch");

    const policyHash = generationRefreshPolicyHash(policy);
    const promotedAtMonotonicNs = this.#monotonicNow();
    decimal(promotedAtMonotonicNs, "promotedAtMonotonicNs");
    const generationId = hashDomain("aloha/ready-generation-id/v1", {
      parentGenerationId: input.parentGenerationId,
      runId: run.runId,
      cutoff: run.cutoff,
      definitionCatalogRoot: run.definitionCatalogRoot,
      instanceCatalogRoot: instanceCatalog.instanceCatalogRoot,
      graphRoot: graph.graphRoot,
      policyHash,
    });
    const withoutRevision = deepFreeze({
      generationId,
      parentGenerationId: input.parentGenerationId,
      generationRefreshPolicyHash: policyHash,
      cutoff: run.cutoff,
      recentObservationRange: run.recentObservationRange,
      definitionCatalogRoot: run.definitionCatalogRoot,
      sourceCoverageRoot: run.sourceCoverage.sourceCoverageRoot,
      candidatePartitionRoot: run.candidatePartitionRoot,
      verifiedMemoSetRoot: run.verifiedMemoSetRoot,
      instanceCatalogRoot: instanceCatalog.instanceCatalogRoot,
      graphRoot: graph.graphRoot,
      edgeCount: graph.edgeCount,
      instanceCount: instanceCatalog.instanceCount,
      promotedAtMonotonicNs,
    });
    const committed = await this.#canonical.withPromotionFence(run.cutoff, async fence => {
      const fencedCatalog = this.#currentDefinitionCatalog();
      if (run.definitionCatalogRoot !== fencedCatalog.definitionCatalogRoot) {
        throw new Error("promotion-definition-catalog-mismatch");
      }
      validateSourceCoverageCertificate(run.sourceCoverage, fencedCatalog.declaredSourcePlans);
      return this.#store.commitReadyCAS({
        expectedRevision: run.checkpointRevision,
        expectedInProgressRunId: run.runId,
        fence,
        graph,
        instanceCatalog,
        ready: withoutRevision,
      });
    });
    const readyPayload = { ...withoutRevision, promotionRevision: committed.promotionRevision };
    const expectedReadyRecordHash = hashDomain("aloha/ready-generation/v1", readyPayload);
    if (committed.readyRecordHash !== expectedReadyRecordHash) {
      throw new Error("ready-record-hash-mismatch");
    }
    const ready = deepFreeze({ ...readyPayload, readyRecordHash: committed.readyRecordHash });
    await this.#canonical.assertStillCanonical(run.cutoff);
    return ready;
  }

  async validateServing(input: ServingValidationInputV1): Promise<void> {
    const expectedPolicyHash = generationRefreshPolicyHash(input.policy);
    const currentCatalog = this.#currentDefinitionCatalog();
    if (
      input.ready.definitionCatalogRoot !== input.expectedDefinitionCatalogRoot
      || input.ready.definitionCatalogRoot !== currentCatalog.definitionCatalogRoot
    ) {
      throw new Error("serving-definition-catalog-mismatch");
    }
    if (input.ready.generationRefreshPolicyHash !== expectedPolicyHash) {
      throw new Error("serving-policy-mismatch");
    }
    await this.#canonical.assertStillCanonical(input.ready.cutoff);
    const age = decimal(await this.#canonical.ageInBlocks(input.ready.cutoff), "servingAge");
    if (age > decimal(input.policy.maxServingAgeBlocks, "maxServingAgeBlocks")) {
      throw new Error("serving-generation-stale");
    }
    const readyPayload = {
      generationId: input.ready.generationId,
      parentGenerationId: input.ready.parentGenerationId,
      generationRefreshPolicyHash: input.ready.generationRefreshPolicyHash,
      cutoff: input.ready.cutoff,
      recentObservationRange: input.ready.recentObservationRange,
      definitionCatalogRoot: input.ready.definitionCatalogRoot,
      sourceCoverageRoot: input.ready.sourceCoverageRoot,
      candidatePartitionRoot: input.ready.candidatePartitionRoot,
      verifiedMemoSetRoot: input.ready.verifiedMemoSetRoot,
      instanceCatalogRoot: input.ready.instanceCatalogRoot,
      graphRoot: input.ready.graphRoot,
      edgeCount: input.ready.edgeCount,
      instanceCount: input.ready.instanceCount,
      promotedAtMonotonicNs: input.ready.promotedAtMonotonicNs,
      promotionRevision: input.ready.promotionRevision,
    };
    if (hashDomain("aloha/ready-generation/v1", readyPayload) !== input.ready.readyRecordHash) {
      throw new Error("serving-ready-record-hash-mismatch");
    }
    const closure = await this.#store.loadReadyClosure(input.ready);
    validateSourceCoverageCertificate(closure.sourceCoverage, currentCatalog.declaredSourcePlans);
    if (closure.sourceCoverage.sourceCoverageRoot !== input.ready.sourceCoverageRoot) {
      throw new Error("serving-source-coverage-root-mismatch");
    }
    const recomputedGraph = buildPersistedGraph(closure.instanceCatalog);
    const suppliedGraphRoot = hashDomain("aloha/persisted-graph/v1", {
      cutoff: closure.graph.cutoff,
      instanceCatalogRoot: closure.graph.instanceCatalogRoot,
      edges: closure.graph.edges,
    });
    if (
      closure.instanceCatalog.instanceCatalogRoot !== input.ready.instanceCatalogRoot
      || closure.instanceCatalog.instanceCount !== input.ready.instanceCount
      || closure.graph.graphRoot !== input.ready.graphRoot
      || suppliedGraphRoot !== input.ready.graphRoot
      || closure.graph.edgeCount !== String(closure.graph.edges.length)
      || recomputedGraph.graphRoot !== input.ready.graphRoot
      || recomputedGraph.edgeCount !== input.ready.edgeCount
    ) throw new Error("serving-ready-closure-mismatch");
    await this.#store.assertContentRoot("candidate-partition", input.ready.candidatePartitionRoot);
    await this.#store.assertContentRoot("verified-memo-set", input.ready.verifiedMemoSetRoot);
  }
}
