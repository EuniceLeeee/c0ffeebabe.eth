import assert from "node:assert/strict";
import {
  blindProductionAuditHash,
} from "../blind-production-audit.js";
import {
  buildPairedLiveReport,
  freezePairedLiveEligibilityRule,
  ImmutablePairedLiveDeliveryBroker,
  PAIRED_LIVE_COVERAGE_FLOOR,
  PAIRED_LIVE_SCHEMA_VERSION,
  PAIRED_LIVE_TERMINAL_DEADLINE_MS,
  reconcilePairedLiveCanonicalHeaders,
  TrustedPairedLiveHeaderAuditor,
  type EligibleHeadJournalEntry,
  type EligibleHeadJournalSeal,
  type FinalCanonicalHeader,
  type FrozenPairedLiveEligibilityRule,
  type HeaderAuditResult,
  type PairedLiveCanonicalHeaderSubscription,
  type PairedLiveEligibilityRuleInput,
  type PairedLiveFinalCanonicalSource,
  type PairedLiveSemanticExtractor,
  type PairedLiveSide,
  type PairedLiveSourceHeader,
  type PairedLiveTerminalInput,
  type PairedLiveTrustedClock,
} from "./adapter-family-paired-live.js";

function testFrozenRuleAndReorgJournal(): void {
  const context = makeContext(100, 102, 1_000, ["approved-family"]);
  const { rule } = context;
  assert(Object.isFrozen(rule));
  assert(Object.isFrozen(rule.sharedInputs));
  assert.equal(rule.terminalDeadlineMs, 10_000);
  assert.equal(rule.absoluteHeadCoverageFloor, 0.95);
  assert.equal(rule.relativeHeadCoverageFloor, 0.95);
  assert(rule.sealedAtMs < rule.observationWindow.opensAtMs);
  assert(!("futureHeaderHashes" in rule));

  const extraInput = ruleInput(100, 102, 1_000, []);
  const extraClock = new FakeTrustedClock(
    extraInput.trustedClockIdentitySha256,
    999,
  );
  assert.throws(
    () => freezePairedLiveEligibilityRule({
      ...extraInput,
      futureHeaderHashes: [blockHash(999)],
    } as PairedLiveEligibilityRuleInput, extraClock),
    /unexpected or missing fields/,
    "future hashes cannot be smuggled into the frozen rule",
  );

  const lateInput = ruleInput(103, 103, 2_000, []);
  const lateClock = new FakeTrustedClock(
    lateInput.trustedClockIdentitySha256,
    lateInput.observationWindow.opensAtMs,
  );
  assert.throws(
    () => freezePairedLiveEligibilityRule(lateInput, lateClock),
    /sealed before the observation window/,
    "eligibility cannot be frozen after observation starts",
  );

  assert.throws(
    () => {
      (rule.blockRange as { first: number }).first = 1;
    },
    TypeError,
    "frozen eligibility must be deeply immutable",
  );

  const auditor = makeAuditor(context);
  assert(Object.isFrozen(auditor));
  assert(Object.isFrozen(auditor.journal));
  assert.throws(
    () => {
      (auditor.journal as unknown as { append: unknown }).append = () => {};
    },
    TypeError,
    "the public journal is a frozen read-only facade",
  );
  const before = captureHeader(
    context,
    auditor,
    {
      number: 99,
      hash: blockHash(99),
      parentHash: blockHash(98),
      sourceGeneration: 0,
    },
    1_000,
  );
  assert.deepEqual(before, {
    eligible: false,
    reason: "before_block_range",
  });
  const h100 = requiredEligible(captureHeader(
    context,
    auditor,
    {
      number: 100,
      hash: blockHash(100),
      parentHash: blockHash(99),
      sourceGeneration: 0,
    },
    1_100,
  ));
  const h101Orphan = requiredEligible(captureHeader(
    context,
    auditor,
    {
      number: 101,
      hash: blockHash(101),
      parentHash: blockHash(100),
      sourceGeneration: 0,
    },
    1_200,
  ));
  context.clock.set(1_250);
  assert.throws(
    () => context.headerSource.emit({
      number: 101,
      hash: blockHash(1_101),
      parentHash: blockHash(100),
      sourceGeneration: 0,
    }),
    /replacement must advance source generation/,
    "a replacement cannot overwrite the prior source generation",
  );
  const h101Canonical = requiredEligible(captureHeader(
    context,
    auditor,
    {
      number: 101,
      hash: blockHash(1_101),
      parentHash: blockHash(100),
      sourceGeneration: 1,
    },
    1_300,
  ));
  const h102 = requiredEligible(captureHeader(
    context,
    auditor,
    {
      number: 102,
      hash: blockHash(1_102),
      parentHash: blockHash(1_101),
      sourceGeneration: 1,
    },
    1_400,
  ));
  const entries = [h100, h101Orphan, h101Canonical, h102];
  assert.equal(auditor.journal.entries().length, 4);
  assert.equal(h100.previousEntrySha256, "0".repeat(64));
  for (let index = 1; index < entries.length; index++) {
    assert.equal(
      entries[index]!.previousEntrySha256,
      entries[index - 1]!.entrySha256,
      "eligible-head journal is hash chained",
    );
  }

  const broker = new ImmutablePairedLiveDeliveryBroker(
    rule,
    auditor.journal,
    context.semanticExtractor,
  );
  assert(Object.isFrozen(broker));
  assert.throws(
    () => {
      (broker as unknown as { clock: unknown }).clock = {
        nowMs: () => 0,
      };
    },
    TypeError,
    "the broker's trusted clock capability is not replaceable",
  );
  assert.throws(
    () => {
      (broker as unknown as { semanticExtractor: unknown })
        .semanticExtractor = {
          extract: () => ({
            type: "scanner_done",
            outcome: "no_candidate",
            commonSemantics: {},
            additions: [],
            telemetry: telemetry(),
          }),
        };
    },
    TypeError,
    "the broker's semantic extractor capability is not replaceable",
  );
  context.clock.set(1_500);
  assert.throws(
    () => broker.deliver("baseline", "f".repeat(64)),
    /previously journaled eligible head/,
    "delivery cannot precede the trusted journal",
  );
  for (const [index, entry] of entries.entries()) {
    const baseline = deliverAndAcknowledge(
      context,
      broker,
      "baseline",
      entry,
    );
    const challenger = deliverAndAcknowledge(
      context,
      broker,
      "challenger",
      entry,
    );
    assert.strictEqual(
      baseline.envelope,
      challenger.envelope,
      "A/B receive the same immutable envelope object",
    );
    assert(Object.isFrozen(baseline.envelope));
    assert(Object.isFrozen(baseline.envelope.header));
    assert.throws(
      () => {
        (baseline.envelope.header as { hash: string }).hash = blockHash(999);
      },
      TypeError,
    );
    const commonSemantics = {
      orderedOutput: [`head-${entry.number}`, entry.hash],
      terminal: index % 2 === 0 ? "candidate" : "no_candidate",
    };
    const terminal = index % 2 === 0
      ? candidateTerminal(commonSemantics)
      : noCandidateTerminal(commonSemantics);
    recordTerminal(context, broker, "baseline", entry, terminal);
    recordTerminal(
      context,
      broker,
      "challenger",
      entry,
      {
        ...terminal,
        additions: index === 0
          ? [{ id: "approved-family", semantics: { emittedEdges: 2 } }]
          : [],
      },
    );
  }

  const journal = auditor.journal.seal();
  assert.equal(journal.entryCount, 4);
  context.clock.set(1_500);
  assert.throws(
    () => context.headerSource.emit({
      number: 102,
      hash: blockHash(2_102),
      parentHash: blockHash(1_101),
      sourceGeneration: 2,
    }),
    /journal is sealed/,
  );
  const brokerSeal = broker.seal();
  assert.equal(brokerSeal.deliveryReceipts.length, 8);
  assert.equal(brokerSeal.ackReceipts.length, 8);
  assert.equal(brokerSeal.terminalReceipts.length, 8);
  assert(
    brokerSeal.terminalReceipts.every((receipt) => {
      const entry = entries.find(
        (candidate) =>
          candidate.entrySha256 === receipt.journalEntrySha256,
      );
      return entry &&
        receipt.completedAtMs >= entry.observedAtMs + 100;
    }),
    "terminal timing comes from the broker's trusted clock",
  );

  const finalHeaders: FinalCanonicalHeader[] = [
    {
      number: 100,
      hash: blockHash(100),
      parentHash: blockHash(99),
    },
    {
      number: 101,
      hash: blockHash(1_101),
      parentHash: blockHash(100),
    },
    {
      number: 102,
      hash: blockHash(1_102),
      parentHash: blockHash(1_101),
    },
  ];
  const reconciliation = reconcile(context, journal, finalHeaders);
  assert.equal(reconciliation.status, "valid");
  assert.deepEqual(
    reconciliation.orphanOrReplacementEntrySha256s,
    [h101Orphan.entrySha256],
    "orphaned generations stay in the denominator",
  );
  assert.equal(reconciliation.denominatorEntrySha256s.length, 4);
  const report = buildPairedLiveReport({
    rule,
    journal,
    reconciliation,
    broker: brokerSeal,
  });
  assert.equal(report.denominator.eligibleHeads, 4);
  assert.equal(report.baseline.headCoverage, 1);
  assert.equal(report.challenger.headCoverage, 1);
  assert.equal(report.baseline.terminalLatencyMs.sampleCount, 4);
  assert.equal(report.challenger.terminalLatencyMs.sampleCount, 4);
  assert.equal(report.exactSemantics.status, "pass");
  assert.equal(report.exactSemantics.comparedHeads, 4);
  assert.equal(report.exactSemantics.challengerAdditions["approved-family"], 1);
  assert.equal(report.verdict, "pass");
  assert.equal(report.pairedLivePass, true);
  assert.equal(report.mergeReady, false);
  assert.equal(
    report.mergeReadinessReason,
    "requires_independent_six_stage_evidence",
  );
  assert.match(report.reportSha256, /^[0-9a-f]{64}$/);
  const tamperedJournal = {
    ...journal,
    entryCount: journal.entryCount - 1,
  } as EligibleHeadJournalSeal;
  assert.throws(
    () => buildPairedLiveReport({
      rule,
      journal: tamperedJournal,
      reconciliation,
      broker: brokerSeal,
    }),
    /entry count mismatch/,
    "a stale journal seal cannot shrink the denominator",
  );
  const tamperedBroker = {
    ...brokerSeal,
    terminalReceipts: brokerSeal.terminalReceipts.map(
      (receipt, index) =>
        index === 0
          ? { ...receipt, completedAtMs: receipt.completedAtMs + 1 }
          : receipt,
    ),
  } as typeof brokerSeal;
  assert.throws(
    () => buildPairedLiveReport({
      rule,
      journal,
      reconciliation,
      broker: tamperedBroker,
    }),
    /bound semantic extractor|terminal receipt hash mismatch/,
    "stale receipt hashes cannot fabricate timing",
  );
  const tamperedReconciliation = {
    ...reconciliation,
    status: "invalid",
  } as typeof reconciliation;
  assert.throws(
    () => buildPairedLiveReport({
      rule,
      journal,
      reconciliation: tamperedReconciliation,
      broker: brokerSeal,
    }),
    /reconciliation hash mismatch/,
    "reconciliation status cannot be changed after sealing",
  );

  const incompleteCanonical = reconcile(
    context,
    journal,
    finalHeaders.slice(0, 2),
  );
  assert.equal(incompleteCanonical.status, "invalid");
  const invalidReport = buildPairedLiveReport({
    rule,
    journal,
    reconciliation: incompleteCanonical,
    broker: brokerSeal,
  });
  assert.equal(invalidReport.verdict, "invalid");
  assert.equal(invalidReport.pairedLivePass, false);
  assert.equal(invalidReport.mergeReady, false);
}

