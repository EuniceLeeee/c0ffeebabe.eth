import type { AttestationServiceV1, AttestationValidationAuthorityV1 } from "../index.ts";
import { ATTESTATION_VALIDATION_AUTHORITY_BRAND } from "../authority-brand.ts";
import {
  attestationAuthorityStates,
  attestationServiceStates,
} from "./validation-authority-state.ts";

/**
 * Checkpoint's only authority dependency.  It sees the issued verifier port
 * and the process-local membership registry, never the attestation engine or
 * its issuer/program graph.
 */
export function assertAttestationValidationAuthority(
  value: unknown,
): AttestationValidationAuthorityV1 {
  if (
    value === null
    || typeof value !== "object"
    || (value as { [ATTESTATION_VALIDATION_AUTHORITY_BRAND]?: unknown })[ATTESTATION_VALIDATION_AUTHORITY_BRAND] !== true
    || !attestationAuthorityStates.has(value)
  ) {
    throw new TypeError("attestation-validation-authority-not-issued");
  }
  return value as AttestationValidationAuthorityV1;
}

/** Exact owner seam for release composition.  A structural facade with an
 * engine-issued authority but caller-controlled programs is not sufficient. */
export function assertIssuedAttestationService(value: unknown): AttestationServiceV1 {
  if (value === null || typeof value !== "object" || !attestationServiceStates.has(value)) {
    throw new TypeError("attestation service is not issued");
  }
  return value as AttestationServiceV1;
}
