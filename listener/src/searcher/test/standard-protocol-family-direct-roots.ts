import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFamilyCapabilityShadowArtifact } from
  "../build-family-capability-manifest.js";
import { definedFamilyPluginContractSummary } from
  "../venues/adapter-family-plugin.js";
import { FAMILY_CAPABILITY_NAMES } from
  "../venues/family-capability-catalog.js";
import { plugin as eigenpieStrictFamilyPlugin } from
  "../venues/production-families/eigenpie.production.js";
import { plugin as goldxStrictFamilyPlugin } from
  "../venues/production-families/goldx.production.js";
import { plugin as psmStrictFamilyPlugin } from
  "../venues/production-families/psm.production.js";
import { plugin as rocksolidStrictFamilyPlugin } from
  "../venues/production-families/rocksolid.production.js";
import { plugin as wstethStrictFamilyPlugin } from
  "../venues/production-families/wsteth.production.js";

const listenerRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const families = Object.freeze([
  Object.freeze({ name: "wsteth", plugin: wstethStrictFamilyPlugin }),
  Object.freeze({ name: "psm", plugin: psmStrictFamilyPlugin }),
  Object.freeze({ name: "goldx", plugin: goldxStrictFamilyPlugin }),
  Object.freeze({ name: "eigenpie", plugin: eigenpieStrictFamilyPlugin }),
  Object.freeze({ name: "rocksolid", plugin: rocksolidStrictFamilyPlugin }),
]);

for (const family of families) {
  const summary = definedFamilyPluginContractSummary(family.plugin);
  assert.equal(summary.familyId, `protocol:${family.name}`);
  assert.equal(summary.domain, "protocol");
  assert.deepEqual(
    summary.ownedActionAdapterIds,
    summary.suppliedActionAdapterIds,
    `${summary.familyId} must travel with exactly its owned actions`,
  );
}

const artifact = await buildFamilyCapabilityShadowArtifact({
  rootDirectory: listenerRoot,
  productionRegistryFile: resolve(
    listenerRoot,
    "src/searcher/venues/production-families/tracked-sources.ts",
  ),
  productionEntryFiles: families.map((family) => resolve(
    listenerRoot,
    `src/searcher/venues/production-families/${family.name}.production.ts`,
  )),
});

assert.equal(artifact.complete, true, JSON.stringify(artifact.issues));
assert.deepEqual(artifact.issues, []);

const presentCapabilities = Object.freeze([
  "capture",
  "discovery",
  "identity",
  "instance",
  "routes",
  "pricing",
  "exact",
  "execution",
]);

for (const family of families) {
  const familyId = `protocol:${family.name}`;
  const records = artifact.exact.filter((record) =>
    record.identity.familyId === familyId
  );
  const capabilities = records.map((record) => record.identity.capability);
  assert.equal(new Set(capabilities).size, records.length,
    `${familyId} capability rows must be unique`);
  assert.deepEqual([...capabilities].sort(), [...FAMILY_CAPABILITY_NAMES].sort(),
    `${familyId} must have exactly the canonical capability set`);
  const present = records.filter((record) => record.root.absence === null);
  assert.deepEqual(
    present.map((record) => record.identity.capability).sort(),
    [...presentCapabilities].sort(),
  );
  const familyDirectory = `src/searcher/venues/protocols/${family.name}-family/`;
  const definition = familyDirectory + family.name + ".json";
  for (const record of present) {
    assert.equal(record.root.entrySourceFile, "src/searcher/venues/declarative-protocol.ts");
    assert.equal(record.root.entryExport, "compileDeclarativeProtocol");
    assert(record.root.additionalSourceFiles.includes(definition));
    assert(record.identity.semanticDependencies.includes(definition));
    const handwritten = record.identity.semanticDependencies.filter(path =>
      path.startsWith(familyDirectory) && /\/(?:capture|discovery|identity|instance|routes|pricing|exact|execution)\.ts$/.test(path));
    assert.deepEqual(handwritten, [], `${familyId}/${record.identity.capability} must consume its declaration`);
    assert(!record.identity.semanticDependencies.some(path => path.endsWith(`${family.name}-family-plugin.ts`)));
  }
}

console.log("standard protocol JSON capability roots: ok");
