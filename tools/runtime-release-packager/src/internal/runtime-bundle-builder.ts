import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { buildSync, type Metafile } from "esbuild";
import ts from "typescript";
import { sha256Hex, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import { PRODUCTION_RELEASE_LAYOUT_V1 } from "../deployment-package.ts";

const PRODUCTION_RUNTIME_ENTRY_V1 = "apps/searcher-runtime/src/release-runtime.ts";
const PRODUCTION_LAUNCHER_ENTRY_V1 = "tools/runtime-release-packager/assets/production-launcher.mjs";
const QUALIFIED_RELEASE_RUNNER_ENTRY_V1 = "tools/runtime-release-packager/src/internal/qualified-release-runtime-entry.ts";
const OUTPUT_FILE_V1 = "aloha-production-runtime.mjs";
const QUALIFIED_RELEASE_RUNNER_OUTPUT_FILE_V1 = "aloha-qualified-release-runner.mjs";
const FORBIDDEN_LOADER_MODULES = Object.freeze(new Set([
  "node:module",
  "node:vm",
  "node:worker_threads",
]));
const PRODUCTION_CHILD_PROCESS_OWNERS = Object.freeze(new Set([
  "packages/runtime-release-authority/src/internal/external-proof-owner.ts",
  "runtime/revm-workers/src/node-worker-factory.ts",
]));
const FORBIDDEN_PRODUCTION_BUILD_GRAPH_SEGMENTS = Object.freeze([
  "node_modules",
  "tools/architecture-boundaries/",
  "tools/runtime-release-packager/",
]);
const QUALIFIED_RELEASE_RUNNER_BUILTINS = Object.freeze(new Set([
  "node:crypto",
  "node:fs",
  "node:fs/promises",
  "node:path",
  "node:sqlite",
  "node:util",
  "node:v8",
]));
const FORBIDDEN_LOADER_PROPERTIES = Object.freeze(new Set([
  "createRequire", "getBuiltinModule", "register", "eval", "Function", "Worker", "WebAssembly",
]));
const ALLOWED_PRODUCTION_OPT_PATHS = Object.freeze(new Set([
  PRODUCTION_RELEASE_LAYOUT_V1.revmWorkerExecutablePath,
  PRODUCTION_RELEASE_LAYOUT_V1.proofSignerExecutablePath,
]));

export interface BuiltProductionRuntimeBundleV1 {
  readonly bytes: Uint8Array;
  readonly sha256: Hash;
  readonly metafile: Metafile;
}

export interface ProductionLauncherArtifactV1 {
  readonly bytes: Uint8Array;
  readonly sha256: Hash;
}

export interface BuiltQualifiedReleaseRunnerBundleV1 {
  readonly bytes: Uint8Array;
  readonly sha256: Hash;
}

function assertMetafile(
  metafile: Metafile,
  repositoryRoot: string,
  forbiddenGraphSegments: readonly string[],
  label: string,
  allowedAcceptancePrefixes?: readonly string[],
): void {
  const outputs = Object.values(metafile.outputs);
  if (outputs.length !== 1) throw new TypeError(`${label} builder emitted a non-singleton output`);
  for (const imported of outputs[0]!.imports) {
    if (!imported.external || !imported.path.startsWith("node:")
      || FORBIDDEN_LOADER_MODULES.has(imported.path)) {
      throw new TypeError(`${label} bundle has a non-builtin import: ${imported.path}`);
    }
  }
  const childProcessOwners = Object.entries(metafile.inputs)
    .filter(([, input]) => input.imports.some(imported => imported.external
      && imported.path === "node:child_process"
      && imported.kind === "import-statement"))
    .map(([path]) => path)
    .sort();
  if (label === "production runtime") {
    const expected = [...PRODUCTION_CHILD_PROCESS_OWNERS].sort();
    if (childProcessOwners.length !== expected.length
      || childProcessOwners.some((path, index) => path !== expected[index])) {
      throw new TypeError("production runtime child-process owner denominator mismatch");
    }
  } else if (childProcessOwners.length !== 0) {
    throw new TypeError(`${label} bundle contains a child-process owner`);
  }
  for (const path of [...Object.keys(metafile.inputs), ...Object.keys(metafile.outputs)]) {
    if (isAbsolute(path) || path.includes("\\")
      || forbiddenGraphSegments.some(segment => path.includes(segment))
      || (allowedAcceptancePrefixes !== undefined && path.startsWith("acceptance/")
        && !allowedAcceptancePrefixes.some(prefix => path.startsWith(prefix)))) {
      throw new TypeError(`${label} build graph has a non-release path: ${path}`);
    }
  }
  if (JSON.stringify(metafile).includes(repositoryRoot)) {
    throw new TypeError(`${label} build graph leaks its worktree path`);
  }
}

function moduleSpecifier(value: ts.Expression, _source: ts.SourceFile, label: string): string {
  if (!ts.isStringLiteralLike(value) || !value.text.startsWith("node:")
    || FORBIDDEN_LOADER_MODULES.has(value.text)) {
    throw new TypeError(`${label} must reference a node:* builtin`);
  }
  return value.text;
}

function assertNoUnexpectedProductionOptPath(source: ts.SourceFile, label: string): void {
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && node.text.includes("/opt/aloha")
      && !ALLOWED_PRODUCTION_OPT_PATHS.has(node.text)) {
      throw new TypeError(`${label} references an unapproved /opt/aloha path`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function propertyName(expression: ts.Expression, name: string): expression is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(expression) && expression.name.text === name;
}

function isMemberName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || ((ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)
      || ts.isPropertyAssignment(parent) || ts.isMethodSignature(parent))
      && parent.name === node);
}

