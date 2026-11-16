import { resolve } from "node:path";
import ts from "typescript";

// Framework-owned dependency boundaries, never Family-authored source paths.
// Core interpreters and modules with non-module entry points stay conservative.
export const OPTIONAL_DECLARATIVE_MODULE_SOURCES = Object.freeze({
  "declarative-runtime-evidence.ts": ["signedBlockEvidence"],
  "declarative-oracle-victim.ts": ["oracleVictim"],
  "declarative-trial-state.ts": ["trialState"],
  "declarative-pricing-projection.ts": ["pricingProjection"],
  "declarative-instance-evidence.ts": ["instanceEvidence", "executionProjection"],
} as const);

/** Input has already passed the production JSON validators. Count authored
 * blocks, including blocked dependencies and root blocks overridden by children:
 * the compiler validates those before applying inheritance. */
export function inactiveDeclarativeModules(documents: readonly Record<string, any>[]): readonly string[] {
  const used = new Set<string>();
  for (const document of documents) for (const raw of [document.modules, document.standard?.modules]) {
    if (raw === undefined) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid module dependency declaration");
    for (const [key, block] of Object.entries(raw)) {
      if (!block || typeof block !== "object" || Array.isArray(block)) throw new Error("invalid module dependency block");
      if (Object.keys(block).length) used.add(key);
    }
  }
  const inactive = Object.entries(OPTIONAL_DECLARATIVE_MODULE_SOURCES)
    .filter(([, modules]) => !modules.some(name => used.has(name))).map(([file]) => file);
  if (!documents.some(doc => Object.hasOwn(doc, "admission") ||
      (doc.standard && Object.hasOwn(doc.standard, "admission"))))
    inactive.push("declarative-conversion-admission.ts");
  if (!documents.some(doc => doc.identity?.definition?.workflow === "sampled-conversion-v1"))
    inactive.push("sampled-conversion-flow.json");
  return Object.freeze(inactive.sort());
}

/** An uncalled function body cannot affect an absent module. New top-level
 * execution is not assumed harmless: it restores the complete source hash.
 * Imports are always traversed by the normal closure collector. */
export function dormantDeclarativeModuleSource(input: {
  rootDirectory: string; file: string; source: string; inactive: readonly string[];
}): string | undefined {
  const name = [...Object.keys(OPTIONAL_DECLARATIVE_MODULE_SOURCES),
    "declarative-conversion-admission.ts", "sampled-conversion-flow.json"].find(name =>
    resolve(input.rootDirectory, "src/searcher/venues", name) === resolve(input.file));
  if (!name || !input.inactive.includes(name)) return undefined;
  // JSON is inert data. Its importer and the workflow selection guard remain
  // in the runtime closure, so making this data reachable changes that hash.
  if (name.endsWith(".json")) {
    JSON.parse(input.source);
    return `declarative-dormant-data-v1:${name}`;
  }
  const source = ts.createSourceFile(input.file, input.source, ts.ScriptTarget.Latest, true);
  const bindings = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) bindings.add(d.name.getText());
    if (ts.isFunctionDeclaration(statement) && statement.name) bindings.add(statement.name.text);
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      if (statement.importClause.name) bindings.add(statement.importClause.name.text);
      const names = statement.importClause.namedBindings;
      if (names && ts.isNamedImports(names)) names.elements.forEach(item => bindings.add(item.name.text));
      else if (names) bindings.add(names.name.text);
    }
  }
  // Creating a function does not run its body. For the occasional top-level
  // data constructor, prove a narrower form: a local arrow returning only
  // literals/parameters, without calls, accessors, defaults or mutation.
  const constructors = new Map<string, ts.ArrowFunction>();
  for (const statement of source.statements) if (ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.Const)) {
    for (const d of statement.declarationList.declarations)
      if (ts.isIdentifier(d.name) && d.initializer && ts.isArrowFunction(d.initializer)) constructors.set(d.name.text, d.initializer);
  }
  const data = (node: ts.Expression, parameters: ReadonlySet<string>): boolean => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return data(node.expression, parameters);
    if (ts.isIdentifier(node)) return parameters.has(node.text);
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node) ||
        [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(item => ts.isExpression(item) && data(item, parameters));
    return ts.isObjectLiteralExpression(node) && node.properties.every(item =>
      ts.isShorthandPropertyAssignment(item) ? !item.objectAssignmentInitializer && parameters.has(item.name.text)
        : ts.isPropertyAssignment(item) && !ts.isComputedPropertyName(item.name) && data(item.initializer, parameters));
  };
  const literal = (node: ts.Expression): boolean => {
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return literal(node.expression);
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node) ||
        [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fn = constructors.get(node.expression.text);
      return !!fn && !fn.modifiers?.length && fn.parameters.every(p => ts.isIdentifier(p.name) && !p.initializer) &&
        !ts.isBlock(fn.body) && data(fn.body, new Set(fn.parameters.map(p => p.name.getText()))) &&
        node.arguments.every(literal);
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(item => ts.isExpression(item) && literal(item));
    if (ts.isObjectLiteralExpression(node)) return node.properties.every(item => ts.isPropertyAssignment(item) &&
      !ts.isComputedPropertyName(item.name) && literal(item.initializer));
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Set" &&
        !bindings.has("Set")) return node.arguments?.length === 1 && ts.isArrayLiteralExpression(node.arguments[0]!) && literal(node.arguments[0]!);
    return false;
  };
  const safe = source.statements.every(statement => {
    if (ts.isImportDeclaration(statement)) return statement.importClause !== undefined;
    if (ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
        ts.isEmptyStatement(statement)) return true;
    if (ts.isVariableStatement(statement)) return !!(statement.declarationList.flags & ts.NodeFlags.Const) &&
      statement.declarationList.declarations.every(d => ts.isIdentifier(d.name) && !!d.initializer && literal(d.initializer));
    return false;
  });
  return safe ? `declarative-dormant-module-v1:${name}` : undefined;
}
