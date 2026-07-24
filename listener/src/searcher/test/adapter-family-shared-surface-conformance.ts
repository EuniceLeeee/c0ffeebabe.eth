import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";

type FindingRule =
  | "id-equality"
  | "id-switch"
  | "venue-key-map"
  | "family-direct-import"
  | "legacy-direct-import";

interface Finding {
  readonly rule: FindingRule;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly detail: string;
}

interface FamilySource {
  readonly binding: string;
  readonly familyId: string;
  readonly path: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const LISTENER_ROOT = resolve(HERE, "../../..");
const TSCONFIG = resolve(LISTENER_ROOT, "tsconfig.json");
const PRODUCTION_REGISTRY = resolve(
  LISTENER_ROOT,
  "src/searcher/venues/production-registry.ts",
);

/**
 * Production orchestration and consumers only. Family-owned modules, victim
 * policy and low-level ActionAdapter/compiler code are deliberately outside
 * this surface: protocol semantics belong there.
 */
const SHARED_SURFACE = Object.freeze([
  "src/searcher/main.ts",
  "src/searcher/latest-head-scheduler.ts",
  "src/searcher/blockscan-state-read-backend.ts",
  "src/searcher/blockscan-state-coordinator.ts",
  "src/searcher/detector/pool-impact.ts",
  "src/searcher/detector/blockscan-scanner-core.ts",
  "src/searcher/detector/blockscan-scanner-production.ts",
  "src/searcher/adapter-runtime-coordinator.ts",
  "src/searcher/planner/planner.ts",
  "src/searcher/solver/quoter.ts",
  "src/searcher/solver/solver.ts",
  "src/searcher/solver/plan-builder.ts",
  "src/searcher/live-backends/revm-live-backend.ts",
] as const);

const ID_FIELD_NAMES = new Set([
  "adapterid",
  "edgeadapterid",
  "executionfamilyid",
  "familyid",
  "providerid",
  "fundingproviderid",
  "pooladapter",
  "pooladapterid",
  "matchedadapterid",
  "flashadapterid",
]);

const LEGACY_MODULE_PATTERNS = Object.freeze([
  /(?:^|\/)adapters\/adapter-descriptors(?:\.[cm]?[jt]s)?$/,
  /(?:^|\/)adapters\/flash-providers(?:\.[cm]?[jt]s)?$/,
  /(?:^|\/)venues\/route-adapter-registry(?:\.[cm]?[jt]s)?$/,
]);

const LEGACY_BINDINGS = new Set([
  "ADAPTER_DESCRIPTORS",
  "FLASH_PROVIDER_DESCRIPTORS",
  "LEGACY_PRODUCTION_ROUTE_EDGES",
  "PRODUCTION_ROUTE_ADAPTERS",
]);

function loadProgram(): {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
} {
  const config = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
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
  if (!found) throw new Error(`AST conformance source missing from program: ${path}`);
  return found;
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

function importedBindings(node: ts.ImportDeclaration): readonly string[] {
  const clause = node.importClause;
  if (!clause) return [];
  const bindings: string[] = [];
  if (clause.name) bindings.push(clause.name.text);
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      bindings.push(clause.namedBindings.name.text);
    } else {
      bindings.push(
        ...clause.namedBindings.elements.map(
          (element) => element.propertyName?.text ?? element.name.text,
        ),
      );
    }
  }
  return bindings;
}

