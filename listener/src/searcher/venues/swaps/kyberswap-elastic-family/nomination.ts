import { createAddressSurfaceNomination } from
  "../../address-surface-nomination.js";
import { KYSWAP_SURFACE_PATTERN_ID } from "./abi.js";

/**
 * Opaque-label nomination only. A label or an interface fingerprint can raise
 * a candidate, but it can never admit one: admission is the on-chain
 * `factory()` / `factory.getPool(...)` relation verified in identity.ts.
 */
export const kyberswapElasticNomination = createAddressSurfaceNomination({
  opaqueLabels: Object.freeze([
    "kyberswap-elastic",
    "kyberswap",
    "elastic",
  ]),
  interfaceFingerprints: Object.freeze([KYSWAP_SURFACE_PATTERN_ID]),
});
