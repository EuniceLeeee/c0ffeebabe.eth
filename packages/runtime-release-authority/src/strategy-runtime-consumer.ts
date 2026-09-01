/**
 * Public consumer-only seam for the searcher runtime.  Issuance remains
 * private to the release bootstrap; this module exposes only the exact
 * owner-issued service assertion and its data-only view.
 */
import {
  assertIssuedStrategyRuntimeService,
  type StrategyRuntimeServiceV1,
} from "./internal/strategy-runtime-owner.ts";

export type SearcherStrategyRuntimeServiceV1 = StrategyRuntimeServiceV1;

export function assertIssuedSearcherStrategyRuntimeServiceV1(
  value: unknown,
): asserts value is SearcherStrategyRuntimeServiceV1 {
  assertIssuedStrategyRuntimeService(value);
}

export {
  assertIssuedStrategyRuntimeService,
};
export type {
  StrategyRuntimePlanningRequestV1,
  StrategyRuntimePlanningResultV1,
  StrategyEvidenceExpectationV1,
  StrategyRuntimeMetadataV1,
  StrategyRuntimeServiceV1,
} from "./internal/strategy-runtime-owner.ts";
