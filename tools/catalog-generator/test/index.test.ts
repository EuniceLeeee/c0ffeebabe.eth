import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { asCapabilityId, asCapabilityVersion, asOwnerRef, asSchemaRef } from "../../../packages/capability-contracts/src/index.ts";
import { defineFamily, type FamilyAuthoringDefinitionV1 } from "../../../packages/family-sdk/authoring/index.ts";
import { FAMILY_SEARCH_RUNTIME_ADAPTER_ROLE_V1 } from "../../../packages/family-sdk/search-runtime/index.ts";
import { defineStrategy, type StrategyAuthoringDefinitionV1 } from "../../../packages/strategy-sdk/src/index.ts";
import { sealCapabilityIndex, type CapabilityIndexEntryV1 } from "../../../specs/capability-index/src/index.ts";
import { sealReleaseIntent } from "../../../specs/release-intent/src/index.ts";
import {
  economicValuationOwnerCriticalMutationCorpusRootV1,
  economicValuationOwnerIndependentOracleCaseRootV1,
  economicValuationOwnerQualificationSpecDigestV1,
  type EconomicValuationOwnerDeclarationV1,
} from "../../../specs/economic-valuation-owner/src/index.ts";
import {
  checkGeneratedCatalog,
  checkGeneratedCatalogWithImpact,
  catalogImpactGenesisPriorV1,
  decodeCatalogImpactReceiptV1,
  decodeCatalogImpactPriorV1,
  decodeCatalogImpactSnapshotV1,
  deriveCatalogImpactSnapshotV1,
  encodeCatalogImpactReceiptV1,
  encodeCatalogImpactPriorV1,
  encodeCatalogImpactSnapshotV1,
  generateCatalog,
  generateCatalogWithImpact,
  sealCatalogImpactPriorV1,
  verifyCatalogImpactReceiptV1,
  writeGeneratedCatalog,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/catalog-generator", value);
const impactPrior = (snapshot: Parameters<typeof sealCatalogImpactPriorV1>[1]) => sealCatalogImpactPriorV1("aloha.catalog-impact-advance/v1", snapshot);

function writeModule(root: string, path: string, exportName: string): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, `export const ${exportName} = Object.freeze({ kind: ${JSON.stringify(exportName)} });\n`);
}

function familyDefinition(familyId: string, adapterRoles: readonly string[] = [], includeSearchAdapter = false): FamilyAuthoringDefinitionV1 {
  type CoreKind = "nomination" | "identity" | "materialization" | "projection" | "rehydration";
  const module = <K extends CoreKind>(kind: K) => ({
    modulePath: `families/${familyId}/${kind}.ts`,
    exportName: `${kind}Capability`,
    artifactKind: kind,
    capabilityIds: [asCapabilityId(`family.${familyId}.${kind}`)],
    schemaRefs: [asSchemaRef(h(`${familyId}:${kind}:schema`))],
  }) as { readonly modulePath: string; readonly exportName: string; readonly artifactKind: K; readonly capabilityIds: readonly ReturnType<typeof asCapabilityId>[]; readonly schemaRefs: readonly ReturnType<typeof asSchemaRef>[] };
  const actionOwnerId = `${familyId}.action`;
  const adapter = (name: string) => ({
    modulePath: `families/${familyId}/adapter-${name}.ts`,
    exportName: `adapter${name[0]?.toUpperCase() ?? "X"}Factory`,
    capabilityIds: { quote: asCapabilityId("demo.quote") },
    actionOwnerIds: { execute: actionOwnerId },
  });
  const runtimeAdapters = Object.fromEntries([
    ...(includeSearchAdapter ? [[FAMILY_SEARCH_RUNTIME_ADAPTER_ROLE_V1, adapter("search")] as const] : []),
    ...adapterRoles.map(role => [`other/${role}/v1`, adapter(role)] as const),
  ]);
  return defineFamily({
    manifest: {
      familyId,
      version: "1.0.0",
      pluginCodeHash: h(`${familyId}:plugin`),
      authorityDeclarationHash: h(`${familyId}:authority`),
      sourcePlans: [{
        sourcePlanId: "fixed-cutoff-50-block",
        completeness: "nomination-only",
        historyStartBlock: null,
        schemaHash: asSchemaRef(h(`${familyId}:source-plan-schema`)),
        modulePath: `families/${familyId}/source-plan.ts`,
        exportName: "sourcePlan",
        nominationProgram: {
          kind: "present",
          program: {
            modulePath: `families/${familyId}/nomination-program.ts`,
            exportName: "nominationProgram",
            schemaHash: asSchemaRef(h(`${familyId}:nomination-program-schema`)),
            mutationCorpus: {
              modulePath: `families/${familyId}/nomination-mutations.ts`,
              exportName: "nominationMutations",
            },
            independentOracle: {
              modulePath: `families/${familyId}/nomination-oracle.ts`,
              exportName: "nominationOracle",
            },
          },
        },
      }],
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
      ownerId: actionOwnerId,
      version: asCapabilityVersion("1.0.0"),
      schemaHash: asSchemaRef(h(`${familyId}:action:schema`)),
      implementationHash: h(`${familyId}:action:implementation`),
      actionKinds: ["execute"],
      modulePath: `families/${familyId}/action.ts`,
      exportName: "actionOwner",
    }],
    runtimeAdapters,
    acceptanceDeclarations: [{ factContractId: `${familyId}.facts`, version: asCapabilityVersion("1.0.0"), schemaHash: asSchemaRef(h(`${familyId}:facts`)) }],
  });
}

