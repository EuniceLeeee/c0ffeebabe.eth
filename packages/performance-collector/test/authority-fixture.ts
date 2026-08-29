import {
  createInternalPerformanceHeadTerminalEvidenceOwner,
  type PerformanceHeadTerminalEvidenceDraftV1,
} from "../src/internal/head-terminal-evidence.ts";

const testOwner = createInternalPerformanceHeadTerminalEvidenceOwner();

/** Test-only issuer. Production code must obtain evidence from release composition. */
export function issuePerformanceHeadTerminalEvidenceForTest(
  draft: PerformanceHeadTerminalEvidenceDraftV1,
) {
  return testOwner.issue(draft);
}
