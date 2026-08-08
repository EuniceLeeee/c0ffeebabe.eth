import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import {
  access,
  readFile,
} from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import ts from "typescript";
import type { FamilyId } from "./adapter-family-identifiers.js";
import { hashCanonical } from "./canonical-value.js";
import type {
  FamilyCapabilityName,
  GeneratedCapabilityIdentity,
} from "./family-capability-catalog.js";

/**
 * Framework-owned contract versions. Family source cannot supply or override
 * these values. A framework contract change is therefore an explicit central
 * decision, not another per-Family manual revision.
 */
export const FAMILY_CAPABILITY_CONTRACT_VERSIONS: Readonly<
  Record<FamilyCapabilityName, string>
> = Object.freeze({
  discovery: "s1-discovery-v1",
  identity: "s1-identity-v1",
  instance: "s1-instance-v1",
  routes: "s1-routes-v2",
  pricing: "s1-pricing-v1",
  exact: "s1-exact-v2",
  execution: "s1-execution-v2",
  victim: "s1-victim-v2",
  funding: "s1-funding-v1",
  credit: "s1-credit-v1",
});

export const ACTION_ADAPTER_CONTRACT_VERSION = "s1-action-adapter-v1";
const NODE_RUNTIME_CONTRACT_VERSION = "node-es2022-v1";

export interface SemanticDependencyArtifact {
  readonly logicalId: string;
  readonly contentHash: string;
}

export interface RuntimeSourceClosure {
  readonly entryLogicalId: string;
  readonly entryContentHash: string;
  readonly dependencyArtifacts: readonly SemanticDependencyArtifact[];
  readonly closureHash: string;
}

export interface GeneratedCapabilityClosure {
  readonly identity: GeneratedCapabilityIdentity;
  readonly entryLogicalId: string;
  readonly entryContentHash: string;
  readonly dependencyArtifacts: readonly SemanticDependencyArtifact[];
}

export interface CapabilityClosureInput {
  readonly familyId: FamilyId;
  readonly capability: FamilyCapabilityName;
  readonly rootDirectory: string;
  readonly entryFile: string;
  /** Build-derived roots only, for example manifest and owned actions. */
  readonly additionalEntryFiles?: readonly string[];
  readonly provenanceCommit: string | null;
}

/**
 * Generate a capability identity from emitted runtime JavaScript. Type-only
 * imports/declarations, comments, formatting and the provenance commit are
 * deliberately absent from contentHash.
 */
export async function generateCapabilityClosure(
  input: CapabilityClosureInput,
): Promise<GeneratedCapabilityClosure> {
  assertProvenanceCommit(input.provenanceCommit);
  const contractVersion = FAMILY_CAPABILITY_CONTRACT_VERSIONS[input.capability];
  const runtime = await generateRuntimeSourceClosure({
    rootDirectory: input.rootDirectory,
    entryFile: input.entryFile,
    additionalEntryFiles: input.additionalEntryFiles,
  });
  const dependencies = new Map(
    runtime.dependencyArtifacts.map((artifact) => [
      artifact.logicalId,
      artifact,
    ] as const),
  );
  const capabilityContract = fixedContractArtifact(
    `contract:adapter-family/${input.capability}`,
    contractVersion,
  );
  dependencies.set(capabilityContract.logicalId, capabilityContract);
  if (input.capability === "execution") {
    const actionContract = fixedContractArtifact(
      "contract:action-adapter",
      ACTION_ADAPTER_CONTRACT_VERSION,
    );
    dependencies.set(actionContract.logicalId, actionContract);
  }
  const dependencyArtifacts = Object.freeze(
    [...dependencies.values()].sort(compareArtifact),
  );
  const contentHash = hashCanonical({
    contractVersion,
    entry: runtime.entryContentHash,
    dependencies: dependencyArtifacts.map((artifact) => [
      artifact.logicalId,
      artifact.contentHash,
    ]),
  });
  const identity: GeneratedCapabilityIdentity = Object.freeze({
    familyId: input.familyId,
    capability: input.capability,
    contractVersion,
    contentHash,
    semanticDependencies: Object.freeze(
      dependencyArtifacts.map((artifact) => artifact.logicalId),
    ),
    provenanceCommit: input.provenanceCommit,
  });
  return Object.freeze({
    identity,
    entryLogicalId: runtime.entryLogicalId,
    entryContentHash: runtime.entryContentHash,
    dependencyArtifacts,
  });
}

