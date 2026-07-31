import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
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
import { promisify } from "node:util";
import type { ActionAdapter } from "../../../types.js";
import { AdapterFamilyRegistry } from "../adapter-family-registry.js";
import type { AdapterFamily } from "../route-leg-adapter.js";
import type {
  ProductionFamilyModule,
} from "./contract.js";

const PRODUCTION_ENTRY_PATTERN = /^[a-z0-9][a-z0-9-]*\.production\.ts$/;
const execFileAsync = promisify(execFile);

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

export interface LoadedProductionFamilyModule extends ProductionFamilyModule {
  readonly sourceFile: string;
}

export interface ProductionFamilyLoadResult {
  readonly modules: readonly LoadedProductionFamilyModule[];
  readonly issues: readonly ProductionFamilyLoadIssue[];
  readonly scanSha256: string;
}

interface ProductionFamilyLoaderOptions {
  readonly sourceDirectory?: string;
  readonly importTimeoutMs?: number;
  readonly importEntry?: (
    sourceFile: string,
    runtimeUrl: URL,
  ) => Promise<unknown>;
}

/**
 * Source filenames, not emitted dist contents, define production activation.
 * This prevents a stale compiled file from resurrecting a removed family.
 */
export async function loadProductionFamilyModules(
  baseFamilies: readonly AdapterFamily[],
  options: ProductionFamilyLoaderOptions = {},
): Promise<ProductionFamilyLoadResult> {
  const sourceDirectory = options.sourceDirectory ??
    resolve(listenerRoot(), "src/searcher/venues/production-families");
  const importTimeoutMs = options.importTimeoutMs ?? 10_000;
  if (!Number.isInteger(importTimeoutMs) || importTimeoutMs <= 0) {
    throw new Error("production family importTimeoutMs must be a positive integer");
  }
  let sourceFiles: readonly string[];
  try {
    sourceFiles = options.sourceDirectory === undefined
      ? await trackedProductionSourceFiles(sourceDirectory)
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

  const accepted: LoadedProductionFamilyModule[] = [];
  const issues: ProductionFamilyLoadIssue[] = [];
  const acceptedActionIds = new Set<string>();
  const reservedBaseActionIds = new Set(
    baseFamilies.flatMap((family) => [
      ...family.ownedActionAdapterIds,
      ...family.requiredInfraActionAdapterIds,
    ]),
  );
  const sharedInfraIds = new Set(
    baseFamilies.flatMap((family) => family.requiredInfraActionAdapterIds),
  );

  for (const sourceFile of sourceFiles) {
    const sourcePath = resolve(sourceDirectory, sourceFile);
    let imported: unknown;
    try {
      const runtimeUrl = runtimeModuleUrl(sourcePath);
      const pendingImport = options.importEntry
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

    let candidate: ProductionFamilyModule;
    try {
      candidate = validateModuleContract(imported, sharedInfraIds);
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

    try {
      // Constructing the full prefix checks family id, action ownership,
      // pool/edge claims, identity declarations and every typed capability.
      new AdapterFamilyRegistry([
        ...baseFamilies,
        ...accepted.map((module) => module.family),
        candidate.family,
      ]);
    } catch (error) {
      issues.push(freezeIssue(
        sourceFile,
        "family_registration_conflict",
        errorMessage(error),
      ));
      continue;
    }

    for (const adapter of candidate.actionAdapters) {
      acceptedActionIds.add(adapter.id);
    }
    accepted.push(Object.freeze({
      ...candidate,
      sourceFile,
    }));
  }

  return freezeResult(accepted, issues);
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

async function trackedProductionSourceFiles(
  sourceDirectory: string,
): Promise<readonly string[]> {
  const repoRoot = resolve(listenerRoot(), "..");
  const relativePattern =
    "listener/src/searcher/venues/production-families/*.production.ts";
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "-z", "--", relativePattern],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  const paths = stdout
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();
  const names: string[] = [];
  for (const path of paths) {
    const name = basename(path);
    if (!PRODUCTION_ENTRY_PATTERN.test(name)) {
      throw new Error(`tracked production entry has an invalid name: ${path}`);
    }
    const sourcePath = resolve(repoRoot, path);
    if (dirname(sourcePath) !== sourceDirectory) {
      throw new Error(`tracked production entry escaped its directory: ${path}`);
    }
    const stat = await lstat(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`tracked production entry must be a regular file: ${path}`);
    }
    names.push(name);
  }
  return Object.freeze(names);
}

function validateModuleContract(
  imported: unknown,
  sharedInfraIds: ReadonlySet<string>,
): ProductionFamilyModule {
  if (
    imported === null ||
    typeof imported !== "object" ||
    !("productionFamilyModule" in imported)
  ) {
    throw new Error("module must export productionFamilyModule");
  }
  const module = (imported as {
    readonly productionFamilyModule?: unknown;
  }).productionFamilyModule;
  if (module === null || typeof module !== "object") {
    throw new Error("productionFamilyModule must be an object");
  }
  const family = (module as { readonly family?: unknown }).family;
  const actionAdapters =
    (module as { readonly actionAdapters?: unknown }).actionAdapters;
  if (
    family === null ||
    typeof family !== "object" ||
    typeof (family as { readonly id?: unknown }).id !== "string"
  ) {
    throw new Error("production family must expose a string id");
  }
  if (!Array.isArray(actionAdapters)) {
    throw new Error("production family actionAdapters must be an array");
  }

  const typedFamily = family as AdapterFamily;
  const typedActions = actionAdapters as readonly ActionAdapter[];
  const owned = [...typedFamily.ownedActionAdapterIds].sort();
  const supplied = typedActions.map((adapter) => adapter.id).sort();
  if (
    owned.length !== supplied.length ||
    owned.some((id, index) => supplied[index] !== id)
  ) {
    throw new Error(
      `${typedFamily.id} must supply exactly its owned ActionAdapters ` +
        `(owned=${owned.join(",")} supplied=${supplied.join(",")})`,
    );
  }
  if (new Set(supplied).size !== supplied.length) {
    throw new Error(`${typedFamily.id} supplies duplicate ActionAdapters`);
  }
  for (const action of typedActions) {
    if (
      !action ||
      typeof action.id !== "string" ||
      typeof action.encode !== "function" ||
      typeof action.matchTrace !== "function"
    ) {
      throw new Error(`${typedFamily.id} supplies an invalid ActionAdapter`);
    }
    if (
      action.descriptor === undefined ||
      action.descriptor.adapterId !== action.id
    ) {
      throw new Error(
        `${typedFamily.id} ActionAdapter ${action.id} must own a matching descriptor`,
      );
    }
    const expectedEdgeKind = edgeKindForFamily(typedFamily);
    if (action.descriptor.edgeKind !== expectedEdgeKind) {
      throw new Error(
        `${typedFamily.id} ActionAdapter ${action.id} descriptor edgeKind ` +
          `${String(action.descriptor.edgeKind)} does not match family kind ` +
          `${typedFamily.kind} (${expectedEdgeKind})`,
      );
    }
  }
  for (const infraId of typedFamily.requiredInfraActionAdapterIds) {
    if (!sharedInfraIds.has(infraId)) {
      throw new Error(
        `${typedFamily.id} requires unknown shared infra ${infraId}; ` +
          "add protocol-neutral infra on the framework branch first",
      );
    }
  }
  return Object.freeze({
    family: typedFamily,
    actionAdapters: Object.freeze(
      typedActions as ProductionFamilyModule["actionAdapters"],
    ),
  });
}

function edgeKindForFamily(
  family: AdapterFamily,
): "swap" | "protocol" | "flash" | "credit" {
  switch (family.kind) {
    case "swap":
      return "swap";
    case "protocol-conversion":
      return "protocol";
    case "flash-loan":
      return "flash";
    case "credit":
      return "credit";
    case "liquidity":
      throw new Error(
        `${family.id} uses unsupported automatic family kind liquidity; ` +
          "runtime liquidity taxonomy requires a protocol-neutral framework upgrade",
      );
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
  issues: readonly ProductionFamilyLoadIssue[],
): ProductionFamilyLoadResult {
  const frozenModules = Object.freeze([...modules]);
  const frozenIssues = Object.freeze([...issues]);
  const scanSha256 = createHash("sha256")
    .update(JSON.stringify({
      modules: frozenModules.map((module) => ({
        sourceFile: module.sourceFile,
        familyId: module.family.id,
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
    issues: frozenIssues,
    scanSha256,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
