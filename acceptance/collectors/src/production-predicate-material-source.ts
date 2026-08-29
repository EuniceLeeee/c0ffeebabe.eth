import type { PredicateMaterialSourcePortV1 } from "../../gate-core/src/material-provider.ts";
import {
  readArtifactLineageStageOneCapabilityV1,
  type ProductionArtifactLineageStageOneObserverPortV1,
} from "./production-artifact-lineage-observer.ts";
import {
  assertArtifactLineageStageOneObserverStoreV1,
  readArtifactLineageStageTwoAuthorityV1,
} from "./internal/artifact-lineage-stage-one-state.ts";
import {
  readReleaseOwnedObserverStoreV1,
  type ReleaseOwnedObserverStoreCapabilityV1,
} from "./internal/release-owned-observer-store.ts";
import {
  assertExactKeys,
  readOwnEnumerableDataProperty,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  assertProductionPerformanceMaterialObserverPortV1,
  observeProductionPerformanceMaterialV1,
  type ProductionPerformanceMaterialObserverPortV1,
} from "./internal/performance-material-observer-owner.ts";
import {
  assertIssuedProductionTerminalSelectionObserverPortV1,
  readProductionTerminalSelectionMaterialV1,
  type ProductionTerminalSelectionObserverPortV1,
} from "./internal/terminal-selection-material-owner.ts";
import { issueProductionPredicateMaterialSourcePortV1 } from "./internal/predicate-material-source-issuer.ts";
import { observeArtifactLineageStageTwoGitEvidenceV1 } from "./internal/artifact-lineage-stage-two-git-owner.ts";
import {
  assertProductionLegacyAuthorityMaterialObserverPortV1,
  assertProductionRuntimeRestartMaterialObserverPortV1,
  assertProductionSourceClosureMaterialObserverPortV1,
  observeProductionLegacyAuthorityMaterialV1,
  observeProductionRuntimeRestartMaterialV1,
  observeProductionSourceClosureMaterialV1,
  type ProductionLegacyAuthorityMaterialObserverPortV1,
  type ProductionRuntimeRestartMaterialObserverPortV1,
  type ProductionSourceClosureMaterialObserverPortV1,
} from "./internal/runtime-boundary-material-owner.ts";
import {
  assertProductionTerminalPhaseDurableDiscoveryV1,
  type ProductionTerminalPhaseDurableDiscoveryV1,
} from "./terminal-phase-locator-index.ts";

export interface ProductionPredicateMaterialSourceInputV1 {
  readonly observerStore: ReleaseOwnedObserverStoreCapabilityV1;
  readonly artifactLineageStageOne: ProductionArtifactLineageStageOneObserverPortV1 | null;
  readonly performanceObserver: ProductionPerformanceMaterialObserverPortV1 | null;
  readonly durableTerminalDiscovery: ProductionTerminalPhaseDurableDiscoveryV1 | null;
  readonly terminalSelectionObserver: ProductionTerminalSelectionObserverPortV1 | null;
  readonly runtimeRestartObserver: ProductionRuntimeRestartMaterialObserverPortV1 | null;
  readonly sourceRepositoryClosureObserver: ProductionSourceClosureMaterialObserverPortV1 | null;
  readonly legacyAuthorityClosureObserver: ProductionLegacyAuthorityMaterialObserverPortV1 | null;
}

/** Fixed integration adapter over real observer-owner capabilities.  It is
 * intentionally not re-exported from the collectors public barrel. */