/** A declared absent Domain capability still binds the central contract. */
export function generateAbsentCapabilityIdentity(input: {
  readonly familyId: FamilyId;
  readonly capability: FamilyCapabilityName;
  readonly provenanceCommit: string | null;
}): GeneratedCapabilityIdentity {
  assertProvenanceCommit(input.provenanceCommit);
  const contractVersion = FAMILY_CAPABILITY_CONTRACT_VERSIONS[input.capability];
  const contract = fixedContractArtifact(
    `contract:adapter-family/${input.capability}`,
    contractVersion,
  );
  return Object.freeze({
    familyId: input.familyId,
    capability: input.capability,
    contractVersion,
    contentHash: hashCanonical({
      contractVersion,
      entry: "declared-absent",
      dependencies: [[contract.logicalId, contract.contentHash]],
    }),
    semanticDependencies: Object.freeze([contract.logicalId]),
    provenanceCommit: input.provenanceCommit,
  });
}

/**
 * Build a normalized runtime source closure without assigning a capability.
 * This is used by the separate legacy whole-Family observation path.
 */
export async function generateRuntimeSourceClosure(input: {
  readonly rootDirectory: string;
  readonly entryFile: string;
  readonly additionalEntryFiles?: readonly string[];
}): Promise<RuntimeSourceClosure> {
  const rootDirectory = resolve(input.rootDirectory);
  const entryFile = resolve(input.entryFile);
  assertInsideRoot(rootDirectory, entryFile);
  const compilerOptions = await readCompilerOptions(rootDirectory);
  const packageLock = await readPackageLock(rootDirectory);
  const sourceArtifacts = new Map<string, SemanticDependencyArtifact>();
  const externalArtifacts = new Map<string, SemanticDependencyArtifact>();
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = async (file: string): Promise<void> => {
    const canonicalFile = resolve(file);
    assertInsideRoot(rootDirectory, canonicalFile);
    if (visited.has(canonicalFile) || visiting.has(canonicalFile)) return;
    rejectNonSemanticSource(canonicalFile);
    if (/\.d\.[cm]?ts$/.test(canonicalFile)) {
      throw new Error(
        `runtime capability closure resolved declaration-only source ${canonicalFile}`,
      );
    }
    visiting.add(canonicalFile);
    try {
      const source = await readFile(canonicalFile, "utf8");
      const logicalId = sourceLogicalId(rootDirectory, canonicalFile);
      const normalized = normalizeRuntimeSource(canonicalFile, source);
      sourceArtifacts.set(logicalId, Object.freeze({
        logicalId,
        contentHash: sha256(normalized),
      }));
      if (isTypeScriptSource(canonicalFile)) {
        const emitted = emitRuntimeJavaScript(canonicalFile, source);
        for (const specifier of importedRuntimeSpecifiers(
          canonicalFile,
          emitted,
        )) {
          const resolved = await resolveRuntimeImport({
            importingFile: canonicalFile,
            specifier,
            rootDirectory,
            compilerOptions,
          });
          if (resolved.kind === "local") {
            await visit(resolved.file);
          } else {
            const artifact = externalDependencyArtifact(
              resolved.specifier,
              packageLock,
            );
            externalArtifacts.set(artifact.logicalId, artifact);
          }
        }
      }
      visited.add(canonicalFile);
    } finally {
      visiting.delete(canonicalFile);
    }
  };

  await visit(entryFile);
  for (const additional of [...new Set(input.additionalEntryFiles ?? [])]
    .map((file) => resolve(file))
    .sort()) {
    assertInsideRoot(rootDirectory, additional);
    await visit(additional);
  }

  const entryLogicalId = sourceLogicalId(rootDirectory, entryFile);
  const entryArtifact = sourceArtifacts.get(entryLogicalId);
  if (entryArtifact === undefined) {
    throw new Error(`runtime entry was not collected: ${entryLogicalId}`);
  }
  const dependencies = new Map<string, SemanticDependencyArtifact>();
  for (const artifact of sourceArtifacts.values()) {
    if (artifact.logicalId !== entryLogicalId) {
      dependencies.set(artifact.logicalId, artifact);
    }
  }
  for (const artifact of externalArtifacts.values()) {
    dependencies.set(artifact.logicalId, artifact);
  }
  const dependencyArtifacts = Object.freeze(
    [...dependencies.values()].sort(compareArtifact),
  );
  return Object.freeze({
    entryLogicalId,
    entryContentHash: entryArtifact.contentHash,
    dependencyArtifacts,
    closureHash: hashCanonical({
      entry: entryArtifact.contentHash,
      dependencies: dependencyArtifacts.map((artifact) => [
        artifact.logicalId,
        artifact.contentHash,
      ]),
    }),
  });
}

