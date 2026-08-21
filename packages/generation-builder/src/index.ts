import type { Hash } from "../../canonical-codec/src/index.ts";
import type { InstanceCatalogV1 } from "../../catalog/src/index.ts";
import {
  candidatePartitionRoot,
  mergeAndDedupeNominations,
  recentObservationRange,
  sealSourceCoverage,
  type CandidateNominationV1,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
  type SourcePlanExecutionV1,
  type SourcePlanRefV1,
} from "../../discovery/src/index.ts";
import { sealRecentObservation, type ObservedBlockV1, type RecentObservationReceiptV1 } from "../../observation/src/index.ts";
import type {
  GenerationRefreshPolicyV1,
  ReadyGenerationV1,
  ReadyPromotionInputV1,
  SealedRunForPromotionV1,
} from "../../ready-generation/src/index.ts";

export interface BuilderCatalogV1 {
  readonly definitionCatalogRoot: Hash;
  readonly declaredSourcePlans: readonly SourcePlanRefV1[];
}

export interface BuilderCheckpointRootV1 {
  readonly revision: string;
  readonly inProgressRunId: string | null;
  readonly readyGenerationId: string | null;
}

export interface InProgressBuilderRunV1 {
  readonly runId: string;
  readonly parentGenerationId: string | null;
  readonly checkpointRevision: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly recentObservation: RecentObservationReceiptV1;
  readonly definitionCatalogRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly candidatePartitionRoot: Hash;
  readonly candidates: readonly CandidateRecordV1[];
}

export interface BeginRunInputV1 {
  readonly expectedRootRevision: string;
  readonly parentGenerationId: string | null;
  readonly cutoff: CanonicalCutoffV1;
  readonly recentObservation: RecentObservationReceiptV1;
  readonly definitionCatalogRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly candidatePartitionRoot: Hash;
  readonly candidates: readonly CandidateRecordV1[];
}

export interface BuilderCheckpointPort {
  loadAndValidateRoot(): Promise<BuilderCheckpointRootV1>;
  loadRun(runId: string): Promise<InProgressBuilderRunV1>;
  beginNewRunAndPersistPartition(input: BeginRunInputV1): Promise<InProgressBuilderRunV1>;
  sealRunAndClearInProgressCAS(run: InProgressBuilderRunV1, reason: "stale-cutoff" | "definition-root-changed" | "run-corrupt"): Promise<void>;
  sealCompletedRunAsMemoSeedAndClearCAS(run: SealedRunForPromotionV1): Promise<void>;
}

export interface BuilderCanonicalPort {
  freezeView(signal: AbortSignal): Promise<CanonicalCutoffV1>;
  assertStillCanonical(cutoff: CanonicalCutoffV1): Promise<void>;
  ageInBlocks(cutoff: CanonicalCutoffV1): Promise<string>;
}

export interface BuilderDiscoveryPort {
  executeAllDeclaredPlans(catalog: BuilderCatalogV1, cutoff: CanonicalCutoffV1, signal: AbortSignal): Promise<readonly SourcePlanExecutionV1[]>;
  scanRecentBlocks(cutoff: CanonicalCutoffV1, signal: AbortSignal): Promise<readonly ObservedBlockV1[]>;
  nominateAll(
    catalog: BuilderCatalogV1,
    cutoff: CanonicalCutoffV1,
    sourceExecutions: readonly SourcePlanExecutionV1[],
    recent: RecentObservationReceiptV1,
    signal: AbortSignal,
  ): Promise<readonly CandidateNominationV1[]>;
}

export interface PersistedAttestationPort {
  attestAndPersistDifference(
    run: InProgressBuilderRunV1,
    candidates: readonly CandidateRecordV1[],
    signal: AbortSignal,
  ): Promise<{ readonly sealedRun: SealedRunForPromotionV1; readonly instanceCatalog: InstanceCatalogV1 }>;
}

export interface BoundReadyPromotionPort {
  findLatestReusable(catalog: BuilderCatalogV1, policy: GenerationRefreshPolicyV1): Promise<ReadyGenerationV1 | null>;
  promote(input: ReadyPromotionInputV1): Promise<ReadyGenerationV1>;
}

export interface GenerationBuilderDependencies {
  readonly policy: GenerationRefreshPolicyV1;
  readonly catalog: { loadExact(): BuilderCatalogV1 };
  readonly checkpoint: BuilderCheckpointPort;
  readonly canonical: BuilderCanonicalPort;
  readonly discovery: BuilderDiscoveryPort;
  readonly attestation: PersistedAttestationPort;
  readonly bindPromotion: (callerToken: object) => BoundReadyPromotionPort;
}

const decimal = (value: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError("invalid decimal");
  return BigInt(value);
};

