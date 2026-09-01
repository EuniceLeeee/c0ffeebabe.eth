import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  DEFAULT_PRODUCTION_PERFORMANCE_PROFILE,
  createCandidateSet,
  createProductionPerformanceProfile,
  createPerformanceWindowCommitment,
  type PerformanceBudgetV1,
  type ProductionPerformanceProfileV1,
  type PerformanceWindowCommitmentV1,
} from "../../../specs/performance/src/index.ts";
import { createPerformanceCoverageReceipt, PerformanceWindowCollectorV1, type PerformanceAppendPortV1 } from "../../../packages/performance-collector/src/index.ts";
import { issuePerformanceHeadTerminalEvidenceForTest } from "../../../packages/performance-collector/test/authority-fixture.ts";
import {
  evaluatePerformancePredicate,
  nearestRankPercentile,
} from "../src/predicate.ts";
import { evaluatePerformanceReferenceModel } from "../src/reference-model.ts";
import { runPerformanceMutationRegistry } from "../src/mutations.ts";
import { PERFORMANCE_CRITICAL_MUTATION_IDS } from "../src/spec.ts";
import type { PerformanceFactBundleV1 } from "../src/schema.ts";

const h = (digit: string): Hash => `0x${digit.repeat(64)}` as Hash;

function makeCommitment(profile: ProductionPerformanceProfileV1): PerformanceWindowCommitmentV1 {
  return createPerformanceWindowCommitment({
    windowStartAnchor: { chainId: "1", number: "100", hash: h("1"), parentHash: h("2"), stateRoot: h("3") },
    eligibilityRuleHash: h("4"),
    performanceProfileHash: profile.profileHash,
    targetCount: "100",
    processLogAnchor: { commitSha: "a".repeat(40), executableHash: h("5"), pid: "42", processStartTicks: "7", bootIdHash: h("6"), logSystemId: "system", logBootIdHash: h("6"), logDevice: "8", logInode: "9" },
    releaseBindingId: h("7"), releaseProvenanceHash: h("8"), runtimeAnchorHash: h("9"), providerRoot: h("a"), hardwareProfileRoot: h("b"), commitContextBindingId: h("c"), commitAppendRecordId: h("d"), committedMonotonicNs: "0",
  });
}

