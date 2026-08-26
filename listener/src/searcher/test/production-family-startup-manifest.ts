import assert from "node:assert/strict";
import {
  PRODUCTION_FAMILY_STARTUP_MANIFEST_FORMAT,
  productionFamilyStartupManifest,
} from "../production-family-startup-manifest.js";
import {
  FAMILY_CAPABILITY_NAMES,
  type FamilyCapabilityCatalog,
} from "../venues/family-capability-catalog.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";

function main(): void {
  const first = productionFamilyStartupManifest();
  const second = productionFamilyStartupManifest();
  assert.equal(first.format, PRODUCTION_FAMILY_STARTUP_MANIFEST_FORMAT);
  assert.equal(first.familyCount, first.families.length);
  assert.equal(
    first.capabilityCount,
    first.familyCount * FAMILY_CAPABILITY_NAMES.length,
  );
  assert.equal(first.manifestHash, second.manifestHash);
  assert(Object.isFrozen(first));
  assert(Object.isFrozen(first.families));
  assert(first.families.every((family) => Object.isFrozen(family)));
  const ids = first.families.map((family) => family.familyId);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(new Set(ids).size, ids.length);
  assert(first.families.every((family) =>
    family.applicableCapabilities.length +
      family.declaredAbsentCapabilities.length ===
      FAMILY_CAPABILITY_NAMES.length
  ));
  const catalogFamilies = new Map(
    PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.listAll().map(
      (family) => [family.plugin.manifest.familyId, family] as const,
    ),
  );
  for (const family of first.families) {
    const catalogFamily = catalogFamilies.get(family.familyId);
    assert(catalogFamily);
    assert.deepEqual(
      family.applicableCapabilities,
      FAMILY_CAPABILITY_NAMES.filter((capability) =>
        catalogFamily.applicableCapabilities.includes(capability)
      ),
    );
    assert.deepEqual(
      family.declaredAbsentCapabilities,
      FAMILY_CAPABILITY_NAMES.filter((capability) =>
        !catalogFamily.applicableCapabilities.includes(capability)
      ),
    );
  }

  const fakeFamily = {
    sourceFile: "fixture.ts",
    definitionBoundaryHash: "11".repeat(32),
    plugin: {
      manifest: { familyId: "fixture:fake" },
    },
    hashes: {},
    applicableCapabilities: [],
  };
  assert.throws(() => productionFamilyStartupManifest({
    listAll: () => [fakeFamily],
  } as unknown as FamilyCapabilityCatalog), /lacks capability hash/);

  const single = [{
    sourceFile: "fixture.ts",
    definitionBoundaryHash: "11".repeat(32),
    plugin: {
      manifest: { familyId: "fixture:fake" },
    },
    hashes: Object.fromEntries(FAMILY_CAPABILITY_NAMES.map((capability) => [
      capability,
      { familyId: "fixture:fake", capability, contentHash: "22".repeat(32) },
    ])),
    applicableCapabilities: FAMILY_CAPABILITY_NAMES,
  }];
  const oneFamily = productionFamilyStartupManifest({
    listAll: () => single,
  } as unknown as FamilyCapabilityCatalog);
  assert.equal(oneFamily.familyCount, 1);
  assert.equal(oneFamily.capabilityCount, FAMILY_CAPABILITY_NAMES.length);

  assert.throws(() => productionFamilyStartupManifest({
    listAll: () => [single[0]!, single[0]!],
  } as unknown as FamilyCapabilityCatalog), /duplicate Family/);

  console.log("production family startup manifest PASS");
}

main();