function sameCutoff(left: CanonicalCutoffV1, right: CanonicalCutoffV1): boolean {
  return left.chainId === right.chainId && left.number === right.number
    && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

export class GenerationBuilderV1 {
  readonly #deps: Omit<GenerationBuilderDependencies, "bindPromotion">;
  readonly #promotion: BoundReadyPromotionPort;

  constructor(deps: GenerationBuilderDependencies) {
    const callerToken = Object.freeze({ generationBuilderCaller: Symbol("generation-builder") });
    this.#promotion = deps.bindPromotion(callerToken);
    this.#deps = deps;
  }

  async loadOrBuildInitialReady(signal: AbortSignal): Promise<ReadyGenerationV1> {
    const catalog = this.#deps.catalog.loadExact();
    const reusable = await this.#promotion.findLatestReusable(catalog, this.#deps.policy);
    if (reusable) return reusable;
    return this.buildNextReady(signal);
  }

  async buildNextReady(signal: AbortSignal): Promise<ReadyGenerationV1> {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const catalog = this.#deps.catalog.loadExact();
      const { run, candidates } = await this.loadOrBeginRun(catalog, signal);
      const completed = await this.#deps.attestation.attestAndPersistDifference(run, candidates, signal);
      await this.#deps.canonical.assertStillCanonical(run.cutoff);
      const age = decimal(await this.#deps.canonical.ageInBlocks(run.cutoff));
      const latest = decimal(this.#deps.policy.maxServingAgeBlocks)
        - decimal(this.#deps.policy.minPromotionMarginBlocks);
      if (age > latest) {
        await this.#deps.checkpoint.sealCompletedRunAsMemoSeedAndClearCAS(completed.sealedRun);
        continue;
      }
      return this.#promotion.promote({
        run: completed.sealedRun,
        instanceCatalog: completed.instanceCatalog,
        parentGenerationId: run.parentGenerationId,
        policy: this.#deps.policy,
      });
    }
  }

  private async loadOrBeginRun(
    catalog: BuilderCatalogV1,
    signal: AbortSignal,
  ): Promise<{ run: InProgressBuilderRunV1; candidates: readonly CandidateRecordV1[] }> {
    let root = await this.#deps.checkpoint.loadAndValidateRoot();
    if (root.inProgressRunId !== null) {
      const existing = await this.#deps.checkpoint.loadRun(root.inProgressRunId);
      let reason: "stale-cutoff" | "definition-root-changed" | "run-corrupt" | null = null;
      try {
        await this.#deps.canonical.assertStillCanonical(existing.cutoff);
        if (existing.definitionCatalogRoot !== catalog.definitionCatalogRoot) reason = "definition-root-changed";
        else if (
          candidatePartitionRoot(existing.candidates) !== existing.candidatePartitionRoot
          || existing.recentObservation.range.from !== recentObservationRange(existing.cutoff.number).from
          || existing.recentObservation.range.to !== existing.cutoff.number
          || !sameCutoff(existing.recentObservation.cutoff, existing.cutoff)
        ) reason = "run-corrupt";
      } catch {
        reason = "stale-cutoff";
      }
      if (reason === null) return { run: existing, candidates: existing.candidates };
      await this.#deps.checkpoint.sealRunAndClearInProgressCAS(existing, reason);
      root = await this.#deps.checkpoint.loadAndValidateRoot();
      if (root.inProgressRunId !== null) throw new Error("in-progress-run-not-cleared");
    }

    const cutoff = await this.#deps.canonical.freezeView(signal);
    const sourceExecutions = await this.#deps.discovery.executeAllDeclaredPlans(catalog, cutoff, signal);
    const coverage = sealSourceCoverage(cutoff, catalog.declaredSourcePlans, sourceExecutions);
    const recentBlocks = await this.#deps.discovery.scanRecentBlocks(cutoff, signal);
    const recent = sealRecentObservation(cutoff, recentBlocks);
    const nominations = await this.#deps.discovery.nominateAll(catalog, cutoff, sourceExecutions, recent, signal);
    const candidates = mergeAndDedupeNominations(nominations);
    const partitionRoot = candidatePartitionRoot(candidates);
    const run = await this.#deps.checkpoint.beginNewRunAndPersistPartition({
      expectedRootRevision: root.revision,
      parentGenerationId: root.readyGenerationId,
      cutoff,
      recentObservation: recent,
      definitionCatalogRoot: catalog.definitionCatalogRoot,
      sourceCoverageRoot: coverage.sourceCoverageRoot,
      candidatePartitionRoot: partitionRoot,
      candidates,
    });
    if (run.candidatePartitionRoot !== partitionRoot) throw new Error("persisted-candidate-partition-mismatch");
    return { run, candidates };
  }
}
