import type { Hash } from "../../canonical-codec/src/index.ts";
import type {
  CandidatePartitionCommitmentV1,
  CandidatePartitionCapabilityV1,
} from "../../../specs/candidate-partition-authority/src/index.ts";
import {
  decodeNominationClosureV1,
  type NominationClosureV1,
} from "../../../specs/nomination-authority/src/index.ts";
import { CanonicalSourceError } from "../../canonical-source/src/index.ts";
import type { InstanceCatalogV1 } from "../../catalog/src/index.ts";
import {
  decodePersistedSourcePlanExecutionSet,
  decodeSourcePlanDiscoveryResult,
  validateSourcePlanEvidenceReceipts,
  validatePersistedExecutionCoverage,
  sealSourceCoverage,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
  type SourcePlanExecutionV1,
  type SourcePlanDiscoveryResultV1,
  type SourcePlanEvidenceReceiptV1,
  type SourceCoverageCertificateV1,
  type PersistedSourcePlanExecutionSetV1,
  type SourcePlanRefV1,
} from "../../discovery/src/index.ts";
import {
  decodeRecentObservationScan,
  sealRecentObservation,
  type RawEvidenceLocatorContentV1,
  type RecentObservationReceiptV1,
  type RecentObservationScanV1,
} from "../../observation/src/index.ts";
import {
  authorizeReadyPromotionAbandon,
  generationRefreshPolicyHash,
  readReadyPromotionError,
  type ReadyPromotionAbandonAuthorizationV1,
  type ReadyPromotionAbandonResultV1,
  type ReadyPromotionDurableStateV1,
  type GenerationRefreshPolicyV1,
  type ReadyGenerationV1,
  type ReadyPromotionInputV1,
  type SealedRunBindingV1,
  type SealedRunCapabilityV1,
  type ReadyStageIdentityV1,
  validateReadyStageIdentity,
} from "../../ready-generation/src/index.ts";

export interface BuilderCatalogV1 {
  readonly definitionCatalogRoot: Hash;
  readonly declaredSourcePlans: readonly SourcePlanRefV1[];
}

export interface BuilderCheckpointRootV1 {
  readonly revision: string;
  readonly inProgressRunId: string | null;
  readonly stagedReadyStorageHash: Hash | null;
  readonly readyGenerationId: string | null;
  readonly readyGenerationRecordHash: Hash | null;
}

export interface InProgressBuilderRunV1 {
  readonly runId: string;
  readonly parentGenerationId: string | null;
  readonly checkpointRevision: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly recentObservation: RecentObservationReceiptV1;
  readonly sourcePlanEvidence: readonly SourcePlanEvidenceReceiptV1[];
  readonly definitionCatalogRoot: Hash;
  readonly sourceCoverage: SourceCoverageCertificateV1;
  readonly sourceExecutionSet: PersistedSourcePlanExecutionSetV1;
  readonly nominationClosure: NominationClosureV1;
  /** The only candidate authority exposed after checkpoint persistence. */
  readonly candidatePartition: CandidatePartitionCapabilityV1;
  readonly candidatePartitionBinding: CandidatePartitionCommitmentV1;
}

export interface BeginRunInputV1 {
  readonly expectedRootRevision: string;
  readonly parentGenerationId: string | null;
  readonly cutoff: CanonicalCutoffV1;
  readonly recentObservation: RecentObservationReceiptV1;
  readonly sourcePlanEvidence: readonly SourcePlanEvidenceReceiptV1[];
  readonly definitionCatalogRoot: Hash;
  readonly sourceCoverage: SourceCoverageCertificateV1;
  readonly sourceExecutionSet: PersistedSourcePlanExecutionSetV1;
  readonly nominationClosure: NominationClosureV1;
  readonly candidates: readonly CandidateRecordV1[];
  readonly recentRawEvidenceLocators: readonly RawEvidenceLocatorContentV1[];
  readonly sourcePlanRawEvidenceLocators: readonly RawEvidenceLocatorContentV1[];
}