export function issueProductionPredicateMaterialSourceV1(
  input: ProductionPredicateMaterialSourceInputV1,
): PredicateMaterialSourcePortV1 {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("production predicate material source input is required");
  }
  const expected = [
    "observerStore", "artifactLineageStageOne", "performanceObserver",
    "durableTerminalDiscovery", "terminalSelectionObserver", "runtimeRestartObserver",
    "sourceRepositoryClosureObserver", "legacyAuthorityClosureObserver",
  ];
  assertExactKeys(input, expected, "productionPredicateMaterialSource");
  const observerStore = readOwnEnumerableDataProperty(input, "observerStore", "productionPredicateMaterialSource") as ReleaseOwnedObserverStoreCapabilityV1;
  const artifactLineageStageOne = readOwnEnumerableDataProperty(input, "artifactLineageStageOne", "productionPredicateMaterialSource") as ProductionArtifactLineageStageOneObserverPortV1 | null;
  const performanceObserver = readOwnEnumerableDataProperty(input, "performanceObserver", "productionPredicateMaterialSource") as ProductionPerformanceMaterialObserverPortV1 | null;
  const durableTerminalDiscovery = readOwnEnumerableDataProperty(input, "durableTerminalDiscovery", "productionPredicateMaterialSource") as ProductionTerminalPhaseDurableDiscoveryV1 | null;
  const terminalSelectionObserver = readOwnEnumerableDataProperty(input, "terminalSelectionObserver", "productionPredicateMaterialSource") as ProductionTerminalSelectionObserverPortV1 | null;
  const runtimeRestartObserver = readOwnEnumerableDataProperty(input, "runtimeRestartObserver", "productionPredicateMaterialSource") as ProductionRuntimeRestartMaterialObserverPortV1 | null;
  const sourceRepositoryClosureObserver = readOwnEnumerableDataProperty(input, "sourceRepositoryClosureObserver", "productionPredicateMaterialSource") as ProductionSourceClosureMaterialObserverPortV1 | null;
  const legacyAuthorityClosureObserver = readOwnEnumerableDataProperty(input, "legacyAuthorityClosureObserver", "productionPredicateMaterialSource") as ProductionLegacyAuthorityMaterialObserverPortV1 | null;
  const sink = readReleaseOwnedObserverStoreV1(observerStore).sink;
  if (artifactLineageStageOne !== null) {
    assertArtifactLineageStageOneObserverStoreV1(artifactLineageStageOne, observerStore);
  }
  if (performanceObserver !== null) assertProductionPerformanceMaterialObserverPortV1(performanceObserver);
  if (terminalSelectionObserver !== null) assertIssuedProductionTerminalSelectionObserverPortV1(terminalSelectionObserver);
  if (runtimeRestartObserver !== null) assertProductionRuntimeRestartMaterialObserverPortV1(runtimeRestartObserver);
  if (sourceRepositoryClosureObserver !== null) assertProductionSourceClosureMaterialObserverPortV1(sourceRepositoryClosureObserver);
  if (legacyAuthorityClosureObserver !== null) assertProductionLegacyAuthorityMaterialObserverPortV1(legacyAuthorityClosureObserver);
  if (durableTerminalDiscovery !== null) assertProductionTerminalPhaseDurableDiscoveryV1(durableTerminalDiscovery);
  return issueProductionPredicateMaterialSourcePortV1({
    sink,
    readArtifactLineageStageOne: artifactLineageStageOne === null ? null : async () => readArtifactLineageStageOneCapabilityV1(await artifactLineageStageOne.observe()),
    readArtifactLineageStageTwoAuthority: artifactLineageStageOne === null ? null : () => readArtifactLineageStageTwoAuthorityV1(artifactLineageStageOne, observerStore),
    readArtifactLineageStageTwoGit: artifactLineageStageOne === null ? null : async () => {
      const authority = readArtifactLineageStageTwoAuthorityV1(artifactLineageStageOne, observerStore);
      const observed = await readArtifactLineageStageOneCapabilityV1(await artifactLineageStageOne.observe());
      return observeArtifactLineageStageTwoGitEvidenceV1(authority, observed, sink.resolverPolicy.maxByteLength);
    },
    readFullFamilyObservation: null,
    observePerformance: performanceObserver === null ? null : () => observeProductionPerformanceMaterialV1(performanceObserver),
    readDurableTerminalDiscovery: durableTerminalDiscovery === null ? null : () => durableTerminalDiscovery,
    observeTerminalSelection: terminalSelectionObserver === null ? null : async () => readProductionTerminalSelectionMaterialV1(await terminalSelectionObserver.observe()),
    readRuntimeRestartBoundary: runtimeRestartObserver === null ? null : () => observeProductionRuntimeRestartMaterialV1(runtimeRestartObserver),
    readSourceRepositoryClosureBoundary: sourceRepositoryClosureObserver === null ? null : () => observeProductionSourceClosureMaterialV1(sourceRepositoryClosureObserver),
    readLegacyAuthorityClosureBoundary: legacyAuthorityClosureObserver === null ? null : () => observeProductionLegacyAuthorityMaterialV1(legacyAuthorityClosureObserver),
  });
}
