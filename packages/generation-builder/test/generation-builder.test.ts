import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { sealInstanceCatalog } from "../../catalog/src/index.ts";
import { CanonicalSourceError } from "../../canonical-source/src/index.ts";
import { CASConflictError } from "../../durable-store/src/index.ts";
import { mergeAndDedupeNominations, recentObservationRange, type CandidateRecordV1, type CanonicalCutoffV1 } from "../../discovery/src/index.ts";
import { readyBindingPortForReleaseApproval, releaseApproval } from "../../attestation/test/authority-fixture.ts";
import { issueCandidatePartitionCapabilityFixture } from "../../checkpoint/test/candidate-partition-authority-fixture.ts";
import type { CandidatePartitionCapabilityV1, CandidatePartitionBindingV1 } from "../../../specs/candidate-partition-authority/src/index.ts";
import {
  createReadyPromotionAuthority,
  generationRefreshPolicyHash,
  type ReadyPromotionInputV1,
  type ReadyGenerationV1,
  type ReadyStageIdentityV1,
  type SealedRunBindingV1,
  type SealedRunCapabilityV1,
} from "../../ready-generation/src/index.ts";
import { GenerationBuilderV1, type GenerationBuilderDependencies, type InProgressBuilderRunV1 } from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/builder", value);
const cutoff: CanonicalCutoffV1 = { chainId: "1", number: "49", hash: h("block"), stateRoot: h("state") };
const policy = {
  observationWindowBlocks: "50" as const,
  targetRefreshAgeBlocks: "20",
  maxServingAgeBlocks: "50",
  minPromotionMarginBlocks: "2",
  maxInProgressRuns: "1" as const,
};

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

function candidate(): CandidateRecordV1 {
  return mergeAndDedupeNominations([{
    familyId: "family-a",
    familyDefinitionHash: h("family-definition"),
    instanceNominationKey: "instance-a",
    candidateSnapshotHash: h("candidate-snapshot"),
    evidence: {
      blockNumber: cutoff.number,
      blockHash: cutoff.hash,
      txHash: h("candidate-tx"),
      logIndex: "0",
      address: `0x${"1".repeat(40)}`,
      topic: h("candidate-topic"),
      rawLocatorHash: h("candidate-raw-locator"),
    },
  }])[0]!;
}

function fixture(existing: InProgressBuilderRunV1 | null = null) {
  const events: string[] = [];
  let storedRun = existing;
  let root = { revision: "1", inProgressRunId: existing?.runId ?? null, stagedReadyStorageHash: null as Hash | null, readyGenerationId: null, readyGenerationRecordHash: null as Hash | null };
  let age = "1";
  let canonicalError: unknown = null;
  const instanceCatalog = sealInstanceCatalog(cutoff, []);
  const candidateValue = candidate();
  const approval = releaseApproval(h("framework"), h("executor"), "epoch-1", h("executor-session"));
  const releaseBinding = approval.resolver.resolve(approval.capability).provenance.runtimeBinding;
  const partitionFixture = issueCandidatePartitionCapabilityFixture({
    binding: releaseBinding,
    candidates: [candidateValue],
    cutoff,
    runId: existing?.runId ?? "run-new",
    checkpointRevision: existing?.checkpointRevision ?? "2",
  });
  const candidatePartition: CandidatePartitionCapabilityV1 = existing?.candidatePartition ?? partitionFixture.capability;
  const candidatePartitionBinding: CandidatePartitionBindingV1 = existing?.candidatePartitionBinding ?? partitionFixture.binding;
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
    candidatePartitionProofStorageHash: h("candidate-proof-storage"),
    exactOutcomePartitionRoot: h("outcomes"),
    verifiedMemoSetRoot: h("memos"),
    checkpointRevision: existing?.checkpointRevision ?? "2",
    attestationAuthorityRoot: h("attestation-authority"),
    releaseAuthorityRoot: h("release-authority"),
    releaseProvenanceHash: h("release-provenance"),
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
      async loadStagedPromotion() { events.push("load-stage"); return null; },
      async beginNewRunAndPersistPartition(input) {
        events.push("begin-run");
        const run = {
          runId: "run-new",
          parentGenerationId: input.parentGenerationId,
          checkpointRevision: "2",
          cutoff: input.cutoff,
          recentObservation: input.recentObservation,
          definitionCatalogRoot: input.definitionCatalogRoot,
          sourceCoverage: input.sourceCoverage,
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
        return [{
          plan: { ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: h("definition"), completeness: "complete-snapshot" as const, historyStartBlock: null },
          cutoff,
          outcome: "complete" as const,
          from: "49",
          through: "49",
          previousAppliedThrough: null,
          resultPartitionRoot: h("source-partition"),
        }];
      },
      async scanRecentBlocks() {
        events.push("recent-50");
        return { blocks: blocks(), rawEvidenceLocators: [] };
      },
      async nominateAll() { events.push("nominate"); return []; },
    },
    attestation: {
      async attestAndPersistDifference(run) {
        events.push("attest");
        return {
          sealedRun,
          sealedRunBinding: { ...sealedRunBinding, runId: run.runId, parentGenerationId: run.parentGenerationId, checkpointRevision: run.checkpointRevision, sourceCoverageRoot: run.sourceCoverage.sourceCoverageRoot },
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
            observedHead: sealedRunBinding.cutoff,
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
            candidatePartitionProofStorageHash: sealedRunBinding.candidatePartitionProofStorageHash,
            exactOutcomePartitionRoot: sealedRunBinding.exactOutcomePartitionRoot,
            releaseProvenanceHash: sealedRunBinding.releaseProvenanceHash,
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
    setAge: (value: string) => { age = value; },
    setCanonicalError: (value: unknown) => { canonicalError = value; },
    sealedRunBinding,
  };
}

function issuedDefinitionChangedError(): unknown {
  const authority = createReadyPromotionAuthority(() => ({
    definitionCatalogRoot: h("current-definitions"),
    policy,
  }), readyBindingPortForReleaseApproval(releaseApproval(h("framework"), h("executor"))));
  try {
    authority.issue({
      expectedRevision: "1",
      expectedInProgressRunId: "run",
      cutoff,
      definitionCatalogRoot: h("old-definitions"),
      instanceCatalogRoot: h("instances"),
      graphRoot: h("graph"),
      releaseProvenanceHash: h("release-provenance"),
      candidatePartitionProofStorageHash: h("candidate-proof-storage"),
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
    releaseProvenanceHash: staged.sealedRunBinding.releaseProvenanceHash,
    candidatePartitionProofStorageHash: staged.sealedRunBinding.candidatePartitionProofStorageHash,
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
          releaseProvenanceHash: binding.releaseProvenanceHash,
          candidatePartitionProofStorageHash: binding.candidatePartitionProofStorageHash,
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
  const { deps, events } = fixture();
  const builder = new GenerationBuilderV1(deps);
  await builder.buildNextReady(new AbortController().signal);
  assert.deepEqual(events.filter(value => !["load-root", "canonical"].includes(value)), [
    "load-stage", "freeze", "source-plans", "recent-50", "nominate", "begin-run", "attest", "promote",
  ]);
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
