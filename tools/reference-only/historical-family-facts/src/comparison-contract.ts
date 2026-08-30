import { hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";

/**
 * Frozen comparison vocabulary shared with authoring-side evaluators.  This
 * module intentionally contains no current release lookup or action runner.
 */
export type HistoricalCurrentComparisonStatusV1 = "consistent" | "contradicted" | "unresolved";

export type HistoricalCurrentComparisonReasonCodeV1 =
  | "current-action-exact-match"
  | "effects-not-qualified"
  | "variant-not-covered"
  | "observed-action-invalid"
  | "observed-variant-metadata-mismatch"
  | "settlement-not-proven"
  | "synthetic-probe-not-byte-comparable"
  | "current-action-build-unavailable"
  | "current-action-abi-invalid"
  | "current-action-target-mismatch"
  | "current-action-calldata-mismatch";

export interface HistoricalCurrentClosureBindingV1 {
  readonly family: "univ2-standard" | "univ3-standard";
  readonly familyDefinitionHash: Hash;
  readonly releaseDecision: "include" | "exclude";
  readonly releaseExclusionReasons: readonly string[];
  readonly definitionCatalogLeafDigest: Hash | null;
  readonly actionOwnerRefs: readonly Hash[];
}

export interface HistoricalCurrentComparisonV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.current-adapter-execution-variant-comparison";
  readonly advisoryOnly: true;
  readonly comparatorSpecDigest: Hash;
  readonly comparatorImplementationDigest: Hash;
  readonly status: HistoricalCurrentComparisonStatusV1;
  readonly reasonCodes: readonly HistoricalCurrentComparisonReasonCodeV1[];
  readonly currentClosureBinding: HistoricalCurrentClosureBindingV1;
}

export const HISTORICAL_CURRENT_COMPARISON_CONTRACT_DIGEST_V1 = hashDomain(
  "aloha/historical-current-comparison-contract/v1",
  Object.freeze({
    advisoryOnly: true,
    authority: "none",
    historicalInput: "frozen-manifest-bound-observation",
    currentInput: "caller-supplied-authoring-evaluation",
    currentProducerVerdictIsOracle: false,
    statuses: Object.freeze(["consistent", "contradicted", "unresolved"]),
  }),
);