function isLoaderProperty(node: ts.Node): boolean {
  return (ts.isPropertyAccessExpression(node) && FORBIDDEN_LOADER_PROPERTIES.has(node.name.text))
    || (ts.isElementAccessExpression(node)
      && node.argumentExpression !== undefined
      && ts.isStringLiteralLike(node.argumentExpression)
      && FORBIDDEN_LOADER_PROPERTIES.has(node.argumentExpression.text));
}

function assertBase64Expression(value: ts.Expression): void {
  if (!ts.isCallExpression(value) || value.arguments.length !== 1
    || !ts.isStringLiteral(value.arguments[0]!) || value.arguments[0]!.text !== "base64"
    || !propertyName(value.expression, "toString")) {
    throw new TypeError("production runtime data URL payload is not an exact base64 conversion");
  }
  const receiver = value.expression.expression;
  if (!ts.isCallExpression(receiver) || receiver.arguments.length !== 1
    || !propertyName(receiver.expression, "from")
    || !ts.isIdentifier(receiver.expression.expression)
    || receiver.expression.expression.text !== "Buffer"
    || !ts.isIdentifier(receiver.arguments[0]!)) {
    throw new TypeError("production runtime data URL payload is not sourced from one snapshot identifier");
  }
}

function assertHashFragmentExpression(value: ts.Expression): void {
  if (!ts.isCallExpression(value) || value.arguments.length !== 1
    || !ts.isNumericLiteral(value.arguments[0]!) || value.arguments[0]!.text !== "2"
    || !propertyName(value.expression, "slice")) {
    throw new TypeError("production runtime data URL hash fragment is not exact");
  }
  const receiver = value.expression.expression;
  if (!ts.isPropertyAccessExpression(receiver)
    || receiver.name.text !== "deploymentCompositionModuleSha256"
    || !ts.isIdentifier(receiver.expression)) {
    throw new TypeError("production runtime data URL hash is not manifest-bound");
  }
}

function assertExactDataUrlDynamicImport(argument: ts.Expression | undefined): void {
  if (argument === undefined || !ts.isTemplateExpression(argument)
    || argument.head.text !== "data:text/javascript;base64,"
    || argument.templateSpans.length !== 2
    || argument.templateSpans[0]!.literal.text !== "#"
    || argument.templateSpans[1]!.literal.text !== "") {
    throw new TypeError("production runtime dynamic import is not the exact in-memory data URL form");
  }
  assertBase64Expression(argument.templateSpans[0]!.expression);
  assertHashFragmentExpression(argument.templateSpans[1]!.expression);
}

