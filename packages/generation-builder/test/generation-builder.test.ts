import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, sha256Hex, type Hash } from "../../canonical-codec/src/index.ts";
import { sealInstanceCatalog } from "../../catalog/src/index.ts";
import { CanonicalSourceError } from "../../canonical-source/src/index.ts";
import { CASConflictError } from "../../durable-store/src/index.ts";
import {
  candidatePartitionRoot,
  mergeAndDedupeNominations,
  recentObservationRange,
  sealSourceCoverage,
  sourcePlanDiscoveryRoot,
  sourcePlanEvidenceRoot,
  sourcePlanExecutionRoot,
  sourcePlanIdentity,
  sealPersistedSourcePlanExecution,
  sealPersistedSourcePlanExecutionSet,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
  type SourcePlanExecutionV1,
  type SourcePlanEvidenceReceiptV1,
} from "../../discovery/src/index.ts";
import { sealRecentObservation } from "../../observation/src/index.ts";
import {
  nominationEvidenceRefHash,
  sealNominationClosureV1,
  sealQualifiedSourcePlanNominationReceiptV1,
  type NominationClosureV1,
} from "../../../specs/nomination-authority/src/index.ts";
import { CandidatePartitionCapabilityRegistryV1 } from "../../checkpoint/src/candidate-partition.ts";
import {
  candidatePartitionKeysRoot,
  createCandidatePartitionCommitmentV1,
  type CandidatePartitionCapabilityV1,
  type CandidatePartitionCommitmentV1,
} from "../../../specs/candidate-partition-authority/src/index.ts";
import {
  createReadyPromotionAuthority,
  generationRefreshPolicyHash,
  type ReadyPromotionInputV1,
  type ReadyGenerationV1,
  type ReadyStageIdentityV1,
  type SealedRunBindingV1,
  type SealedRunCapabilityV1,
} from "../../ready-generation/src/index.ts";
import { GenerationBuilderV1, type BeginRunInputV1, type GenerationBuilderDependencies, type InProgressBuilderRunV1 } from "../src/index.ts";
import {
  createRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../runtime-authority/src/index.ts";

const h = (value: string): Hash => hashDomain("test/builder", value);
const cutoff: CanonicalCutoffV1 = { chainId: "1", number: "49", hash: h("block"), stateRoot: h("state") };
const policy = {
  observationWindowBlocks: "50" as const,
  targetRefreshAgeBlocks: "20",
  maxServingAgeBlocks: "50",
  minPromotionMarginBlocks: "2",
  maxInProgressRuns: "1" as const,
};
const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(
  createRuntimeAuthorityDescriptorV1({
    runtimeBindingId: h("runtime-binding"),
    implementationCommit: "a".repeat(40),
  }),
);

function blocks() {
  const values = [];
  let parent = h("parent");
  for (let number = 0; number < 50; number += 1) {
    const hash = number === 49 ? cutoff.hash : h(`block:${number}`);
    values.push({ number: String(number), hash, parentHash: parent, evidence: [] });
    parent = hash;
  }
  return values;
}

function sourceExecution(): SourcePlanExecutionV1 {
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("plan"),
    familyDefinitionHash: h("definition"),
    completeness: "complete-snapshot" as const,
    historyStartBlock: null,
  };
  const rawLocatorHash = sha256Hex(new TextEncoder().encode("builder-source-raw"));
  const sourceEvidenceRefs = [{
    kind: "source-plan" as const,
    version: 1 as const,
    ownerRef: plan.ownerRef,
    sourcePlanRef: plan.sourcePlanRef,
    evidenceRef: h("source-evidence"),
    rawLocatorHash,
  }];
  const sourceEvidenceRoot = sourcePlanEvidenceRoot({ plan, cutoff, refs: sourceEvidenceRefs, rawLocatorHashes: [rawLocatorHash] });
  const base = {
    kind: "source-plan-execution" as const,
    version: 1 as const,
    plan,
    cutoff,
    outcome: "complete" as const,
    from: "49",
    through: "49",
    previousAppliedThrough: null,
    resultPartitionRoot: h("source-partition"),
    opaqueResult: { kind: "builder-source-result", marker: "ok" },
    sourceEvidenceRefs,
    rawLocatorHashes: [rawLocatorHash],
    sourceEvidenceRoot,
  };
  return { ...base, executionRoot: sourcePlanExecutionRoot(base) };
}

function sourceEvidence(value: SourcePlanExecutionV1): SourcePlanEvidenceReceiptV1 {
  return {
    kind: "source-plan-evidence",
    version: 1,
    plan: value.plan,
    cutoff: value.cutoff,
    refs: value.sourceEvidenceRefs,
    rawLocatorHashes: value.rawLocatorHashes,
    evidenceRoot: value.sourceEvidenceRoot,
  };
}