function testFixedDenominatorFailureAccounting(): void {
  const first = 200;
  const last = 205;
  const context = makeContext(first, last, 10_000);
  const { rule } = context;
  const auditor = makeAuditor(context);
  const entries = observeLinear(context, auditor, first, last, 10_100);
  const broker = new ImmutablePairedLiveDeliveryBroker(
    rule,
    auditor.journal,
    context.semanticExtractor,
  );
  for (const entry of entries) {
    deliverAndAcknowledge(context, broker, "baseline", entry);
    recordTerminal(
      context,
      broker,
      "baseline",
      entry,
      noCandidateTerminal({ state: "same" }),
    );
  }

  // Head 0: no delivery receipt.
  // Head 1: delivery but no acknowledgement receipt.
  context.clock.set(entries[1]!.observedAtMs + 3);
  broker.deliver("challenger", entries[1]!.entrySha256);
  // Head 2: delivery+ack but missing terminal.
  deliverAndAcknowledge(context, broker, "challenger", entries[2]!);
  // Heads 3..5: explicit busy/timeout/incomplete terminals.
  for (const [offset, failure] of [
    [3, { type: "skipped_busy", category: "busy" }],
    [4, { type: "timeout", category: "pipeline_timeout" }],
    [5, { type: "incomplete", category: "state_incomplete" }],
  ] as const) {
    const entry = entries[offset]!;
    deliverAndAcknowledge(context, broker, "challenger", entry);
    recordTerminal(
      context,
      broker,
      "challenger",
      entry,
      {
        type: failure.type,
        failureCategory: failure.category,
        telemetry: telemetry(),
      },
    );
  }

  const journal = auditor.journal.seal();
  const brokerSeal = broker.seal();
  const reconciliation = reconcile(
    context,
    journal,
    finalHeadersFor(entries),
  );
  const report = buildPairedLiveReport({
    rule,
    journal,
    reconciliation,
    broker: brokerSeal,
  });
  assert.equal(report.denominator.eligibleHeads, 6);
  assert.equal(report.challenger.headResults.length, 6);
  assert.equal(report.challenger.onTimeTerminalHeads, 0);
  assert.equal(report.challenger.headCoverage, 0);
  assert.deepEqual(report.challenger.failureCategories, {
    incomplete: 1,
    missing_ack_receipt: 1,
    missing_delivery_receipt: 1,
    missing_terminal: 1,
    skipped_busy: 1,
    timeout: 1,
  });
  assert.equal(report.challenger.terminalLatencyMs.sampleCount, 6);
  assert.equal(
    report.challenger.terminalLatencyMs.p95,
    PAIRED_LIVE_TERMINAL_DEADLINE_MS,
  );
  assert.equal(report.challenger.terminalLatencyMs.timingPass, false);
  assert(
    report.challenger.headResults.every(
      (result) =>
        result.accountedLatencyMs >= PAIRED_LIVE_TERMINAL_DEADLINE_MS,
    ),
  );
  assert.equal(report.floors.baselineAbsolutePass, true);
  assert.equal(report.floors.challengerAbsolutePass, false);
  assert.equal(report.floors.challengerRelativeHeadCoveragePass, false);
  assert.equal(report.verdict, "fail");
}

