import {
  registerNominationQualificationReuseOwnerCompositionV1,
  type NominationQualificationReuseOwnerCompositionStateV1,
  type NominationQualificationReuseOwnerCompositionV1,
} from "../../src/internal/nomination-qualification-reuse-owner-state.ts";

/** Test-only raw composition issuer. Production has no raw issuance path. */
export function issueFixtureNominationQualificationReuseOwnerCompositionV1(
  state: Omit<NominationQualificationReuseOwnerCompositionStateV1, "currentRuntimeBinding" | "currentDeploymentFact">
    & Partial<Pick<NominationQualificationReuseOwnerCompositionStateV1, "currentRuntimeBinding" | "currentDeploymentFact">>,
): NominationQualificationReuseOwnerCompositionV1 {
  return registerNominationQualificationReuseOwnerCompositionV1({
    ...state,
    currentRuntimeBinding: state.currentRuntimeBinding ?? state.priorRuntimeBinding,
    currentDeploymentFact: state.currentDeploymentFact ?? state.priorDeploymentFact,
  });
}