function emitRuntimeJavaScript(file: string, source: string): string {
  const result = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      removeComments: true,
      sourceMap: false,
      declaration: false,
      verbatimModuleSyntax: false,
      newLine: ts.NewLineKind.LineFeed,
    },
  });
  const error = result.diagnostics?.find(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (error !== undefined) {
    throw new Error(
      `cannot emit runtime source ${file}: ` +
        ts.flattenDiagnosticMessageText(error.messageText, "\n"),
    );
  }
  return result.outputText;
}

function normalizeRuntimeSource(file: string, source: string): string {
  if (isTypeScriptSource(file)) {
    return canonicalJavaScriptTokens(emitRuntimeJavaScript(file, source));
  }
  if (extname(file).toLowerCase() === ".json") {
    return JSON.stringify(sortJson(JSON.parse(source)));
  }
  return source.replace(/\r\n?/g, "\n");
}

/** Token canonicalization removes printer trivia while preserving JS syntax. */
function canonicalJavaScriptTokens(source: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.ES2022,
    true,
    ts.LanguageVariant.Standard,
    source,
  );
  const tokens: [number, string][] = [];
  for (;;) {
    const token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) break;
    let value = "";
    if (
      token === ts.SyntaxKind.Identifier ||
      token === ts.SyntaxKind.PrivateIdentifier ||
      token === ts.SyntaxKind.StringLiteral ||
      token === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      token === ts.SyntaxKind.TemplateHead ||
      token === ts.SyntaxKind.TemplateMiddle ||
      token === ts.SyntaxKind.TemplateTail
    ) {
      value = scanner.getTokenValue();
    } else if (token === ts.SyntaxKind.NumericLiteral) {
      value = String(Number(scanner.getTokenText().replaceAll("_", "")));
    } else if (token === ts.SyntaxKind.BigIntLiteral) {
      value = `${BigInt(scanner.getTokenText().replaceAll("_", "").slice(0, -1))}n`;
    } else if (token === ts.SyntaxKind.RegularExpressionLiteral) {
      value = scanner.getTokenText();
    }
    tokens.push([token, value]);
  }
  return JSON.stringify(tokens);
}

function importedRuntimeSpecifiers(
  file: string,
  emittedJavaScript: string,
): readonly string[] {
  const sourceFile = ts.createSourceFile(
    file,
    emittedJavaScript,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  const specifiers = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      specifiers.add(node.arguments[0].text);
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  return Object.freeze([...specifiers].sort());
}

async function resolveRuntimeImport(input: {
  readonly importingFile: string;
  readonly specifier: string;
  readonly rootDirectory: string;
  readonly compilerOptions: ts.CompilerOptions;
}): Promise<
  | { readonly kind: "local"; readonly file: string }
  | { readonly kind: "external"; readonly specifier: string }
> {
  if (isNodeBuiltin(input.specifier)) {
    return { kind: "external", specifier: input.specifier };
  }
  const resolution = ts.resolveModuleName(
    input.specifier,
    input.importingFile,
    input.compilerOptions,
    ts.sys,
  ).resolvedModule;
  if (resolution !== undefined) {
    const file = resolve(resolution.resolvedFileName);
    if (
      !resolution.isExternalLibraryImport &&
      !file.split(sep).includes("node_modules") &&
      isInsideRoot(input.rootDirectory, file)
    ) {
      return { kind: "local", file };
    }
  }
  if (input.specifier.startsWith(".") || isAbsolute(input.specifier)) {
    return {
      kind: "local",
      file: await resolveLocalImport(input.importingFile, input.specifier),
    };
  }
  return { kind: "external", specifier: input.specifier };
}

async function resolveLocalImport(
  importingFile: string,
  specifier: string,
): Promise<string> {
  const unresolved = isAbsolute(specifier)
    ? resolve(specifier)
    : resolve(dirname(importingFile), specifier);
  const extension = extname(unresolved);
  const candidates = new Set<string>([unresolved]);
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    const base = unresolved.slice(0, -extension.length);
    candidates.add(`${base}.ts`);
    candidates.add(`${base}.tsx`);
    candidates.add(`${base}.mts`);
    candidates.add(`${base}.cts`);
  } else if (extension.length === 0) {
    candidates.add(`${unresolved}.ts`);
    candidates.add(`${unresolved}.tsx`);
    candidates.add(`${unresolved}.mts`);
    candidates.add(`${unresolved}.cts`);
    candidates.add(`${unresolved}.json`);
    candidates.add(resolve(unresolved, "index.ts"));
    candidates.add(resolve(unresolved, "index.tsx"));
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next deterministic candidate.
    }
  }
  throw new Error(
    `cannot resolve runtime import ${specifier} from ${importingFile}`,
  );
}