function assertLauncherDataUrlDynamicImport(argument: ts.Expression | undefined): void {
  if (argument === undefined || !ts.isTemplateExpression(argument)
    || argument.head.text !== "data:text/javascript;base64,"
    || argument.templateSpans.length !== 2
    || argument.templateSpans[0]!.literal.text !== "#"
    || argument.templateSpans[1]!.literal.text !== "") {
    throw new TypeError("production launcher dynamic import is not the exact snapshot data URL form");
  }
  const payload = argument.templateSpans[0]!.expression;
  if (!ts.isCallExpression(payload) || payload.arguments.length !== 1
    || !ts.isStringLiteral(payload.arguments[0]!) || payload.arguments[0]!.text !== "base64"
    || !propertyName(payload.expression, "toString")) {
    throw new TypeError("production launcher data URL payload is not exact base64");
  }
  const bufferFrom = payload.expression.expression;
  if (!ts.isCallExpression(bufferFrom) || bufferFrom.arguments.length !== 1
    || !propertyName(bufferFrom.expression, "from")
    || !ts.isIdentifier(bufferFrom.expression.expression)
    || bufferFrom.expression.expression.text !== "Buffer"
    || !ts.isPropertyAccessExpression(bufferFrom.arguments[0]!)
    || !ts.isIdentifier(bufferFrom.arguments[0]!.expression)
    || bufferFrom.arguments[0]!.expression.text !== "runtime"
    || bufferFrom.arguments[0]!.name.text !== "bytes") {
    throw new TypeError("production launcher data URL payload is not the verified runtime snapshot");
  }
  const fragment = argument.templateSpans[1]!.expression;
  if (!ts.isCallExpression(fragment) || fragment.arguments.length !== 1
    || !ts.isNumericLiteral(fragment.arguments[0]!) || fragment.arguments[0]!.text !== "2"
    || !propertyName(fragment.expression, "slice")
    || !ts.isPropertyAccessExpression(fragment.expression.expression)
    || !ts.isIdentifier(fragment.expression.expression.expression)
    || fragment.expression.expression.expression.text !== "runtime"
    || fragment.expression.expression.name.text !== "sha256") {
    throw new TypeError("production launcher data URL fragment is not the verified runtime hash");
  }
}

/** The root-owned launcher is inert builtins-only verification plus one snapshot import. */
export function assertProductionLauncherArtifactV1(bytesValue: Uint8Array): void {
  let sourceText: string;
  try {
    sourceText = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytesValue));
  } catch {
    throw new TypeError("production launcher is not UTF-8 JavaScript");
  }
  if (sourceText.includes("node_modules")
    || sourceText.includes("node:child_process") || sourceText.includes("/usr/bin/git")) {
    throw new TypeError("production launcher references a candidate checkout or external loader");
  }
  const source = ts.createSourceFile("production-launcher.mjs", sourceText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const parseDiagnostics = (source as ts.SourceFile & {
    readonly parseDiagnostics?: readonly ts.Diagnostic[];
  }).parseDiagnostics ?? [];
  if (parseDiagnostics.length !== 0) throw new TypeError("production launcher is not valid JavaScript");
  assertNoUnexpectedProductionOptPath(source, "production launcher");
  const imports: string[] = [];
  let dynamicImportCount = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = moduleSpecifier(node.moduleSpecifier, source, "production launcher import");
      imports.push(specifier);
    } else if (ts.isExportDeclaration(node)) {
      throw new TypeError("production launcher must not export a module surface");
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      dynamicImportCount += 1;
      assertLauncherDataUrlDynamicImport(node.arguments[0]);
    } else if (ts.isMetaProperty(node)
      || (ts.isIdentifier(node) && ["createRequire", "eval", "Function", "Worker", "WebAssembly"].includes(node.text))
      || (ts.isIdentifier(node) && /^(?:__)?require[0-9]*$/.test(node.text) && !isMemberName(node))
      || isLoaderProperty(node)) {
      throw new TypeError("production launcher contains a forbidden loader primitive");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (dynamicImportCount !== 1
    || imports.sort().join("\0") !== ["node:crypto", "node:fs"].sort().join("\0")) {
    throw new TypeError("production launcher import denominator is invalid");
  }
}

export function loadProductionLauncherArtifactV1(repositoryRootValue: string): ProductionLauncherArtifactV1 {
  const repositoryRoot = realpathSync(resolve(repositoryRootValue));
  const path = join(repositoryRoot, PRODUCTION_LAUNCHER_ENTRY_V1);
  if (realpathSync(path) !== path || !lstatSync(path).isFile()) {
    throw new TypeError("production launcher source is not a canonical regular file");
  }
  const bytes = new Uint8Array(readFileSync(path));
  assertProductionLauncherArtifactV1(bytes);
  return Object.freeze({ bytes, sha256: sha256Hex(bytes) });
}

