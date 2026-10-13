import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";
import type { ActionAdapter } from "../../types.js";
import type { LoadedDefinedFamilyPluginModule } from
  "../venues/production-families/loader.js";

export interface FamilyOwnedActionBinding {
  readonly id: string;
  readonly binding: string;
}

export interface FamilyOwnershipManifestEntry {
  readonly id: string;
  readonly kind: string;
  readonly root_source: string;
  readonly root_export: string;
  readonly source_files: readonly string[];
  readonly pool_adapter_ids: readonly string[];
  readonly edge_adapter_ids: readonly string[];
  readonly owned_action_adapter_ids: readonly string[];
  readonly owned_action_bindings: readonly FamilyOwnedActionBinding[];
  readonly required_action_adapter_ids: readonly string[];
  readonly required_action_bindings: readonly FamilyOwnedActionBinding[];
  readonly candidate_source_ids: readonly string[];
  /** Route is excluded from ordinary block-scan until same-head evidence exists. */
  readonly requires_current_head_execution_evidence: boolean;
  readonly activation_sha256: string;
}

export interface FamilyOwnershipManifest {
  readonly schema_version: 1;
  readonly registry_order: readonly string[];
  readonly action_catalog_ids: readonly string[];
  readonly registry_skeleton_sha256: string;
  readonly action_index_skeleton_sha256: string;
  readonly families: readonly FamilyOwnershipManifestEntry[];
}

export type FamilyOwnershipSourceKind =
  | "production-registry"
  | "action-index";

interface FamilyRoot {
  readonly binding: string;
  readonly imported: string;
  readonly id: string;
  readonly path: string;
}

