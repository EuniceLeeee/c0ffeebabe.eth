import { createHash } from "node:crypto";
import {
  readdir,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  resolve,
} from "node:path";
import {
  fileURLToPath,
  pathToFileURL,
} from "node:url";
import {
  GENERATED_PRODUCTION_FAMILY_ENTRIES,
} from "../../generated/production-family-entries.generated.js";
import {
  definedFamilyPluginContractSummary,
  type AnyDefinedStrictFamilyPlugin,
  type FamilyOwnedActionAdapter as StrictFamilyOwnedActionAdapter,
} from "../adapter-family-plugin.js";
import type { FamilyId } from "../adapter-family-identifiers.js";
import {
  PRODUCTION_ENTRY_PATTERN,
  productionFamilySourceDirectory,
} from "./tracked-sources.js";
import type { FamilyActivation } from "./activation.js";
import { assertSelectorFamilyModule } from "../selector-family-module.js";

export type ProductionFamilyLoadIssueCode =
  | "source_scan_failed"
  | "module_import_failed"
  | "module_import_timeout"
  | "invalid_module_contract"
  | "family_registration_conflict";

export interface ProductionFamilyLoadIssue {
  readonly sourceFile: string;
  readonly code: ProductionFamilyLoadIssueCode;
  readonly message: string;
}

export interface LoadedDefinedFamilyPluginModule {
  readonly contractKind: "defined-family-plugin";
  readonly familyId: FamilyId;
  readonly definitionBoundaryHash: string;
  readonly semanticDefinitionHash: string;
  readonly plugin: AnyDefinedStrictFamilyPlugin;
  readonly actionAdapters: readonly StrictFamilyOwnedActionAdapter[];
  readonly sourceFile: string;
  readonly activation: FamilyActivation;
}

export interface ProductionFamilyLoadResult {
  /** Empty sentinel retained for result consumers; no module loading contract exists. */
  readonly modules: readonly never[];
  /** Strict constructor plugins are scanned and fully validated. */
  readonly plugins: readonly LoadedDefinedFamilyPluginModule[];
  /** Fully validated definitions omitted only from runtime activation. */
  readonly disabledPlugins: readonly LoadedDefinedFamilyPluginModule[];
  readonly issues: readonly ProductionFamilyLoadIssue[];
  readonly scanSha256: string;
}

export function assertCompleteProductionFamilyLoad(
  result: ProductionFamilyLoadResult,
): void {
  if (result.issues.length === 0) return;
  const failures = result.issues
    .map((issue) => `${issue.sourceFile}:${issue.code}:${issue.message}`)
    .join("; ");
  throw new Error(`production family activation is incomplete: ${failures}`);
}

export interface ProductionFamilyLoaderOptions {
  readonly sourceDirectory?: string;
  readonly importTimeoutMs?: number;
  readonly sharedInfraActionAdapterIds?: readonly string[];
  readonly importEntry?: (
    sourceFile: string,
    runtimeUrl: URL,
  ) => Promise<unknown>;
}

/**
 * The default production composition root is a build-time generated static
 * import list. Development fixtures may still supply a source directory, but
 * production runtime never discovers authority from a checkout or `.git`.
 */
