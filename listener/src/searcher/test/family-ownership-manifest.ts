import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import "../../adapters/index.js";
import { listAll } from "../../adapters/registry.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";

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
const LISTENER_ROOT = resolve(HERE, "../../..");
const TSCONFIG = resolve(LISTENER_ROOT, "tsconfig.json");
const PRODUCTION_REGISTRY = resolve(
  LISTENER_ROOT,
  "src/searcher/venues/production-registry.ts",
);
const ACTION_INDEX = resolve(LISTENER_ROOT, "src/adapters/index.ts");

export function createFamilyOwnershipManifest(): FamilyOwnershipManifest {
  const { program, checker } = loadProgram();
  const runtimeFamilies = PRODUCTION_ADAPTER_FAMILIES.list();
  const roots = productionFamilyRoots(
    program,
    checker,
    runtimeFamilies.map((family) => family.id),
  );
  if (roots.length !== runtimeFamilies.length) {
    throw new Error(
      "family ownership registry AST/runtime cardinality mismatch",
    );
  }
  const runtimeById = new Map<string, (typeof runtimeFamilies)[number]>(
    runtimeFamilies.map((family) => [
      family.id,
      family,
    ]),
  );
  const actionSources = activeActionSources(program, checker);
  const registeredActionIds = listAll().map((adapter) => adapter.id).sort();
  const derivedActionIds = [...actionSources.keys()].sort();
  if (canonicalJson(registeredActionIds) !== canonicalJson(derivedActionIds)) {
    throw new Error(
      "family ownership action catalog AST/runtime registration mismatch",
    );
  }
  const families = roots.map((root) => {
    const family = runtimeById.get(root.id);
    if (!family) {
      throw new Error(
        `family ownership root ${root.binding} has unregistered id ${root.id}`,
      );
    }
    const poolAdapterIds = "poolAdapters" in family
      ? [...family.poolAdapters].sort()
      : [];
    const edgeAdapterIds = "edgeAdapterIds" in family
      ? [...family.edgeAdapterIds].sort()
      : [];
    const files = relativeFamilyImportClosure(program, root.path);
    const actionBindings = [...family.ownedActionAdapterIds]
      .sort()
      .map((actionId) => {
        const source = actionSources.get(actionId);
        if (!source) {
          throw new Error(
            `family ownership cannot resolve active ActionAdapter ${actionId}`,
          );
        }
        for (const actionPath of source.paths) {
          for (const imported of relativeActionImportClosure(program, actionPath)) {
            files.add(imported);
          }
        }
        return { id: actionId, binding: source.binding };
      });
    const requiredActionBindings = [...family.requiredInfraActionAdapterIds]
      .sort()
      .map((actionId) => {
        const source = actionSources.get(actionId);
        if (!source) {
          throw new Error(
            `family ownership cannot resolve required ActionAdapter ${actionId}`,
          );
        }
        for (const actionPath of source.paths) {
          for (const imported of relativeActionImportClosure(program, actionPath)) {
            files.add(imported);
          }
        }
        return { id: actionId, binding: source.binding };
      });
    const candidateSourceIds =
      "discovery" in family && family.discovery
        ? [...family.discovery.candidateSources].sort()
        : [];
    return {
      id: family.id,
      kind: family.kind,
      root_source: repoRelative(root.path),
      root_export: root.imported,
      source_files: [...files].map(repoRelative).sort(),
      pool_adapter_ids: poolAdapterIds,
      edge_adapter_ids: edgeAdapterIds,
      owned_action_adapter_ids: [...family.ownedActionAdapterIds].sort(),
      owned_action_bindings: actionBindings,
      required_action_adapter_ids:
        [...family.requiredInfraActionAdapterIds].sort(),
      required_action_bindings: requiredActionBindings,
      candidate_source_ids: candidateSourceIds,
      requires_current_head_execution_evidence:
        "pendingTransactionEvidence" in family &&
        family.pendingTransactionEvidence?.routeActivation ===
          "current-head-block-scan",
      activation_sha256: sha256(canonicalJson({
        id: family.id,
        kind: family.kind,
        root_source: repoRelative(root.path),
        root_export: root.imported,
        pool_adapter_ids: poolAdapterIds,
        edge_adapter_ids: edgeAdapterIds,
        owned_action_bindings: actionBindings,
        owned_action_adapter_ids: [...family.ownedActionAdapterIds].sort(),
        required_action_bindings: requiredActionBindings,
        required_infra_action_adapter_ids:
          [...family.requiredInfraActionAdapterIds].sort(),
        candidate_source_ids: candidateSourceIds,
        requires_current_head_execution_evidence:
          "pendingTransactionEvidence" in family &&
          family.pendingTransactionEvidence?.routeActivation ===
            "current-head-block-scan",
        ...("funding" in family
          ? {
              funding_action_adapter_id: family.funding.actionAdapterId,
              funding_lineage: family.funding.lineage,
            }
          : {}),
      })),
    };
  });
  return {
    schema_version: 1,
    registry_order: roots.map((root) => root.id),
    action_catalog_ids: listAll().map((adapter) => adapter.id),
    registry_skeleton_sha256: familyOwnershipSourceSkeletonSha256(
      "production-registry",
      sourceFile(program, PRODUCTION_REGISTRY).getFullText(),
    ),
    action_index_skeleton_sha256: familyOwnershipSourceSkeletonSha256(
      "action-index",
      sourceFile(program, ACTION_INDEX).getFullText(),
    ),
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
  checker: ts.TypeChecker,
  runtimeIds: readonly string[],
): readonly FamilyRoot[] {
  const registry = sourceFile(program, PRODUCTION_REGISTRY);
  const imports = directNamedImports(registry);
  const declaration = findVariable(registry, "PRODUCTION_ADAPTER_FAMILIES");
  const registered = declaration?.initializer &&
      ts.isNewExpression(declaration.initializer) &&
      declaration.initializer.arguments?.[0] &&
      ts.isArrayLiteralExpression(declaration.initializer.arguments[0])
    ? declaration.initializer.arguments[0]
    : null;
  if (!registered) {
    throw new Error("family ownership cannot derive production registry");
  }
  return registered.elements.map((element, index) => {
    if (!ts.isIdentifier(element)) {
      throw new Error(
        `family registration must be a direct binding: ${element.getText(registry)}`,
      );
    }
    const imported = imports.get(element.text);
    if (!imported) {
      throw new Error(`family registration ${element.text} is not imported`);
    }
    const id = readObjectId(
      sourceFile(program, imported.path),
      imported.imported,
      checker,
    );
    if (id === null || id !== runtimeIds[index]) {
      throw new Error(
        `family registration ${element.text} disagrees with runtime order`,
      );
    }
    return {
      binding: element.text,
      imported: imported.imported,
      id,
      path: imported.path,
    };
  });
}

function activeActionSources(
  program: ts.Program,
  checker: ts.TypeChecker,
): ReadonlyMap<string, ActiveActionSource> {
  const index = sourceFile(program, ACTION_INDEX);
  const imports = directNamedImports(index);
  const declaration = findVariable(index, "PRODUCTION_ACTION_CATALOG");
  const catalog = declaration?.initializer
    ? firstArrayLiteral(declaration.initializer)
    : null;
  if (!catalog) throw new Error("family ownership cannot derive action catalog");
  const sources = new Map<string, ActiveActionSource>();
  const bind = (id: string, source: ActiveActionSource): void => {
    const prior = sources.get(id);
    if (prior && canonicalJson(prior) !== canonicalJson(source)) {
      throw new Error(`ActionAdapter ${id} has multiple active sources`);
    }
    sources.set(id, source);
  };
  for (const element of catalog.elements) {
    if (ts.isIdentifier(element)) {
      const imported = imports.get(element.text);
      if (!imported) {
        throw new Error(
          `active ActionAdapter ${element.text} is not a direct import`,
        );
      }
      const id = readObjectId(
        sourceFile(program, imported.path),
        imported.imported,
        checker,
      );
      if (!id) {
        throw new Error(
          `active ActionAdapter ${element.text} has no static id`,
        );
      }
      bind(id, {
        paths: [imported.path],
        binding: `${repoRelative(imported.path)}#${imported.imported}`,
      });
      continue;
    }
    if (ts.isSpreadElement(element)) {
      const spread = resolveMappedActionSpread(element.expression, imports);
      if (!spread) {
        throw new Error(
          `family ownership cannot resolve action catalog spread ${element.getText(index)}`,
        );
      }
      const descriptorIds = staticArrayObjectPropertyValues(
        sourceFile(program, spread.descriptor.path),
        spread.descriptor.imported,
        "id",
        checker,
      );
      if (descriptorIds.length === 0) {
        throw new Error(
          `action descriptor ${spread.descriptor.imported} has no static ids`,
        );
      }
      const binding = `${repoRelative(spread.descriptor.path)}#` +
        `${spread.descriptor.imported}.map(` +
        `${repoRelative(spread.factory.path)}#${spread.factory.imported})`;
      for (const id of descriptorIds) {
        bind(id, {
          paths: [...new Set([
            spread.descriptor.path,
            spread.factory.path,
          ])].sort(),
          binding,
        });
      }
      continue;
    }
    throw new Error(
      `family ownership cannot resolve action catalog entry ${element.getText(index)}`,
    );
  }
  return sources;
}

function resolveMappedActionSpread(
  expression: ts.Expression,
  imports: ReadonlyMap<
    string,
    { readonly imported: string; readonly path: string }
  >,
): {
  readonly descriptor: { readonly imported: string; readonly path: string };
  readonly factory: { readonly imported: string; readonly path: string };
} | null {
  if (
    !ts.isCallExpression(expression) ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    expression.expression.name.text !== "map" ||
    !ts.isIdentifier(expression.expression.expression) ||
    expression.arguments.length !== 1 ||
    !ts.isIdentifier(expression.arguments[0])
  ) {
    return null;
  }
  const descriptor = imports.get(expression.expression.expression.text);
  const factory = imports.get(expression.arguments[0].text);
  return descriptor && factory ? { descriptor, factory } : null;
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
      if (resolved && isFamilyModule(resolved) && !closure.has(resolved)) {
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

function registryAllowedRanges(source: ts.SourceFile): readonly ts.TextRange[] {
  const ranges: ts.TextRange[] = [];
  const declaration = findVariable(source, "PRODUCTION_ADAPTER_FAMILIES");
  const registered = declaration?.initializer &&
      ts.isNewExpression(declaration.initializer) &&
      declaration.initializer.arguments?.[0] &&
      ts.isArrayLiteralExpression(declaration.initializer.arguments[0])
    ? declaration.initializer.arguments[0]
    : null;
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

function readObjectId(
  source: ts.SourceFile,
  binding: string,
  checker: ts.TypeChecker,
): string | null {
  let result: string | null = null;
  const visit = (node: ts.Node): void => {
    if (
      result === null &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === binding &&
      node.initializer
    ) {
      const object = unwrapObjectLiteral(node.initializer);
      if (!object) return;
      for (const property of object.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          propertyName(property.name) === "id"
        ) {
          result = staticString(property.initializer, checker);
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function staticArrayObjectPropertyValues(
  source: ts.SourceFile,
  binding: string,
  name: string,
  checker: ts.TypeChecker,
): string[] {
  const values = new Set<string>();
  const declaration = findVariable(source, binding);
  const array = declaration?.initializer
    ? firstArrayLiteral(declaration.initializer)
    : null;
  if (!array) return [];
  for (const element of array.elements) {
    const object = unwrapObjectLiteral(element);
    if (!object) continue;
    for (const property of object.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        propertyName(property.name) === name
      ) {
        const value = staticString(property.initializer, checker);
        if (value !== null) values.add(value);
      }
    }
  }
  return [...values].sort();
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

function staticString(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): string | null {
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
    ts.isStringLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current)
  ) {
    return current.text;
  }
  if (ts.isCallExpression(current) && current.arguments.length === 1) {
    const argument = identityValidatorArgument(current, checker);
    if (argument) return staticString(argument, checker, seen);
  }
  if (!ts.isIdentifier(current) && !ts.isPropertyAccessExpression(current)) {
    return null;
  }
  let symbol = checker.getSymbolAtLocation(
    ts.isPropertyAccessExpression(current) ? current.name : current,
  );
  if (!symbol) return null;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  if (seen.has(symbol)) return null;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const value = staticString(declaration.initializer, checker, seen);
      if (value !== null) return value;
    }
    if (ts.isPropertyAssignment(declaration)) {
      const value = staticString(declaration.initializer, checker, seen);
      if (value !== null) return value;
    }
  }
  return null;
}

function identityValidatorArgument(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.Expression | null {
  const callee = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name
    : call.expression;
  let symbol = checker.getSymbolAtLocation(callee);
  if (!symbol) return null;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (
      !ts.isFunctionDeclaration(declaration) ||
      declaration.parameters.length !== 1 ||
      !declaration.body ||
      !ts.isIdentifier(declaration.parameters[0].name)
    ) {
      continue;
    }
    const parameter = declaration.parameters[0].name.text;
    let returnsParameter = false;
    const visit = (node: ts.Node): void => {
      if (!ts.isReturnStatement(node) || !node.expression) {
        ts.forEachChild(node, visit);
        return;
      }
      let returned = node.expression;
      while (
        ts.isParenthesizedExpression(returned) ||
        ts.isAsExpression(returned) ||
        ts.isSatisfiesExpression(returned) ||
        ts.isTypeAssertionExpression(returned)
      ) {
        returned = returned.expression;
      }
      if (ts.isIdentifier(returned) && returned.text === parameter) {
        returnsParameter = true;
      }
    };
    visit(declaration.body);
    if (returnsParameter) return call.arguments[0];
  }
  return null;
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
}

function main(): void {
  const args = process.argv.slice(2);
  const outputPath = args[0] === "--out" && args.length === 2
    ? resolve(args[1])
    : null;
  if (
    !outputPath &&
    (args.length > 1 || (args.length === 1 && args[0] !== "--json"))
  ) {
    throw new Error(
      "usage: family-ownership-manifest.ts [--json | --out <new-file>]",
    );
  }
  runOwnershipManifestSelfTests();
  const manifest = createFamilyOwnershipManifest();
  if (outputPath) {
    writeFileSync(outputPath, `${JSON.stringify(manifest)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    // Candidate imports cannot race a later event-loop turn to replace the
    // exclusive manifest artifact after the trusted writer succeeds.
    process.exit(0);
  }
  console.log(`ADAPTER_FAMILY_OWNERSHIP_MANIFEST=${JSON.stringify(manifest)}`);
  if (args.length === 0) {
    console.log(
      `adapter-family-ownership-manifest PASS (${manifest.families.length} families)`,
    );
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
