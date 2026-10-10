import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

interface BoundaryFinding {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

interface SourceAnalysis {
  readonly findings: readonly BoundaryFinding[];
  readonly runtimeDependencies: readonly string[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const LISTENER_ROOT = resolve(HERE, "../../..");
const FAMILY_DIRECTORIES = [
  resolve(LISTENER_ROOT, "src/searcher/venues/swaps"),
  resolve(LISTENER_ROOT, "src/searcher/venues/protocols"),
  resolve(LISTENER_ROOT, "src/searcher/venues/funding"),
  resolve(LISTENER_ROOT, "src/searcher/venues/credit"),
] as const;
const PRODUCTION_ENTRIES = resolve(
  LISTENER_ROOT,
  "src/searcher/venues/production-families",
);

const REQUEST_PROGRAM_MODULE = /(?:^|\/)adapter-request-program(?:\.[cm]?[jt]s)?$/;
const WORK_INTENT_MODULE = /(?:^|\/)adapter-work-intent(?:\.[cm]?[jt]s)?$/;
const LIFECYCLE_CACHE_MODULE =
  /(?:^|\/)adapter-family-lifecycle-content-cache(?:\.[cm]?[jt]s)?$/;
const EXACT_CACHE_MODULE =
  /(?:^|\/)adapter-family-exact-quote-cache(?:\.[cm]?[jt]s)?$/;
function scanSource(file: string, sourceText: string): readonly BoundaryFinding[] {
  return analyzeSource(file, sourceText).findings;
}

function analyzeSource(file: string, sourceText: string): SourceAnalysis {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const findings: BoundaryFinding[] = [];
  const runtimeDependencies = new Set<string>();
  const add = (node: ts.Node, detail: string): void => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ file, line: position.line + 1, detail });
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (importHasRuntimeValue(clause)) {
        runtimeDependencies.add(specifier);
        if (
          REQUEST_PROGRAM_MODULE.test(specifier) ||
          WORK_INTENT_MODULE.test(specifier) ||
          LIFECYCLE_CACHE_MODULE.test(specifier) ||
          EXACT_CACHE_MODULE.test(specifier)
        ) {
          add(node, "Family runtime closure cannot import central Adapter runtimes");
        }
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.isTypeOnly
    ) {
      const specifier = node.moduleSpecifier.text;
      runtimeDependencies.add(specifier);
      if (
        REQUEST_PROGRAM_MODULE.test(specifier) ||
        WORK_INTENT_MODULE.test(specifier) ||
        LIFECYCLE_CACHE_MODULE.test(specifier) ||
        EXACT_CACHE_MODULE.test(specifier)
      ) {
        add(node, "Family runtime closure cannot re-export central Adapter runtimes");
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      typeof node.arguments[0]!.text === "string"
    ) {
      const specifier = node.arguments[0]!.text;
      if (
        REQUEST_PROGRAM_MODULE.test(specifier) ||
        WORK_INTENT_MODULE.test(specifier) ||
        LIFECYCLE_CACHE_MODULE.test(specifier) ||
        EXACT_CACHE_MODULE.test(specifier)
      ) {
        add(node, "Family runtime closure cannot dynamically load central Adapter runtimes");
      }
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")
      ) {
        runtimeDependencies.add(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return {
    findings: Object.freeze(findings),
    runtimeDependencies: Object.freeze([...runtimeDependencies]),
  };
}

function importHasRuntimeValue(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  if (clause.namedBindings === undefined) return false;
  if (ts.isNamespaceImport(clause.namedBindings)) return true;
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function tsFiles(directory: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    // This selects runtime roots, not their dependency closure. A production
    // import into a test directory is still followed by scanRuntimeClosure.
    if (entry.isDirectory() && !["test", "tests", "__tests__"].includes(entry.name)) {
      files.push(...tsFiles(path));
    } else if (entry.isFile() && [".ts", ".tsx"].includes(extname(path)) &&
        !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function scanRuntimeClosure(roots: readonly string[]): {
  readonly files: readonly string[];
  readonly findings: readonly BoundaryFinding[];
} {
  const pending = [...roots];
  const visited = new Set<string>();
  const findings: BoundaryFinding[] = [];
  while (pending.length > 0) {
    const file = resolve(pending.pop()!);
    if (visited.has(file)) continue;
    visited.add(file);
    const analysis = analyzeSource(
      relative(LISTENER_ROOT, file),
      readFileSync(file, "utf8"),
    );
    findings.push(...analysis.findings);
    for (const specifier of analysis.runtimeDependencies) {
      const dependency = resolveTypeScriptDependency(file, specifier);
      if (dependency !== null && !visited.has(dependency)) pending.push(dependency);
    }
  }
  return {
    files: Object.freeze([...visited].sort()),
    findings: Object.freeze(findings),
  };
}

function resolveTypeScriptDependency(
  importingFile: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".") && !isAbsolute(specifier)) return null;
  const unresolved = isAbsolute(specifier)
    ? resolve(specifier)
    : resolve(dirname(importingFile), specifier);
  const extension = extname(unresolved);
  const candidates = new Set<string>([unresolved]);
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    const base = unresolved.slice(0, -extension.length);
    candidates.add(`${base}.ts`);
    candidates.add(`${base}.tsx`);
  } else if (extension.length === 0) {
    candidates.add(`${unresolved}.ts`);
    candidates.add(`${unresolved}.tsx`);
    candidates.add(resolve(unresolved, "index.ts"));
    candidates.add(resolve(unresolved, "index.tsx"));
  }
  for (const candidate of candidates) {
    if (
      existsSync(candidate) &&
      statSync(candidate).isFile() &&
      [".ts", ".tsx"].includes(extname(candidate))
    ) {
      return resolve(candidate);
    }
  }
  return null;
}

const synthetic = scanSource(
  "synthetic-family.ts",
  `import { createBoundedRequestExecutor } from "../adapter-request-program.js";`,
);
assert.equal(synthetic.length, 1, "the boundary scanner must catch issuer imports");

const syntheticAlias = scanSource(
  "synthetic-helper.ts",
  `const load = createRequire(import.meta.url); load("../adapter-request-program.js");`,
);
assert.equal(
  syntheticAlias.length,
  1,
  "the boundary scanner must catch aliased createRequire calls",
);

const syntheticRoot = mkdtempSync(join(tmpdir(), "adapter-issuer-closure-"));
try {
  const entry = join(syntheticRoot, "fixture.production.ts");
  const helper = join(syntheticRoot, "helper.ts");
  writeFileSync(entry, `import "./helper.js";\nexport const plugin = {};\n`);
  writeFileSync(
    helper,
    `import { createBoundedRequestExecutor } from "../adapter-request-program.js";\n` +
      `void createBoundedRequestExecutor;\n`,
  );
  const transitive = scanRuntimeClosure([entry]);
  assert.equal(
    transitive.findings.length,
    1,
    "a helper in the Family runtime closure must not hide the central issuer",
  );
  assert(transitive.files.includes(resolve(helper)));

  const testDirectory = join(syntheticRoot, "test");
  mkdirSync(testDirectory);
  const testHelper = join(testDirectory, "central-probe.ts");
  const unitTest = join(syntheticRoot, "contract.test.ts");
  const centralImport = `import { createBoundedRequestExecutor } from "../adapter-request-program.js";\n`;
  writeFileSync(testHelper, centralImport);
  writeFileSync(unitTest, centralImport);
  writeFileSync(entry, `export const plugin = {};\n`);
  writeFileSync(helper, `export const fixture = {};\n`);
  const runtimeRoots = tsFiles(syntheticRoot);
  assert.deepEqual([...runtimeRoots].sort(), [entry, helper].sort(),
    "standalone Family tests must not become runtime roots");
  assert.deepEqual(scanRuntimeClosure(runtimeRoots).findings, []);
  writeFileSync(entry, `import "./test/central-probe.js";\nexport const plugin = {};\n`);
  const hiddenInTest = scanRuntimeClosure(runtimeRoots);
  assert.equal(hiddenInTest.findings.length, 1,
    "production code cannot hide a central issuer behind a test path");
  assert(hiddenInTest.files.includes(resolve(testHelper)));
} finally {
  rmSync(syntheticRoot, { recursive: true, force: true });
}

const familyFiles = [
  ...FAMILY_DIRECTORIES.flatMap(tsFiles),
  ...tsFiles(PRODUCTION_ENTRIES).filter((file) => file.endsWith(".production.ts")),
];
const closure = scanRuntimeClosure(familyFiles);
const findings = closure.findings;
assert.deepEqual(
  findings,
  [],
  findings.map((finding) =>
    `${finding.file}:${finding.line}: ${finding.detail}`
  ).join("\n"),
);

console.log(
  `adapter-family-central-issuer-boundary PASS ` +
    `(${familyFiles.length} roots / ${closure.files.length} runtime-closure files)`,
);
