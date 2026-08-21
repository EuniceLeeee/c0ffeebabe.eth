import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { sealInstanceCatalog } from "../../catalog/src/index.ts";
import { recentObservationRange, type CanonicalCutoffV1 } from "../../discovery/src/index.ts";
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

function fixture(existing: InProgressBuilderRunV1 | null = null) {
  const events: string[] = [];
  let storedRun = existing;
  let root = { revision: "1", inProgressRunId: existing?.runId ?? null, readyGenerationId: null };
  let age = "1";
  const instanceCatalog = sealInstanceCatalog(cutoff, []);
  const deps: GenerationBuilderDependencies = {
    policy,
    catalog: { loadExact: () => ({
      definitionCatalogRoot: h("definitions"),
      declaredSourcePlans: [{
        ownerRef: h("owner"),
        sourcePlanRef: h("plan"),
        familyDefinitionHash: h("definition"),
        completeness: "complete-snapshot",
      }],
    }) },
    checkpoint: {
      async loadAndValidateRoot() { events.push("load-root"); return root; },
      async loadRun() { events.push("load-run"); if (!storedRun) throw new Error("missing"); return storedRun; },
      async beginNewRunAndPersistPartition(input) {
        events.push("begin-run");
        const run = {
          runId: "run-new",
          parentGenerationId: input.parentGenerationId,
          checkpointRevision: "2",
          cutoff: input.cutoff,
          recentObservation: input.recentObservation,
          definitionCatalogRoot: input.definitionCatalogRoot,
          sourceCoverageRoot: input.sourceCoverageRoot,
          candidatePartitionRoot: input.candidatePartitionRoot,
          candidates: input.candidates,
        };
        storedRun = run;
        root = { revision: "2", inProgressRunId: run.runId, readyGenerationId: null };
        return run;
      },
      async sealRunAndClearInProgressCAS() { events.push("seal-stale"); root = { ...root, inProgressRunId: null }; },
      async sealCompletedRunAsMemoSeedAndClearCAS() { events.push("seal-seed"); root = { ...root, inProgressRunId: null }; age = "1"; },
    },
    canonical: {
      async freezeView() { events.push("freeze"); return cutoff; },
      async assertStillCanonical() { events.push("canonical"); },
      async ageInBlocks() { return age; },
    },
    discovery: {
      async executeAllDeclaredPlans() {
        events.push("source-plans");
        return [{
          plan: { ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: h("definition"), completeness: "complete-snapshot" as const },
          cutoff,
          outcome: "complete" as const,
          from: "49",
          through: "49",
          previousAppliedThrough: null,
          resultPartitionRoot: h("source-partition"),
        }];
      },
      async scanRecentBlocks() { events.push("recent-50"); return blocks(); },
      async nominateAll() { events.push("nominate"); return []; },
    },
    attestation: {
      async attestAndPersistDifference(run) {
        events.push("attest");
        return {
          sealedRun: {
            runId: run.runId,
            parentGenerationId: run.parentGenerationId,
            cutoff: run.cutoff,
            recentObservationRange: recentObservationRange(run.cutoff.number),
            definitionCatalogRoot: run.definitionCatalogRoot,
            sourceCoverage: {
              cutoff: run.cutoff,
              entries: [],
              sourceCoverageRoot: run.sourceCoverageRoot,
            },
            candidatePartitionRoot: run.candidatePartitionRoot,
            candidateKeys: [],
            verifiedMemoSetRoot: h("memos"),
            checkpointRevision: run.checkpointRevision,
            partition: {
              runId: run.runId,
              cutoff: run.cutoff,
              outcomes: [],
              accounting: { pending: "0", verified: "0", chainProvenRejected: "0", retryable: "0", invalidProgram: "0" },
              exactOutcomePartitionRoot: h("outcomes"),
            },
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
          return {
            generationId: "generation-a",
            parentGenerationId: input.parentGenerationId,
            generationRefreshPolicyHash: h("policy"),
            cutoff: input.run.cutoff,
            recentObservationRange: input.run.recentObservationRange,
            definitionCatalogRoot: input.run.definitionCatalogRoot,
            sourceCoverageRoot: input.run.sourceCoverage.sourceCoverageRoot,
            candidatePartitionRoot: input.run.candidatePartitionRoot,
            verifiedMemoSetRoot: input.run.verifiedMemoSetRoot,
            instanceCatalogRoot: input.instanceCatalog.instanceCatalogRoot,
            graphRoot: h("graph"), edgeCount: "0", instanceCount: "0",
            promotionRevision: "3", promotedAtMonotonicNs: "1", readyRecordHash: h("ready"),
          };
        },
      };
    },
  };
  return {
    deps,
    events,
    getRun: () => storedRun,
    setAge: (value: string) => { age = value; },
  };
}

test("new run order is source coverage then exact 50 blocks then nomination, attestation and promotion", async () => {
  const { deps, events } = fixture();
  const builder = new GenerationBuilderV1(deps);
  await builder.buildNextReady(new AbortController().signal);
  assert.deepEqual(events.filter(value => !["load-root", "canonical"].includes(value)), [
    "freeze", "source-plans", "recent-50", "nominate", "begin-run", "attest", "promote",
  ]);
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
