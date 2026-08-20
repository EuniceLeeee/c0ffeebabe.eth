import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

/**
 * This package is a source/build fact collector.  It never reads a runtime
 * object and it never emits a legacy=0 claim.  The caller may use its receipt
 * as an observation in the independent acceptance core, but the receipt is
 * not itself a production verdict.
 */

export type Language = "typescript" | "javascript" | "rust" | "solidity" | "metadata";
export type FileClass =
  | "acceptance-pure-core"
  | "acceptance-collector"
  | "central"
  | "production-runtime"
  | "family"
  | "strategy"
  | "authoring"
  | "generated"
  | "reference-only"
  | "metadata";
export type DiagnosticKind = "fail" | "invalid";

export interface BoundaryDiagnostic {
  readonly kind: DiagnosticKind;
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly offset: number | null;
  readonly caseId?: string;
}

export interface TrackedFile {
  readonly path: string;
  readonly mode: string;
  readonly blobSha: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly language: Language;
  readonly fileClass: FileClass;
}

export interface GraphNode {
  readonly path: string;
  readonly configPath: string;
  readonly root: boolean;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly specifier: string;
}

export interface CompilerSummary {
  readonly typescriptVersion: string;
  readonly compilerVersionRoot: string;
  readonly configPaths: readonly string[];
  readonly configRoots: string;
  readonly graphRoot: string;
  readonly packageManifestRoot: string;
  readonly externalDependencyRoot: string;
  readonly externalDependencies: readonly string[];
  readonly workspaceNames: readonly string[];
}

export interface BoundaryOptions {
  /** Absolute or relative repository root. Defaults to this package's repo. */
  readonly gitRoot?: string;
  /** Production default is true. Tests may explicitly collect a local fixture. */
  readonly requirePushed?: boolean;
}

export interface BoundaryReceipt {
  readonly schemaVersion: 1;
  readonly gate: "aloha.machine-enforced-boundary";
  readonly verdict: "pass" | "fail" | "invalid";
  readonly candidate: {
    readonly gitRoot: string;
    readonly branch: string | null;
    readonly headSha: string | null;
    readonly upstreamSha: string | null;
    readonly clean: boolean;
    readonly pushed: boolean;
  };
  readonly denominator: {
    readonly scannedFileSetRoot: string;
    readonly manifestRoot: string;
    readonly files: readonly TrackedFile[];
  };
  readonly compiler: CompilerSummary;
  readonly graph: {
    readonly nodes: readonly GraphNode[];
    readonly edges: readonly GraphEdge[];
  };
  readonly diagnostics: readonly BoundaryDiagnostic[];
  readonly mutationCorpus: {
    readonly root: string;
    readonly cases: readonly MutationResult[];
  };
  readonly claims: {
    readonly sourceBuildClosure: "observed";
    readonly runtimeLegacyZero: "not-asserted";
    readonly productionAuthority: "not-observed";
  };
}

export interface MutationExpectation {
  readonly caseId: string;
  readonly path: string;
  readonly offset: number;
  readonly code: string;
}

export interface MutationCase {
  readonly caseId: string;
  readonly path: string;
  readonly source: string;
  readonly expected: readonly MutationExpectation[];
  readonly scanOptions?: SourceScanOptions;
}

export interface MutationResult {
  readonly caseId: string;
  readonly expected: readonly MutationExpectation[];
  readonly actual: readonly MutationExpectation[];
  readonly pass: boolean;
}

const SOURCE_EXTENSIONS = new Map<string, Language>([
  [".ts", "typescript"], [".tsx", "typescript"], [".mts", "typescript"], [".cts", "typescript"],
  [".js", "javascript"], [".jsx", "javascript"], [".mjs", "javascript"], [".cjs", "javascript"],
  [".rs", "rust"], [".sol", "solidity"],
]);
const METADATA_NAMES = new Set([
  ".gitignore", ".gitattributes", ".npmrc", "LICENSE", "README", "README.md", "AGENTS.md", "CLAUDE.md",
]);
const METADATA_EXTENSIONS = new Set([".json", ".md", ".lock", ".toml", ".txt", ".yaml", ".yml"]);
const CONFIG_NAMES = new Set(["package.json", "tsconfig.json", "jsconfig.json", "foundry.toml", "remappings.txt"]);
const NODE_BUILTIN_PREFIXES = ["node:"];

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite hash input");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  throw new TypeError("unsupported hash input");
}

function hashDomain(domain: string, value: unknown): string {
  return `0x${createHash("sha256").update(domain).update("\0").update(canonical(value)).digest("hex")}`;
}

function posixPath(value: string): string {
  return value.split(sep).join("/");
}

function abs(root: string, path: string): string {
  return resolve(root, path);
}

function rel(root: string, path: string): string {
  return posixPath(relative(root, path));
}

