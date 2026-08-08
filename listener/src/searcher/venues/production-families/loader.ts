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
import { AdapterFamilyRegistry } from "../adapter-family-registry.js";
import {
  assertDefinedFamilyPlugin,
  definedFamilyPluginContractSummary,
  type AnyDefinedStrictFamilyPlugin,
  type FamilyOwnedActionAdapter as StrictFamilyOwnedActionAdapter,
} from "../adapter-family-plugin.js";
import type { FamilyId } from "../adapter-family-identifiers.js";
import type { AdapterFamily } from "../route-leg-adapter.js";
import type {
  ProductionFamilyActivation,
} from "./contract.js";
import {
  assertLegacyProductionFamilyModule,
} from "./contract.js";
import {
  PRODUCTION_ENTRY_PATTERN,
  productionFamilySourceDirectory,
} from "./tracked-sources.js";

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

export interface LoadedProductionFamilyModule extends ProductionFamilyActivation {
  readonly sourceFile: string;
}

export interface LoadedDefinedFamilyPluginModule {
  readonly contractKind: "defined-family-plugin";
  readonly familyId: FamilyId;
  readonly definitionBoundaryHash: string;
  readonly plugin: AnyDefinedStrictFamilyPlugin;
  readonly actionAdapters: readonly StrictFamilyOwnedActionAdapter[];
  readonly sourceFile: string;
}

export interface ProductionFamilyLoadResult {
  readonly modules: readonly LoadedProductionFamilyModule[];
  /** Terminal plugins are scanned and validated but not silently legacy-adapted. */
  readonly plugins: readonly LoadedDefinedFamilyPluginModule[];
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
  readonly contractMode?: "mixed-migration" | "strict-only";
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
export async function loadProductionFamilyModules(
  baseFamilies: readonly AdapterFamily[],
  options: ProductionFamilyLoaderOptions = {},
): Promise<ProductionFamilyLoadResult> {
  const rootDirectory = listenerRoot();
  const sourceDirectory = options.sourceDirectory ??
    productionFamilySourceDirectory(rootDirectory);
  const importTimeoutMs = options.importTimeoutMs ?? 10_000;
  const contractMode = options.contractMode ?? "mixed-migration";
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
    return freezeResult([], [], [issue]);
  }

  const accepted: LoadedProductionFamilyModule[] = [];
  const acceptedPlugins: LoadedDefinedFamilyPluginModule[] = [];
  const issues: ProductionFamilyLoadIssue[] = [];
  const acceptedActionIds = new Set<string>();
  const reservedBaseActionIds = new Set(
    [
      ...baseFamilies.flatMap((family) => [
      ...family.ownedActionAdapterIds,
      ...family.requiredInfraActionAdapterIds,
      ]),
      ...(options.sharedInfraActionAdapterIds ?? []),
    ],
  );
  const sharedInfraIds = new Set(
    [
      ...baseFamilies.flatMap((family) => family.requiredInfraActionAdapterIds),
      ...(options.sharedInfraActionAdapterIds ?? []),
    ],
  );
  const activeFamilyIds = new Set<string>(
    baseFamilies.map((family) => family.id),
  );

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
        contractMode,
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
      reservedBaseActionIds.has(adapter.id) ||
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

    if (candidate.contractKind === "legacy-production-module") {
      try {
        // Constructing the full prefix checks family id, action ownership,
        // pool/edge claims, identity declarations and every typed capability.
        new AdapterFamilyRegistry([
          ...baseFamilies,
          ...accepted.map((module) => module.family),
          candidate.activation.family,
        ]);
      } catch (error) {
        issues.push(freezeIssue(
          sourceFile,
          "family_registration_conflict",
          errorMessage(error),
        ));
        continue;
      }
    }

