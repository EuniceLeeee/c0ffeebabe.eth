/** Public Stage 1 surface is read/assert/type-only. The sole production
 * observer issuer lives under internal/ and is imported only by the verified
 * runtime-release composition owner. */
export {
  assertIssuedProductionArtifactLineageStageOneObserverPortV1,
  readArtifactLineageStageOneCapabilityV1,
  type ArtifactLineageStageOneCapabilityV1,
  type ArtifactLineageStageOneObservationV1,
  type ProductionArtifactLineageStageOneObserverPortV1,
} from "./internal/artifact-lineage-stage-one-state.ts";
