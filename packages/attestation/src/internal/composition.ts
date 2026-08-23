import {
  createAttestationServiceInternal,
  createFrameworkFailureRuntimeInternal,
  createRejectionExecutorAuthorityIssuerInternal,
  createRejectionFactRuntimeInternal,
} from "./engine.ts";
import { resolveCompositionBinding } from "./composition-resolution.ts";
import type {
  AttestationServiceConstructorV1,
  AttestationServiceV1,
  AttestationCompositionBindingV1,
  FrameworkFailureClassifierPort,
  FrameworkFailureRuntimePort,
  RejectionExecutorAuthorityIssuerV1,
  RejectionFactRuntimePort,
} from "../index.ts";

export function createFrameworkFailureRuntime(
  seed: AttestationCompositionBindingV1,
  classifier: FrameworkFailureClassifierPort,
): FrameworkFailureRuntimePort {
  return createFrameworkFailureRuntimeInternal(resolveCompositionBinding(seed), classifier);
}

export function createRejectionExecutorAuthorityIssuer(
  seed: AttestationCompositionBindingV1,
): RejectionExecutorAuthorityIssuerV1 {
  return createRejectionExecutorAuthorityIssuerInternal(resolveCompositionBinding(seed));
}

export function createRejectionFactRuntime(capability: Parameters<typeof createRejectionFactRuntimeInternal>[0]): RejectionFactRuntimePort {
  return createRejectionFactRuntimeInternal(capability);
}

export function createAttestationService(input: AttestationServiceConstructorV1): AttestationServiceV1 {
  const composition = resolveCompositionBinding(input.composition);
  return createAttestationServiceInternal({ ...input, composition });
}
