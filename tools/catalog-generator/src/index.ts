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
import type {
  GeneratedFamilyRuntimeDescriptorV1,
  GeneratedFamilyRuntimeAdapterV1,
  GeneratedFamilyRuntimeFamilyV1,
  GeneratedFamilyRuntimeSourcePlanV1,
  GeneratedFamilyRuntimeStageV1,
} from "../../../packages/family-composition/src/index.ts";
import {
  nominationProgramRoot,
  nominationProgramProposalLeafDigest,
  nominationProgramSetRoot,
  runtimeAdapterLeafDigest,
  sourcePlanLeafDigest,
} from "../../../packages/family-composition/src/index.ts";
import {
  strategyPlanningTemplateHash,
  type GeneratedStrategyRuntimeDescriptorV1,
  type GeneratedStrategyRuntimeEntryV1,
} from "../../../packages/strategy-composition/src/index.ts";
import {
  hashReleaseQualifiedCapabilityRefsRoot,
  type CapabilityIndexV1,
} from "../../../specs/capability-index/src/index.ts";
import {
  type FamilyReleaseIntentEntryV1,
  type ReleaseIntentV1,
  type StrategyReleaseIntentEntryV1,
} from "../../../specs/release-intent/src/index.ts";
import {
  createCatalogImpactReceiptV1,
  decodeCatalogImpactPriorV1,
  sealCatalogImpactSnapshotV1,
  type CatalogImpactPriorV1,
  type CatalogImpactReceiptV1,
  type CatalogImpactSnapshotV1,
} from "./impact-receipt.ts";
import {
  economicValuationOwnerCriticalMutationCorpusRootV1,
  economicValuationOwnerIndependentOracleCaseRootV1,
  economicValuationOwnerQualificationSpecDigestV1,
  sealGeneratedEconomicValuationOwnerRegistryV1,
  sealQualifiedEconomicValuationOwnerEntryV1,
  type EconomicValuationOwnerDeclarationV1,
  type GeneratedEconomicValuationOwnerRegistryV1,
} from "../../../specs/economic-valuation-owner/src/index.ts";
import {
  sealEconomicSafetyActionOwnerProposalV1,
  sealGeneratedEconomicSafetyActionOwnerRegistryV1,
  type GeneratedEconomicSafetyActionOwnerRegistryV1,
} from "../../../specs/economic-safety-profile/src/index.ts";

export {
  catalogImpactFamilyProposalOwnershipRootV1,
  createCatalogImpactReceiptV1,
  catalogImpactGenesisPriorV1,
  decodeCatalogImpactPriorV1,
  decodeCatalogImpactReceiptV1,
  decodeCatalogImpactSnapshotV1,
  encodeCatalogImpactReceiptV1,
  encodeCatalogImpactPriorV1,
  encodeCatalogImpactSnapshotV1,
  sealCatalogImpactSnapshotV1,
  sealCatalogImpactPriorV1,
  verifyCatalogImpactReceiptV1,
  type CatalogImpactArtifactFactV1,
  type CatalogImpactReusableArtifactFactV1,
  type CatalogImpactPriorV1,
  type CatalogImpactReceiptV1,
  type CatalogImpactSnapshotV1,
} from "./impact-receipt.ts";

export interface FamilyGenerationInputV1 {
  readonly definition: FamilyAuthoringDefinitionV1;
  readonly publicEntry: FamilyReleaseIntentEntryV1;
}

export interface StrategyGenerationInputV1 {
  readonly definition: StrategyAuthoringDefinitionV1;
  readonly publicEntry: StrategyReleaseIntentEntryV1;
}

export interface EconomicValuationOwnerGenerationInputV1 {
  readonly declaration: EconomicValuationOwnerDeclarationV1;
  readonly qualificationSpec: unknown;
  readonly criticalMutationCorpus: unknown;
  readonly independentOracleCases: unknown;
}

export interface CatalogGenerationInputV1 {
  readonly repositoryRoot: string;
  readonly releaseIntent: ReleaseIntentV1;
  readonly capabilityIndex: CapabilityIndexV1;
  /** Pre-commit proposed refs. The generator may bind but never mint authority from them. */
  readonly proposedCapabilityRefs: readonly CapabilityRefV1[];
  readonly compilerClosures: readonly CatalogCompilerClosureFactV1[];
  readonly families: readonly FamilyGenerationInputV1[];
  readonly strategies: readonly StrategyGenerationInputV1[];
  readonly valuationOwners: readonly EconomicValuationOwnerGenerationInputV1[];
}

export interface GeneratedFamilyCatalogV1 {
  readonly schemaVersion: 1;
  readonly releaseIntentRoot: Hash;
  readonly capabilityIndexRoot: Hash;
  /** Root of the pre-commit proposed capability set; this grants no authority. */
  readonly proposedCapabilitySetRoot: Hash;
  readonly entries: readonly import("../../../packages/family-sdk/runtime-refs/index.ts").GeneratedFamilyEntryV1[];
  readonly definitionCatalogRoot: Hash;
}

export interface GeneratedStrategyCatalogV1 {
  readonly schemaVersion: 1;
  readonly releaseIntentRoot: Hash;
  readonly capabilityIndexRoot: Hash;
  /** Root of the pre-commit proposed capability set; this grants no authority. */
  readonly proposedCapabilitySetRoot: Hash;
  readonly entries: readonly GeneratedStrategyCatalogLeafV1[];
  readonly definitionCatalogRoot: Hash;
}

export interface GeneratedCatalogArtifactsV1 {
  readonly familyCatalog: GeneratedFamilyCatalogV1;
  readonly strategyCatalog: GeneratedStrategyCatalogV1;
  /** Combined Family + Strategy leaf root used by ReadyGeneration/runtime. */
  readonly globalDefinitionCatalogRoot: Hash;
  readonly familyRuntimeDescriptor: GeneratedFamilyRuntimeDescriptorV1;
  readonly strategyRuntimeDescriptor: GeneratedStrategyRuntimeDescriptorV1;
  readonly valuationOwnerRegistry: GeneratedEconomicValuationOwnerRegistryV1;
  readonly economicSafetyActionOwnerRegistry: GeneratedEconomicSafetyActionOwnerRegistryV1;
  readonly familyCatalogText: string;
  readonly strategyCatalogText: string;
  readonly familyRuntimeCompositionText: string;
  readonly valuationOwnerRegistryText: string;
  readonly safetyProfileText: string;
  readonly outputRoot: Hash;
  readonly ledger: CatalogGenerationLedgerV1;
  readonly ledgerText: string;
}