function testExactNinetyFivePercentBoundary(): void {
  const first = 300;
  const last = 319;
  const context = makeContext(first, last, 20_000);
  const { rule } = context;
  const auditor = makeAuditor(context);
  const entries = observeLinear(context, auditor, first, last, 20_100);
  const broker = new ImmutablePairedLiveDeliveryBroker(
    rule,
    auditor.journal,
    context.semanticExtractor,
  );
  for (const [index, entry] of entries.entries()) {
    const semantics = { candidateSet: [entry.number], rank: index + 1 };
    deliverAndAcknowledge(context, broker, "baseline", entry);
    recordTerminal(
      context,
      broker,
      "baseline",
      entry,
      candidateTerminal(semantics),
    );
    if (index === entries.length - 1) continue;
    deliverAndAcknowledge(context, broker, "challenger", entry);
    recordTerminal(
      context,
      broker,
      "challenger",
      entry,
      candidateTerminal(semantics),
    );
  }
  const journal = auditor.journal.seal();
  const brokerSeal = broker.seal();
  const reconciliation = reconcile(
    context,
    journal,
    finalHeadersFor(entries),
  );
  const report = buildPairedLiveReport({
    rule,
    journal,
    reconciliation,
    broker: brokerSeal,
  });
  assert.equal(report.baseline.headCoverage, 1);
  assert.equal(report.challenger.headCoverage, 0.95);
  assert.equal(report.challenger.terminalLatencyMs.sampleCount, 20);
  assert.equal(report.challenger.terminalLatencyMs.p95, 1_900);
  assert.equal(report.challenger.terminalLatencyMs.timingPass, true);
  assert.equal(report.floors.challengerAbsolutePass, true);
  assert.equal(report.floors.challengerRelativeHeadCoveragePass, true);
  assert.equal(report.floors.completedHeads95Pass, true);
  assert.equal(report.floors.baselineCandidateHeads, 20);
  assert.equal(report.floors.reproducedBaselineCandidateHeads, 19);
  assert.equal(report.floors.candidateCoverage, 0.95);
  assert.equal(report.floors.candidateCoverage95Pass, true);
  assert.equal(report.floors.throughput95Pass, true);
  assert.equal(report.verdict, "pass");
  assert.equal(report.pairedLivePass, true);
  assert.equal(report.mergeReady, false);
}