function addFamilyFiles(root: string, definition: FamilyAuthoringDefinitionV1): void {
  const modules = [definition.core.nomination, definition.core.identity, definition.core.materialization, definition.core.projection, definition.core.rehydration, ...Object.values(definition.extensions).flatMap(slot => slot.kind === "present" ? [slot.module] : []), ...definition.actionOwners, ...Object.values(definition.runtimeAdapters ?? {})];
  for (const module of modules) writeModule(root, module.modulePath, module.exportName);
  for (const plan of definition.manifest.sourcePlans) {
    const target = join(root, plan.modulePath);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "export const " + plan.exportName + " = Object.freeze(" + JSON.stringify({
      sourcePlanId: plan.sourcePlanId,
      completeness: plan.completeness,
      historyStartBlock: plan.historyStartBlock,
      schemaHash: plan.schemaHash,
    }) + ");\n");
    if (plan.nominationProgram.kind === "present") {
      const program = plan.nominationProgram.program;
      for (const module of [program, program.mutationCorpus, program.independentOracle]) {
        writeModule(root, module.modulePath, module.exportName);
      }
    }
  }
  const publicPath = join(root, `families/${definition.manifest.familyId}/public.ts`);
  writeFileSync(publicPath, [
    ...[...modules, ...definition.manifest.sourcePlans]
      .map(module => `export { ${module.exportName} } from "./${module.modulePath.split("/").pop()!}";`),
    "export const PUBLIC_ENTRY = Object.freeze({});",
    "",
  ].join("\n"));
}

function strategyDefinition(strategyId: string): StrategyAuthoringDefinitionV1 {
  const strategyRoot = `strategies/${strategyId}/src/index.ts`;
  return defineStrategy({
    strategyId,
    version: "1.0.0",
    pluginCodeHash: h(`${strategyId}:plugin`),
    requiredCapabilityPredicates: [],
    planningProblemIssuer: {
      modulePath: strategyRoot,
      exportName: "PLANNING_PROBLEM_ISSUER",
      ownerRef: asOwnerRef(h(`${strategyId}:issuer-owner`)),
      implementationHash: h(`${strategyId}:issuer-implementation`),
    },
    constraintSchemaRefs: [asSchemaRef(h(`${strategyId}:constraint`))],
    factContractRefs: [asSchemaRef(h(`${strategyId}:facts`))],
    planningTemplate: {
      kind: "closed-loop-template",
      entryAssetPolicy: "any-graph-asset",
      minLegs: "2",
      maxLegs: "4",
      candidateLimit: "128",
      edgeReuse: "forbid",
      constraintSchemaRefs: [asSchemaRef(h(`${strategyId}:constraint`))],
    },
    modulePath: strategyRoot,
    exportName: "STRATEGY_DEFINITION",
  });
}

function addStrategyFiles(root: string, definition: StrategyAuthoringDefinitionV1): void {
  const target = join(root, definition.modulePath);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, [
    `export const ${definition.exportName} = Object.freeze({});`,
    `export const ${definition.planningProblemIssuer.exportName} = Object.freeze({ issue() { return {}; } });`,
    "",
  ].join("\n"));
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

