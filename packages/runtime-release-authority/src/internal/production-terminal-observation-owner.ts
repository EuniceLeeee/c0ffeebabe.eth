import {
  issueProductionFullFamilyCollectorPortV1,
} from "../../../../acceptance/collectors/src/production-full-family-port.ts";
import {
  issueProductionSixStepCollectorPortV1,
} from "../../../../acceptance/collectors/src/production-six-step-port.ts";
import {
  issueProductionTerminalPhaseCollectorPortV1,
} from "../../../../acceptance/collectors/src/production-terminal-phase-port.ts";
import {
  ProductionTerminalPhaseLocatorIndexV1,
} from "../../../../acceptance/collectors/src/terminal-phase-locator-index.ts";
import {
  assertExactKeys,
  readOwnEnumerableDataProperty,
} from "../../../canonical-codec/src/index.ts";
import {
  assertRuntimeReleaseObserverStoreServiceOwnedByAuthorityV1,
  readRuntimeReleaseObserverSinkV1,
  type RuntimeReleaseObserverStoreServiceV1,
} from "./observer-store-owner.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";

export interface RuntimeReleaseTerminalObservationInputV1 {
  readonly observerStore: RuntimeReleaseObserverStoreServiceV1;
  readonly observerContentDirectory: string;
  readonly terminalLocatorDirectory: string;
  readonly releaseIntentCanonicalBytes: Uint8Array;
  readonly familyCatalogSourceBytes: Uint8Array;
  readonly runtimeCompositionSourceBytes: Uint8Array;
  readonly strategyCatalogSourceBytes: Uint8Array;
  readonly candidateProofVerifierBindingBytes: Uint8Array;
}

/** Exact release-owner splice into the acceptance observation sinks. The
 * production application receives only collector ports; collector issuers,
 * stores, and locator construction never cross the facade. */
export function issueRuntimeReleaseTerminalObservationPortsV1(
  authority: RuntimeReleaseAuthorityV1,
  input: RuntimeReleaseTerminalObservationInputV1,
) {
  const keys = [
    "observerStore", "observerContentDirectory", "terminalLocatorDirectory",
    "releaseIntentCanonicalBytes", "familyCatalogSourceBytes", "runtimeCompositionSourceBytes",
    "strategyCatalogSourceBytes", "candidateProofVerifierBindingBytes",
  ] as const;
  assertExactKeys(input, keys, "runtimeReleaseTerminalObservation");
  const observerStoreService = readOwnEnumerableDataProperty(
    input,
    "observerStore",
    "runtimeReleaseTerminalObservation",
  ) as RuntimeReleaseObserverStoreServiceV1;
  const observerContentDirectory = readOwnEnumerableDataProperty(
    input,
    "observerContentDirectory",
    "runtimeReleaseTerminalObservation",
  ) as string;
  const terminalLocatorDirectory = readOwnEnumerableDataProperty(
    input,
    "terminalLocatorDirectory",
    "runtimeReleaseTerminalObservation",
  ) as string;
  const releaseIntentCanonicalBytes = readOwnEnumerableDataProperty(input, "releaseIntentCanonicalBytes", "runtimeReleaseTerminalObservation") as Uint8Array;
  const familyCatalogSourceBytes = readOwnEnumerableDataProperty(input, "familyCatalogSourceBytes", "runtimeReleaseTerminalObservation") as Uint8Array;
  const runtimeCompositionSourceBytes = readOwnEnumerableDataProperty(input, "runtimeCompositionSourceBytes", "runtimeReleaseTerminalObservation") as Uint8Array;
  const strategyCatalogSourceBytes = readOwnEnumerableDataProperty(input, "strategyCatalogSourceBytes", "runtimeReleaseTerminalObservation") as Uint8Array;
  const candidateProofVerifierBindingBytes = readOwnEnumerableDataProperty(input, "candidateProofVerifierBindingBytes", "runtimeReleaseTerminalObservation") as Uint8Array;
  assertRuntimeReleaseObserverStoreServiceOwnedByAuthorityV1(authority, observerStoreService);
  const observerStore = observerStoreService.issueObserverStore({
    directory: observerContentDirectory,
  });
  const sink = readRuntimeReleaseObserverSinkV1(observerStoreService, observerStore);
  const fullFamilyObservation = issueProductionFullFamilyCollectorPortV1({
    releaseIntentCanonicalBytes,
    familyCatalogSourceBytes,
    runtimeCompositionSourceBytes,
    strategyCatalogSourceBytes,
    candidateProofVerifierBindingBytes,
    sink,
  });
  const sixStepObservation = issueProductionSixStepCollectorPortV1(sink);
  const locatorIndex = new ProductionTerminalPhaseLocatorIndexV1({
    directory: terminalLocatorDirectory,
    sink,
  });
  const terminalPhaseObservation = issueProductionTerminalPhaseCollectorPortV1({ sink, locatorIndex });
  return Object.freeze({ fullFamilyObservation, sixStepObservation, terminalPhaseObservation });
}