function productionFamilySources(
  program: ts.Program,
  checker: ts.TypeChecker,
): readonly FamilySource[] {
  const registry = sourceFile(program, PRODUCTION_REGISTRY);
  const imports = new Map<
    string,
    { readonly imported: string; readonly path: string }
  >();
  for (const statement of registry.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const path = resolveTsImport(registry.fileName, statement.moduleSpecifier.text);
    if (!path || !statement.importClause?.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings)) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      imports.set(element.name.text, {
        imported: element.propertyName?.text ?? element.name.text,
        path,
      });
    }
  }

  let registered: readonly ts.Expression[] | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "PRODUCTION_ADAPTER_FAMILIES" &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      node.initializer.arguments?.[0] &&
      ts.isArrayLiteralExpression(node.initializer.arguments[0])
    ) {
      registered = node.initializer.arguments[0].elements;
    }
    ts.forEachChild(node, visit);
  };
  visit(registry);
  if (!registered) {
    throw new Error("cannot derive production family modules from registry AST");
  }

  const results: FamilySource[] = [];
  for (const expression of registered as readonly ts.Expression[]) {
    if (!ts.isIdentifier(expression)) {
      throw new Error(
        `production family registration must be a directly imported binding: ${expression.getText(registry)}`,
      );
    }
    const imported = imports.get(expression.text);
    if (!imported) {
      throw new Error(`production family ${expression.text} is not a direct import`);
    }
    results.push({
      binding: expression.text,
      familyId: readFamilyId(
        sourceFile(program, imported.path),
        imported.imported,
        checker,
      ) ?? expression.text,
      path: imported.path,
    });
  }
  return results;
}