interface ActiveActionSource {
  readonly paths: readonly string[];
  readonly binding: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const IS_MAIN = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const OPTIONS: { readonly json?: boolean; readonly sourceRoot?: string } = IS_MAIN ? parseManifestArguments(process.argv.slice(2)) : {};
const LISTENER_ROOT = OPTIONS.sourceRoot
  ? resolve(OPTIONS.sourceRoot, "listener") : resolve(HERE, "../../..");
const TSCONFIG = resolve(LISTENER_ROOT, "tsconfig.json");
const PRODUCTION_REGISTRY = resolve(
  LISTENER_ROOT,
  "src/searcher/venues/production-registry.ts",
);
const ACTION_INDEX = resolve(LISTENER_ROOT, "src/adapters/index.ts");

const PRODUCTION_ENTRIES = resolve(
  LISTENER_ROOT, "src/searcher/generated/production-family-entries.generated.ts",
);
const PRODUCTION_COMPOSITION = resolve(
  LISTENER_ROOT, "src/searcher/venues/production-family-composition.ts",
);
const INFRA_ACTIONS = resolve(
  LISTENER_ROOT, "src/searcher/venues/production-infra-actions.ts",
);

/** The worker loads each source tree's real composition, including disabled definitions. */
export async function createFamilyOwnershipManifest(): Promise<FamilyOwnershipManifest> {
  const { program } = loadProgram();
  const composition = await import(pathToFileURL(PRODUCTION_COMPOSITION).href) as
    typeof import("../venues/production-family-composition.js");
  const infra = await import(pathToFileURL(INFRA_ACTIONS).href) as
    typeof import("../venues/production-infra-actions.js");
  const load = composition.PRODUCTION_STRICT_SHADOW_FAMILY_LOAD;
  if (load.issues.length !== 0 || load.modules.length !== 0) {
    throw new Error("family ownership requires a complete strict production load");
  }
  const modules = [...load.plugins, ...load.disabledPlugins]
    .sort((left, right) => left.sourceFile.localeCompare(right.sourceFile));
  const roots = productionFamilyRoots(program, modules);
  const byId = new Map(modules.map(module => [module.familyId as string, module]));
  const actionSources = await activeActionSources(
    program, modules, infra.PRODUCTION_INFRA_ACTION_ADAPTERS,
  );
  const actionIds = composition.PRODUCTION_STRICT_SHADOW_ACTION_ADAPTERS.map(action => action.id);
  const declaredActiveIds = [
    ...load.plugins.flatMap(module => module.actionAdapters.map(action => action.id)),
    ...infra.PRODUCTION_INFRA_ACTION_ADAPTERS.map(action => action.id),
  ];
  if (canonicalJson(actionIds) !== canonicalJson(declaredActiveIds)) {
    throw new Error("family ownership active action catalog/composition mismatch");
  }
  const families = roots.map(root => {
    const module = byId.get(root.id)!;
    const plugin = module.plugin;
    const manifest = plugin.manifest;
    const files = relativeFamilyImportClosure(program, root.path);
    const bindings = (ids: readonly string[]): FamilyOwnedActionBinding[] =>
      [...ids].sort().map(id => {
        const source = actionSources.get(id);
        if (!source) throw new Error("family ownership cannot resolve ActionAdapter " + id);
        for (const path of source.paths) {
          for (const imported of relativeActionImportClosure(program, path)) files.add(imported);
        }
        return { id, binding: source.binding };
      });
    const ownedBindings = bindings(manifest.ownedActionAdapterIds);
    const requiredBindings = bindings(manifest.requiredInfraActionAdapterIds);
    const candidateSources = [...(plugin.discovery.candidateSources ?? [])].sort();
    return {
      id: root.id,
      kind: manifest.domain,
      root_source: repoRelative(root.path),
      root_export: root.imported,
      source_files: [...files].map(repoRelative).sort(),
      pool_adapter_ids: [...(manifest.poolAdapterIds ?? [])].sort(),
      edge_adapter_ids: [...(manifest.edgeAdapterIds ?? [])].sort(),
      owned_action_adapter_ids: [...manifest.ownedActionAdapterIds].sort(),
      owned_action_bindings: ownedBindings,
      required_action_adapter_ids: [...manifest.requiredInfraActionAdapterIds].sort(),
      required_action_bindings: requiredBindings,
      candidate_source_ids: candidateSources,
      // The strict definition has no legacy pendingTransactionEvidence surface.
      requires_current_head_execution_evidence: false,
      activation_sha256: sha256(canonicalJson({
        manifest,
        activation: module.activation,
        definitionBoundaryHash: module.definitionBoundaryHash,
        rootSource: repoRelative(root.path),
        rootExport: root.imported,
        ownedBindings,
        requiredBindings,
        candidateSources,
      })),
    };
  });
  return {
    schema_version: 1,
    registry_order: roots.map(root => root.id),
    action_catalog_ids: actionIds,
    // These are complete central source fingerprints, never caller-supplied hashes.
    registry_skeleton_sha256: sha256(canonicalJson([
      sourceFile(program, PRODUCTION_ENTRIES).getFullText(),
      sourceFile(program, PRODUCTION_COMPOSITION).getFullText(),
    ])),
    action_index_skeleton_sha256: sha256(canonicalJson([
      sourceFile(program, ACTION_INDEX).getFullText(),
      sourceFile(program, INFRA_ACTIONS).getFullText(),
    ])),
    families,
  };
}

function loadProgram(): {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
} {
  const config = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
  if (config.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    LISTENER_ROOT,
    undefined,
    TSCONFIG,
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => LISTENER_ROOT,
        getNewLine: () => "\n",
      }),
    );
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return { program, checker: program.getTypeChecker() };
}

function sourceFile(program: ts.Program, path: string): ts.SourceFile {
  const found = program.getSourceFile(path);
  if (!found) throw new Error(`family ownership source missing: ${path}`);
  return found;
}