function testCandidateCoverageUsesHeadOverlap(): void {
  const first = 350;
  const last = 369;
  const context = makeContext(first, last, 25_000);
  const { rule } = context;
  const auditor = makeAuditor(context);
  const entries = observeLinear(context, auditor, first, last, 25_100);
  const broker = new ImmutablePairedLiveDeliveryBroker(
    rule,
    auditor.journal,
    context.semanticExtractor,
  );
  for (const [index, entry] of entries.entries()) {
    if (index !== 0) {
      deliverAndAcknowledge(context, broker, "baseline", entry);
      recordTerminal(
        context,
        broker,
        "baseline",
        entry,
        index === 1
          ? candidateTerminal({ candidateHead: entry.number })
          : noCandidateTerminal({ commonHead: entry.number }),
      );
    }
    if (index !== 1) {
      deliverAndAcknowledge(context, broker, "challenger", entry);
      recordTerminal(
        context,
        broker,
        "challenger",
        entry,
        index === 0
          ? candidateTerminal({ candidateHead: entry.number })
          : noCandidateTerminal({ commonHead: entry.number }),
      );
    }
  }
  const journal = auditor.journal.seal();
  const brokerSeal = broker.seal();
  const reconciliation = reconcile(
    context,
    journal,
    finalHeadersFor(entries),
  );
  const report = buildPairedLiveReport({
    rule,
    journal,
    reconciliation,
    broker: brokerSeal,
  });
  assert.equal(report.baseline.headCoverage, 0.95);
  assert.equal(report.challenger.headCoverage, 0.95);
  assert.equal(report.baseline.candidateHeads, 1);
  assert.equal(report.challenger.candidateHeads, 1);
  assert.equal(report.exactSemantics.status, "pass");
  assert.equal(report.floors.baselineCandidateHeads, 1);
  assert.equal(report.floors.reproducedBaselineCandidateHeads, 0);
  assert.equal(report.floors.candidateCoverage, 0);
  assert.equal(report.floors.candidateCoverage95Pass, false);
  assert.equal(report.verdict, "fail");
}

