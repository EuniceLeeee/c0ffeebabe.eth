import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import {
  catalogCompilerClosureFactKey,
  sealCatalogCompilerClosureFacts,
  type CatalogCompilerClosureFactV1,
} from "../../../specs/catalog-compiler/src/index.ts";
import {
  asCapabilityId,
  asCapabilityVersion,
  asOwnerRef,
  asSchemaRef,
  type CapabilityId,
  type CapabilityRefV1,
  type OwnerRef,
  type SchemaRef,
} from "../../../packages/capability-contracts/src/index.ts";
import {
  familyAuthoringDigest,
  normalizeFamilyDefinition,
  type FamilyAuthoringDefinitionV1,
  type ModuleEntrypointV1,
} from "../../../packages/family-sdk/authoring/index.ts";
import {
  strategyAuthoringDigest,
  compileStrategy,
  normalizeStrategyDefinition,
  type StrategyAuthoringDefinitionV1,
  type GeneratedStrategyCatalogLeafV1,
} from "../../../packages/strategy-sdk/src/index.ts";
import {
  catalogLeafDigest,
  dependencyLeafDigest,
  artifactDependencyRoot,
  type CatalogLeafV1,
  type DependencyLeafV1,
} from "../../../packages/artifact-fingerprint/src/pure/index.ts";
import type { Hash } from "../../../packages/canonical-codec/src/index.ts";
import { type CapabilityIndexV1 } from "../../../specs/capability-index/src/index.ts";
import {
  type FamilyReleaseIntentEntryV1,
  type ReleaseIntentV1,
  type StrategyReleaseIntentEntryV1,
} from "../../../specs/release-intent/src/index.ts";

export interface FamilyGenerationInputV1 {
  readonly definition: FamilyAuthoringDefinitionV1;
  readonly publicEntry: FamilyReleaseIntentEntryV1;
}

export interface StrategyGenerationInputV1 {
  readonly definition: StrategyAuthoringDefinitionV1;
  readonly publicEntry: StrategyReleaseIntentEntryV1;
}

export interface CatalogGenerationInputV1 {
  readonly repositoryRoot: string;
  readonly releaseIntent: ReleaseIntentV1;
  readonly capabilityIndex: CapabilityIndexV1;
  /** Release-qualified, owner-issued refs. The generator may bind but never mint them. */
  readonly qualifiedCapabilityRefs: readonly CapabilityRefV1[];
  readonly compilerClosures: readonly CatalogCompilerClosureFactV1[];
  readonly families: readonly FamilyGenerationInputV1[];
  readonly strategies: readonly StrategyGenerationInputV1[];
}

export interface GeneratedFamilyCatalogV1 {
  readonly schemaVersion: 1;
  readonly releaseIntentRoot: Hash;
  readonly capabilityIndexRoot: Hash;
  readonly entries: readonly import("../../../packages/family-sdk/runtime-refs/index.ts").GeneratedFamilyEntryV1[];
  readonly definitionCatalogRoot: Hash;
}

export interface GeneratedStrategyCatalogV1 {
  readonly schemaVersion: 1;
  readonly releaseIntentRoot: Hash;
  readonly capabilityIndexRoot: Hash;
  readonly entries: readonly GeneratedStrategyCatalogLeafV1[];
  readonly definitionCatalogRoot: Hash;
}

export interface GeneratedCatalogArtifactsV1 {
  readonly familyCatalog: GeneratedFamilyCatalogV1;
  readonly strategyCatalog: GeneratedStrategyCatalogV1;
  readonly familyCatalogText: string;
  readonly strategyCatalogText: string;
  readonly outputRoot: Hash;
  readonly ledger: CatalogGenerationLedgerV1;
  readonly ledgerText: string;
}

export interface CatalogContentRecordV1 {
  readonly path: string;
  readonly contentSha256: Hash;
  readonly byteLength: number;
}

export interface CatalogGenerationLedgerV1 {
  readonly schemaVersion: 1;
  readonly outputPaths: readonly string[];
  readonly inputRecords: readonly CatalogContentRecordV1[];
  readonly compilerRecords: readonly CompilerRecordV1[];
  readonly generatorRecords: readonly CompilerRecordV1[];
  readonly outputs: readonly (CatalogContentRecordV1 & { readonly catalogRoot: Hash })[];
  readonly inputRoot: Hash;
  readonly compilerRoot: Hash;
  readonly generatorRoot: Hash;
  readonly ledgerHash: Hash;
}