function productionFamilyRoots(
  program: ts.Program,
  modules: readonly LoadedDefinedFamilyPluginModule[],
): readonly FamilyRoot[] {
  const source = sourceFile(program, PRODUCTION_ENTRIES);
  const imports = new Map<string, string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.importClause?.namedBindings &&
        ts.isNamespaceImport(statement.importClause.namedBindings)) {
      const path = resolveTsImport(source.fileName, statement.moduleSpecifier.text);
      if (path) imports.set(statement.importClause.namedBindings.name.text, path);
    }
  }
  const declaration = findVariable(source, "GENERATED_PRODUCTION_FAMILY_ENTRIES");
  const array = declaration?.initializer ? firstArrayLiteral(declaration.initializer) : null;
  if (!array) throw new Error("family ownership cannot derive generated production entries");
  const bySource = new Map(modules.map(module => [module.sourceFile, module]));
  const roots = array.elements.map(element => {
    const object = unwrapObjectLiteral(element);
    const fields = new Map(object?.properties.filter(ts.isPropertyAssignment)
      .map(property => [propertyName(property.name), property.initializer]));
    const file = fields.get("sourceFile");
    const binding = fields.get("module");
    if (!file || !ts.isStringLiteral(file) || !binding || !ts.isIdentifier(binding) ||
        !/^[a-z0-9][a-z0-9-]*\.production\.ts$/.test(file.text)) {
      throw new Error("family ownership requires static generated entry bindings");
    }
    const path = imports.get(binding.text);
    const module = bySource.get(file.text);
    if (!module || path !== resolve(LISTENER_ROOT, "src/searcher/venues/production-families", file.text)) {
      throw new Error("family ownership generated entry/installed source mismatch: " + file.text);
    }
    return { binding: binding.text, imported: "plugin", id: module.familyId as string, path };
  });
  if (canonicalJson(roots.map(root => root.id)) !==
      canonicalJson(modules.map(module => module.familyId))) {
    throw new Error("family ownership generated/runtime order or cardinality mismatch");
  }
  return roots;
}

async function activeActionSources(
  program: ts.Program,
  modules: readonly LoadedDefinedFamilyPluginModule[],
  infrastructure: readonly ActionAdapter[],
): Promise<ReadonlyMap<string, ActiveActionSource>> {
  const source = sourceFile(program, INFRA_ACTIONS);
  const imports = directNamedImports(source);
  const declaration = findVariable(source, "PRODUCTION_INFRA_ACTION_ADAPTERS");
  const array = declaration?.initializer ? firstArrayLiteral(declaration.initializer) : null;
  if (!array) throw new Error("family ownership cannot derive infrastructure actions");
  const sources = new Map<string, ActiveActionSource>();
  const runtimeById = new Map(infrastructure.map(action => [action.id, action]));
  const bind = (id: string, entry: ActiveActionSource): void => {
    if (sources.has(id)) throw new Error("ActionAdapter has multiple active sources: " + id);
    sources.set(id, entry);
  };
  for (const element of array.elements) {
    const imported = ts.isIdentifier(element) ? imports.get(element.text) : undefined;
    if (!imported) throw new Error("infrastructure action is not a direct named import");
    const importedModule = await import(pathToFileURL(imported.path).href);
    const action = importedModule[imported.imported] as ActionAdapter | undefined;
    if (!action || runtimeById.get(action.id) !== action) {
      throw new Error("family ownership infrastructure AST/runtime binding mismatch");
    }
    bind(action.id, {
      paths: [imported.path],
      binding: repoRelative(imported.path) + "#" + imported.imported,
    });
  }
  if (canonicalJson([...sources.keys()]) !== canonicalJson(infrastructure.map(action => action.id))) {
    throw new Error("family ownership infrastructure AST/runtime order mismatch");
  }
  for (const module of modules) {
    const entryPath = resolve(
      LISTENER_ROOT, "src/searcher/venues/production-families", module.sourceFile,
    );
    for (const action of module.actionAdapters) {
      bind(action.id, {
        paths: [entryPath],
        binding: repoRelative(entryPath) + "#plugin.actionAdapters[" + action.id + "]",
      });
    }
  }
  return sources;
}

