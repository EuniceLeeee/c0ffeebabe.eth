import type {
  FinalSimulationPortV1,
} from "../index.ts";
import {
  readIssuedProducerCurrentSourceSessionCapabilityV1,
  type ProducerCurrentSourceSessionCapabilityV1,
  type ProducerCurrentSourceSessionViewV1,
} from "../../../canonical-source/src/index.ts";

/**
 * An application must never receive a raw final-simulation factory. This
 * process-local capability is issued only by the release/final-sim owner;
 * structural copies and objects carrying the same `issue` method are not
 * accepted by the searcher runtime.
 */
export interface QualifiedFinalSimulationPortFactoryV1<Simulation> {
  readonly issue: (
    currentSourceCapability: ProducerCurrentSourceSessionCapabilityV1,
  ) => FinalSimulationPortV1<Simulation> | Promise<FinalSimulationPortV1<Simulation>>;
}

export interface QualifiedFinalSimulationPortIssuerV1<Simulation> {
  readonly issue: (
    currentSource: ProducerCurrentSourceSessionViewV1,
    currentSourceCapability: ProducerCurrentSourceSessionCapabilityV1,
  ) => FinalSimulationPortV1<Simulation> | Promise<FinalSimulationPortV1<Simulation>>;
}

const issued = new WeakSet<object>();

/** Internal composition/test seam; production callers receive the capability. */
export function issueQualifiedFinalSimulationPortFactoryV1<Simulation>(
  factory: QualifiedFinalSimulationPortIssuerV1<Simulation>,
): QualifiedFinalSimulationPortFactoryV1<Simulation> {
  if (factory === null || typeof factory !== "object" || typeof factory.issue !== "function") {
    throw new TypeError("qualified final simulation factory is required");
  }
  const capability = Object.freeze({
    async issue(currentSourceCapability: ProducerCurrentSourceSessionCapabilityV1) {
      const currentSource = readIssuedProducerCurrentSourceSessionCapabilityV1(currentSourceCapability);
      await currentSource.assertCurrent();
      return await factory.issue(currentSource, currentSourceCapability);
    },
  });
  issued.add(capability);
  return capability;
}

export function assertIssuedQualifiedFinalSimulationPortFactory(
  value: unknown,
): asserts value is QualifiedFinalSimulationPortFactoryV1<unknown> {
  if (value === null || typeof value !== "object" || !issued.has(value)) {
    throw new TypeError("qualified final simulation factory is not owner-issued");
  }
}