/** Parse exact emitted JavaScript and reject every filesystem/package import. */
export function assertSelfContainedRuntimeBundleV1(bytesValue: Uint8Array): void {
  const bytes = new Uint8Array(bytesValue);
  let sourceText: string;
  try {
    sourceText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("production runtime bundle is not UTF-8 JavaScript");
  }
  if (sourceText.includes("node_modules")
    || sourceText.includes("file://")) {
    throw new TypeError("production runtime bundle references a checkout or node_modules");
  }
  const source = ts.createSourceFile(OUTPUT_FILE_V1, sourceText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const parseDiagnostics = (source as ts.SourceFile & {
    readonly parseDiagnostics?: readonly ts.Diagnostic[];
  }).parseDiagnostics ?? [];
  if (parseDiagnostics.length !== 0) throw new TypeError("production runtime bundle is not valid JavaScript");
  assertNoUnexpectedProductionOptPath(source, "production runtime bundle");
  let dynamicImportCount = 0;
  const exportedNames: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      moduleSpecifier(node.moduleSpecifier, source, "production runtime import");
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) {
        moduleSpecifier(node.moduleSpecifier, source, "production runtime re-export");
      } else if (node.exportClause === undefined || !ts.isNamedExports(node.exportClause)) {
        throw new TypeError("production runtime bundle has a non-exact export declaration");
      } else {
        exportedNames.push(...node.exportClause.elements.map(element => element.name.text));
      }
    } else if (ts.isExportAssignment(node)) {
      throw new TypeError("production runtime bundle has an export assignment");
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      dynamicImportCount += 1;
      assertExactDataUrlDynamicImport(node.arguments[0]);
    } else if (ts.isMetaProperty(node)) {
      throw new TypeError("production runtime bundle must not depend on import.meta");
    } else if (ts.isIdentifier(node)
      && ["createRequire", "eval", "Function", "Worker", "WebAssembly"].includes(node.text)) {
      throw new TypeError(`production runtime bundle contains a forbidden loader primitive: ${node.text}`);
    } else if (ts.isIdentifier(node) && /^(?:__)?require[0-9]*$/.test(node.text) && !isMemberName(node)) {
      throw new TypeError("production runtime bundle contains a require loader");
    } else if (isLoaderProperty(node)) {
      throw new TypeError("production runtime bundle contains a dynamic module registration primitive");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (dynamicImportCount !== 1) {
    throw new TypeError("production runtime bundle must contain one exact snapshot data URL import");
  }
  if (exportedNames.sort().join("\0") !== [
    "issueInstalledProductionStartupCapabilityV1",
    "issuePreReleaseStartupCapabilityV1",
    "startReleaseRuntimeSessionV1",
  ].sort().join("\0")) {
    throw new TypeError("production runtime bundle has a non-exact export surface");
  }
}