function generation(root: string, familyIds: readonly string[], adapterRoles: readonly string[] = [], includeSearchAdapter = false, strategyIds: readonly string[] = ["demo-strategy"]) {
  const definitions = familyIds.map(familyId => familyDefinition(
    familyId,
    familyId === "demo-a" ? adapterRoles : [],
    familyId === "demo-a" && includeSearchAdapter,
  ));
  for (const definition of definitions) addFamilyFiles(root, definition);
  const strategyDefinitions = strategyIds.map(strategyId => strategyDefinition(strategyId));
  for (const definition of strategyDefinitions) addStrategyFiles(root, definition);
  mkdirSync(join(root, "tools", "catalog-generator", "src"), { recursive: true });
  writeFileSync(join(root, "tools", "catalog-generator", "src", "index.ts"), "export const generateCatalogWithImpact = 1;\n");
  const valuationQualificationSpec = Object.freeze({ semantics: "test-one-to-one" });
  const valuationMutationCorpus = Object.freeze(["foreign-asset", "source-splice"]);
  const valuationIndependentOracleCases = Object.freeze([Object.freeze({ asset: "native", verdict: "valid" })]);
  const valuationDeclaration: EconomicValuationOwnerDeclarationV1 = Object.freeze({
    ownerRef: h("valuation-owner"),
    modulePath: "valuation-owners/test/src/runtime.ts",
    exportName: "createTestValuationOwner",
    implementationHash: h("valuation-owner-implementation"),
    factSchemaRef: h("valuation-fact-schema"),
    sourceReadCapabilityRefs: Object.freeze([]),
    qualificationModulePath: "valuation-owners/test/src/qualification.ts",
    qualificationSpecExportName: "TEST_VALUATION_QUALIFICATION_SPEC",
    criticalMutationCorpusExportName: "TEST_VALUATION_MUTATION_CORPUS",
    independentOracleCasesExportName: "TEST_VALUATION_ORACLE_CASES",
    qualificationSpecDigest: economicValuationOwnerQualificationSpecDigestV1(valuationQualificationSpec),
    criticalMutationCorpusRoot: economicValuationOwnerCriticalMutationCorpusRootV1(valuationMutationCorpus),
    independentOracleCaseRoot: economicValuationOwnerIndependentOracleCaseRootV1(valuationIndependentOracleCases),
  });
  writeModule(root, valuationDeclaration.modulePath, valuationDeclaration.exportName);
  const valuationQualificationPath = join(root, valuationDeclaration.qualificationModulePath);
  mkdirSync(join(valuationQualificationPath, ".."), { recursive: true });
  writeFileSync(valuationQualificationPath, [
    `export const ${valuationDeclaration.qualificationSpecExportName} = Object.freeze({});`,
    `export const ${valuationDeclaration.criticalMutationCorpusExportName} = Object.freeze([]);`,
    `export const ${valuationDeclaration.independentOracleCasesExportName} = Object.freeze([]);`,
    "",
  ].join("\n"));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true } }));
  const index = capabilityIndex(root);
  const proposedCapabilityRefs = index.entries.map(entry => ({
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
  const strategies = strategyDefinitions.map(definition => ({
    definition,
    publicEntry: {
      strategyId: definition.strategyId,
      manifestRoot: hashDomain("aloha/strategy-manifest/v1", {
        strategyId: definition.strategyId,
        version: definition.version,
        pluginCodeHash: definition.pluginCodeHash,
      }),
      modulePath: definition.modulePath,
      exportName: definition.exportName,
    },
  }));
  const releaseIntent = sealReleaseIntent(
    families.map(item => item.publicEntry),
    strategies.map(item => item.publicEntry),
  );
  const modules: Array<{ readonly modulePath: string; readonly exportName: string }> = [
    ...index.entries.map(entry => ({ modulePath: entry.modulePath, exportName: entry.exportName })),
    ...families.flatMap(item => {
      const definition = item.definition;
      return [
        item.publicEntry,
        definition.core.nomination,
        definition.core.identity,
        definition.core.materialization,
        definition.core.projection,
        definition.core.rehydration,
        ...definition.manifest.sourcePlans,
        ...definition.manifest.sourcePlans.flatMap(plan => plan.nominationProgram.kind === "present"
          ? [plan.nominationProgram.program, plan.nominationProgram.program.mutationCorpus, plan.nominationProgram.program.independentOracle]
          : []),
        ...Object.values(definition.extensions).flatMap(slot => slot.kind === "present" ? [slot.module] : []),
        ...definition.actionOwners,
        ...Object.values(definition.runtimeAdapters ?? {}),
      ].map(module => ({ modulePath: module.modulePath, exportName: module.exportName }));
    }),
    ...strategies.flatMap(item => [
      { modulePath: item.definition.modulePath, exportName: item.definition.exportName },
      {
        modulePath: item.definition.planningProblemIssuer.modulePath,
        exportName: item.definition.planningProblemIssuer.exportName,
      },
    ]),
    { modulePath: valuationDeclaration.modulePath, exportName: valuationDeclaration.exportName },
    { modulePath: valuationDeclaration.qualificationModulePath, exportName: valuationDeclaration.qualificationSpecExportName },
    { modulePath: valuationDeclaration.qualificationModulePath, exportName: valuationDeclaration.criticalMutationCorpusExportName },
    { modulePath: valuationDeclaration.qualificationModulePath, exportName: valuationDeclaration.independentOracleCasesExportName },
    { modulePath: "tools/catalog-generator/src/index.ts", exportName: "generateCatalogWithImpact" },
  ];
  const uniqueModules = [...new Map(modules.map(module => [`${module.modulePath}#${module.exportName}`, module] as const)).values()];
  const compilerClosures = uniqueModules.map(module => ({
    ...module,
    entrypointId: `${module.modulePath}#${module.exportName}`,
    closureDigest: h(`closure:${module.modulePath}#${module.exportName}`),
    programInputSetRoot: h(`inputs:${module.modulePath}#${module.exportName}`),
  }));
  return {
    repositoryRoot: root,
    releaseIntent,
    capabilityIndex: index,
    proposedCapabilityRefs,
    compilerClosures,
    families,
    strategies,
    valuationOwners: [Object.freeze({
      declaration: valuationDeclaration,
      qualificationSpec: valuationQualificationSpec,
      criticalMutationCorpus: valuationMutationCorpus,
      independentOracleCases: valuationIndependentOracleCases,
    })],
  };
}

function withCapability(
  input: ReturnType<typeof generation>,
  root: string,
  capabilityId: string,
  dependencyIds: readonly string[],
  semanticVersion: string,
) {
  const modulePath = `capabilities/${capabilityId}.ts`;
  const exportName = "CAPABILITY";
  writeModule(root, modulePath, exportName);
  const entry = {
    capabilityId,
    version: "1.0.0",
    schemaHash: h(`${capabilityId}:schema:${semanticVersion}`),
    interpreterHash: h(`${capabilityId}:interpreter:${semanticVersion}`),
    dependencyIds,
    modulePath,
    exportName,
  };
  return {
    ...input,
    capabilityIndex: sealCapabilityIndex([...input.capabilityIndex.entries, entry]),
    proposedCapabilityRefs: [...input.proposedCapabilityRefs, {
      capabilityId: asCapabilityId(entry.capabilityId),
      version: asCapabilityVersion(entry.version),
      schemaHash: asSchemaRef(entry.schemaHash),
      interpreterHash: entry.interpreterHash,
      ownerRef: asOwnerRef(h(`${capabilityId}:owner:${semanticVersion}`)),
    }],
    compilerClosures: [...input.compilerClosures, {
      modulePath,
      exportName,
      entrypointId: `${modulePath}#${exportName}`,
      closureDigest: h(`${capabilityId}:closure:${semanticVersion}`),
      programInputSetRoot: h(`${capabilityId}:inputs:${semanticVersion}`),
    }],
  };
}

function withValuationOwner(input: ReturnType<typeof generation>, root: string, name: string) {
  const qualificationSpec = Object.freeze({ semantics: `${name}-valuation` });
  const criticalMutationCorpus = Object.freeze([`${name}-foreign-asset`]);
  const independentOracleCases = Object.freeze([Object.freeze({ asset: name, verdict: "valid" })]);
  const declaration: EconomicValuationOwnerDeclarationV1 = Object.freeze({
    ownerRef: h(`${name}:valuation-owner`),
    modulePath: `valuation-owners/${name}/src/runtime.ts`,
    exportName: "createValuationOwner",
    implementationHash: h(`${name}:valuation-implementation`),
    factSchemaRef: h(`${name}:valuation-fact-schema`),
    sourceReadCapabilityRefs: Object.freeze([]),
    qualificationModulePath: `valuation-owners/${name}/src/qualification.ts`,
    qualificationSpecExportName: "QUALIFICATION_SPEC",
    criticalMutationCorpusExportName: "MUTATION_CORPUS",
    independentOracleCasesExportName: "ORACLE_CASES",
    qualificationSpecDigest: economicValuationOwnerQualificationSpecDigestV1(qualificationSpec),
    criticalMutationCorpusRoot: economicValuationOwnerCriticalMutationCorpusRootV1(criticalMutationCorpus),
    independentOracleCaseRoot: economicValuationOwnerIndependentOracleCaseRootV1(independentOracleCases),
  });
  writeModule(root, declaration.modulePath, declaration.exportName);
  const qualificationPath = join(root, declaration.qualificationModulePath);
  mkdirSync(join(qualificationPath, ".."), { recursive: true });
  writeFileSync(qualificationPath, [
    `export const ${declaration.qualificationSpecExportName} = Object.freeze({});`,
    `export const ${declaration.criticalMutationCorpusExportName} = Object.freeze([]);`,
    `export const ${declaration.independentOracleCasesExportName} = Object.freeze([]);`,
    "",
  ].join("\n"));
  const modules = [
    { modulePath: declaration.modulePath, exportName: declaration.exportName },
    { modulePath: declaration.qualificationModulePath, exportName: declaration.qualificationSpecExportName },
    { modulePath: declaration.qualificationModulePath, exportName: declaration.criticalMutationCorpusExportName },
    { modulePath: declaration.qualificationModulePath, exportName: declaration.independentOracleCasesExportName },
  ];
  return {
    ...input,
    compilerClosures: [...input.compilerClosures, ...modules.map(module => ({
      ...module,
      entrypointId: `${module.modulePath}#${module.exportName}`,
      closureDigest: h(`closure:${module.modulePath}#${module.exportName}`),
      programInputSetRoot: h(`inputs:${module.modulePath}#${module.exportName}`),
    }))],
    valuationOwners: [...input.valuationOwners, Object.freeze({
      declaration,
      qualificationSpec,
      criticalMutationCorpus,
      independentOracleCases,
    })],
  };
}

test("generator uses compiler-derived closures and a fresh content ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-catalog-generator-"));
  try {
    const input = generation(root, ["demo-a"]);
    const artifacts = generateCatalog(input);
    assert.match(artifacts.ledger.generatorRecords[0]?.logicalPath ?? "", /tools\/catalog-generator\/src\/index\.ts/);
    assert.ok(artifacts.ledger.compilerRecords.some(record => record.logicalPath === "families/demo-a/quote.ts#quoteCapability"));
    assert.equal(artifacts.familyRuntimeDescriptor.families.length, 1);
    assert.equal(artifacts.familyRuntimeDescriptor.families[0]?.entry.familyId, "demo-a");
    assert.equal(artifacts.familyRuntimeDescriptor.families[0]?.entry.lifecycleRefs.identity.capabilityId, "family.demo-a.identity");
    assert.equal(artifacts.familyRuntimeDescriptor.families[0]?.entry.lifecycleRefs.identity.schemaHash, h("demo-a:identity:schema"));
    assert.equal(artifacts.strategyCatalog.entries.length, 1);
    assert.equal(artifacts.strategyCatalog.entries[0]?.strategyId, "demo-strategy");
    assert.equal(artifacts.strategyRuntimeDescriptor.strategies.length, 1);
    assert.equal(artifacts.strategyRuntimeDescriptor.strategies[0]?.catalogEntry.strategyId, "demo-strategy");
    assert.equal(artifacts.familyRuntimeDescriptor.definitionCatalogRoot, artifacts.globalDefinitionCatalogRoot);
    assert.equal(artifacts.strategyRuntimeDescriptor.definitionCatalogRoot, artifacts.globalDefinitionCatalogRoot);
    assert.match(artifacts.familyRuntimeCompositionText, /FAMILY_0_IDENTITY_DEFINITION/);
    assert.match(artifacts.familyRuntimeCompositionText, /families\/demo-a\/public\.ts/);
    const familyImports = artifacts.familyRuntimeCompositionText.split("\n").filter(line => line.startsWith("import ") && line.includes("families/"));
    assert.ok(familyImports.length > 5);
    assert.ok(familyImports.some(line => line.includes("/public.ts\";")));
    assert.match(artifacts.familyRuntimeCompositionText, /nomination-program\.ts/);
    assert.ok(familyImports.every(line => !/nomination-mutations\.ts|nomination-oracle\.ts/.test(line)));
    assert.match(artifacts.familyRuntimeCompositionText, /export const createReleaseFamilyRuntimeComposition/);
    assert.match(artifacts.familyRuntimeCompositionText, /createReleaseStrategyRuntimeComposition/);
    assert.match(artifacts.familyRuntimeCompositionText, /STRATEGY_0_PLANNING_PROBLEM_ISSUER/);
    assert.match(artifacts.familyRuntimeCompositionText, /strategies\/demo-strategy\/src\/index\.ts/);
    assert.match(artifacts.familyRuntimeCompositionText, /createGeneratedFamilyRuntimeFactory/);
    assert.equal(artifacts.valuationOwnerRegistry.entries.length, 1);
    assert.match(artifacts.valuationOwnerRegistryText, /valuation-owners\/test\/src\/runtime\.ts/);
    assert.match(artifacts.valuationOwnerRegistryText, /joinEconomicValuationOwnerQualificationSetV1/);
    assert.doesNotMatch(artifacts.valuationOwnerRegistryText, /packages\/economics-safety\/src\/evaluator\.ts/);
    const valuationRuntimeImports = artifacts.valuationOwnerRegistryText.split("\n").filter(line => line.startsWith("import "));
    assert.ok(valuationRuntimeImports.every(line => !/qualification\.ts|MUTATION_CORPUS|ORACLE_CASES/.test(line)));
    assert.ok(artifacts.ledger.outputPaths.includes("generated/valuation-owner-registry/index.ts"));
    assert.doesNotMatch(artifacts.familyRuntimeCompositionText, /export const FAMILY_RUNTIME_DESCRIPTOR/);
    assert.doesNotMatch(artifacts.familyRuntimeCompositionText, /GeneratedFamilyRuntimeAuthorityBindingV1\[\]/);
    writeGeneratedCatalog(root, artifacts);
    assert.deepEqual(checkGeneratedCatalog(input), []);
    writeFileSync(join(root, "generated", "family-catalog", "index.ts"), `${readFileSync(join(root, "generated", "family-catalog", "index.ts"), "utf8")}\n// stale\n`);
    assert.ok(checkGeneratedCatalog(input).some(error => error === "output-content:generated/family-catalog/index.ts"));
    writeFileSync(
      join(root, "generated", "runtime-composition", "index.ts"),
      readFileSync(join(root, "generated", "runtime-composition", "index.ts"), "utf8") + "\n// stale\n",
    );
    assert.ok(checkGeneratedCatalog(input).some(error => error === "output-content:generated/runtime-composition/index.ts"));
    writeFileSync(
      join(root, "generated", "valuation-owner-registry", "index.ts"),
      readFileSync(join(root, "generated", "valuation-owner-registry", "index.ts"), "utf8") + "\n// stale\n",
    );
    assert.ok(checkGeneratedCatalog(input).some(error => error === "output-content:generated/valuation-owner-registry/index.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adding an unrelated valuation owner changes only aggregate registry roots and preserves the existing leaf", () => {
  const beforeRoot = mkdtempSync(join(tmpdir(), "aloha-valuation-before-"));
  const afterRoot = mkdtempSync(join(tmpdir(), "aloha-valuation-after-"));
  try {
    const beforeInput = generation(beforeRoot, ["demo-a"]);
    const afterInput = withValuationOwner(generation(afterRoot, ["demo-a"]), afterRoot, "future");
    const before = generateCatalog(beforeInput);
    const after = generateCatalog(afterInput);
    const existingOwnerRef = before.valuationOwnerRegistry.entries[0]!.ownerRef;
    assert.equal(
      after.valuationOwnerRegistry.entries.find(entry => entry.ownerRef === existingOwnerRef)?.qualificationLeafDigest,
      before.valuationOwnerRegistry.entries[0]!.qualificationLeafDigest,
    );
    assert.notEqual(after.valuationOwnerRegistry.valuationOwnerRegistryRoot, before.valuationOwnerRegistry.valuationOwnerRegistryRoot);
    assert.equal(after.familyRuntimeDescriptor.descriptorRoot, before.familyRuntimeDescriptor.descriptorRoot);
    assert.equal(after.strategyRuntimeDescriptor.descriptorRoot, before.strategyRuntimeDescriptor.descriptorRoot);
  } finally {
    rmSync(beforeRoot, { recursive: true, force: true });
    rmSync(afterRoot, { recursive: true, force: true });
  }
});

test("adding an unrelated Family changes only aggregate catalog root and leaves old entry byte-stable", () => {
  const firstRoot = mkdtempSync(join(tmpdir(), "aloha-catalog-before-"));
  const secondRoot = mkdtempSync(join(tmpdir(), "aloha-catalog-after-"));
  try {
    const first = generateCatalog(generation(firstRoot, ["demo-a"]));
    const second = generateCatalog(generation(secondRoot, ["demo-a", "demo-b"]));
    assert.deepEqual(second.familyCatalog.entries[0], first.familyCatalog.entries[0]);
    assert.deepEqual(second.familyRuntimeDescriptor.families[0], first.familyRuntimeDescriptor.families[0]);
    assert.equal(
      second.familyRuntimeDescriptor.families[0]!.sourcePlans[0]!.nominationProgramProposal.proposalLeafDigest,
      first.familyRuntimeDescriptor.families[0]!.sourcePlans[0]!.nominationProgramProposal.proposalLeafDigest,
    );
    assert.notEqual(second.familyRuntimeDescriptor.nominationProgramSetRoot, first.familyRuntimeDescriptor.nominationProgramSetRoot);
    assert.notEqual(second.familyCatalog.definitionCatalogRoot, first.familyCatalog.definitionCatalogRoot);
    assert.notEqual(second.familyRuntimeDescriptor.descriptorRoot, first.familyRuntimeDescriptor.descriptorRoot);
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("adding an unrelated Strategy changes only aggregate Strategy/global roots and preserves existing leaves", () => {
  const firstRoot = mkdtempSync(join(tmpdir(), "aloha-strategy-before-"));
  const secondRoot = mkdtempSync(join(tmpdir(), "aloha-strategy-after-"));
  try {
    const first = generateCatalog(generation(firstRoot, ["demo-a"], [], false, ["demo-strategy"]));
    const second = generateCatalog(generation(secondRoot, ["demo-a"], [], false, ["demo-strategy", "future-strategy"]));
    assert.deepEqual(second.familyCatalog.entries[0], first.familyCatalog.entries[0]);
    assert.deepEqual(second.strategyCatalog.entries[0], first.strategyCatalog.entries[0]);
    assert.deepEqual(second.strategyRuntimeDescriptor.strategies[0], first.strategyRuntimeDescriptor.strategies[0]);
    assert.notEqual(second.strategyCatalog.definitionCatalogRoot, first.strategyCatalog.definitionCatalogRoot);
    assert.notEqual(second.globalDefinitionCatalogRoot, first.globalDefinitionCatalogRoot);
    assert.notEqual(second.strategyRuntimeDescriptor.descriptorRoot, first.strategyRuntimeDescriptor.descriptorRoot);
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("an empty Strategy BOM is rejected by the release generator", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-empty-strategy-"));
  try {
    const complete = generation(root, ["demo-a"]);
    assert.throws(() => generateCatalog({
      ...complete,
      strategies: [],
      releaseIntent: sealReleaseIntent(complete.releaseIntent.families, []),
    }), /empty Strategy BOM/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adding an unrelated runtime-adapter role preserves the existing adapter leaf digest", () => {
  const firstRoot = mkdtempSync(join(tmpdir(), "aloha-adapter-before-"));
  const secondRoot = mkdtempSync(join(tmpdir(), "aloha-adapter-after-"));
  try {
    const first = generateCatalog(generation(firstRoot, ["demo-a"], ["one"], true));
    const second = generateCatalog(generation(secondRoot, ["demo-a"], ["one", "two"], true));
    const firstAdapter = first.familyRuntimeDescriptor.families[0]!.runtimeAdapters.find(adapter => adapter.role === FAMILY_SEARCH_RUNTIME_ADAPTER_ROLE_V1);
    const secondAdapter = second.familyRuntimeDescriptor.families[0]!.runtimeAdapters.find(adapter => adapter.role === FAMILY_SEARCH_RUNTIME_ADAPTER_ROLE_V1);
    assert.ok(firstAdapter);
    assert.ok(secondAdapter);
    assert.equal(secondAdapter.leafDigest, firstAdapter.leafDigest);
    assert.notEqual(second.familyRuntimeDescriptor.descriptorRoot, first.familyRuntimeDescriptor.descriptorRoot);
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
    assert.throws(() => generateCatalog({ ...complete, families: [], strategies: [] }), /incomplete Family/);
    assert.throws(() => generateCatalog({ ...complete, families: [complete.families[0]!, complete.families[0]!] }), /duplicate Family/);
    const incompleteIntent = sealReleaseIntent([...complete.releaseIntent.families, {
      familyId: "missing-family",
      manifestRoot: h("missing"),
      modulePath: "families/missing/public.ts",
      exportName: "PUBLIC_ENTRY",
    }], complete.releaseIntent.strategies);
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

test("content-addressed impact receipt preserves exact unrelated artifact-to-proposal mapping", () => {
  const beforeRoot = mkdtempSync(join(tmpdir(), "aloha-impact-before-"));
  const afterRoot = mkdtempSync(join(tmpdir(), "aloha-impact-after-"));
  try {
    const beforeInput = generation(beforeRoot, ["demo-a"]);
    const beforeArtifacts = generateCatalog(beforeInput);
    const before = deriveCatalogImpactSnapshotV1(beforeInput, beforeArtifacts);
    assert.deepEqual(decodeCatalogImpactSnapshotV1(encodeCatalogImpactSnapshotV1(before)), before);
    const prior = impactPrior(before);
    const after = generateCatalogWithImpact(generation(afterRoot, ["demo-a", "demo-b"]), prior);
    assert.deepEqual(after.impactReceipt.changedCapabilityIds, []);
    assert.deepEqual(after.impactReceipt.changedCapabilityClosure, []);
    assert.deepEqual(after.impactReceipt.affectedArtifactIds, ["family:demo-b"]);
    assert.deepEqual(after.impactReceipt.affectedFamilyIds, ["demo-b"]);
    const priorDemo = before.artifacts.find(value => value.artifactId === "family:demo-a")!;
    const { nominationProposalLeafDigests: legacyRoots, ...legacyArtifact } = priorDemo;
    assert.throws(() => decodeCatalogImpactSnapshotV1({
      ...before,
      artifacts: before.artifacts.map(value => value.artifactId === priorDemo.artifactId
        ? { ...legacyArtifact, qualificationRoots: legacyRoots }
        : value),
    }), /unknown field|non-exact keys/);
    assert.deepEqual(after.impactReceipt.reusableArtifacts.find(value => value.artifactId === priorDemo.artifactId), {
      artifactId: priorDemo.artifactId,
      artifactKind: priorDemo.artifactKind,
      familyId: priorDemo.familyId,
      memoRoot: priorDemo.memoRoot,
      nominationProposalLeafDigests: priorDemo.nominationProposalLeafDigests,
    });
    assert.notEqual(after.impactReceipt.beforeDefinitionCatalogRoot, after.impactReceipt.afterDefinitionCatalogRoot);
    assert.deepEqual(decodeCatalogImpactReceiptV1(encodeCatalogImpactReceiptV1(after.impactReceipt)), after.impactReceipt);
    writeGeneratedCatalog(afterRoot, after);
    assert.deepEqual(checkGeneratedCatalogWithImpact(generation(afterRoot, ["demo-a", "demo-b"]), prior), []);
    assert.ok(after.ledger.outputs.some(value => value.path === "generated/catalog-impact.receipt.json" && value.catalogRoot === after.impactReceipt.receiptRoot));
    const receiptPath = join(afterRoot, "generated", "catalog-impact.receipt.json");
    writeFileSync(receiptPath, `${readFileSync(receiptPath, "utf8")}\n`);
    assert.ok(checkGeneratedCatalogWithImpact(generation(afterRoot, ["demo-a", "demo-b"]), prior).includes("output-content:generated/catalog-impact.receipt.json"));
    rmSync(receiptPath);
    assert.ok(checkGeneratedCatalogWithImpact(generation(afterRoot, ["demo-a", "demo-b"]), prior).includes("missing-output:generated/catalog-impact.receipt.json"));
  } finally {
    rmSync(beforeRoot, { recursive: true, force: true });
    rmSync(afterRoot, { recursive: true, force: true });
  }
});

test("explicit greenfield genesis affects every first-release artifact and the next unchanged release reuses all roots", () => {
  const firstRoot = mkdtempSync(join(tmpdir(), "aloha-impact-genesis-first-"));
  const secondRoot = mkdtempSync(join(tmpdir(), "aloha-impact-genesis-second-"));
  try {
    const firstInput = generation(firstRoot, ["demo-a"]);
    const genesis = catalogImpactGenesisPriorV1();
    assert.deepEqual(decodeCatalogImpactPriorV1(encodeCatalogImpactPriorV1(genesis)), genesis);
    const first = generateCatalogWithImpact(firstInput, genesis);
    assert.equal(genesis.origin, "aloha.greenfield-genesis/v1");
    assert.deepEqual(first.impactReceipt.changedCapabilityIds, ["demo.quote"]);
    assert.deepEqual(first.impactReceipt.affectedArtifactIds, ["family:demo-a", "strategy:demo-strategy"]);
    assert.deepEqual(first.impactReceipt.affectedFamilyIds, ["demo-a"]);
    assert.deepEqual(first.impactReceipt.reusableArtifacts, []);
    assert.deepEqual(first.ledger.inputRecords.filter(value => value.path.startsWith("input/prior-catalog-impact-")).map(value => value.path), [
      "input/prior-catalog-impact-identity",
      "input/prior-catalog-impact-pin",
      "input/prior-catalog-impact-snapshot",
    ]);

    const secondInput = generation(secondRoot, ["demo-a"]);
    const second = generateCatalogWithImpact(secondInput, impactPrior(first.impactSnapshot));
    assert.deepEqual(second.impactReceipt.changedCapabilityIds, []);
    assert.deepEqual(second.impactReceipt.changedCapabilityClosure, []);
    assert.deepEqual(second.impactReceipt.affectedArtifactIds, []);
    assert.deepEqual(second.impactReceipt.affectedFamilyIds, []);
    assert.deepEqual(second.impactReceipt.reusableArtifacts.map(value => value.artifactId), first.impactSnapshot.artifacts.map(value => value.artifactId));
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("unrequested capability changes stay local while a shared dependency mutation expands through the real closure", () => {
  const unusedBeforeRoot = mkdtempSync(join(tmpdir(), "aloha-impact-unused-before-"));
  const unusedAfterRoot = mkdtempSync(join(tmpdir(), "aloha-impact-unused-after-"));
  const sharedBeforeRoot = mkdtempSync(join(tmpdir(), "aloha-impact-shared-before-"));
  const sharedAfterRoot = mkdtempSync(join(tmpdir(), "aloha-impact-shared-after-"));
  try {
    const unusedBeforeInput = withCapability(generation(unusedBeforeRoot, ["demo-a"]), unusedBeforeRoot, "demo.unused", [], "v1");
    const unusedBefore = deriveCatalogImpactSnapshotV1(unusedBeforeInput, generateCatalog(unusedBeforeInput));
    const unusedAfterInput = withCapability(generation(unusedAfterRoot, ["demo-a"]), unusedAfterRoot, "demo.unused", [], "v2");
    const unusedAfter = generateCatalogWithImpact(unusedAfterInput, impactPrior(unusedBefore));
    assert.deepEqual(unusedAfter.impactReceipt.changedCapabilityIds, ["demo.unused"]);
    assert.deepEqual(unusedAfter.impactReceipt.changedCapabilityClosure, ["demo.unused"]);
    assert.deepEqual(unusedAfter.impactReceipt.affectedArtifactIds, []);
    assert.ok(unusedAfter.impactReceipt.reusableArtifacts.length >= 2);

    const sharedInput = (root: string, version: string) => {
      const base = withCapability(generation(root, ["demo-a"]), root, "demo.shared", [], version);
      return {
        ...base,
        capabilityIndex: sealCapabilityIndex(base.capabilityIndex.entries.map(entry => entry.capabilityId === "demo.quote"
          ? { ...entry, dependencyIds: ["demo.shared"] }
          : entry)),
      };
    };
    const sharedBeforeInput = sharedInput(sharedBeforeRoot, "v1");
    const sharedBefore = deriveCatalogImpactSnapshotV1(sharedBeforeInput, generateCatalog(sharedBeforeInput));
    const sharedAfterInput = sharedInput(sharedAfterRoot, "v2");
    const sharedAfter = generateCatalogWithImpact(sharedAfterInput, impactPrior(sharedBefore));
    assert.deepEqual(sharedAfter.impactReceipt.changedCapabilityIds, ["demo.shared"]);
    assert.deepEqual(sharedAfter.impactReceipt.changedCapabilityClosure, ["demo.quote", "demo.shared"]);
    assert.deepEqual(sharedAfter.impactReceipt.affectedArtifactIds, ["family:demo-a"]);
    assert.deepEqual(sharedAfter.impactReceipt.affectedFamilyIds, ["demo-a"]);
    assert.ok(sharedAfter.impactReceipt.reusableArtifacts.some(value =>
      value.artifactId === "strategy:demo-strategy"
      && value.memoRoot === sharedBefore.artifacts.find(item => item.artifactId === "strategy:demo-strategy")!.memoRoot,
    ));
  } finally {
    for (const root of [unusedBeforeRoot, unusedAfterRoot, sharedBeforeRoot, sharedAfterRoot]) rmSync(root, { recursive: true, force: true });
  }
});

test("impact reuse claims cannot be substituted or forged and a pinned prior snapshot is mandatory", () => {
  const beforeRoot = mkdtempSync(join(tmpdir(), "aloha-impact-forgery-before-"));
  const afterRoot = mkdtempSync(join(tmpdir(), "aloha-impact-forgery-after-"));
  try {
    const beforeInput = generation(beforeRoot, ["demo-a"]);
    const before = deriveCatalogImpactSnapshotV1(beforeInput, generateCatalog(beforeInput));
    assert.throws(() => decodeCatalogImpactSnapshotV1({ ...before, snapshotRoot: h("forged-snapshot") }), /snapshot root mismatch/);
    const afterInput = generation(afterRoot, ["demo-a", "demo-b"]);
    const prior = impactPrior(before);
    const after = generateCatalogWithImpact(afterInput, prior);
    assert.throws(() => generateCatalogWithImpact(afterInput, undefined as never), /pinned prior/);
    assert.throws(() => generateCatalogWithImpact(afterInput, { ...prior, pinnedSnapshotRoot: h("wrong-prior") }), /prior pin/);
    const forged = {
      ...after.impactReceipt,
      affectedArtifactIds: [],
      reusableArtifacts: [...after.impactReceipt.reusableArtifacts, {
        artifactId: "family:demo-b",
        artifactKind: "family" as const,
        familyId: "demo-b",
        memoRoot: after.impactSnapshot.artifacts.find(value => value.artifactId === "family:demo-b")!.memoRoot,
        nominationProposalLeafDigests: after.impactSnapshot.artifacts.find(value => value.artifactId === "family:demo-b")!.nominationProposalLeafDigests,
      }].sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
    };
    assert.throws(() => decodeCatalogImpactReceiptV1(forged), /receipt root mismatch/);
    const unrelatedAfterInput = generation(afterRoot, ["demo-a"]);
    const unrelatedAfterArtifacts = generateCatalog(unrelatedAfterInput);
    const unrelatedAfter = deriveCatalogImpactSnapshotV1(unrelatedAfterInput, unrelatedAfterArtifacts);
    assert.throws(() => verifyCatalogImpactReceiptV1({
      receipt: after.impactReceipt,
      pinnedBeforeSnapshotRoot: before.snapshotRoot,
      before,
      after: unrelatedAfter,
    }), /does not match/);
    assert.throws(() => decodeCatalogImpactReceiptV1({ ...after.impactReceipt, callerVerdict: "pass" }), /exact keys|unknown/i);
  } finally {
    rmSync(beforeRoot, { recursive: true, force: true });
    rmSync(afterRoot, { recursive: true, force: true });
  }
});
