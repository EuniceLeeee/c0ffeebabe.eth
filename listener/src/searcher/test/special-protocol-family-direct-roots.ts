import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFamilyCapabilityShadowArtifact } from
  "../build-family-capability-manifest.js";
import { definedFamilyPluginContractSummary } from
  "../venues/adapter-family-plugin.js";
import { FAMILY_CAPABILITY_NAMES } from
  "../venues/family-capability-catalog.js";
import type { CapabilityExactShadowRecord } from
  "../venues/family-capability-shadow.js";
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
  "capture",
  "discovery",
  "identity",
  "instance",
  "routes",
  "pricing",
  "exact",
  "execution",
] as const);

function assertDirectRoots(
  family: (typeof families)[number],
  records: readonly CapabilityExactShadowRecord[],
): void {
  const capabilities = records.map((record) => record.identity.capability);
  assert.equal(
    new Set(capabilities).size,
    records.length,
    `${family.familyId} capability rows must be unique`,
  );
  assert.deepEqual(
    [...capabilities].sort(),
    [...FAMILY_CAPABILITY_NAMES].sort(),
    `${family.familyId} must have exactly the canonical capability set`,
  );
  for (const record of records) {
    assert.equal(record.identity.familyId, family.familyId);
    assert.equal(record.root.capability, record.identity.capability);
  }

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

  const discovery = present.find((record) =>
    record.identity.capability === "discovery"
  )!;
  const directRootFiles = present.map((record) => record.root.entrySourceFile!);
  for (const record of present) {
    assert(
      !record.identity.semanticDependencies.some((dependency) =>
        dependency.endsWith(`${family.sourceName}-family-plugin.ts`)
      ),
      `${family.familyId}/${record.identity.capability} cannot hash the compatibility assembly`,
    );
    assert(
      record.identity.semanticDependencies.every((dependency) => {
        const isSemanticRoot = directRootFiles.includes(dependency) || (
          dependency.startsWith("src/searcher/venues/") &&
          FAMILY_CAPABILITY_NAMES.some((capability) =>
            dependency.endsWith(`-family/${capability}.ts`)
          )
        );
        // Capture materialization composes the declared same-Family discovery;
        // no other sibling or cross-Family capability root is permitted.
        return !isSemanticRoot || (
          record.identity.capability === "capture" &&
          dependency === discovery.root.entrySourceFile
        );
      }),
      `${family.familyId}/${record.identity.capability} cannot depend on a sibling or cross-Family semantic root except capture -> declared discovery`,
    );
  }
}

for (const family of families) {
  const records = artifact.exact.filter((record) =>
    record.identity.familyId === family.familyId
  );
  assertDirectRoots(family, records);

  // Exercise the same assertions on corrupt records, not a separate validator.
  for (const record of records) {
    assert.throws(
      () => assertDirectRoots(family, records.filter((row) => row !== record)),
      /must have exactly the canonical capability set/,
    );
    assert.throws(
      () => assertDirectRoots(family, [...records, record]),
      /capability rows must be unique/,
    );
    const other = records.find((row) => row !== record)!;
    assert.throws(
      () => assertDirectRoots(family, records.map((row) =>
        row === other ? record : row
      )),
      /capability rows must be unique/,
    );
  }

  const capture = records.find((record) =>
    record.identity.capability === "capture"
  )!;
  assert.throws(
    () => assertDirectRoots(family, records.map((record) =>
      record === capture
        ? { ...record, root: { ...record.root, absence: "declared-absent" } }
        : record
    )),
    /capture must be present/,
  );
  const otherFamily = families.find((candidate) => candidate !== family)!;
  assert.throws(
    () => assertDirectRoots(family, records.map((record) =>
      record === capture
        ? {
          ...record,
          root: {
            ...record.root,
            entrySourceFile:
              `src/searcher/venues/protocols/${otherFamily.sourceName}-family/capture.ts`,
          },
        }
        : record
    )),
    assert.AssertionError,
  );

  for (const record of records.filter((row) => row.root.absence === null)) {
    for (const sourceName of [family.sourceName, otherFamily.sourceName]) {
      for (const capability of FAMILY_CAPABILITY_NAMES) {
        if (
          record.identity.capability === "capture" &&
          sourceName === family.sourceName && capability === "discovery"
        ) continue;
        const dependency =
          `src/searcher/venues/protocols/${sourceName}-family/${capability}.ts`;
        assert.throws(
          () => assertDirectRoots(family, records.map((row) =>
            row === record
              ? {
                ...row,
                identity: {
                  ...row.identity,
                  semanticDependencies: [
                    ...row.identity.semanticDependencies, dependency,
                  ],
                },
              }
              : row
          )),
          /cannot depend on a sibling or cross-Family semantic root/,
        );
      }
    }
    assert.throws(
      () => assertDirectRoots(family, records.map((row) =>
        row === record
          ? {
            ...row,
            identity: {
              ...row.identity,
              semanticDependencies: [
                ...row.identity.semanticDependencies,
                `src/searcher/venues/protocols/${family.sourceName}-family-plugin.ts`,
              ],
            },
          }
          : row
      )),
      /cannot hash the compatibility assembly/,
    );
  }
}

console.log("special protocol direct capability roots: ok");