function testExactSemanticMismatch(): void {
  const context = makeContext(400, 400, 30_000);
  const { rule } = context;
  const auditor = makeAuditor(context);
  const [entry] = observeLinear(context, auditor, 400, 400, 30_100);
  const broker = new ImmutablePairedLiveDeliveryBroker(
    rule,
    auditor.journal,
    context.semanticExtractor,
  );
  deliverAndAcknowledge(context, broker, "baseline", entry!);
  deliverAndAcknowledge(context, broker, "challenger", entry!);
  recordTerminal(
    context,
    broker,
    "baseline",
    entry!,
    candidateTerminal({ orderedEdges: ["common-a"] }),
  );
  recordTerminal(
    context,
    broker,
    "challenger",
    entry!,
    candidateTerminal({ orderedEdges: ["common-b"] }),
  );
  const journal = auditor.journal.seal();
  const brokerSeal = broker.seal();
  const reconciliation = reconcile(
    context,
    journal,
    finalHeadersFor([entry!]),
  );
  const report = buildPairedLiveReport({
    rule,
    journal,
    reconciliation,
    broker: brokerSeal,
  });
  assert.equal(report.baseline.headCoverage, 1);
  assert.equal(report.challenger.headCoverage, 1);
  assert.equal(report.exactSemantics.status, "fail");
  assert.deepEqual(
    report.exactSemantics.mismatchEntrySha256s,
    [entry!.entrySha256],
  );
  assert.equal(report.verdict, "fail");
  assert.equal(report.pairedLivePass, false);
  assert.equal(report.mergeReady, false);
}

