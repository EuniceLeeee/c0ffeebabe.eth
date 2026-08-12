import assert from "node:assert/strict";
import {
  distillSystemicLiveGateInput,
  evaluateSystemicLiveGate,
  evaluateSystemicLiveFromReport,
  type SystemicLiveGateInput,
} from "../systemic-live-gate.js";
import type {
  PairedLiveReport,
} from "../adapter-family-paired-live.js";

function input(overrides: Partial<SystemicLiveGateInput> = {}): SystemicLiveGateInput {
  return Object.freeze({
    pairedLiveVerdict: "pass",
    exactSemanticsStatus: "pass",
    challengerOnlyRepeatedFailureCategories: Object.freeze([]),
    baselineAbsoluteHeadCoveragePass: true,
    challengerAbsoluteHeadCoveragePass: true,
    challengerRelativeHeadCoveragePass: true,
    completedHeadsPass: true,
    candidateOverlapPass: true,
    throughputPass: true,
    baselineTimingPass: true,
    challengerTimingPass: true,
    ...overrides,
  });
}

function sideReportFixture() {
  return Object.freeze({
    eligibleHeads: 1,
    onTimeTerminalHeads: 1,
    noCandidateHeads: 0,
    candidateHeads: 1,
    headCoverage: 1,
    throughputHeadsPerSecond: 1,
    terminalLatencyMs: Object.freeze({
      sampleCount: 1,
      p50: 1,
      p95: 1,
      timingPass: true,
    }),
    failureCategories: Object.freeze({}),
    calls: 1,
    batches: 1,
    familyDistribution: Object.freeze({}),
    headResults: Object.freeze([]),
  });
}

function reportFixture(
  overrides: Partial<PairedLiveReport> = {},
): PairedLiveReport {
  return Object.freeze({
    schemaVersion: 1,
    experimentId: "fixture",
    eligibilityRuleSha256: "1".repeat(64),
    journalSha256: "2".repeat(64),
    reconciliationSha256: "3".repeat(64),
    receiptSetSha256: "4".repeat(64),
    denominator: Object.freeze({
      eligibleHeads: 1,
      entrySha256s: Object.freeze(["5".repeat(64)]),
    }),
    canonicalReconciliationStatus: "valid",
    baseline: sideReportFixture(),
    challenger: sideReportFixture(),
    exactSemantics: Object.freeze({
      status: "pass",
      comparedHeads: 1,
      mismatchEntrySha256s: Object.freeze([]),
      additionViolations: Object.freeze([]),
      challengerAdditions: Object.freeze({}),
    }),
    floors: Object.freeze({
      absoluteFloor: 0.95,
      baselineAbsolutePass: true,
      challengerAbsolutePass: true,
      baselineTimingPass: true,
      challengerTimingPass: true,
      relativeFloor: 0.95,
      requiredChallengerHeadCoverage: 0.95,
      challengerRelativeHeadCoveragePass: true,
      completedHeads95Pass: true,
      baselineCandidateHeads: 1,
      reproducedBaselineCandidateHeads: 1,
      candidateCoverage: 1,
      candidateCoverage95Pass: true,
      throughput95Pass: true,
    }),
    challengerOnlyRepeatedFailureCategories: Object.freeze([]),
    verdict: "pass",
    pairedLivePass: true,
    mergeReady: false,
    mergeReadinessReason:
      "requires_independent_six_stage_evidence",
    reportSha256: "6".repeat(64),
    ...overrides,
  }) as PairedLiveReport;
}

function main(): void {
  const pass = evaluateSystemicLiveGate(input());
  assert.deepEqual(pass, { status: "pass", reasons: [] });
  assert(Object.isFrozen(pass));
  assert(Object.isFrozen(pass.reasons));

  const verdictFail = evaluateSystemicLiveGate(input({
    pairedLiveVerdict: "fail",
  }));
  assert.equal(verdictFail.status, "not-pass");
  assert(verdictFail.reasons.some((reason) =>
    reason.includes("paired-live verdict")
  ));

  const semanticFail = evaluateSystemicLiveGate(input({
    exactSemanticsStatus: "fail",
  }));
  assert.equal(semanticFail.status, "not-pass");
  assert(semanticFail.reasons.some((reason) =>
    reason.includes("exact semantics")
  ));

  const repeated = evaluateSystemicLiveGate(input({
    challengerOnlyRepeatedFailureCategories: ["queue-exhaustion"],
  }));
  assert.equal(repeated.status, "not-pass");
  assert(repeated.reasons.some((reason) =>
    reason.includes("challenger-only repeated")
  ));

  for (const [key, label] of [
    ["baselineAbsoluteHeadCoveragePass", "baseline absolute"],
    ["challengerAbsoluteHeadCoveragePass", "challenger absolute"],
    ["challengerRelativeHeadCoveragePass", "challenger relative"],
    ["completedHeadsPass", "completed-heads"],
    ["candidateOverlapPass", "candidate overlap"],
    ["throughputPass", "throughput"],
    ["baselineTimingPass", "baseline terminal-latency"],
    ["challengerTimingPass", "challenger terminal-latency"],
  ] as const) {
    const failed = evaluateSystemicLiveGate(input({
      [key]: false,
    } as Partial<SystemicLiveGateInput>));
    assert.equal(failed.status, "not-pass");
    assert(failed.reasons.some((reason) => reason.includes(label)));
  }

  const all = evaluateSystemicLiveGate(input({
    pairedLiveVerdict: "invalid",
    exactSemanticsStatus: "n/a",
    challengerOnlyRepeatedFailureCategories: ["a", "b"],
    baselineAbsoluteHeadCoveragePass: false,
    challengerAbsoluteHeadCoveragePass: false,
    challengerRelativeHeadCoveragePass: false,
    completedHeadsPass: false,
    candidateOverlapPass: false,
    throughputPass: false,
    baselineTimingPass: false,
    challengerTimingPass: false,
  }));
  assert.equal(all.status, "not-pass");
  assert.equal(all.reasons.length, 11);

  const distilled = distillSystemicLiveGateInput(reportFixture());
  assert.deepEqual(evaluateSystemicLiveGate(distilled), {
    status: "pass",
    reasons: [],
  });
  assert.deepEqual(evaluateSystemicLiveFromReport(reportFixture()), {
    status: "pass",
    reasons: [],
  });
  const failingReport = evaluateSystemicLiveFromReport(reportFixture({
    verdict: "fail",
    pairedLivePass: false,
    floors: Object.freeze({
      ...reportFixture().floors,
      challengerAbsolutePass: false,
    }),
  }));
  assert.equal(failingReport.status, "not-pass");
  assert(failingReport.reasons.some((reason) =>
    reason.includes("paired-live verdict")
  ));
  assert(failingReport.reasons.some((reason) =>
    reason.includes("challenger absolute head coverage")
  ));
  console.log("systemic-live gate PASS");
}

main();
