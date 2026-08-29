/**
 * Public consumer-only seam for the searcher runtime.  Issuance remains
 * private to the release bootstrap; this module exposes only the exact
 * owner-issued service assertion and its data-only view.
 */
import { assertIssuedRuntimeReleaseStrategyRuntimeService } from "./internal/strategy-runtime-owner.ts";

export { assertIssuedRuntimeReleaseStrategyRuntimeService };
export type {
  RuntimeReleaseStrategyPlanningRequestV1,
  RuntimeReleaseStrategyPlanningResultV1,
  RuntimeReleaseStrategyRuntimeMetadataV1,
  RuntimeReleaseStrategyRuntimeServiceV1,
} from "./internal/strategy-runtime-owner.ts";
