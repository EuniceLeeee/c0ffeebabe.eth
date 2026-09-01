/**
 * Public consumer-only seam for the searcher runtime.  Issuance remains
 * private to the release bootstrap; this module exposes only the exact
 * owner-issued service assertion and its data-only view.
 */
import {
  assertIssuedRuntimeReleaseStrategyRuntimeService,
  assertIssuedUnsignedDryRunStrategyRuntimeService,
  type RuntimeReleaseStrategyRuntimeServiceV1,
  type UnsignedDryRunStrategyRuntimeServiceV1,
} from "./internal/strategy-runtime-owner.ts";

export type SearcherStrategyRuntimeServiceV1 =
  | RuntimeReleaseStrategyRuntimeServiceV1
  | UnsignedDryRunStrategyRuntimeServiceV1;

export function assertIssuedSearcherStrategyRuntimeServiceV1(
  value: unknown,
): asserts value is SearcherStrategyRuntimeServiceV1 {
  try {
    assertIssuedRuntimeReleaseStrategyRuntimeService(value);
  } catch {
    assertIssuedUnsignedDryRunStrategyRuntimeService(value);
  }
}

export {
  assertIssuedRuntimeReleaseStrategyRuntimeService,
  assertIssuedUnsignedDryRunStrategyRuntimeService,
};
export type {
  RuntimeReleaseStrategyEvidenceExpectationV1,
  RuntimeReleaseStrategyPlanningRequestV1,
  RuntimeReleaseStrategyPlanningResultV1,
  RuntimeReleaseStrategyRuntimeMetadataV1,
  RuntimeReleaseStrategyRuntimeServiceV1,
  UnsignedDryRunStrategyRuntimeMetadataV1,
  UnsignedDryRunStrategyRuntimeServiceV1,
} from "./internal/strategy-runtime-owner.ts";
