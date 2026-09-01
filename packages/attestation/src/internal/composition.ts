import type { Hash } from "../../../canonical-codec/src/index.ts";
import type { RuntimeAuthorityProjectionV1 } from "../../../runtime-authority/src/index.ts";
import {
  createAttestationServiceInternal,
  createFrameworkFailureRuntimeInternal,
  createRejectionExecutorAuthorityIssuerInternal,
  createRejectionFactRuntimeInternal,
} from "./engine.ts";
import type {
  AttestationServiceConstructorV1,
  AttestationServiceV1,
  FrameworkFailureClassifierPort,
  FrameworkFailureRuntimePort,
  RejectionExecutorAuthorityIssuerV1,
  RejectionFactRuntimePort,
} from "../index.ts";

export function createFrameworkFailureRuntime(
  runtimeAuthority: RuntimeAuthorityProjectionV1,
  classifier: FrameworkFailureClassifierPort,
): FrameworkFailureRuntimePort {
  return createFrameworkFailureRuntimeInternal(runtimeAuthority, classifier);
}

export function createRejectionExecutorAuthorityIssuer(input: {
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly workerEpoch: string;
  readonly executorSessionHash: Hash;
}): RejectionExecutorAuthorityIssuerV1 {
  return createRejectionExecutorAuthorityIssuerInternal(input);
}

export function createRejectionFactRuntime(
  capability: Parameters<typeof createRejectionFactRuntimeInternal>[0],
): RejectionFactRuntimePort {
  return createRejectionFactRuntimeInternal(capability);
}

export function createAttestationService(input: AttestationServiceConstructorV1): AttestationServiceV1 {
  return createAttestationServiceInternal(input);
}