interface CompilerRecordV1 {
  readonly logicalPath: string;
  readonly contentSha256: Hash;
  readonly byteLength: number;
  readonly sourceKind: "tracked" | "typescript-lib" | "external";
}
const HASH_RE = /^0x[0-9a-f]{64}$/;

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  throw new TypeError(`non-canonical generator value ${typeof value}`);
}

function hashDomain(domain: string, value: unknown): Hash {
  return `0x${createHash("sha256").update(domain).update("\0").update(canonical(value)).digest("hex")}`;
}

function bytesHash(value: Buffer | string): Hash {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function repoPath(root: string, candidate: string): string {
  const absolute = resolve(root, candidate);
  const path = relative(root, absolute).split(sep).join("/");
  if (path === "" || path === ".." || path.startsWith("../") || path.startsWith("/")) throw new TypeError(`source path escapes repository: ${candidate}`);
  return path;
}

function sourceText(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new TypeError(`source entrypoint missing: ${path}`);
  return readFileSync(absolute, "utf8");
}

interface CompilerClosureV1 {
  readonly root: Hash;
  readonly entrypointId: string;
  readonly programInputSetRoot: Hash;
}

function compilerClosure(facts: readonly CatalogCompilerClosureFactV1[], entrypoint: ModuleEntrypointV1): CompilerClosureV1 {
  const key = catalogCompilerClosureFactKey(entrypoint);
  const fact = facts.find(candidate => catalogCompilerClosureFactKey(candidate) === key);
  if (fact === undefined) throw new TypeError(`qualified catalog compiler closure missing ${key}`);
  return Object.freeze({ root: fact.closureDigest, entrypointId: fact.entrypointId, programInputSetRoot: fact.programInputSetRoot });
}

const FAMILY_OUTPUT_PATH = "generated/family-catalog/index.ts";
const STRATEGY_OUTPUT_PATH = "generated/strategy-catalog/index.ts";
const LEDGER_OUTPUT_PATH = "generated/catalog-generation.ledger.json";
const GENERATOR_ENTRYPOINT: ModuleEntrypointV1 = Object.freeze({ modulePath: "tools/catalog-generator/src/index.ts", exportName: "generateCatalog" });

function canonicalRecord(path: string, value: unknown): CatalogContentRecordV1 {
  const text = canonical(value);
  return Object.freeze({ path, contentSha256: bytesHash(text), byteLength: Buffer.byteLength(text) });
}

function ledgerWithoutHash(ledger: Omit<CatalogGenerationLedgerV1, "ledgerHash">): Hash {
  return hashDomain("aloha/catalog-generation-ledger/v1", ledger);
}

function renderLedger(ledger: CatalogGenerationLedgerV1): string {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

function assertLedgerShape(value: unknown): CatalogGenerationLedgerV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("catalog ledger must be an object");
  const record = value as Record<string, unknown>;
  const expected = ["schemaVersion", "outputPaths", "inputRecords", "compilerRecords", "generatorRecords", "outputs", "inputRoot", "compilerRoot", "generatorRoot", "ledgerHash"].sort();
  const actual = Object.keys(record).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new TypeError("catalog ledger has non-exact keys");
  if (record.schemaVersion !== 1 || !Array.isArray(record.outputPaths) || !Array.isArray(record.inputRecords) || !Array.isArray(record.compilerRecords) || !Array.isArray(record.generatorRecords) || !Array.isArray(record.outputs)) throw new TypeError("catalog ledger shape invalid");
  const hash = (value: unknown, path: string): Hash => {
    if (typeof value !== "string" || !HASH_RE.test(value)) throw new TypeError(`invalid ledger hash ${path}`);
    return value as Hash;
  };
  const content = (value: unknown, path: string): CatalogContentRecordV1 => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`invalid ledger content ${path}`);
    const item = value as Record<string, unknown>;
    const keys = Object.keys(item).sort();
    if (JSON.stringify(keys) !== JSON.stringify(["byteLength", "contentSha256", "path"])) throw new TypeError(`invalid ledger content keys ${path}`);
    if (typeof item.path !== "string" || typeof item.byteLength !== "number" || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0) throw new TypeError(`invalid ledger content ${path}`);
    return Object.freeze({ path: item.path, contentSha256: hash(item.contentSha256, `${path}.contentSha256`), byteLength: item.byteLength as number });
  };
  const output = (value: unknown, path: string): CatalogContentRecordV1 & { readonly catalogRoot: Hash } => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`invalid ledger output ${path}`);
    const item = value as Record<string, unknown>;
    const keys = Object.keys(item).sort();
    if (JSON.stringify(keys) !== JSON.stringify(["byteLength", "catalogRoot", "contentSha256", "path"])) throw new TypeError(`invalid ledger output keys ${path}`);
    const base = content({ path: item.path, contentSha256: item.contentSha256, byteLength: item.byteLength }, path);
    return Object.freeze({ ...base, catalogRoot: hash(item.catalogRoot, `${path}.catalogRoot`) });
  };
  const compiler = (value: unknown, path: string): CompilerRecordV1 => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`invalid compiler record ${path}`);
    const item = value as Record<string, unknown>;
    const keys = Object.keys(item).sort();
    if (JSON.stringify(keys) !== JSON.stringify(["byteLength", "contentSha256", "logicalPath", "sourceKind"])) throw new TypeError(`invalid compiler record keys ${path}`);
    if (typeof item.logicalPath !== "string" || typeof item.byteLength !== "number" || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0 || !["tracked", "typescript-lib", "external"].includes(item.sourceKind as string)) throw new TypeError(`invalid compiler record ${path}`);
    return Object.freeze({ logicalPath: item.logicalPath, contentSha256: hash(item.contentSha256, `${path}.contentSha256`), byteLength: item.byteLength as number, sourceKind: item.sourceKind as CompilerRecordV1["sourceKind"] });
  };
  const outputs = (record.outputs as readonly unknown[]).map((item, index) => {
    return output(item, `outputs[${index}]`);
  });
  const result = Object.freeze({
    schemaVersion: 1 as const,
    outputPaths: Object.freeze((record.outputPaths as readonly unknown[]).map((item, index) => {
      if (typeof item !== "string") throw new TypeError(`invalid output path ${index}`);
      return item;
    })),
    inputRecords: Object.freeze((record.inputRecords as readonly unknown[]).map((item, index) => content(item, `inputRecords[${index}]`))),
    compilerRecords: Object.freeze((record.compilerRecords as readonly unknown[]).map((item, index) => compiler(item, `compilerRecords[${index}]`))),
    generatorRecords: Object.freeze((record.generatorRecords as readonly unknown[]).map((item, index) => compiler(item, `generatorRecords[${index}]`))),
    outputs: Object.freeze(outputs),
    inputRoot: hash(record.inputRoot, "inputRoot"),
    compilerRoot: hash(record.compilerRoot, "compilerRoot"),
    generatorRoot: hash(record.generatorRoot, "generatorRoot"),
    ledgerHash: hash(record.ledgerHash, "ledgerHash"),
  });
  const { ledgerHash, ...withoutHash } = result;
  if (ledgerWithoutHash(withoutHash) !== ledgerHash) throw new TypeError("catalog ledger hash mismatch");
  return result;
}