export interface GeneratedCatalogImpactArtifactsV1 extends GeneratedCatalogArtifactsV1 {
  readonly impactSnapshot: CatalogImpactSnapshotV1;
  readonly impactReceipt: CatalogImpactReceiptV1;
  readonly impactSnapshotText: string;
  readonly impactReceiptText: string;
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
const RUNTIME_COMPOSITION_OUTPUT_PATH = "generated/runtime-composition/index.ts";
const VALUATION_OWNER_REGISTRY_OUTPUT_PATH = "generated/valuation-owner-registry/index.ts";
const SAFETY_PROFILE_OUTPUT_PATH = "generated/safety-profile/index.ts";
const LEDGER_OUTPUT_PATH = "generated/catalog-generation.ledger.json";
const IMPACT_SNAPSHOT_OUTPUT_PATH = "generated/catalog-impact.snapshot.json";
const IMPACT_RECEIPT_OUTPUT_PATH = "generated/catalog-impact.receipt.json";
const GENERATOR_ENTRYPOINT: ModuleEntrypointV1 = Object.freeze({ modulePath: "tools/catalog-generator/src/index.ts", exportName: "generateCatalogWithImpact" });

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

/** @internal Exact static source check shared with current-release regression tests. */
export function assertStaticEntrypoint(root: string, binding: ModuleEntrypointV1): string {
  const path = repoPath(root, binding.modulePath);
  if (binding.modulePath.startsWith(".") || binding.modulePath.startsWith("/") || binding.modulePath.includes("..") || binding.modulePath.includes("\\") || binding.modulePath.includes("?") || binding.modulePath.includes("#")) throw new TypeError(`non-static entrypoint ${binding.modulePath}`);
  const source = ts.createSourceFile(path, sourceText(root, path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exported = new Set<string>();
  for (const statement of source.statements) {
    // `export { ... }` and `export * from ...` are ExportDeclaration nodes;
    // unlike declarations, TypeScript does not put an `export` modifier on
    // those nodes.  Treat the declaration itself as the static export edge,
    // while retaining the modifier check for declarations and assignments.
    const hasExport = ts.isExportDeclaration(statement)
      || Boolean((statement as ts.Node & { readonly modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
    if (!hasExport) continue;
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) exported.add(declaration.name.text);
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name) exported.add(statement.name.text);
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) exported.add(element.name.text);
    }
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
  const lifecycleRefs = Object.fromEntries(coreModules.map((module, index) => {
    const stage = coreStages[index];
    const capabilityId = module.capabilityIds[0] ?? `${definition.manifest.familyId}.core.${stage}`;
    const schemaHash = module.schemaRefs[0] ?? hashDomain("aloha/core-schema/v1", stage);
    return [stage, stageRef(
      definition.manifest.familyId,
      familyDefinitionHash,
      stage,
      module,
      closure(module),
      capabilityId,
      definition.manifest.version,
      schemaHash,
    )];
  })) as import("../../../packages/family-sdk/runtime-refs/index.ts").GeneratedFamilyEntryV1["lifecycleRefs"];
  const leaves = capabilityLeaves(compilerFacts, capabilityIndex);
  const present = Object.values(definition.extensions).flatMap(slot => slot.kind === "present" ? [slot.module] : []);
  const adapterCapabilityIds = Object.values(definition.runtimeAdapters ?? {}).flatMap(adapter => Object.values(adapter.capabilityIds));
  const allRequestedCapabilityIds = [...new Set([...present.map(module => module.capabilityId), ...adapterCapabilityIds])];
  const refs = present.map(module => {
    const indexed = capabilityIndex.entries.find(entry => entry.capabilityId === module.capabilityId);
    if (indexed === undefined) throw new TypeError(`unknown capability ${module.capabilityId}`);
    if (indexed.version !== module.version || indexed.schemaHash !== module.schemaHash || indexed.interpreterHash !== module.interpreterHash) throw new TypeError(`capability contract mismatch ${module.capabilityId}`);
    return stageRef(definition.manifest.familyId, familyDefinitionHash, "capability", module, closure(module), module.capabilityId, module.version, module.schemaHash);
  });
  const dependency = artifactDependencyRoot(allRequestedCapabilityIds, leaves);
  const actionOwnerRefs = definition.actionOwners.map(action => ownerRef("aloha/family-action-owner/v1", {
    familyId: definition.manifest.familyId,
    ownerId: action.ownerId,
    version: action.version,
    schemaHash: action.schemaHash,
    implementationHash: action.implementationHash,
    closureRoot: closure(action),
  }));
  const sourcePlanRefs = definition.manifest.sourcePlans.map(plan => {
    const closureRoot = closure(plan);
    return Object.freeze({
      ownerRef: ownerRef("aloha/family-source-plan-owner/v1", {
        familyId: definition.manifest.familyId,
        sourcePlanId: plan.sourcePlanId,
        modulePath: plan.modulePath,
        exportName: plan.exportName,
        closureRoot,
      }),
      sourcePlanRef: hashDomain("aloha/family-source-plan-ref/v1", {
        sourcePlanId: plan.sourcePlanId,
        modulePath: plan.modulePath,
        exportName: plan.exportName,
        closureRoot,
        schemaHash: plan.schemaHash,
        completeness: plan.completeness,
        historyStartBlock: plan.historyStartBlock,
      }),
      familyDefinitionHash,
      completeness: plan.completeness,
      historyStartBlock: plan.historyStartBlock,
    });
  }).sort((left, right) => left.sourcePlanRef.localeCompare(right.sourcePlanRef));
  const factContractRefs = definition.acceptanceDeclarations.map(fact => Object.freeze({ factContractId: fact.factContractId, version: fact.version, schemaHash: fact.schemaHash }));
  const adapterClosures = Object.values(definition.runtimeAdapters ?? {}).map(adapter => closure(adapter));
  const definitionLeaf: CatalogLeafV1 = {
    leafId: `family:${definition.manifest.familyId}`,
    definitionHash: familyDefinitionHash,
    requestedDependencyClosure: dependency.requestedDependencyClosure,
    implementationClosureRoot: hashDomain("aloha/family-public-closure/v1", { publicClosure, core: coreModules.map(module => closure(module)), sourcePlans: definition.manifest.sourcePlans.map(plan => closure(plan)), extensions: present.map(module => closure(module)), actions: definition.actionOwners.map(action => closure(action)), runtimeAdapters: adapterClosures }),
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
    sourcePlanRefs: Object.freeze(sourcePlanRefs),
    definitionCatalogLeafDigest: catalogLeafDigest(definitionLeaf),
    capabilityCatalogRoot: dependency.requestedDependencyRoot,
  });
}

function familyRuntimeFamilyDescriptor(
  root: string,
  input: FamilyGenerationInputV1,
  entry: import("../../../packages/family-sdk/runtime-refs/index.ts").GeneratedFamilyEntryV1,
  compilerFacts: readonly CatalogCompilerClosureFactV1[],
): GeneratedFamilyRuntimeFamilyV1 {
  const definition = normalizeFamilyDefinition(input.definition);
  const publicPath = assertStaticEntrypoint(root, input.publicEntry);
  const stages = [
    ["nomination", definition.core.nomination],
    ["identity", definition.core.identity],
    ["materialization", definition.core.materialization],
    ["projection", definition.core.projection],
    ["rehydration", definition.core.rehydration],
  ] as const;
  const stageDescriptors: GeneratedFamilyRuntimeStageV1[] = stages.map(([stage, module]) => {
    const modulePath = assertStaticEntrypoint(root, module);
    const closureRoot = compilerClosure(compilerFacts, { modulePath, exportName: module.exportName }).root;
    return Object.freeze({
      stage,
      modulePath,
      exportName: module.exportName,
      closureRoot,
      stageRef: entry.lifecycleRefs[stage],
    });
  });
  const sourcePlans: GeneratedFamilyRuntimeSourcePlanV1[] = definition.manifest.sourcePlans.map(plan => {
    const modulePath = assertStaticEntrypoint(root, plan);
    const closureRoot = compilerClosure(compilerFacts, { modulePath, exportName: plan.exportName }).root;
    const planRef = entry.sourcePlanRefs.find(candidate => candidate.sourcePlanRef === hashDomain("aloha/family-source-plan-ref/v1", {
      sourcePlanId: plan.sourcePlanId,
      modulePath,
      exportName: plan.exportName,
      closureRoot,
      schemaHash: plan.schemaHash,
      completeness: plan.completeness,
      historyStartBlock: plan.historyStartBlock,
    }));
    if (planRef === undefined) throw new TypeError(`generated Family source plan ref missing ${plan.sourcePlanId}`);
    const descriptor = {
      sourcePlanId: plan.sourcePlanId,
      modulePath,
      exportName: plan.exportName,
      closureRoot,
      schemaHash: plan.schemaHash,
      planRef,
    } as const;
    const leafDigest = sourcePlanLeafDigest(descriptor);
    const nominationSlot = plan.nominationProgram;
    if (nominationSlot.kind !== "present") {
      throw new TypeError(`release source plan lacks nomination qualification ${definition.manifest.familyId}:${plan.sourcePlanId}`);
    }
    const nomination = nominationSlot.program;
    const program = Object.freeze({
      modulePath: assertStaticEntrypoint(root, nomination),
      exportName: nomination.exportName,
      closureRoot: compilerClosure(compilerFacts, nomination).root,
      schemaHash: nomination.schemaHash,
    });
    const mutationCorpus = Object.freeze({
      modulePath: assertStaticEntrypoint(root, nomination.mutationCorpus),
      exportName: nomination.mutationCorpus.exportName,
      closureRoot: compilerClosure(compilerFacts, nomination.mutationCorpus).root,
    });
    const independentOracle = Object.freeze({
      modulePath: assertStaticEntrypoint(root, nomination.independentOracle),
      exportName: nomination.independentOracle.exportName,
      closureRoot: compilerClosure(compilerFacts, nomination.independentOracle).root,
    });
    const qualificationBase = Object.freeze({
      program,
      mutationCorpus,
      independentOracle,
      nominationProgramRoot: nominationProgramRoot({ program }),
    });
    const nominationProgramProposal = Object.freeze({
      ...qualificationBase,
      proposalLeafDigest: nominationProgramProposalLeafDigest(leafDigest, qualificationBase),
    });
    return Object.freeze({ ...descriptor, leafDigest, nominationProgramProposal });
  }).sort((left, right) => left.sourcePlanId.localeCompare(right.sourcePlanId));
  const extensions = Object.values(definition.extensions).flatMap(slot => {
    if (slot.kind !== "present") return [];
    const modulePath = assertStaticEntrypoint(root, slot.module);
    const capabilityRef = entry.extensionRefs.find(ref => ref.capabilityId === slot.module.capabilityId);
    if (capabilityRef === undefined) throw new TypeError(`generated Family runtime capability ref missing ${slot.module.capabilityId}`);
    return [Object.freeze({
      modulePath,
      exportName: slot.module.exportName,
      closureRoot: compilerClosure(compilerFacts, { modulePath, exportName: slot.module.exportName }).root,
      capabilityRef,
    })];
  }).sort((left, right) => left.capabilityRef.capabilityId.localeCompare(right.capabilityRef.capabilityId));
  const actionOwners = definition.actionOwners.map(action => {
    const modulePath = assertStaticEntrypoint(root, action);
    const actionOwnerRef = ownerRef("aloha/family-action-owner/v1", {
      familyId: definition.manifest.familyId,
      ownerId: action.ownerId,
      version: action.version,
      schemaHash: action.schemaHash,
      implementationHash: action.implementationHash,
      closureRoot: compilerClosure(compilerFacts, { modulePath, exportName: action.exportName }).root,
    });
    if (!entry.actionOwnerRefs.includes(actionOwnerRef)) throw new TypeError(`generated Family runtime action owner ref missing ${action.ownerId}`);
    return Object.freeze({
      modulePath,
      exportName: action.exportName,
      closureRoot: compilerClosure(compilerFacts, { modulePath, exportName: action.exportName }).root,
      ownerRef: actionOwnerRef,
      ownerId: action.ownerId,
      version: action.version,
      schemaHash: action.schemaHash,
      implementationHash: action.implementationHash,
      actionKinds: Object.freeze([...action.actionKinds]),
    });
  }).sort((left, right) => left.ownerRef.localeCompare(right.ownerRef));
  const runtimeAdapters: GeneratedFamilyRuntimeAdapterV1[] = Object.entries(definition.runtimeAdapters ?? {}).map(([role, declaration]) => {
    const modulePath = assertStaticEntrypoint(root, declaration);
    const capabilityRefs: Record<string, import("../../../packages/family-sdk/runtime-refs/index.ts").StageCapabilityRefV1> = {};
    for (const [capabilityRole, capabilityId] of Object.entries(declaration.capabilityIds)) {
      const capabilityRef = entry.extensionRefs.find(ref => ref.capabilityId === capabilityId);
      if (capabilityRef === undefined || capabilityRef.stage !== "capability") {
        throw new TypeError(`generated Family runtime adapter capability ref missing ${role}:${capabilityRole}`);
      }
      capabilityRefs[capabilityRole] = capabilityRef;
    }
    const actionOwnerRefs: Record<string, import("../../../packages/family-sdk/runtime-refs/index.ts").ActionOwnerRef> = {};
    for (const [actionRole, ownerId] of Object.entries(declaration.actionOwnerIds)) {
      const action = definition.actionOwners.find(candidate => candidate.ownerId === ownerId);
      if (action === undefined) throw new TypeError(`generated Family runtime adapter action owner missing ${role}:${actionRole}`);
      const actionOwner = actionOwners.find(candidate => candidate.ownerId === ownerId);
      if (actionOwner === undefined) throw new TypeError(`generated Family runtime adapter action ref missing ${role}:${actionRole}`);
      actionOwnerRefs[actionRole] = actionOwner.ownerRef;
    }
    const closureRoot = compilerClosure(compilerFacts, { modulePath, exportName: declaration.exportName }).root;
    const descriptor = {
      role,
      modulePath,
      exportName: declaration.exportName,
      closureRoot,
      capabilityRefs: Object.freeze(Object.fromEntries(Object.entries(capabilityRefs).sort(([left], [right]) => left.localeCompare(right)))),
      actionOwnerRefs: Object.freeze(Object.fromEntries(Object.entries(actionOwnerRefs).sort(([left], [right]) => left.localeCompare(right)))),
    } as const;
    return Object.freeze({ ...descriptor, leafDigest: runtimeAdapterLeafDigest(descriptor) });
  }).sort((left, right) => left.role.localeCompare(right.role));
  const runtimeAdapterRoot = hashDomain("aloha/family-runtime-adapter-set/v1", runtimeAdapters.map(adapter => adapter.leafDigest).sort());
  const sourcePlanRoot = hashDomain("aloha/family-source-plan-set/v1", sourcePlans.map(plan => plan.leafDigest).sort());
  const stageDefinitionRoot = hashDomain("aloha/family-runtime-definition-set/v1", [...stageDescriptors].sort((left, right) => left.stage.localeCompare(right.stage)).map(stage => ({
    stage: stage.stage,
    modulePath: stage.modulePath,
    exportName: stage.exportName,
    closureRoot: stage.closureRoot,
    stageRef: stage.stageRef,
  })));
  return Object.freeze({
    entry,
    publicEntry: Object.freeze({
      modulePath: publicPath,
      exportName: input.publicEntry.exportName,
      closureRoot: compilerClosure(compilerFacts, { modulePath: publicPath, exportName: input.publicEntry.exportName }).root,
    }),
    stages: Object.freeze([...stageDescriptors].sort((left, right) => left.stage.localeCompare(right.stage))),
    sourcePlans: Object.freeze(sourcePlans),
    extensions: Object.freeze(extensions),
    actionOwners: Object.freeze(actionOwners),
    runtimeAdapters: Object.freeze(runtimeAdapters),
    runtimeAdapterRoot,
    sourcePlanRoot,
    stageDefinitionRoot,
  });
}

function familyRuntimeDescriptor(
  releaseIntentRoot: Hash,
  definitionCatalogRoot: Hash,
  proposedCapabilitySetRoot: Hash,
  families: readonly GeneratedFamilyRuntimeFamilyV1[],
): GeneratedFamilyRuntimeDescriptorV1 {
  const normalized = Object.freeze({
    schemaVersion: 1 as const,
    releaseIntentRoot,
    definitionCatalogRoot,
    proposedCapabilitySetRoot,
    nominationProgramSetRoot: nominationProgramSetRoot(
      families.flatMap(family => family.sourcePlans.map(plan =>
        plan.nominationProgramProposal.proposalLeafDigest)),
    ),
    families: Object.freeze([...families].sort((left, right) => left.entry.familyId.localeCompare(right.entry.familyId))),
  });
  return Object.freeze({
    ...normalized,
    descriptorRoot: hashDomain("aloha/generated-family-runtime-descriptor/v1", normalized),
  });
}

function strategyRuntimeEntry(
  root: string,
  input: StrategyGenerationInputV1,
  entry: GeneratedStrategyCatalogLeafV1,
  compilerFacts: readonly CatalogCompilerClosureFactV1[],
): GeneratedStrategyRuntimeEntryV1 {
  const definition = normalizeStrategyDefinition(input.definition);
  const issuer = definition.planningProblemIssuer;
  const issuerModulePath = assertStaticEntrypoint(root, issuer);
  const issuerClosureRoot = compilerClosure(compilerFacts, {
    modulePath: issuerModulePath,
    exportName: issuer.exportName,
  }).root;
  const planningTemplateHash = strategyPlanningTemplateHash(entry.planningTemplate);
  const leafPayload = {
    strategyId: entry.strategyId,
    strategyDefinitionHash: entry.strategyDefinitionHash,
    definitionCatalogLeafDigest: entry.definitionCatalogLeafDigest,
    issuerModulePath,
    issuerExportName: issuer.exportName,
    issuerClosureRoot,
    planningTemplateHash,
  };
  return Object.freeze({
    catalogEntry: entry,
    issuerModulePath,
    issuerExportName: issuer.exportName,
    issuerClosureRoot,
    planningTemplateHash,
    leafDigest: hashDomain("aloha/generated-strategy-runtime-leaf/v1", leafPayload),
  });
}

function strategyRuntimeDescriptor(
  releaseIntentRoot: Hash,
  definitionCatalogRoot: Hash,
  proposedCapabilitySetRoot: Hash,
  strategies: readonly GeneratedStrategyRuntimeEntryV1[],
): GeneratedStrategyRuntimeDescriptorV1 {
  const normalized = Object.freeze({
    schemaVersion: 1 as const,
    releaseIntentRoot,
    definitionCatalogRoot,
    proposedCapabilitySetRoot,
    strategies: Object.freeze([...strategies].sort((left, right) =>
      left.catalogEntry.strategyId.localeCompare(right.catalogEntry.strategyId),
    )),
  });
  return Object.freeze({
    ...normalized,
    descriptorRoot: hashDomain("aloha/generated-strategy-runtime-descriptor/v1", normalized),
  });
}

function renderFamilyRuntimeComposition(
  descriptor: GeneratedFamilyRuntimeDescriptorV1,
  strategyDescriptor: GeneratedStrategyRuntimeDescriptorV1,
): string {
  const imports = descriptor.families.flatMap((family, index) => family.stages.map(stage =>
    "import { " + stage.exportName + " as FAMILY_" + index + "_" + stage.stage.toUpperCase() + "_DEFINITION } from \"../../" + family.publicEntry.modulePath + "\";"));
  const extensionImports = descriptor.families.flatMap((family, familyIndex) => family.extensions.map((extension, extensionIndex) =>
    "import { " + extension.exportName + " as FAMILY_" + familyIndex + "_EXTENSION_" + extensionIndex + " } from \"../../" + family.publicEntry.modulePath + "\";"));
  const actionImports = descriptor.families.flatMap((family, familyIndex) => family.actionOwners.map((action, actionIndex) =>
    "import { " + action.exportName + " as FAMILY_" + familyIndex + "_ACTION_" + actionIndex + " } from \"../../" + family.publicEntry.modulePath + "\";"));
  const adapterImports = descriptor.families.flatMap((family, familyIndex) => family.runtimeAdapters.map((adapter, adapterIndex) =>
    "import { " + adapter.exportName + " as FAMILY_" + familyIndex + "_RUNTIME_ADAPTER_" + adapterIndex + " } from \"../../" + family.publicEntry.modulePath + "\";"));
  const sourcePlanImports = descriptor.families.flatMap((family, familyIndex) => family.sourcePlans.map((plan, planIndex) =>
    "import { " + plan.exportName + " as FAMILY_" + familyIndex + "_SOURCE_PLAN_" + planIndex + " } from \"../../" + plan.modulePath + "\";"));
  const nominationProgramImports = descriptor.families.flatMap((family, familyIndex) => family.sourcePlans.map((plan, planIndex) =>
    "import { " + plan.nominationProgramProposal.program.exportName + " as FAMILY_" + familyIndex + "_NOMINATION_PROGRAM_" + planIndex + " } from \"../../" + plan.nominationProgramProposal.program.modulePath + "\";"));
  const strategyImports = strategyDescriptor.strategies.map((entry, index) =>
    "import { " + entry.issuerExportName + " as STRATEGY_" + index + "_PLANNING_PROBLEM_ISSUER } from \"../../" + entry.issuerModulePath + "\";");
  const definitionSets = descriptor.families.flatMap((family, index) => [
    "const FAMILY_RUNTIME_DEFINITIONS_" + index + " = Object.freeze([",
    ...family.stages.map(stage => "  FAMILY_" + index + "_" + stage.stage.toUpperCase() + "_DEFINITION,"),
    "]);",
    "",
  ]);
  return [
    "/* generated by @aloha/catalog-generator; DO NOT EDIT */",
    "import { createGeneratedFamilyRuntimeFactory, type GeneratedFamilyRuntimeFactoryV1 } from \"../../packages/family-composition/src/internal/generated-runtime-composition.ts\";",
    "import type { GeneratedFamilyRuntimeDescriptorV1 } from \"../../packages/family-composition/src/index.ts\";",
    "import { createGeneratedStrategyRuntimeFactory, type GeneratedStrategyRuntimeFactoryV1 } from \"../../packages/strategy-composition/src/internal/generated-runtime-composition.ts\";",
    "import type { GeneratedStrategyRuntimeDescriptorV1 } from \"../../packages/strategy-composition/src/index.ts\";",
    ...imports,
    ...extensionImports,
    ...actionImports,
    ...adapterImports,
    ...sourcePlanImports,
    ...nominationProgramImports,
    ...strategyImports,
    "",
    ...definitionSets,
    ...descriptor.families.flatMap((family, index) => [
      "const FAMILY_RUNTIME_ADAPTERS_" + index + " = Object.freeze([",
      ...family.runtimeAdapters.map((adapter, adapterIndex) => "  Object.freeze({ factory: FAMILY_" + index + "_RUNTIME_ADAPTER_" + adapterIndex + ", modulePath: " + JSON.stringify(adapter.modulePath) + ", exportName: " + JSON.stringify(adapter.exportName) + ", closureRoot: " + JSON.stringify(adapter.closureRoot) + ", leafDigest: " + JSON.stringify(adapter.leafDigest) + " }),"),
      "]);",
      "",
    ]),
    ...descriptor.families.flatMap((family, index) => [
      "const FAMILY_NOMINATION_PROGRAMS_" + index + " = Object.freeze([",
      ...family.sourcePlans.map((_plan, planIndex) => "  FAMILY_" + index + "_NOMINATION_PROGRAM_" + planIndex + ","),
      "]);",
      "",
    ]),
    ...descriptor.families.flatMap((family, index) => [
      "const FAMILY_SOURCE_PLANS_" + index + " = Object.freeze([",
      ...family.sourcePlans.map((_plan, planIndex) => "  FAMILY_" + index + "_SOURCE_PLAN_" + planIndex + ","),
      "]);",
      "",
    ]),
    "const FAMILY_RUNTIME_DESCRIPTOR = Object.freeze(",
    JSON.stringify(descriptor, null, 2),
    ") as unknown as GeneratedFamilyRuntimeDescriptorV1;",
    "const STRATEGY_RUNTIME_DESCRIPTOR = Object.freeze(",
    JSON.stringify(strategyDescriptor, null, 2),
    ") as unknown as GeneratedStrategyRuntimeDescriptorV1;",
    "",
    "export const createReleaseFamilyRuntimeComposition: GeneratedFamilyRuntimeFactoryV1 = createGeneratedFamilyRuntimeFactory({",
    "  descriptor: FAMILY_RUNTIME_DESCRIPTOR,",
    "  definitions: [",
    ...descriptor.families.map((_family, index) => "    FAMILY_RUNTIME_DEFINITIONS_" + index + ","),
    "  ],",
    "  extensions: [",
    ...descriptor.families.map((family, familyIndex) => "    Object.freeze([" + family.extensions.map((_extension, extensionIndex) => "FAMILY_" + familyIndex + "_EXTENSION_" + extensionIndex).join(", ") + "]),"),
    "  ],",
    "  actionOwners: [",
    ...descriptor.families.map((family, familyIndex) => "    Object.freeze([" + family.actionOwners.map((_action, actionIndex) => "FAMILY_" + familyIndex + "_ACTION_" + actionIndex).join(", ") + "]),"),
    "  ],",
    "  runtimeAdapters: [",
    ...descriptor.families.map((_family, index) => "    FAMILY_RUNTIME_ADAPTERS_" + index + ","),
    "  ],",
    "  sourcePlans: [",
    ...descriptor.families.map((_family, index) => "    FAMILY_SOURCE_PLANS_" + index + ","),
    "  ],",
    "  nominationPrograms: [",
    ...descriptor.families.map((_family, index) => "    FAMILY_NOMINATION_PROGRAMS_" + index + ","),
    "  ],",
    "});",
    "",
    "export const createReleaseStrategyRuntimeComposition: GeneratedStrategyRuntimeFactoryV1 = createGeneratedStrategyRuntimeFactory({",
    "  descriptor: STRATEGY_RUNTIME_DESCRIPTOR,",
    "  issuers: [",
    ...strategyDescriptor.strategies.map((_entry, index) => "    STRATEGY_" + index + "_PLANNING_PROBLEM_ISSUER,"),
    "  ],",
    "});",
    "",
  ].join("\n");
}

function strategyEntry(
  root: string,
  input: StrategyGenerationInputV1,
  capabilityIndex: CapabilityIndexV1,
  proposedCapabilityRefs: readonly CapabilityRefV1[],
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
    const proposed = proposedCapabilityRefs.find(entry => entry.capabilityId === predicate.capabilityId);
    if (proposed === undefined) throw new TypeError(`missing proposed capability ref ${predicate.capabilityId}`);
    if (proposed.version !== indexed.version || proposed.schemaHash !== indexed.schemaHash || proposed.interpreterHash !== indexed.interpreterHash) {
      throw new TypeError(`proposed capability ref mismatch ${predicate.capabilityId}`);
    }
    entries.push(proposed);
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
    planningTemplate: compiled.entry.planningTemplate,
  });
}

