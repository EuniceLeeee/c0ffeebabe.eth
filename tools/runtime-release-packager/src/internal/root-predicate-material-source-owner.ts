import type { PredicateMaterialSourcePortV1 } from "../../../../acceptance/gate-core/src/material-provider.ts";
import {
  issueProductionArtifactLineageStageOneObserverPortV1,
} from "../../../../acceptance/collectors/src/internal/artifact-lineage-stage-one-owner.ts";
import type { ProductionPerformanceMaterialObserverPortV1 } from "../../../../acceptance/collectors/src/internal/performance-material-observer-owner.ts";
import type { ProductionTerminalSelectionObserverPortV1 } from "../../../../acceptance/collectors/src/internal/terminal-selection-material-owner.ts";
import type {
  ProductionLegacyAuthorityMaterialObserverPortV1,
  ProductionRuntimeRestartMaterialObserverPortV1,
  ProductionSourceClosureMaterialObserverPortV1,
} from "../../../../acceptance/collectors/src/internal/runtime-boundary-material-owner.ts";
import {
  issueProductionPredicateMaterialSourceV1,
} from "../../../../acceptance/collectors/src/production-predicate-material-source.ts";
import {
  assertExactKeys,
  readOwnEnumerableDataProperty,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  readReleaseOwnedObserverStoreV1,
  type ReleaseOwnedObserverStoreCapabilityV1,
} from "../../../../acceptance/collectors/src/internal/release-owned-observer-store.ts";
import type { ProductionTerminalPhaseDurableDiscoveryV1 } from "../../../../acceptance/collectors/src/terminal-phase-locator-index.ts";

export interface RootPredicateMaterialSourceInputV1 {
  readonly observerStore: ReleaseOwnedObserverStoreCapabilityV1;
  readonly artifactLineageRepositoryRoot: string;
  readonly performanceObserver: ProductionPerformanceMaterialObserverPortV1;
  readonly durableTerminalDiscovery: ProductionTerminalPhaseDurableDiscoveryV1;
  readonly terminalSelectionObserver: ProductionTerminalSelectionObserverPortV1;
  readonly runtimeRestartObserver: ProductionRuntimeRestartMaterialObserverPortV1;
  readonly sourceRepositoryClosureObserver: ProductionSourceClosureMaterialObserverPortV1;
  readonly legacyAuthorityClosureObserver: ProductionLegacyAuthorityMaterialObserverPortV1;
}

/** Root-only bridge: candidate runtime owns the release-bound store, while
 * the packager owns Git observation and composes only reopened B material. */
export function issueRootPredicateMaterialSourceV1(
  input: RootPredicateMaterialSourceInputV1,
): PredicateMaterialSourcePortV1 {
  assertExactKeys(input, [
    "observerStore", "artifactLineageRepositoryRoot",
    "performanceObserver", "durableTerminalDiscovery", "terminalSelectionObserver", "runtimeRestartObserver",
    "sourceRepositoryClosureObserver", "legacyAuthorityClosureObserver",
  ], "rootPredicateMaterialSource");
  const observerStore = readOwnEnumerableDataProperty(
    input, "observerStore", "rootPredicateMaterialSource",
  ) as ReleaseOwnedObserverStoreCapabilityV1;
  const artifactLineageRepositoryRoot = readOwnEnumerableDataProperty(
    input, "artifactLineageRepositoryRoot", "rootPredicateMaterialSource",
  ) as string;
  const performanceObserver = readOwnEnumerableDataProperty(
    input, "performanceObserver", "rootPredicateMaterialSource",
  ) as ProductionPerformanceMaterialObserverPortV1;
  const durableTerminalDiscovery = readOwnEnumerableDataProperty(
    input, "durableTerminalDiscovery", "rootPredicateMaterialSource",
  ) as ProductionTerminalPhaseDurableDiscoveryV1;
  const terminalSelectionObserver = readOwnEnumerableDataProperty(
    input, "terminalSelectionObserver", "rootPredicateMaterialSource",
  ) as ProductionTerminalSelectionObserverPortV1;
  const runtimeRestartObserver = readOwnEnumerableDataProperty(
    input, "runtimeRestartObserver", "rootPredicateMaterialSource",
  ) as ProductionRuntimeRestartMaterialObserverPortV1;
  const sourceRepositoryClosureObserver = readOwnEnumerableDataProperty(
    input, "sourceRepositoryClosureObserver", "rootPredicateMaterialSource",
  ) as ProductionSourceClosureMaterialObserverPortV1;
  const legacyAuthorityClosureObserver = readOwnEnumerableDataProperty(
    input, "legacyAuthorityClosureObserver", "rootPredicateMaterialSource",
  ) as ProductionLegacyAuthorityMaterialObserverPortV1;
  for (const [name, value] of Object.entries({
    performanceObserver,
    durableTerminalDiscovery,
    terminalSelectionObserver,
    runtimeRestartObserver,
    sourceRepositoryClosureObserver,
    legacyAuthorityClosureObserver,
  })) {
    if (value === null || typeof value !== "object") {
      throw new TypeError(`root predicate material ${name} is unavailable`);
    }
  }
  readReleaseOwnedObserverStoreV1(observerStore);
  const artifactLineageStageOne = issueProductionArtifactLineageStageOneObserverPortV1({
    repositoryRoot: artifactLineageRepositoryRoot,
    store: observerStore,
    assertCurrent: () => {
      readReleaseOwnedObserverStoreV1(observerStore);
    },
  });
  const source = issueProductionPredicateMaterialSourceV1({
    observerStore,
    artifactLineageStageOne,
    performanceObserver,
    durableTerminalDiscovery,
    terminalSelectionObserver,
    runtimeRestartObserver,
    sourceRepositoryClosureObserver,
    legacyAuthorityClosureObserver,
  });
  readReleaseOwnedObserverStoreV1(observerStore);
  return source;
}
