import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  DEFAULT_PRODUCTION_PERFORMANCE_PROFILE,
  createCandidateSet,
  createPerformanceWindowCommitment,
  type PerformanceWindowCommitmentV1,
  type QueueTelemetryV1,
  type PermitAccountingV1,
  type ResourceSampleV1,
} from "../../../specs/performance/src/index.ts";
import {
  PerformanceWindowCollectorV1,
  createPerformanceCoverageReceipt,
  type PerformanceAppendPortV1,
} from "../src/index.ts";
import { issuePerformanceHeadTerminalEvidenceForTest } from "./authority-fixture.ts";
import type { PerformanceHeadTerminalEvidenceDraftV1 } from "../src/internal/head-terminal-evidence.ts";

const h = (digit: string): Hash => `0x${digit.repeat(64)}` as Hash;

function commitment(committedMonotonicNs = "0"): PerformanceWindowCommitmentV1 {
  return createPerformanceWindowCommitment({
    windowStartAnchor: { chainId: "1", number: "100", hash: h("1"), parentHash: h("2"), stateRoot: h("2") },
    eligibilityRuleHash: h("3"),
    performanceProfileHash: DEFAULT_PRODUCTION_PERFORMANCE_PROFILE.profileHash,
    targetCount: "100",
    processLogAnchor: {
      commitSha: "a".repeat(40), executableHash: h("4"), pid: "42", processStartTicks: "7", bootIdHash: h("5"),
      logSystemId: "system", logBootIdHash: h("5"), logDevice: "8", logInode: "9",
    },
    releaseBindingId: h("6"),
    releaseProvenanceHash: h("7"),
    runtimeAnchorHash: h("c"),
    providerRoot: h("8"),
    hardwareProfileRoot: h("9"),
    commitContextBindingId: h("a"),
    commitAppendRecordId: h("b"),
    committedMonotonicNs,
  });
}

function facts(
  coverage: ReturnType<typeof createPerformanceCoverageReceipt>,
  candidateSet: ReturnType<typeof createCandidateSet>,
  generationId = "generation-1",
) {
  return {
    coverage,
    candidateSet,
    serving: {
      generationId,
      graphRoot: generationId === "generation-1" ? h("6") : h("c"),
      readyRecordHash: generationId === "generation-1" ? h("7") : h("d"),
      generationSourceCoverageRoot: generationId === "generation-1" ? h("e") : h("f"),
    },
  };
}

class MemoryAppend implements PerformanceAppendPortV1 {
  readonly requests: Uint8Array[] = [];
  #offset = 0n;
  async appendFsyncMonotonic(request: Parameters<PerformanceAppendPortV1["appendFsyncMonotonic"]>[0]) {
    const start = this.#offset;
    this.#offset += BigInt(request.bytes.length);
    this.requests.push(request.bytes);
    return {
      sequence: request.sequence,
      eventId: request.eventId,
      contentSha256: sha256Hex(request.bytes),
      byteLength: request.bytes.length.toString(),
      offsetStart: start.toString(),
      offsetEnd: this.#offset.toString(),
      fsynced: true as const,
    };
  }
}

class FailOnceAppend extends MemoryAppend {
  readonly #failAtCall: number;
  #calls = 0;

  constructor(failAtCall: number) {
    super();
    this.#failAtCall = failAtCall;
  }