function sourceExecutionSet(value: SourcePlanExecutionV1) {
  return sealPersistedSourcePlanExecutionSet(value.cutoff, [sealPersistedSourcePlanExecution({
    execution: value,
    sourcePlanLeafDigest: h("plan-leaf"),
    sourcePlanSchemaHash: h("plan-schema"),
    sourcePlanClosureRoot: h("plan-closure"),
    sourceAuthorityRoot: h("source-authority"),
    runtimeAuthority,
    sourceAnchorRoot: h("source-anchor"),
    previousExecutionRoot: null,
  })]);
}

function candidate(execution: SourcePlanExecutionV1): CandidateRecordV1 {
  return mergeAndDedupeNominations([{
    kind: "aloha.candidate-nomination",
    version: "2",
    familyId: "family-a",
    familyDefinitionHash: execution.plan.familyDefinitionHash,
    instanceNominationKey: "instance-a",
    evidence: execution.sourceEvidenceRefs[0]!,
  }])[0]!;
}

function issueCandidatePartitionFixture(
  registry: CandidatePartitionCapabilityRegistryV1,
  candidates: readonly CandidateRecordV1[],
  runId: string,
  checkpointRevision: string,
) {
  const binding = createCandidatePartitionCommitmentV1({
    kind: "aloha.candidate-partition-commitment",
    version: "1",
    runtimeAuthority,
    runId,
    cutoff,
    candidatePartitionRoot: candidatePartitionRoot(candidates),
    candidatePartitionStorageHash: h(`candidate-storage:${runId}:${checkpointRevision}`),
    nominationClosureRoot: h(`candidate-nomination:${runId}:${checkpointRevision}`),
    nominationClosureStorageHash: h(`candidate-nomination-storage:${runId}:${checkpointRevision}`),
    recordCount: String(candidates.length),
    candidateKeysRoot: candidatePartitionKeysRoot(candidates.map(value => value.familyCandidateKey)),
    recentObservationRoot: h(`candidate-observation:${runId}:${checkpointRevision}`),
    sourceCoverageRoot: h(`candidate-coverage:${runId}:${checkpointRevision}`),
    checkpointRevision,
  });
  const capability = registry.registerVerifiedCommitment(binding, candidates, Object.freeze({
    read(): Uint8Array { throw new TypeError("test candidate raw evidence is unavailable"); },
  }));
  return Object.freeze({ capability, binding });
}

function nominationClosure(
  execution: SourcePlanExecutionV1,
  executionSet: ReturnType<typeof sourceExecutionSet>,
  recentObservationRoot: Hash,
  sourceCoverageRoot: Hash,
  candidates: readonly CandidateRecordV1[],
): NominationClosureV1 {
  const identity = sourcePlanIdentity(execution.plan);
  const receipt = sealQualifiedSourcePlanNominationReceiptV1({
    cutoff,
    familyId: candidates[0]!.familyId,
    familyDefinitionHash: execution.plan.familyDefinitionHash,
    sourcePlanIdentity: identity,
    sourcePlanLeafDigest: executionSet.executions[0]!.sourcePlanLeafDigest,
    nominationProgramRoot: h("nomination-program"),
    nominationProgramProposalLeafDigest: h("nomination-program-proposal"),
    qualificationRoot: h("nomination-qualification"),
    denominator: {
      kind: "complete-source-result",
      persistedExecutionRoot: executionSet.executions[0]!.persistedExecutionRoot,
      resultPartitionRoot: execution.resultPartitionRoot,
    },
    claims: candidates.map(value => ({
      sourcePlanIdentity: identity,
      familyCandidateKey: value.familyCandidateKey,
      instanceNominationKey: value.instanceNominationKey,
      evidenceRefHash: nominationEvidenceRefHash(value.evidence[0]!),
    })),
  });
  return sealNominationClosureV1({
    cutoff,
    recentObservationRoot,
    sourceExecutionSetRoot: executionSet.executionSetRoot,
    sourceCoverageRoot,
    sourcePlanIdentities: [identity],
    receipts: [receipt],
    candidates,
    candidatePartitionRoot: candidatePartitionRoot(candidates),
  });
}

