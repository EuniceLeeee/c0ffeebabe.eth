import { runtimeReleaseBindingProvenanceHash } from "../../../specs/release-authority/src/index.ts";
import {
  readQualifiedReleaseLineageObservationV1,
  type QualifiedReleaseAcceptanceRunnerCapabilityV1,
} from "../../../tools/runtime-release-packager/src/internal/qualified-release-public-runner-state.ts";
import {
  issueProductionPerformanceMaterialObserverOwnerPortV1,
  type ProductionPerformanceMaterialObserverPortV1,
} from "./internal/performance-material-observer-owner.ts";

/** Advisory pre-release performance qualification is deliberately
 * unavailable. Raw SQLite evidence remains independently observable, but it
 * is not read or promoted into qualified material before the post-freeze
 * external observer exists. */
export function issueProductionPerformanceMaterialObserverPortV1(
  qualifiedReleaseRunner: QualifiedReleaseAcceptanceRunnerCapabilityV1,
): ProductionPerformanceMaterialObserverPortV1 {
  const lineage = readQualifiedReleaseLineageObservationV1(qualifiedReleaseRunner);
  return issueProductionPerformanceMaterialObserverOwnerPortV1(Object.freeze({
    candidateReleaseCommit: lineage.boundary.candidateReleaseCommit,
    runtimeBindingId: lineage.runtimeBinding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(lineage.runtimeBinding),
  }));
}

export type { ProductionPerformanceMaterialObserverPortV1 };
