import type {
  ProductionSixStepObservationInvocationV1,
  ProductionSixStepObservationPortV1,
  ProductionSixStepObservationResultCapabilityV1,
} from "../index.ts";

type ObservationImplementationV1 = (
  input: ProductionSixStepObservationInvocationV1,
) => Promise<unknown> | unknown;

const issuedPorts = new WeakMap<object, ObservationImplementationV1>();
const issuedResults = new WeakMap<object, unknown>();

function exactInvocation(value: ProductionSixStepObservationInvocationV1): ProductionSixStepObservationInvocationV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("production Six-Step observation invocation is required");
  }
  const keys = Reflect.ownKeys(value);
  const expected = ["windowSelectionCapability", "terminalBindingCapability", "joinedProcessCapability"];
  if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) {
    throw new TypeError("production Six-Step observation invocation has non-exact fields");
  }
  if (value.windowSelectionCapability === null || typeof value.windowSelectionCapability !== "object"
    || (value.terminalBindingCapability !== null && typeof value.terminalBindingCapability !== "object")
    || (value.joinedProcessCapability !== null && typeof value.joinedProcessCapability !== "object")) {
    throw new TypeError("production Six-Step observation accepts only opaque capabilities or explicit missing");
  }
  return Object.freeze({
    windowSelectionCapability: value.windowSelectionCapability,
    terminalBindingCapability: value.terminalBindingCapability,
    joinedProcessCapability: value.joinedProcessCapability,
  });
}

/** Acceptance-owned issuer; package root deliberately does not export it. */
export function issueProductionSixStepObservationPortV1(
  implementation: ObservationImplementationV1,
): ProductionSixStepObservationPortV1 {
  if (typeof implementation !== "function") {
    throw new TypeError("production Six-Step observation implementation is required");
  }
  let port: ProductionSixStepObservationPortV1;
  port = Object.freeze({
    async observe(input: ProductionSixStepObservationInvocationV1) {
      assertIssuedProductionSixStepObservationPortV1(port);
      const result = await implementation(exactInvocation(input));
      const capability = Object.freeze(Object.create(null)) as ProductionSixStepObservationResultCapabilityV1;
      issuedResults.set(capability, result);
      return capability;
    },
  });
  issuedPorts.set(port, implementation);
  return port;
}

export function assertIssuedProductionSixStepObservationPortV1(
  value: unknown,
): asserts value is ProductionSixStepObservationPortV1 {
  if (value === null || typeof value !== "object" || !issuedPorts.has(value)) {
    throw new TypeError("production Six-Step observation port is not owner-issued");
  }
}

export function readProductionSixStepObservationResultV1(
  capability: ProductionSixStepObservationResultCapabilityV1,
): unknown {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("production Six-Step observation result capability is invalid");
  }
  if (!issuedResults.has(capability)) {
    throw new TypeError("production Six-Step observation result capability was not issued");
  }
  return issuedResults.get(capability);
}