function renderModule(name: string, value: unknown): string {
  return `/* generated by @aloha/catalog-generator; DO NOT EDIT */\nexport const ${name} = Object.freeze(${JSON.stringify(value, null, 2)});\n`;
}

function generatedValuationOwnerRegistry(
  root: string,
  inputs: readonly EconomicValuationOwnerGenerationInputV1[],
  compilerFacts: readonly CatalogCompilerClosureFactV1[],
): GeneratedEconomicValuationOwnerRegistryV1 {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new TypeError("empty valuation-owner BOM is not releaseable");
  const entries = inputs.map(input => {
    const declaration = input.declaration;
    const runtimePath = assertStaticEntrypoint(root, {
      modulePath: declaration.modulePath,
      exportName: declaration.exportName,
    });
    const qualificationSpecPath = assertStaticEntrypoint(root, {
      modulePath: declaration.qualificationModulePath,
      exportName: declaration.qualificationSpecExportName,
    });
    const mutationPath = assertStaticEntrypoint(root, {
      modulePath: declaration.qualificationModulePath,
      exportName: declaration.criticalMutationCorpusExportName,
    });
    const oraclePath = assertStaticEntrypoint(root, {
      modulePath: declaration.qualificationModulePath,
      exportName: declaration.independentOracleCasesExportName,
    });
    if (declaration.qualificationSpecDigest !== economicValuationOwnerQualificationSpecDigestV1(input.qualificationSpec)) {
      throw new TypeError(`valuation-owner qualification spec root mismatch ${declaration.ownerRef}`);
    }
    if (declaration.criticalMutationCorpusRoot !== economicValuationOwnerCriticalMutationCorpusRootV1(input.criticalMutationCorpus)) {
      throw new TypeError(`valuation-owner mutation corpus root mismatch ${declaration.ownerRef}`);
    }
    if (declaration.independentOracleCaseRoot !== economicValuationOwnerIndependentOracleCaseRootV1(input.independentOracleCases)) {
      throw new TypeError(`valuation-owner independent oracle case root mismatch ${declaration.ownerRef}`);
    }
    return sealQualifiedEconomicValuationOwnerEntryV1(
      declaration,
      compilerClosure(compilerFacts, { modulePath: runtimePath, exportName: declaration.exportName }).root,
      {
        qualificationSpecClosureRoot: compilerClosure(compilerFacts, { modulePath: qualificationSpecPath, exportName: declaration.qualificationSpecExportName }).root,
        criticalMutationCorpusClosureRoot: compilerClosure(compilerFacts, { modulePath: mutationPath, exportName: declaration.criticalMutationCorpusExportName }).root,
        independentOracleClosureRoot: compilerClosure(compilerFacts, { modulePath: oraclePath, exportName: declaration.independentOracleCasesExportName }).root,
      },
    );
  }).sort((left, right) => left.ownerRef.localeCompare(right.ownerRef));
  return sealGeneratedEconomicValuationOwnerRegistryV1(entries);
}