export async function loadStrictProductionFamilyPlugins(
  options: ProductionFamilyLoaderOptions = {},
): Promise<ProductionFamilyLoadResult> {
  const rootDirectory = listenerRoot();
  const sourceDirectory = options.sourceDirectory ??
    productionFamilySourceDirectory(rootDirectory);
  const importTimeoutMs = options.importTimeoutMs ?? 10_000;
  if (!Number.isInteger(importTimeoutMs) || importTimeoutMs <= 0) {
    throw new Error("production family importTimeoutMs must be a positive integer");
  }
  let sourceFiles: readonly string[];
  const generatedModules = options.sourceDirectory === undefined
    ? new Map<string, unknown>(
      GENERATED_PRODUCTION_FAMILY_ENTRIES.map((entry) => [
        entry.sourceFile,
        entry.module,
      ]),
    )
    : null;
  try {
    sourceFiles = options.sourceDirectory === undefined
      ? GENERATED_PRODUCTION_FAMILY_ENTRIES.map((entry) => entry.sourceFile)
      : (await readdir(sourceDirectory, { withFileTypes: true }))
        .filter((entry) =>
          entry.isFile() && PRODUCTION_ENTRY_PATTERN.test(entry.name)
        )
        .map((entry) => entry.name)
        .sort();
  } catch (error) {
    const issue = freezeIssue(
      "production-families",
      "source_scan_failed",
      errorMessage(error),
    );
    return freezeResult([], [issue]);
  }

  const acceptedPlugins: LoadedDefinedFamilyPluginModule[] = [];
  const disabledPlugins: LoadedDefinedFamilyPluginModule[] = [];
  const issues: ProductionFamilyLoadIssue[] = [];
  const acceptedActionIds = new Set<string>();
  const sharedInfraIds = new Set(options.sharedInfraActionAdapterIds ?? []);
  const activeFamilyIds = new Set<string>();

  for (const sourceFile of sourceFiles) {
    const sourcePath = resolve(sourceDirectory, sourceFile);
    let imported: unknown;
    try {
      const generatedModule = generatedModules?.get(sourceFile);
      const runtimeUrl = runtimeModuleUrl(sourcePath);
      const pendingImport = generatedModule !== undefined
        ? Promise.resolve(generatedModule)
        : options.importEntry
          ? options.importEntry(sourceFile, runtimeUrl)
          : import(runtimeUrl.href);
      imported = await withTimeout(
        Promise.resolve(pendingImport),
        importTimeoutMs,
        sourceFile,
      );
    } catch (error) {
      const timeout = error instanceof ProductionFamilyImportTimeoutError;
      issues.push(freezeIssue(
        sourceFile,
        timeout ? "module_import_timeout" : "module_import_failed",
        errorMessage(error),
      ));
      continue;
    }

    let candidate: ValidatedProductionContract;
    try {
      candidate = validateModuleContract(
        imported,
        sharedInfraIds,
      );
    } catch (error) {
      issues.push(freezeIssue(
        sourceFile,
        "invalid_module_contract",
        errorMessage(error),
      ));
      continue;
    }

    const duplicateAction = candidate.actionAdapters.find((adapter) =>
      sharedInfraIds.has(adapter.id) ||
      acceptedActionIds.has(adapter.id)
    );
    if (duplicateAction) {
      issues.push(freezeIssue(
        sourceFile,
        "family_registration_conflict",
        `ActionAdapter ${duplicateAction.id} is already active in production`,
      ));
      continue;
    }

    if (activeFamilyIds.has(candidate.familyId)) {
      issues.push(freezeIssue(
        sourceFile,
        "family_registration_conflict",
        `Adapter Family ${candidate.familyId} is already active in production`,
      ));
      continue;
    }

    for (const adapter of candidate.actionAdapters) {
      acceptedActionIds.add(adapter.id);
    }
    activeFamilyIds.add(candidate.familyId);
    const target = candidate.runtimeActivation.enabled ? acceptedPlugins : disabledPlugins;
    target.push(Object.freeze({
      contractKind: candidate.contractKind,
      familyId: candidate.familyId,
      definitionBoundaryHash: candidate.definitionBoundaryHash,
      semanticDefinitionHash: candidate.semanticDefinitionHash,
      plugin: candidate.plugin,
      actionAdapters: candidate.actionAdapters,
      sourceFile,
      activation: candidate.runtimeActivation,
    }));
  }

  return freezeResult(acceptedPlugins, issues, disabledPlugins);
}