export interface BuilderCheckpointPort {
  loadAndValidateRoot(): Promise<BuilderCheckpointRootV1>;
  loadRun(runId: string): Promise<InProgressBuilderRunV1>;
  loadSourcePlanPredecessor(parentGenerationId: string | null): Promise<SourcePlanPredecessorClosureV1 | null>;
  loadStagedPromotion(): Promise<{ readonly sealedRun: SealedRunCapabilityV1; readonly sealedRunBinding: SealedRunBindingV1; readonly instanceCatalog: InstanceCatalogV1; readonly stage: ReadyStageIdentityV1 } | null>;
  beginNewRunAndPersistPartition(input: BeginRunInputV1): Promise<InProgressBuilderRunV1>;
  sealRunAndClearInProgressCAS(run: InProgressBuilderRunV1, reason: "stale-cutoff" | "definition-root-changed" | "run-corrupt"): Promise<void>;
  resolveStagedPromotion(stage: ReadyStageIdentityV1): Promise<ReadyPromotionDurableStateV1>;
  abandonStagedPromotionCAS(stage: ReadyStageIdentityV1, authorization: ReadyPromotionAbandonAuthorizationV1): Promise<ReadyPromotionAbandonResultV1>;
  sealCompletedRunAsMemoSeedAndClearCAS(run: SealedRunCapabilityV1): Promise<void>;
}

export interface BuilderCanonicalPort {
  freezeView(signal: AbortSignal): Promise<CanonicalCutoffV1>;
  assertStillCanonical(cutoff: CanonicalCutoffV1): Promise<void>;
  ageInBlocks(cutoff: CanonicalCutoffV1): Promise<string>;
  recentObservationRange(cutoff: CanonicalCutoffV1): { readonly from: string; readonly to: string };
}

export interface BuilderDiscoveryPort {
  executeAllDeclaredPlans(
    catalog: BuilderCatalogV1,
    cutoff: CanonicalCutoffV1,
    predecessor: SourcePlanPredecessorClosureV1 | null,
    signal: AbortSignal,
  ): Promise<DurableSourcePlanDiscoveryResultV1>;
  scanRecentBlocks(cutoff: CanonicalCutoffV1, signal: AbortSignal): Promise<RecentObservationScanV1>;
  nominateAll(
    catalog: BuilderCatalogV1,
    cutoff: CanonicalCutoffV1,
    sourceExecutions: readonly SourcePlanExecutionV1[],
    sourceEvidence: readonly SourcePlanEvidenceReceiptV1[],
    sourceRawEvidenceLocators: readonly RawEvidenceLocatorContentV1[],
    recent: RecentObservationReceiptV1,
    recentRawEvidenceLocators: readonly RawEvidenceLocatorContentV1[],
    sourceExecutionSet: PersistedSourcePlanExecutionSetV1,
    sourceCoverage: SourceCoverageCertificateV1,
    signal: AbortSignal,
  ): Promise<BuilderNominationCapabilityV1>;
  readIssuedNomination(capability: BuilderNominationCapabilityV1): {
    readonly candidates: readonly CandidateRecordV1[];
    readonly nominationClosure: NominationClosureV1;
  };
}

/** Process-local discovery-owner authority; JSON clones and shape fakes fail. */
export type BuilderNominationCapabilityV1 = object;

export interface SourcePlanPredecessorClosureV1 {
  readonly sourceCoverage: SourceCoverageCertificateV1;
  readonly sourceExecutionSet: PersistedSourcePlanExecutionSetV1;
  readonly rawEvidenceLocators: readonly RawEvidenceLocatorContentV1[];
}

export interface DurableSourcePlanDiscoveryResultV1 {
  readonly discovery: SourcePlanDiscoveryResultV1;
  readonly sourceExecutionSet: PersistedSourcePlanExecutionSetV1;
}

