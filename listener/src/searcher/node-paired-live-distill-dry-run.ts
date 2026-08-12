import {
  evaluateSystemicLiveFromReport,
} from "./systemic-live-gate.js";
import type {
  PairedLiveReport,
} from "./adapter-family-paired-live.js";

/**
 * Node dry-run for the systemic-live decision chain (distiller + gate) over
 * a fixture paired-live report. It never runs a live window: the runner
 * instrumentation that produces a trusted report from real baseline +
 * challenger processes is the next slice. Output is a machine-readable
 * record with the gate verdict.
 */

function sideReport() {
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

function fixtureReport(): PairedLiveReport {
  return Object.freeze({
    schemaVersion: 1,
    experimentId: "s1-node-distill-dry-run",
    eligibilityRuleSha256: "1".repeat(64),
    journalSha256: "2".repeat(64),
    reconciliationSha256: "3".repeat(64),
    receiptSetSha256: "4".repeat(64),
    denominator: Object.freeze({
      eligibleHeads: 1,
      entrySha256s: Object.freeze(["5".repeat(64)]),
    }),
    canonicalReconciliationStatus: "valid",
    baseline: sideReport(),
    challenger: sideReport(),
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
  }) as PairedLiveReport;
}

function main(): void {
  const report = fixtureReport();
  const verdict = evaluateSystemicLiveFromReport(report);
  console.log(JSON.stringify({
    format: "s1-node-paired-live-distill-dry-run-v1",
    status: "pass",
    reportSha256: report.reportSha256,
    gateVerdict: verdict.status,
    gateReasons: verdict.reasons,
  }, null, 2));
  if (verdict.status !== "pass") {
    throw new Error(`gate did not pass: ${verdict.reasons.join("; ")}`);
  }
}

main();
