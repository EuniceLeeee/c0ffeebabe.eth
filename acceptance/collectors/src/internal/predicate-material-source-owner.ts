import type { PredicateMaterialSourcePortV1 } from "../../../gate-core/src/material-provider.ts";
import type { ContentAddressedObserverSinkV1 } from "../content-addressed-sink.ts";

export interface ProductionPredicateMaterialSourceOwnerInputV1 {
  readonly sink: ContentAddressedObserverSinkV1;
  readonly readArtifactLineageStageOne: (() => unknown) | null;
  readonly readArtifactLineageStageTwoAuthority: (() => unknown) | null;
  readonly readArtifactLineageStageTwoGit: (() => unknown) | null;
  readonly readFullFamilyObservation: (() => unknown) | null;
  readonly observePerformance: (() => unknown) | null;
  readonly readDurableTerminalDiscovery: (() => unknown) | null;
  readonly observeTerminalSelection: (() => Promise<unknown>) | null;
  readonly readRuntimeRestartBoundary: (() => Promise<unknown>) | null;
  readonly readSourceRepositoryClosureBoundary: (() => Promise<unknown>) | null;
  readonly readLegacyAuthorityClosureBoundary: (() => Promise<unknown>) | null;
}

const sourceStates = new WeakMap<object, Readonly<ProductionPredicateMaterialSourceOwnerInputV1>>();

/** Registry primitive consumed only by the physical and fresh-runner issuers. */
export function registerProductionPredicateMaterialSourceStateV1(
  input: ProductionPredicateMaterialSourceOwnerInputV1,
): PredicateMaterialSourcePortV1 {
  const port = Object.freeze(Object.create(null)) as object;
  sourceStates.set(port, Object.freeze({ ...input }));
  return port;
}

export function assertProductionPredicateMaterialSourcePortV1(
  value: unknown,
): asserts value is PredicateMaterialSourcePortV1 {
  if (value === null || typeof value !== "object" || !sourceStates.has(value)) {
    throw new TypeError("predicate material source port was not release-owner-issued");
  }
}

export function readProductionPredicateMaterialSourceStateV1(
  port: PredicateMaterialSourcePortV1,
): Readonly<ProductionPredicateMaterialSourceOwnerInputV1> {
  assertProductionPredicateMaterialSourcePortV1(port);
  return sourceStates.get(port)!;
}
