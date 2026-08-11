/**
 * Systemic-live gate contract (Phase D / §13-§14). Consumes the distilled
 * paired-live report verdict plus the independent coverage/timing gates and
 * fails closed unless the challenger matches or beats the baseline across
 * exact semantics, candidate overlap, head coverage, completion and
 * throughput. This gate never runs a live window itself; the paired-live
 * harness produces the evidence, and this gate is the authority decision.
 */
export interface SystemicLiveGateInput {
  readonly pairedLiveVerdict:
    | "pass"
    | "fail"
    | "invalid"
    | "relative_diagnostic_only";
  readonly exactSemanticsStatus: "pass" | "fail" | "n/a";
  readonly challengerOnlyRepeatedFailureCategories: readonly string[];
  readonly baselineAbsoluteHeadCoveragePass: boolean;
  readonly challengerAbsoluteHeadCoveragePass: boolean;
  readonly challengerRelativeHeadCoveragePass: boolean;
  readonly completedHeadsPass: boolean;
  readonly candidateOverlapPass: boolean;
  readonly throughputPass: boolean;
  readonly baselineTimingPass: boolean;
  readonly challengerTimingPass: boolean;
}

export type SystemicLiveGateVerdict =
  | {
      readonly status: "pass";
      readonly reasons: readonly string[];
    }
  | {
      readonly status: "not-pass";
      readonly reasons: readonly string[];
    };

export function evaluateSystemicLiveGate(
  input: SystemicLiveGateInput,
): SystemicLiveGateVerdict {
  const reasons: string[] = [];
  if (input.pairedLiveVerdict !== "pass") {
    reasons.push(`paired-live verdict is ${input.pairedLiveVerdict}`);
  }
  if (input.exactSemanticsStatus !== "pass") {
    reasons.push(`exact semantics status is ${input.exactSemanticsStatus}`);
  }
  if (input.challengerOnlyRepeatedFailureCategories.length > 0) {
    reasons.push(
      `challenger-only repeated failures: ` +
        input.challengerOnlyRepeatedFailureCategories.join(","),
    );
  }
  if (!input.baselineAbsoluteHeadCoveragePass) {
    reasons.push("baseline absolute head coverage did not pass");
  }
  if (!input.challengerAbsoluteHeadCoveragePass) {
    reasons.push("challenger absolute head coverage did not pass");
  }
  if (!input.challengerRelativeHeadCoveragePass) {
    reasons.push("challenger relative head coverage did not pass");
  }
  if (!input.completedHeadsPass) {
    reasons.push("challenger completed-heads 95% pass did not pass");
  }
  if (!input.candidateOverlapPass) {
    reasons.push("candidate overlap 95% pass did not pass");
  }
  if (!input.throughputPass) {
    reasons.push("throughput 95% pass did not pass");
  }
  if (!input.baselineTimingPass) {
    reasons.push("baseline terminal-latency timing did not pass");
  }
  if (!input.challengerTimingPass) {
    reasons.push("challenger terminal-latency timing did not pass");
  }
  return reasons.length === 0
    ? Object.freeze({ status: "pass" as const, reasons: Object.freeze([]) })
    : Object.freeze({
        status: "not-pass" as const,
        reasons: Object.freeze(reasons),
      });
}
