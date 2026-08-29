import {
  assertIssuedRuntimeReleaseSixStepTerminalBindingServiceV1,
  readRuntimeReleaseSixStepTerminalBindingCapabilityV1,
  readRuntimeReleaseSixStepTerminalArtifactCapabilitiesV1,
  type RuntimeReleaseSixStepTerminalBindingCapabilityV1,
  type RuntimeReleaseSixStepTerminalBindingServiceV1,
  type RuntimeReleaseSixStepTerminalBindingV1,
} from "./internal/six-step-terminal-owner.ts";
import type { ProductionSixStepArtifactCapabilitiesV1 } from "../../search-pipeline/src/index.ts";

export type {
  RuntimeReleaseSixStepTerminalBindingCapabilityV1,
  RuntimeReleaseSixStepTerminalBindingServiceV1,
  RuntimeReleaseSixStepTerminalBindingV1,
} from "./internal/six-step-terminal-owner.ts";

/** Fixed consumer. No caller-provided reader or decoded terminal DTO exists. */
export function readRuntimeReleaseSixStepTerminalBindingV1(
  capability: RuntimeReleaseSixStepTerminalBindingCapabilityV1,
): RuntimeReleaseSixStepTerminalBindingV1 {
  return readRuntimeReleaseSixStepTerminalBindingCapabilityV1(capability);
}

/** Opaque complete Stage 1-6 closure retained by the exact successful
 * terminal. No event or artifact can be minted through this reader. */
export function readRuntimeReleaseSixStepTerminalArtifactsV1(
  capability: RuntimeReleaseSixStepTerminalBindingCapabilityV1,
): ProductionSixStepArtifactCapabilitiesV1 {
  return readRuntimeReleaseSixStepTerminalArtifactCapabilitiesV1(capability);
}

export { assertIssuedRuntimeReleaseSixStepTerminalBindingServiceV1 };