function fixture(existing: InProgressBuilderRunV1 | null = null) {
  const events: string[] = [];
  let storedRun = existing;
  let root = { revision: "1", inProgressRunId: existing?.runId ?? null, stagedReadyStorageHash: null as Hash | null, readyGenerationId: null, readyGenerationRecordHash: null as Hash | null };
  let age = "1";
  let canonicalError: unknown = null;
  let capturedBeginInput: BeginRunInputV1 | null = null;
  let capturedNomination: { sourceExecutions: readonly SourcePlanExecutionV1[]; sourceEvidenceCount: number; sourceRawCount: number; recentRawCount: number } | null = null;
  const execution = sourceExecution();
  const executionSet = sourceExecutionSet(execution);
  const coverage = sealSourceCoverage(cutoff, [execution.plan], [execution]);
  const recent = sealRecentObservation(cutoff, recentObservationRange(cutoff.number), blocks(), []);
  const instanceCatalog = sealInstanceCatalog(cutoff, []);
  const candidateValue = candidate(execution);
  const candidates = [candidateValue];
  const nominationClosureValue = nominationClosure(
    execution,
    executionSet,
    recent.observationRoot,
    coverage.sourceCoverageRoot,
    candidates,
  );
  const nominationClosureStorageHash = h("nomination-closure-storage");
  const nominationCapabilities = new WeakMap<object, {
    readonly candidates: readonly CandidateRecordV1[];
    readonly nominationClosure: NominationClosureV1;
  }>();
  const partitionFixture = issueCandidatePartitionFixture(
    new CandidatePartitionCapabilityRegistryV1(),
    [candidateValue],
    existing?.runId ?? "run-new",
    existing?.checkpointRevision ?? "2",
  );
  const candidatePartition: CandidatePartitionCapabilityV1 = existing?.candidatePartition ?? partitionFixture.capability;
  const candidatePartitionBinding: CandidatePartitionCommitmentV1 = existing?.candidatePartitionBinding ?? partitionFixture.binding;
  const sealedRun = Object.freeze({}) as SealedRunCapabilityV1;
  const sealedRunBinding: SealedRunBindingV1 = {
    runId: existing?.runId ?? "run-new",
    parentGenerationId: existing?.parentGenerationId ?? null,
    cutoff,
    recentObservationRange: recentObservationRange(cutoff.number),
    definitionCatalogRoot: h("definitions"),
    sourceCoverageRoot: h("coverage"),
    candidatePartitionRoot: candidatePartitionBinding.candidatePartitionRoot,
    candidatePartitionStorageHash: candidatePartitionBinding.candidatePartitionStorageHash,
    nominationClosureRoot: nominationClosureValue.root,
    nominationClosureStorageHash,
    candidatePartitionCommitmentStorageHash: h("candidate-commitment-storage"),
    exactOutcomePartitionRoot: h("outcomes"),
    verifiedMemoSetRoot: h("memos"),
    checkpointRevision: existing?.checkpointRevision ?? "2",
    runtimeAuthority,
    attestationAuthorityRoot: h("attestation-authority"),
    frameworkAuthorityRoot: h("framework-authority"),
    executorAuthorityRoot: h("executor-authority"),
  };
  const deps: GenerationBuilderDependencies = {
    policy,
    catalog: { loadExact: () => ({
      definitionCatalogRoot: h("definitions"),
      declaredSourcePlans: [{
        ownerRef: h("owner"),
        sourcePlanRef: h("plan"),
        familyDefinitionHash: h("definition"),
        completeness: "complete-snapshot",
        historyStartBlock: null,
      }],
    }) },
    checkpoint: {
      async loadAndValidateRoot() { events.push("load-root"); return root; },
      async loadRun() { events.push("load-run"); if (!storedRun) throw new Error("missing"); return storedRun; },
      async loadSourcePlanPredecessor() { return null; },
      async loadStagedPromotion() { events.push("load-stage"); return null; },
      async beginNewRunAndPersistPartition(input) {
        events.push("begin-run");
        capturedBeginInput = input;
        const run = {
          runId: "run-new",
          parentGenerationId: input.parentGenerationId,
          checkpointRevision: "2",
          cutoff: input.cutoff,
          recentObservation: input.recentObservation,
          sourcePlanEvidence: input.sourcePlanEvidence,
          definitionCatalogRoot: input.definitionCatalogRoot,
          sourceCoverage: input.sourceCoverage,
          sourceExecutionSet: input.sourceExecutionSet,
          nominationClosure: input.nominationClosure,
          candidatePartition,
          candidatePartitionBinding,
        };
        storedRun = run;
        root = { revision: "2", inProgressRunId: run.runId, stagedReadyStorageHash: null, readyGenerationId: null, readyGenerationRecordHash: null };
        return run;
      },
      async sealRunAndClearInProgressCAS() { events.push("seal-stale"); root = { ...root, inProgressRunId: null }; },
      async resolveStagedPromotion(stage: ReadyStageIdentityV1) { return { kind: "staged" as const, stage }; },
      async abandonStagedPromotionCAS(stage) { events.push("abandon-stage"); root = { ...root, inProgressRunId: null, stagedReadyStorageHash: null }; return { kind: "abandoned" as const, stage }; },
      async sealCompletedRunAsMemoSeedAndClearCAS() { events.push("seal-seed"); root = { ...root, inProgressRunId: null }; age = "1"; },
    },
    canonical: {
      async freezeView() { events.push("freeze"); return cutoff; },
      async assertStillCanonical() {
        events.push("canonical");
        if (canonicalError !== null) throw canonicalError;
      },
      async ageInBlocks() { return age; },
      recentObservationRange(value) { return recentObservationRange(value.number); },
    },
    discovery: {
      async executeAllDeclaredPlans() {
        events.push("source-plans");
        const rawBytes = new TextEncoder().encode("builder-source-raw");
        const evidence = sourceEvidence(execution);
        const discovery = {
          kind: "source-plan-discovery" as const,
          version: 1 as const,
          executions: [execution],
          evidence: [evidence],
          rawEvidenceLocators: [{ kind: "raw-evidence-locator" as const, version: 1 as const, rawLocatorHash: execution.rawLocatorHashes[0]!, bytes: rawBytes }],
          discoveryRoot: sourcePlanDiscoveryRoot({
            executions: [execution],
            evidence: [evidence],
            rawEvidenceLocators: [{ kind: "raw-evidence-locator" as const, version: 1 as const, rawLocatorHash: execution.rawLocatorHashes[0]!, bytes: rawBytes }],
          }),
        };
        return { discovery, sourceExecutionSet: executionSet };
      },
      async scanRecentBlocks() {
        events.push("recent-50");
        return { kind: "recent-observation-scan" as const, version: 1 as const, blocks: blocks(), rawEvidenceLocators: [] };
      },
      async nominateAll(_catalog, _cutoff, sourceExecutions, sourceEvidence, sourceRawEvidenceLocators, _recent, recentRawEvidenceLocators, issuedExecutionSet, issuedCoverage) {
        events.push("nominate");
        capturedNomination = {
          sourceExecutions,
          sourceEvidenceCount: sourceEvidence.length,
          sourceRawCount: sourceRawEvidenceLocators.length,
          recentRawCount: recentRawEvidenceLocators.length,
        };
        assert.equal(issuedExecutionSet.executionSetRoot, executionSet.executionSetRoot);
        assert.equal(issuedCoverage.sourceCoverageRoot, coverage.sourceCoverageRoot);
        const capability = Object.freeze(Object.create(null));
        nominationCapabilities.set(capability, Object.freeze({ candidates, nominationClosure: nominationClosureValue }));
        return capability;
      },
      readIssuedNomination(capability) {
        events.push("read-nomination");
        const result = nominationCapabilities.get(capability);
        if (result === undefined) throw new TypeError("nomination capability was not issued by this discovery owner");
        return result;
      },
    },
    attestation: {
      async attestAndPersistDifference(run) {
        events.push("attest");
        return {
          sealedRun,
          sealedRunBinding: {
            ...sealedRunBinding,
            runId: run.runId,
            parentGenerationId: run.parentGenerationId,
            checkpointRevision: run.checkpointRevision,
            sourceCoverageRoot: run.sourceCoverage.sourceCoverageRoot,
            nominationClosureRoot: run.nominationClosure.root,
          },
          instanceCatalog,
        };
      },
    },
    bindPromotion(token) {
      assert.equal(typeof token, "object");
      return {
        async findLatestReusable() { return null; },
        async promote(input) {
          events.push("promote");
          const generationRefreshPolicyHashValue = generationRefreshPolicyHash(input.policy);
          const freshnessPayload = {
            cutoff: sealedRunBinding.cutoff,
            observedHead: { ...sealedRunBinding.cutoff, parentHash: h("promotion-parent") },
            observedAgeBlocks: "0",
            maxPromotionAgeBlocks: "48",
            generationRefreshPolicyHash: generationRefreshPolicyHashValue,
            journalEpoch: "1",
            canonicalJournalRoot: h("journal"),
          };
          const promotionFreshness = {
            ...freshnessPayload,
            freshnessReceiptHash: hashDomain("aloha/promotion-freshness-receipt/v1", freshnessPayload),
          };
          const readyPayload = {
            generationId: "generation-a",
            parentGenerationId: input.parentGenerationId,
            generationRefreshPolicyHash: generationRefreshPolicyHashValue,
            cutoff: sealedRunBinding.cutoff,
            recentObservationRange: sealedRunBinding.recentObservationRange,
            definitionCatalogRoot: sealedRunBinding.definitionCatalogRoot,
            sourceCoverageRoot: sealedRunBinding.sourceCoverageRoot,
            candidatePartitionRoot: sealedRunBinding.candidatePartitionRoot,
            nominationClosureRoot: sealedRunBinding.nominationClosureRoot,
            nominationClosureStorageHash: sealedRunBinding.nominationClosureStorageHash,
            candidatePartitionCommitmentStorageHash: sealedRunBinding.candidatePartitionCommitmentStorageHash,
            exactOutcomePartitionRoot: sealedRunBinding.exactOutcomePartitionRoot,
            runtimeAuthority,
            verifiedMemoSetRoot: sealedRunBinding.verifiedMemoSetRoot,
            instanceCatalogRoot: input.instanceCatalog.instanceCatalogRoot,
            graphRoot: h("graph"), edgeCount: "0", instanceCount: "0",
            promotionFreshness,
            promotionRevision: "3", promotedAtMonotonicNs: "1",
          };
          return { ...readyPayload, readyRecordHash: hashDomain("aloha/ready-generation/v1", readyPayload) };
        },
      };
    },
  };
  return {
    deps,
    events,
    getRun: () => storedRun,
    getBeginInput: () => capturedBeginInput,
    getNomination: () => capturedNomination,
    setAge: (value: string) => { age = value; },
    setCanonicalError: (value: unknown) => { canonicalError = value; },
    sealedRunBinding,
  };
}

