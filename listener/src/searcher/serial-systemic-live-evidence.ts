import {
  evaluateSystemicLiveGate,
  type SystemicLiveGateInput,
  type SystemicLiveGateVerdict,
} from "./systemic-live-gate.js";

/**
 * Serial (non-simultaneous) systemic-live evidence adapter. Parses each
 * side's events.jsonl `block_scan_result` rows into head-level coverage,
 * completion and timing metrics, then maps them onto the fail-closed gate
 * input. The paired-live verdict is honestly
 * `relative_diagnostic_only` because the sides did not run simultaneously;
 * the gate therefore never passes on serial evidence alone.
 */

export interface SerialSideEvidence {
  readonly sha: string;
  readonly eligibleHeads: number;
  readonly fullCoverageHeads: number;
  readonly completedHeads: number;
  readonly totalMsSamples: readonly number[];
  readonly p95TotalMs: number | null;
  readonly headsPerSecond: number | null;
}

export function deriveSerialSideEvidence(input: {
  readonly sha: string;
  readonly eventsLines: readonly string[];
  readonly windowSeconds: number;
}): SerialSideEvidence {
  const heads = new Map<number, {
    readonly fullCoverage: boolean;
    readonly completed: boolean;
    readonly totalMs: number;
  }>();
  for (const line of input.eventsLines) {
    if (!line.includes('"type":"block_scan_result"')) continue;
    let parsed: {
      readonly source_block?: number;
      readonly full_coverage?: boolean;
      readonly outcome?: string;
      readonly total_ms?: number;
    };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    const block = parsed.source_block;
    if (typeof block !== "number" || !Number.isSafeInteger(block)) continue;
    heads.set(block, {
      fullCoverage: parsed.full_coverage === true,
      completed: parsed.outcome !== "budget_exceeded" &&
        parsed.outcome !== "failed",
      totalMs: typeof parsed.total_ms === "number" ? parsed.total_ms : -1,
    });
  }
  const fullCoverageHeads = [...heads.values()].filter(
    (head) => head.fullCoverage,
  ).length;
  const completedHeads = [...heads.values()].filter(
    (head) => head.completed,
  ).length;
  const totalMsSamples = [...heads.values()]
    .filter((head) => head.totalMs >= 0)
    .map((head) => head.totalMs)
    .sort((left, right) => left - right);
  const p95TotalMs = totalMsSamples.length === 0
    ? null
    : totalMsSamples[
        Math.min(
          totalMsSamples.length - 1,
          Math.floor(totalMsSamples.length * 0.95),
        )
      ]!;
  return Object.freeze({
    sha: input.sha,
    eligibleHeads: heads.size,
    fullCoverageHeads,
    completedHeads,
    totalMsSamples: Object.freeze(totalMsSamples),
    p95TotalMs,
    headsPerSecond: input.windowSeconds > 0
      ? heads.size / input.windowSeconds
      : null,
  });
}

export function deriveSerialSystemicLiveGateInput(input: {
  readonly baseline: SerialSideEvidence;
  readonly challenger: SerialSideEvidence;
}): SystemicLiveGateInput {
  const coverageFloor = 0.95;
  const baselineCoverage = input.baseline.eligibleHeads === 0
    ? 0
    : input.baseline.fullCoverageHeads / input.baseline.eligibleHeads;
  const challengerCoverage = input.challenger.eligibleHeads === 0
    ? 0
    : input.challenger.fullCoverageHeads / input.challenger.eligibleHeads;
  const baselineCompleted = input.baseline.eligibleHeads === 0
    ? 0
    : input.baseline.completedHeads / input.baseline.eligibleHeads;
  const challengerCompleted = input.challenger.eligibleHeads === 0
    ? 0
    : input.challenger.completedHeads / input.challenger.eligibleHeads;
  const relative = (value: number, base: number): boolean =>
    base === 0 ? value === 0 : value >= base * 0.95;
  const baselineThroughput = input.baseline.headsPerSecond ?? 0;
  const challengerThroughput = input.challenger.headsPerSecond ?? 0;
  const baselineP95 = input.baseline.p95TotalMs ?? Number.POSITIVE_INFINITY;
  const challengerP95 = input.challenger.p95TotalMs ?? Number.POSITIVE_INFINITY;
  const timingFloor = 8_000;
  return Object.freeze({
    pairedLiveVerdict: "relative_diagnostic_only",
    exactSemanticsStatus: "n/a",
    challengerOnlyRepeatedFailureCategories: Object.freeze([]),
    baselineAbsoluteHeadCoveragePass: baselineCoverage >= coverageFloor,
    challengerAbsoluteHeadCoveragePass: challengerCoverage >= coverageFloor,
    challengerRelativeHeadCoveragePass: relative(
      challengerCoverage,
      baselineCoverage,
    ),
    completedHeadsPass:
      challengerCompleted >= coverageFloor &&
      relative(challengerCompleted, baselineCompleted),
    candidateOverlapPass: relative(
      challengerThroughput,
      baselineThroughput,
    ),
    throughputPass: relative(challengerThroughput, baselineThroughput),
    baselineTimingPass: baselineP95 <= timingFloor,
    challengerTimingPass: challengerP95 <= timingFloor &&
      challengerP95 <= baselineP95 * 1.05,
  });
}

export function evaluateSystemicLiveFromSerialEvidence(input: {
  readonly baseline: SerialSideEvidence;
  readonly challenger: SerialSideEvidence;
}): SystemicLiveGateVerdict {
  return evaluateSystemicLiveGate(
    deriveSerialSystemicLiveGateInput(input),
  );
}
