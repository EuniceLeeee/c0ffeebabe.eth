import assert from "node:assert/strict";
import {
  deriveSerialSideEvidence,
  deriveSerialSystemicLiveGateInput,
  evaluateSystemicLiveFromSerialEvidence,
} from "../serial-systemic-live-evidence.js";

function headLine(input: {
  readonly block: number;
  readonly fullCoverage?: boolean;
  readonly outcome?: string;
  readonly totalMs?: number;
}): string {
  return JSON.stringify({
    type: "block_scan_result",
    source_block: input.block,
    full_coverage: input.fullCoverage ?? true,
    outcome: input.outcome ?? "completed",
    total_ms: input.totalMs ?? 1_000,
  });
}

function main(): void {
  const baselineLines = Array.from({ length: 20 }, (_, index) =>
    headLine({ block: 100 + index })
  );
  const challengerLines = Array.from({ length: 20 }, (_, index) =>
    headLine({ block: 200 + index, totalMs: 1_040 })
  );
  const baseline = deriveSerialSideEvidence({
    sha: "baseline",
    eventsLines: baselineLines,
    windowSeconds: 600,
  });
  const challenger = deriveSerialSideEvidence({
    sha: "challenger",
    eventsLines: challengerLines,
    windowSeconds: 600,
  });
  assert.equal(baseline.eligibleHeads, 20);
  assert.equal(baseline.fullCoverageHeads, 20);
  assert.equal(baseline.completedHeads, 20);
  assert.equal(baseline.p95TotalMs, 1_000);
  assert.equal(challenger.p95TotalMs, 1_040);

  const gateInput = deriveSerialSystemicLiveGateInput({
    baseline,
    challenger,
  });
  assert.equal(gateInput.pairedLiveVerdict, "relative_diagnostic_only");
  assert.equal(gateInput.baselineAbsoluteHeadCoveragePass, true);
  assert.equal(gateInput.challengerAbsoluteHeadCoveragePass, true);
  assert.equal(gateInput.challengerRelativeHeadCoveragePass, true);
  assert.equal(gateInput.completedHeadsPass, true);
  assert.equal(gateInput.candidateOverlapPass, true);
  assert.equal(gateInput.throughputPass, true);
  assert.equal(gateInput.baselineTimingPass, true);
  assert.equal(gateInput.challengerTimingPass, true);
  const verdict = evaluateSystemicLiveFromSerialEvidence({
    baseline,
    challenger,
  });
  assert.equal(verdict.status, "not-pass");
  assert(verdict.reasons.some((reason) =>
    reason.includes("relative_diagnostic_only")
  ), "serial evidence must never pass the gate alone");

  const lowCoverageChallenger = deriveSerialSideEvidence({
    sha: "challenger-low",
    eventsLines: Array.from({ length: 20 }, (_, index) =>
      headLine({
        block: 300 + index,
        fullCoverage: index >= 2,
      })
    ),
    windowSeconds: 600,
  });
  const lowInput = deriveSerialSystemicLiveGateInput({
    baseline,
    challenger: lowCoverageChallenger,
  });
  assert.equal(lowInput.challengerAbsoluteHeadCoveragePass, false);
  assert.equal(
    lowInput.challengerRelativeHeadCoveragePass,
    false,
  );
  console.log("serial-systemic-live-evidence PASS");
}

main();
