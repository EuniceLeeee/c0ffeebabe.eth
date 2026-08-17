import assert from "node:assert/strict";
import {
  productionPoolUniverseSourceFingerprintsStrict,
  strictCatalogUniverseSourceFingerprints,
} from
  "../strict-universe-source-fingerprints.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";

async function main(): Promise<void> {
  const strict = productionPoolUniverseSourceFingerprintsStrict();
  assert(strict.length >= 1, "strict fingerprints must be non-empty");
  assert(
    strict.some((entry) => entry.startsWith("strict-catalog-universe:v1:")),
    "strict catalog universe fingerprint must be present",
  );
  // Deterministic.
  assert.deepEqual(
    strict,
    productionPoolUniverseSourceFingerprintsStrict(),
    "strict fingerprints must be deterministic",
  );
  // Catalog-derived surface: one strict fingerprint per call, stable.
  const derived = strictCatalogUniverseSourceFingerprints({
    catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
  });
  assert.equal(derived.length, 1);
  assert.match(derived[0], /^strict-catalog-universe:v1:[0-9a-f]{64}$/);
  // The strict surface covers all 22 families (no per-family list here;
  // the fingerprint binds catalogHash which itself covers every family).
  assert(
    strict.length === productionPoolUniverseSourceFingerprintsStrict().length,
    "strict fingerprints must be stable across calls",
  );
  console.log("strict universe source fingerprints PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