function directNamedImports(
  source: ts.SourceFile,
): ReadonlyMap<string, { readonly imported: string; readonly path: string }> {
  const imports = new Map<
    string,
    { readonly imported: string; readonly path: string }
  >();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    const path = resolveTsImport(source.fileName, statement.moduleSpecifier.text);
    if (!path) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      imports.set(element.name.text, {
        imported: element.propertyName?.text ?? element.name.text,
        path,
      });
    }
  }
  return imports;
}

function relativeFamilyImportClosure(
  program: ts.Program,
  root: string,
): Set<string> {
  const closure = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (closure.has(path)) continue;
    closure.add(path);
    const source = sourceFile(program, path);
    for (const statement of source.statements) {
      const specifier = ts.isImportDeclaration(statement)
        ? statement.moduleSpecifier
        : ts.isExportDeclaration(statement)
          ? statement.moduleSpecifier
          : undefined;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      const resolved = resolveTsImport(source.fileName, specifier.text);
      if (resolved) assertFamilyRuntimeImportBoundary(source.fileName, resolved);
      if (resolved && (isFamilyModule(resolved) ||
          repoRelative(resolved).startsWith("src/adapters/")) && !closure.has(resolved)) {
        pending.push(resolved);
      }
    }
  }
  return closure;
}

function relativeActionImportClosure(
  program: ts.Program,
  root: string,
): Set<string> {
  const closure = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (closure.has(path)) continue;
    closure.add(path);
    const source = sourceFile(program, path);
    for (const statement of source.statements) {
      const specifier = ts.isImportDeclaration(statement)
        ? statement.moduleSpecifier
        : ts.isExportDeclaration(statement)
          ? statement.moduleSpecifier
          : undefined;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      const resolved = resolveTsImport(source.fileName, specifier.text);
      if (resolved) assertFamilyRuntimeImportBoundary(source.fileName, resolved);
      if (
        resolved &&
        repoRelative(resolved).startsWith("src/adapters/") &&
        !closure.has(resolved)
      ) {
        pending.push(resolved);
      }
    }
  }
  return closure;
}

function assertFamilyRuntimeImportBoundary(
  importer: string,
  imported: string,
): void {
  const importedPath = repoRelative(imported);
  if (
    importedPath.includes("/test/") ||
    [
      "src/searcher/venues/production-registry.ts",
      "src/searcher/venues/production-family-composition.ts",
      "src/searcher/venues/production-families/loader.ts",
      "src/searcher/generated/production-family-entries.generated.ts",
      "src/searcher/generated/family-capability-shadow.generated.json",
      "src/adapters/index.ts",
      "src/adapters/registry.ts",
      "src/shared/adapters/index.ts",
    ].includes(importedPath)
  ) {
    throw new Error(
      `family runtime import boundary: ${repoRelative(importer)} ` +
        `must not import ${importedPath}`,
    );
  }
}

function registryAllowedRanges(source: ts.SourceFile): readonly ts.TextRange[] {
  const ranges: ts.TextRange[] = [];
  const registered = familyRegistrationArray(source);
  if (!registered) throw new Error("family registry array is missing");
  const usedBindings = new Set(
    registered.elements
      .filter(ts.isIdentifier)
      .map((element) => element.text),
  );
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const bindings = statement.importClause?.namedBindings &&
          ts.isNamedImports(statement.importClause.namedBindings)
        ? statement.importClause.namedBindings.elements
        : [];
      if (
        isFamilyImportSpecifier(statement.moduleSpecifier.text) &&
        bindings.length > 0 &&
        bindings.every((binding) => usedBindings.has(binding.name.text))
      ) {
        ranges.push(statement);
      }
    }
  }
  ranges.push(registered);
  return ranges;
}