class MemoryAppend implements PerformanceAppendPortV1 {
  #offset = 0n;
  async appendFsyncMonotonic(request: Parameters<PerformanceAppendPortV1["appendFsyncMonotonic"]>[0]) {
    const start = this.#offset;
    this.#offset += BigInt(request.bytes.length);
    return { sequence: request.sequence, eventId: request.eventId, contentSha256: sha256Hex(request.bytes), byteLength: request.bytes.length.toString(), offsetStart: start.toString(), offsetEnd: this.#offset.toString(), fsynced: true as const };
  }
}

interface BuildBundleOptionsV1 {
  readonly profile?: ProductionPerformanceProfileV1;
  readonly candidateBearing?: boolean;
  readonly coarseDurationUs?: string;
  readonly finalSimulationQueueWaitUs?: string;
  readonly finalSimulationServiceUs?: string;
  readonly successfulDryRunHeadCount?: number;
}

function profileWithBudgets(patch: Partial<PerformanceBudgetV1>): ProductionPerformanceProfileV1 {
  const profile = DEFAULT_PRODUCTION_PERFORMANCE_PROFILE;
  return createProductionPerformanceProfile({
    version: profile.version,
    targetCount: profile.targetCount,
    percentileAlgorithm: profile.percentileAlgorithm,
    percentiles: [...profile.percentiles],
    budgets: { ...profile.budgets, ...patch },
    queueProfile: { ...profile.queueProfile },
    requireSixStepDryRunCandidate: true,
  });
}

async function buildBundle(options: BuildBundleOptionsV1 = {}): Promise<PerformanceFactBundleV1> {
  const profile = options.profile ?? DEFAULT_PRODUCTION_PERFORMANCE_PROFILE;
  const candidateBearing = options.candidateBearing ?? true;
  const successfulDryRunHeadCount = candidateBearing ? options.successfulDryRunHeadCount ?? 1 : 0;
  if (!Number.isSafeInteger(successfulDryRunHeadCount) || successfulDryRunHeadCount < 0 || successfulDryRunHeadCount > 100) {
    throw new TypeError("successfulDryRunHeadCount is invalid");
  }
  const append = new MemoryAppend();
  let now = 1_000_000n;
  const collector = await PerformanceWindowCollectorV1.open({ commitment: makeCommitment(profile), profile, append, clock: () => { now += 1_000_000n; return now; } });
  let previousHash = h("d");
  for (let index = 0; index < 100; index += 1) {
    const hasSuccessfulDryRun = index < successfulDryRunHeadCount;
    const candidateId = h((((index + 1) % 9) + 1).toString());
    const headHash = h(((index % 9) + 1).toString());
    const anchor = await collector.acceptCanonicalHead({ canonicalHead: { chainId: "1", number: (101 + index).toString(), hash: headHash, parentHash: previousHash, stateRoot: h("e") } });
    const candidateSet = createCandidateSet({ windowId: collector.commitment.windowId, ordinal: (index + 1).toString(), candidateIds: hasSuccessfulDryRun ? [candidateId] : [] });
    const serving = index < 20
      ? { generationId: "generation-1", graphRoot: h("7"), readyRecordHash: h("8"), generationSourceCoverageRoot: h("c") }
      : { generationId: "generation-2", graphRoot: h("6"), readyRecordHash: h("5"), generationSourceCoverageRoot: h("a") };
    const coverage = createPerformanceCoverageReceipt({ windowId: collector.commitment.windowId, ordinal: anchor.ordinal, canonicalHead: anchor.canonicalHead, sourceCoverageRoot: h("f") });
    const head = await collector.bindEligibleHeadFacts(anchor, { coverage, candidateSet, serving });
    previousHash = headHash;
    await collector.sealTerminal(head.headRecordId, issuePerformanceHeadTerminalEvidenceForTest({
      windowId: collector.commitment.windowId,
      headRecordId: head.headRecordId,
      candidateSetRoot: candidateSet.candidateSetRoot,
      correlationRoot: h("4"),
      outcome: hasSuccessfulDryRun ? "complete-candidates-terminal" : "complete-no-candidate",
      candidatePathDurationUs: hasSuccessfulDryRun ? "500" : null,
      sourceCoarseDurationUs: "100", coarseDurationUs: options.coarseDurationUs ?? "90", plannerExactProgramDurationUs: hasSuccessfulDryRun ? "200" : "0", finalSimulationQueueWaitUs: hasSuccessfulDryRun ? options.finalSimulationQueueWaitUs ?? "10" : "0", finalSimulationServiceUs: hasSuccessfulDryRun ? options.finalSimulationServiceUs ?? "100" : "0", overheadDurationUs: "10",
      candidateTerminals: hasSuccessfulDryRun ? [{ candidateId, outcome: "verified", timingUs: "500", evidenceRoot: h("2"), sixStepCompletion: { mode: "dry-run", evidenceRoot: h("5") } }] : [],
      workReceiptRoot: h("3"),
      queueTelemetry: [{ lane: "producer-critical", resource: "rpc", current: "0", max: "4", oldestAgeUs: "0", accepted: "1", rejected: "0", cancelled: "0" }],
      permitAccounting: [{ ownerRef: "producer", lane: "producer-critical", resource: "rpc", issued: "1", released: "1", active: "0" }],
      resourceSamples: [{ resource: "rpc", current: "0", capacity: "8", max: "8" }],
      cpuMemoryEventLoop: { cpuUtilizationBasisPoints: "100", rssBytes: "1000", eventLoopLagUs: "1" },
      workerRestart: { workerCount: "4", restarted: "0", orphanedWorkers: "0" },
    }));
  }
  const bundle = collector.snapshot().bundle;
  assert.ok(bundle !== null);
  return bundle;
}

test("nearest-rank is integer and non-interpolating", () => {
  assert.equal(nearestRankPercentile(["1", "2", "100"], "0.50"), "2");
  assert.equal(nearestRankPercentile(["1", "2", "100"], "0.95"), "100");
});

test("runtime predicate and independent reference agree on a complete 100-head corpus", async () => {
  const bundle = await buildBundle();
  const runtime = evaluatePerformancePredicate(bundle);
  const reference = evaluatePerformanceReferenceModel(bundle);
  assert.equal(runtime.verdict, "pass", JSON.stringify(runtime.reasons));
  assert.equal(reference.verdict, "pass", JSON.stringify(reference.reasons));
  assert.deepEqual(runtime.percentiles?.headCompletionP99Us, "1000");
  assert.equal(runtime.acceptanceReceipt?.verdict, "pass");
  assert.deepEqual(bundle.generationSegments.map(segment => [segment.firstHeadOrdinal, segment.lastHeadOrdinal]), [["1", "20"], ["21", "100"]]);
});

test("runtime and reference reject aggregate Proxy/accessor inputs without invoking traps", async () => {
  const bundle = await buildBundle();
  let trapHits = 0;
  const proxy = new Proxy(bundle, {
    get: () => { trapHits += 1; return undefined; },
    has: () => { trapHits += 1; return false; },
    ownKeys: () => { trapHits += 1; return []; },
  });
  assert.equal(evaluatePerformancePredicate(proxy).verdict, "invalid");
  assert.equal(evaluatePerformanceReferenceModel(proxy).verdict, "invalid");
  assert.equal(trapHits, 0);

  let getterHits = 0;
  const accessor = { ...bundle };
  Object.defineProperty(accessor, "profile", {
    enumerable: true,
    get: () => { getterHits += 1; return bundle.profile; },
  });
  assert.equal(evaluatePerformancePredicate(accessor as never).verdict, "invalid");
  assert.equal(evaluatePerformanceReferenceModel(accessor as never).verdict, "invalid");
  assert.equal(getterHits, 0);
});

test("every declared mutation executes and the no-op is detected as ineffective", async () => {
  const bundle = await buildBundle();
  const runs = runPerformanceMutationRegistry(bundle);
  assert.deepEqual(runs.map((run) => run.id), [...PERFORMANCE_CRITICAL_MUTATION_IDS]);
  assert.equal(runs.length, PERFORMANCE_CRITICAL_MUTATION_IDS.length);
  assert.equal(runs.find((run) => run.id === "no-op-mutator")?.changed, false);
  assert.equal(runs.filter((run) => run.id !== "no-op-mutator" && run.changed).length, runs.length - 1);
  for (const run of runs) {
    const verdict = evaluatePerformancePredicate(run.output as PerformanceFactBundleV1).verdict;
    if (run.id === "no-op-mutator") assert.equal(verdict, "pass");
    else assert.notEqual(verdict, "pass", `${run.id} did not exercise a rejecting mutation`);
  }
});

test("a complete 100-head no-candidate window cannot satisfy the required dry-run candidate", async () => {
  const bundle = await buildBundle({ candidateBearing: false });
  const runtime = evaluatePerformancePredicate(bundle);
  const reference = evaluatePerformanceReferenceModel(bundle);
  assert.equal(runtime.verdict, "fail");
  assert.equal(reference.verdict, "fail");
  assert.ok(runtime.reasons.some((reason) => reason.code === "required-six-step-missing"));
});

test("a structurally valid window with two successful dry runs is invalid until a different selection rule is frozen", async () => {
  const bundle = await buildBundle({ successfulDryRunHeadCount: 2 });
  const runtime = evaluatePerformancePredicate(bundle);
  const reference = evaluatePerformanceReferenceModel(bundle);
  assert.equal(runtime.verdict, "invalid");
  assert.equal(reference.verdict, "invalid");
  assert.ok(runtime.reasons.some((reason) => reason.code === "required-six-step-cardinality"));
  assert.ok(reference.reasons.includes("six-step-candidate-cardinality"));
});

test("exact denominator rejects both 99 and 101 heads", async () => {
  const bundle = await buildBundle();
  const mutations = runPerformanceMutationRegistry(bundle);
  for (const id of ["head-99", "head-101"] as const) {
    const mutation = mutations.find((entry) => entry.id === id);
    assert.ok(mutation !== undefined);
    assert.equal(evaluatePerformancePredicate(mutation.output as PerformanceFactBundleV1).verdict, "invalid");
  }
});

test("missing budget fields are invalid rather than silently skipped", async () => {
  const bundle = await buildBundle();
  const { coarseP99Us: _omitted, ...budgets } = bundle.profile.budgets;
  const malformed = {
    ...bundle,
    profile: { ...bundle.profile, budgets },
  };
  assert.equal(evaluatePerformancePredicate(malformed as never).verdict, "invalid");
  assert.equal(evaluatePerformanceReferenceModel(malformed as never).verdict, "invalid");
});

test("missing coarse or final-simulation timing samples are invalid", async () => {
  const bundle = await buildBundle();
  for (const field of ["coarseDurationUs", "finalSimulationQueueWaitUs", "finalSimulationServiceUs"] as const) {
    const metric = { ...bundle.metrics[0] } as Record<string, unknown>;
    delete metric[field];
    const malformed = { ...bundle, metrics: [metric, ...bundle.metrics.slice(1)] };
    assert.equal(evaluatePerformancePredicate(malformed as never).verdict, "invalid", field);
    assert.equal(evaluatePerformanceReferenceModel(malformed as never).verdict, "invalid", field);
  }
});

test("coarse, final queue-service p99, and final hard deadline are all load-bearing", async () => {
  const cases = [
    {
      bundle: await buildBundle({ profile: profileWithBudgets({ coarseP95Us: "80", coarseP99Us: "80" }) }),
      path: "coarseP95Us",
    },
    {
      bundle: await buildBundle({ profile: profileWithBudgets({ finalSimulationQueueServiceP99Us: "100" }) }),
      path: "finalSimulationQueueServiceP99Us",
    },
    {
      bundle: await buildBundle({ profile: profileWithBudgets({ finalSimulationHardDeadlineUs: "100" }) }),
      path: "finalSimulationHardDeadlineUs",
    },
  ] as const;
  for (const entry of cases) {
    const runtime = evaluatePerformancePredicate(entry.bundle);
    const reference = evaluatePerformanceReferenceModel(entry.bundle);
    assert.equal(runtime.verdict, "fail", entry.path);
    assert.equal(reference.verdict, "fail", entry.path);
    assert.ok(runtime.reasons.some((reason) => reason.code === "budget-exceeded" && reason.path.includes(entry.path)), entry.path);
  }
});