function assertStaticEntrypoint(root: string, binding: ModuleEntrypointV1): string {
  const path = repoPath(root, binding.modulePath);
  if (binding.modulePath.startsWith(".") || binding.modulePath.startsWith("/") || binding.modulePath.includes("..") || binding.modulePath.includes("\\") || binding.modulePath.includes("?") || binding.modulePath.includes("#")) throw new TypeError(`non-static entrypoint ${binding.modulePath}`);
  const source = ts.createSourceFile(path, sourceText(root, path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exported = new Set<string>();
  for (const statement of source.statements) {
    const hasExport = Boolean((statement as ts.Node & { readonly modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
    if (!hasExport) continue;
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) exported.add(declaration.name.text);
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name) exported.add(statement.name.text);
  }
  if (!exported.has(binding.exportName)) throw new TypeError(`entrypoint does not directly export ${path}#${binding.exportName}`);
  return path;
}

function capabilityLeaves(compilerFacts: readonly CatalogCompilerClosureFactV1[], index: CapabilityIndexV1): readonly DependencyLeafV1[] {
  return Object.freeze(index.entries.map(entry => ({
    id: entry.capabilityId,
    version: entry.version,
    schemaHash: entry.schemaHash,
    interpreterHash: entry.interpreterHash,
    dependencyIds: entry.dependencyIds,
    implementationClosureRoot: compilerClosure(compilerFacts, { modulePath: entry.modulePath, exportName: entry.exportName }).root,
  })));
}

function ownerRef(domain: string, value: unknown): OwnerRef {
  return asOwnerRef(hashDomain(domain, value));
}

function stageRef(
  familyId: string,
  familyDefinitionHash: Hash,
  stage: "nomination" | "identity" | "materialization" | "projection" | "rehydration" | "capability",
  module: ModuleEntrypointV1,
  closureRoot: Hash,
  capabilityId: string,
  capabilityVersion: string,
  schemaHash: Hash,
): import("../../../packages/family-sdk/runtime-refs/index.ts").StageCapabilityRefV1 {
  return Object.freeze({
    familyId: familyId as import("../../../packages/family-sdk/runtime-refs/index.ts").FamilyId,
    familyDefinitionHash,
    stage,
    capabilityId: asCapabilityId(capabilityId),
    version: asCapabilityVersion(capabilityVersion),
    schemaHash: asSchemaRef(schemaHash),
    interpreterHash: closureRoot,
    ownerRef: ownerRef("aloha/family-stage-owner/v1", { familyId, stage, module, closureRoot }),
  });
}

function familyEntry(
  root: string,
  input: FamilyGenerationInputV1,
  capabilityIndex: CapabilityIndexV1,
  compilerFacts: readonly CatalogCompilerClosureFactV1[],
): import("../../../packages/family-sdk/runtime-refs/index.ts").GeneratedFamilyEntryV1 {
  const definition = normalizeFamilyDefinition(input.definition);
  if (definition.manifest.familyId !== input.publicEntry.familyId) throw new TypeError(`Family release-intent id mismatch ${input.publicEntry.familyId}`);
  const familyDefinitionHash = familyAuthoringDigest(definition);
  const manifestRoot = hashDomain("aloha/family-manifest/v1", definition.manifest);
  if (manifestRoot !== input.publicEntry.manifestRoot) throw new TypeError(`Family manifest root mismatch ${definition.manifest.familyId}`);
  const publicClosure = compilerClosure(compilerFacts, input.publicEntry).root;
  assertStaticEntrypoint(root, input.publicEntry);
  const moduleClosures = new Map<string, Hash>();
  const closure = (module: ModuleEntrypointV1): Hash => {
    const key = `${module.modulePath}#${module.exportName}`;
    const found = moduleClosures.get(key);
    if (found) return found;
    const resolved = assertStaticEntrypoint(root, module);
    const digest = compilerClosure(compilerFacts, { modulePath: resolved, exportName: module.exportName }).root;
    moduleClosures.set(key, digest);
    return digest;
  };
  const coreModules = [definition.core.nomination, definition.core.identity, definition.core.materialization, definition.core.projection, definition.core.rehydration];
  const coreStages = ["nomination", "identity", "materialization", "projection", "rehydration"] as const;
  const lifecycleRefs = Object.fromEntries(coreModules.map((module, index) => [coreStages[index], stageRef(
    definition.manifest.familyId,
    familyDefinitionHash,
    coreStages[index],
    module,
    closure(module),
    `${definition.manifest.familyId}.core.${coreStages[index]}`,
    definition.manifest.version,
    module.schemaRefs[0] ?? hashDomain("aloha/core-schema/v1", coreStages[index]),
  )])) as import("../../../packages/family-sdk/runtime-refs/index.ts").GeneratedFamilyEntryV1["lifecycleRefs"];
  const leaves = capabilityLeaves(compilerFacts, capabilityIndex);
  const present = Object.values(definition.extensions).flatMap(slot => slot.kind === "present" ? [slot.module] : []);
  const refs = present.map(module => {
    const indexed = capabilityIndex.entries.find(entry => entry.capabilityId === module.capabilityId);
    if (indexed === undefined) throw new TypeError(`unknown capability ${module.capabilityId}`);
    if (indexed.version !== module.version || indexed.schemaHash !== module.schemaHash || indexed.interpreterHash !== module.interpreterHash) throw new TypeError(`capability contract mismatch ${module.capabilityId}`);
    return stageRef(definition.manifest.familyId, familyDefinitionHash, "capability", module, closure(module), module.capabilityId, module.version, module.schemaHash);
  });
  const dependency = artifactDependencyRoot(present.map(module => module.capabilityId), leaves);
  const actionOwnerRefs = definition.actionOwners.map(action => ownerRef("aloha/family-action-owner/v1", {
    familyId: definition.manifest.familyId,
    ownerId: action.ownerId,
    version: action.version,
    schemaHash: action.schemaHash,
    implementationHash: action.implementationHash,
    closureRoot: closure(action),
  }));
  const factContractRefs = definition.acceptanceDeclarations.map(fact => Object.freeze({ factContractId: fact.factContractId, version: fact.version, schemaHash: fact.schemaHash }));
  const definitionLeaf: CatalogLeafV1 = {
    leafId: `family:${definition.manifest.familyId}`,
    definitionHash: familyDefinitionHash,
    requestedDependencyClosure: dependency.requestedDependencyClosure,
    implementationClosureRoot: hashDomain("aloha/family-public-closure/v1", { publicClosure, core: coreModules.map(module => closure(module)), extensions: present.map(module => closure(module)), actions: definition.actionOwners.map(action => closure(action)) }),
  };
  return Object.freeze({
    familyId: definition.manifest.familyId as import("../../../packages/family-sdk/runtime-refs/index.ts").FamilyId,
    familyDefinitionHash,
    issuerRef: ownerRef("aloha/family-issuer/v1", { familyId: definition.manifest.familyId, familyDefinitionHash }),
    authorityRef: hashDomain("aloha/family-authority-declaration/v1", definition.manifest.authorityDeclarationHash) as import("../../../packages/family-sdk/runtime-refs/index.ts").AuthorityDeclarationRef,
    lifecycleRefs,
    extensionRefs: Object.freeze(refs.sort((left, right) => left.capabilityId.localeCompare(right.capabilityId))),
    actionOwnerRefs: Object.freeze(actionOwnerRefs.sort()),
    factContractRefs: Object.freeze(factContractRefs.sort((left, right) => left.factContractId.localeCompare(right.factContractId))),
    definitionCatalogLeafDigest: catalogLeafDigest(definitionLeaf),
    capabilityCatalogRoot: dependency.requestedDependencyRoot,
  });
}

function strategyEntry(
  root: string,
  input: StrategyGenerationInputV1,
  capabilityIndex: CapabilityIndexV1,
  qualifiedCapabilityRefs: readonly CapabilityRefV1[],
  compilerFacts: readonly CatalogCompilerClosureFactV1[],
): GeneratedStrategyCatalogLeafV1 {
  const definition = normalizeStrategyDefinition(input.definition);
  if (definition.strategyId !== input.publicEntry.strategyId) throw new TypeError(`Strategy release-intent id mismatch ${input.publicEntry.strategyId}`);
  const manifestRoot = hashDomain("aloha/strategy-manifest/v1", { strategyId: definition.strategyId, version: definition.version, pluginCodeHash: definition.pluginCodeHash });
  if (manifestRoot !== input.publicEntry.manifestRoot) throw new TypeError(`Strategy manifest root mismatch ${definition.strategyId}`);
  const publicClosure = compilerClosure(compilerFacts, input.publicEntry).root;
  assertStaticEntrypoint(root, input.publicEntry);
  const entries: CapabilityRefV1[] = [];
  for (const predicate of definition.requiredCapabilityPredicates) {
    const indexed = capabilityIndex.entries.find(entry => entry.capabilityId === predicate.capabilityId);
    if (indexed === undefined) throw new TypeError(`unknown strategy capability ${predicate.capabilityId}`);
    if (indexed.version !== predicate.minimumVersion) throw new TypeError(`strategy capability version does not exactly match ${predicate.capabilityId}`);
    const qualified = qualifiedCapabilityRefs.find(entry => entry.capabilityId === predicate.capabilityId);
    if (qualified === undefined) throw new TypeError(`missing release-qualified capability ref ${predicate.capabilityId}`);
    if (qualified.version !== indexed.version || qualified.schemaHash !== indexed.schemaHash || qualified.interpreterHash !== indexed.interpreterHash) {
      throw new TypeError(`release-qualified capability ref mismatch ${predicate.capabilityId}`);
    }
    entries.push(qualified);
  }
  const compiled = compileStrategy(definition, entries);
  const implementationClosureRoot = hashDomain("aloha/strategy-compiler-closure/v1", {
    publicClosure,
    issuer: compilerClosure(compilerFacts, definition.planningProblemIssuer).root,
    definition: compilerClosure(compilerFacts, { modulePath: definition.modulePath, exportName: definition.exportName }).root,
  });
  const strategyDefinitionHash = hashDomain("aloha/strategy-definition-compiled/v2", {
    base: compiled.entry.strategyDefinitionHash,
    implementationClosureRoot,
  });
  const leaf: CatalogLeafV1 = {
    leafId: `strategy:${definition.strategyId}`,
    definitionHash: strategyDefinitionHash,
    requestedDependencyClosure: definition.requiredCapabilityPredicates.map(predicate => predicate.capabilityId).sort(),
    implementationClosureRoot,
  };
  return Object.freeze({
    strategyId: definition.strategyId,
    strategyDefinitionHash,
    issuerRef: ownerRef("aloha/strategy-issuer/v1", { strategyId: definition.strategyId, strategyDefinitionHash }),
    requiredCapabilityRefs: compiled.entry.requiredCapabilityRefs,
    planningProblemIssuer: compiled.entry.planningProblemIssuer,
    constraintSchemaRefs: compiled.entry.constraintSchemaRefs,
    factContractRefs: compiled.entry.factContractRefs,
    definitionCatalogLeafDigest: catalogLeafDigest(leaf),
    strategyVersion: compiled.entry.strategyVersion,
    requestedCapabilityDependencyRoot: compiled.entry.requestedCapabilityDependencyRoot,
    implementationClosureRoot,
    loopIntent: compiled.entry.loopIntent,
  });
}

function renderModule(name: string, value: unknown): string {
  return `/* generated by @aloha/catalog-generator; DO NOT EDIT */\nexport const ${name} = Object.freeze(${JSON.stringify(value, null, 2)});\n`;
}

export function generateCatalog(input: CatalogGenerationInputV1): GeneratedCatalogArtifactsV1 {
  if (input === null || typeof input !== "object") throw new TypeError("catalog generation input must be an object");
  const root = resolve(input.repositoryRoot);
  const releaseIntent = input.releaseIntent;
  const compilerFacts = sealCatalogCompilerClosureFacts(input.compilerClosures);
  const qualifiedCapabilityIds = input.qualifiedCapabilityRefs.map(ref => ref.capabilityId);
  if (new Set(qualifiedCapabilityIds).size !== qualifiedCapabilityIds.length) throw new TypeError("duplicate release-qualified capability ref");
  const familyById = new Map(input.families.map(item => [item.definition.manifest.familyId, item] as const));
  const strategyById = new Map(input.strategies.map(item => [item.definition.strategyId, item] as const));
  if (familyById.size !== input.families.length) throw new TypeError("duplicate Family generation input");
  if (strategyById.size !== input.strategies.length) throw new TypeError("duplicate Strategy generation input");
  const expectedFamilies = new Set(releaseIntent.families.map(entry => entry.familyId));
  const expectedStrategies = new Set(releaseIntent.strategies.map(entry => entry.strategyId));
  if (expectedFamilies.size !== releaseIntent.families.length || expectedStrategies.size !== releaseIntent.strategies.length) throw new TypeError("release intent contains duplicate entry");
  for (const id of familyById.keys()) if (!expectedFamilies.has(id)) throw new TypeError(`unknown Family outside release intent ${id}`);
  for (const id of strategyById.keys()) if (!expectedStrategies.has(id)) throw new TypeError(`unknown Strategy outside release intent ${id}`);
  for (const entry of releaseIntent.families) if (!familyById.has(entry.familyId)) throw new TypeError(`incomplete Family catalog input ${entry.familyId}`);
  for (const entry of releaseIntent.strategies) if (!strategyById.has(entry.strategyId)) throw new TypeError(`incomplete Strategy catalog input ${entry.strategyId}`);
  const requiredCompilerKeys = new Set<string>();
  const requireCompiler = (entrypoint: ModuleEntrypointV1): void => {
    compilerClosure(compilerFacts, entrypoint);
    requiredCompilerKeys.add(catalogCompilerClosureFactKey(entrypoint));
  };
  for (const entry of input.capabilityIndex.entries) {
    requireCompiler({ modulePath: entry.modulePath, exportName: entry.exportName });
  }
  const collectFamily = (item: FamilyGenerationInputV1): void => {
    requireCompiler(item.publicEntry);
    const definition = normalizeFamilyDefinition(item.definition);
    for (const module of [definition.core.nomination, definition.core.identity, definition.core.materialization, definition.core.projection, definition.core.rehydration]) requireCompiler(module);
    for (const slot of Object.values(definition.extensions)) if (slot.kind === "present") requireCompiler(slot.module);
    for (const action of definition.actionOwners) requireCompiler(action);
  };
  const collectStrategy = (item: StrategyGenerationInputV1): void => {
    const definition = normalizeStrategyDefinition(item.definition);
    requireCompiler(item.publicEntry);
    requireCompiler(definition);
    requireCompiler(definition.planningProblemIssuer);
  };
  for (const item of input.families) collectFamily(item);
  for (const item of input.strategies) collectStrategy(item);
  const suppliedCompilerKeys = compilerFacts.map(catalogCompilerClosureFactKey);
  const unknownCompilerFacts = suppliedCompilerKeys.filter(key => !requiredCompilerKeys.has(key) && key !== catalogCompilerClosureFactKey(GENERATOR_ENTRYPOINT));
  if (unknownCompilerFacts.length > 0) throw new TypeError(`unknown catalog compiler closure facts ${unknownCompilerFacts.join(",")}`);
  requireCompiler(GENERATOR_ENTRYPOINT);
  const families = releaseIntent.families.map(entry => familyEntry(root, familyById.get(entry.familyId)!, input.capabilityIndex, compilerFacts));
  const strategies = releaseIntent.strategies.map(entry => strategyEntry(root, strategyById.get(entry.strategyId)!, input.capabilityIndex, input.qualifiedCapabilityRefs, compilerFacts));
  const familyCatalog = Object.freeze({
    schemaVersion: 1 as const,
    releaseIntentRoot: releaseIntent.releaseIntentRoot,
    capabilityIndexRoot: input.capabilityIndex.capabilityIndexRoot,
    entries: Object.freeze(families.sort((left, right) => left.familyId.localeCompare(right.familyId))),
    definitionCatalogRoot: hashDomain("aloha/family-definition-catalog/v1", families.map(entry => entry.definitionCatalogLeafDigest).sort()),
  });
  const strategyCatalog = Object.freeze({
    schemaVersion: 1 as const,
    releaseIntentRoot: releaseIntent.releaseIntentRoot,
    capabilityIndexRoot: input.capabilityIndex.capabilityIndexRoot,
    entries: Object.freeze(strategies.sort((left, right) => left.strategyId.localeCompare(right.strategyId))),
    definitionCatalogRoot: hashDomain("aloha/strategy-definition-catalog/v1", strategies.map(entry => entry.definitionCatalogLeafDigest).sort()),
  });
  const familyCatalogText = renderModule("FAMILY_CATALOG", familyCatalog);
  const strategyCatalogText = renderModule("STRATEGY_CATALOG", strategyCatalog);
  const inputRecords = Object.freeze([
    canonicalRecord("input/release-intent", releaseIntent),
    canonicalRecord("input/capability-index", input.capabilityIndex),
    canonicalRecord("input/qualified-capability-refs", input.qualifiedCapabilityRefs),
    canonicalRecord("input/compiler-closures", compilerFacts),
  ].sort((left, right) => left.path.localeCompare(right.path)));
  const compilerRecords = Object.freeze(compilerFacts.filter(fact => catalogCompilerClosureFactKey(fact) !== catalogCompilerClosureFactKey(GENERATOR_ENTRYPOINT)).map(fact => ({
    logicalPath: `${fact.modulePath}#${fact.exportName}`,
    contentSha256: fact.closureDigest,
    byteLength: 0,
    sourceKind: "tracked" as const,
  })));
  const generatorFact = compilerFacts.find(fact => catalogCompilerClosureFactKey(fact) === catalogCompilerClosureFactKey(GENERATOR_ENTRYPOINT))!;
  const generatorRecords = Object.freeze([{ logicalPath: `${generatorFact.modulePath}#${generatorFact.exportName}`, contentSha256: generatorFact.closureDigest, byteLength: 0, sourceKind: "tracked" as const }]);
  const outputRoot = hashDomain("aloha/generated-catalog-output/v1", { familyCatalog, strategyCatalog });
  const outputs = Object.freeze([
    Object.freeze({ ...canonicalRecord(FAMILY_OUTPUT_PATH, familyCatalogText), catalogRoot: familyCatalog.definitionCatalogRoot }),
    Object.freeze({ ...canonicalRecord(STRATEGY_OUTPUT_PATH, strategyCatalogText), catalogRoot: strategyCatalog.definitionCatalogRoot }),
  ]);
  const withoutHash = {
    schemaVersion: 1 as const,
    outputPaths: Object.freeze([FAMILY_OUTPUT_PATH, STRATEGY_OUTPUT_PATH].sort()),
    inputRecords,
    compilerRecords,
    generatorRecords,
    outputs,
    inputRoot: hashDomain("aloha/catalog-input-root/v1", inputRecords),
    compilerRoot: hashDomain("aloha/catalog-compiler-record-root/v1", compilerRecords),
    generatorRoot: hashDomain("aloha/catalog-generator-record-root/v1", generatorRecords),
  };
  const ledger = Object.freeze({ ...withoutHash, ledgerHash: ledgerWithoutHash(withoutHash) });
  return Object.freeze({
    familyCatalog,
    strategyCatalog,
    familyCatalogText,
    strategyCatalogText,
    outputRoot,
    ledger,
    ledgerText: renderLedger(ledger),
  });
}

export function writeGeneratedCatalog(rootInput: string, artifacts: GeneratedCatalogArtifactsV1): void {
  const root = resolve(rootInput);
  const familyPath = resolve(root, FAMILY_OUTPUT_PATH);
  const strategyPath = resolve(root, STRATEGY_OUTPUT_PATH);
  const ledgerPath = resolve(root, LEDGER_OUTPUT_PATH);
  mkdirSync(dirname(familyPath), { recursive: true });
  mkdirSync(dirname(strategyPath), { recursive: true });
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(familyPath, artifacts.familyCatalogText);
  writeFileSync(strategyPath, artifacts.strategyCatalogText);
  writeFileSync(ledgerPath, artifacts.ledgerText);
}

export function verifyCatalogLedger(rootInput: string, artifacts: GeneratedCatalogArtifactsV1): readonly string[] {
  const root = resolve(rootInput);
  const errors: string[] = [];
  const compare = (path: string, expected: string): void => {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) {
      errors.push(`missing-output:${path}`);
      return;
    }
    const actual = readFileSync(absolute, "utf8");
    if (actual !== expected) errors.push(`output-content:${path}`);
  };
  compare(FAMILY_OUTPUT_PATH, artifacts.familyCatalogText);
  compare(STRATEGY_OUTPUT_PATH, artifacts.strategyCatalogText);
  const ledgerPath = resolve(root, LEDGER_OUTPUT_PATH);
  if (!existsSync(ledgerPath)) {
    errors.push(`missing-ledger:${LEDGER_OUTPUT_PATH}`);
  } else {
    try {
      const persisted = assertLedgerShape(JSON.parse(readFileSync(ledgerPath, "utf8")));
      if (canonical(persisted) !== canonical(artifacts.ledger)) errors.push("ledger-content");
    } catch (error) {
      errors.push(`ledger-invalid:${String(error)}`);
    }
  }
  return Object.freeze(errors);
}

/** Fresh regeneration is the only acceptance path for generated catalog bytes. */
export function checkGeneratedCatalog(input: CatalogGenerationInputV1): readonly string[] {
  try {
    const artifacts = generateCatalog(input);
    return verifyCatalogLedger(input.repositoryRoot, artifacts);
  } catch (error) {
    return Object.freeze([`generation-failed:${String(error)}`]);
  }
}
