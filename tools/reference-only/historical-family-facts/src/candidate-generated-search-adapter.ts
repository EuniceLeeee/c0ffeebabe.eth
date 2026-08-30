import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertExactKeys,
  decodeCanonicalBytes,
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import { createReleaseFamilyRuntimeComposition } from "../../../../generated/runtime-composition/index.ts";
import {
  readGeneratedFamilyRuntimeAdapterFactories,
  readGeneratedFamilyRuntimeFactoryMetadata,
  type GeneratedFamilyRuntimeFactoryMetadataV1,
} from "../../../../packages/family-composition/src/internal/generated-runtime-composition.ts";
import type {
  GeneratedFamilyRuntimeActionOwnerV1,
  GeneratedFamilyRuntimeAdapterV1,
  GeneratedFamilyRuntimeExtensionV1,
} from "../../../../packages/family-composition/src/index.ts";
import {
  familySearchAmount,
  familySearchExecutionContext,
  familySearchObjective,
  familySearchSource,
  validateFamilySearchRouteLegBinding,
  type FamilySearchAdapterFactoryV1,
  type FamilySearchAdapterV1,
  type FamilySearchCurrentSourceV1,
  type FamilySearchLegRequestV1,
  type FamilySearchRunArtifactsV1,
  type FamilySearchStageOutcomeV1,
} from "../../../../packages/family-sdk/search-runtime/index.ts";
import type { ActionOwnerRef, StageCapabilityRefV1 } from "../../../../packages/family-sdk/runtime-refs/index.ts";
import {
  createFamilyCurrentSourceCaptureV1,
  createFrozenFamilyCurrentSourceReplayV1,
  type GeneratedFamilySearchAdapterBindingV1,
} from "./family-current-source-replay.ts";
import {
  verifyCandidateGeneratedSourceBindingV1,
  type CandidateGeneratedSourceBindingV1,
} from "./candidate-generated-source-binding.ts";
import { writeImmutableFile } from "./immutable-file.ts";

export const CANDIDATE_GENERATED_SEARCH_DIAGNOSTIC_MANIFEST_KIND =
  "aloha.candidate-generated-search-adapter-diagnostic-v1" as const;

const GENERATED_RUNTIME_PATH = fileURLToPath(new URL(
  "../../../../generated/runtime-composition/index.ts",
  import.meta.url,
));
const GENERATED_RUNTIME_LOGICAL_PATH = "generated/runtime-composition/index.ts";
const GENERATED_RUNTIME_URL = new URL(
  "../../../../generated/runtime-composition/index.ts",
  import.meta.url,
);
const REPOSITORY_ROOT_URL = new URL("../../../../", import.meta.url);
const STORE_DIRECTORY = "candidate-generated-search-adapter-v1";

type MetadataFamily = GeneratedFamilyRuntimeFactoryMetadataV1["families"][number];
type RunResult = FamilySearchStageOutcomeV1<FamilySearchRunArtifactsV1>;
type NeutralLegRequest = Omit<FamilySearchLegRequestV1, "currentSource">;

export interface CandidateGeneratedSearchAdapterBindingV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly generatedRuntimePath: string;
  readonly generatedRuntimeSourceHash: Hash;
  readonly generatedFactoryDescriptorRoot: Hash;
  readonly familyOrdinal: string;
  readonly adapterOrdinal: string;
  readonly adapter: Readonly<{
    role: "search/v1";
    modulePath: string;
    exportName: string;
    closureRoot: Hash;
    leafDigest: Hash;
  }>;
  readonly generatedStaticImportBindingRoot: Hash;
  readonly extensionImportRoot: Hash;
  readonly actionOwnerImportRoot: Hash;
}

export interface CandidateGeneratedSearchDiagnosticManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof CANDIDATE_GENERATED_SEARCH_DIAGNOSTIC_MANIFEST_KIND;
  readonly advisoryOnly: true;
  readonly candidateGeneratedAdapterExecuted: true;
  readonly generatedStaticImportBound: true;
  readonly implementationClosureQualified: false;
  readonly chainStateQualified: false;
  readonly releaseQualified: false;
  readonly productionAcceptance: false;
  readonly adapterVerdictQualified: false;
  readonly runResultClaimLevel: "untrusted-candidate-outcome-diagnostic-only";
  readonly fenceClaimLevel: "before-after-observation-only-a-b-a-not-excluded";
  readonly binding: CandidateGeneratedSearchAdapterBindingV1;
  readonly runRequestHash: Hash;
  readonly runResult: CanonicalJson;
  readonly runResultHash: Hash;
  readonly currentSourceManifestRoot: Hash;
  readonly manifestRoot: Hash;
}

