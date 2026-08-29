import {
  assertIssuedProductionFullFamilyObservationPortV1,
} from "./internal/owner.ts";

export type ProductionFullFamilyObservationResultCapabilityV1 = object;

/**
 * Opaque evidence handed from the one application terminal phase to the
 * externally owned observer.  The application cannot decode or replace any
 * of these owner-issued capabilities.
 */
export interface ProductionFullFamilyObservationInvocationV1 {
  readonly checkpointReader: object;
  readonly stage12Capability: object;
  readonly runtimeReleaseTerminalBindingCapability: object;
  readonly fullGraphCoarseSweepCapability: object;
}

export interface ProductionFullFamilyObservationPortV1 {
  readonly observe: (
    input: ProductionFullFamilyObservationInvocationV1,
  ) => Promise<ProductionFullFamilyObservationResultCapabilityV1>;
}

export { assertIssuedProductionFullFamilyObservationPortV1 };
