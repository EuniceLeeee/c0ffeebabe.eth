import {
  assertIssuedProductionSixStepObservationPortV1,
} from "./internal/owner.ts";

export type ProductionSixStepObservationResultCapabilityV1 = object;

export interface ProductionSixStepObservationInvocationV1 {
  readonly windowSelectionCapability: object;
  readonly terminalBindingCapability: object | null;
  readonly joinedProcessCapability: object | null;
}

export interface ProductionSixStepObservationPortV1 {
  readonly observe: (
    input: ProductionSixStepObservationInvocationV1,
  ) => Promise<ProductionSixStepObservationResultCapabilityV1>;
}

export { assertIssuedProductionSixStepObservationPortV1 };