export type CandidateGeneratedSearchCaptureResultV1 =
  | Readonly<{
    kind: "sealed";
    manifest: CandidateGeneratedSearchDiagnosticManifestV1;
    result: RunResult;
  }>
  | Readonly<{
    kind: "unsealed";
    candidateGeneratedAdapterExecuted: true;
    generatedStaticImportBound: true;
    implementationClosureQualified: false;
    chainStateQualified: false;
    releaseQualified: false;
    productionAcceptance: false;
    advisoryOnly: true;
    adapterVerdictQualified: false;
    runResultClaimLevel: "untrusted-candidate-outcome-diagnostic-only";
    fenceClaimLevel: "before-after-observation-only-a-b-a-not-excluded";
    result: RunResult | null;
    reasonCode: string;
  }>;

interface BoundCandidate {
  readonly binding: CandidateGeneratedSearchAdapterBindingV1;
  readonly family: MetadataFamily;
  readonly adapterDescriptor: GeneratedFamilyRuntimeAdapterV1;
  readonly adapter: FamilySearchAdapterV1;
}

function fail(message: string): never {
  throw new TypeError(message);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) fail(`${path} must be a plain object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${path} must be non-empty text`);
  return value;
}

function hash(value: unknown, path: string): Hash {
  const selected = text(value, path).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(selected)) fail(`${path} must be a hash`);
  return selected as Hash;
}

