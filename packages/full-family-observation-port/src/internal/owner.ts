import type {
  ProductionFullFamilyObservationInvocationV1,
  ProductionFullFamilyObservationPortV1,
  ProductionFullFamilyObservationResultCapabilityV1,
} from "../index.ts";

type ObservationImplementationV1 = (
  input: ProductionFullFamilyObservationInvocationV1,
) => Promise<unknown>;

const issuedPorts = new WeakMap<object, ObservationImplementationV1>();
const issuedResults = new WeakMap<object, unknown>();

function exactInvocation(value: ProductionFullFamilyObservationInvocationV1): ProductionFullFamilyObservationInvocationV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("production full-family observation invocation is required");
  }
  const keys = Reflect.ownKeys(value);
  const expected = [
    "checkpointReader",
    "stage12Capability",
    "runtimeReleaseTerminalBindingCapability",
    "fullGraphCoarseSweepCapability",
  ];
  if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) {
    throw new TypeError("production full-family observation invocation has non-exact fields");
  }
  for (const key of expected) {
    const item = value[key as keyof ProductionFullFamilyObservationInvocationV1];
    if (item === null || typeof item !== "object") {
      throw new TypeError(`production full-family observation ${key} is not an opaque capability`);
    }
  }
  return Object.freeze({
    checkpointReader: value.checkpointReader,
    stage12Capability: value.stage12Capability,
    runtimeReleaseTerminalBindingCapability: value.runtimeReleaseTerminalBindingCapability,
    fullGraphCoarseSweepCapability: value.fullGraphCoarseSweepCapability,
  });
}

/** Acceptance-owned issuance seam. It is intentionally not re-exported by
 * the package root, so production can consume but cannot mint this port. */
export function issueProductionFullFamilyObservationPortV1(
  implementation: ObservationImplementationV1,
): ProductionFullFamilyObservationPortV1 {
  if (typeof implementation !== "function") {
    throw new TypeError("production full-family observation implementation is required");
  }
  let port: ProductionFullFamilyObservationPortV1;
  port = Object.freeze({
    async observe(input: ProductionFullFamilyObservationInvocationV1) {
      assertIssuedProductionFullFamilyObservationPortV1(port);
      const result = await implementation(exactInvocation(input));
      const capability = Object.freeze(Object.create(null)) as ProductionFullFamilyObservationResultCapabilityV1;
      issuedResults.set(capability, result);
      return capability;
    },
  });
  issuedPorts.set(port, implementation);
  return port;
}

export function assertIssuedProductionFullFamilyObservationPortV1(
  value: unknown,
): asserts value is ProductionFullFamilyObservationPortV1 {
  if (value === null || typeof value !== "object" || !issuedPorts.has(value)) {
    throw new TypeError("production full-family observation port is not owner-issued");
  }
}

/** Acceptance-owned result reader. Production retains only the opaque
 * capability and cannot inspect, forge, or reinterpret the verdict/facts. */
export function readProductionFullFamilyObservationResultV1(
  capability: ProductionFullFamilyObservationResultCapabilityV1,
): unknown {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("production full-family observation result capability is invalid");
  }
  if (!issuedResults.has(capability)) {
    throw new TypeError("production full-family observation result capability was not issued");
  }
  return issuedResults.get(capability);
}