function issuedDefinitionChangedError(): unknown {
  const currentRuntimeAuthority = projectRuntimeAuthorityDescriptorV1(
    createRuntimeAuthorityDescriptorV1({
      runtimeBindingId: h("definition-change-runtime"),
      implementationCommit: "a".repeat(40),
    }),
  );
  const authorityPort = Object.freeze({
    readCurrent: () => Object.freeze({ runtimeAuthority: currentRuntimeAuthority }),
  });
  const authority = createReadyPromotionAuthority(() => ({
    definitionCatalogRoot: h("current-definitions"),
    policy,
  }), authorityPort);
  try {
    authority.issue({
      expectedRevision: "1",
      expectedInProgressRunId: "run",
      cutoff,
      definitionCatalogRoot: h("old-definitions"),
      instanceCatalogRoot: h("instances"),
      graphRoot: h("graph"),
      runtimeAuthority: currentRuntimeAuthority,
      candidatePartitionCommitmentStorageHash: h("candidate-commitment-storage"),
      nominationClosureRoot: h("nomination-closure"),
      nominationClosureStorageHash: h("nomination-closure-storage"),
      policy,
    });
  } catch (error) {
    return error;
  }
  throw new Error("definition-change fixture did not fail");
}

interface StagedFixtureOptions {
  readonly resolveSequence?: readonly ("staged" | "absent" | "committed")[];
  readonly abandonError?: unknown;
  readonly exposeCommittedReady?: boolean;
}