class ProductionFamilyImportTimeoutError extends Error {}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  sourceFile: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ProductionFamilyImportTimeoutError(
            `production family import timed out after ${timeoutMs}ms: ${sourceFile}`,
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validateModuleContract(
  imported: unknown,
  sharedInfraIds: ReadonlySet<string>,
): ValidatedProductionContract {
  if (
    imported === null ||
    typeof imported !== "object"
  ) {
    throw new Error("production entry module must be an object");
  }
  const namespace = imported as {
    readonly productionFamilyModule?: unknown;
    readonly plugin?: unknown;
    readonly activation?: unknown;
    readonly selectorFamilyModule?: unknown;
  };
  if ("productionFamilyModule" in namespace || "plugin" in namespace || "activation" in namespace) {
    throw new Error(
      "legacy productionFamilyModule/plugin exports are no longer supported; export a v2 selectorFamilyModule",
    );
  }
  if (!("selectorFamilyModule" in namespace)) {
    throw new Error("module must export a v2 selectorFamilyModule");
  }
  const module = namespace.selectorFamilyModule;
  assertSelectorFamilyModule(module);
  const plugin = module.plugin;
  const summary = definedFamilyPluginContractSummary(plugin);
  assertKnownSharedInfra(
    summary.familyId,
    summary.requiredInfraActionAdapterIds,
    sharedInfraIds,
  );
  return Object.freeze({
    contractKind: "defined-family-plugin" as const,
    familyId: summary.familyId,
    definitionBoundaryHash: summary.definitionBoundaryHash,
    semanticDefinitionHash: module.semanticDefinitionHash,
    plugin,
    runtimeActivation: module.activation,
    actionAdapters: Object.freeze([...plugin.actionAdapters]),
  });
}

interface ValidatedProductionContract {
  readonly contractKind: "defined-family-plugin";
  readonly familyId: FamilyId;
  readonly definitionBoundaryHash: string;
  readonly semanticDefinitionHash: string;
  readonly plugin: AnyDefinedStrictFamilyPlugin;
  readonly runtimeActivation: FamilyActivation;
  readonly actionAdapters: readonly StrictFamilyOwnedActionAdapter[];
}

function assertKnownSharedInfra(
  familyId: string,
  requiredInfraActionAdapterIds: readonly string[],
  sharedInfraIds: ReadonlySet<string>,
): void {
  for (const infraId of requiredInfraActionAdapterIds) {
    if (!sharedInfraIds.has(infraId)) {
      throw new Error(
        `${familyId} requires unknown shared infra ${infraId}; ` +
          "add protocol-neutral infra on the framework branch first",
      );
    }
  }
}

function listenerRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

function runtimeModuleUrl(sourcePath: string): URL {
  const loaderPath = fileURLToPath(import.meta.url);
  if (extname(loaderPath) === ".ts") {
    return pathToFileURL(sourcePath);
  }
  const runtimeFile = basename(sourcePath, ".ts") + ".js";
  return pathToFileURL(resolve(dirname(loaderPath), runtimeFile));
}

function freezeIssue(
  sourceFile: string,
  code: ProductionFamilyLoadIssueCode,
  message: string,
): ProductionFamilyLoadIssue {
  return Object.freeze({ sourceFile, code, message });
}

function freezeResult(
  plugins: readonly LoadedDefinedFamilyPluginModule[],
  issues: readonly ProductionFamilyLoadIssue[],
  disabledPlugins: readonly LoadedDefinedFamilyPluginModule[] = [],
): ProductionFamilyLoadResult {
  const frozenModules: readonly never[] = Object.freeze([]);
  const frozenPlugins = Object.freeze([...plugins]);
  const frozenDisabledPlugins = Object.freeze([...disabledPlugins]);
  const frozenIssues = Object.freeze([...issues]);
  const scanSha256 = createHash("sha256")
    .update(JSON.stringify({
      modules: frozenModules,
      plugins: frozenPlugins.map((module) => ({
        sourceFile: module.sourceFile,
        familyId: module.familyId,
        contractKind: module.contractKind,
        definitionBoundaryHash: module.definitionBoundaryHash,
        semanticDefinitionHash: module.semanticDefinitionHash,
        actionAdapterIds: module.actionAdapters.map((adapter) => adapter.id),
      })),
      disabledPlugins: frozenDisabledPlugins.map((module) => ({
        sourceFile: module.sourceFile,
        familyId: module.familyId,
        definitionBoundaryHash: module.definitionBoundaryHash,
        semanticDefinitionHash: module.semanticDefinitionHash,
        activation: module.activation,
        actionAdapterIds: module.actionAdapters.map((adapter) => adapter.id),
      })),
      issues: frozenIssues.map((issue) => ({
        sourceFile: issue.sourceFile,
        code: issue.code,
      })),
    }))
    .digest("hex");
  return Object.freeze({
    modules: frozenModules,
    plugins: frozenPlugins,
    disabledPlugins: frozenDisabledPlugins,
    issues: frozenIssues,
    scanSha256,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