function familyRegistrationArray(
  source: ts.SourceFile,
): ts.ArrayLiteralExpression | null {
  const legacy = findVariable(source, "LEGACY_PRODUCTION_ADAPTER_FAMILIES");
  if (legacy?.initializer) {
    const found = firstArrayLiteral(legacy.initializer);
    if (found) return found;
  }
  const declaration = findVariable(source, "PRODUCTION_ADAPTER_FAMILIES");
  return declaration?.initializer &&
      ts.isNewExpression(declaration.initializer) &&
      declaration.initializer.arguments?.[0] &&
      ts.isArrayLiteralExpression(declaration.initializer.arguments[0])
    ? declaration.initializer.arguments[0]
    : null;
}

function actionIndexAllowedRanges(source: ts.SourceFile): readonly ts.TextRange[] {
  const ranges: ts.TextRange[] = [];
  const declaration = findVariable(source, "PRODUCTION_ACTION_CATALOG");
  const catalog = declaration?.initializer
    ? firstArrayLiteral(declaration.initializer)
    : null;
  if (!catalog) throw new Error("production action catalog is missing");
  const usedBindings = new Set<string>();
  collectIdentifiers(catalog, usedBindings);
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    if (!isActionImportSpecifier(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
      ? statement.importClause.namedBindings.elements
      : [];
    if (
      bindings.length > 0 &&
      bindings.every((binding) => usedBindings.has(binding.name.text))
    ) {
      ranges.push(statement);
    }
  }
  ranges.push(catalog);
  return ranges;
}

export function familyOwnershipSourceSkeletonSha256(
  kind: FamilyOwnershipSourceKind,
  sourceText: string,
): string {
  const source = ts.createSourceFile(
    kind === "production-registry"
      ? "production-registry.ts"
      : "action-index.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const ranges = kind === "production-registry"
    ? registryAllowedRanges(source)
    : actionIndexAllowedRanges(source);
  return sourceSkeletonSha256(source, ranges);
}

function sourceSkeletonSha256(
  source: ts.SourceFile,
  ranges: readonly ts.TextRange[],
): string {
  let text = source.getFullText();
  for (const range of [...ranges].sort((a, b) => b.pos - a.pos)) {
    text = `${text.slice(0, range.pos)}${text.slice(range.end)}`;
  }
  // Hash the retained bytes exactly. Whitespace and newlines can change
  // TypeScript semantics through comments, ASI, literals and regular
  // expressions; normalizing them would reopen a central-logic bypass.
  return sha256(text);
}

function isFamilyImportSpecifier(specifier: string): boolean {
  const segments = relativeImportSegments(specifier);
  return segments !== null &&
    segments.length >= 2 &&
    [
      "swaps",
      "protocols",
      "credit",
      "funding",
      "liquidity",
    ].includes(segments[0]);
}

function isActionImportSpecifier(specifier: string): boolean {
  return relativeImportSegments(specifier) !== null;
}

function relativeImportSegments(specifier: string): readonly string[] | null {
  if (!specifier.startsWith("./")) return null;
  const segments = specifier.slice(2).split("/");
  return segments.length > 0 &&
      segments.every((segment) =>
        segment.length > 0 && segment !== "." && segment !== ".."
      )
    ? segments
    : null;
}

function findVariable(
  source: ts.SourceFile,
  name: string,
): ts.VariableDeclaration | null {
  let result: ts.VariableDeclaration | null = null;
  const visit = (node: ts.Node): void => {
    if (
      result === null &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      result = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function firstArrayLiteral(node: ts.Node): ts.ArrayLiteralExpression | null {
  if (ts.isArrayLiteralExpression(node)) return node;
  let result: ts.ArrayLiteralExpression | null = null;
  ts.forEachChild(node, (child) => {
    if (result === null) result = firstArrayLiteral(child);
  });
  return result;
}

function collectIdentifiers(node: ts.Node, output: Set<string>): void {
  if (ts.isIdentifier(node)) output.add(node.text);
  ts.forEachChild(node, (child) => collectIdentifiers(child, output));
}

function unwrapObjectLiteral(
  expression: ts.Expression,
): ts.ObjectLiteralExpression | null {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  if (
    ts.isCallExpression(current) &&
    current.arguments[0] &&
    ts.isPropertyAccessExpression(current.expression) &&
    current.expression.expression.getText() === "Object" &&
    current.expression.name.text === "freeze"
  ) {
    return unwrapObjectLiteral(current.arguments[0]);
  }
  return ts.isObjectLiteralExpression(current) ? current : null;
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) ||
      ts.isStringLiteral(name) ||
      ts.isNumericLiteral(name)
    ? name.text
    : null;
}

function resolveTsImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const raw = resolve(dirname(importer), specifier);
  const candidates = [
    raw,
    raw.replace(/\.[cm]?js$/, ".ts"),
    raw.replace(/\.[cm]?js$/, ".tsx"),
    resolve(raw, "index.ts"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function isFamilyModule(path: string): boolean {
  const relativePath = repoRelative(path);
  return [
    "src/searcher/venues/swaps/",
    "src/searcher/venues/protocols/",
    "src/searcher/venues/credit/",
    "src/searcher/venues/funding/",
    "src/searcher/venues/liquidity/",
  ].some((prefix) => relativePath.startsWith(prefix));
}

function repoRelative(path: string): string {
  return relative(LISTENER_ROOT, path).replaceAll("\\", "/");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runOwnershipManifestSelfTests(): void {
  for (const path of [
    "src/searcher/venues/swaps/example-family/test/runtime-shortcut.ts",
    "src/searcher/venues/production-family-composition.ts",
    "src/searcher/venues/production-families/loader.ts",
    "src/searcher/generated/production-family-entries.generated.ts",
    "src/searcher/generated/family-capability-shadow.generated.json",
  ]) {
    assert.throws(() => assertFamilyRuntimeImportBoundary(
      resolve(LISTENER_ROOT, "src/searcher/venues/swaps/example.ts"),
      resolve(LISTENER_ROOT, path),
    ), /family runtime import boundary/, "strict bootstrap cannot become family-owned: " + path);
  }
  assert.throws(() => parseManifestArguments(["--source-root"]), /usage:/);
  assert.throws(() => parseManifestArguments(["--json", "--json"]), /usage:/);
  assert.throws(() => parseManifestArguments(["--source-root", ".", "--source-root", "."]), /usage:/);

  const syntheticSource = (text: string): ts.SourceFile =>
    ts.createSourceFile(
      "synthetic.ts",
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
  const assertDistinctSkeletons = (
    left: string,
    right: string,
    message: string,
  ): void => {
    assert.notEqual(
      sourceSkeletonSha256(syntheticSource(left), []),
      sourceSkeletonSha256(syntheticSource(right), []),
      message,
    );
  };
  const source = (
    imports: readonly string[],
    registrations: readonly string[],
  ): { file: ts.SourceFile; ranges: ts.TextRange[] } => {
    const text = `${imports.map((name) =>
      `import { ${name} } from "./${name}.js";`).join("\n")}\n` +
      `const registry = new Registry([${registrations.join(",")}]);\n` +
      "const centralLogic = true;\n";
    const file = ts.createSourceFile(
      "synthetic.ts",
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const importRanges = file.statements.filter(ts.isImportDeclaration);
    const array = firstArrayLiteral(
      file.statements.find(ts.isVariableStatement)!,
    );
    assert.ok(array);
    return { file, ranges: [...importRanges, array] };
  };
  const baseline = source(["familyA"], ["familyA"]);
  const added = source(["familyA", "familyB"], ["familyA", "familyB"]);
  assert.equal(
    sourceSkeletonSha256(baseline.file, baseline.ranges),
    sourceSkeletonSha256(added.file, added.ranges),
    "thin registration cardinality must not change the central skeleton",
  );
  const registrySource = (families: readonly string[]): string =>
    `${families.map((name) =>
      `import { ${name} } from "./swaps/${name}.js";`).join("\n")}\n` +
    `export const PRODUCTION_ADAPTER_FAMILIES = ` +
    `new Registry([${families.join(",")}]);\n` +
    "const centralLogic = true;\n";
  assert.equal(
    familyOwnershipSourceSkeletonSha256(
      "production-registry",
      registrySource(["familyA"]),
    ),
    familyOwnershipSourceSkeletonSha256(
      "production-registry",
      registrySource(["familyA", "familyB"]),
    ),
    "canonical registry hashing must ignore thin family registration",
  );
  const actionSource = (actions: readonly string[]): string =>
    `${actions.map((name) =>
      `import { ${name} } from "./${name}.js";`).join("\n")}\n` +
    `const PRODUCTION_ACTION_CATALOG = ` +
    `new Map([${actions.join(",")}]);\n` +
    "registerProductionActions();\n";
  assert.equal(
    familyOwnershipSourceSkeletonSha256(
      "action-index",
      actionSource(["actionA"]),
    ),
    familyOwnershipSourceSkeletonSha256(
      "action-index",
      actionSource(["actionA", "actionB"]),
    ),
    "canonical action hashing must ignore thin action registration",
  );
  assert.notEqual(
    familyOwnershipSourceSkeletonSha256(
      "production-registry",
      registrySource(["familyA"]),
    ),
    familyOwnershipSourceSkeletonSha256(
      "production-registry",
      registrySource(["familyA"]).replace(
        "const centralLogic = true",
        "const centralLogic = false",
      ),
    ),
    "canonical registry hashing must retain central logic",
  );
  assertDistinctSkeletons(
    "centralCall(); // trusted boundary\nnextCall();\n",
    "centralCall(); // trusted boundary nextCall();\n",
    "line-comment joins must change the central skeleton",
  );
  assertDistinctSkeletons(
    'const centralValue = "a b";\n',
    'const centralValue = "a  b";\n',
    "whitespace inside string literals must change the central skeleton",
  );
  assertDistinctSkeletons(
    "function centralValue() { return\n{ allowed: true }; }\n",
    "function centralValue() { return { allowed: true }; }\n",
    "ASI-sensitive newlines must change the central skeleton",
  );
  assertDistinctSkeletons(
    "const centralPattern = /a b/;\n",
    "const centralPattern = /a  b/;\n",
    "semantic whitespace must change the central skeleton",
  );
  assert.throws(
    () =>
      assertFamilyRuntimeImportBoundary(
        resolve(LISTENER_ROOT, "src/searcher/venues/swaps/example.ts"),
        resolve(LISTENER_ROOT, "src/searcher/test/example.ts"),
      ),
    /family runtime import boundary/,
    "production family source must not import its tests",
  );
  assert.throws(
    () =>
      assertFamilyRuntimeImportBoundary(
        resolve(LISTENER_ROOT, "src/adapters/example.ts"),
        PRODUCTION_REGISTRY,
      ),
    /family runtime import boundary/,
    "production family source must not import the registry bootstrap",
  );
}

function parseManifestArguments(args: readonly string[]): {
  readonly json?: boolean;
  readonly sourceRoot?: string;
} {
  let json = false;
  let sourceRoot: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json" && !json) json = true;
    else if (arg === "--source-root" && sourceRoot === undefined &&
             args[index + 1] && !args[index + 1].startsWith("--")) {
      sourceRoot = resolve(args[++index]);
    } else {
      throw new Error("usage: family-ownership-manifest.ts [--json] [--source-root <repo>]");
    }
  }
  return { json, sourceRoot };
}

async function main(): Promise<void> {
  runOwnershipManifestSelfTests();
  const manifest = await createFamilyOwnershipManifest();
  console.log("ADAPTER_FAMILY_OWNERSHIP_MANIFEST=" + JSON.stringify(manifest));
  if (!OPTIONS.json) {
    console.log("adapter-family-ownership-manifest PASS (" + manifest.families.length + " families)");
  }
}

if (IS_MAIN) await main();