function renderValuationOwnerRegistry(registry: GeneratedEconomicValuationOwnerRegistryV1): string {
  const imports = registry.entries.map((entry, index) =>
    `import { ${entry.exportName} as VALUATION_OWNER_${index}_FACTORY } from "../../${entry.modulePath}";`);
  return [
    "/* generated by @aloha/catalog-generator; DO NOT EDIT */",
    "import type { Hash } from \"../../packages/canonical-codec/src/index.ts\";",
    "import { joinEconomicValuationOwnerQualificationSetV1, type EconomicValuationOwnerQualificationCertificateV1, type EconomicValuationOwnerRuntimeBindingV1, type GeneratedEconomicValuationOwnerRegistryV1 } from \"../../specs/economic-valuation-owner/src/index.ts\";",
    ...imports,
    "",
    "const VALUATION_OWNER_REGISTRY = Object.freeze(",
    JSON.stringify(registry, null, 2),
    ") as unknown as GeneratedEconomicValuationOwnerRegistryV1;",
    "",
    "export function readGeneratedEconomicValuationOwnerProposalRegistryV1(): GeneratedEconomicValuationOwnerRegistryV1 {",
    "  return VALUATION_OWNER_REGISTRY;",
    "}",
    "",
    "export function readGeneratedEconomicValuationOwnerRegistryV1(",
    "  qualificationCertificates: readonly EconomicValuationOwnerQualificationCertificateV1[],",
    "  qualifiedValuationOwnerSetRoot: Hash,",
    "): Readonly<{",
    "  registry: GeneratedEconomicValuationOwnerRegistryV1;",
    "  qualificationCertificates: readonly EconomicValuationOwnerQualificationCertificateV1[];",
    "  qualifiedValuationOwnerSetRoot: Hash;",
    "  owners: readonly EconomicValuationOwnerRuntimeBindingV1[];",
    "}> {",
    "  const qualification = joinEconomicValuationOwnerQualificationSetV1(",
    "    VALUATION_OWNER_REGISTRY,",
    "    qualificationCertificates,",
    "    qualifiedValuationOwnerSetRoot,",
    "  );",
    "  const owners: readonly EconomicValuationOwnerRuntimeBindingV1[] = Object.freeze([",
    ...registry.entries.map((entry, index) => [
      `    VALUATION_OWNER_${index}_FACTORY(Object.freeze({`,
      `      supportedAssetRefs: Object.freeze(${JSON.stringify(entry.supportedAssetRefs)}) satisfies readonly Hash[],`,
      `      implementationClosureRoot: ${JSON.stringify(entry.implementationClosureRoot)},`,
      `      qualificationLeafDigest: ${JSON.stringify(entry.qualificationLeafDigest)},`,
      `      valuationOwnerRegistryRoot: ${JSON.stringify(registry.valuationOwnerRegistryRoot)},`,
      "      qualifiedValuationOwnerSetRoot,",
      "    })),",
    ].join("\n")),
    "  ]);",
    "  return Object.freeze({",
    "    registry: qualification.registry,",
    "    qualificationCertificates: qualification.certificates,",
    "    qualifiedValuationOwnerSetRoot: qualification.qualifiedValuationOwnerSetRoot,",
    "    owners,",
    "  });",
    "}",
    "",
  ].join("\n");
}