  override async appendFsyncMonotonic(request: Parameters<PerformanceAppendPortV1["appendFsyncMonotonic"]>[0]) {
    const call = this.#calls;
    this.#calls += 1;
    if (call === this.#failAtCall) throw new Error("forced append uncertainty");
    return super.appendFsyncMonotonic(request);
  }
}

const queue: QueueTelemetryV1 = {
  lane: "producer-critical", resource: "rpc", current: "0", max: "4", oldestAgeUs: "0", accepted: "1", rejected: "0", cancelled: "0",
};
const permit: PermitAccountingV1 = { ownerRef: "producer", lane: "producer-critical", resource: "rpc", issued: "1", released: "1", active: "0" };
const resource: ResourceSampleV1 = { resource: "rpc", current: "0", capacity: "8", max: "8" };

function terminalEvidenceDraft(input: {
  readonly windowId: Hash;
  readonly headRecordId: Hash;
  readonly candidateSetRoot: Hash;
  readonly candidateId?: Hash;
  readonly candidateOutcome?: "verified" | "chain-proven-rejected" | "policy-rejected";
  readonly withSixStep?: boolean;
}): PerformanceHeadTerminalEvidenceDraftV1 {
  const candidateId = input.candidateId;
  const withSixStep = input.withSixStep ?? candidateId !== undefined;
  return {
    windowId: input.windowId,
    headRecordId: input.headRecordId,
    candidateSetRoot: input.candidateSetRoot,
    correlationRoot: h("4"),
    outcome: candidateId === undefined ? "complete-no-candidate" : "complete-candidates-terminal",
    candidatePathDurationUs: candidateId === undefined ? null : "500",
    sourceCoarseDurationUs: "100",
    coarseDurationUs: "90",
    plannerExactProgramDurationUs: candidateId === undefined ? "0" : "200",
    finalSimulationQueueWaitUs: candidateId === undefined ? "0" : "10",
    finalSimulationServiceUs: candidateId === undefined ? "0" : "100",
    overheadDurationUs: "10",
    candidateTerminals: candidateId === undefined ? [] : [{
      candidateId,
      outcome: input.candidateOutcome ?? "verified",
      timingUs: "500",
      evidenceRoot: h("b"),
      sixStepCompletion: withSixStep ? { mode: "unsigned-dry-run", evidenceRoot: h("f") } : null,
    }],
    workReceiptRoot: h("a"),
    queueTelemetry: [queue],
    permitAccounting: [permit],
    resourceSamples: [resource],
    cpuMemoryEventLoop: { cpuUtilizationBasisPoints: "100", rssBytes: "1000", eventLoopLagUs: "1" },
    workerRestart: { workerCount: "4", restarted: "0", orphanedWorkers: "0" },
  };
}

async function bindHead(
  collector: PerformanceWindowCollectorV1,
  number: string,
  hash: Hash,
  parentHash: Hash,
  candidateIds: readonly Hash[] = [],
) {
  const anchor = await collector.acceptCanonicalHead({
    canonicalHead: { chainId: "1", number, hash, parentHash, stateRoot: h("e") },
  });
  const candidateSet = createCandidateSet({
    windowId: collector.commitment.windowId,
    ordinal: anchor.ordinal,
    candidateIds,
  });
  const coverage = createPerformanceCoverageReceipt({
    windowId: collector.commitment.windowId,
    ordinal: anchor.ordinal,
    canonicalHead: anchor.canonicalHead,
    sourceCoverageRoot: h("d"),
  });
  const head = await collector.bindEligibleHeadFacts(anchor, facts(coverage, candidateSet));
  return { head, candidateSet };
}

test("collector assigns ordinals and seals all unhealthy outcomes instead of dropping them", async () => {
  const append = new MemoryAppend();
  let now = 1_000_000n;
  const collector = await PerformanceWindowCollectorV1.open({
    commitment: commitment(),
    profile: DEFAULT_PRODUCTION_PERFORMANCE_PROFILE,
    append,
    clock: () => { now += 1_000_000n; return now; },
  });
  let previousHash = h("f");
  let firstHeadId: Hash | null = null;
  for (let index = 0; index < 100; index += 1) {
    const hash = h(((index % 9) + 1).toString());
    const anchor = await collector.acceptCanonicalHead({
      canonicalHead: { chainId: "1", number: (101 + index).toString(), hash, parentHash: previousHash, stateRoot: h("e") },
    });
    const candidateSet = createCandidateSet({ windowId: collector.commitment.windowId, ordinal: (index + 1).toString(), candidateIds: index === 0 ? [h("c")] : [] });
    const coverage = createPerformanceCoverageReceipt({ windowId: collector.commitment.windowId, ordinal: anchor.ordinal, canonicalHead: anchor.canonicalHead, sourceCoverageRoot: h("d") });
    const head = await collector.bindEligibleHeadFacts(anchor, facts(coverage, candidateSet, index < 20 ? "generation-1" : "generation-2"));
    if (firstHeadId === null) firstHeadId = head.headRecordId;
    previousHash = hash;
    const terminal = await collector.sealTerminal(head.headRecordId, issuePerformanceHeadTerminalEvidenceForTest({
      windowId: collector.commitment.windowId,
      headRecordId: head.headRecordId,
      candidateSetRoot: candidateSet.candidateSetRoot,
      correlationRoot: h("4"),
      outcome: index === 50 ? "timeout" : index === 0 ? "complete-candidates-terminal" : "complete-no-candidate",
      candidatePathDurationUs: index === 0 ? "500" : null,
      sourceCoarseDurationUs: "100",
      coarseDurationUs: "90",
      plannerExactProgramDurationUs: index === 0 ? "200" : "0",
      finalSimulationQueueWaitUs: index === 0 ? "10" : "0",
      finalSimulationServiceUs: index === 0 ? "100" : "0",
      overheadDurationUs: "10",
      candidateTerminals: index === 0 ? [{ candidateId: h("c"), outcome: "verified", timingUs: "500", evidenceRoot: h("b"), sixStepCompletion: { mode: "unsigned-dry-run", evidenceRoot: h("f") } }] : [],
      workReceiptRoot: h("a"),
      queueTelemetry: [queue], permitAccounting: [permit], resourceSamples: [resource],
      cpuMemoryEventLoop: { cpuUtilizationBasisPoints: "100", rssBytes: "1000", eventLoopLagUs: "1" },
      workerRestart: { workerCount: "4", restarted: "0", orphanedWorkers: "0" },
    }));
    assert.equal(terminal.ordinal, (index + 1).toString());
  }
  const snapshot = collector.snapshot();
  assert.ok(snapshot.bundle !== null, "unhealthy terminals still seal a complete raw bundle");
  assert.equal(snapshot.bundle?.windowReceipt.healthyHeadCount, "99");
  assert.equal(snapshot.terminals.length, 100);
  assert.equal(snapshot.terminals.filter((terminal) => !terminal.healthy).length, 1);
  assert.deepEqual(snapshot.generationSegments.map(segment => [segment.firstHeadOrdinal, segment.lastHeadOrdinal]), [["1", "20"], ["21", "100"]]);
  assert.equal(snapshot.rawEventIds.length, append.requests.length);
  assert.equal(snapshot.rawEvents.length, append.requests.length);
  assert.ok(firstHeadId !== null);
});

test("head admission defers lane facts and preserves content-addressed anchors", async () => {
  const append = new MemoryAppend();
  let now = 1_000_000n;
  const collector = await PerformanceWindowCollectorV1.open({
    commitment: commitment(),
    profile: DEFAULT_PRODUCTION_PERFORMANCE_PROFILE,
    append,
    clock: () => { now += 1_000_000n; return now; },
  });
  const mutableHead = { chainId: "1", number: "101", hash: h("1"), parentHash: h("2"), stateRoot: h("3") };
  await assert.rejects(
    () => collector.acceptCanonicalHead({ canonicalHead: mutableHead, sourceCoverageRoot: h("9"), candidateIds: [] } as never),
    /unknown field/,
  );
  const anchor = await collector.acceptCanonicalHead({ canonicalHead: mutableHead });
  mutableHead.hash = h("4");
  assert.equal(anchor.canonicalHead.hash, h("1"));
  assert.equal(append.requests.length, 1, "admission must not append placeholder coverage or candidates");

  const candidateSet = createCandidateSet({ windowId: collector.commitment.windowId, ordinal: anchor.ordinal, candidateIds: [] });
  const mismatchedCoverage = createPerformanceCoverageReceipt({
    windowId: collector.commitment.windowId,
    ordinal: anchor.ordinal,
    canonicalHead: { ...anchor.canonicalHead, hash: h("4") },
    sourceCoverageRoot: h("5"),
  });
  await assert.rejects(
    () => collector.bindEligibleHeadFacts(anchor, facts(mismatchedCoverage, candidateSet)),
    /coverage receipt does not bind eligible head anchor/,
  );
  assert.equal(append.requests.length, 1, "rejected joins must not append partial facts");

  const coverage = createPerformanceCoverageReceipt({
    windowId: collector.commitment.windowId,
    ordinal: anchor.ordinal,
    canonicalHead: anchor.canonicalHead,
    sourceCoverageRoot: h("5"),
  });
  const head = await collector.bindEligibleHeadFacts(anchor, facts(coverage, candidateSet));
  assert.equal(head.ordinal, "1");
  assert.equal(append.requests.length, 3, "eligible-head and candidate-set append only after the exact join");
});

test("replacement keeps one ordinal and records lineage only after replacement facts bind", async () => {
  const append = new MemoryAppend();
  let now = 1_000_000n;
  const collector = await PerformanceWindowCollectorV1.open({
    commitment: commitment(),
    profile: DEFAULT_PRODUCTION_PERFORMANCE_PROFILE,
    append,
    clock: () => { now += 1_000_000n; return now; },
  });
  const first = await collector.acceptCanonicalHead({
    canonicalHead: { chainId: "1", number: "101", hash: h("1"), parentHash: h("2"), stateRoot: h("3") },
  });
  const firstSet = createCandidateSet({ windowId: collector.commitment.windowId, ordinal: first.ordinal, candidateIds: [] });
  const firstCoverage = createPerformanceCoverageReceipt({ windowId: collector.commitment.windowId, ordinal: first.ordinal, canonicalHead: first.canonicalHead, sourceCoverageRoot: h("4") });
  const firstHead = await collector.bindEligibleHeadFacts(first, facts(firstCoverage, firstSet));
  const replacement = await collector.replaceCanonicalHead(first, {
    canonicalHead: { chainId: "1", number: "101", hash: h("5"), parentHash: h("2"), stateRoot: h("3") },
  });
  await assert.rejects(() => collector.sealTerminal(firstHead.headRecordId, {} as never), /head facts are not bound/);
  const replacementSet = createCandidateSet({ windowId: collector.commitment.windowId, ordinal: replacement.ordinal, candidateIds: [] });
  const replacementCoverage = createPerformanceCoverageReceipt({ windowId: collector.commitment.windowId, ordinal: replacement.ordinal, canonicalHead: replacement.canonicalHead, sourceCoverageRoot: h("6") });
  const replacementHead = await collector.bindEligibleHeadFacts(replacement, facts(replacementCoverage, replacementSet));
  const snapshot = collector.snapshot();
  assert.equal(snapshot.heads.length, 1);
  assert.equal(snapshot.heads[0]?.headRecordId, replacementHead.headRecordId);
  assert.equal(snapshot.lineages.length, 1);
  assert.equal(snapshot.lineages[0]?.orphanHeadRecordId, firstHead.headRecordId);
  assert.deepEqual(snapshot.rawEvents.map((event) => event.eventType), [
    "window-commitment",
    "eligible-head",
    "candidate-set",
    "eligible-head",
    "candidate-set",
    "orphan-replacement",
  ]);
});

test("collector accepts only issued evidence capabilities and rejects clones and cross-head reuse", async () => {
  const collector = await PerformanceWindowCollectorV1.open({
    commitment: commitment(),
    profile: DEFAULT_PRODUCTION_PERFORMANCE_PROFILE,
    append: new MemoryAppend(),
    clock: (() => { let now = 1_000_000n; return () => { now += 1_000_000n; return now; }; })(),
  });
  const first = await bindHead(collector, "101", h("1"), h("f"), [h("c")]);
  const second = await bindHead(collector, "102", h("2"), h("1"));
  const issued = issuePerformanceHeadTerminalEvidenceForTest(terminalEvidenceDraft({
    windowId: collector.commitment.windowId,
    headRecordId: first.head.headRecordId,
    candidateSetRoot: first.candidateSet.candidateSetRoot,
    candidateId: h("c"),
  }));

  await assert.rejects(
    () => collector.sealTerminal(first.head.headRecordId, { ...issued } as never),
    /was not issued/,
  );
  await assert.rejects(
    () => collector.sealTerminal(second.head.headRecordId, issued),
    /another head/,
  );
  await collector.sealTerminal(first.head.headRecordId, issued);
});

test("pre-append semantic rejection aborts the evidence claim instead of losing it", async () => {
  const append = new MemoryAppend();
  const collector = await PerformanceWindowCollectorV1.open({
    commitment: commitment(),
    profile: DEFAULT_PRODUCTION_PERFORMANCE_PROFILE,
    append,
    clock: (() => { let now = 1_000_000n; return () => { now += 1_000_000n; return now; }; })(),
  });
  const target = await bindHead(collector, "101", h("1"), h("f"), [h("c")]);
  const invalid = terminalEvidenceDraft({
    windowId: collector.commitment.windowId,
    headRecordId: target.head.headRecordId,
    candidateSetRoot: target.candidateSet.candidateSetRoot,
    candidateId: h("c"),
  });
  const capability = issuePerformanceHeadTerminalEvidenceForTest({ ...invalid, candidateTerminals: [] });
  await assert.rejects(() => collector.sealTerminal(target.head.headRecordId, capability), /requires every candidate terminal/);
  await assert.rejects(() => collector.sealTerminal(target.head.headRecordId, capability), /requires every candidate terminal/);
  assert.equal(append.requests.length, 3, "pre-append rejection must not create terminal facts");
});

test("an indeterminate durable append consumes the claim and poisons exact-head retry", async () => {
  const append = new FailOnceAppend(3);
  const collector = await PerformanceWindowCollectorV1.open({
    commitment: commitment(),
    profile: DEFAULT_PRODUCTION_PERFORMANCE_PROFILE,
    append,
    clock: (() => { let now = 1_000_000n; return () => { now += 1_000_000n; return now; }; })(),
  });
  const target = await bindHead(collector, "101", h("1"), h("f"));
  const capability = issuePerformanceHeadTerminalEvidenceForTest(terminalEvidenceDraft({
    windowId: collector.commitment.windowId,
    headRecordId: target.head.headRecordId,
    candidateSetRoot: target.candidateSet.candidateSetRoot,
  }));
  await assert.rejects(() => collector.sealTerminal(target.head.headRecordId, capability), /forced append uncertainty/);
  await assert.rejects(() => collector.sealTerminal(target.head.headRecordId, capability), /durable append is indeterminate/);
  assert.equal(append.requests.length, 3, "collector must not append a replacement terminal after uncertain persistence");
});

test("collector rejects cross-window capabilities and raw caller terminal DTOs", async () => {
  const open = async () => PerformanceWindowCollectorV1.open({
    commitment: commitment(),
    profile: DEFAULT_PRODUCTION_PERFORMANCE_PROFILE,
    append: new MemoryAppend(),
    clock: (() => { let now = 1_000_000n; return () => { now += 1_000_000n; return now; }; })(),
  });
  const firstCollector = await open();
  const secondCollector = await PerformanceWindowCollectorV1.open({
    commitment: commitment("1"),
    profile: DEFAULT_PRODUCTION_PERFORMANCE_PROFILE,
    append: new MemoryAppend(),
    clock: (() => { let now = 2_000_000n; return () => { now += 1_000_000n; return now; }; })(),
  });
  const target = await bindHead(secondCollector, "101", h("1"), h("f"));
  const draft = terminalEvidenceDraft({
    windowId: firstCollector.commitment.windowId,
    headRecordId: target.head.headRecordId,
    candidateSetRoot: target.candidateSet.candidateSetRoot,
  });
  await assert.rejects(
    () => secondCollector.sealTerminal(target.head.headRecordId, issuePerformanceHeadTerminalEvidenceForTest(draft)),
    /another window/,
  );
  await assert.rejects(
    () => secondCollector.sealTerminal(target.head.headRecordId, draft as never),
    /was not issued/,
  );
});

test("test authority refuses rejected or policy outcomes masquerading as six-step completion", () => {
  for (const outcome of ["chain-proven-rejected", "policy-rejected"] as const) {
    assert.throws(
      () => issuePerformanceHeadTerminalEvidenceForTest(terminalEvidenceDraft({
        windowId: h("1"),
        headRecordId: h("2"),
        candidateSetRoot: h("3"),
        candidateId: h("4"),
        candidateOutcome: outcome,
        withSixStep: true,
      })),
      /only a verified candidate/,
    );
  }
});
