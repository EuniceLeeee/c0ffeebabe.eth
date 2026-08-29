import { assertIssuedProductionTerminalPhaseObservationPortV1 } from "./internal/owner.ts";

export type ProductionTerminalPhaseObservationResultCapabilityV1 = object;

export interface ProductionTerminalPhaseObservationInvocationV1 {
  readonly finalDurableWindowCapability: object;
  readonly fullGraphCoarseSweepCapability: object;
  readonly runtimeReleaseTerminalBindingCapability: object;
  readonly fullFamilyObservationResultCapability: object;
  readonly sixStepObservationResultCapability: object;
}

export interface ProductionTerminalPhaseObservationPortV1 {
  readonly seal: (
    input: ProductionTerminalPhaseObservationInvocationV1,
  ) => Promise<ProductionTerminalPhaseObservationResultCapabilityV1>;
}

export { assertIssuedProductionTerminalPhaseObservationPortV1 };
