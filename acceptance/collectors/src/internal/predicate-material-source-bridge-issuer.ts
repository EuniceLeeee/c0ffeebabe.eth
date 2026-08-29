import { types as nodeTypes } from "node:util";
import { assertExactKeys, assertPlainObject } from "../../../../packages/canonical-codec/src/index.ts";
import { decodeResolverPolicy } from "../../../../specs/artifact-resolution/src/index.ts";
import type {
  ContentAddressedObserverSinkV1,
  ObservedContentArtifactV1,
  ObserverArtifactWriteV1,
} from "../content-addressed-sink.ts";
import type { PredicateMaterialSourcePortV1 } from "../../../gate-core/src/material-provider.ts";
import {
  registerProductionPredicateMaterialSourceStateV1,
  type ProductionPredicateMaterialSourceOwnerInputV1,
} from "./predicate-material-source-owner.ts";

export type BridgedPredicateMaterialReaderNameV1 = Exclude<
  keyof ProductionPredicateMaterialSourceOwnerInputV1,
  "sink"
>;

export interface BridgedPredicateMaterialSourceOperationsV1 {
  readonly resolverPolicy: unknown;
  readonly readers: Readonly<Record<BridgedPredicateMaterialReaderNameV1, boolean>>;
  readonly read: (reader: BridgedPredicateMaterialReaderNameV1) => unknown;
  readonly write: (input: ObserverArtifactWriteV1) => Promise<ObservedContentArtifactV1>;
}

const readerNames = Object.freeze([
  "readArtifactLineageStageOne",
  "readArtifactLineageStageTwoAuthority",
  "readArtifactLineageStageTwoGit",
  "readFullFamilyObservation",
  "observePerformance",
  "readDurableTerminalDiscovery",
  "observeTerminalSelection",
  "readRuntimeRestartBoundary",
  "readSourceRepositoryClosureBoundary",
  "readLegacyAuthorityClosureBoundary",
] as const satisfies readonly BridgedPredicateMaterialReaderNameV1[]);

/**
 * Fresh-bundle issuer. It registers only an exact method facade; the physical
 * sink and outer source registry never cross the module boundary.
 */
export function issueBridgedPredicateMaterialSourcePortV1(
  operations: BridgedPredicateMaterialSourceOperationsV1,
): PredicateMaterialSourcePortV1 {
  assertPlainObject(operations, "bridgedPredicateMaterialSource");
  assertExactKeys(
    operations,
    ["read", "readers", "resolverPolicy", "write"],
    "bridgedPredicateMaterialSource",
  );
  if (nodeTypes.isProxy(operations) || typeof operations.read !== "function"
    || typeof operations.write !== "function") {
    throw new TypeError("bridged predicate material source operations are invalid");
  }
  assertPlainObject(operations.readers, "bridgedPredicateMaterialSource.readers");
  assertExactKeys(operations.readers, readerNames, "bridgedPredicateMaterialSource.readers");
  for (const name of readerNames) {
    if (typeof operations.readers[name] !== "boolean") {
      throw new TypeError(`bridged predicate material source reader ${name} availability is invalid`);
    }
  }
  const resolverPolicy = decodeResolverPolicy(operations.resolverPolicy as never);
  const sink = Object.freeze({
    resolverPolicy,
    write: (input: ObserverArtifactWriteV1) => operations.write(input),
  }) as unknown as ContentAddressedObserverSinkV1;
  const reader = (name: BridgedPredicateMaterialReaderNameV1): (() => unknown) | null =>
    operations.readers[name] ? () => operations.read(name) : null;
  return registerProductionPredicateMaterialSourceStateV1(Object.freeze({
    sink,
    readArtifactLineageStageOne: reader("readArtifactLineageStageOne"),
    readArtifactLineageStageTwoAuthority: reader("readArtifactLineageStageTwoAuthority"),
    readArtifactLineageStageTwoGit: reader("readArtifactLineageStageTwoGit"),
    readFullFamilyObservation: reader("readFullFamilyObservation"),
    observePerformance: reader("observePerformance"),
    readDurableTerminalDiscovery: reader("readDurableTerminalDiscovery"),
    observeTerminalSelection: reader("observeTerminalSelection") as (() => Promise<unknown>) | null,
    readRuntimeRestartBoundary: reader("readRuntimeRestartBoundary") as (() => Promise<unknown>) | null,
    readSourceRepositoryClosureBoundary: reader("readSourceRepositoryClosureBoundary") as (() => Promise<unknown>) | null,
    readLegacyAuthorityClosureBoundary: reader("readLegacyAuthorityClosureBoundary") as (() => Promise<unknown>) | null,
  }));
}
