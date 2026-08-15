import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";

type FindingRule =
  | "concrete-family-import"
  | "production-family-literal"
  | "family-dispatch-branch"
  | "family-keyed-table"
  | "generated-boundary-bypass";

interface Finding {
  readonly rule: FindingRule;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly detail: string;
  readonly importChain?: readonly string[];
}

interface ImportGraph {
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
  readonly sourceByPath: ReadonlyMap<string, ts.SourceFile>;
}

interface ProductionVocabulary {
  readonly familyIds: ReadonlySet<string>;
  readonly familyAliases: ReadonlySet<string>;
  readonly pluginDeclaredHex: ReadonlySet<string>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const LISTENER_ROOT = resolve(HERE, "../../..");
const TSCONFIG = resolve(LISTENER_ROOT, "tsconfig.json");
const GENERATED_CATALOG_BOUNDARY = resolve(
  LISTENER_ROOT,
  "src/searcher/generated/production-family-entries.generated.ts",
);
const LEGACY_AUTHORITY_BOUNDARIES = new Set([
  "src/searcher/venues/production-registry.ts",
  "src/searcher/venues/adapter-family-registry.ts",
  "src/searcher/venues/route-leg-registry.ts",
  "src/searcher/venues/landed-event-registry.ts",
  "src/searcher/architecture-migration-fixture-replay.ts",
  "src/adapters/adapter-descriptors.ts",
  "src/adapters/flash-providers.ts",
].map((path) => resolve(LISTENER_ROOT, path)));

/**
 * These are architecture roots, not a whitelist of files to inspect. Every
 * transitive local import is scanned. New helper files therefore enter the
 * gate automatically as soon as a central path or framework test imports
 * them.
 */
const CENTRAL_ROOTS = Object.freeze([
  "src/searcher/main.ts",
  "src/searcher/strict-execution-projection.ts",
  "src/searcher/strict-family-lifecycle-runner.ts",
  "src/searcher/adapter-work-intent.ts",
  "src/searcher/venues/adapter-family-runtime.ts",
  "src/searcher/venues/family-capability-catalog.ts",
  "src/searcher/venues/production-family-composition.ts",
] as const);

const FRAMEWORK_TEST_ROOTS = Object.freeze([
  "src/searcher/test/strict-execution-projection.ts",
  "src/searcher/test/strict-family-lifecycle-runner.ts",
  "src/searcher/test/family-capability-catalog.ts",
  "src/searcher/test/production-family-composition.ts",
] as const);

const FAMILY_ID_FIELD_NAMES = new Set([
  "adapterfamily",
  "adapterfamilyid",
  "adapterid",
  "capturefamily",
  "capturename",
  "family",
  "families",
  "familyid",
  "familyids",
  "familykey",
  "protocolid",
  "venueid",
]);
const EQUALITY_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

function loadProgram(): ts.Program {
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
    throw new Error(ts.formatDiagnosticsWithColorAndContext(
      parsed.errors,
      {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => LISTENER_ROOT,
        getNewLine: () => "\n",
      },
    ));
  }
  return ts.createProgram(parsed.fileNames, parsed.options);
}

function buildImportGraph(program: ts.Program): ImportGraph {
  const sourceByPath = new Map<string, ts.SourceFile>();
  for (const source of program.getSourceFiles()) {
    if (!source.fileName.startsWith(LISTENER_ROOT) || source.isDeclarationFile) {
      continue;
    }
    sourceByPath.set(resolve(source.fileName), source);
  }
  const dependencies = new Map<string, readonly string[]>();
  for (const [path, source] of sourceByPath) {
    const imports: string[] = [];
    for (const statement of source.statements) {
      if (isTypeOnlyImportOrExport(statement)) continue;
      const specifier = ts.isImportDeclaration(statement)
        ? statement.moduleSpecifier
        : ts.isExportDeclaration(statement)
          ? statement.moduleSpecifier
          : undefined;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      const resolved = resolveTsImport(path, specifier.text);
      if (resolved !== null && sourceByPath.has(resolved)) imports.push(resolved);
    }
    dependencies.set(path, Object.freeze([...new Set(imports)].sort()));
  }
  return { dependencies, sourceByPath };
}