function testRepeatedChallengerOnlyFailureFails(): void {
  const first = 500;
  const last = 539;
  const context = makeContext(first, last, 40_000);
  const { rule } = context;
  const auditor = makeAuditor(context);
  const entries = observeLinear(context, auditor, first, last, 40_100);
  const broker = new ImmutablePairedLiveDeliveryBroker(
    rule,
    auditor.journal,
    context.semanticExtractor,
  );
  for (const [index, entry] of entries.entries()) {
    deliverAndAcknowledge(context, broker, "baseline", entry);
    recordTerminal(
      context,
      broker,
      "baseline",
      entry,
      noCandidateTerminal({ state: entry.number }),
    );
    deliverAndAcknowledge(context, broker, "challenger", entry);
    if (index >= entries.length - 2) {
      recordTerminal(
        context,
        broker,
        "challenger",
        entry,
        {
          type: "skipped_busy",
          failureCategory: `producer-label-${index}`,
          telemetry: telemetry(),
        },
      );
    } else {
      recordTerminal(
        context,
        broker,
        "challenger",
        entry,
        noCandidateTerminal({ state: entry.number }),
      );
    }
  }
  const journal = auditor.journal.seal();
  const brokerSeal = broker.seal();
  const reconciliation = reconcile(
    context,
    journal,
    finalHeadersFor(entries),
  );
  const report = buildPairedLiveReport({
    rule,
    journal,
    reconciliation,
    broker: brokerSeal,
  });
  assert.equal(report.challenger.headCoverage, 0.95);
  assert.equal(report.challenger.terminalLatencyMs.timingPass, true);
  assert.deepEqual(
    report.challengerOnlyRepeatedFailureCategories,
    ["skipped_busy"],
    "producer labels cannot split a systemic canonical failure",
  );
  assert.equal(report.verdict, "fail");
  assert.equal(report.pairedLivePass, false);
}

interface TestContext {
  readonly rule: FrozenPairedLiveEligibilityRule;
  readonly clock: FakeTrustedClock;
  readonly headerSource: FakeCanonicalHeaderSource;
  readonly semanticExtractor: FakeSemanticExtractor;
}

class FakeTrustedClock implements PairedLiveTrustedClock {
  constructor(
    readonly identitySha256: string,
    private currentMs: number,
  ) {}

  nowMs(): number {
    return this.currentMs;
  }

  set(nowMs: number): void {
    this.currentMs = nowMs;
  }
}

