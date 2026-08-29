import {
  registerCurrentCatalogImpactAnalysisCapabilityV1,
  type CurrentCatalogImpactAnalysisCapabilityV1,
  type CurrentCatalogImpactAnalysisStateV1,
} from "../../src/internal/current-impact-analysis-state.ts";

/** Test-only raw-state issuer. Production code must use the fixed catalog owner. */
export function issueFixtureCurrentCatalogImpactAnalysisCapabilityV1(
  state: CurrentCatalogImpactAnalysisStateV1,
): CurrentCatalogImpactAnalysisCapabilityV1 {
  return registerCurrentCatalogImpactAnalysisCapabilityV1(state);
}
