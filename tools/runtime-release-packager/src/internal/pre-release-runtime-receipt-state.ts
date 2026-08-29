import type {
  PreReleaseAdvisoryMaterialCapabilityV1,
  PreReleaseAdvisoryMaterialProjectionV1,
  PreReleaseStagingArtifactNameV1,
} from "../pre-release-staging-contract.ts";
import type { QualifiedReleaseAcceptanceRunnerCapabilityV1 } from "./qualified-release-public-runner-state.ts";
import type { ReleaseOwnedObserverStoreCapabilityV1 } from "../../../../acceptance/collectors/src/internal/release-owned-observer-store.ts";
import type { ProductionTerminalPhaseDurableDiscoveryV1 } from "../../../../acceptance/collectors/src/terminal-phase-locator-index.ts";
import type { ProductionPerformanceMaterialObserverPortV1 } from "../../../../acceptance/collectors/src/internal/performance-material-observer-owner.ts";
import type { ProductionTerminalSelectionObserverPortV1 } from "../../../../acceptance/collectors/src/internal/terminal-selection-material-owner.ts";
import type { ProductionRuntimeRestartMaterialObserverPortV1 } from "../../../../acceptance/collectors/src/internal/runtime-boundary-material-owner.ts";
import type { PreReleaseControllerDatabaseSnapshotPublicationV1 } from "../../../pre-release-restart-controller/src/durable-owner.ts";

export interface PreReleaseAdvisoryMaterialV1 {
  readonly qualifiedReleaseRunner: QualifiedReleaseAcceptanceRunnerCapabilityV1;
  readonly observerStore: ReleaseOwnedObserverStoreCapabilityV1;
  readonly performanceObserver: ProductionPerformanceMaterialObserverPortV1;
  readonly durableTerminalDiscovery: ProductionTerminalPhaseDurableDiscoveryV1;
  readonly terminalSelectionObserver: ProductionTerminalSelectionObserverPortV1;
  readonly runtimeRestartObserver: ProductionRuntimeRestartMaterialObserverPortV1;
  readonly checkpointSnapshotPublication: PreReleaseControllerDatabaseSnapshotPublicationV1;
  readonly stagingArtifactBytes: Readonly<Record<PreReleaseStagingArtifactNameV1, Uint8Array>>;
}

interface ReceiptStateV1 {
  readonly projection: PreReleaseAdvisoryMaterialProjectionV1;
  readonly material: PreReleaseAdvisoryMaterialV1;
}

const receipts = new WeakMap<object, ReceiptStateV1>();

/** Owner-only registration port; Boundary must allow only the staging owner. */
export function issuePreReleaseAdvisoryMaterialCapabilityV1(
  projection: PreReleaseAdvisoryMaterialProjectionV1,
  material: PreReleaseAdvisoryMaterialV1,
): PreReleaseAdvisoryMaterialCapabilityV1 {
  const capability = Object.freeze(Object.create(null)) as PreReleaseAdvisoryMaterialCapabilityV1;
  receipts.set(capability, Object.freeze({ projection, material: Object.freeze({ ...material }) }));
  return capability;
}

/** Exact consumer port; structural clones never recover a projection. */
export function readPreReleaseAdvisoryMaterialCapabilityV1(
  capability: PreReleaseAdvisoryMaterialCapabilityV1,
): PreReleaseAdvisoryMaterialProjectionV1 {
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("pre-release advisory material capability is invalid");
  }
  const state = receipts.get(capability);
  if (state === undefined) {
    throw new TypeError("pre-release advisory material capability was not staging-owner-issued");
  }
  return state.projection;
}


/** Owner-internal exact material reader; public projections never expose
 * process-local authority and structural clones cannot recover it. */
export function readPreReleaseAdvisoryMaterialV1(
  capability: PreReleaseAdvisoryMaterialCapabilityV1,
): PreReleaseAdvisoryMaterialV1 {
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("pre-release advisory material capability is invalid");
  }
  const state = receipts.get(capability);
  if (state === undefined) {
    throw new TypeError("pre-release advisory material capability was not staging-owner-issued");
  }
  return state.material;
}