function canonical(value: unknown, path: string): CanonicalJson {
  try {
    return decodeCanonicalBytes(encodeCanonicalBytes(value));
  } catch (error) {
    fail(`${path} must be canonical: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalBytes(left)).equals(Buffer.from(encodeCanonicalBytes(right)));
}

function exactRef(left: unknown, right: unknown): boolean {
  return canonicalEqual(left, right);
}

function moduleUrl(modulePath: string): URL {
  if (!/^[a-z0-9][a-z0-9._/-]*\.ts$/.test(modulePath) || modulePath.includes("..")) {
    fail("generated modulePath is invalid");
  }
  return new URL(modulePath, REPOSITORY_ROOT_URL);
}

async function exactImportedValues(
  descriptorModulePath: string,
  exportName: string,
  staticModuleSpecifier: string,
  path: string,
): Promise<Readonly<{ owner: unknown; staticAlias: unknown }>> {
  const descriptorModule = await import(moduleUrl(descriptorModulePath).href);
  const staticModule = await import(new URL(staticModuleSpecifier, GENERATED_RUNTIME_URL).href);
  if (!Object.hasOwn(descriptorModule, exportName) || !Object.hasOwn(staticModule, exportName)) {
    fail(`${path} exact named export is missing`);
  }
  return Object.freeze({ owner: descriptorModule[exportName], staticAlias: staticModule[exportName] });
}

function importRoot(
  domain: string,
  descriptors: readonly (GeneratedFamilyRuntimeExtensionV1 | GeneratedFamilyRuntimeActionOwnerV1)[],
  staticBinding: CandidateGeneratedSourceBindingV1,
  kind: "extension" | "action",
): Hash {
  const imports = kind === "extension" ? staticBinding.extensionImports : staticBinding.actionOwnerImports;
  return hashDomain(domain, descriptors.map((descriptor, index) => ({
    descriptor,
    staticImport: imports[index],
  })));
}

function normalizedCurrentSource(value: FamilySearchCurrentSourceV1): FamilySearchCurrentSourceV1 {
  const selected = object(value, "candidate.currentSource");
  assertExactKeys(selected, ["source", "assertCurrent"], "candidate.currentSource");
  if (typeof selected.assertCurrent !== "function") fail("candidate.currentSource.assertCurrent must be a function");
  return Object.freeze({
    source: familySearchSource(selected.source, "candidate.currentSource.source"),
    assertCurrent: selected.assertCurrent as FamilySearchCurrentSourceV1["assertCurrent"],
  });
}

function normalizedLeg(value: NeutralLegRequest): NeutralLegRequest {
  const selected = object(value, "candidate.request");
  assertExactKeys(selected, ["route", "objective", "amount", "execution"], "candidate.request");
  const amount = familySearchAmount(selected.amount as never, "candidate.request.amount");
  const execution = familySearchExecutionContext(selected.execution as never, "candidate.request.execution");
  if (amount.recipient !== execution.executorAddress) fail("candidate request executor/recipient mismatch");
  return Object.freeze({
    route: validateFamilySearchRouteLegBinding(selected.route),
    objective: familySearchObjective(selected.objective as never, "candidate.request.objective"),
    amount,
    execution,
  });
}

function runRequestHash(request: NeutralLegRequest, currentSource: FamilySearchCurrentSourceV1): Hash {
  return hashDomain("aloha/candidate-generated-search-run-request/v1", {
    route: request.route,
    source: currentSource.source,
    objective: request.objective,
    amount: request.amount,
    execution: request.execution,
  });
}

function resultHash(result: CanonicalJson): Hash {
  return hashDomain("aloha/candidate-generated-search-run-result/v1", result);
}

function bindingRootValue(
  sourceBinding: CandidateGeneratedSourceBindingV1,
  family: MetadataFamily,
  adapter: GeneratedFamilyRuntimeAdapterV1,
): CandidateGeneratedSearchAdapterBindingV1 {
  const sourceBytes = Uint8Array.from(readFileSync(GENERATED_RUNTIME_PATH));
  const extensionImportRoot = importRoot(
    "aloha/candidate-generated-search-extension-imports/v1",
    family.extensions,
    sourceBinding,
    "extension",
  );
  const actionOwnerImportRoot = importRoot(
    "aloha/candidate-generated-search-action-imports/v1",
    family.actionOwners,
    sourceBinding,
    "action",
  );
  const staticObservation = {
    familyOrdinal: String(sourceBinding.familyOrdinal),
    adapterOrdinal: String(sourceBinding.adapterOrdinal),
    adapterImport: sourceBinding.adapterImport,
    extensionImports: sourceBinding.extensionImports,
    actionOwnerImports: sourceBinding.actionOwnerImports,
  };
  return Object.freeze({
    familyId: family.familyId,
    familyDefinitionHash: family.familyDefinitionHash,
    generatedRuntimePath: GENERATED_RUNTIME_LOGICAL_PATH,
    generatedRuntimeSourceHash: sha256Hex(sourceBytes),
    generatedFactoryDescriptorRoot: readGeneratedFamilyRuntimeFactoryMetadata(
      createReleaseFamilyRuntimeComposition,
    ).descriptorRoot,
    familyOrdinal: String(sourceBinding.familyOrdinal),
    adapterOrdinal: String(sourceBinding.adapterOrdinal),
    adapter: Object.freeze({
      role: "search/v1",
      modulePath: adapter.modulePath,
      exportName: adapter.exportName,
      closureRoot: adapter.closureRoot,
      leafDigest: adapter.leafDigest,
    }),
    generatedStaticImportBindingRoot: hashDomain(
      "aloha/candidate-generated-search-static-import-binding/v1",
      staticObservation,
    ),
    extensionImportRoot,
    actionOwnerImportRoot,
  });
}

function currentSourceBinding(
  binding: CandidateGeneratedSearchAdapterBindingV1,
): GeneratedFamilySearchAdapterBindingV1 {
  return Object.freeze({
    familyId: binding.familyId,
    familyDefinitionHash: binding.familyDefinitionHash,
    role: binding.adapter.role,
    modulePath: binding.adapter.modulePath,
    exportName: binding.adapter.exportName,
    closureRoot: binding.adapter.closureRoot,
    leafDigest: binding.adapter.leafDigest,
    generatedRuntimePath: binding.generatedRuntimePath,
    generatedRuntimeSourceHash: binding.generatedRuntimeSourceHash,
  });
}

function unsealed(
  result: RunResult | null,
  reasonCode: string,
): CandidateGeneratedSearchCaptureResultV1 {
  return Object.freeze({
    kind: "unsealed",
    candidateGeneratedAdapterExecuted: true,
    generatedStaticImportBound: true,
    implementationClosureQualified: false,
    chainStateQualified: false,
    releaseQualified: false,
    productionAcceptance: false,
    advisoryOnly: true,
    adapterVerdictQualified: false,
    runResultClaimLevel: "untrusted-candidate-outcome-diagnostic-only",
    fenceClaimLevel: "before-after-observation-only-a-b-a-not-excluded",
    result,
    reasonCode,
  });
}

async function bindCandidate(familyId: string): Promise<BoundCandidate> {
  const metadata = readGeneratedFamilyRuntimeFactoryMetadata(createReleaseFamilyRuntimeComposition);
  const families = metadata.families.filter((family) => family.familyId === familyId);
  if (families.length !== 1) fail(`canonical generated family must be unique ${familyId}`);
  const family = families[0]!;
  const adapters = family.runtimeAdapters.filter((adapter) => adapter.role === "search/v1");
  if (adapters.length !== 1) fail(`canonical generated search/v1 Adapter must be unique ${familyId}`);
  const adapterDescriptor = adapters[0]!;
  const source = readFileSync(GENERATED_RUNTIME_PATH, "utf8");
  const sourceBinding = verifyCandidateGeneratedSourceBindingV1({ source, metadata, familyId });

  const extensionImports = await Promise.all(family.extensions.map((extension, index) =>
    exactImportedValues(
      extension.modulePath,
      extension.exportName,
      sourceBinding.extensionImports[index]!.moduleSpecifier,
      `candidate extension ${index}`,
    )));
  const actionImports = await Promise.all(family.actionOwners.map((owner, index) =>
    exactImportedValues(
      owner.modulePath,
      owner.exportName,
      sourceBinding.actionOwnerImports[index]!.moduleSpecifier,
      `candidate action owner ${index}`,
    )));
  const factoryImports = await exactImportedValues(
    adapterDescriptor.modulePath,
    adapterDescriptor.exportName,
    sourceBinding.adapterImport.moduleSpecifier,
    "candidate search Adapter factory",
  );
  const generatedFactories = readGeneratedFamilyRuntimeAdapterFactories(createReleaseFamilyRuntimeComposition)
    .filter((binding) => binding.familyDefinitionHash === family.familyDefinitionHash
      && binding.descriptor.role === "search/v1");
  if (generatedFactories.length !== 1) fail("candidate generated search Adapter factory is missing or duplicated");
  if (!canonicalEqual(generatedFactories[0]!.descriptor, adapterDescriptor)) {
    fail("candidate generated search Adapter factory descriptor mismatch");
  }
  const actualFactory = generatedFactories[0]!.actualFactory;
  if (factoryImports.owner !== actualFactory || factoryImports.staticAlias !== actualFactory) {
    fail("candidate generated search Adapter owner/static/factory identity mismatch");
  }
  if (typeof actualFactory !== "function") fail("candidate search Adapter factory is not a function");
  const extensionValues = extensionImports.map((value, index) => {
    if (value.owner !== value.staticAlias) fail(`candidate extension owner/static identity mismatch ${index}`);
    return value.staticAlias;
  });
  const actionValues = actionImports.map((value, index) => {
    if (value.owner !== value.staticAlias) fail(`candidate action owner/static identity mismatch ${index}`);
    return value.staticAlias;
  });

  const declaredCapabilities = Object.entries(adapterDescriptor.capabilityRefs);
  const declaredActions = Object.entries(adapterDescriptor.actionOwnerRefs);
  if (declaredCapabilities.length !== family.extensions.length) fail("candidate search Adapter capability set is incomplete");
  if (declaredActions.length !== family.actionOwners.length) fail("candidate search Adapter action-owner set is incomplete");
  const capabilityMatches = declaredCapabilities.map(([role, ref]) => {
    const matches = family.extensions
      .map((extension, index) => Object.freeze({ extension, value: extensionValues[index]! }))
      .filter(({ extension }) => exactRef(extension.capabilityRef, ref));
    if (matches.length !== 1) fail(`candidate search Adapter capability import is missing or duplicated ${role}`);
    return Object.freeze({ role, ref, value: matches[0]!.value });
  });
  const actionMatches = declaredActions.map(([role, ref]) => {
    const matches = family.actionOwners
      .map((owner, index) => Object.freeze({ owner, value: actionValues[index]! }))
      .filter(({ owner }) => owner.ownerRef === ref);
    if (matches.length !== 1) fail(`candidate search Adapter action import is missing or duplicated ${role}`);
    return Object.freeze({ role, ref, value: matches[0]!.value });
  });
  const resolvedCapabilities = new Set<string>();
  const resolvedActions = new Set<string>();
  const resolver = Object.freeze({
    resolveCapability(familyDefinitionHash: Hash, ref: StageCapabilityRefV1): object {
      if (familyDefinitionHash !== family.familyDefinitionHash) fail("candidate resolver cross-family capability hash");
      const matches = capabilityMatches.filter((value) => exactRef(value.ref, ref));
      if (matches.length !== 1) fail("candidate resolver capability is undeclared");
      if (resolvedCapabilities.has(matches[0]!.role)) fail("candidate resolver capability was resolved more than once");
      resolvedCapabilities.add(matches[0]!.role);
      const value = matches[0]!.value;
      if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        fail("candidate resolver capability export is invalid");
      }
      return value as object;
    },
    resolveActionOwner(familyDefinitionHash: Hash, ref: ActionOwnerRef): object {
      if (familyDefinitionHash !== family.familyDefinitionHash) fail("candidate resolver cross-family action hash");
      const matches = actionMatches.filter((value) => value.ref === ref);
      if (matches.length !== 1) fail("candidate resolver action owner is undeclared");
      if (resolvedActions.has(matches[0]!.role)) fail("candidate resolver action owner was resolved more than once");
      resolvedActions.add(matches[0]!.role);
      const value = matches[0]!.value;
      if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        fail("candidate resolver action-owner export is invalid");
      }
      return value as object;
    },
  });
  const adapter = (actualFactory as FamilySearchAdapterFactoryV1)({
    composition: resolver,
    familyDefinitionHash: family.familyDefinitionHash,
    capabilityRefs: adapterDescriptor.capabilityRefs,
    actionOwnerRefs: adapterDescriptor.actionOwnerRefs,
  });
  if (resolvedCapabilities.size !== declaredCapabilities.length) fail("candidate Adapter factory did not resolve every capability");
  if (resolvedActions.size !== declaredActions.length) fail("candidate Adapter factory did not resolve every action owner");
  if (adapter === null || typeof adapter !== "object") fail("candidate search Adapter factory returned an invalid Adapter");
  for (const method of ["readState", "projectCoarse", "evaluateExact", "buildAction", "run"] as const) {
    if (typeof adapter[method] !== "function") fail(`candidate search Adapter is missing ${method}`);
  }
  return Object.freeze({
    binding: bindingRootValue(sourceBinding, family, adapterDescriptor),
    family,
    adapterDescriptor,
    adapter,
  });
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`candidate diagnostic path is not a real directory: ${path}`);
}

function manifestRoot(base: Omit<CandidateGeneratedSearchDiagnosticManifestV1, "manifestRoot">): Hash {
  return hashDomain("aloha/candidate-generated-search-adapter-diagnostic/v1", base);
}

function materializeManifest(rootDirectory: string, manifest: CandidateGeneratedSearchDiagnosticManifestV1): void {
  const directory = join(resolve(rootDirectory), STORE_DIRECTORY, "manifests");
  ensureDirectory(directory);
  writeImmutableFile(
    join(directory, `${manifest.manifestRoot.slice(2)}.json`),
    encodeCanonicalBytes(manifest),
    "immutable candidate generated search diagnostic changed",
  );
}

function decodeBinding(value: unknown): CandidateGeneratedSearchAdapterBindingV1 {
  const selected = object(value, "$.manifest.binding");
  assertExactKeys(selected, [
    "familyId", "familyDefinitionHash", "generatedRuntimePath", "generatedRuntimeSourceHash",
    "generatedFactoryDescriptorRoot", "familyOrdinal", "adapterOrdinal", "adapter",
    "generatedStaticImportBindingRoot", "extensionImportRoot", "actionOwnerImportRoot",
  ], "$.manifest.binding");
  const adapter = object(selected.adapter, "$.manifest.binding.adapter");
  assertExactKeys(adapter, ["role", "modulePath", "exportName", "closureRoot", "leafDigest"], "$.manifest.binding.adapter");
  if (adapter.role !== "search/v1") fail("candidate diagnostic Adapter role mismatch");
  const familyOrdinal = text(selected.familyOrdinal, "$.manifest.binding.familyOrdinal");
  const adapterOrdinal = text(selected.adapterOrdinal, "$.manifest.binding.adapterOrdinal");
  if (!/^(0|[1-9][0-9]*)$/.test(familyOrdinal) || !/^(0|[1-9][0-9]*)$/.test(adapterOrdinal)) {
    fail("candidate diagnostic generated ordinal is invalid");
  }
  return Object.freeze({
    familyId: text(selected.familyId, "$.manifest.binding.familyId"),
    familyDefinitionHash: hash(selected.familyDefinitionHash, "$.manifest.binding.familyDefinitionHash"),
    generatedRuntimePath: text(selected.generatedRuntimePath, "$.manifest.binding.generatedRuntimePath"),
    generatedRuntimeSourceHash: hash(selected.generatedRuntimeSourceHash, "$.manifest.binding.generatedRuntimeSourceHash"),
    generatedFactoryDescriptorRoot: hash(selected.generatedFactoryDescriptorRoot, "$.manifest.binding.generatedFactoryDescriptorRoot"),
    familyOrdinal,
    adapterOrdinal,
    adapter: Object.freeze({
      role: "search/v1",
      modulePath: text(adapter.modulePath, "$.manifest.binding.adapter.modulePath"),
      exportName: text(adapter.exportName, "$.manifest.binding.adapter.exportName"),
      closureRoot: hash(adapter.closureRoot, "$.manifest.binding.adapter.closureRoot"),
      leafDigest: hash(adapter.leafDigest, "$.manifest.binding.adapter.leafDigest"),
    }),
    generatedStaticImportBindingRoot: hash(selected.generatedStaticImportBindingRoot, "$.manifest.binding.generatedStaticImportBindingRoot"),
    extensionImportRoot: hash(selected.extensionImportRoot, "$.manifest.binding.extensionImportRoot"),
    actionOwnerImportRoot: hash(selected.actionOwnerImportRoot, "$.manifest.binding.actionOwnerImportRoot"),
  });
}

function loadManifest(rootDirectory: string, expectedManifestRoot: Hash): CandidateGeneratedSearchDiagnosticManifestV1 {
  const expected = hash(expectedManifestRoot, "expectedManifestRoot");
  const path = join(resolve(rootDirectory), STORE_DIRECTORY, "manifests", `${expected.slice(2)}.json`);
  if (!existsSync(path)) fail("candidate generated search diagnostic manifest is missing");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("candidate generated search diagnostic manifest is not a regular file");
  const bytes = Uint8Array.from(readFileSync(path));
  const decodedBytes = decodeCanonicalBytes(bytes);
  const selected = object(decodedBytes, "$.manifest");
  assertExactKeys(selected, [
    "schemaVersion", "kind", "advisoryOnly", "candidateGeneratedAdapterExecuted", "generatedStaticImportBound",
    "implementationClosureQualified", "chainStateQualified", "releaseQualified", "productionAcceptance",
    "adapterVerdictQualified", "runResultClaimLevel", "fenceClaimLevel",
    "binding", "runRequestHash", "runResult", "runResultHash", "currentSourceManifestRoot", "manifestRoot",
  ], "$.manifest");
  if (
    selected.schemaVersion !== 1 ||
    selected.kind !== CANDIDATE_GENERATED_SEARCH_DIAGNOSTIC_MANIFEST_KIND ||
    selected.advisoryOnly !== true ||
    selected.candidateGeneratedAdapterExecuted !== true ||
    selected.generatedStaticImportBound !== true ||
    selected.implementationClosureQualified !== false ||
    selected.chainStateQualified !== false ||
    selected.releaseQualified !== false ||
    selected.productionAcceptance !== false ||
    selected.adapterVerdictQualified !== false ||
    selected.runResultClaimLevel !== "untrusted-candidate-outcome-diagnostic-only" ||
    selected.fenceClaimLevel !== "before-after-observation-only-a-b-a-not-excluded"
  ) fail("invalid candidate generated search diagnostic discriminator");
  const binding = decodeBinding(selected.binding);
  const runResult = canonical(selected.runResult, "$.manifest.runResult");
  const runResultHash = hash(selected.runResultHash, "$.manifest.runResultHash");
  if (runResultHash !== resultHash(runResult)) fail("candidate diagnostic run result hash mismatch");
  const base = {
    schemaVersion: 1 as const,
    kind: CANDIDATE_GENERATED_SEARCH_DIAGNOSTIC_MANIFEST_KIND,
    advisoryOnly: true as const,
    candidateGeneratedAdapterExecuted: true as const,
    generatedStaticImportBound: true as const,
    implementationClosureQualified: false as const,
    chainStateQualified: false as const,
    releaseQualified: false as const,
    productionAcceptance: false as const,
    adapterVerdictQualified: false as const,
    runResultClaimLevel: "untrusted-candidate-outcome-diagnostic-only" as const,
    fenceClaimLevel: "before-after-observation-only-a-b-a-not-excluded" as const,
    binding,
    runRequestHash: hash(selected.runRequestHash, "$.manifest.runRequestHash"),
    runResult,
    runResultHash,
    currentSourceManifestRoot: hash(selected.currentSourceManifestRoot, "$.manifest.currentSourceManifestRoot"),
  };
  const root = hash(selected.manifestRoot, "$.manifest.manifestRoot");
  if (root !== manifestRoot(base)) fail("candidate generated search diagnostic manifest root mismatch");
  const manifest = Object.freeze({ ...base, manifestRoot: root });
  if (!canonicalEqual(manifest, decodedBytes)) fail("candidate diagnostic manifest bytes are not canonical");
  if (root !== expected) fail("loaded candidate diagnostic manifest root mismatch");
  return manifest;
}

/** Read-only candidate binding inspection; it never opens the release composition. */
export async function inspectCandidateGeneratedSearchAdapterV1(
  familyId: string,
): Promise<CandidateGeneratedSearchAdapterBindingV1> {
  return (await bindCandidate(text(familyId, "familyId"))).binding;
}

export async function captureCandidateGeneratedSearchAdapterV1(input: Readonly<{
  rootDirectory: string;
  familyId: string;
  endpoint: string | URL;
  currentSource: FamilySearchCurrentSourceV1;
  request: NeutralLegRequest;
  timeoutMs?: number;
  headers?: Readonly<Record<string, string>>;
}>): Promise<CandidateGeneratedSearchCaptureResultV1> {
  const keys = ["rootDirectory", "familyId", "endpoint", "currentSource", "request"];
  if (Object.hasOwn(input, "timeoutMs")) keys.push("timeoutMs");
  if (Object.hasOwn(input, "headers")) keys.push("headers");
  assertExactKeys(input, keys, "candidate.captureOptions");
  const currentSource = normalizedCurrentSource(input.currentSource);
  const request = normalizedLeg(input.request);
  const bound = await bindCandidate(text(input.familyId, "familyId"));
  const transport = createFamilyCurrentSourceCaptureV1({
    rootDirectory: input.rootDirectory,
    familyId: bound.family.familyId,
    endpoint: input.endpoint,
    currentSource,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.headers === undefined ? {} : { headers: input.headers }),
  });
  if (!canonicalEqual(currentSourceBinding(bound.binding), transport.binding)) {
    fail("candidate/current-source generated binding mismatch before run");
  }
  let result: RunResult;
  try {
    result = await bound.adapter.run({ ...request, currentSource, readPort: transport.readPort });
  } catch (error) {
    return unsealed(null, `candidate Adapter threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.kind !== "verified") {
    return unsealed(result, `candidate Adapter did not publish verified artifacts: ${result.kind}`);
  }
  let fresh: BoundCandidate;
  try {
    fresh = await bindCandidate(bound.family.familyId);
  } catch (error) {
    return unsealed(result, `candidate generated search binding refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!canonicalEqual(bound.binding, fresh.binding)) {
    return unsealed(result, "candidate generated search binding changed during run");
  }
  let currentSourceManifestRoot: Hash;
  try {
    const currentSourceManifest = await transport.seal();
    if (!canonicalEqual(currentSourceBinding(bound.binding), currentSourceManifest.canonicalGeneratedBinding)) {
      return unsealed(result, "candidate/current-source sealed generated binding mismatch");
    }
    currentSourceManifestRoot = currentSourceManifest.manifestRoot;
  } catch (error) {
    return unsealed(result, error instanceof Error ? error.message : String(error));
  }
  let canonicalResult: CanonicalJson;
  try {
    canonicalResult = canonical(result, "candidate.runResult");
  } catch (error) {
    return unsealed(result, error instanceof Error ? error.message : String(error));
  }
  const base = {
    schemaVersion: 1 as const,
    kind: CANDIDATE_GENERATED_SEARCH_DIAGNOSTIC_MANIFEST_KIND,
    advisoryOnly: true as const,
    candidateGeneratedAdapterExecuted: true as const,
    generatedStaticImportBound: true as const,
    implementationClosureQualified: false as const,
    chainStateQualified: false as const,
    releaseQualified: false as const,
    productionAcceptance: false as const,
    adapterVerdictQualified: false as const,
    runResultClaimLevel: "untrusted-candidate-outcome-diagnostic-only" as const,
    fenceClaimLevel: "before-after-observation-only-a-b-a-not-excluded" as const,
    binding: bound.binding,
    runRequestHash: runRequestHash(request, currentSource),
    runResult: canonicalResult,
    runResultHash: resultHash(canonicalResult),
    currentSourceManifestRoot,
  };
  const manifest = Object.freeze({ ...base, manifestRoot: manifestRoot(base) });
  materializeManifest(input.rootDirectory, manifest);
  loadManifest(input.rootDirectory, manifest.manifestRoot);
  return Object.freeze({ kind: "sealed", manifest, result });
}

export async function replayCandidateGeneratedSearchAdapterV1(input: Readonly<{
  rootDirectory: string;
  manifestRoot: Hash;
  currentSource: FamilySearchCurrentSourceV1;
  request: NeutralLegRequest;
}>): Promise<
  | Readonly<{ kind: "replayed"; manifest: CandidateGeneratedSearchDiagnosticManifestV1; result: RunResult }>
  | Extract<CandidateGeneratedSearchCaptureResultV1, { kind: "unsealed" }>
> {
  assertExactKeys(input, ["rootDirectory", "manifestRoot", "currentSource", "request"], "candidate.replayOptions");
  const manifest = loadManifest(input.rootDirectory, input.manifestRoot);
  const currentSource = normalizedCurrentSource(input.currentSource);
  const request = normalizedLeg(input.request);
  if (runRequestHash(request, currentSource) !== manifest.runRequestHash) fail("candidate frozen run request mismatch");
  const bound = await bindCandidate(manifest.binding.familyId);
  if (!canonicalEqual(bound.binding, manifest.binding)) fail("candidate frozen generated binding mismatch");
  const transport = createFrozenFamilyCurrentSourceReplayV1({
    rootDirectory: input.rootDirectory,
    manifestRoot: manifest.currentSourceManifestRoot,
  });
  if (!canonicalEqual(currentSourceBinding(bound.binding), transport.binding)) {
    fail("candidate/current-source frozen generated binding mismatch before replay");
  }
  let result: RunResult;
  try {
    result = await bound.adapter.run({ ...request, currentSource, readPort: transport.readPort });
  } catch (error) {
    return unsealed(null, `candidate Adapter replay threw: ${error instanceof Error ? error.message : String(error)}`) as Extract<CandidateGeneratedSearchCaptureResultV1, { kind: "unsealed" }>;
  }
  if (result.kind !== "verified") {
    return unsealed(result, `candidate Adapter replay did not publish verified artifacts: ${result.kind}`) as Extract<CandidateGeneratedSearchCaptureResultV1, { kind: "unsealed" }>;
  }
  try {
    transport.assertExactTranscriptConsumed();
  } catch (error) {
    return unsealed(result, error instanceof Error ? error.message : String(error)) as Extract<CandidateGeneratedSearchCaptureResultV1, { kind: "unsealed" }>;
  }
  let fresh: BoundCandidate;
  try {
    fresh = await bindCandidate(manifest.binding.familyId);
  } catch (error) {
    return unsealed(result, `candidate frozen binding refresh failed: ${error instanceof Error ? error.message : String(error)}`) as Extract<CandidateGeneratedSearchCaptureResultV1, { kind: "unsealed" }>;
  }
  if (!canonicalEqual(bound.binding, fresh.binding)) {
    return unsealed(result, "candidate frozen generated binding changed during replay") as Extract<CandidateGeneratedSearchCaptureResultV1, { kind: "unsealed" }>;
  }
  let canonicalResult: CanonicalJson;
  try {
    canonicalResult = canonical(result, "candidate.replayedResult");
  } catch (error) {
    return unsealed(result, error instanceof Error ? error.message : String(error)) as Extract<CandidateGeneratedSearchCaptureResultV1, { kind: "unsealed" }>;
  }
  if (resultHash(canonicalResult) !== manifest.runResultHash || !canonicalEqual(canonicalResult, manifest.runResult)) {
    return unsealed(result, "candidate frozen run result mismatch") as Extract<CandidateGeneratedSearchCaptureResultV1, { kind: "unsealed" }>;
  }
  return Object.freeze({ kind: "replayed", manifest, result });
}
