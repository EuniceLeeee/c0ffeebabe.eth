import type { AttestationValidationAuthorityV1 } from "../index.ts";
import { ATTESTATION_VALIDATION_AUTHORITY_BRAND } from "../authority-brand.ts";
import {
  attestationAuthorityStates,
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