function generatedEconomicSafetyActionOwnerRegistry(
  descriptor: GeneratedFamilyRuntimeDescriptorV1,
): GeneratedEconomicSafetyActionOwnerRegistryV1 {
  const proposals = descriptor.families.flatMap(family => family.actionOwners.map(owner =>
    sealEconomicSafetyActionOwnerProposalV1({
      familyDefinitionHash: family.entry.familyDefinitionHash,
      ownerId: owner.ownerId,
      ownerRef: owner.ownerRef,
      implementationHash: owner.implementationHash,
      schemaRef: owner.schemaHash,
      implementationClosureRoot: owner.closureRoot,
    }))).sort((left, right) => left.ownerRef.localeCompare(right.ownerRef));
  return sealGeneratedEconomicSafetyActionOwnerRegistryV1(proposals);
}

function renderSafetyProfile(registry: GeneratedEconomicSafetyActionOwnerRegistryV1): string {
  return [
    "// generated by @aloha/catalog-generator; DO NOT EDIT",
    "import type { Hash } from \"../../packages/canonical-codec/src/index.ts\";",
    "import { joinGeneratedEconomicSafetyProfileV1, type EconomicSafetyActionOwnerQualificationCertificateV1, type GeneratedEconomicSafetyActionOwnerRegistryV1, type SafetyProfileV1 } from \"../../specs/economic-safety-profile/src/index.ts\";",
    "",
    "const ACTION_OWNER_REGISTRY = Object.freeze(",
    JSON.stringify(registry, null, 2),
    ") as unknown as GeneratedEconomicSafetyActionOwnerRegistryV1;",
    "",
    "export function readGeneratedEconomicSafetyProfileV1(",
    "  qualificationCertificates: readonly EconomicSafetyActionOwnerQualificationCertificateV1[],",
    "  qualifiedActionOwnerSetRoot: Hash,",
    "  safetyProfile: SafetyProfileV1,",
    "  safetyProfileRoot: Hash,",
    ") {",
    "  return joinGeneratedEconomicSafetyProfileV1(",
    "    ACTION_OWNER_REGISTRY, qualificationCertificates, qualifiedActionOwnerSetRoot, safetyProfile, safetyProfileRoot,",
    "  );",
    "}",
    "",
  ].join("\n");
}

