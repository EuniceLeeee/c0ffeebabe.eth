import assert from "node:assert/strict";
import {
  EXPECTED_PRODUCTION_CAPABILITY_COUNT,
  EXPECTED_PRODUCTION_FAMILY_COUNT,
  PRODUCTION_FAMILY_STARTUP_MANIFEST_FORMAT,
  productionFamilyStartupManifest,
} from "../production-family-startup-manifest.js";
import {
  FAMILY_CAPABILITY_NAMES,
  type FamilyCapabilityCatalog,
} from "../venues/family-capability-catalog.js";

function main(): void {
  const first = productionFamilyStartupManifest();
  const second = productionFamilyStartupManifest();
  assert.equal(first.format, PRODUCTION_FAMILY_STARTUP_MANIFEST_FORMAT);
  assert.equal(first.familyCount, EXPECTED_PRODUCTION_FAMILY_COUNT);
  assert.equal(first.capabilityCount, EXPECTED_PRODUCTION_CAPABILITY_COUNT);
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
  const funding = first.families.find((family) =>
    family.familyId === "flash-loan:morpho"
  )!;
  assert.deepEqual(funding.applicableCapabilities, ["funding"]);
  const credit = first.families.find((family) =>
    family.familyId === "credit:fluid"
  )!;
  assert(credit.applicableCapabilities.includes("credit"));
  assert(credit.declaredAbsentCapabilities.includes("pricing"));
  assert(credit.declaredAbsentCapabilities.includes("exact"));

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
  assert.throws(() => productionFamilyStartupManifest({
    listAll: () => single,
  } as unknown as FamilyCapabilityCatalog), /requires 22 Families/);

  assert.throws(() => productionFamilyStartupManifest({
    listAll: () => [fakeFamily, fakeFamily],
  } as unknown as FamilyCapabilityCatalog), /lacks capability hash/);

  console.log("production family startup manifest PASS");
}

main();