async function stagedFixture(firstPromotionError: unknown, options: StagedFixtureOptions = {}) {
  const seeded = fixture();
  await new GenerationBuilderV1(seeded.deps).buildNextReady(new AbortController().signal);
  const run = seeded.getRun();
  assert.notEqual(run, null);
  const staged = await seeded.deps.attestation.attestAndPersistDifference(run!, new AbortController().signal);
  const resumed = fixture(run);
  const checkpoint = resumed.deps.checkpoint;
  const bindPromotion = resumed.deps.bindPromotion;
  const stage: ReadyStageIdentityV1 = {
    stageStorageHash: h("staged-storage"),
    runId: run!.runId,
    expectedRevision: run!.checkpointRevision,
    sealedRevision: run!.checkpointRevision,
    stageRevision: String(Number(run!.checkpointRevision) + 1),
    stageRecordHash: h("staged-record"),
    readyBaseHash: h("staged-ready-base"),
    cutoff: run!.cutoff,
    generationRefreshPolicyHash: generationRefreshPolicyHash(policy),
    definitionCatalogRoot: run!.definitionCatalogRoot,
    runtimeAuthority,
    candidatePartitionCommitmentStorageHash: staged.sealedRunBinding.candidatePartitionCommitmentStorageHash,
    nominationClosureRoot: staged.sealedRunBinding.nominationClosureRoot,
    nominationClosureStorageHash: staged.sealedRunBinding.nominationClosureStorageHash,
  };
  let stageAvailable = true;
  let promotionCalls = 0;
  let testPromotionCalls = 0;
  let committedReady: ReadyGenerationV1 | null = null;
  const resolveSequence = [...(options.resolveSequence ?? [])];
  const deps: GenerationBuilderDependencies = {
    ...resumed.deps,
    checkpoint: {
      ...checkpoint,
      async loadStagedPromotion() {
        resumed.events.push("load-stage");
        return stageAvailable ? { ...staged, stage } : null;
      },
      async resolveStagedPromotion(value) {
        const resolution = resolveSequence.shift() ?? (stageAvailable ? "staged" : "absent");
        if (resolution === "committed") {
          stageAvailable = false;
          return { kind: "committed" as const, stage: value, ready: committedReady! };
        }
        return resolution === "staged"
          ? { kind: "staged" as const, stage: value }
          : { kind: "absent" as const, stage: value, activeReady: null };
      },
      async abandonStagedPromotionCAS(value) {
        resumed.events.push("abandon-stage");
        if (options.abandonError !== undefined) throw options.abandonError;
        stageAvailable = false;
        return { kind: "abandoned" as const, stage: value };
      },
    },
    bindPromotion(token) {
      const bound = bindPromotion(token);
      const originalFindLatestReusable = bound.findLatestReusable;
      return {
        ...bound,
        async findLatestReusable(...args: Parameters<typeof originalFindLatestReusable>) {
          const reusable = await originalFindLatestReusable(...args);
          return options.exposeCommittedReady ? committedReady : reusable;
        },
        async promote(input: ReadyPromotionInputV1) {
          promotionCalls += 1;
          testPromotionCalls += 1;
          if (testPromotionCalls === 1) throw firstPromotionError;
          return bound.promote(input);
        },
      };
    },
  };
  if (options.exposeCommittedReady || options.resolveSequence?.includes("committed")) {
    const bound = resumed.deps.bindPromotion(Object.freeze({ committedFixture: true }));
    committedReady = await bound.promote({
      sealedRun: staged.sealedRun,
      instanceCatalog: staged.instanceCatalog,
      parentGenerationId: staged.sealedRunBinding.parentGenerationId,
      policy,
    });
    committedReady = {
      ...committedReady,
      cutoff: staged.sealedRunBinding.cutoff,
      definitionCatalogRoot: staged.sealedRunBinding.definitionCatalogRoot,
      sourceCoverageRoot: staged.sealedRunBinding.sourceCoverageRoot,
      candidatePartitionRoot: staged.sealedRunBinding.candidatePartitionRoot,
      exactOutcomePartitionRoot: staged.sealedRunBinding.exactOutcomePartitionRoot,
      verifiedMemoSetRoot: staged.sealedRunBinding.verifiedMemoSetRoot,
    };
    promotionCalls = 0;
    testPromotionCalls = 0;
  }
  return { ...resumed, deps, promotionCalls: () => testPromotionCalls };
}