export function generateCatalog(input: CatalogGenerationInputV1): GeneratedCatalogArtifactsV1 {
  if (input === null || typeof input !== "object") throw new TypeError("catalog generation input must be an object");
  const root = resolve(input.repositoryRoot);
  const releaseIntent = input.releaseIntent;
  const compilerFacts = sealCatalogCompilerClosureFacts(input.compilerClosures);
  const proposedCapabilityIds = input.proposedCapabilityRefs.map(ref => ref.capabilityId);
  if (new Set(proposedCapabilityIds).size !== proposedCapabilityIds.length) throw new TypeError("duplicate proposed capability ref");
  const familyById = new Map(input.families.map(item => [item.definition.manifest.familyId, item] as const));
  const strategyById = new Map(input.strategies.map(item => [item.definition.strategyId, item] as const));
  if (!Array.isArray(input.valuationOwners) || input.valuationOwners.length === 0) throw new TypeError("empty valuation-owner BOM is not releaseable");
  if (familyById.size !== input.families.length) throw new TypeError("duplicate Family generation input");
  if (strategyById.size !== input.strategies.length) throw new TypeError("duplicate Strategy generation input");
  const expectedFamilies = new Set(releaseIntent.families.map(entry => entry.familyId));
  const expectedStrategies = new Set(releaseIntent.strategies.map(entry => entry.strategyId));
  if (expectedFamilies.size !== releaseIntent.families.length || expectedStrategies.size !== releaseIntent.strategies.length) throw new TypeError("release intent contains duplicate entry");
  for (const id of familyById.keys()) if (!expectedFamilies.has(id)) throw new TypeError(`unknown Family outside release intent ${id}`);
  for (const id of strategyById.keys()) if (!expectedStrategies.has(id)) throw new TypeError(`unknown Strategy outside release intent ${id}`);
  for (const entry of releaseIntent.families) if (!familyById.has(entry.familyId)) throw new TypeError(`incomplete Family catalog input ${entry.familyId}`);
  for (const entry of releaseIntent.strategies) if (!strategyById.has(entry.strategyId)) throw new TypeError(`incomplete Strategy catalog input ${entry.strategyId}`);
  if (releaseIntent.strategies.length === 0) throw new TypeError("empty Strategy BOM is not releaseable");
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
    for (const plan of definition.manifest.sourcePlans) requireCompiler(plan);
    for (const plan of definition.manifest.sourcePlans) {
      if (plan.nominationProgram.kind !== "present") {
        throw new TypeError(`release source plan lacks nomination qualification ${definition.manifest.familyId}:${plan.sourcePlanId}`);
      }
      requireCompiler(plan.nominationProgram.program);
      requireCompiler(plan.nominationProgram.program.mutationCorpus);
      requireCompiler(plan.nominationProgram.program.independentOracle);
    }
    for (const slot of Object.values(definition.extensions)) if (slot.kind === "present") requireCompiler(slot.module);
    for (const action of definition.actionOwners) requireCompiler(action);
    for (const adapter of Object.values(definition.runtimeAdapters ?? {})) requireCompiler(adapter);
  };
  const collectStrategy = (item: StrategyGenerationInputV1): void => {
    const definition = normalizeStrategyDefinition(item.definition);
    requireCompiler(item.publicEntry);
    requireCompiler(definition);
    requireCompiler(definition.planningProblemIssuer);
  };
  for (const item of input.families) collectFamily(item);
  for (const item of input.strategies) collectStrategy(item);
  for (const item of input.valuationOwners) {
    requireCompiler({ modulePath: item.declaration.modulePath, exportName: item.declaration.exportName });
    requireCompiler({ modulePath: item.declaration.qualificationModulePath, exportName: item.declaration.qualificationSpecExportName });
    requireCompiler({ modulePath: item.declaration.qualificationModulePath, exportName: item.declaration.criticalMutationCorpusExportName });
    requireCompiler({ modulePath: item.declaration.qualificationModulePath, exportName: item.declaration.independentOracleCasesExportName });
  }
  const suppliedCompilerKeys = compilerFacts.map(catalogCompilerClosureFactKey);
  const unknownCompilerFacts = suppliedCompilerKeys.filter(key => !requiredCompilerKeys.has(key) && key !== catalogCompilerClosureFactKey(GENERATOR_ENTRYPOINT));
  if (unknownCompilerFacts.length > 0) throw new TypeError(`unknown catalog compiler closure facts ${unknownCompilerFacts.join(",")}`);
  requireCompiler(GENERATOR_ENTRYPOINT);
  const families = releaseIntent.families.map(entry => familyEntry(root, familyById.get(entry.familyId)!, input.capabilityIndex, compilerFacts));
  const strategies = releaseIntent.strategies.map(entry => strategyEntry(root, strategyById.get(entry.strategyId)!, input.capabilityIndex, input.proposedCapabilityRefs, compilerFacts));
  const familyCatalog = Object.freeze({
    schemaVersion: 1 as const,
    releaseIntentRoot: releaseIntent.releaseIntentRoot,
    capabilityIndexRoot: input.capabilityIndex.capabilityIndexRoot,
    proposedCapabilitySetRoot: hashReleaseQualifiedCapabilityRefsRoot(input.proposedCapabilityRefs),
    entries: Object.freeze(families.sort((left, right) => left.familyId.localeCompare(right.familyId))),
    definitionCatalogRoot: hashDomain("aloha/family-definition-catalog/v1", families.map(entry => entry.definitionCatalogLeafDigest).sort()),
  });
  const strategyCatalog = Object.freeze({
    schemaVersion: 1 as const,
    releaseIntentRoot: releaseIntent.releaseIntentRoot,
    capabilityIndexRoot: input.capabilityIndex.capabilityIndexRoot,
    proposedCapabilitySetRoot: hashReleaseQualifiedCapabilityRefsRoot(input.proposedCapabilityRefs),
    entries: Object.freeze(strategies.sort((left, right) => left.strategyId.localeCompare(right.strategyId))),
    definitionCatalogRoot: hashDomain("aloha/strategy-definition-catalog/v1", strategies.map(entry => entry.definitionCatalogLeafDigest).sort()),
  });
  const globalDefinitionCatalogRoot = hashDomain("aloha/definition-catalog/v1", [
    ...families.map(entry => entry.definitionCatalogLeafDigest),
    ...strategies.map(entry => entry.definitionCatalogLeafDigest),
  ].sort());
  const runtimeFamilies = releaseIntent.families.map(releaseEntry => {
    const source = familyById.get(releaseEntry.familyId)!;
    const generatedEntry = families.find(entry => entry.familyId === releaseEntry.familyId);
    if (generatedEntry === undefined) throw new TypeError("generated Family catalog entry missing " + releaseEntry.familyId);
    return familyRuntimeFamilyDescriptor(root, source, generatedEntry, compilerFacts);
  });
  const familyRuntimeDescriptorValue = familyRuntimeDescriptor(
    releaseIntent.releaseIntentRoot,
    globalDefinitionCatalogRoot,
    hashReleaseQualifiedCapabilityRefsRoot(input.proposedCapabilityRefs),
    runtimeFamilies,
  );
  const runtimeStrategies = releaseIntent.strategies.map(releaseEntry => {
    const source = strategyById.get(releaseEntry.strategyId);
    if (source === undefined) throw new TypeError("generated Strategy input missing " + releaseEntry.strategyId);
    const generatedEntry = strategies.find(entry => entry.strategyId === releaseEntry.strategyId);
    if (generatedEntry === undefined) throw new TypeError("generated Strategy catalog entry missing " + releaseEntry.strategyId);
    return strategyRuntimeEntry(root, source, generatedEntry, compilerFacts);
  });
  const strategyRuntimeDescriptorValue = strategyRuntimeDescriptor(
    releaseIntent.releaseIntentRoot,
    globalDefinitionCatalogRoot,
    hashReleaseQualifiedCapabilityRefsRoot(input.proposedCapabilityRefs),
    runtimeStrategies,
  );
  const valuationOwnerRegistry = generatedValuationOwnerRegistry(root, input.valuationOwners, compilerFacts);
  const economicSafetyActionOwnerRegistry = generatedEconomicSafetyActionOwnerRegistry(familyRuntimeDescriptorValue);
  const familyCatalogText = renderModule("FAMILY_CATALOG", familyCatalog);
  const strategyCatalogText = renderModule("STRATEGY_CATALOG", strategyCatalog);
  const familyRuntimeCompositionText = renderFamilyRuntimeComposition(
    familyRuntimeDescriptorValue,
    strategyRuntimeDescriptorValue,
  );
  const valuationOwnerRegistryText = renderValuationOwnerRegistry(valuationOwnerRegistry);
  const safetyProfileText = renderSafetyProfile(economicSafetyActionOwnerRegistry);
  const inputRecords = Object.freeze([
    canonicalRecord("input/release-intent", releaseIntent),
    canonicalRecord("input/capability-index", input.capabilityIndex),
    canonicalRecord("input/proposed-capability-set", {
      refs: input.proposedCapabilityRefs,
      root: hashReleaseQualifiedCapabilityRefsRoot(input.proposedCapabilityRefs),
    }),
    canonicalRecord("input/compiler-closures", compilerFacts),
    canonicalRecord("input/valuation-owners", input.valuationOwners),
  ].sort((left, right) => left.path.localeCompare(right.path)));
  const compilerRecords = Object.freeze(compilerFacts.filter(fact => catalogCompilerClosureFactKey(fact) !== catalogCompilerClosureFactKey(GENERATOR_ENTRYPOINT)).map(fact => ({
    logicalPath: `${fact.modulePath}#${fact.exportName}`,
    contentSha256: fact.closureDigest,
    byteLength: 0,
    sourceKind: "tracked" as const,
  })));
  const generatorFact = compilerFacts.find(fact => catalogCompilerClosureFactKey(fact) === catalogCompilerClosureFactKey(GENERATOR_ENTRYPOINT))!;
  const generatorRecords = Object.freeze([{ logicalPath: `${generatorFact.modulePath}#${generatorFact.exportName}`, contentSha256: generatorFact.closureDigest, byteLength: 0, sourceKind: "tracked" as const }]);
  const outputRoot = hashDomain("aloha/generated-catalog-output/v1", {
    familyCatalog,
    strategyCatalog,
    globalDefinitionCatalogRoot,
    familyRuntimeDescriptor: familyRuntimeDescriptorValue,
    strategyRuntimeDescriptor: strategyRuntimeDescriptorValue,
    valuationOwnerRegistry,
    economicSafetyActionOwnerRegistry,
  });
  const outputs = Object.freeze([
    Object.freeze({ ...canonicalRecord(FAMILY_OUTPUT_PATH, familyCatalogText), catalogRoot: familyCatalog.definitionCatalogRoot }),
    Object.freeze({ ...canonicalRecord(STRATEGY_OUTPUT_PATH, strategyCatalogText), catalogRoot: strategyCatalog.definitionCatalogRoot }),
    Object.freeze({ ...canonicalRecord(RUNTIME_COMPOSITION_OUTPUT_PATH, familyRuntimeCompositionText), catalogRoot: familyRuntimeDescriptorValue.descriptorRoot }),
    Object.freeze({ ...canonicalRecord(VALUATION_OWNER_REGISTRY_OUTPUT_PATH, valuationOwnerRegistryText), catalogRoot: valuationOwnerRegistry.valuationOwnerRegistryRoot }),
    Object.freeze({ ...canonicalRecord(SAFETY_PROFILE_OUTPUT_PATH, safetyProfileText), catalogRoot: economicSafetyActionOwnerRegistry.actionOwnerRegistryRoot }),
  ]);
  const withoutHash = {
    schemaVersion: 1 as const,
    outputPaths: Object.freeze([FAMILY_OUTPUT_PATH, STRATEGY_OUTPUT_PATH, RUNTIME_COMPOSITION_OUTPUT_PATH, VALUATION_OWNER_REGISTRY_OUTPUT_PATH, SAFETY_PROFILE_OUTPUT_PATH].sort()),
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
    globalDefinitionCatalogRoot,
    familyRuntimeDescriptor: familyRuntimeDescriptorValue,
    strategyRuntimeDescriptor: strategyRuntimeDescriptorValue,
    valuationOwnerRegistry,
    economicSafetyActionOwnerRegistry,
    familyCatalogText,
    strategyCatalogText,
    familyRuntimeCompositionText,
    valuationOwnerRegistryText,
    safetyProfileText,
    outputRoot,
    ledger,
    ledgerText: renderLedger(ledger),
  });
}

