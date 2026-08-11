import type {
  ProductionFamilyStartupManifest,
} from "./production-family-startup-manifest.js";
import {
  EXPECTED_PRODUCTION_CAPABILITY_COUNT,
  EXPECTED_PRODUCTION_FAMILY_COUNT,
  productionFamilyStartupManifest,
} from "./production-family-startup-manifest.js";
import type {
  SystemicLiveGateVerdict,
} from "./systemic-live-gate.js";

/**
 * Single fail-closed cutover-readiness decision over the Phase D/E prep
 * gates: batch parity, held-out negatives, systemic-live, the startup
 * manifest (re-validated and hash-compared) and the source-bound strict
 * consumer entry. The authorized cutover step consumes this verdict; this
 * module never switches authority itself.
 */
export interface S1CutoverReadinessInput {
  readonly batchParityPass: boolean;
  readonly heldOutNegativesPass: boolean;
  readonly systemicLiveVerdict: SystemicLiveGateVerdict["status"];
  readonly startupManifest: ProductionFamilyStartupManifest;
  readonly strictConsumerSourceBound: boolean;
}

export type S1CutoverReadinessVerdict =
  | {
      readonly status: "ready";
      readonly reasons: readonly string[];
    }
  | {
      readonly status: "not-ready";
      readonly reasons: readonly string[];
    };

export function evaluateS1CutoverReadiness(
  input: S1CutoverReadinessInput,
): S1CutoverReadinessVerdict {
  const reasons: string[] = [];
  if (!input.batchParityPass) {
    reasons.push("22-family batch parity receipt is not pass");
  }
  if (!input.heldOutNegativesPass) {
    reasons.push("held-out negative fixtures did not all mismatch");
  }
  if (input.systemicLiveVerdict !== "pass") {
    reasons.push(`systemic-live gate verdict is ${input.systemicLiveVerdict}`);
  }
  try {
    const current = productionFamilyStartupManifest();
    if (
      input.startupManifest.familyCount !== EXPECTED_PRODUCTION_FAMILY_COUNT ||
      input.startupManifest.capabilityCount !==
        EXPECTED_PRODUCTION_CAPABILITY_COUNT ||
      input.startupManifest.manifestHash !== current.manifestHash
    ) {
      reasons.push("startup manifest is stale or mismatches the catalog");
    }
  } catch {
    reasons.push("startup manifest failed closed");
  }
  if (!input.strictConsumerSourceBound) {
    reasons.push("strict catalog consumer is not source-bound");
  }
  return reasons.length === 0
    ? Object.freeze({ status: "ready" as const, reasons: Object.freeze([]) })
    : Object.freeze({
        status: "not-ready" as const,
        reasons: Object.freeze(reasons),
      });
}
