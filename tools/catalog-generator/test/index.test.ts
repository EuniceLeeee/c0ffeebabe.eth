import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { asCapabilityId, asCapabilityVersion, asOwnerRef, asSchemaRef } from "../../../packages/capability-contracts/src/index.ts";
import { defineFamily, type FamilyAuthoringDefinitionV1 } from "../../../packages/family-sdk/authoring/index.ts";
import { sealCapabilityIndex, type CapabilityIndexEntryV1 } from "../../../specs/capability-index/src/index.ts";
import { sealReleaseIntent } from "../../../specs/release-intent/src/index.ts";
import { checkGeneratedCatalog, generateCatalog, writeGeneratedCatalog } from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/catalog-generator", value);

function writeModule(root: string, path: string, exportName: string): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, `export const ${exportName} = Object.freeze({ kind: ${JSON.stringify(exportName)} });\n`);
}

function familyDefinition(familyId: string): FamilyAuthoringDefinitionV1 {
  type CoreKind = "nomination" | "identity" | "materialization" | "projection" | "rehydration";
  const module = <K extends CoreKind>(kind: K) => ({
    modulePath: `families/${familyId}/${kind}.ts`,
    exportName: `${kind}Capability`,
    artifactKind: kind,
    capabilityIds: [],
    schemaRefs: [asSchemaRef(h(`${familyId}:${kind}:schema`))],
  }) as { readonly modulePath: string; readonly exportName: string; readonly artifactKind: K; readonly capabilityIds: readonly never[]; readonly schemaRefs: readonly ReturnType<typeof asSchemaRef>[] };
  return defineFamily({
    manifest: {
      familyId,
      version: "1.0.0",
      pluginCodeHash: h(`${familyId}:plugin`),
      authorityDeclarationHash: h(`${familyId}:authority`),
      sourcePlanIds: ["fixed-cutoff-50-block"],
    },
    core: {
      nomination: { ...module("nomination"), sourcePlanIds: ["fixed-cutoff-50-block"] },
      identity: module("identity"),
      materialization: module("materialization"),
      projection: module("projection"),
      rehydration: module("rehydration"),
    },
    extensions: {
      "demo.quote": {
        kind: "present",
        module: {
          capabilityId: asCapabilityId("demo.quote"),
          version: asCapabilityVersion("1.0.0"),
          schemaHash: asSchemaRef(h("demo.quote:schema")),
          interpreterHash: h("demo.quote:interpreter"),
          dependencyIds: [],
          artifactKinds: ["exact"],
          modulePath: `families/${familyId}/quote.ts`,
          exportName: "quoteCapability",
        },
      },
    },
    actionOwners: [{
      ownerId: `${familyId}.action`,
      version: asCapabilityVersion("1.0.0"),
      schemaHash: asSchemaRef(h(`${familyId}:action:schema`)),
      implementationHash: h(`${familyId}:action:implementation`),
      actionKinds: ["execute"],
      modulePath: `families/${familyId}/action.ts`,
      exportName: "actionOwner",
    }],
    acceptanceDeclarations: [{ factContractId: `${familyId}.facts`, version: asCapabilityVersion("1.0.0"), schemaHash: asSchemaRef(h(`${familyId}:facts`)) }],
  });
}

function addFamilyFiles(root: string, definition: FamilyAuthoringDefinitionV1): void {
  const modules = [definition.core.nomination, definition.core.identity, definition.core.materialization, definition.core.projection, definition.core.rehydration, ...Object.values(definition.extensions).flatMap(slot => slot.kind === "present" ? [slot.module] : []), ...definition.actionOwners];
  for (const module of modules) writeModule(root, module.modulePath, module.exportName);
  writeModule(root, `families/${definition.manifest.familyId}/public.ts`, "PUBLIC_ENTRY");
}

function capabilityIndex(root: string): ReturnType<typeof sealCapabilityIndex> {
  const entry: CapabilityIndexEntryV1 = {
    capabilityId: "demo.quote",
    version: "1.0.0",
    schemaHash: h("demo.quote:schema"),
    interpreterHash: h("demo.quote:interpreter"),
    dependencyIds: [],
    modulePath: "families/demo-a/quote.ts",
    exportName: "quoteCapability",
  };
  return sealCapabilityIndex([entry]);
}