/**
 * Project the exact impact facts from generator-owned inputs and outputs.
 * Callers cannot submit affected/reusable conclusions: the projection joins
 * the normalized authoring definitions, qualified compiler facts and the
 * generated catalog/runtime entries produced by this generator invocation.
 */
export function deriveCatalogImpactSnapshotV1(
  input: CatalogGenerationInputV1,
  artifacts: GeneratedCatalogArtifactsV1,
): CatalogImpactSnapshotV1 {
  const compilerFacts = sealCatalogCompilerClosureFacts(input.compilerClosures);
  const leaves = capabilityLeaves(compilerFacts, input.capabilityIndex);
  const familyInputs = new Map(input.families.map(value => [value.definition.manifest.familyId, value] as const));
  const familyRuntime = new Map(artifacts.familyRuntimeDescriptor.families.map(value => [value.entry.familyId, value] as const));
  const familyArtifacts = artifacts.familyCatalog.entries.map(entry => {
    const source = familyInputs.get(entry.familyId);
    const runtime = familyRuntime.get(entry.familyId);
    if (source === undefined || runtime === undefined) throw new TypeError(`generated impact Family facts missing ${entry.familyId}`);
    const definition = normalizeFamilyDefinition(source.definition);
    const requested = [...new Set([
      ...Object.values(definition.extensions).flatMap(slot => slot.kind === "present" ? [slot.module.capabilityId] : []),
      ...Object.values(definition.runtimeAdapters ?? {}).flatMap(adapter => Object.values(adapter.capabilityIds)),
    ])];
    const dependency = artifactDependencyRoot(requested, leaves);
    if (dependency.requestedDependencyRoot !== entry.capabilityCatalogRoot) throw new TypeError(`generated impact Family dependency root mismatch ${entry.familyId}`);
    return Object.freeze({
      artifactId: `family:${entry.familyId}`,
      artifactKind: "family" as const,
      familyId: entry.familyId,
      definitionCatalogLeafDigest: entry.definitionCatalogLeafDigest,
      requestedDependencyClosure: dependency.requestedDependencyClosure,
      requestedDependencyRoot: dependency.requestedDependencyRoot,
      memoRoot: hashDomain("aloha/catalog-family-semantic-memo/v1", entry),
      nominationProposalLeafDigests: Object.freeze(runtime.sourcePlans.map(plan => plan.nominationProgramProposal.proposalLeafDigest).sort()),
    });
  });
  const strategyInputs = new Map(input.strategies.map(value => [value.definition.strategyId, value] as const));
  const strategyArtifacts = artifacts.strategyCatalog.entries.map(entry => {
    const source = strategyInputs.get(entry.strategyId);
    if (source === undefined) throw new TypeError(`generated impact Strategy facts missing ${entry.strategyId}`);
    const definition = normalizeStrategyDefinition(source.definition);
    const dependency = artifactDependencyRoot(definition.requiredCapabilityPredicates.map(value => value.capabilityId), leaves);
    return Object.freeze({
      artifactId: `strategy:${entry.strategyId}`,
      artifactKind: "strategy" as const,
      familyId: null,
      definitionCatalogLeafDigest: entry.definitionCatalogLeafDigest,
      requestedDependencyClosure: dependency.requestedDependencyClosure,
      requestedDependencyRoot: dependency.requestedDependencyRoot,
      memoRoot: hashDomain("aloha/catalog-strategy-semantic-memo/v1", entry),
      nominationProposalLeafDigests: Object.freeze([]),
    });
  });
  return sealCatalogImpactSnapshotV1({
    definitionCatalogRoot: artifacts.globalDefinitionCatalogRoot,
    capabilities: leaves,
    artifacts: [...familyArtifacts, ...strategyArtifacts],
  });
}