function isInside(root: string, path: string): boolean {
  const r = relative(root, path);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function diagnostic(
  kind: DiagnosticKind,
  code: string,
  path: string,
  message: string,
  offset: number | null = null,
): BoundaryDiagnostic {
  return { kind, code, path: posixPath(path), message, offset };
}

function uniqueDiagnostics(items: readonly BoundaryDiagnostic[]): BoundaryDiagnostic[] {
  const seen = new Set<string>();
  const result: BoundaryDiagnostic[] = [];
  for (const item of items) {
    const key = `${item.kind}|${item.code}|${item.path}|${item.offset ?? ""}|${item.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result.sort((a, b) =>
    `${a.path}:${a.offset ?? -1}:${a.code}`.localeCompare(`${b.path}:${b.offset ?? -1}:${b.code}`));
}

function classify(path: string): { language: Language; fileClass: FileClass; sourceLike: boolean } {
  const normalized = posixPath(path);
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const extension = extname(base).toLowerCase();
  const language = SOURCE_EXTENSIONS.get(extension) ?? "metadata";
  const parts = normalized.split("/");
  const top = parts[0] ?? "";
  const generated = parts.includes("generated") || /(?:^|\.)(?:generated|gen)\.[^.]+$/.test(base);
  let fileClass: FileClass;
  if (generated) fileClass = "generated";
  else if (top === "acceptance") fileClass = parts[1] === "collectors" ? "acceptance-collector" : "acceptance-pure-core";
  else if (top === "families") fileClass = "family";
  else if (top === "apps") fileClass = "production-runtime";
  else if (top === "tools" && parts[1] === "reference-only") fileClass = "reference-only";
  else if (top === "tools") fileClass = "authoring";
  else if (top === "strategies") fileClass = "strategy";
  else if (top === "packages" || top === "specs") fileClass = "central";
  else if (top === "docs" || top === "analysis") fileClass = "metadata";
  else fileClass = "metadata";
  const sourceLike = SOURCE_EXTENSIONS.has(extension) || CONFIG_NAMES.has(base);
  return { language, fileClass, sourceLike };
}

function readTrackedFiles(root: string, diagnostics: BoundaryDiagnostic[]): TrackedFile[] {
  let output: string;
  let flagOutput: string;
  try {
    output = execFileSync("git", ["ls-files", "-s", "-z"], { cwd: root, encoding: "utf8" });
    flagOutput = execFileSync("git", ["ls-files", "-v", "-z"], { cwd: root, encoding: "utf8" });
  } catch (error) {
    diagnostics.push(diagnostic("invalid", "git-tree-unreadable", ".", String(error)));
    return [];
  }
  const indexFlags = new Map<string, string>();
  for (const record of flagOutput.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf(" ");
    if (separator !== 1) {
      diagnostics.push(diagnostic("invalid", "git-index-flag-record", ".", "Malformed git ls-files -v record"));
      continue;
    }
    indexFlags.set(posixPath(record.slice(2)), record[0]!);
  }
  const files: TrackedFile[] = [];
  for (const record of output.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) {
      diagnostics.push(diagnostic("invalid", "git-index-record", ".", "Malformed git ls-files record"));
      continue;
    }
    const [mode, blobSha, stage] = record.slice(0, tab).split(/\s+/);
    const path = posixPath(record.slice(tab + 1));
    if (stage !== "0") {
      diagnostics.push(diagnostic("invalid", "nonzero-index-stage", path, "Unmerged index entries cannot enter the source denominator"));
    }
    if (indexFlags.get(path) !== "H") {
      diagnostics.push(diagnostic("invalid", "noncanonical-index-flag", path, "assume-unchanged, skip-worktree, or another nonstandard index flag is forbidden"));
    }
    if (mode === "120000") {
      diagnostics.push(diagnostic("invalid", "symlink-in-denominator", path, "Symlinks are not a reproducible source denominator"));
    }
    const metadata = classify(path);
    const filePath = abs(root, path);
    let byteLength = 0;
    let contentSha256 = "";
    try {
      const stat = lstatSync(filePath);
      if (stat.isSymbolicLink()) {
        diagnostics.push(diagnostic("invalid", "symlink-in-denominator", path, "Working tree path is a symlink"));
      } else if (!stat.isFile()) {
        diagnostics.push(diagnostic("invalid", "tracked-path-not-file", path, "Tracked denominator entry is not a regular file"));
      } else {
        const bytes = readFileSync(filePath);
        byteLength = bytes.byteLength;
        contentSha256 = `0x${createHash("sha256").update(bytes).digest("hex")}`;
        const indexedBytes = execFileSync("git", ["cat-file", "blob", blobSha], {
          cwd: root,
          encoding: null,
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (!bytes.equals(indexedBytes)) {
          diagnostics.push(diagnostic("invalid", "worktree-index-content-mismatch", path, "Compiler-visible bytes differ from the exact indexed blob"));
        }
      }
    } catch (error) {
      diagnostics.push(diagnostic("invalid", "tracked-file-missing", path, String(error)));
    }
    const extension = extname(path).toLowerCase();
    const sourceDirectory = /^(acceptance|apps|families|packages|specs|strategies|tools)\//.test(path);
    if (sourceDirectory && !metadata.sourceLike && !METADATA_NAMES.has(path.slice(path.lastIndexOf("/") + 1)) && !METADATA_EXTENSIONS.has(extension)) {
      diagnostics.push(diagnostic("invalid", "unclassified-source-file", path, "File in a source root has no declared language/class"));
    }
    files.push({ path, mode, blobSha, contentSha256, byteLength, language: metadata.language, fileClass: metadata.fileClass });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function readJson(root: string, path: string, diagnostics: BoundaryDiagnostic[]): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(abs(root, path), "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("object expected");
    return value as Record<string, unknown>;
  } catch (error) {
    diagnostics.push(diagnostic("invalid", "invalid-json-manifest", path, String(error)));
    return null;
  }
}

function getStringTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(getStringTargets);
  if (value && typeof value === "object") return Object.values(value).flatMap(getStringTargets);
  return [];
}

function readPackageManifests(
  root: string,
  files: readonly TrackedFile[],
  diagnostics: BoundaryDiagnostic[],
): { manifests: Map<string, Record<string, unknown>>; workspaceNames: string[]; rootHash: string } {
  const manifests = new Map<string, Record<string, unknown>>();
  const packageFiles = files.filter((file) => file.path.endsWith("/package.json") || file.path === "package.json");
  for (const file of packageFiles) {
    const value = readJson(root, file.path, diagnostics);
    if (value) manifests.set(file.path, value);
  }
  const workspaceNames: string[] = [];
  const rootManifest = manifests.get("package.json");
  const workspacePatterns = Array.isArray(rootManifest?.workspaces)
    ? rootManifest.workspaces.filter((item): item is string => typeof item === "string")
    : typeof rootManifest?.workspaces === "object" && rootManifest.workspaces !== null && Array.isArray((rootManifest.workspaces as Record<string, unknown>).packages)
      ? ((rootManifest.workspaces as Record<string, unknown>).packages as unknown[]).filter((item): item is string => typeof item === "string")
      : [];
  const matches = (path: string, pattern: string): boolean => {
    const p = pattern.replace(/\*\*/g, "§§").replace(/\*/g, "[^/]+").replace(/§§/g, ".*");
    return new RegExp(`^${p}$`).test(path);
  };
  for (const [path, value] of manifests) {
    const packageDir = path === "package.json" ? "" : path.slice(0, -"/package.json".length);
    if (packageDir && workspacePatterns.length > 0 && !workspacePatterns.some((pattern) => matches(packageDir, pattern))) {
      diagnostics.push(diagnostic("fail", "workspace-package-outside-workspaces", path, "Package is not covered by the root workspaces declaration"));
    }
    if (typeof value.name === "string") workspaceNames.push(value.name);
    for (const field of ["exports", "imports"] as const) {
      for (const target of getStringTargets(value[field])) {
        if (!target.startsWith("./")) continue;
        const targetPath = posixPath(join(packageDir, target));
        const targetMatches = targetPath.endsWith("*")
          ? files.some((candidate) => candidate.path.startsWith(targetPath.slice(0, -1)))
          : files.some((candidate) => candidate.path === targetPath);
        if (!targetMatches) {
          diagnostics.push(diagnostic("fail", "package-target-not-tracked", path, `${field} target ${target} is not in the exact Git tree`));
        }
      }
    }
  }
  const rootHash = hashDomain("aloha/boundary/package-manifests/v1", packageFiles.map((file) => ({ path: file.path, sha: file.blobSha })));
  return { manifests, workspaceNames: workspaceNames.sort(), rootHash };
}

function readTsConfig(
  root: string,
  configPath: string,
  diagnostics: BoundaryDiagnostic[],
): { parsed: ts.ParsedCommandLine; program: ts.Program } | null {
  const absolute = abs(root, configPath);
  const loaded = ts.readConfigFile(absolute, ts.sys.readFile);
  if (loaded.error) {
    diagnostics.push(diagnostic("invalid", "tsconfig-read-error", configPath, ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n")));
    return null;
  }
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(absolute), undefined, absolute);
  for (const error of parsed.errors) {
    diagnostics.push(diagnostic("invalid", "tsconfig-parse-error", configPath, ts.flattenDiagnosticMessageText(error.messageText, "\n")));
  }
  if (parsed.options.moduleResolution !== ts.ModuleResolutionKind.NodeNext || parsed.options.module !== ts.ModuleKind.NodeNext) {
    diagnostics.push(diagnostic("fail", "non-nodenext-resolution", configPath, "The production TypeScript graph must use the pinned NodeNext resolver"));
  }
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  for (const error of ts.getPreEmitDiagnostics(program)) {
    const file = error.file ? rel(root, error.file.fileName) : configPath;
    diagnostics.push(diagnostic("fail", "typescript-build-diagnostic", file, ts.flattenDiagnosticMessageText(error.messageText, "\n"), error.start ?? null));
  }
  return { parsed, program };
}

function moduleSpecifierText(node: ts.Expression): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function unwrapped(expression: ts.Expression): ts.Expression {
  let value = expression;
  while (ts.isParenthesizedExpression(value)) value = value.expression;
  return value;
}

function isIdentifierNamed(expression: ts.Expression, names: ReadonlySet<string>): boolean {
  const value = unwrapped(expression);
  return ts.isIdentifier(value) && names.has(value.text);
}

function isImportCall(expression: ts.Expression): boolean {
  const value = unwrapped(expression);
  return value.kind === ts.SyntaxKind.ImportKeyword;
}

export interface SourceScanOptions {
  readonly pureAcceptanceCore?: boolean;
  /** Runtime/central/family source may not spawn child processes. */
  readonly forbidEnvironmentIo?: boolean;
}

export interface SourceScanResult {
  readonly diagnostics: BoundaryDiagnostic[];
  readonly imports: Array<{ specifier: string; offset: number; dynamic: boolean }>;
}

const PURE_ACCEPTANCE_FORBIDDEN_MODULES = new Set([
  "fs", "node:fs", "fs/promises", "node:fs/promises", "path", "node:path", "url", "node:url",
  "net", "node:net", "http", "node:http", "https", "node:https", "dns", "node:dns",
  "tls", "node:tls", "child_process", "node:child_process", "worker_threads", "node:worker_threads",
]);

/** AST-only loader scan. It is also used by independent mutation tests. */
export function inspectSourceText(path: string, source: string, options: SourceScanOptions = {}): SourceScanResult {
  const scriptKind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".jsx") ? ts.ScriptKind.JSX : undefined;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostics: BoundaryDiagnostic[] = [];
  const imports: Array<{ specifier: string; offset: number; dynamic: boolean }> = [];
  const requireNames = new Set(["require"]);
  const createRequireNames = new Set<string>(["createRequire"]);
  const workerNames = new Set(["Worker"]);
  const childProcessNames = new Set<string>();
  const report = (code: string, node: ts.Node, message: string, kind: DiagnosticKind = "fail") => {
    diagnostics.push(diagnostic(kind, code, path, message, node.getStart(file)));
  };
  const addBinding = (name: ts.BindingName, set: Set<string>) => {
    if (ts.isIdentifier(name)) set.add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) addBinding(element.name, set);
  };
  const isCreateRequireCall = (expression: ts.Expression): boolean => {
    const value = unwrapped(expression);
    return ts.isCallExpression(value) && isIdentifierNamed(value.expression, createRequireNames);
  };
  const isRequireAlias = (expression: ts.Expression): boolean => isIdentifierNamed(expression, requireNames);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = moduleSpecifierText(node.moduleSpecifier);
      if (specifier === null) report("nonliteral-module-specifier", node.moduleSpecifier, "Import specifier must be a literal");
      else {
        imports.push({ specifier, offset: node.moduleSpecifier.getStart(file), dynamic: false });
        if (options.forbidEnvironmentIo && (specifier === "node:child_process" || specifier === "child_process")) report("child-process-loader", node.moduleSpecifier, "child_process is outside the production boundary");
        if (options.pureAcceptanceCore && PURE_ACCEPTANCE_FORBIDDEN_MODULES.has(specifier)) report("acceptance-environment-import", node.moduleSpecifier, "Acceptance pure core cannot import filesystem, process, network, child-process, or worker APIs");
        if (specifier === "node:worker_threads" || specifier === "worker_threads") {
          for (const element of node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) ? node.importClause.namedBindings.elements : []) {
            const imported = element.propertyName?.text ?? element.name.text;
            if (imported === "Worker") workerNames.add(element.name.text);
          }
        }
        for (const element of node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) ? node.importClause.namedBindings.elements : []) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (imported === "createRequire" && (specifier === "node:module" || specifier === "module")) createRequireNames.add(element.name.text);
        }
        if (node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings) && (specifier === "node:worker_threads" || specifier === "worker_threads")) workerNames.add(`${node.importClause.namedBindings.name.text}.Worker`);
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = moduleSpecifierText(node.moduleSpecifier);
      if (specifier === null) report("nonliteral-module-specifier", node.moduleSpecifier, "Export specifier must be a literal");
      else imports.push({ specifier, offset: node.moduleSpecifier.getStart(file), dynamic: false });
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = moduleSpecifierText(node.moduleReference.expression!);
      if (specifier === null) report("nonliteral-module-specifier", node.moduleReference, "Import-equals specifier must be a literal");
      else imports.push({ specifier, offset: node.moduleReference.getStart(file), dynamic: false });
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (isRequireAlias(node.initializer)) {
        report("ambiguous-loader-alias", node.initializer, "Cannot prove a require alias dataflow; use a static import");
      }
      const initializer = unwrapped(node.initializer);
      if (ts.isCallExpression(initializer) && isIdentifierNamed(initializer.expression, requireNames)) {
        const requiredModule = initializer.arguments[0] ? moduleSpecifierText(initializer.arguments[0]) : null;
        if (requiredModule === "node:module" || requiredModule === "module") {
          if (ts.isObjectBindingPattern(node.name)) {
            for (const element of node.name.elements) {
              const imported = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : ts.isIdentifier(element.name) ? element.name.text : null;
              if (imported === "createRequire") addBinding(element.name, createRequireNames);
            }
          }
        }
      }
      if (isCreateRequireCall(node.initializer)) {
        addBinding(node.name, requireNames);
        addBinding(node.name, createRequireNames);
      }
      if (ts.isIdentifier(node.name) && isIdentifierNamed(node.initializer, workerNames)) workerNames.add(node.name.text);
      if (ts.isIdentifier(node.name) && ts.isPropertyAccessExpression(unwrapped(node.initializer))) {
        const property = unwrapped(node.initializer) as ts.PropertyAccessExpression;
        if (property.name.text === "Worker") workerNames.add(node.name.text);
      }
      if (ts.isIdentifier(node.name) && isCreateRequireCall(node.initializer)) createRequireNames.add(node.name.text);
      if (ts.isIdentifier(node.initializer) && (node.initializer.text === "eval" || node.initializer.text === "Function")) {
        report("ambiguous-dynamic-code-alias", node.initializer, "Cannot prove an eval/Function alias is safe; use static code");
      }
    }
    if (options.pureAcceptanceCore && ts.isIdentifier(node) && node.text === "process") {
      report("acceptance-environment-process", node, "Acceptance pure core cannot read process/environment state");
    }
    if (ts.isCallExpression(node)) {
      const expression = unwrapped(node.expression);
      if (isImportCall(expression)) {
        const argument = node.arguments[0];
        const specifier = argument ? moduleSpecifierText(argument) : null;
        if (specifier === null) report("dynamic-import-nonliteral", argument ?? node, "Dynamic import must use one literal module specifier");
        else imports.push({ specifier, offset: argument.getStart(file), dynamic: true });
      } else if (ts.isCallExpression(expression) && isIdentifierNamed(expression.expression, createRequireNames)) {
        const argument = node.arguments[0];
        const specifier = argument ? moduleSpecifierText(argument) : null;
        if (specifier === null) report("dynamic-loader", argument ?? node, "createRequire loader must use a literal specifier");
        else imports.push({ specifier, offset: argument.getStart(file), dynamic: false });
      } else if (isIdentifierNamed(expression, requireNames)) {
        const argument = node.arguments[0];
        const specifier = argument ? moduleSpecifierText(argument) : null;
        if (specifier === null) report("dynamic-loader", argument ?? node, "require/createRequire loader must use a literal specifier");
        else {
          if (options.forbidEnvironmentIo && (specifier === "node:child_process" || specifier === "child_process")) report("child-process-loader", argument, "child_process is outside the production boundary");
          imports.push({ specifier, offset: argument.getStart(file), dynamic: false });
        }
      } else if (isIdentifierNamed(expression, createRequireNames)) {
        // createRequire(import.meta.url) creates a loader; only calls made
        // through that loader are subject to the literal-specifier rule.
      } else if (ts.isIdentifier(expression) && (expression.text === "eval" || expression.text === "Function")) {
        report("dynamic-code-eval", expression, "eval and Function are not permitted in the source/build boundary");
      } else if (options.pureAcceptanceCore && ts.isIdentifier(expression) && (expression.text === "fetch" || expression.text === "WebSocket" || expression.text === "XMLHttpRequest")) {
        report("acceptance-environment-network", expression, "Acceptance pure core cannot perform network I/O");
      }
      const property = ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
      if (property && childProcessNames.has(property)) report("child-process-loader", expression, "child_process execution is outside the production boundary");
    }
    if (ts.isNewExpression(node)) {
      const expression = unwrapped(node.expression);
      const worker = ts.isIdentifier(expression) && workerNames.has(expression.text)
        || ts.isPropertyAccessExpression(expression) && workerNames.has(`${expression.expression.getText(file)}.${expression.name.text}`)
        || ts.isIdentifier(expression) && expression.text === "Worker";
      if (worker) {
        const argument = node.arguments?.[0];
        if (!argument || moduleSpecifierText(argument) === null) report("worker-nonliteral", argument ?? node, "Worker entry must be a literal and must resolve through NodeNext");
        else imports.push({ specifier: moduleSpecifierText(argument)!, offset: argument.getStart(file), dynamic: false });
      }
      if (ts.isIdentifier(expression) && expression.text === "Function") report("dynamic-code-eval", expression, "Function constructor is not permitted");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { diagnostics, imports };
}

function resolveSpecifier(
  root: string,
  containingPath: string,
  specifier: string,
  options: ts.CompilerOptions,
  tracked: ReadonlyMap<string, TrackedFile>,
  externalDependencies: Set<string>,
  diagnostics: BoundaryDiagnostic[],
  offset: number,
): string | null {
  if (NODE_BUILTIN_PREFIXES.some((prefix) => specifier.startsWith(prefix))) {
    externalDependencies.add(specifier);
    return `@external/${specifier}`;
  }
  const result = ts.resolveModuleName(specifier, containingPath, options, ts.sys).resolvedModule;
  if (!result) {
    diagnostics.push(diagnostic("invalid", "unresolved-module", rel(root, containingPath), `NodeNext could not resolve ${specifier}`, offset));
    return null;
  }
  const target = resolve(result.resolvedFileName);
  if (!isInside(root, target)) {
    if (target.includes(`${sep}node_modules${sep}`)) {
      externalDependencies.add(specifier);
      return `@external/${specifier}`;
    }
    diagnostics.push(diagnostic("invalid", "resolved-outside-root", rel(root, containingPath), `Resolved module ${specifier} is outside the exact repository root`, offset));
    return null;
  }
  const targetPath = rel(root, target);
  if (targetPath.startsWith("node_modules/")) {
    externalDependencies.add(specifier);
    return `@external/${specifier}`;
  }
  const file = tracked.get(targetPath);
  if (!file) diagnostics.push(diagnostic("invalid", "resolved-file-not-tracked", targetPath, `Resolved module ${specifier} is outside the exact Git denominator`, offset));
  if (file?.mode === "120000") diagnostics.push(diagnostic("invalid", "resolved-symlink", targetPath, "Resolved module is a symlink", offset));
  return file ? targetPath : null;
}

export interface GeneratedManifestFacts {
  readonly diagnostics: readonly BoundaryDiagnostic[];
  readonly generatorPaths: readonly string[];
}

export function validateGeneratedManifestFacts(
  manifestPath: string,
  value: Record<string, unknown>,
  generatedPaths: readonly string[],
  files: readonly TrackedFile[],
): GeneratedManifestFacts {
  const diagnostics: BoundaryDiagnostic[] = [];
  const keys = Object.keys(value).sort();
  const expectedKeys = ["generators", "manifestHash", "outputs"];
  if (canonical(keys) !== canonical(expectedKeys)) diagnostics.push(diagnostic("fail", "generated-manifest-keys", manifestPath, "Generated manifest must contain exactly generators, manifestHash, and outputs"));
  const rawOutputsValue = value.outputs;
  const rawOutputs = Array.isArray(rawOutputsValue) ? rawOutputsValue : [];
  if (!Array.isArray(rawOutputsValue) || !rawOutputs.every((item): item is string => typeof item === "string")) diagnostics.push(diagnostic("fail", "generated-output-type", manifestPath, "Generated outputs must be an array of strings"));
  const outputs = rawOutputs.filter((item): item is string => typeof item === "string");
  const sortedOutputs = [...outputs].sort();
  const actual = [...generatedPaths].sort();
  if (outputs.length === 0 || new Set(outputs).size !== outputs.length || canonical(outputs) !== canonical(sortedOutputs) || canonical(sortedOutputs) !== canonical(actual)) diagnostics.push(diagnostic("fail", "generated-output-set-mismatch", manifestPath, "Generated manifest output set must be a non-empty exact sorted set"));
  const rawGeneratorsValue = value.generators;
  const rawGenerators = Array.isArray(rawGeneratorsValue) ? rawGeneratorsValue : [];
  if (!Array.isArray(rawGeneratorsValue) || !rawGenerators.every((item): item is string => typeof item === "string")) diagnostics.push(diagnostic("fail", "generator-type", manifestPath, "Generator closure must be an array of strings"));
  const generators = rawGenerators.filter((item): item is string => typeof item === "string");
  const sortedGenerators = [...generators].sort();
  if (generators.length === 0 || new Set(generators).size !== generators.length || canonical(generators) !== canonical(sortedGenerators)) diagnostics.push(diagnostic("invalid", "generator-closure-missing", manifestPath, "Generated outputs require a non-empty exact sorted generator closure"));
  for (const generator of generators) {
    const file = files.find((candidate) => candidate.path === generator);
    if (!file || file.fileClass === "generated" || file.language === "metadata") diagnostics.push(diagnostic("invalid", "generator-not-tracked-source", manifestPath, `Generator ${generator} is not a tracked source file`));
  }
  const manifestHash = hashDomain("aloha/boundary/generated-manifest/v1", { path: manifestPath, outputs: sortedOutputs, generators: sortedGenerators });
  if (typeof value.manifestHash !== "string" || value.manifestHash !== manifestHash) diagnostics.push(diagnostic("fail", "generated-manifest-hash", manifestPath, "Generated manifest must carry the exact canonical manifest hash"));
  return { diagnostics, generatorPaths: generators };
}

function validateGeneratedTree(root: string, files: readonly TrackedFile[], diagnostics: BoundaryDiagnostic[]): Set<string> {
  const generated = files.filter((file) => file.fileClass === "generated");
  if (generated.length === 0) return new Set();
  const manifestCandidates = files.filter((file) => /(?:^|\/)(?:generated|\.generated)-manifest\.json$/.test(file.path));
  if (manifestCandidates.length !== 1) {
    diagnostics.push(diagnostic("invalid", "generated-manifest-missing", generated[0].path, "Generated outputs require one tracked generated manifest and generator closure"));
    return new Set();
  }
  const manifestPath = manifestCandidates[0].path;
  const value = readJson(root, manifestPath, diagnostics);
  if (!value) return new Set();
  const actual = generated.map((file) => file.path).filter((path) => path !== manifestPath).sort();
  const facts = validateGeneratedManifestFacts(manifestPath, value, actual, files);
  diagnostics.push(...facts.diagnostics);
  return new Set(facts.generatorPaths);
}

export function validateDependencyBoundaries(
  files: readonly TrackedFile[],
  edges: readonly GraphEdge[],
  diagnostics: BoundaryDiagnostic[],
): void {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const testOrFixture = (path: string): boolean =>
    /(?:^|\/)(?:test|tests|fixture|fixtures)\//.test(path) || /(?:^|\.)test\.[^.]+$/.test(path) || /(?:^|\.)spec\.[^.]+$/.test(path);
  const isSpecs = (path: string): boolean => path.startsWith("specs/");
  const isCanonicalCodec = (path: string): boolean => path.startsWith("packages/canonical-codec/");
  const isGeneratedComposition = (path: string): boolean => /(?:^|\/)(?:runtime|production)-composition\.[^.]+$/.test(path) || path.includes("/runtime-composition/");
  const isFamilyPublic = (path: string): boolean => {
    const base = path.slice(path.lastIndexOf("/") + 1);
    return base === "index.ts" || base === "index.js" || base.endsWith("-public.ts") || path.includes("/public/");
  };
  const isPublicPluginEntry = (file: TrackedFile): boolean => (file.fileClass === "family" || file.fileClass === "strategy") && isFamilyPublic(file.path);
  for (const edge of edges) {
    const from = byPath.get(edge.from);
    const to = byPath.get(edge.to);
    if (!from) continue;
    const fromIsTest = testOrFixture(from.path);
    // Tests and fixtures are observed separately; they must never create a
    // production import edge or make the production closure appear larger.
    if (fromIsTest) continue;
    const external = edge.to.startsWith("@external/");
    if (external) {
      const forbiddenGovernanceExternal =
        from.fileClass === "acceptance-pure-core" ||
        (from.fileClass === "central" && isSpecs(from.path)) ||
        (from.fileClass === "reference-only" && !edge.specifier.startsWith("node:"));
      if (forbiddenGovernanceExternal) diagnostics.push(diagnostic("fail", "governance-imports-external", edge.from, `Governance source cannot import external dependency ${edge.specifier}`));
      continue;
    }
    if (!to) continue;
    if (testOrFixture(to.path)) diagnostics.push(diagnostic("fail", "production-imports-test-fixture", edge.from, `Non-test source imports test/fixture source ${edge.to}`));
    if (from.fileClass === "central") {
      if (to.fileClass === "family") diagnostics.push(diagnostic("fail", "central-imports-family", edge.from, `Central code imports Family source ${edge.to}`));
      if (to.fileClass === "strategy") diagnostics.push(diagnostic("fail", "central-imports-strategy", edge.from, `Central code imports Strategy source ${edge.to}`));
      if (to.fileClass === "production-runtime") diagnostics.push(diagnostic("fail", "central-imports-runtime", edge.from, `Central code imports runtime source ${edge.to}`));
      if (to.fileClass === "acceptance-pure-core" || to.fileClass === "acceptance-collector" || to.fileClass === "reference-only") diagnostics.push(diagnostic("fail", "central-imports-governance-tool", edge.from, `Central code imports governance/acceptance source ${edge.to}`));
      if (to.fileClass === "generated") diagnostics.push(diagnostic("fail", "central-imports-generated", edge.from, `Central code cannot import generated concrete/composition output ${edge.to}`));
      if (isSpecs(from.path) && !isSpecs(to.path) && !isCanonicalCodec(to.path)) diagnostics.push(diagnostic("fail", "specs-import-outside-frozen-closure", edge.from, `Frozen specs may only import specs or canonical-codec: ${edge.to}`));
    }
    if (from.fileClass === "production-runtime") {
      if (to.fileClass === "authoring" || to.fileClass === "reference-only") diagnostics.push(diagnostic("fail", "runtime-imports-authoring", edge.from, `Runtime imports ${to.fileClass} source ${edge.to}`));
      if (to.fileClass === "family" || to.fileClass === "acceptance-pure-core" || to.fileClass === "acceptance-collector") diagnostics.push(diagnostic("fail", "runtime-imports-family-or-acceptance", edge.from, `Runtime cannot import Family or acceptance implementation ${edge.to}`));
      if (to.fileClass === "strategy") diagnostics.push(diagnostic("fail", "runtime-imports-strategy", edge.from, `Runtime must consume generated composition, not concrete Strategy source ${edge.to}`));
    }
    if (from.fileClass === "acceptance-pure-core" && to.fileClass !== "acceptance-pure-core" && !isSpecs(to.path) && !isCanonicalCodec(to.path)) diagnostics.push(diagnostic("fail", "acceptance-imports-production", edge.from, `Acceptance pure core may only import itself, frozen specs, or canonical-codec: ${edge.to}`));
    if (from.fileClass === "acceptance-collector" && (to.fileClass === "production-runtime" || to.fileClass === "family" || to.fileClass === "reference-only")) diagnostics.push(diagnostic("fail", "collector-imports-production", edge.from, `Collector cannot import production or reference-only implementation ${edge.to}`));
    if (from.fileClass === "reference-only" && !isSpecs(to.path) && !isCanonicalCodec(to.path) && to.fileClass !== "reference-only") diagnostics.push(diagnostic("fail", "reference-imports-production", edge.from, `Reference-only code may only import frozen specs, canonical-codec, or local reference code: ${edge.to}`));
    if (from.fileClass === "family" && to.fileClass === "family" && from.path.split("/")[1] !== to.path.split("/")[1]) diagnostics.push(diagnostic("fail", "family-imports-family", edge.from, `Family imports another Family internals ${edge.to}`));
    if (from.fileClass === "strategy" && to.fileClass === "strategy" && from.path.split("/")[1] !== to.path.split("/")[1]) diagnostics.push(diagnostic("fail", "strategy-imports-strategy", edge.from, `Strategy imports another Strategy internals ${edge.to}`));
    if (from.fileClass === "strategy" && (to.fileClass === "family" || to.fileClass === "acceptance-pure-core" || to.fileClass === "acceptance-collector")) diagnostics.push(diagnostic("fail", "strategy-imports-family-or-acceptance", edge.from, `Strategy cannot import Family or acceptance implementation ${edge.to}`));
    if (from.fileClass === "generated" && to.fileClass === "authoring") diagnostics.push(diagnostic("fail", "generated-imports-authoring", edge.from, `Generated output cannot import authoring code ${edge.to}`));
    if (from.fileClass === "generated" && (to.fileClass === "family" || to.fileClass === "strategy") && !(isGeneratedComposition(from.path) && isPublicPluginEntry(to))) diagnostics.push(diagnostic("fail", "generated-imports-plugin-internal", edge.from, `Only generated composition may import a Family/Strategy public entry ${edge.to}`));
    if (
      to.fileClass === "generated" &&
      from.fileClass !== "central" &&
      from.fileClass !== "generated" &&
      !(from.fileClass === "production-runtime" && isGeneratedComposition(to.path))
    ) {
      diagnostics.push(diagnostic("fail", "generated-consumer-boundary", edge.from, `Only generated modules may compose generated artifacts, and apps may consume runtime composition only: ${edge.to}`));
    }
  }
}

function sourceBuildGraph(
  root: string,
  files: readonly TrackedFile[],
  configs: readonly string[],
  packageRoot: string,
  requiredGenerators: ReadonlySet<string>,
  diagnostics: BoundaryDiagnostic[],
): { nodes: GraphNode[]; edges: GraphEdge[]; compilerRoot: string; externalDependencies: string[] } {
  const tracked = new Map(files.map((file) => [file.path, file]));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const externalDependencies = new Set<string>();
  const covered = new Set<string>();
  const configRoots: Array<{ path: string; options: ts.CompilerOptions; roots: string[] }> = [];
  for (const configPath of configs) {
    const result = readTsConfig(root, configPath, diagnostics);
    if (!result) continue;
    configRoots.push({ path: configPath, options: result.parsed.options, roots: result.parsed.fileNames.map((name) => resolve(name)) });
    for (const name of result.parsed.fileNames) {
      const path = rel(root, resolve(name));
      if (tracked.has(path)) covered.add(path);
    }
    const sourceFiles = result.program.getSourceFiles().filter((source) => {
      if (!isInside(root, resolve(source.fileName))) return false;
      return !rel(root, resolve(source.fileName)).startsWith("node_modules/");
    });
    for (const source of sourceFiles) {
      const sourcePath = rel(root, resolve(source.fileName));
      if (!tracked.has(sourcePath)) {
        diagnostics.push(diagnostic("invalid", "compiler-source-not-tracked", sourcePath, "Compiler graph contains a source not present in exact Git tree"));
        continue;
      }
      nodes.push({ path: sourcePath, configPath, root: result.parsed.fileNames.some((name) => resolve(name) === resolve(source.fileName)) });
      const sourceFileMeta = tracked.get(sourcePath)!;
      const pureAcceptanceCore = sourceFileMeta.fileClass === "acceptance-pure-core" && !/(?:^|\/)(?:test|tests)\//.test(sourcePath) && !/(?:^|\.)test\.[^.]+$/.test(sourcePath);
      const forbidEnvironmentIo = sourceFileMeta.fileClass !== "authoring" && sourceFileMeta.fileClass !== "acceptance-collector" && sourceFileMeta.fileClass !== "reference-only" && !/(?:^|\/)(?:test|tests)\//.test(sourcePath) && !/(?:^|\.)test\.[^.]+$/.test(sourcePath);
      const scan = inspectSourceText(sourcePath, readFileSync(source.fileName, "utf8"), { pureAcceptanceCore, forbidEnvironmentIo });
      diagnostics.push(...scan.diagnostics);
      for (const item of scan.imports) {
        const target = resolveSpecifier(root, source.fileName, item.specifier, result.parsed.options, tracked, externalDependencies, diagnostics, item.offset);
        if (target) edges.push({ from: sourcePath, to: target, specifier: item.specifier });
      }
    }
  }
  const sourceFiles = files.filter((file) => file.language === "typescript" || file.language === "javascript");
  for (const file of sourceFiles) {
    if (!covered.has(file.path)) diagnostics.push(diagnostic("invalid", "source-not-in-tsconfig", file.path, "Tracked TS/JS source is excluded from every real compiler config"));
  }
  const uniqueNodes = Array.from(new Map(nodes.map((node) => [`${node.configPath}|${node.path}`, node])).values()).sort((a, b) => `${a.configPath}|${a.path}`.localeCompare(`${b.configPath}|${b.path}`));
  const uniqueEdges = Array.from(new Map(edges.map((edge) => [`${edge.from}|${edge.to}|${edge.specifier}`, edge])).values()).sort((a, b) => `${a.from}|${a.to}|${a.specifier}`.localeCompare(`${b.from}|${b.to}|${b.specifier}`));
  for (const generator of requiredGenerators) {
    if (!uniqueNodes.some((node) => node.path === generator)) diagnostics.push(diagnostic("invalid", "generator-outside-compiler-graph", generator, "Every generated output generator must be present in the pinned compiler graph"));
  }
  validateDependencyBoundaries(files, uniqueEdges, diagnostics);
  const compilerRoot = hashDomain("aloha/boundary/compiler-graph/v1", {
    version: ts.version,
    configs: configRoots.map((config) => ({ path: config.path, options: config.options, roots: config.roots.map((name) => rel(root, name)).sort() })),
    packageRoot,
    externalDependencies: Array.from(externalDependencies).sort(),
    nodes: uniqueNodes,
    edges: uniqueEdges,
  });
  return { nodes: uniqueNodes, edges: uniqueEdges, compilerRoot, externalDependencies: Array.from(externalDependencies).sort() };
}

function exactGitState(root: string, requirePushed: boolean, diagnostics: BoundaryDiagnostic[]): BoundaryReceipt["candidate"] {
  let branch: string | null = null;
  let headSha: string | null = null;
  let upstreamSha: string | null = null;
  let clean = false;
  try {
    if (git(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") throw new Error("not a Git work tree");
    branch = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]) || null;
    headSha = git(root, ["rev-parse", "HEAD"]) || null;
    const status = execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" });
    clean = status.length === 0;
    if (!clean) diagnostics.push(diagnostic("invalid", "dirty-tree", ".", "Required gate denominator must be a clean work tree"));
    try { upstreamSha = git(root, ["rev-parse", "--verify", "@{upstream}"]) || null; } catch { upstreamSha = null; }
    if (!branch) diagnostics.push(diagnostic("invalid", "detached-head", ".", "Required gate needs a named candidate branch"));
    if (requirePushed && !upstreamSha) diagnostics.push(diagnostic("invalid", "unpushed-candidate", ".", "No upstream ref proves this candidate was pushed"));
    if (requirePushed && upstreamSha && headSha !== upstreamSha) diagnostics.push(diagnostic("invalid", "remote-not-at-head", ".", "HEAD is not the exact upstream tip"));
  } catch (error) {
    diagnostics.push(diagnostic("invalid", "git-state-unreadable", ".", String(error)));
  }
  return { gitRoot: root, branch, headSha, upstreamSha, clean, pushed: Boolean(headSha && upstreamSha && headSha === upstreamSha) };
}

function languageAdapterCheck(files: readonly TrackedFile[], diagnostics: BoundaryDiagnostic[]): void {
  const rust = files.some((file) => file.language === "rust");
  const solidity = files.some((file) => file.language === "solidity");
  if (rust) diagnostics.push(diagnostic("invalid", "rust-build-adapter-missing", ".", "A .rs file entered the denominator without a pinned cargo/build-graph adapter"));
  if (solidity) diagnostics.push(diagnostic("invalid", "solidity-build-adapter-missing", ".", "A .sol file entered the denominator without a pinned solc/Forge build-graph adapter"));
}

function mutationKey(value: MutationExpectation): string {
  return `${value.caseId}|${value.path}|${value.offset}|${value.code}`;
}

export function verifyMutationCorpus(cases: readonly MutationCase[] = MUTATION_CORPUS): MutationResult[] {
  return cases.map((item) => {
    const actual = inspectSourceText(item.path, item.source, item.scanOptions).diagnostics.map((entry) => ({ caseId: item.caseId, path: entry.path, offset: entry.offset ?? -1, code: entry.code })).sort((a, b) => mutationKey(a).localeCompare(mutationKey(b)));
    const expected = [...item.expected].sort((a, b) => mutationKey(a).localeCompare(mutationKey(b)));
    const pass = actual.length === expected.length && actual.every((entry, index) => mutationKey(entry) === mutationKey(expected[index]));
    return { caseId: item.caseId, expected, actual, pass };
  });
}

const mutation = (caseId: string, path: string, source: string, code: string, token: string): MutationCase => ({
  caseId,
  path,
  source,
  expected: [{ caseId, path, offset: source.indexOf(token), code }],
});

/** Each case is independently scanned; no case can satisfy another case's expected multiset. */
export const MUTATION_CORPUS: readonly MutationCase[] = Object.freeze([
  mutation("require-alias", "fixture/require-alias.ts", "const load = require; load(name);", "ambiguous-loader-alias", "require"),
  mutation("create-require-alias", "fixture/create-require-alias.ts", "const req = createRequire(import.meta.url); req(name);", "dynamic-loader", "name"),
  mutation("dynamic-import-concat", "fixture/dynamic-import-concat.ts", "import('./safe.js' + suffix);", "dynamic-import-nonliteral", "'./safe.js'"),
  mutation("worker-alias", "fixture/worker-alias.ts", "new Worker('./worker.js' + suffix);", "worker-nonliteral", "'./worker.js'"),
  mutation("eval", "fixture/eval.ts", "eval(source);", "dynamic-code-eval", "eval"),
  mutation("function-constructor", "fixture/function.ts", "new Function(source);", "dynamic-code-eval", "Function"),
  {
    caseId: "acceptance-fs-process",
    path: "fixture/acceptance-fs-process.ts",
    source: "import fs from 'node:fs'; process.env.HOME;",
    scanOptions: { pureAcceptanceCore: true },
    expected: [
      { caseId: "acceptance-fs-process", path: "fixture/acceptance-fs-process.ts", offset: 15, code: "acceptance-environment-import" },
      { caseId: "acceptance-fs-process", path: "fixture/acceptance-fs-process.ts", offset: 26, code: "acceptance-environment-process" },
    ],
  },
  {
    caseId: "same-file-extra-diagnostics",
    path: "fixture/same-file-extra.ts",
    source: "require(prefix); eval(source);",
    expected: [
      { caseId: "same-file-extra-diagnostics", path: "fixture/same-file-extra.ts", offset: 8, code: "dynamic-loader" },
      { caseId: "same-file-extra-diagnostics", path: "fixture/same-file-extra.ts", offset: 17, code: "dynamic-code-eval" },
    ],
  },
]);

export function runBoundaryGate(options: BoundaryOptions = {}): BoundaryReceipt {
  const root = resolve(options.gitRoot ?? fileURLToPath(new URL("../../..", import.meta.url)));
  const requirePushed = options.requirePushed ?? true;
  const diagnostics: BoundaryDiagnostic[] = [];
  const candidate = exactGitState(root, requirePushed, diagnostics);
  const files = readTrackedFiles(root, diagnostics);
  if (files.length === 0) diagnostics.push(diagnostic("invalid", "empty-git-denominator", ".", "An empty or unreadable Git tree cannot receive boundary credit"));
  const packageData = readPackageManifests(root, files, diagnostics);
  const generatedGenerators = validateGeneratedTree(root, files, diagnostics);
  languageAdapterCheck(files, diagnostics);
  const configs = files.filter((file) => /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(file.path) || /(?:^|\/)jsconfig(?:\.[^/]+)?\.json$/.test(file.path)).map((file) => file.path).sort();
  if (files.some((file) => file.language === "typescript" || file.language === "javascript") && configs.length === 0) diagnostics.push(diagnostic("invalid", "tsconfig-missing", ".", "TS/JS denominator has no real compiler configuration"));
  const graph = sourceBuildGraph(root, files, configs, packageData.rootHash, generatedGenerators, diagnostics);
  const lockFiles = files.filter((file) => /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(file.path));
  if (graph.externalDependencies.some((specifier) => !specifier.startsWith("node:")) && lockFiles.length === 0) {
    diagnostics.push(diagnostic("invalid", "external-lock-missing", ".", "External package imports require a tracked lockfile bound into the compiler graph"));
  }
  const scannedFileSetRoot = hashDomain("aloha/boundary/scanned-file-set/v1", files);
  const compilerVersionRoot = hashDomain("aloha/boundary/compiler-version/v1", { package: "typescript", version: ts.version });
  const configRoots = hashDomain("aloha/boundary/compiler-configs/v1", configs.map((path) => ({ path, sha: files.find((file) => file.path === path)?.blobSha ?? null })));
  const externalDependencyRoot = hashDomain("aloha/boundary/external-dependencies/v1", {
    dependencies: graph.externalDependencies,
    lockFiles: lockFiles.map((file) => ({ path: file.path, sha: file.blobSha })),
  });
  const manifestRoot = hashDomain("aloha/boundary/manifest/v1", {
    scannedFileSetRoot,
    configs,
    configRoots,
    compilerVersionRoot,
    compilerGraphRoot: graph.compilerRoot,
    externalDependencyRoot,
    packageManifestRoot: packageData.rootHash,
  });
  const mutationCorpus = verifyMutationCorpus();
  for (const result of mutationCorpus) if (!result.pass) diagnostics.push(diagnostic("fail", "mutation-expected-multiset", result.caseId, "Mutation actual diagnostics differ from its independent exact expected multiset"));
  const compiler: CompilerSummary = {
    typescriptVersion: ts.version,
    compilerVersionRoot,
    configPaths: configs,
    configRoots,
    graphRoot: graph.compilerRoot,
    packageManifestRoot: packageData.rootHash,
    externalDependencyRoot,
    externalDependencies: graph.externalDependencies,
    workspaceNames: packageData.workspaceNames,
  };
  const finalDiagnostics = uniqueDiagnostics(diagnostics);
  const verdict = finalDiagnostics.some((item) => item.kind === "invalid") ? "invalid" : finalDiagnostics.length > 0 ? "fail" : "pass";
  return {
    schemaVersion: 1,
    gate: "aloha.machine-enforced-boundary",
    verdict,
    candidate,
    denominator: { scannedFileSetRoot, manifestRoot, files },
    compiler,
    graph: { nodes: graph.nodes, edges: graph.edges },
    diagnostics: finalDiagnostics,
    mutationCorpus: { root: hashDomain("aloha/boundary/mutation-corpus/v1", mutationCorpus), cases: mutationCorpus },
    claims: { sourceBuildClosure: "observed", runtimeLegacyZero: "not-asserted", productionAuthority: "not-observed" },
  };
}

export function formatReceipt(receipt: BoundaryReceipt): string {
  return `${canonical(receipt)}\n`;
}
