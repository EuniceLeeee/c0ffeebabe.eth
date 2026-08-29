import type {
  PreReleaseBTerminalPhysicalObservationCapabilityV1,
  PreReleaseBTerminalPhysicalObservationV1,
} from "../pre-release-b-terminal-physical-observation.ts";

const observations = new WeakMap<object, PreReleaseBTerminalPhysicalObservationV1>();

/** Terminal-snapshot-owner-only registrar. The public module deliberately
 * exposes no mint, so a decoded or structurally equal record has no standing. */
export function registerPreReleaseBTerminalPhysicalObservationV1(
  capability: PreReleaseBTerminalPhysicalObservationCapabilityV1,
  observation: PreReleaseBTerminalPhysicalObservationV1,
): void {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0
    || observations.has(capability)) {
    throw new TypeError("pre-release B terminal physical observation capability is invalid");
  }
  observations.set(capability, Object.freeze(observation));
}

export function readRegisteredPreReleaseBTerminalPhysicalObservationV1(
  capability: PreReleaseBTerminalPhysicalObservationCapabilityV1,
): PreReleaseBTerminalPhysicalObservationV1 {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("pre-release B terminal physical observation capability is invalid");
  }
  const observation = observations.get(capability);
  if (observation === undefined) {
    throw new TypeError("pre-release B terminal physical observation was not owner-issued");
  }
  return observation;
}