/** Missing or unpinned prior state is invalid; there is no implicit empty baseline. */
export function generateCatalogWithImpact(input: CatalogGenerationInputV1, priorInput: CatalogImpactPriorV1): GeneratedCatalogImpactArtifactsV1 {
  if (priorInput === null || typeof priorInput !== "object") throw new TypeError("pinned prior catalog impact snapshot is required");
  const prior = decodeCatalogImpactPriorV1(priorInput);
  const artifacts = generateCatalog(input);
  const impactSnapshot = deriveCatalogImpactSnapshotV1(input, artifacts);
  const impactReceipt = createCatalogImpactReceiptV1({
    pinnedBeforeSnapshotRoot: prior.pinnedSnapshotRoot,
    before: prior.snapshot,
    after: impactSnapshot,
  });
  const impactSnapshotText = `${JSON.stringify(impactSnapshot, null, 2)}\n`;
  const impactReceiptText = `${JSON.stringify(impactReceipt, null, 2)}\n`;
  const inputRecords = Object.freeze([
    ...artifacts.ledger.inputRecords,
    canonicalRecord("input/prior-catalog-impact-identity", {
      origin: prior.origin,
      priorIdentityRoot: prior.priorIdentityRoot,
    }),
    canonicalRecord("input/prior-catalog-impact-pin", {
      pinnedSnapshotRoot: prior.pinnedSnapshotRoot,
    }),
    canonicalRecord("input/prior-catalog-impact-snapshot", prior.snapshot),
  ].sort((left, right) => left.path.localeCompare(right.path)));
  const outputs = Object.freeze([
    ...artifacts.ledger.outputs,
    Object.freeze({ ...canonicalRecord(IMPACT_SNAPSHOT_OUTPUT_PATH, impactSnapshotText), catalogRoot: impactSnapshot.snapshotRoot }),
    Object.freeze({ ...canonicalRecord(IMPACT_RECEIPT_OUTPUT_PATH, impactReceiptText), catalogRoot: impactReceipt.receiptRoot }),
  ].sort((left, right) => left.path.localeCompare(right.path)));
  const { ledgerHash: _priorLedgerHash, ...priorLedgerBase } = artifacts.ledger;
  const ledgerBase = {
    ...priorLedgerBase,
    outputPaths: Object.freeze([...artifacts.ledger.outputPaths, IMPACT_SNAPSHOT_OUTPUT_PATH, IMPACT_RECEIPT_OUTPUT_PATH].sort()),
    inputRecords,
    outputs,
    inputRoot: hashDomain("aloha/catalog-input-root/v1", inputRecords),
  };
  const ledger = Object.freeze({ ...ledgerBase, ledgerHash: ledgerWithoutHash(ledgerBase) });
  return Object.freeze({
    ...artifacts,
    outputRoot: hashDomain("aloha/generated-catalog-output-with-impact/v1", {
      catalogOutputRoot: artifacts.outputRoot,
      impactSnapshotRoot: impactSnapshot.snapshotRoot,
      impactReceiptRoot: impactReceipt.receiptRoot,
    }),
    ledger,
    ledgerText: renderLedger(ledger),
    impactSnapshot,
    impactReceipt,
    impactSnapshotText,
    impactReceiptText,
  });
}

export function writeGeneratedCatalog(rootInput: string, artifacts: GeneratedCatalogArtifactsV1): void {
  const root = resolve(rootInput);
  const familyPath = resolve(root, FAMILY_OUTPUT_PATH);
  const strategyPath = resolve(root, STRATEGY_OUTPUT_PATH);
  const runtimeCompositionPath = resolve(root, RUNTIME_COMPOSITION_OUTPUT_PATH);
  const valuationOwnerRegistryPath = resolve(root, VALUATION_OWNER_REGISTRY_OUTPUT_PATH);
  const safetyProfilePath = resolve(root, SAFETY_PROFILE_OUTPUT_PATH);
  const ledgerPath = resolve(root, LEDGER_OUTPUT_PATH);
  mkdirSync(dirname(familyPath), { recursive: true });
  mkdirSync(dirname(strategyPath), { recursive: true });
  mkdirSync(dirname(runtimeCompositionPath), { recursive: true });
  mkdirSync(dirname(valuationOwnerRegistryPath), { recursive: true });
  mkdirSync(dirname(safetyProfilePath), { recursive: true });
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(familyPath, artifacts.familyCatalogText);
  writeFileSync(strategyPath, artifacts.strategyCatalogText);
  writeFileSync(runtimeCompositionPath, artifacts.familyRuntimeCompositionText);
  writeFileSync(valuationOwnerRegistryPath, artifacts.valuationOwnerRegistryText);
  writeFileSync(safetyProfilePath, artifacts.safetyProfileText);
  writeFileSync(ledgerPath, artifacts.ledgerText);
  if ("impactReceipt" in artifacts) {
    const impact = artifacts as GeneratedCatalogImpactArtifactsV1;
    writeFileSync(resolve(root, IMPACT_SNAPSHOT_OUTPUT_PATH), impact.impactSnapshotText);
    writeFileSync(resolve(root, IMPACT_RECEIPT_OUTPUT_PATH), impact.impactReceiptText);
  }
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
  compare(RUNTIME_COMPOSITION_OUTPUT_PATH, artifacts.familyRuntimeCompositionText);
  compare(VALUATION_OWNER_REGISTRY_OUTPUT_PATH, artifacts.valuationOwnerRegistryText);
  compare(SAFETY_PROFILE_OUTPUT_PATH, artifacts.safetyProfileText);
  if ("impactReceipt" in artifacts) {
    const impact = artifacts as GeneratedCatalogImpactArtifactsV1;
    compare(IMPACT_SNAPSHOT_OUTPUT_PATH, impact.impactSnapshotText);
    compare(IMPACT_RECEIPT_OUTPUT_PATH, impact.impactReceiptText);
  }
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

export function checkGeneratedCatalogWithImpact(input: CatalogGenerationInputV1, prior: CatalogImpactPriorV1): readonly string[] {
  try {
    const artifacts = generateCatalogWithImpact(input, prior);
    return verifyCatalogLedger(input.repositoryRoot, artifacts);
  } catch (error) {
    return Object.freeze([`generation-failed:${String(error)}`]);
  }
}