function isTypeOnlyImportOrExport(statement: ts.Statement): boolean {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause?.isTypeOnly === true) return true;
    if (clause?.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.name === undefined &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly)) {
      return true;
    }
  }
  return ts.isExportDeclaration(statement) && statement.isTypeOnly;
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

function generatedProductionEntries(
  graph: ImportGraph,
): readonly string[] {
  const source = graph.sourceByPath.get(GENERATED_CATALOG_BOUNDARY);
  if (source === undefined) {
    throw new Error("generated production Family boundary is absent from program");
  }
  const entries: string[] = [];
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const imported = resolveTsImport(source.fileName, statement.moduleSpecifier.text);
    if (imported === null || !isProductionEntry(imported)) {
      throw new Error(
        `generated Family catalog imports a non-entry module: ` +
          statement.moduleSpecifier.text,
      );
    }
    entries.push(imported);
  }
  if (entries.length === 0) {
    throw new Error("generated production Family boundary contains no entries");
  }
  return Object.freeze([...new Set(entries)].sort());
}

function isProductionEntry(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized.includes("/src/searcher/venues/production-families/") &&
    normalized.endsWith(".production.ts");
}

function productionVocabulary(entries: readonly string[]): ProductionVocabulary {
  const familyIds = new Set<string>();
  const familyAliases = new Set<string>();
  const pluginDeclaredHex = new Set<string>();
  for (const loaded of
    PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.listAll()) {
    const id = loaded.plugin.manifest.familyId;
    familyIds.add(id);
    addFamilyAliases(familyAliases, id);
    for (const action of loaded.plugin.actionAdapters) {
      familyAliases.add(action.id.toLowerCase());
    }
    if ("discovery" in loaded.plugin) {
      for (const pattern of loaded.plugin.discovery.callPatterns ?? []) {
        pluginDeclaredHex.add(pattern.selector.toLowerCase());
      }
      for (const pattern of loaded.plugin.discovery.logPatterns ?? []) {
        pluginDeclaredHex.add(pattern.topic.toLowerCase());
        if (pattern.emitter !== undefined && "address" in pattern.emitter) {
          pluginDeclaredHex.add(pattern.emitter.address.toLowerCase());
        }
      }
      for (const surface of loaded.plugin.discovery.addressSurfaces ?? []) {
        if (/^0x[0-9a-fA-F]+$/.test(surface.fingerprint)) {
          pluginDeclaredHex.add(surface.fingerprint.toLowerCase());
        }
      }
    }
  }
  for (const entry of entries) {
    addFamilyAliases(
      familyAliases,
      entry.split("/").at(-1)!.replace(/\.production\.ts$/, ""),
    );
  }
  return {
    familyIds,
    familyAliases,
    pluginDeclaredHex,
  };
}

function addFamilyAliases(target: Set<string>, value: string): void {
  const normalized = value.toLowerCase();
  target.add(normalized);
  const suffix = normalized.includes(":")
    ? normalized.slice(normalized.lastIndexOf(":") + 1)
    : normalized;
  target.add(suffix);
  if (suffix.endsWith("-standard")) {
    target.add(suffix.slice(0, -"-standard".length));
  }
}

function reachableClosure(input: {
  readonly graph: ImportGraph;
  readonly roots: readonly string[];
}): {
  readonly paths: ReadonlySet<string>;
  readonly parent: ReadonlyMap<string, string | null>;
} {
  const paths = new Set<string>();
  const parent = new Map<string, string | null>();
  const queue = input.roots.map((root) => resolve(LISTENER_ROOT, root));
  for (const root of queue) {
    if (!input.graph.sourceByPath.has(root)) {
      throw new Error(`architecture gate root is absent: ${relative(LISTENER_ROOT, root)}`);
    }
    parent.set(root, null);
  }
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index]!;
    if (paths.has(path)) continue;
    paths.add(path);
    // The generated static catalog is the sole intentional concrete-Family
    // boundary. Its entries are validated separately and never traversed as
    // central implementation.
    if (path === GENERATED_CATALOG_BOUNDARY ||
        LEGACY_AUTHORITY_BOUNDARIES.has(path)) continue;
    for (const dependency of input.graph.dependencies.get(path) ?? []) {
      // A concrete plugin is diagnosed at the importing central module. Do
      // not descend into its legal plugin-local ABI/semantic closure and turn
      // those declarations into false central findings.
      if (isFamilyOwnedImplementation(dependency) ||
          LEGACY_AUTHORITY_BOUNDARIES.has(dependency)) continue;
      if (!parent.has(dependency)) parent.set(dependency, path);
      queue.push(dependency);
    }
  }
  return { paths, parent };
}

