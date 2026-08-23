/** Runtime-only nominal marker shared by the sole authority contract,
 * issuer state, and narrow verifier.  Possessing the symbol property is not
 * sufficient: the verifier also requires process-local WeakMap membership. */
export const ATTESTATION_VALIDATION_AUTHORITY_BRAND = Symbol(
  "aloha-attestation-validation-authority",
);