    for (const adapter of candidate.actionAdapters) {
      acceptedActionIds.add(adapter.id);
    }
    activeFamilyIds.add(candidate.familyId);
    if (candidate.contractKind === "legacy-production-module") {
      accepted.push(Object.freeze({
        ...candidate.activation,
        sourceFile,
      }));
    } else {
      acceptedPlugins.push(Object.freeze({
        contractKind: candidate.contractKind,
        familyId: candidate.familyId,
        definitionBoundaryHash: candidate.definitionBoundaryHash,
        plugin: candidate.plugin,
        actionAdapters: candidate.actionAdapters,
        sourceFile,
      }));
    }
  }

  return freezeResult(accepted, acceptedPlugins, issues);
}

/**
 * Terminal loader entry: strict constructor modules only, with no legacy base
 * Family input. The mixed loader remains solely for migration fixtures until
 * the §18.3 cleanup slice deletes it.
 */
export async function loadStrictProductionFamilyPlugins(
  options: Omit<ProductionFamilyLoaderOptions, "contractMode">,
): Promise<ProductionFamilyLoadResult> {
  const result = await loadProductionFamilyModules([], {
    ...options,
    contractMode: "strict-only",
  });
  if (result.modules.length !== 0) {
    throw new Error("strict production loader admitted a legacy module");
  }
  return result;
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
  contractMode: "mixed-migration" | "strict-only",
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
  };
  const hasLegacy = "productionFamilyModule" in namespace;
  const hasPlugin = "plugin" in namespace;
  if (hasLegacy === hasPlugin) {
    throw new Error(
      "module must export exactly one of productionFamilyModule or plugin",
    );
  }

  if (hasPlugin) {
    const plugin = namespace.plugin;
    assertDefinedFamilyPlugin(plugin);
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
      plugin,
      actionAdapters: Object.freeze([...plugin.actionAdapters]),
    });
  }

  const module = namespace.productionFamilyModule;
  if (contractMode === "strict-only") {
    throw new Error(
      "productionFamilyModule is a migration-only contract; export a strict plugin",
    );
  }
  assertLegacyProductionFamilyModule(module);
  assertKnownSharedInfra(
    module.family.id,
    module.family.requiredInfraActionAdapterIds,
    sharedInfraIds,
  );
  const activation = Object.freeze({
    contractKind: module.contractKind,
    activationContractHash: module.activationContractHash,
    family: module.family,
    actionAdapters: Object.freeze([...module.actionAdapters]),
  });
  return Object.freeze({
    contractKind: "legacy-production-module" as const,
    familyId: module.family.id,
    activation,
    actionAdapters: activation.actionAdapters,
  });
}

type ValidatedProductionContract =
  | {
      readonly contractKind: "legacy-production-module";
      readonly familyId: string;
      readonly activation: ProductionFamilyActivation;
      readonly actionAdapters: ProductionFamilyActivation["actionAdapters"];
    }
  | {
      readonly contractKind: "defined-family-plugin";
      readonly familyId: FamilyId;
      readonly definitionBoundaryHash: string;
      readonly plugin: AnyDefinedStrictFamilyPlugin;
      readonly actionAdapters: readonly StrictFamilyOwnedActionAdapter[];
    };

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
  modules: readonly LoadedProductionFamilyModule[],
  plugins: readonly LoadedDefinedFamilyPluginModule[],
  issues: readonly ProductionFamilyLoadIssue[],
): ProductionFamilyLoadResult {
  const frozenModules = Object.freeze([...modules]);
  const frozenPlugins = Object.freeze([...plugins]);
  const frozenIssues = Object.freeze([...issues]);
  const scanSha256 = createHash("sha256")
    .update(JSON.stringify({
      modules: frozenModules.map((module) => ({
        sourceFile: module.sourceFile,
        familyId: module.family.id,
        contractKind: module.contractKind,
        activationContractHash: module.activationContractHash,
        actionAdapterIds: module.actionAdapters.map((adapter) => adapter.id),
      })),
      plugins: frozenPlugins.map((module) => ({
        sourceFile: module.sourceFile,
        familyId: module.familyId,
        contractKind: module.contractKind,
        definitionBoundaryHash: module.definitionBoundaryHash,
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
    issues: frozenIssues,
    scanSha256,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