function importChain(
  path: string,
  parent: ReadonlyMap<string, string | null>,
): readonly string[] {
  const result: string[] = [];
  let current: string | null | undefined = path;
  while (current !== null && current !== undefined) {
    result.push(relative(LISTENER_ROOT, current));
    current = parent.get(current);
  }
  return Object.freeze(result.reverse());
}

function scanClosure(input: {
  readonly graph: ImportGraph;
  readonly closure: ReturnType<typeof reachableClosure>;
  readonly vocabulary: ProductionVocabulary;
  readonly productionEntries: ReadonlySet<string>;
}): readonly Finding[] {
  const findings: Finding[] = [];
  for (const path of input.closure.paths) {
    if (path === GENERATED_CATALOG_BOUNDARY) continue;
    const source = input.graph.sourceByPath.get(path)!;
    for (const dependency of input.graph.dependencies.get(path) ?? []) {
      if (dependency === GENERATED_CATALOG_BOUNDARY) continue;
      if (
        input.productionEntries.has(dependency) ||
        isFamilyOwnedImplementation(dependency)
      ) {
        const importNode = importNodeForDependency(source, dependency) ?? source;
        addFinding(
          findings,
          source,
          importNode,
          "concrete-family-import",
          `imports ${relative(LISTENER_ROOT, dependency)}`,
          importChain(path, input.closure.parent),
        );
      } else if (LEGACY_AUTHORITY_BOUNDARIES.has(dependency)) {
        const importNode = importNodeForDependency(source, dependency) ?? source;
        addFinding(
          findings,
          source,
          importNode,
          "generated-boundary-bypass",
          `imports executable legacy authority ${relative(LISTENER_ROOT, dependency)}`,
          importChain(path, input.closure.parent),
        );
      }
    }
    findings.push(...scanFamilyLogic(
      source,
      input.vocabulary,
      importChain(path, input.closure.parent),
    ));
  }
  return Object.freeze(findings);
}

function isFamilyOwnedImplementation(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (/\/src\/searcher\/venues\/production-families\/[^/]+\.production\.ts$/.test(
    normalized,
  )) return true;
  if (/\/src\/searcher\/venues\/(?:swaps|protocols|credit|funding)\/[^/]+-family\//.test(
    normalized,
  )) return true;
  return /\/src\/searcher\/venues\/(?:swaps|protocols|credit|funding)\/(?!adapter-family-plugin\.ts$)[^/]+-family-plugin\.ts$/.test(
    normalized,
  );
}

function importNodeForDependency(
  source: ts.SourceFile,
  dependency: string,
): ts.ImportDeclaration | ts.ExportDeclaration | null {
  for (const statement of source.statements) {
    const specifier = ts.isImportDeclaration(statement)
      ? statement.moduleSpecifier
      : ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    if (resolveTsImport(source.fileName, specifier.text) === dependency) {
      return statement as ts.ImportDeclaration | ts.ExportDeclaration;
    }
  }
  return null;
}