function readFamilyId(
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

function unwrapObjectLiteral(expression: ts.Expression): ts.ObjectLiteralExpression | null {
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
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  if (
    ts.isComputedPropertyName(name) &&
    (ts.isStringLiteral(name.expression) ||
      ts.isNoSubstitutionTemplateLiteral(name.expression))
  ) {
    return name.expression.text;
  }
  return null;
}

function staticString(
  expression: ts.Expression,
  checker?: ts.TypeChecker,
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
  if (!checker || (!ts.isIdentifier(current) && !ts.isPropertyAccessExpression(current))) {
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
    if (ts.isEnumMember(declaration) && declaration.initializer) {
      const value = staticString(declaration.initializer, checker, seen);
      if (value !== null) return value;
    }
  }
  return null;
}

function expressionFieldName(expression: ts.Expression): string | null {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    if (
      ts.isStringLiteral(current.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(current.argumentExpression)
    ) {
      return current.argumentExpression.text;
    }
  }
  return null;
}

function isPlanActionAdapterId(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  const nameNode = ts.isPropertyAccessExpression(current)
    ? current.name
    : ts.isElementAccessExpression(current)
      ? current.argumentExpression
      : ts.isIdentifier(current)
        ? current
        : null;
  if (!nameNode) return false;
  let symbol = checker.getSymbolAtLocation(nameNode);
  if (!symbol) return false;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return (symbol.declarations ?? []).some((declaration) => {
    const parent = declaration.parent;
    return (
      (ts.isInterfaceDeclaration(parent) || ts.isTypeLiteralNode(parent)) &&
      ts.isInterfaceDeclaration(parent) &&
      (parent.name.text === "PlanNode" || parent.name.text === "ResolvedPlanNode") &&
      declaration.getSourceFile().fileName.endsWith("/src/types.ts")
    );
  });
}

function isIdExpression(
  expression: ts.Expression,
  checker?: ts.TypeChecker,
): boolean {
  const name = expressionFieldName(expression);
  if (!name) return false;
  const normalized = name.replaceAll("_", "").toLowerCase();
  if (checker && isPlanActionAdapterId(expression, checker)) return false;
  if (ID_FIELD_NAMES.has(normalized)) return true;
  if (normalized !== "id") return false;

  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  if (!ts.isPropertyAccessExpression(current)) return false;
  const ownerText = current.expression.getText().toLowerCase();
  if (/(?:family|provider|adapter|venue)/.test(ownerText)) return true;
  if (!checker) return false;
  const type = checker.typeToString(checker.getTypeAtLocation(current.expression));
  return /(?:AdapterFamily|RouteLegAdapter|SwapAdapter|FlashLoan|Provider)/.test(type);
}

function addFinding(
  findings: Finding[],
  source: ts.SourceFile,
  node: ts.Node,
  rule: FindingRule,
  detail: string,
): void {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  findings.push({
    rule,
    file: relative(LISTENER_ROOT, source.fileName),
    line: position.line + 1,
    column: position.character + 1,
    detail,
  });
}

function scanIdBranches(
  source: ts.SourceFile,
  checker: ts.TypeChecker | undefined,
  knownVenueIds: ReadonlySet<string>,
): Finding[] {
  const findings: Finding[] = [];
  const known = new Set([...knownVenueIds].map((id) => id.toLowerCase()));
  const equalityKinds = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ]);

  const inspectStaticMapEntries = (
    node: ts.Node,
    entries: readonly ts.Expression[],
  ): void => {
    for (const entry of entries) {
      const key = ts.isArrayLiteralExpression(entry)
        ? entry.elements[0]
        : entry;
      if (!key || !ts.isExpression(key)) continue;
      const value = staticString(key, checker);
      if (value !== null && known.has(value.toLowerCase())) {
        addFinding(
          findings,
          source,
          key,
          "venue-key-map",
          `static venue key ${JSON.stringify(value)}`,
        );
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      equalityKinds.has(node.operatorToken.kind)
    ) {
      const leftIsId = isIdExpression(node.left, checker);
      const rightIsId = isIdExpression(node.right, checker);
      const leftValue = staticString(node.left, checker);
      const rightValue = staticString(node.right, checker);
      if (
        (leftIsId && rightValue !== null) ||
        (rightIsId && leftValue !== null)
      ) {
        addFinding(
          findings,
          source,
          node,
          "id-equality",
          node.getText(source),
        );
      }
    }

    if (ts.isSwitchStatement(node)) {
      const discriminantIsId = isIdExpression(node.expression, checker);
      for (const clause of node.caseBlock.clauses) {
        if (!ts.isCaseClause(clause)) continue;
        const value = staticString(clause.expression, checker);
        if (
          value !== null &&
          (discriminantIsId || known.has(value.toLowerCase()))
        ) {
          addFinding(
            findings,
            source,
            clause,
            "id-switch",
            `${node.expression.getText(source)} case ${JSON.stringify(value)}`,
          );
        }
      }
    }

    if (ts.isNewExpression(node) && node.arguments?.[0]) {
      const constructor = node.expression.getText(source);
      const entries = node.arguments[0];
      if (
        (constructor === "Map" || constructor === "Set") &&
        ts.isArrayLiteralExpression(entries)
      ) {
        inspectStaticMapEntries(node, entries.elements);
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      if (
        method === "fromEntries" &&
        node.expression.expression.getText(source) === "Object" &&
        node.arguments[0] &&
        ts.isArrayLiteralExpression(node.arguments[0])
      ) {
        inspectStaticMapEntries(node, node.arguments[0].elements);
      }
      if (
        (method === "set" || method === "add") &&
        node.arguments[0]
      ) {
        const value = staticString(node.arguments[0], checker);
        if (value !== null && known.has(value.toLowerCase())) {
          addFinding(
            findings,
            source,
            node.arguments[0],
            "venue-key-map",
            `static venue key ${JSON.stringify(value)}`,
          );
        }
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (
          !ts.isPropertyAssignment(property) &&
          !ts.isMethodDeclaration(property) &&
          !ts.isShorthandPropertyAssignment(property)
        ) {
          continue;
        }
        const key = propertyName(property.name);
        if (key !== null && known.has(key.toLowerCase())) {
          addFinding(
            findings,
            source,
            property.name,
            "venue-key-map",
            `static venue key ${JSON.stringify(key)}`,
          );
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

function scanImports(
  source: ts.SourceFile,
  familySources: ReadonlySet<string>,
): Finding[] {
  const findings: Finding[] = [];
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const resolved = resolveTsImport(source.fileName, specifier);
    if (resolved && familySources.has(resolved)) {
      addFinding(
        findings,
        source,
        statement,
        "family-direct-import",
        `direct family module import ${JSON.stringify(specifier)}`,
      );
    }
    if (
      LEGACY_MODULE_PATTERNS.some((pattern) => pattern.test(specifier)) ||
      importedBindings(statement).some((binding) => LEGACY_BINDINGS.has(binding))
    ) {
      addFinding(
        findings,
        source,
        statement,
        "legacy-direct-import",
        `legacy registry/descriptor import ${JSON.stringify(specifier)}`,
      );
    }
  }
  return findings;
}

function productionVenueIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const family of PRODUCTION_ADAPTER_FAMILIES.list()) {
    ids.add(family.id);
    if ("edgeAdapterIds" in family) {
      for (const id of family.edgeAdapterIds) ids.add(id);
    }
    if ("poolAdapters" in family) {
      for (const id of family.poolAdapters) ids.add(id);
    }
    if (family.kind === "flash-loan") {
      ids.add(family.funding.actionAdapterId);
      ids.add(family.funding.lineage);
    }
  }
  return ids;
}

function formatFindings(findings: readonly Finding[]): string {
  return findings
    .map(
      (finding) =>
        `${finding.file}:${finding.line}:${finding.column} ` +
        `[${finding.rule}] ${finding.detail}`,
    )
    .join("\n");
}

function assertDetectorSelfTest(knownVenueIds: ReadonlySet<string>): void {
  const bad = ts.createSourceFile(
    "synthetic-bad.ts",
    `
      function bad(edge: { adapterId: string }, providerId: string) {
        if (edge.adapterId === "new-unregistered-edge") return;
        switch (providerId) {
          case "new-unregistered-provider": return;
        }
        const venueById = new Map([["univ2-standard", () => 1]]);
        return venueById;
      }
    `,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const badRules = scanIdBranches(bad, undefined, knownVenueIds)
    .map((finding) => finding.rule);
  assert(badRules.includes("id-equality"), "AST detector missed ID equality");
  assert(badRules.includes("id-switch"), "AST detector missed ID switch/case");
  assert(badRules.includes("venue-key-map"), "AST detector missed venue-key map");

  const good = ts.createSourceFile(
    "synthetic-good.ts",
    `
      function good(registry: { forEdge(id: string): unknown }, edge: { adapterId: string }) {
        return registry.forEdge(edge.adapterId);
      }
    `,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  assert.equal(
    scanIdBranches(good, undefined, knownVenueIds).length,
    0,
    "AST detector rejected registry-derived lookup",
  );
}

function printFamilyLocReview(families: readonly FamilySource[]): void {
  const grouped = new Map<
    string,
    { readonly ids: string[]; readonly lines: number }
  >();
  for (const family of families) {
    const prior = grouped.get(family.path);
    if (prior) {
      prior.ids.push(family.familyId);
      continue;
    }
    const source = readFileSync(family.path, "utf8");
    grouped.set(family.path, {
      ids: [family.familyId],
      lines: source.length === 0 ? 0 : source.split(/\r?\n/).length,
    });
  }
  const rows = [...grouped.entries()]
    .map(([path, report]) => ({
      path: relative(LISTENER_ROOT, path),
      ids: [...report.ids].sort(),
      lines: report.lines,
    }))
    .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  const overBudget = rows.filter((row) => row.lines > 200);

  console.log("[adapter-family-shared-surface] family LOC review (physical LOC; advisory only)");
  for (const row of rows) {
    console.log(
      `  ${String(row.lines).padStart(4)}  ${row.path}  [${row.ids.join(", ")}]` +
      (row.lines > 200 ? "  REVIEW" : ""),
    );
  }
  console.log(
    `[adapter-family-shared-surface] advisory >200 LOC: ` +
    `${overBudget.length}/${rows.length} modules; does not affect PASS`,
  );
}

function main(): void {
  const { program, checker } = loadProgram();
  const familySources = productionFamilySources(program, checker);
  assert.equal(
    familySources.length,
    PRODUCTION_ADAPTER_FAMILIES.list().length,
    "registry AST/runtime family cardinality mismatch",
  );
  const familyPaths = new Set(familySources.map((family) => family.path));
  const knownVenueIds = productionVenueIds();
  assertDetectorSelfTest(knownVenueIds);

  const findings: Finding[] = [];
  for (const relativePath of SHARED_SURFACE) {
    const source = sourceFile(program, resolve(LISTENER_ROOT, relativePath));
    findings.push(
      ...scanIdBranches(source, checker, knownVenueIds),
      ...scanImports(source, familyPaths),
    );
  }

  if (findings.length > 0) {
    throw new Error(
      `shared orchestration/consumer surface has adapter-family bypasses:\n` +
      formatFindings(findings),
    );
  }

  printFamilyLocReview(familySources);
  console.log(
    `adapter-family-shared-surface-conformance PASS ` +
    `(${SHARED_SURFACE.length} shared files, ${familySources.length} families)`,
  );
}

main();