async function firstPromotionAmbiguousFixture() {
  const base = fixture();
  let captured: ReadyPromotionInputV1 | null = null;
  let committedReady: ReadyGenerationV1 | null = null;
  let stageAvailable = false;
  let promotionCalls = 0;
  const originalCheckpoint = base.deps.checkpoint;
  const originalBindPromotion = base.deps.bindPromotion;
  let capturedBinding: SealedRunBindingV1 | null = null;
  const deps: GenerationBuilderDependencies = {
    ...base.deps,
    checkpoint: {
      ...originalCheckpoint,
      async loadStagedPromotion() {
        base.events.push("load-stage");
        if (!stageAvailable || captured === null) return null;
        const binding = capturedBinding!;
        const stage: ReadyStageIdentityV1 = {
          stageStorageHash: h("ambiguous-stage-storage"),
          runId: binding.runId,
          expectedRevision: binding.checkpointRevision,
          sealedRevision: binding.checkpointRevision,
          stageRevision: String(Number(binding.checkpointRevision) + 1),
          stageRecordHash: h("ambiguous-stage-record"),
          readyBaseHash: h("ambiguous-ready-base"),
          cutoff: binding.cutoff,
          generationRefreshPolicyHash: generationRefreshPolicyHash(policy),
          definitionCatalogRoot: binding.definitionCatalogRoot,
          runtimeAuthority,
          candidatePartitionCommitmentStorageHash: binding.candidatePartitionCommitmentStorageHash,
          nominationClosureRoot: binding.nominationClosureRoot,
          nominationClosureStorageHash: binding.nominationClosureStorageHash,
        };
        return { sealedRun: captured.sealedRun, sealedRunBinding: binding, instanceCatalog: captured.instanceCatalog, stage };
      },
      async resolveStagedPromotion(stage) {
        stageAvailable = false;
        return { kind: "committed" as const, stage, ready: committedReady! };
      },
    },
    bindPromotion(token) {
      const bound = originalBindPromotion(token);
      return {
        ...bound,
        async findLatestReusable() { return committedReady; },
        async promote(input: ReadyPromotionInputV1) {
          promotionCalls += 1;
          if (promotionCalls === 1) {
            captured = input;
            capturedBinding = base.sealedRunBinding;
            committedReady = await bound.promote(input);
            stageAvailable = true;
            throw new CASConflictError("2", "3");
          }
          return bound.promote(input);
        },
      };
    },
  };
  return { ...base, deps, promotionCalls: () => promotionCalls };
}

