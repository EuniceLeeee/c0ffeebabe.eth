import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFamilyCapabilityShadowArtifact } from
  "../build-family-capability-manifest.js";
import { definedFamilyPluginContractSummary } from
  "../venues/adapter-family-plugin.js";
import { eigenpieStrictFamilyPlugin } from
  "../venues/protocols/eigenpie-family-plugin.js";
import { goldxStrictFamilyPlugin } from
  "../venues/protocols/goldx-family-plugin.js";
import { psmStrictFamilyPlugin } from
  "../venues/protocols/psm-family-plugin.js";
import { rocksolidStrictFamilyPlugin } from
  "../venues/protocols/rocksolid-family-plugin.js";
import { wstethStrictFamilyPlugin } from
  "../venues/protocols/wsteth-family-plugin.js";

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
  assert.equal(records.length, 10, `${familyId} capability row count`);
  const present = records.filter((record) => record.root.absence === null);
  assert.deepEqual(
    present.map((record) => record.identity.capability).sort(),
    [...presentCapabilities].sort(),
  );
  assert.equal(
    new Set(present.map((record) => record.root.entrySourceFile)).size,
    presentCapabilities.length,
    `${familyId} must use one direct source root per semantic capability`,
  );
  const directRootFiles = present.map((record) =>
    record.root.entrySourceFile!
  );
  for (const record of present) {
    assert.equal(
      record.root.entrySourceFile,
      `src/searcher/venues/protocols/${family.name}-family/` +
        `${record.identity.capability}.ts`,
    );
    assert(
      !record.identity.semanticDependencies.some((dependency) =>
        dependency.endsWith(`${family.name}-family-plugin.ts`)
      ),
      `${familyId}/${record.identity.capability} cannot hash the compatibility assembly`,
    );
    assert(
      directRootFiles.every((root) =>
        !record.identity.semanticDependencies.includes(root)
      ),
      `${familyId}/${record.identity.capability} cannot depend on a sibling semantic root`,
    );
  }
}

console.log("standard protocol direct capability roots: ok");
