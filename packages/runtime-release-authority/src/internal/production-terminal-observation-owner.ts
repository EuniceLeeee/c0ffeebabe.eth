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
  readReleaseOwnedObserverStoreV1,
} from "../../../../acceptance/collectors/src/internal/release-owned-observer-store.ts";
import type { RuntimeReleaseObserverStoreServiceV1 } from "./observer-store-owner.ts";

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
  input: RuntimeReleaseTerminalObservationInputV1,
) {
  const observerStore = input.observerStore.issueObserverStore({
    directory: input.observerContentDirectory,
  });
  const sink = readReleaseOwnedObserverStoreV1(observerStore).sink;
  const fullFamilyObservation = issueProductionFullFamilyCollectorPortV1({
    releaseIntentCanonicalBytes: input.releaseIntentCanonicalBytes,
    familyCatalogSourceBytes: input.familyCatalogSourceBytes,
    runtimeCompositionSourceBytes: input.runtimeCompositionSourceBytes,
    strategyCatalogSourceBytes: input.strategyCatalogSourceBytes,
    candidateProofVerifierBindingBytes: input.candidateProofVerifierBindingBytes,
    sink,
  });
  const sixStepObservation = issueProductionSixStepCollectorPortV1(sink);
  const locatorIndex = new ProductionTerminalPhaseLocatorIndexV1({
    directory: input.terminalLocatorDirectory,
    sink,
  });
  const terminalPhaseObservation = issueProductionTerminalPhaseCollectorPortV1({ sink, locatorIndex });
  return Object.freeze({ fullFamilyObservation, sixStepObservation, terminalPhaseObservation });
}
