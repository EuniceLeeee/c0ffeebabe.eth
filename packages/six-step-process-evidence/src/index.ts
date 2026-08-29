import {
  readSearcherProductionSixStepProcessEvidenceCapabilityV1,
  type SearcherProductionSixStepProcessCapabilityV1,
  type SearcherProductionSixStepProcessEvidenceV1,
  type SearcherProductionSixStepSchedulerJoinV1,
  type SixStepRuntimeAnchorV1,
} from "./internal/owner.ts";
import {
  readSearcherProductionSixStepCompleteAppendMaterialV1,
  type SearcherProductionSixStepCompleteAppendCapabilityV1,
} from "./internal/complete-append-owner.ts";
import {
  SIX_STEP_WINDOW_SELECTION_POLICY_DIGEST,
  readSearcherProductionSixStepWindowSelectionCapabilityV1,
  type SearcherProductionSixStepWindowSelectionCapabilityV1,
  type SearcherProductionSixStepWindowSelectionV1,
} from "./internal/window-selection-owner.ts";

export { SIX_STEP_WINDOW_SELECTION_POLICY_DIGEST };

export type {
  SearcherProductionSixStepProcessCapabilityV1,
  SearcherProductionSixStepProcessEvidenceV1,
  SearcherProductionSixStepSchedulerJoinV1,
  SixStepRuntimeAnchorV1,
} from "./internal/owner.ts";
export type { SearcherProductionSixStepCompleteAppendCapabilityV1 } from "./internal/complete-append-owner.ts";
export type {
  SearcherProductionSixStepWindowSelectionCapabilityV1,
  SearcherProductionSixStepWindowSelectionV1,
} from "./internal/window-selection-owner.ts";

/** Fixed consumer. Callers cannot inject a reader, issuer, or joined DTO. */
export function readSearcherProductionSixStepProcessEvidenceV1(
  capability: SearcherProductionSixStepProcessCapabilityV1,
): SearcherProductionSixStepProcessEvidenceV1 {
  return readSearcherProductionSixStepProcessEvidenceCapabilityV1(capability);
}

/** Fixed narrow projection used by the application to bind the exact retained
 * successful search terminal. No event, receipt, Stage1/2 or runtime DTO is
 * exposed through this consumer. */
export function readSearcherProductionSixStepCompleteAppendSearchTerminalV1(
  capability: SearcherProductionSixStepCompleteAppendCapabilityV1,
) {
  return readSearcherProductionSixStepCompleteAppendMaterialV1(capability).searchTerminalCapability;
}

/** Fixed window-level selection consumer. The returned complete-append value
 * remains opaque and is chosen by the release-fixed mechanical policy. */
export function readSearcherProductionSixStepWindowSelectionV1(
  capability: SearcherProductionSixStepWindowSelectionCapabilityV1,
): SearcherProductionSixStepWindowSelectionV1 {
  return readSearcherProductionSixStepWindowSelectionCapabilityV1(capability);
}
