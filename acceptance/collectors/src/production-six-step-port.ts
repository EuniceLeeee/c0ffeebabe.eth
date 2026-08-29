import type {
  ProductionSixStepObservationPortV1,
  ProductionSixStepObservationResultCapabilityV1,
} from "../../../packages/six-step-observation-port/src/index.ts";
import {
  issueProductionSixStepObservationPortV1,
  readProductionSixStepObservationResultV1,
} from "../../../packages/six-step-observation-port/src/internal/owner.ts";
import type { RuntimeReleaseSixStepTerminalBindingCapabilityV1 } from "../../../packages/runtime-release-authority/src/six-step-terminal-consumer.ts";
import type { SearcherProductionSixStepProcessCapabilityV1 } from "../../../packages/six-step-process-evidence/src/index.ts";
import type { SearcherProductionSixStepWindowSelectionCapabilityV1 } from "../../../packages/six-step-process-evidence/src/index.ts";
import { ContentAddressedObserverSinkV1 } from "./content-addressed-sink.ts";
import {
  observeProductionSixStep,
  type ProductionSixStepObserverResultV1,
} from "./six-step-observer.ts";

/**
 * Fixed acceptance implementation. Production can invoke this branded port
 * only with the two owner-issued capabilities; it cannot supply an observer,
 * expected verdict, decoded trace, or action facts.
 */
export function issueProductionSixStepCollectorPortV1(
  sink: ContentAddressedObserverSinkV1,
): ProductionSixStepObservationPortV1 {
  if (!(sink instanceof ContentAddressedObserverSinkV1)) {
    throw new TypeError("production Six-Step collector port requires collector-owned sink");
  }
  return issueProductionSixStepObservationPortV1(invocation => observeProductionSixStep({
    windowSelectionCapability:
      invocation.windowSelectionCapability as SearcherProductionSixStepWindowSelectionCapabilityV1,
    terminalBindingCapability:
      invocation.terminalBindingCapability as RuntimeReleaseSixStepTerminalBindingCapabilityV1 | null,
    joinedProcessCapability:
      invocation.joinedProcessCapability as SearcherProductionSixStepProcessCapabilityV1 | null,
    sink,
  }));
}

export function readProductionSixStepCollectorResultV1(
  capability: ProductionSixStepObservationResultCapabilityV1,
): ProductionSixStepObserverResultV1 {
  return readProductionSixStepObservationResultV1(capability) as ProductionSixStepObserverResultV1;
}