export interface PersistedAttestationPort {
  attestAndPersistDifference(
    run: InProgressBuilderRunV1,
    signal: AbortSignal,
  ): Promise<{ readonly sealedRun: SealedRunCapabilityV1; readonly sealedRunBinding: SealedRunBindingV1; readonly instanceCatalog: InstanceCatalogV1 }>;
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

/**
 * A stored run can be discarded only when the canonical source has proved
 * that its cutoff is no longer the canonical cutoff.  Transport, fence and
 * implementation failures must leave the run in place for a later retry.
 */
function isTerminalCanonicalMismatch(error: unknown): boolean {
  return error instanceof CanonicalSourceError && [
    "hash-mismatch",
    "state-root-mismatch",
    "missing-header",
  ].includes(error.code);
}

function isCasConflict(error: unknown): boolean {
  return error instanceof Error && error.name === "CASConflictError";
}

function readyMatchesPromotionInput(
  ready: ReadyGenerationV1,
  input: ReadyPromotionInputV1,
  binding: SealedRunBindingV1,
): boolean {
  return ready.parentGenerationId === input.parentGenerationId
    && sameCutoff(ready.cutoff, binding.cutoff)
    && ready.generationRefreshPolicyHash === generationRefreshPolicyHash(input.policy)
    && ready.definitionCatalogRoot === binding.definitionCatalogRoot
    && ready.sourceCoverageRoot === binding.sourceCoverageRoot
    && ready.candidatePartitionRoot === binding.candidatePartitionRoot
    && ready.candidatePartitionCommitmentStorageHash === binding.candidatePartitionCommitmentStorageHash
    && ready.exactOutcomePartitionRoot === binding.exactOutcomePartitionRoot
    && ready.verifiedMemoSetRoot === binding.verifiedMemoSetRoot
    && ready.instanceCatalogRoot === input.instanceCatalog.instanceCatalogRoot;
}

type StagedPromotionRecoveryActionV1 =
  | { readonly kind: "abandon"; readonly authorization: ReadyPromotionAbandonAuthorizationV1 }
  | { readonly kind: "reload" }
  | { readonly kind: "retry"; readonly error: unknown }
  | { readonly kind: "fatal"; readonly error: unknown }
  | { readonly kind: "committed"; readonly ready: ReadyGenerationV1 };

type AbandonAttemptResultV1 =
  | ReadyPromotionAbandonResultV1
  | { readonly kind: "reload" }
  | { readonly kind: "retry"; readonly error: unknown };

function assertStagedPromotionBinding(
  staged: { readonly sealedRunBinding: SealedRunBindingV1; readonly stage: ReadyStageIdentityV1 },
): void {
  validateReadyStageIdentity(staged.stage);
  if (
    staged.stage.runId !== staged.sealedRunBinding.runId
    || staged.stage.expectedRevision !== staged.sealedRunBinding.checkpointRevision
    || staged.stage.sealedRevision !== staged.sealedRunBinding.checkpointRevision
    || !sameCutoff(staged.stage.cutoff, staged.sealedRunBinding.cutoff)
    || staged.stage.definitionCatalogRoot !== staged.sealedRunBinding.definitionCatalogRoot
    || staged.stage.candidatePartitionCommitmentStorageHash !== staged.sealedRunBinding.candidatePartitionCommitmentStorageHash
  ) {
    throw new Error("ready-promotion-stage-input-mismatch");
  }
}

function assertRecoveredStageMatchesInput(
  staged: { readonly sealedRun: SealedRunCapabilityV1; readonly sealedRunBinding: SealedRunBindingV1; readonly instanceCatalog: InstanceCatalogV1; readonly stage: ReadyStageIdentityV1 },
  input: ReadyPromotionInputV1,
): void {
  assertStagedPromotionBinding(staged);
  const run = staged.sealedRunBinding;
  if (
    run.parentGenerationId !== input.parentGenerationId
    || staged.instanceCatalog.instanceCatalogRoot !== input.instanceCatalog.instanceCatalogRoot
  ) {
    throw new Error("ready-promotion-recovery-input-mismatch");
  }
}

function reusableMatchesPromotion(
  ready: ReadyGenerationV1,
  input: ReadyPromotionInputV1,
  expectedReadyRecordHash?: Hash,
  binding?: SealedRunBindingV1,
): boolean {
  return (expectedReadyRecordHash === undefined || ready.readyRecordHash === expectedReadyRecordHash)
    && binding !== undefined
    && readyMatchesPromotionInput(ready, input, binding);
}

function isRecoverablePromotionError(error: unknown): boolean {
  const typed = readReadyPromotionError(error);
  if (typed?.recovery === "abandon" || typed?.recovery === "retry") return true;
  if (isCasConflict(error)) return true;
  return error instanceof CanonicalSourceError && [
    "transport",
    "canonical-view-superseded",
    "fence-invalid",
  ].includes(error.code);
}

function classifyStagedPromotionFailure(
  error: unknown,
  state: ReadyPromotionDurableStateV1,
): StagedPromotionRecoveryActionV1 {
  if (state.kind === "committed") {
    return isRecoverablePromotionError(error)
      ? { kind: "committed", ready: state.ready }
      : { kind: "fatal", error };
  }
  // An absent stage after an ambiguous call is a reload only for an error
  // whose class permits an ambiguous CAS outcome.  Treating every error as a
  // reload would turn an arbitrary post-CAS bug into an infinite rebuild loop.
  if (state.kind === "absent") {
    return isRecoverablePromotionError(error)
      ? { kind: "reload" }
      : { kind: "fatal", error };
  }
  const authorization = authorizeReadyPromotionAbandon(error, state.stage);
  if (authorization) return { kind: "abandon", authorization };
  const typed = readReadyPromotionError(error);
  if (error instanceof CanonicalSourceError) {
    if (["transport", "canonical-view-superseded", "fence-invalid"].includes(error.code)) {
      return { kind: "retry", error };
    }
    return { kind: "fatal", error };
  }
  if (typed?.recovery === "retry" || isCasConflict(error)) {
    return { kind: "retry", error };
  }
  return { kind: "fatal", error };
}

export class GenerationBuilderV1 {
  readonly #deps: Omit<GenerationBuilderDependencies, "bindPromotion">;
  readonly #promotion: BoundReadyPromotionPort;