function generation(root: string, familyIds: readonly string[]) {
  const definitions = familyIds.map(familyDefinition);
  for (const definition of definitions) addFamilyFiles(root, definition);
  mkdirSync(join(root, "tools", "catalog-generator", "src"), { recursive: true });
  writeFileSync(join(root, "tools", "catalog-generator", "src", "index.ts"), "export const generateCatalog = 1;\n");
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true } }));
  const index = capabilityIndex(root);
  const qualifiedCapabilityRefs = index.entries.map(entry => ({
    capabilityId: asCapabilityId(entry.capabilityId),
    version: asCapabilityVersion(entry.version),
    schemaHash: asSchemaRef(entry.schemaHash),
    interpreterHash: entry.interpreterHash,
    ownerRef: asOwnerRef(h(`${entry.capabilityId}:qualified-owner`)),
  }));
  const families = definitions.map(definition => ({
    definition,
    publicEntry: {
      familyId: definition.manifest.familyId,
      manifestRoot: hashDomain("aloha/family-manifest/v1", definition.manifest),
      modulePath: `families/${definition.manifest.familyId}/public.ts`,
      exportName: "PUBLIC_ENTRY",
    },
  }));
  const releaseIntent = sealReleaseIntent(families.map(item => item.publicEntry), []);
  const modules: Array<{ readonly modulePath: string; readonly exportName: string }> = [
    ...index.entries.map(entry => ({ modulePath: entry.modulePath, exportName: entry.exportName })),
    ...families.flatMap(item => {
      const definition = item.definition;
      return [item.publicEntry, definition.core.nomination, definition.core.identity, definition.core.materialization, definition.core.projection, definition.core.rehydration, ...Object.values(definition.extensions).flatMap(slot => slot.kind === "present" ? [slot.module] : []), ...definition.actionOwners].map(module => ({ modulePath: module.modulePath, exportName: module.exportName }));
    }),
    { modulePath: "tools/catalog-generator/src/index.ts", exportName: "generateCatalog" },
  ];
  const uniqueModules = [...new Map(modules.map(module => [`${module.modulePath}#${module.exportName}`, module] as const)).values()];
  const compilerClosures = uniqueModules.map(module => ({
    ...module,
    entrypointId: `${module.modulePath}#${module.exportName}`,
    closureDigest: h(`closure:${module.modulePath}#${module.exportName}`),
    programInputSetRoot: h(`inputs:${module.modulePath}#${module.exportName}`),
  }));
  return { repositoryRoot: root, releaseIntent, capabilityIndex: index, qualifiedCapabilityRefs, compilerClosures, families, strategies: [] as const };
}

test("generator uses compiler-derived closures and a fresh content ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-catalog-generator-"));
  try {
    const input = generation(root, ["demo-a"]);
    const artifacts = generateCatalog(input);
    assert.match(artifacts.ledger.generatorRecords[0]?.logicalPath ?? "", /tools\/catalog-generator\/src\/index\.ts/);
    assert.ok(artifacts.ledger.compilerRecords.some(record => record.logicalPath === "families/demo-a/quote.ts#quoteCapability"));
    writeGeneratedCatalog(root, artifacts);
    assert.deepEqual(checkGeneratedCatalog(input), []);
    writeFileSync(join(root, "generated", "family-catalog", "index.ts"), `${readFileSync(join(root, "generated", "family-catalog", "index.ts"), "utf8")}\n// stale\n`);
    assert.ok(checkGeneratedCatalog(input).some(error => error === "output-content:generated/family-catalog/index.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adding an unrelated Family changes only aggregate catalog root and leaves old entry byte-stable", () => {
  const firstRoot = mkdtempSync(join(tmpdir(), "aloha-catalog-before-"));
  const secondRoot = mkdtempSync(join(tmpdir(), "aloha-catalog-after-"));
  try {
    const first = generateCatalog(generation(firstRoot, ["demo-a"]));
    const second = generateCatalog(generation(secondRoot, ["demo-a", "demo-b"]));
    assert.deepEqual(second.familyCatalog.entries[0], first.familyCatalog.entries[0]);
    assert.notEqual(second.familyCatalog.definitionCatalogRoot, first.familyCatalog.definitionCatalogRoot);
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("BOM mismatch, unknown entry, duplicate input, and incomplete input fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-catalog-negative-"));
  try {
    const complete = generation(root, ["demo-a"]);
    assert.throws(() => generateCatalog({ ...complete, families: [{ ...complete.families[0]!, definition: familyDefinition("not-in-bom") }] }), /unknown Family|id mismatch/);
    assert.throws(() => generateCatalog({ ...complete, families: [] }), /incomplete Family/);
    assert.throws(() => generateCatalog({ ...complete, families: [complete.families[0]!, complete.families[0]!] }), /duplicate Family/);
    const incompleteIntent = sealReleaseIntent([...complete.releaseIntent.families, {
      familyId: "missing-family",
      manifestRoot: h("missing"),
      modulePath: "families/missing/public.ts",
      exportName: "PUBLIC_ENTRY",
    }], []);
    assert.throws(() => generateCatalog({ ...complete, releaseIntent: incompleteIntent }), /incomplete Family/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler facts are externally bound and self-consistent output plus ledger edits cannot bypass fresh regeneration", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-catalog-compiler-negative-"));
  try {
    const input = generation(root, ["demo-a"]);
    assert.throws(() => generateCatalog({ ...input, compilerClosures: input.compilerClosures.slice(1) }), /closure missing/);
    const changedClosure = generateCatalog({
      ...input,
      compilerClosures: input.compilerClosures.map((fact, index) => index === 0 ? { ...fact, closureDigest: h("forged-closure") } : fact),
    });
    assert.notEqual(changedClosure.ledger.compilerRoot, generateCatalog(input).ledger.compilerRoot);
    const artifacts = generateCatalog(input);
    writeGeneratedCatalog(root, artifacts);
    const familyPath = join(root, "generated", "family-catalog", "index.ts");
    const ledgerPath = join(root, "generated", "catalog-generation.ledger.json");
    writeFileSync(familyPath, `${readFileSync(familyPath, "utf8")}\n// jointly forged\n`);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, unknown>;
    const outputs = ledger.outputs as Array<Record<string, unknown>>;
    outputs[0]!.contentSha256 = h("forged-output");
    ledger.ledgerHash = h("forged-ledger");
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    assert.notDeepEqual(checkGeneratedCatalog(input), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