class FakeCanonicalHeaderSource
  implements PairedLiveCanonicalHeaderSubscription {
  private readonly listeners =
    new Set<(header: PairedLiveSourceHeader) => void>();

  constructor(readonly identitySha256: string) {}

  subscribe(listener: (header: PairedLiveSourceHeader) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(header: PairedLiveSourceHeader): void {
    for (const listener of this.listeners) listener(header);
  }
}

class FakeFinalCanonicalSource implements PairedLiveFinalCanonicalSource {
  constructor(
    readonly identitySha256: string,
    private readonly headers: readonly FinalCanonicalHeader[],
  ) {}

  enumerateFinalCanonicalHeaders(): readonly FinalCanonicalHeader[] {
    return this.headers;
  }
}

class FakeSemanticExtractor implements PairedLiveSemanticExtractor {
  constructor(readonly identitySha256: string) {}

  extract(input: Readonly<{
    side: PairedLiveSide;
    rawOutput: unknown;
  }>): PairedLiveTerminalInput {
    assert(
      input.rawOutput &&
        typeof input.rawOutput === "object" &&
        "productionTerminal" in input.rawOutput,
      "test raw production output has no terminal",
    );
    return (
      input.rawOutput as {
        readonly productionTerminal: PairedLiveTerminalInput;
      }
    ).productionTerminal;
  }
}

function ruleInput(
  first: number,
  last: number,
  opensAtMs: number,
  approvedAdditionIds: readonly string[],
): PairedLiveEligibilityRuleInput {
  return {
    schemaVersion: PAIRED_LIVE_SCHEMA_VERSION,
    experimentId: `paired-live-${first}-${last}`,
    blockRange: { first, last },
    observationWindow: {
      opensAtMs,
      closesAtMs: opensAtMs + 60_000,
    },
    warmupThroughBlock: first - 2,
    catchUpThroughBlock: first - 1,
    sourceKind: "local-canonical",
    reorgPolicy: "include-all-observed-generations",
    terminalDeadlineMs: PAIRED_LIVE_TERMINAL_DEADLINE_MS,
    absoluteHeadCoverageFloor: PAIRED_LIVE_COVERAGE_FLOOR,
    relativeHeadCoverageFloor: PAIRED_LIVE_COVERAGE_FLOOR,
    systemicFailureRepeatThreshold: 2,
    trustedClockIdentitySha256: hash(`clock-${first}`),
    headerAuditorSourceIdentitySha256: hash(`header-source-${first}`),
    reconciliationSourceIdentitySha256: hash(`final-source-${first}`),
    sharedInputs: {
      resolvedConfigSha256: hash(`config-${first}`),
      universeSha256: hash(`universe-${first}`),
      backendIdentitySha256: hash(`backend-${first}`),
      evPolicySha256: hash(`ev-${first}`),
      submissionPolicySha256: hash(`submission-${first}`),
      semanticExtractorSha256: hash(`semantic-extractor-${first}`),
    },
    approvedAdditionIds,
  };
}

function makeContext(
  first: number,
  last: number,
  opensAtMs: number,
  approvedAdditionIds: readonly string[] = [],
): TestContext {
  const input = ruleInput(first, last, opensAtMs, approvedAdditionIds);
  const clock = new FakeTrustedClock(
    input.trustedClockIdentitySha256,
    opensAtMs - 1,
  );
  const rule = freezePairedLiveEligibilityRule(input, clock);
  const headerSource = new FakeCanonicalHeaderSource(
    rule.headerAuditorSourceIdentitySha256,
  );
  const semanticExtractor = new FakeSemanticExtractor(
    rule.sharedInputs.semanticExtractorSha256,
  );
  return { rule, clock, headerSource, semanticExtractor };
}

function makeAuditor(context: TestContext): TrustedPairedLiveHeaderAuditor {
  return new TrustedPairedLiveHeaderAuditor(
    context.rule,
    context.headerSource,
    context.clock,
  );
}

function captureHeader(
  context: TestContext,
  auditor: TrustedPairedLiveHeaderAuditor,
  header: PairedLiveSourceHeader,
  observedAtMs: number,
): HeaderAuditResult {
  const priorCount = auditor.auditResults().length;
  context.clock.set(observedAtMs);
  context.headerSource.emit(header);
  const result = auditor.auditResults()[priorCount];
  assert(result, "trusted source emission did not produce an audit result");
  return result;
}

function observeLinear(
  context: TestContext,
  auditor: TrustedPairedLiveHeaderAuditor,
  first: number,
  last: number,
  firstObservedAtMs: number,
): EligibleHeadJournalEntry[] {
  const entries: EligibleHeadJournalEntry[] = [];
  for (let number = first; number <= last; number++) {
    entries.push(requiredEligible(captureHeader(
      context,
      auditor,
      {
        number,
        hash: blockHash(number),
        parentHash: blockHash(number - 1),
        sourceGeneration: 0,
      },
      firstObservedAtMs + (number - first) * 100,
    )));
  }
  return entries;
}

function reconcile(
  context: TestContext,
  journal: EligibleHeadJournalSeal,
  headers: readonly FinalCanonicalHeader[],
) {
  context.clock.set(context.rule.observationWindow.closesAtMs);
  return reconcilePairedLiveCanonicalHeaders({
    rule: context.rule,
    journal,
    source: new FakeFinalCanonicalSource(
      context.rule.reconciliationSourceIdentitySha256,
      headers,
    ),
    clock: context.clock,
  });
}

function deliverAndAcknowledge(
  context: TestContext,
  broker: ImmutablePairedLiveDeliveryBroker,
  side: PairedLiveSide,
  entry: EligibleHeadJournalEntry,
): ReturnType<ImmutablePairedLiveDeliveryBroker["deliver"]> {
  const sideOffset = side === "baseline" ? 1 : 3;
  context.clock.set(entry.observedAtMs + sideOffset);
  const delivery = broker.deliver(
    side,
    entry.entrySha256,
  );
  context.clock.set(entry.observedAtMs + sideOffset + 1);
  const ack = broker.acknowledge({
    side,
    journalEntrySha256: entry.entrySha256,
    envelopeSha256: delivery.envelope.envelopeSha256,
    runtimeSharedInputs: broker.rule.sharedInputs,
  });
  assert.equal(ack.deliveryReceiptSha256, delivery.receipt.receiptSha256);
  assert.equal(
    ack.runtimeSharedInputSha256,
    blindProductionAuditHash(broker.rule.sharedInputs),
  );
  return delivery;
}

function recordTerminal(
  context: TestContext,
  broker: ImmutablePairedLiveDeliveryBroker,
  side: PairedLiveSide,
  entry: EligibleHeadJournalEntry,
  terminal: PairedLiveTerminalInput,
  latencyMs = 100,
): void {
  context.clock.set(entry.observedAtMs + latencyMs);
  broker.recordTerminal(side, entry.entrySha256, {
    producerClaimedCompletedAtMs: 0,
    productionTerminal: terminal,
  });
}

function noCandidateTerminal(
  commonSemantics: unknown,
): Extract<PairedLiveTerminalInput, { readonly type: "scanner_done" }> {
  return {
    type: "scanner_done",
    outcome: "no_candidate",
    commonSemantics,
    additions: [],
    telemetry: telemetry(),
  };
}

function candidateTerminal(
  commonSemantics: unknown,
): Extract<PairedLiveTerminalInput, { readonly type: "ev_decision" }> {
  return {
    type: "ev_decision",
    outcome: "candidate",
    commonSemantics,
    additions: [],
    telemetry: telemetry(),
  };
}

function telemetry(): {
  readonly calls: number;
  readonly batches: number;
  readonly familyCounts: Readonly<Record<string, number>>;
} {
  return {
    calls: 4,
    batches: 2,
    familyCounts: {
      "family-a": 2,
      "family-b": 1,
    },
  };
}

function finalHeadersFor(
  entries: readonly EligibleHeadJournalEntry[],
): FinalCanonicalHeader[] {
  return entries.map((entry) => ({
    number: entry.number,
    hash: entry.hash,
    parentHash: entry.parentHash,
  }));
}

function requiredEligible(
  result: HeaderAuditResult,
): EligibleHeadJournalEntry {
  assert.equal(result.eligible, true);
  return result.entry;
}

function blockHash(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function hash(value: string): string {
  return blindProductionAuditHash(value);
}

testFrozenRuleAndReorgJournal();
testFixedDenominatorFailureAccounting();
testExactNinetyFivePercentBoundary();
testCandidateCoverageUsesHeadOverlap();
testExactSemanticMismatch();
testRepeatedChallengerOnlyFailureFails();

console.log("adapter family paired live trusted primitive: ok");