  constructor(deps: GenerationBuilderDependencies) {
    const callerToken = Object.freeze({ generationBuilderCaller: Symbol("generation-builder") });
    this.#promotion = deps.bindPromotion(callerToken);
    this.#deps = deps;
  }

  /**
   * Abandon is itself a CAS operation.  A concurrent activation wins the
   * race legitimately; a retryable CAS outcome must be resolved from durable
   * state, never guessed from the thrown error.  Any other failure remains
   * fatal so a storage defect cannot become a rebuild loop.
   */
  private async abandonStagedPromotion(
    stage: ReadyStageIdentityV1,
    authorization: ReadyPromotionAbandonAuthorizationV1,
  ): Promise<AbandonAttemptResultV1> {
    try {
      return await this.#deps.checkpoint.abandonStagedPromotionCAS(stage, authorization);
    } catch (error) {
      const typed = readReadyPromotionError(error);
      if (!isCasConflict(error) && typed?.recovery !== "retry") throw error;
      const state = await this.#deps.checkpoint.resolveStagedPromotion(stage);
      if (state.kind === "committed") {
        return { kind: "committed", stage: state.stage, ready: state.ready };
      }
      if (state.kind === "absent") return { kind: "reload" };
      return { kind: "retry", error };
    }
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
      const staged = await this.#deps.checkpoint.loadStagedPromotion();
      if (staged !== null) {
        assertStagedPromotionBinding(staged);
        const stagedPromotionInput: ReadyPromotionInputV1 = {
          sealedRun: staged.sealedRun,
          instanceCatalog: staged.instanceCatalog,
          parentGenerationId: staged.sealedRunBinding.parentGenerationId,
          policy: this.#deps.policy,
        };
        try {
          // Await inside this try: returning the promise would bypass staged
          // recovery when promotion rejects asynchronously.
          return await this.#promotion.promote(stagedPromotionInput);
        } catch (error) {
          const state = await this.#deps.checkpoint.resolveStagedPromotion(staged.stage);
          const recovery = classifyStagedPromotionFailure(error, state);
          if (recovery.kind === "committed") {
            const reusable = await this.#promotion.findLatestReusable(catalog, this.#deps.policy);
            if (reusable && reusableMatchesPromotion(reusable, stagedPromotionInput, recovery.ready.readyRecordHash, staged.sealedRunBinding)) {
              return reusable;
            }
            continue;
          }
          if (recovery.kind === "reload") continue;
          if (recovery.kind === "retry" || recovery.kind === "fatal") throw recovery.error;
          const abandoned = await this.abandonStagedPromotion(staged.stage, recovery.authorization);
          if (abandoned.kind === "committed") {
            const reusable = await this.#promotion.findLatestReusable(catalog, this.#deps.policy);
            if (reusable && reusableMatchesPromotion(reusable, stagedPromotionInput, abandoned.ready.readyRecordHash, staged.sealedRunBinding)) {
              return reusable;
            }
          }
          continue;
        }
      }
      const { run } = await this.loadOrBeginRun(catalog, signal);
      const completed = await this.#deps.attestation.attestAndPersistDifference(run, signal);
      await this.#deps.canonical.assertStillCanonical(run.cutoff);
      const age = decimal(await this.#deps.canonical.ageInBlocks(run.cutoff));
      const latest = decimal(this.#deps.policy.maxServingAgeBlocks)
        - decimal(this.#deps.policy.minPromotionMarginBlocks);
      if (age > latest) {
        await this.#deps.checkpoint.sealCompletedRunAsMemoSeedAndClearCAS(completed.sealedRun);
        continue;
      }
      const promotionInput: ReadyPromotionInputV1 = {
        sealedRun: completed.sealedRun,
        instanceCatalog: completed.instanceCatalog,
        parentGenerationId: run.parentGenerationId,
        policy: this.#deps.policy,
      };
      try {
        return await this.#promotion.promote(promotionInput);
      } catch (error) {
        if (!isRecoverablePromotionError(error)) throw error;
        const reusable = await this.#promotion.findLatestReusable(catalog, this.#deps.policy);
        if (reusable && readyMatchesPromotionInput(reusable, promotionInput, completed.sealedRunBinding)) return reusable;

        // A failure may have happened after the stage CAS but before the
        // caller observed its identity.  Re-read the durable authority instead
        // of guessing from the thrown error or starting a second run.
        const recoveredStage = await this.#deps.checkpoint.loadStagedPromotion();
        if (recoveredStage !== null) {
          assertRecoveredStageMatchesInput(recoveredStage, promotionInput);
          const state = await this.#deps.checkpoint.resolveStagedPromotion(recoveredStage.stage);
          const recovery = classifyStagedPromotionFailure(error, state);
          if (recovery.kind === "committed") {
            const current = await this.#promotion.findLatestReusable(catalog, this.#deps.policy);
            if (current && reusableMatchesPromotion(current, promotionInput, recovery.ready.readyRecordHash, recoveredStage.sealedRunBinding)) {
              return current;
            }
            continue;
          }
          if (recovery.kind === "reload") continue;
          if (recovery.kind === "retry" || recovery.kind === "fatal") throw recovery.error;
          const abandoned = await this.abandonStagedPromotion(
            recoveredStage.stage,
            recovery.authorization,
          );
          if (abandoned.kind === "committed") {
            const current = await this.#promotion.findLatestReusable(catalog, this.#deps.policy);
            if (current && reusableMatchesPromotion(current, promotionInput, abandoned.ready.readyRecordHash, recoveredStage.sealedRunBinding)) {
              return current;
            }
          }
          continue;
        }

        const typed = readReadyPromotionError(error);
        // No durable stage exists, so there is no exact stage identity to
        // authorize an abandon against.  Preserve the typed error for the
        // caller instead of looping forever on an unchanged policy/config.
        if (typed?.recovery === "abandon") throw error;
        throw error;
      }
    }
  }

  private async loadOrBeginRun(
    catalog: BuilderCatalogV1,
    signal: AbortSignal,
  ): Promise<{ run: InProgressBuilderRunV1 }> {
    let root = await this.#deps.checkpoint.loadAndValidateRoot();
    if (root.inProgressRunId !== null) {
      const existing = await this.#deps.checkpoint.loadRun(root.inProgressRunId);
      let reason: "stale-cutoff" | "definition-root-changed" | "run-corrupt" | null = null;
      try {
        await this.#deps.canonical.assertStillCanonical(existing.cutoff);
        if (existing.definitionCatalogRoot !== catalog.definitionCatalogRoot) reason = "definition-root-changed";
        else if (
          existing.recentObservation.range.from !== this.#deps.canonical.recentObservationRange(existing.cutoff).from
          || existing.recentObservation.range.to !== this.#deps.canonical.recentObservationRange(existing.cutoff).to
          || !sameCutoff(existing.recentObservation.cutoff, existing.cutoff)
        ) reason = "run-corrupt";
        else {
          try {
            validateSourcePlanEvidenceReceipts(existing.sourcePlanEvidence, existing.cutoff, catalog.declaredSourcePlans);
            validatePersistedExecutionCoverage(existing.sourceExecutionSet, existing.sourceCoverage);
          } catch {
            reason = "run-corrupt";
          }
        }
      } catch (error) {
        if (!isTerminalCanonicalMismatch(error)) throw error;
        reason = "stale-cutoff";
      }
      if (reason === null) return { run: existing };
      await this.#deps.checkpoint.sealRunAndClearInProgressCAS(existing, reason);
      root = await this.#deps.checkpoint.loadAndValidateRoot();
      if (root.inProgressRunId !== null) throw new Error("in-progress-run-not-cleared");
    }

    const cutoff = await this.#deps.canonical.freezeView(signal);
    let predecessor = await this.#deps.checkpoint.loadSourcePlanPredecessor(root.readyGenerationId);
    if (predecessor !== null) {
      try {
        validatePersistedExecutionCoverage(predecessor.sourceExecutionSet, predecessor.sourceCoverage);
        await this.#deps.canonical.assertStillCanonical(predecessor.sourceCoverage.cutoff);
        if (
          predecessor.sourceCoverage.cutoff.chainId !== cutoff.chainId
          || decimal(predecessor.sourceCoverage.cutoff.number) >= decimal(cutoff.number)
        ) predecessor = null;
      } catch (error) {
        if (!isTerminalCanonicalMismatch(error)) throw error;
        predecessor = null;
      }
    }
    const durableDiscovery = await this.#deps.discovery.executeAllDeclaredPlans(catalog, cutoff, predecessor, signal);
    const sourceDiscovery = decodeSourcePlanDiscoveryResult(durableDiscovery.discovery);
    const sourceExecutionSet = decodePersistedSourcePlanExecutionSet(durableDiscovery.sourceExecutionSet);
    const coverage = sealSourceCoverage(cutoff, catalog.declaredSourcePlans, sourceDiscovery.executions);
    validatePersistedExecutionCoverage(sourceExecutionSet, coverage);
    const recentScan = decodeRecentObservationScan(
      await this.#deps.discovery.scanRecentBlocks(cutoff, signal),
    );
    const recent = sealRecentObservation(
      cutoff,
      this.#deps.canonical.recentObservationRange(cutoff),
      recentScan.blocks,
      recentScan.rawEvidenceLocators,
    );
    const nominationResultCapability = await this.#deps.discovery.nominateAll(
      catalog,
      cutoff,
      sourceDiscovery.executions,
      sourceDiscovery.evidence,
      sourceDiscovery.rawEvidenceLocators,
      recent,
      recentScan.rawEvidenceLocators,
      sourceExecutionSet,
      coverage,
      signal,
    );
    const nominationResult = this.#deps.discovery.readIssuedNomination(nominationResultCapability);
    const candidates = nominationResult.candidates;
    const nominationClosure = decodeNominationClosureV1(nominationResult.nominationClosure);
    const run = await this.#deps.checkpoint.beginNewRunAndPersistPartition({
      expectedRootRevision: root.revision,
      parentGenerationId: root.readyGenerationId,
      cutoff,
      recentObservation: recent,
      sourcePlanEvidence: sourceDiscovery.evidence,
      definitionCatalogRoot: catalog.definitionCatalogRoot,
      sourceCoverage: coverage,
      sourceExecutionSet,
      nominationClosure,
      candidates,
      recentRawEvidenceLocators: recentScan.rawEvidenceLocators,
      sourcePlanRawEvidenceLocators: sourceDiscovery.rawEvidenceLocators,
    });
      return { run };
  }
}