function scanFamilyLogic(
  source: ts.SourceFile,
  vocabulary: ProductionVocabulary,
  chain: readonly string[],
): readonly Finding[] {
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (isStaticStringNode(node) && !isModuleSpecifier(node)) {
      const value = node.text.toLowerCase();
      if (vocabulary.familyIds.has(value) ||
          vocabulary.familyAliases.has(value) ||
          vocabulary.pluginDeclaredHex.has(value)) {
        addFinding(
          findings,
          source,
          node,
          "production-family-literal",
          `production Family vocabulary ${JSON.stringify(node.text)}`,
          chain,
        );
      }
    }

    if (ts.isBinaryExpression(node) &&
        EQUALITY_OPERATORS.has(node.operatorToken.kind) &&
        (expressionLooksFamilyish(node.left) ||
          expressionLooksFamilyish(node.right))) {
      const literal = staticString(node.left) ?? staticString(node.right);
      if (literal !== null) {
        addFinding(
          findings,
          source,
          node,
          "family-dispatch-branch",
          node.getText(source),
          chain,
        );
      }
    }

    if (ts.isSwitchStatement(node) && expressionLooksFamilyish(node.expression)) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && staticString(clause.expression) !== null) {
          addFinding(
            findings,
            source,
            clause,
            "family-dispatch-branch",
            `${node.expression.getText(source)} case ` +
              JSON.stringify(staticString(clause.expression)),
            chain,
          );
        }
      }
    }

    if (isFamilyKeyedTable(node, vocabulary)) {
      addFinding(
        findings,
        source,
        node,
        "family-keyed-table",
        node.getText(source).slice(0, 180),
        chain,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return Object.freeze(findings);
}

function isStaticStringNode(
  node: ts.Node,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  return parent !== undefined && (ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node;
}

function staticString(expression: ts.Expression): string | null {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return isStaticStringNode(current) ? current.text : null;
}

function expressionLooksFamilyish(expression: ts.Expression): boolean {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) current = current.expression;
  if (ts.isIdentifier(current)) {
    return FAMILY_ID_FIELD_NAMES.has(current.text.toLowerCase());
  }
  if (ts.isPropertyAccessExpression(current)) {
    return FAMILY_ID_FIELD_NAMES.has(current.name.text.toLowerCase());
  }
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    const key = staticString(current.argumentExpression);
    return key !== null && FAMILY_ID_FIELD_NAMES.has(key.toLowerCase());
  }
  return false;
}

function declarationName(node: ts.Node): string {
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (ts.isVariableDeclaration(current)) {
      return ts.isIdentifier(current.name) ? current.name.text : "";
    }
    if (ts.isPropertyAssignment(current) || ts.isPropertyDeclaration(current)) {
      if (ts.isIdentifier(current.name) || isStaticStringNode(current.name)) {
        return current.name.text;
      }
      return "";
    }
    current = current.parent;
  }
  return "";
}

function isFamilyKeyedTable(
  node: ts.Node,
  vocabulary: ProductionVocabulary,
): boolean {
  const owner = declarationName(node).toLowerCase();
  if (!/(?:family|families|adapter|protocol|venue|capture|driver)/.test(owner)) {
    return false;
  }
  const entries = tableEntries(node);
  if (entries === null) return false;
  for (const entry of entries) {
    const value = staticString(entry);
    if (value === null) continue;
    const normalized = value.toLowerCase();
    if (vocabulary.familyIds.has(normalized) ||
        vocabulary.familyAliases.has(normalized) ||
        vocabulary.pluginDeclaredHex.has(normalized)) return true;
  }
  return false;
}

function tableEntries(node: ts.Node): readonly ts.Expression[] | null {
  if (ts.isNewExpression(node) && node.arguments?.[0] &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "Map" || node.expression.text === "Set") &&
      ts.isArrayLiteralExpression(node.arguments[0])) {
    return Object.freeze(node.arguments[0].elements.flatMap((entry) => {
      if (!ts.isExpression(entry)) return [];
      if (ts.isArrayLiteralExpression(entry) && entry.elements[0] &&
          ts.isExpression(entry.elements[0])) return [entry.elements[0]];
      return [entry];
    }));
  }
  if (ts.isObjectLiteralExpression(node)) {
    return Object.freeze(node.properties.flatMap((property) => {
      if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) {
        return [];
      }
      const name = property.name;
      if (isStaticStringNode(name)) return [name];
      if (ts.isIdentifier(name)) {
        return [ts.factory.createStringLiteral(name.text)];
      }
      return [];
    }));
  }
  return null;
}

