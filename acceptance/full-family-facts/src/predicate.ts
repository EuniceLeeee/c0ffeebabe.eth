import {
  decodeFullFamilyFacts,
  deriveFullFamilyStatus,
  validateFullFamilyFacts,
  type FamilyDerivedStatusV1,
  type FullFamilyFactBundleV1,
  type FullFamilyGeneratedRuntimeMetadataV1,
} from "./schema.ts";

export type FullFamilyPredicateVerdict = "pass" | "fail" | "invalid";

export type FullFamilyReasonCode =
  | "malformed-fact"
  | "release-set-mismatch"
  | "runtime-binding-mismatch"
  | "family-denominator-mismatch"
  | "family-definition-mismatch"
  | "cross-family-evidence"
  | "source-partition-incomplete"
  | "source-coverage-invalid"
  | "candidate-partition-mismatch"
  | "candidate-outcome-denominator-mismatch"
  | "publication-denominator-mismatch"
  | "coarse-denominator-mismatch"
  | "ready-count-mismatch"
  | "retryable-status"
  | "invalid-program-status"
  | "contract-failed"
  | "producer-verdict-injection";

export interface FullFamilyReasonV1 {
  readonly code: FullFamilyReasonCode;
  readonly path: string;
}

export interface FullFamilyStatusV1 {
  readonly familyId: string;
  readonly status: FamilyDerivedStatusV1;
}

export interface FullFamilyPredicateResultV1 {
  readonly verdict: FullFamilyPredicateVerdict;
  readonly reasons: readonly FullFamilyReasonV1[];
  readonly familyCount: string | null;
  readonly statuses: readonly FullFamilyStatusV1[];
  readonly bundle: FullFamilyFactBundleV1 | null;
}

function reason(code: FullFamilyReasonCode, path: string): FullFamilyReasonV1 {
  return Object.freeze({ code, path });
}

function structuralReason(error: unknown): FullFamilyReasonCode {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("release-intent") || message.includes("runtime-composition") || message.includes("definition-catalog")) return "release-set-mismatch";
  if (message.includes("recent observation") || message.includes("root-mismatch")) return "runtime-binding-mismatch";
  if (message.includes("family-denominator") || message.includes("unknown-family")) return "family-denominator-mismatch";
  if (message.includes("family-definition")) return "family-definition-mismatch";
  if (message.includes("cross-family")) return "cross-family-evidence";
  if (message.includes("source-coverage") || message.includes("coverage-")) return "source-coverage-invalid";
  if (message.includes("source-plan")) return "source-partition-incomplete";
  if (message.includes("candidate-partition") || message.includes("candidate-key")) return "candidate-partition-mismatch";
  if (message.includes("candidate-outcome")) return "candidate-outcome-denominator-mismatch";
  if (message.includes("publication") || message.includes("instance-edge") || message.includes("edge-instance")) return "publication-denominator-mismatch";
  if (message.includes("coarse") || message.includes("unranked")) return "coarse-denominator-mismatch";
  if (message.includes("instance-catalog-count") || message.includes("graph-edge-count")) return "ready-count-mismatch";
  if (message.includes("producer")) return "producer-verdict-injection";
  return "malformed-fact";
}

function rawBundle(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length !== 1) throw new TypeError("full-family facts require exactly one bundle");
  return value[0];
}

/**
 * Pure semantic predicate. Artifact resolution and observation binding are
 * performed by the GateCore adapter before this function is called.
 */
export function evaluateFullFamilyPredicate(
  value: unknown,
  generatedRuntime: FullFamilyGeneratedRuntimeMetadataV1,
): FullFamilyPredicateResultV1 {
  let bundle: FullFamilyFactBundleV1;
  try {
    bundle = decodeFullFamilyFacts(rawBundle(value) as object);
    validateFullFamilyFacts(bundle, generatedRuntime);
  } catch (error) {
    return Object.freeze({
      verdict: "invalid",
      reasons: Object.freeze([reason(structuralReason(error), "$.predicateFacts")]),
      familyCount: null,
      statuses: Object.freeze([]),
      bundle: null,
    });
  }
  const generatedByFamily = new Map(generatedRuntime.families.map(family => [family.familyId, family]));
  const statuses = Object.freeze(bundle.families.map(family => {
    const generatedFamily = generatedByFamily.get(family.familyId);
    if (generatedFamily === undefined) throw new TypeError(`generated Family denominator missing ${family.familyId}`);
    return Object.freeze({
      familyId: family.familyId,
      status: deriveFullFamilyStatus(family, bundle.sourceCoverage.artifact, generatedFamily),
    });
  }));
  const unresolved = statuses.find(entry => entry.status === "retryable" || entry.status === "invalid-program");
  if (unresolved !== undefined) {
    return Object.freeze({
      verdict: "invalid",
      reasons: Object.freeze([reason(unresolved.status === "retryable" ? "retryable-status" : "invalid-program-status", `$.families.${unresolved.familyId}`)]),
      familyCount: bundle.familyMatrixCount,
      statuses,
      bundle,
    });
  }
  const failed = statuses.find(entry => entry.status === "contract-failed");
  if (failed !== undefined) {
    return Object.freeze({
      verdict: "fail",
      reasons: Object.freeze([reason("contract-failed", `$.families.${failed.familyId}`)]),
      familyCount: bundle.familyMatrixCount,
      statuses,
      bundle,
    });
  }
  return Object.freeze({
    verdict: "pass",
    reasons: Object.freeze([]),
    familyCount: bundle.familyMatrixCount,
    statuses,
    bundle,
  });
}
