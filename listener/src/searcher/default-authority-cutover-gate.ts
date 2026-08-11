/**
 * Default-authority cutover gate contract (§18.3.6, §16). The gate never
 * switches authority; it only evaluates whether the production default
 * path may become the strict catalog authority. It fails closed when the
 * strict consumer is inactive, when the legacy registry would remain
 * co-active (dual-authority is forbidden), or when any prerequisite gate
 * (batch parity, held-out negatives, systemic-live) is not pass.
 */
export interface DefaultAuthorityCutoverGateInput {
  readonly strictConsumerActive: boolean;
  readonly legacyAuthorityActive: boolean;
  readonly batchParityPass: boolean;
  readonly heldOutNegativesPass: boolean;
  readonly systemicLiveGatePass: boolean;
}

export type DefaultAuthorityCutoverVerdict =
  | {
      readonly status: "not-eligible";
      readonly reasons: readonly string[];
    }
  | {
      readonly status: "ready";
      readonly reasons: readonly string[];
    };

export function evaluateDefaultAuthorityCutoverGate(
  input: DefaultAuthorityCutoverGateInput,
): DefaultAuthorityCutoverVerdict {
  const reasons: string[] = [];
  if (!input.strictConsumerActive) {
    reasons.push("strict catalog consumer is not the active production path");
  }
  if (input.legacyAuthorityActive) {
    reasons.push(
      "legacy registry remains the production authority (dual authority " +
        "is forbidden)",
    );
  }
  if (!input.batchParityPass) {
    reasons.push("22-family batch parity receipt is not pass");
  }
  if (!input.heldOutNegativesPass) {
    reasons.push("held-out negative fixtures did not all mismatch");
  }
  if (!input.systemicLiveGatePass) {
    reasons.push("systemic-live gate is not pass");
  }
  return reasons.length === 0
    ? Object.freeze({ status: "ready" as const, reasons: Object.freeze([]) })
    : Object.freeze({
        status: "not-eligible" as const,
        reasons: Object.freeze(reasons),
      });
}