function addFinding(
  findings: Finding[],
  source: ts.SourceFile,
  node: ts.Node,
  rule: FindingRule,
  detail: string,
  chain?: readonly string[],
): void {
  const start = node === source ? 0 : node.getStart(source);
  const position = source.getLineAndCharacterOfPosition(start);
  findings.push(Object.freeze({
    rule,
    file: relative(LISTENER_ROOT, source.fileName),
    line: position.line + 1,
    column: position.character + 1,
    detail,
    ...(chain === undefined ? {} : { importChain: chain }),
  }));
}

function assertDetectorSelfTest(vocabulary: ProductionVocabulary): void {
  const exampleFamilyId = [...vocabulary.familyIds][0]!;
  const bad = ts.createSourceFile(
    "synthetic-bad.ts",
    `
      function bad(item: { familyId: string }) {
        if (item.familyId === ${JSON.stringify(exampleFamilyId)}) return;
        switch (item.familyId) { case "synthetic-family": return; }
        const familyDrivers = new Map([[${JSON.stringify(exampleFamilyId)}, 1]]);
        return familyDrivers;
      }
    `,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const rules = scanFamilyLogic(bad, vocabulary, ["synthetic-bad.ts"])
    .map((finding) => finding.rule);
  assert(rules.includes("production-family-literal"));
  assert(rules.includes("family-dispatch-branch"));
  assert(rules.includes("family-keyed-table"));

  const good = ts.createSourceFile(
    "synthetic-good.ts",
    `
      function good(catalog: { forFamily(id: string): unknown }, familyId: string) {
        return catalog.forFamily(familyId);
      }
    `,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  assert.equal(
    scanFamilyLogic(good, vocabulary, ["synthetic-good.ts"]).length,
    0,
  );

  assert.equal(
    expressionLooksFamilyish(ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier("url"),
      "protocol",
    )),
    false,
    "ordinary URL.protocol access must not be treated as Family dispatch",
  );
  assert.equal(
    isFamilyOwnedImplementation(resolve(
      LISTENER_ROOT,
      "src/searcher/venues/swaps/synthetic-family/identity.ts",
    )),
    true,
  );
  assert.equal(
    isFamilyOwnedImplementation(resolve(
      LISTENER_ROOT,
      "src/searcher/venues/protocols/protocol-state-framework.ts",
    )),
    false,
  );
}

function formatFindings(findings: readonly Finding[]): string {
  const unique = new Map<string, Finding>();
  for (const finding of findings) {
    const key = `${finding.file}:${finding.line}:${finding.column}:` +
      `${finding.rule}:${finding.detail}`;
    unique.set(key, finding);
  }
  return [...unique.values()]
    .sort((left, right) =>
      left.file.localeCompare(right.file) || left.line - right.line ||
      left.column - right.column || left.rule.localeCompare(right.rule)
    )
    .map((finding) =>
      `${finding.file}:${finding.line}:${finding.column} ` +
      `[${finding.rule}] ${finding.detail}` +
      (finding.importChain === undefined
        ? ""
        : `\n  closure: ${finding.importChain.join(" -> ")}`)
    )
    .join("\n");
}

function main(): void {
  const program = loadProgram();
  const graph = buildImportGraph(program);
  const entries = generatedProductionEntries(graph);
  const vocabulary = productionVocabulary(entries);
  assert.equal(
    entries.length,
    PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.listAll().length,
    "generated entry/catalog cardinality mismatch",
  );
  assertDetectorSelfTest(vocabulary);
  const roots = [...CENTRAL_ROOTS, ...FRAMEWORK_TEST_ROOTS];
  const closure = reachableClosure({ graph, roots });
  const findings = scanClosure({
    graph,
    closure,
    vocabulary,
    productionEntries: new Set(entries),
  });
  if (findings.length > 0) {
    throw new Error(
      `central AST/import-closure gate found Family-specific logic:\n` +
        formatFindings(findings),
    );
  }
  console.log(
    `adapter-family-shared-surface-conformance PASS ` +
      `(roots=${roots.length} closure=${closure.paths.size} ` +
      `families=${entries.length})`,
  );
}

main();
