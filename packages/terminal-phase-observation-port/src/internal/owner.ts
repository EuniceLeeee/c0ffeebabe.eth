import type {
  ProductionTerminalPhaseObservationInvocationV1,
  ProductionTerminalPhaseObservationPortV1,
  ProductionTerminalPhaseObservationResultCapabilityV1,
} from "../index.ts";

type TerminalPhaseImplementationV1 = (
  input: ProductionTerminalPhaseObservationInvocationV1,
) => Promise<unknown>;

const issuedPorts = new WeakMap<object, TerminalPhaseImplementationV1>();
const issuedResults = new WeakMap<object, unknown>();

function exactInvocation(
  value: ProductionTerminalPhaseObservationInvocationV1,
): ProductionTerminalPhaseObservationInvocationV1 {
  if (value === null || typeof value !== "object") throw new TypeError("terminal-phase observation invocation is required");
  const expected = [
    "finalDurableWindowCapability",
    "fullGraphCoarseSweepCapability",
    "runtimeReleaseTerminalBindingCapability",
    "fullFamilyObservationResultCapability",
    "sixStepObservationResultCapability",
  ];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) {
    throw new TypeError("terminal-phase observation invocation has non-exact fields");
  }
  for (const key of expected) {
    if (value[key as keyof ProductionTerminalPhaseObservationInvocationV1] === null
      || typeof value[key as keyof ProductionTerminalPhaseObservationInvocationV1] !== "object") {
      throw new TypeError(`terminal-phase observation ${key} is not an opaque capability`);
    }
  }
  return Object.freeze({
    finalDurableWindowCapability: value.finalDurableWindowCapability,
    fullGraphCoarseSweepCapability: value.fullGraphCoarseSweepCapability,
    runtimeReleaseTerminalBindingCapability: value.runtimeReleaseTerminalBindingCapability,
    fullFamilyObservationResultCapability: value.fullFamilyObservationResultCapability,
    sixStepObservationResultCapability: value.sixStepObservationResultCapability,
  });
}

export function issueProductionTerminalPhaseObservationPortV1(
  implementation: TerminalPhaseImplementationV1,
): ProductionTerminalPhaseObservationPortV1 {
  if (typeof implementation !== "function") throw new TypeError("terminal-phase observation implementation is required");
  let port: ProductionTerminalPhaseObservationPortV1;
  port = Object.freeze({
    async seal(input: ProductionTerminalPhaseObservationInvocationV1) {
      assertIssuedProductionTerminalPhaseObservationPortV1(port);
      const result = await implementation(exactInvocation(input));
      const capability = Object.freeze(Object.create(null)) as ProductionTerminalPhaseObservationResultCapabilityV1;
      issuedResults.set(capability, result);
      return capability;
    },
  });
  issuedPorts.set(port, implementation);
  return port;
}

export function assertIssuedProductionTerminalPhaseObservationPortV1(
  value: unknown,
): asserts value is ProductionTerminalPhaseObservationPortV1 {
  if (value === null || typeof value !== "object" || !issuedPorts.has(value)) {
    throw new TypeError("terminal-phase observation port is not owner-issued");
  }
}

export function readProductionTerminalPhaseObservationResultV1(
  capability: ProductionTerminalPhaseObservationResultCapabilityV1,
): unknown {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("terminal-phase observation result capability is invalid");
  }
  const result = issuedResults.get(capability);
  if (result === undefined) throw new TypeError("terminal-phase observation result capability was not issued");
  return result;
}