/** The qualified runner is an exact-commit, builtins-only closure with no secondary loader. */
export function assertSelfContainedQualifiedReleaseRunnerBundleV1(bytesValue: Uint8Array): void {
  const bytes = new Uint8Array(bytesValue);
  let sourceText: string;
  try {
    sourceText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("qualified release runner bundle is not UTF-8 JavaScript");
  }
  if (sourceText.includes("/opt/aloha") || sourceText.includes("node_modules")
    || sourceText.includes("file://")) {
    throw new TypeError("qualified release runner bundle references a checkout or node_modules");
  }
  const source = ts.createSourceFile(
    QUALIFIED_RELEASE_RUNNER_OUTPUT_FILE_V1,
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  const parseDiagnostics = (source as ts.SourceFile & {
    readonly parseDiagnostics?: readonly ts.Diagnostic[];
  }).parseDiagnostics ?? [];
  if (parseDiagnostics.length !== 0) {
    throw new TypeError("qualified release runner bundle is not valid JavaScript");
  }
  const exportedNames: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = moduleSpecifier(node.moduleSpecifier, source, "qualified release runner import");
      if (!QUALIFIED_RELEASE_RUNNER_BUILTINS.has(specifier)) {
        throw new TypeError(`qualified release runner imports an unapproved builtin: ${specifier}`);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) {
        const specifier = moduleSpecifier(node.moduleSpecifier, source, "qualified release runner re-export");
        if (!QUALIFIED_RELEASE_RUNNER_BUILTINS.has(specifier)) {
          throw new TypeError(`qualified release runner re-exports an unapproved builtin: ${specifier}`);
        }
      } else if (node.exportClause === undefined || !ts.isNamedExports(node.exportClause)) {
        throw new TypeError("qualified release runner bundle has a non-exact export declaration");
      } else {
        exportedNames.push(...node.exportClause.elements.map(element => element.name.text));
      }
    } else if (ts.isExportAssignment(node)) {
      throw new TypeError("qualified release runner bundle has an export assignment");
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new TypeError("qualified release runner bundle contains a dynamic import");
    } else if (ts.isMetaProperty(node)) {
      throw new TypeError("qualified release runner bundle must not depend on import.meta");
    } else if (ts.isIdentifier(node)
      && ["createRequire", "eval", "Function", "Worker", "WebAssembly"].includes(node.text)) {
      throw new TypeError(`qualified release runner bundle contains a forbidden loader primitive: ${node.text}`);
    } else if (ts.isIdentifier(node) && /^(?:__)?require[0-9]*$/.test(node.text) && !isMemberName(node)) {
      throw new TypeError("qualified release runner bundle contains a require loader");
    } else if (isLoaderProperty(node)) {
      throw new TypeError("qualified release runner bundle contains a dynamic module registration primitive");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (exportedNames.join("\0") !== "createFreshQualifiedReleaseRunnerRuntimeV1") {
    throw new TypeError("qualified release runner bundle has a non-exact export surface");
  }
}

/** Deterministically build the one production runtime closure from tracked source. */
export function buildProductionRuntimeBundleV1(repositoryRootValue: string): BuiltProductionRuntimeBundleV1 {
  const repositoryRoot = realpathSync(resolve(repositoryRootValue));
  const result = buildSync({
    absWorkingDir: repositoryRoot,
    entryPoints: [PRODUCTION_RUNTIME_ENTRY_V1],
    outfile: OUTPUT_FILE_V1,
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    external: ["node:*"],
    legalComments: "none",
    charset: "utf8",
    treeShaking: true,
    sourcemap: false,
    logLevel: "silent",
  });
  if (result.outputFiles.length !== 1 || result.metafile === undefined) {
    throw new TypeError("production runtime builder did not emit one exact bundle");
  }
  assertMetafile(
    result.metafile,
    repositoryRoot,
    FORBIDDEN_PRODUCTION_BUILD_GRAPH_SEGMENTS,
    "production runtime",
    [
      "acceptance/collectors/",
      // The collector writes the frozen terminal-selection wire contract; no
      // predicate, oracle, qualification, or GateCore module enters runtime.
      "acceptance/terminal-selection-facts/src/schema.ts",
    ],
  );
  const bytes = new Uint8Array(result.outputFiles[0]!.contents);
  if (new TextDecoder().decode(bytes).includes(repositoryRoot)) {
    throw new TypeError("production runtime bundle leaks its worktree path");
  }
  assertSelfContainedRuntimeBundleV1(bytes);
  return Object.freeze({ bytes, sha256: sha256Hex(bytes), metafile: result.metafile });
}

/** Deterministically build the qualified runner closure from one source snapshot. */
export function buildQualifiedReleaseRunnerBundleV1(
  repositoryRootValue: string,
): BuiltQualifiedReleaseRunnerBundleV1 {
  const repositoryRoot = realpathSync(resolve(repositoryRootValue));
  const result = buildSync({
    absWorkingDir: repositoryRoot,
    entryPoints: [QUALIFIED_RELEASE_RUNNER_ENTRY_V1],
    outfile: QUALIFIED_RELEASE_RUNNER_OUTPUT_FILE_V1,
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    external: ["node:*"],
    legalComments: "none",
    charset: "utf8",
    treeShaking: true,
    sourcemap: false,
    logLevel: "silent",
  });
  if (result.outputFiles.length !== 1 || result.metafile === undefined) {
    throw new TypeError("qualified release runner builder did not emit one exact bundle");
  }
  assertMetafile(
    result.metafile,
    repositoryRoot,
    ["node_modules", "tools/architecture-boundaries/", "tools/runtime-release-packager/src/internal/runtime-bundle-builder.ts"],
    "qualified release runner",
  );
  const bytes = new Uint8Array(result.outputFiles[0]!.contents);
  if (new TextDecoder().decode(bytes).includes(repositoryRoot)) {
    throw new TypeError("qualified release runner bundle leaks its worktree path");
  }
  assertSelfContainedQualifiedReleaseRunnerBundleV1(bytes);
  return Object.freeze({ bytes, sha256: sha256Hex(bytes) });
}
