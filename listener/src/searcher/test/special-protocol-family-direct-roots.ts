import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFamilyCapabilityShadowArtifact } from
  "../build-family-capability-manifest.js";
import { definedFamilyPluginContractSummary } from
  "../venues/adapter-family-plugin.js";
import { plugin as erc4626SiloRedeemPlugin } from
  "../venues/production-families/erc4626-silo-redeem.production.js";
import { plugin as etherTokenNativeRedeemPlugin } from
  "../venues/production-families/ethertoken-native-redeem.production.js";
import { plugin as metronomeHgUsdcPlugin } from
  "../venues/production-families/metronome-hgusdc.production.js";
import { plugin as metronomeSynthPlugin } from
  "../venues/production-families/metronome-synth.production.js";
import { plugin as selfBurnNativePlugin } from
  "../venues/production-families/self-burn-native.production.js";

const listenerRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const families = Object.freeze([
  Object.freeze({
    familyId: "protocol:erc4626-silo-redeem",
    sourceName: "erc4626-silo-redeem",
    plugin: erc4626SiloRedeemPlugin,
  }),
  Object.freeze({
    familyId: "protocol:metronome-synth",
    sourceName: "metronome-synth",
    plugin: metronomeSynthPlugin,
  }),
  Object.freeze({
    familyId: "protocol:metronome-hgusdc",
    sourceName: "metronome-hgusdc",
    plugin: metronomeHgUsdcPlugin,
  }),
  Object.freeze({
    familyId: "protocol:self-burn-native",
    sourceName: "self-burn-native",
    plugin: selfBurnNativePlugin,
  }),
  Object.freeze({
    familyId: "protocol:ethertoken-native-redeem",
    sourceName: "ethertoken-native-redeem",
    plugin: etherTokenNativeRedeemPlugin,
  }),
]);

for (const family of families) {
  const summary = definedFamilyPluginContractSummary(family.plugin);
  assert.equal(summary.familyId, family.familyId);
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
    `src/searcher/venues/production-families/${family.sourceName}.production.ts`,
  )),
});

assert.equal(artifact.complete, true, JSON.stringify(artifact.issues));
assert.deepEqual(artifact.issues, []);

const directCapabilities = Object.freeze([
  "discovery",
  "identity",
  "instance",
  "routes",
  "pricing",
  "exact",
  "execution",
] as const);

for (const family of families) {
  const records = artifact.exact.filter((record) =>
    record.identity.familyId === family.familyId
  );
  assert.equal(records.length, 10, `${family.familyId} capability row count`);

  const present = records.filter((record) => record.root.absence === null);
  for (const capability of directCapabilities) {
    const record = present.find((candidate) =>
      candidate.identity.capability === capability
    );
    assert(record, `${family.familyId}/${capability} must be present`);
    assert.equal(
      record.root.entrySourceFile,
      `src/searcher/venues/protocols/${family.sourceName}-family/` +
        `${capability}.ts`,
    );
  }
  const victim = present.find((record) =>
    record.identity.capability === "victim"
  );
  if (family.sourceName === "metronome-synth") {
    assert(victim, `${family.familyId}/victim must be present`);
    assert.equal(
      victim.root.entrySourceFile,
      "src/searcher/venues/protocols/metronome-synth-family/victim.ts",
    );
  } else {
    assert.equal(victim, undefined, `${family.familyId}/victim must be absent`);
  }

  const directRootFiles = present.map((record) => record.root.entrySourceFile!);
  for (const record of present) {
    assert(
      !record.identity.semanticDependencies.some((dependency) =>
        dependency.endsWith(`${family.sourceName}-family-plugin.ts`)
      ),
      `${family.familyId}/${record.identity.capability} cannot hash the compatibility assembly`,
    );
    assert(
      directRootFiles.every((root) =>
        !record.identity.semanticDependencies.includes(root)
      ),
      `${family.familyId}/${record.identity.capability} cannot depend on a sibling semantic root`,
    );
  }
}

console.log("special protocol direct capability roots: ok");