test("new run order is source coverage then exact 50 blocks then nomination, attestation and promotion", async () => {
  const { deps, events, getBeginInput, getNomination } = fixture();
  const builder = new GenerationBuilderV1(deps);
  await builder.buildNextReady(new AbortController().signal);
  const beginInput = getBeginInput();
  assert.notEqual(beginInput, null);
  assert.deepEqual(events.filter(value => !["load-root", "canonical"].includes(value)), [
    "load-stage", "freeze", "source-plans", "recent-50", "nominate", "read-nomination", "begin-run", "attest", "promote",
  ]);
  assert.equal(beginInput!.sourcePlanEvidence.length, 1);
  assert.equal(beginInput!.recentRawEvidenceLocators.length, 0);
  assert.equal(beginInput!.sourcePlanRawEvidenceLocators.length, 1);
  assert.equal(
    beginInput!.nominationClosure.sourceExecutionSetRoot,
    beginInput!.sourceExecutionSet.executionSetRoot,
  );
  assert.equal(
    beginInput!.nominationClosure.sourceCoverageRoot,
    beginInput!.sourceCoverage.sourceCoverageRoot,
  );
  assert.equal(
    beginInput!.nominationClosure.candidatePartitionRoot,
    candidatePartitionRoot(beginInput!.candidates),
  );
  const denominator = beginInput!.nominationClosure.receipts[0]!.denominator;
  assert.equal(denominator.kind, "complete-source-result");
  assert.equal(
    denominator.persistedExecutionRoot,
    beginInput!.sourceExecutionSet.executions[0]!.persistedExecutionRoot,
  );
  assert.equal(getNomination()?.sourceExecutions.length, 1);
  assert.equal(getNomination()?.sourceEvidenceCount, 1);
  assert.equal(getNomination()?.sourceRawCount, 1);
  assert.equal(getNomination()?.recentRawCount, 0);
});

test("first promotion post-CAS ambiguity reloads the exact committed stage before returning", async () => {
  const value = await firstPromotionAmbiguousFixture();
  const ready = await new GenerationBuilderV1(value.deps).buildNextReady(new AbortController().signal);
  assert.equal(ready.generationId, "generation-a");
  assert.equal(value.promotionCalls(), 1);
  assert.equal(value.events.includes("load-stage"), true);
});

test("compatible in-progress run resumes before any new cutoff is frozen", async () => {
  const first = fixture();
  await new GenerationBuilderV1(first.deps).buildNextReady(new AbortController().signal);
  const existing = first.getRun();
  assert.notEqual(existing, null);

  const resumed = fixture(existing);
  await new GenerationBuilderV1(resumed.deps).buildNextReady(new AbortController().signal);
  assert.equal(resumed.events.includes("load-run"), true);
  assert.equal(resumed.events.includes("freeze"), false);
  assert.equal(resumed.events.includes("source-plans"), false);
  assert.equal(resumed.events.includes("recent-50"), false);
  assert.equal(resumed.events.includes("nominate"), false);
  assert.equal(resumed.events.includes("attest"), true);
  assert.equal(resumed.events.includes("promote"), true);
});

test("cold run older than promotion margin is sealed as memo seed before retry", async () => {
  const value = fixture();
  value.setAge("49");
  const builder = new GenerationBuilderV1(value.deps);
  const ready = await builder.buildNextReady(new AbortController().signal);
  assert.equal(ready.generationId, "generation-a");
  assert.equal(value.events.includes("seal-seed"), true);
  assert.equal(value.events.filter(event => event === "freeze").length, 2);
});

test("retryable canonical transport failure preserves the durable in-progress run", async () => {
  const first = fixture();
  await new GenerationBuilderV1(first.deps).buildNextReady(new AbortController().signal);
  const existing = first.getRun();
  assert.notEqual(existing, null);
  const resumed = fixture(existing);
  resumed.setCanonicalError(Object.assign(new Error("rpc unavailable"), {
    code: "transport",
    retryable: true,
  }));
  await assert.rejects(
    () => new GenerationBuilderV1(resumed.deps).buildNextReady(new AbortController().signal),
    /rpc unavailable/,
  );
  assert.equal(resumed.events.includes("seal-stale"), false);
  assert.equal(resumed.getRun()?.runId, existing!.runId);
});