interface PackageLock {
  readonly packages?: Readonly<Record<string, {
    readonly version?: string;
    readonly integrity?: string;
  }>>;
}

async function readCompilerOptions(
  rootDirectory: string,
): Promise<ts.CompilerOptions> {
  const configPath = ts.findConfigFile(rootDirectory, ts.sys.fileExists);
  if (configPath === undefined) {
    return {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.Node16,
      moduleResolution: ts.ModuleResolutionKind.Node16,
      resolveJsonModule: true,
    };
  }
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, "\n"),
    );
  }
  return parsed.options;
}

async function readPackageLock(rootDirectory: string): Promise<PackageLock> {
  let cursor = rootDirectory;
  for (;;) {
    const file = resolve(cursor, "package-lock.json");
    try {
      return JSON.parse(await readFile(file, "utf8")) as PackageLock;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return {};
    cursor = parent;
  }
}

function externalDependencyArtifact(
  specifier: string,
  lock: PackageLock,
): SemanticDependencyArtifact {
  if (isNodeBuiltin(specifier)) {
    const normalized = specifier.startsWith("node:")
      ? specifier
      : `node:${specifier}`;
    return fixedContractArtifact(
      `runtime:${normalized}`,
      NODE_RUNTIME_CONTRACT_VERSION,
    );
  }
  const packageName = barePackageName(specifier);
  const locked = lock.packages?.[`node_modules/${packageName}`];
  if (locked?.version === undefined) {
    throw new Error(
      `runtime dependency ${packageName} is absent from package-lock.json`,
    );
  }
  const logicalId = `package:${packageName}@${locked.version}`;
  return Object.freeze({
    logicalId,
    contentHash: sha256(JSON.stringify({
      packageName,
      version: locked.version,
      integrity: locked.integrity ?? null,
    })),
  });
}

function fixedContractArtifact(
  logicalId: string,
  version: string,
): SemanticDependencyArtifact {
  return Object.freeze({
    logicalId: `${logicalId}@${version}`,
    contentHash: sha256(`${logicalId}\0${version}`),
  });
}

function barePackageName(specifier: string): string {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (parts.length < 2) throw new Error(`invalid package import ${specifier}`);
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function isNodeBuiltin(specifier: string): boolean {
  const normalized = specifier.startsWith("node:")
    ? specifier.slice("node:".length)
    : specifier;
  return builtinModules.includes(normalized) ||
    builtinModules.includes(`node:${normalized}`);
}

function sourceLogicalId(rootDirectory: string, file: string): string {
  return relative(rootDirectory, file).split(sep).join("/");
}

function assertInsideRoot(rootDirectory: string, file: string): void {
  if (!isInsideRoot(rootDirectory, file)) {
    throw new Error(`semantic source escapes root ${rootDirectory}: ${file}`);
  }
}

function isInsideRoot(rootDirectory: string, file: string): boolean {
  const path = relative(resolve(rootDirectory), resolve(file));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function rejectNonSemanticSource(file: string): void {
  const normalized = file.split(sep).join("/");
  if (
    /\/(?:test|tests|__tests__)\//.test(normalized) ||
    /(?:^|\.)test\.[cm]?[jt]sx?$/.test(normalized) ||
    /\/(?:dist|build|out|coverage|node_modules)\//.test(normalized)
  ) {
    throw new Error(`capability closure imports non-semantic source ${file}`);
  }
}

function isTypeScriptSource(file: string): boolean {
  return /\.[cm]?tsx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

function compareArtifact(
  left: SemanticDependencyArtifact,
  right: SemanticDependencyArtifact,
): number {
  return left.logicalId.localeCompare(right.logicalId);
}

function assertProvenanceCommit(value: string | null): void {
  if (value !== null && !/^[0-9a-f]{40,64}$/.test(value)) {
    throw new Error("capability provenanceCommit must be a git object id");
  }
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === "object" &&
    "code" in error && (error as { readonly code?: string }).code === "ENOENT";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
