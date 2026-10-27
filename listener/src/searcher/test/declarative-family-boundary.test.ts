import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as ts from "typescript";

const listenerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceRoot = resolve(listenerRoot, "src");
const familyRoot = resolve(sourceRoot, "searcher/venues/protocols/erc4626-family");
const legacyPlugin = resolve(sourceRoot, "searcher/venues/erc4626-family-plugin");

// These paths define a source-code migration boundary, never protocol admission.
function inside(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
function testSource(file: string): boolean {
  return /(?:^|[/\\])(?:test|tests|__tests__)(?:[/\\]|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
}
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) :
      entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  }).sort();
}
function staticString(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left), right = staticString(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}
function imports(file: string, text: string): readonly { specifier: string; line: number }[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: { specifier: string; line: number }[] = [];
  function visit(node: ts.Node): void {
    let expression: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) expression = node.moduleSpecifier;
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      expression = node.moduleReference.expression;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      expression = node.argument.literal;
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      expression = node.arguments[0];
    }
    const specifier = staticString(expression);
    if (specifier !== undefined) {
      found.push({ specifier, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}
function boundaryFindings(file: string, text: string): string[] {
  return imports(file, text).flatMap(({ specifier, line }) => {
    if (!specifier.startsWith(".") && !isAbsolute(specifier)) return [];
    const target = resolve(dirname(file), specifier);
    const withoutExtension = target.replace(/\.[cm]?[jt]sx?$/, "");
    const retired = withoutExtension === legacyPlugin ||
      (inside(familyRoot, target) && !inside(resolve(familyRoot, "test"), target) &&
        extname(target) !== ".json");
    const testBridge = inside(resolve(familyRoot, "test"), target) && !testSource(file);
    return retired || testBridge
      ? [`${relative(listenerRoot, file)}:${line}: ${retired ? "retired Family module" : "production test bridge"}: ${specifier}`]
      : [];
  });
}

const actualSources = () => sourceFiles(sourceRoot).map(file => ({ file, text: readFileSync(file, "utf8") }));

test("declarative Family boundary detects imports without mistaking JSON, comments or strings for code", () => {
  const file = resolve(sourceRoot, "searcher/probe.ts");
  const path = "./venues/protocols/erc4626-family";
  const bad = [
    `import { exact } from "${path}/exact.js";`,
    `export * from "${path}/execution.js";`,
    `const runtime = import("${path}/identity.js");`,
    `const runtime = import(\`${path}/routes.js\`);`,
    `const runtime = import("${path}/" + "instance.js");`,
    `const runtime = require("${path}/pricing.js");`,
    `type Runtime = import("${path}/types.js").Descriptor;`,
    `import Runtime = require("${path}/protocol.js");`,
    'import { plugin } from "./venues/erc4626-family-plugin.js";',
  ];
  for (const text of bad) assert.equal(boundaryFindings(file, text).length, 1, text);
  assert.deepEqual(boundaryFindings(file, `
    import definition from "${path}/erc4626.json";
    const note = 'import("${path}/exact.js")';
    // import { exact } from "${path}/exact.js";
  `), []);
});

test("declarative Family test bridge is usable by tests but not a production escape hatch", () => {
  const specifier = "./venues/protocols/erc4626-family/test/public-api.js";
  const production = resolve(sourceRoot, "searcher/consumer.ts");
  assert.match(boundaryFindings(production, `export * from "${specifier}";`)[0]!, /production test bridge/);
  assert.match(boundaryFindings(production, `import("${specifier}");`)[0]!, /production test bridge/);
  assert.deepEqual(boundaryFindings(resolve(familyRoot, "test/sample.ts"), 'import "./public-api.js";'), []);
});

test("ERC4626 Family root contains definitions and tests, with no handwritten compatibility modules", () => {
  const forbidden = readdirSync(familyRoot, { withFileTypes: true }).filter(entry =>
    !(entry.isFile() && entry.name.endsWith(".json")) && !(entry.isDirectory() && entry.name === "test"));
  assert.deepEqual(forbidden.map(entry => entry.name).sort(), [], "Family root must contain only JSON and test/");
  assert.equal(existsSync(`${legacyPlugin}.ts`), false, "retired plugin bridge must be removed");
});

test("all source imports respect the retired-module and production/test boundaries", () => {
  const findings = actualSources().flatMap(({ file, text }) => boundaryFindings(file, text));
  assert.deepEqual(findings, [], findings.join("\n"));
});

test("generated ERC4626 contracts exactly match the current main and child JSON type declarations", async () => {
  const generated = resolve(sourceRoot, "searcher/generated/declarative-family-types/erc4626.generated.ts");
  assert(existsSync(generated), "generated Family contracts are required");
  const definition = JSON.parse(readFileSync(resolve(familyRoot, "erc4626.json"), "utf8"));
  const children = definition.variantFiles.map((file: string) =>
    JSON.parse(readFileSync(resolve(familyRoot, file), "utf8")));
  const { renderDeclarativeFamilyTypes } = await import("../venues/declarative-types.js");
  assert.equal(readFileSync(generated, "utf8"),
    renderDeclarativeFamilyTypes(definition.types, children.map((child: { types: unknown }) => child.types)),
    "generated contracts are stale relative to the Family JSON");
});