test("provider chain or block-number mismatch is fatal and preserves the durable run", async () => {
  for (const code of ["chain-id-mismatch", "number-mismatch"] as const) {
    const first = fixture();
    await new GenerationBuilderV1(first.deps).buildNextReady(new AbortController().signal);
    const existing = first.getRun();
    assert.notEqual(existing, null);
    const resumed = fixture(existing);
    resumed.setCanonicalError(new CanonicalSourceError(code, code, false));
    await assert.rejects(
      () => new GenerationBuilderV1(resumed.deps).buildNextReady(new AbortController().signal),
      new RegExp(code),
    );
    assert.equal(resumed.events.includes("seal-stale"), false, code);
    assert.equal(resumed.getRun()?.runId, existing!.runId, code);
  }
});

test("an explicitly typed incompatible stage is abandoned once before a fresh build", async () => {
  const value = await stagedFixture(
    issuedDefinitionChangedError(),
  );
  const ready = await new GenerationBuilderV1(value.deps).buildNextReady(new AbortController().signal);
  assert.equal(ready.generationId, "generation-a");
  assert.equal(value.events.filter(event => event === "abandon-stage").length, 1);
  assert.equal(value.events.filter(event => event === "freeze").length, 0);
  assert.equal(value.promotionCalls(), 2);
});

test("error text cannot impersonate staged incompatibility or trigger rebuild", async () => {
  const value = await stagedFixture(new Error("definition-catalog-changed"));
  await assert.rejects(
    () => new GenerationBuilderV1(value.deps).buildNextReady(new AbortController().signal),
    /definition-catalog-changed/,
  );
  assert.equal(value.events.includes("abandon-stage"), false);
  assert.equal(value.events.includes("freeze"), false);
  assert.equal(value.promotionCalls(), 1);
});

test("a terminal canonical mismatch or stale promotion does not impersonate typed abandon", async () => {
  for (const code of [
    "hash-mismatch",
    "promotion-stale",
    "canonical-view-superseded",
  ]) {
    const value = await stagedFixture(Object.assign(new Error(code), {
      code,
      retryable: false,
    }));
    await assert.rejects(() => new GenerationBuilderV1(value.deps).buildNextReady(new AbortController().signal));
    assert.equal(value.events.filter(event => event === "abandon-stage").length, 0, code);
    assert.equal(value.promotionCalls(), 1, code);
  }
});

test("activation winning the abandon CAS race is accepted only after current reusable reload", async () => {
  const value = await stagedFixture(issuedDefinitionChangedError(), {
    resolveSequence: ["staged", "committed"],
    abandonError: new CASConflictError("3", "4"),
    exposeCommittedReady: true,
  });
  const ready = await new GenerationBuilderV1(value.deps).buildNextReady(new AbortController().signal);
  assert.equal(ready.generationId, "generation-a");
  assert.equal(value.events.filter(event => event === "abandon-stage").length, 1);
  assert.equal(value.promotionCalls(), 1);
});

test("a committed durable outcome is not trusted without a current reusable fact", async () => {
  const value = await stagedFixture(new CASConflictError("3", "4"), {
    resolveSequence: ["committed"],
    exposeCommittedReady: false,
  });
  const ready = await new GenerationBuilderV1(value.deps).buildNextReady(new AbortController().signal);
  assert.equal(ready.generationId, "generation-a");
  assert.equal(value.promotionCalls(), 2);
  assert.equal(value.events.includes("begin-run"), false);
});

test("unknown post-CAS failure is fatal even when the stage disappeared", async () => {
  const value = await stagedFixture(new Error("storage-corruption"), {
    resolveSequence: ["absent"],
  });
  await assert.rejects(
    () => new GenerationBuilderV1(value.deps).buildNextReady(new AbortController().signal),
    /storage-corruption/,
  );
  assert.equal(value.events.includes("abandon-stage"), false);
  assert.equal(value.promotionCalls(), 1);
});

test("chain and block-number mismatches remain fatal rather than staged abandon", async () => {
  for (const code of ["chain-id-mismatch", "number-mismatch"] as const) {
    const value = await stagedFixture(new CanonicalSourceError(code, code, false));
    await assert.rejects(
      () => new GenerationBuilderV1(value.deps).buildNextReady(new AbortController().signal),
      new RegExp(code),
    );
    assert.equal(value.events.includes("abandon-stage"), false, code);
    assert.equal(value.promotionCalls(), 1, code);
  }
});
