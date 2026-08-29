import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import { COMMON_ENVELOPE_ROLE_CONTRACT_VERSION } from "../../../specs/qualification/src/index.ts";

export type Hash = `0x${string}`;

export interface RoleBindingInputV1 {
  readonly modulePath: string;
  readonly exportName: string;
}

/**
 * This is the only authoring input accepted by the generator.  It is emitted
 * by the real release composition module, not supplied by a caller of the
 * acceptance boundary.  Every predicate owns its own oracle binding.
 */
export interface ReleaseCompositionInputV1 {
  readonly schemaVersion: 1;
  readonly commonEnvelopeRoleContractVersion: string;
  readonly genericCore: RoleBindingInputV1;
  readonly qualifiedRunner: RoleBindingInputV1;
  readonly releaseRuntime: RoleBindingInputV1;
  readonly predicateAdapters: readonly PredicateCompositionInputV1[];
}

export interface PredicateCompositionInputV1 {
  readonly predicateId: string;
  readonly predicateSpecDigest: Hash;
  readonly predicateProgramDescriptorDigest: Hash;
  readonly oracleProgramDescriptorDigest: Hash;
  readonly adapterVersion: string;
  readonly oracleVersion: string;
  readonly modulePath: string;
  readonly exportName: string;
  readonly oracleModulePath: string;
  readonly oracleExportName: string;
  readonly materialProviderModulePath: string;
  readonly materialProviderExportName: string;
  readonly materialProviderContractDigest: Hash;
}

/**
 * The generator-owned v2 composition leaf tuple.  Neither the authoring BOM
 * nor a concrete adapter may provide the leaf: it is derived after resolving
 * both named exports and hashing their exact current source bytes.
 */
export interface PredicateCompositionLeafInputV2 {
  readonly predicateId: string;
  readonly predicateSpecDigest: Hash;
  readonly predicateProgramDescriptorDigest: Hash;
  readonly oracleProgramDescriptorDigest: Hash;
  readonly adapterVersion: string;
  readonly oracleVersion: string;
  readonly modulePath: string;
  readonly exportName: string;
  readonly oracleModulePath: string;
  readonly oracleExportName: string;
  readonly predicateImplementationExportDigest: Hash;
  readonly oracleImplementationExportDigest: Hash;
  readonly materialProviderModulePath: string;
  readonly materialProviderExportName: string;
  readonly materialProviderContractDigest: Hash;
  readonly materialProviderImplementationExportDigest: Hash;
}

export interface GeneratedPredicateCompositionBindingV1 extends PredicateCompositionInputV1, PredicateCompositionLeafInputV2 {
  readonly commonEnvelopeRoleContractVersion: string;
  readonly compositionLeafDigest: Hash;
}

export interface GeneratedReleaseRoleManifestV1 {
  readonly schemaVersion: 1;
  readonly commonEnvelopeRoleContractVersion: string;
  readonly genericCore: RoleBindingInputV1 & { readonly entrypointId: string };
  readonly qualifiedRunner: RoleBindingInputV1 & {
    readonly entrypointId: string;
    readonly implementationExportDigest: Hash;
  };
  readonly predicateAdapters: readonly (GeneratedPredicateCompositionBindingV1 & {
    readonly entrypointId: string;
    readonly oracleEntrypointId: string;
    readonly materialProviderEntrypointId: string;
  })[];
  readonly releaseRuntime: RoleBindingInputV1 & { readonly entrypointId: string };
  readonly predicateCompositionRootDigest: Hash;
  readonly rootDigest: Hash;
}

export interface ContentRecordV1 {
  readonly path: string;
  readonly contentSha256: Hash;
  readonly byteLength: number;
}

/**
 * Content-addressed regeneration ledger.  Paths alone are intentionally not
 * sufficient: a changed composition, role module, generator, or output makes
 * the ledger stale even when every path remains identical.
 */
export interface ReleaseRoleManifestLedgerV1 {
  readonly schemaVersion: 1;
  readonly manifestPath: string;
  readonly compositionPath: string;
  readonly inputFiles: readonly ContentRecordV1[];
  readonly generatorFiles: readonly ContentRecordV1[];
  readonly outputs: readonly (ContentRecordV1 & { readonly manifestRootDigest: Hash | null })[];
  /** The authority placeholder is fixed and verified separately from the generated BOM. */
  readonly fixedOutputs: readonly ContentRecordV1[];
  readonly inputRoot: Hash;
  readonly generatorRoot: Hash;
  readonly ledgerHash: Hash;
}

export interface GenerateOptionsV1 {
  readonly repositoryRoot: string;
}

export interface GeneratedReleaseRoleManifestResultV1 {
  readonly manifest: GeneratedReleaseRoleManifestV1;
  readonly ledger: ReleaseRoleManifestLedgerV1;
  readonly outputText: string;
  readonly ledgerText: string;
  /** Additional generated release outputs, keyed by their fixed repo path. */
  readonly generatedOutputs: readonly GeneratedOutputV1[];
  /** Fixed fail-closed files written alongside generated outputs. */
  readonly fixedOutputs: readonly GeneratedOutputV1[];
}

export interface GeneratedOutputV1 {
  readonly path: string;
  readonly text: string;
}

const HASH_RE = /^0x[0-9a-f]{64}$/;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
/** Fixed by the package, never selected by a manifest caller. */
const GENERATOR_SOURCE_PATHS = Object.freeze([
  "tools/release-role-manifest/src/index.ts",
  "tools/release-role-manifest/src/cli.ts",
] as const);

/** Production paths are fixed by the package; callers cannot redirect the
 * release authority, wrapper, or composition output through CLI arguments. */
const PRODUCTION_COMPOSITION_PATH = "acceptance/gate-core/src/release-composition.ts";
const PRODUCTION_ROLE_MANIFEST_PATH = "acceptance/gate-core/src/generated/release-role-manifest.ts";
const PRODUCTION_PREDICATE_COMPOSITION_PATH = "acceptance/gate-core/src/generated/predicate-composition.ts";
const PRODUCTION_RELEASE_RUNTIME_PATH = "acceptance/gate-core/src/generated/release-runtime.ts";
const PRODUCTION_RELEASE_AUTHORITY_PATH = "acceptance/gate-core/src/generated/release-authority.ts";

const PRODUCTION_LEDGER_PATH = "acceptance/gate-core/src/release-role-manifest.ledger.json";
/** Outputs whose bytes are rendered from the release composition. */
const PRODUCTION_GENERATED_OUTPUT_PATHS = Object.freeze([
  PRODUCTION_PREDICATE_COMPOSITION_PATH,
  PRODUCTION_ROLE_MANIFEST_PATH,
  PRODUCTION_RELEASE_RUNTIME_PATH,
].sort());
/** A separately fixed fail-closed placeholder; never an authority generator input. */
const PRODUCTION_FIXED_OUTPUT_PATHS = Object.freeze([PRODUCTION_RELEASE_AUTHORITY_PATH].sort());

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite canonical value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  throw new TypeError(`unsupported canonical value ${typeof value}`);
}

function hashDomain(domain: string, value: unknown): Hash {
  return `0x${createHash("sha256").update(domain).update("\0").update(canonical(value)).digest("hex")}`;
}

function sha256Bytes(bytes: Buffer): Hash {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Bind a named export to the exact source bytes that define its module.  The
 * export name is deliberately part of the digest: switching from one export
 * to another in the same file must invalidate the old qualification.
 */
export function computeImplementationExportDigest(rootInput: string, binding: RoleBindingInputV1): Hash {
  const root = resolve(rootInput);
  const modulePath = repoPath(root, binding.modulePath);
  if (binding.exportName.length === 0) throw new TypeError("implementation export name is required");
  const moduleContentSha256 = sha256Bytes(readFileSync(resolve(root, modulePath)));
  return hashDomain("aloha/implementation-export/v1", {
    modulePath,
    exportName: binding.exportName,
    moduleContentSha256,
  });
}

export function computePredicateCompositionLeafDigest(value: PredicateCompositionLeafInputV2): Hash {
  return hashDomain("aloha/predicate-composition-leaf/v3", value);
}

function posixPath(value: string): string {
  return value.split(sep).join("/");
}

function repoPath(root: string, value: string): string {
  const absolute = resolve(root, value);
  const relativePath = posixPath(relative(root, absolute));
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("/")) {
    throw new TypeError(`path escapes repository: ${value}`);
  }
  return relativePath;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonical(actual) !== canonical(wanted)) throw new TypeError(`${label} has non-exact keys`);
}

function recordFor(root: string, inputPath: string): ContentRecordV1 {
  const path = repoPath(root, inputPath);
  const bytes = readFileSync(resolve(root, path));
  return Object.freeze({ path, contentSha256: sha256Bytes(bytes), byteLength: bytes.byteLength });
}

function recordFromText(root: string, inputPath: string, text: string): ContentRecordV1 {
  const path = repoPath(root, inputPath);
  const bytes = Buffer.from(text, "utf8");
  return Object.freeze({ path, contentSha256: sha256Bytes(bytes), byteLength: bytes.byteLength });
}

function joinPath(directory: string, name: string): string {
  return `${directory}${sep}${name}`;
}

function assertNoDynamicLoaders(sourcePath: string, sourceFile: ts.SourceFile): readonly string[] {
  const staticRequires: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new TypeError(`dynamic import is not allowed in release closure: ${sourcePath}`);
    }
    if (ts.isCallExpression(node)) {
      const directCalleeName = ts.isIdentifier(node.expression) ? node.expression.text : null;
      if (directCalleeName === "require") {
        const argument = node.arguments.length === 1 ? node.arguments[0] : undefined;
        if (argument === undefined || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) {
          throw new TypeError(`dynamic require is not allowed in release closure: ${sourcePath}`);
        }
        staticRequires.push(argument.text);
      }
      if (directCalleeName === "createRequire" || directCalleeName === "eval" || directCalleeName === "Function" || directCalleeName === "Worker") {
        throw new TypeError(`dynamic loader is not allowed in release closure: ${sourcePath}`);
      }
    }
    if (ts.isNewExpression(node)) {
      const calleeName = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null;
      if (calleeName === "Worker" || calleeName === "Function") throw new TypeError(`dynamic loader is not allowed in release closure: ${sourcePath}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return Object.freeze(staticRequires);
}

function sourceImportSpecifiers(root: string, sourcePath: string): readonly string[] {
  const text = readFileSync(resolve(root, sourcePath), "utf8");
  const source = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true);
  const specifiers = [...assertNoDynamicLoaders(sourcePath, source)];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text);
    else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference) && ts.isStringLiteral(statement.moduleReference.expression)) specifiers.push(statement.moduleReference.expression.text);
  }
  return specifiers;
}

function resolveLocalImport(root: string, fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(root, dirname(fromPath), specifier);
  const candidates = [base, ...Array.from(SOURCE_EXTENSIONS).map((extension) => `${base}${extension}`), ...Array.from(SOURCE_EXTENSIONS).map((extension) => `${base}/index${extension}`)];
  for (const candidate of candidates) {
    const path = repoPath(root, candidate);
    if (existsSync(resolve(root, path)) && statSync(resolve(root, path)).isFile()) return path;
  }
  throw new TypeError(`unresolved local release import ${fromPath} -> ${specifier}`);
}

function transitiveTrackedSources(root: string, roots: readonly string[], excluded: ReadonlySet<string>): readonly string[] {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (candidate: string): void => {
    const path = repoPath(root, candidate);
    if (excluded.has(path) || visited.has(path)) return;
    if (!SOURCE_EXTENSIONS.has(extname(path))) return;
    if (visiting.has(path)) throw new TypeError(`source import cycle detected at ${path}`);
    visiting.add(path);
    visited.add(path);
    for (const specifier of sourceImportSpecifiers(root, path)) {
      const target = resolveLocalImport(root, path, specifier);
      if (target !== null) visit(target);
    }
    visiting.delete(path);
  };
  for (const rootPath of roots) visit(rootPath);
  return Object.freeze([...visited].sort());
}

function metadataInputsFor(root: string, sourcePaths: readonly string[]): readonly string[] {
  const metadata = new Set<string>(["package.json", "package-lock.json"]);
  for (const sourcePath of sourcePaths) {
    let directory = dirname(sourcePath);
    while (true) {
      const tsconfig = directory ? `${directory}/tsconfig.json` : "tsconfig.json";
      const packageJson = directory ? `${directory}/package.json` : "package.json";
      if (existsSync(resolve(root, tsconfig))) metadata.add(tsconfig);
      if (existsSync(resolve(root, packageJson))) metadata.add(packageJson);
      if (!directory) break;
      directory = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "";
    }
  }
  return Object.freeze([...metadata].filter((path) => existsSync(resolve(root, path))).sort());
}

function contentRoot(domain: string, records: readonly ContentRecordV1[]): Hash {
  return hashDomain(domain, [...records].sort((left, right) => left.path.localeCompare(right.path)));
}

function isHash(value: unknown): value is Hash {
  return typeof value === "string" && HASH_RE.test(value);
}

function assertBinding(value: unknown, label: string): RoleBindingInputV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  exactKeys(record, ["modulePath", "exportName"], label);
  if (typeof record.modulePath !== "string" || typeof record.exportName !== "string" || record.modulePath.length === 0 || record.exportName.length === 0) {
    throw new TypeError(`${label} binding strings are required`);
  }
  return { modulePath: record.modulePath, exportName: record.exportName };
}

function assertComposition(value: unknown): ReleaseCompositionInputV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("release composition must be an object");
  const record = value as Record<string, unknown>;
  exactKeys(record, ["schemaVersion", "commonEnvelopeRoleContractVersion", "genericCore", "qualifiedRunner", "releaseRuntime", "predicateAdapters"], "release composition");
  if (record.schemaVersion !== 1) throw new TypeError("unsupported release composition schema");
  if (record.commonEnvelopeRoleContractVersion !== COMMON_ENVELOPE_ROLE_CONTRACT_VERSION) throw new TypeError("unsupported common envelope role contract version");
  const rawEntries = record.predicateAdapters;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) throw new TypeError("release composition requires predicate adapters");
  const predicateAdapters: PredicateCompositionInputV1[] = [];
  for (const [index, raw] of rawEntries.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`predicate adapter ${index} must be an object`);
    const entry = raw as Record<string, unknown>;
    exactKeys(entry, ["predicateId", "predicateSpecDigest", "predicateProgramDescriptorDigest", "oracleProgramDescriptorDigest", "adapterVersion", "oracleVersion", "modulePath", "exportName", "oracleModulePath", "oracleExportName", "materialProviderModulePath", "materialProviderExportName", "materialProviderContractDigest"], `predicate adapter ${index}`);
    if (typeof entry.predicateId !== "string" || entry.predicateId.length === 0 || !isHash(entry.predicateSpecDigest) || !isHash(entry.predicateProgramDescriptorDigest) || !isHash(entry.oracleProgramDescriptorDigest) || typeof entry.adapterVersion !== "string" || entry.adapterVersion.length === 0 || typeof entry.oracleVersion !== "string" || entry.oracleVersion.length === 0 || typeof entry.modulePath !== "string" || typeof entry.exportName !== "string" || typeof entry.oracleModulePath !== "string" || typeof entry.oracleExportName !== "string" || typeof entry.materialProviderModulePath !== "string" || typeof entry.materialProviderExportName !== "string" || !isHash(entry.materialProviderContractDigest)) {
      throw new TypeError(`predicate adapter ${index} has invalid binding`);
    }
    predicateAdapters.push(Object.freeze({
      predicateId: entry.predicateId,
      predicateSpecDigest: entry.predicateSpecDigest,
      predicateProgramDescriptorDigest: entry.predicateProgramDescriptorDigest,
      oracleProgramDescriptorDigest: entry.oracleProgramDescriptorDigest,
      adapterVersion: entry.adapterVersion,
      oracleVersion: entry.oracleVersion,
      modulePath: entry.modulePath,
      exportName: entry.exportName,
      oracleModulePath: entry.oracleModulePath,
      oracleExportName: entry.oracleExportName,
      materialProviderModulePath: entry.materialProviderModulePath,
      materialProviderExportName: entry.materialProviderExportName,
      materialProviderContractDigest: entry.materialProviderContractDigest,
    }));
  }
  const sorted = [...predicateAdapters].sort((left, right) => left.predicateId.localeCompare(right.predicateId));
  if (canonical(sorted) !== canonical(predicateAdapters)) throw new TypeError("predicate adapters must be sorted by predicateId");
  if (new Set(predicateAdapters.map((entry) => entry.predicateId)).size !== predicateAdapters.length) throw new TypeError("duplicate predicateId in release composition");
  return Object.freeze({
    schemaVersion: 1,
    commonEnvelopeRoleContractVersion: record.commonEnvelopeRoleContractVersion,
    genericCore: assertBinding(record.genericCore, "genericCore"),
    qualifiedRunner: assertBinding(record.qualifiedRunner, "qualifiedRunner"),
    releaseRuntime: assertBinding(record.releaseRuntime, "releaseRuntime"),
    predicateAdapters: Object.freeze(predicateAdapters),
  });
}

function directlyExportedNames(root: string, modulePath: string): ReadonlySet<string> {
  const path = repoPath(root, modulePath);
  if (!SOURCE_EXTENSIONS.has(extname(path))) throw new TypeError(`unsupported module extension ${path}`);
  const source = ts.createSourceFile(path, readFileSync(resolve(root, path), "utf8"), ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const exported = (node: ts.Node & { readonly modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean =>
    Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
  const declared = (node: ts.Node & { readonly modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean =>
    Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword));
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && exported(statement) && !declared(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) names.add(declaration.name.text);
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement))
      && exported(statement) && !declared(statement) && statement.name !== undefined
      && (!ts.isFunctionDeclaration(statement) || statement.body !== undefined)) {
      names.add(statement.name.text);
    }
  }
  return names;
}

function assertDirectNamedExport(root: string, binding: RoleBindingInputV1): void {
  const path = repoPath(root, binding.modulePath);
  if (!directlyExportedNames(root, path).has(binding.exportName)) {
    throw new TypeError(`missing direct static export ${path}#${binding.exportName}`);
  }
}

/**
 * Reject non-static composition sources before importing them.  A release BOM
 * cannot be selected by a dynamic path, spread, callback, or computed object;
 * the only accepted source is an exported const literal wrapped in
 * Object.freeze/as/satisfies/parentheses.  Values may be independently
 * validated against the imported runtime modules below.
 */
function compositionDeclaration(root: string, compositionPath: string): ts.VariableDeclaration {
  const path = repoPath(root, compositionPath);
  const source = readFileSync(resolve(root, path), "utf8");
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const declarations: ts.VariableDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const candidate of statement.declarationList.declarations) {
      if (ts.isIdentifier(candidate.name) && candidate.name.text === "RELEASE_ROLE_COMPOSITION") declarations.push(candidate);
    }
  }
  if (declarations.length !== 1) throw new TypeError(`${path} must contain exactly one RELEASE_ROLE_COMPOSITION declaration`);
  const [declaration] = declarations;
  const statement = declaration.parent.parent;
  if (!ts.isVariableStatement(statement)) throw new TypeError(`${path} must export const RELEASE_ROLE_COMPOSITION`);
  const exported = Boolean(statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
  if (!exported || (declaration.parent.flags & ts.NodeFlags.Const) === 0 || declaration.initializer === undefined) {
    throw new TypeError(`${path} must export const RELEASE_ROLE_COMPOSITION`);
  }
  let reassigned = false;
  const containsBinding = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return node.text === "RELEASE_ROLE_COMPOSITION";
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return false;
    let found = false;
    ts.forEachChild(node, (child) => { if (!found && containsBinding(child)) found = true; });
    return found;
  };
  const isAssignmentOperator = (kind: ts.SyntaxKind): boolean => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
  const scanWrites = (node: ts.Node): void => {
    if (reassigned) return;
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind) && containsBinding(node.left)) reassigned = true;
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) && containsBinding(node.operand)) reassigned = true;
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && containsBinding(node.initializer)) reassigned = true;
    ts.forEachChild(node, scanWrites);
  };
  scanWrites(sourceFile);
  if (reassigned) throw new TypeError(`${path} RELEASE_ROLE_COMPOSITION is reassigned`);
  return declaration;
}

function assertStaticCompositionSource(root: string, compositionPath: string): void {
  const path = repoPath(root, compositionPath);
  const declaration = compositionDeclaration(root, compositionPath);
  if (!declaration.initializer) throw new TypeError(`${path} must export const RELEASE_ROLE_COMPOSITION`);
  let expression: ts.Expression = declaration.initializer;
  while (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression;
  if (ts.isCallExpression(expression) && expression.arguments.length === 1 && ts.isPropertyAccessExpression(expression.expression) && ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === "Object" && expression.expression.name.text === "freeze") expression = expression.arguments[0]!;
  const staticLiteral = (node: ts.Expression): boolean => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) return staticLiteral(node.expression);
    if (ts.isArrayLiteralExpression(node)) return node.elements.every((element) => ts.isExpression(element) && staticLiteral(element));
    if (!ts.isObjectLiteralExpression(node)) return false;
    return node.properties.every((property) => {
      if (!ts.isPropertyAssignment(property) || property.name === undefined) return false;
      if (ts.isComputedPropertyName(property.name)) return false;
      return staticLiteral(property.initializer);
    });
  };
  if (!staticLiteral(expression)) throw new TypeError(`${path} RELEASE_ROLE_COMPOSITION contains a non-static expression`);
}

function staticCompositionValue(root: string, compositionPath: string): ReleaseCompositionInputV1 {
  const path = repoPath(root, compositionPath);
  const declaration = compositionDeclaration(root, compositionPath);
  if (!declaration?.initializer) throw new TypeError(`${path} must export const RELEASE_ROLE_COMPOSITION`);
  const literal = (node: ts.Expression): unknown => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) return literal(node.expression);
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object" && node.expression.name.text === "freeze") return literal(node.arguments[0]!);
    if (ts.isArrayLiteralExpression(node)) return node.elements.map((item) => literal(item as ts.Expression));
    if (ts.isObjectLiteralExpression(node)) {
      const result: Record<string, unknown> = {};
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) throw new TypeError(`${path} composition contains a non-static property`);
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
        if (key === null) throw new TypeError(`${path} composition contains a non-static property name`);
        if (Object.prototype.hasOwnProperty.call(result, key)) throw new TypeError(`${path} composition contains duplicate property ${key}`);
        result[key] = literal(property.initializer);
      }
      return result;
    }
    throw new TypeError(`${path} composition contains a non-static value`);
  };
  return assertComposition(literal(declaration.initializer));
}

function compilerConfigFor(root: string, modulePath: string): string {
  let directory = dirname(repoPath(root, modulePath));
  while (true) {
    const candidate = directory ? `${directory}/tsconfig.json` : "tsconfig.json";
    if (existsSync(resolve(root, candidate))) return candidate;
    if (!directory) break;
    directory = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "";
  }
  throw new TypeError(`no tsconfig for ${modulePath}`);
}

function diagnosticMessage(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
}

/**
 * The generator ledger must describe the compiler-visible closure of the
 * fixed generator entrypoints.  A handwritten import walk is insufficient:
 * it misses package resolution, ambient declarations, and compiler options.
 * The TypeScript program is used only while generating the observation; no
 * compiler AST is retained in the ledger or in any returned value.
 */
function compilerSourceClosure(root: string, roots: readonly string[]): readonly string[] {
  if (roots.length === 0) throw new TypeError("compiler closure requires roots");
  const configPath = compilerConfigFor(root, roots[0]!);
  const configAbsolutePath = resolve(root, configPath);
  const loaded = ts.readConfigFile(configAbsolutePath, ts.sys.readFile);
  if (loaded.error) throw new TypeError(`cannot read generator tsconfig ${configPath}: ${diagnosticMessage(loaded.error)}`);
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(configAbsolutePath), undefined, configAbsolutePath);
  if (parsed.errors.length > 0) throw new TypeError(`invalid generator tsconfig ${configPath}: ${parsed.errors.map(diagnosticMessage).join("; ")}`);
  if (parsed.projectReferences !== undefined && parsed.projectReferences.length > 0) throw new TypeError(`project references are not allowed in generator closure: ${configPath}`);
  const rootNames = roots.map((path) => resolve(root, repoPath(root, path)));
  const program = ts.createProgram({ rootNames, options: parsed.options });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) throw new TypeError(`generator compiler diagnostics: ${diagnostics.map(diagnosticMessage).join("; ")}`);
  const rootRealPath = realpathSync(root);
  const files = new Set<string>();
  const staticRequiresBySource = new Map<string, readonly string[]>();
  for (const sourceFile of program.getSourceFiles()) {
    // Default libraries are compiler-owned inputs rather than repository
    // source. They are pinned by the selected TypeScript package/lockfile.
    if (program.isSourceFileDefaultLibrary(sourceFile)) continue;
    let sourceRealPath: string;
    try {
      sourceRealPath = realpathSync(sourceFile.fileName);
    } catch {
      throw new TypeError(`compiler closure source is unreadable: ${sourceFile.fileName}`);
    }
    if (sourceRealPath !== rootRealPath && !sourceRealPath.startsWith(`${rootRealPath}${sep}`)) {
      throw new TypeError(`compiler closure source escapes repository: ${sourceFile.fileName}`);
    }
    const relativeSourcePath = posixPath(relative(rootRealPath, sourceRealPath));
    if (relativeSourcePath === "" || relativeSourcePath === ".." || relativeSourcePath.startsWith("../") || relativeSourcePath.startsWith("/")) {
      throw new TypeError(`compiler closure source escapes repository: ${sourceFile.fileName}`);
    }
    const path = repoPath(root, relativeSourcePath);
    // Dependency installations are represented by package metadata, not by
    // mutable node_modules bytes. A workspace symlink resolves to its tracked
    // workspace path before this check and is retained.
    if (path.split("/").includes("node_modules")) continue;
    if (!SOURCE_EXTENSIONS.has(extname(path))) continue;
    staticRequiresBySource.set(path, assertNoDynamicLoaders(path, sourceFile));
    files.add(path);
  }
  for (const [sourcePath, specifiers] of staticRequiresBySource) {
    for (const specifier of specifiers) {
      const target = resolveLocalImport(root, sourcePath, specifier);
      if (target !== null && !files.has(target)) {
        throw new TypeError(`compiler closure omitted static require: ${sourcePath} -> ${specifier}`);
      }
    }
  }
  for (const rootPath of roots) {
    const path = repoPath(root, rootPath);
    if (!files.has(path)) throw new TypeError(`compiler closure omitted generator root: ${path}`);
  }
  return Object.freeze([...files].sort());
}

function compilerEntrypointId(root: string, binding: RoleBindingInputV1, packageEntrypoint: boolean): string {
  const modulePath = repoPath(root, binding.modulePath);
  const configPath = compilerConfigFor(root, modulePath);
  if (!packageEntrypoint) return `compiler-root:${configPath}:${modulePath}`;
  let directory = modulePath.includes("/") ? modulePath.slice(0, modulePath.lastIndexOf("/")) : "";
  while (true) {
    const packagePath = directory ? `${directory}/package.json` : "package.json";
    if (existsSync(resolve(root, packagePath))) {
      const packageValue = JSON.parse(readFileSync(resolve(root, packagePath), "utf8")) as Record<string, unknown>;
      const target = `./${modulePath.slice(directory ? directory.length + 1 : 0)}`;
      const exports = packageValue.exports;
      const isRootExport = exports !== null &&
        typeof exports === "object" &&
        !Array.isArray(exports) &&
        Object.keys(exports as Record<string, unknown>).length === 1 &&
        Object.prototype.hasOwnProperty.call(exports, ".") &&
        (exports as Record<string, unknown>)["."] === target;
      if (isRootExport) return `package-entrypoint:${packagePath}:.:${modulePath}:${configPath}`;
    }
    if (!directory) break;
    directory = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "";
  }
  throw new TypeError(`release runtime ${modulePath} is not an exact package export`);
}

function computePredicateCompositionRootDigest(entries: readonly Pick<GeneratedPredicateCompositionBindingV1, "compositionLeafDigest">[]): Hash {
  return hashDomain("aloha/predicate-composition-root/v1", entries.map((entry) => entry.compositionLeafDigest).sort());
}

function releaseManifestRootDigest(manifest: Omit<GeneratedReleaseRoleManifestV1, "rootDigest">): Hash {
  return hashDomain("aloha/boundary/release-role-manifest/v2", manifest);
}

function renderManifest(manifest: GeneratedReleaseRoleManifestV1): string {
  const serialized = JSON.stringify(manifest, null, 2);
  return `/* generated by tools/release-role-manifest; DO NOT EDIT */\nexport const RELEASE_ROLE_MANIFEST = Object.freeze(${serialized} as const);\n`;
}

function moduleSpecifier(fromPath: string, targetPath: string): string {
  const value = posixPath(relative(dirname(fromPath), targetPath));
  return value.startsWith(".") ? value : `./${value}`;
}

function renderPredicateComposition(
  outputPath: string,
  entries: readonly GeneratedPredicateCompositionBindingV1[],
): string {
  const evaluatorImports = entries.map((entry, index) =>
    `import { ${entry.exportName} as predicateEvaluator${index} } from ${JSON.stringify(moduleSpecifier(outputPath, entry.modulePath))};`,
  );
  const materialProviderImports = entries.map((entry, index) =>
    `import { ${entry.materialProviderExportName} as materialProvider${index} } from ${JSON.stringify(moduleSpecifier(outputPath, entry.materialProviderModulePath))};`,
  );
  const bindings = entries.map((entry, index) => `  Object.freeze({
    predicateId: ${JSON.stringify(entry.predicateId)},
    commonEnvelopeRoleContractVersion: ${JSON.stringify(entry.commonEnvelopeRoleContractVersion)},
    predicateSpecDigest: ${JSON.stringify(entry.predicateSpecDigest)},
    predicateProgramDescriptorDigest: ${JSON.stringify(entry.predicateProgramDescriptorDigest)},
    oracleProgramDescriptorDigest: ${JSON.stringify(entry.oracleProgramDescriptorDigest)},
    adapterVersion: ${JSON.stringify(entry.adapterVersion)},
    oracleVersion: ${JSON.stringify(entry.oracleVersion)},
    compositionLeafDigest: ${JSON.stringify(entry.compositionLeafDigest)},
    predicateImplementationExportDigest: ${JSON.stringify(entry.predicateImplementationExportDigest)},
    oracleImplementationExportDigest: ${JSON.stringify(entry.oracleImplementationExportDigest)},
    materialProviderContractDigest: ${JSON.stringify(entry.materialProviderContractDigest)},
    materialProviderImplementationExportDigest: ${JSON.stringify(entry.materialProviderImplementationExportDigest)},
    evaluator: predicateEvaluator${index},
    materialProvider: materialProvider${index},
  })`).join(",\n");
  const evaluatorTypePath = moduleSpecifier(outputPath, "acceptance/gate-core/src/predicate-composition.ts");
  return `/* generated by tools/release-role-manifest; DO NOT EDIT */
${evaluatorImports.join("\n")}
${materialProviderImports.join("\n")}
import type { PredicateCompositionBindingV1 } from ${JSON.stringify(evaluatorTypePath)};
export type { PredicateCompositionBindingV1 as ReleasePredicateBindingV1 };

export const RELEASE_PREDICATE_BINDINGS: readonly PredicateCompositionBindingV1[] = Object.freeze([
${bindings}
]);

const PREDICATE_EVALUATORS: ReadonlyMap<string, PredicateCompositionBindingV1> = new Map(
  RELEASE_PREDICATE_BINDINGS.map((binding) => [binding.predicateId, binding] as const),
);

export const PREDICATE_COMPOSITION_ROOT_DIGEST = ${JSON.stringify(computePredicateCompositionRootDigest(entries))} as const;

export function resolvePredicateEvaluator(predicateId: string): PredicateCompositionBindingV1 | null {
  return PREDICATE_EVALUATORS.get(predicateId) ?? null;
}
`;
}

function renderReleaseRuntime(): string {
  return `/* generated by tools/release-role-manifest; DO NOT EDIT */
import {
  createReleaseAuthorityUnavailableResult,
  type GateCoreResultV1,
} from "../index.ts";
import {
  assertCommonEnvelopeAuthorityPortV1,
  assembleReleasePredicateInvocationsV1,
  evaluateAssembledReleaseInvocationsV1,
  type AssembledReleaseInvocationSetCapabilityV1,
  type CommonEnvelopeAuthorityPortV1,
  type PredicateMaterialSourcePortV1,
} from "../index.ts";
import { RELEASE_PREDICATE_BINDINGS } from "./predicate-composition.ts";

/** Candidate package entrypoint.  Candidate authority is permanently null;
 * deployment acceptance runs only through the qualified release runner. */
export function evaluateGateCore(_untrustedInput: unknown): GateCoreResultV1 {
  return createReleaseAuthorityUnavailableResult();
}

/** Release-owned all-predicate material path.  Inputs are opaque ports and
 * the generic assembler mechanically traverses the generated binding list. */
export function assembleReleaseGateInvocations(
  authority: CommonEnvelopeAuthorityPortV1,
  source: PredicateMaterialSourcePortV1,
): Promise<AssembledReleaseInvocationSetCapabilityV1> {
  return assembleReleasePredicateInvocationsV1(authority, source, RELEASE_PREDICATE_BINDINGS);
}

export { evaluateAssembledReleaseInvocationsV1 as evaluateAssembledReleaseGateInvocations };
export { assertCommonEnvelopeAuthorityPortV1 };

export type {
  GateCoreResultV1,
  AssembledReleaseInvocationSetCapabilityV1,
  CommonEnvelopeAuthorityPortV1,
  PredicateMaterialSourcePortV1,
} from "../index.ts";
`;
}

function renderReleaseAuthority(): string {
  return `/* generated by tools/release-role-manifest; DO NOT EDIT */
import type { GateCoreAuthorityPinV1 } from "../index.ts";

/** Fail-closed until qualification emits a separately reviewed authority. */
export const RELEASE_AUTHORITY: GateCoreAuthorityPinV1 | null = null;
`;
}

function renderLedger(ledger: ReleaseRoleManifestLedgerV1): string {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

function withoutLedgerHash(ledger: Omit<ReleaseRoleManifestLedgerV1, "ledgerHash">): Hash {
  return hashDomain("aloha/release-role-manifest-ledger/v1", ledger);
}

function assertProductionOptions(options: GenerateOptionsV1): void {
  if (options === null || typeof options !== "object" || typeof options.repositoryRoot !== "string" || canonical(Object.keys(options).sort()) !== canonical(["repositoryRoot"])) {
    throw new TypeError("release-role-manifest options are fixed to repositoryRoot; production composition, three generated outputs, one fixed authority output, and ledger paths cannot be redirected");
  }
}

export async function generateReleaseRoleManifest(options: GenerateOptionsV1): Promise<GeneratedReleaseRoleManifestResultV1> {
  assertProductionOptions(options);
  const root = resolve(options.repositoryRoot);
  const compositionPath = repoPath(root, PRODUCTION_COMPOSITION_PATH);
  const outputPath = repoPath(root, PRODUCTION_ROLE_MANIFEST_PATH);
  const ledgerPath = repoPath(root, PRODUCTION_LEDGER_PATH);
  assertStaticCompositionSource(root, compositionPath);
  const composition = staticCompositionValue(root, compositionPath);
  assertDirectNamedExport(root, composition.genericCore);
  assertDirectNamedExport(root, composition.qualifiedRunner);
  const genericCore = {
    ...composition.genericCore,
    entrypointId: compilerEntrypointId(root, composition.genericCore, false),
  } as const;
  const releaseRuntime = {
    ...composition.releaseRuntime,
    entrypointId: compilerEntrypointId(root, composition.releaseRuntime, true),
  } as const;
  const qualifiedRunnerPath = repoPath(root, composition.qualifiedRunner.modulePath);
  const qualifiedRunner = {
    ...composition.qualifiedRunner,
    modulePath: qualifiedRunnerPath,
    entrypointId: compilerEntrypointId(root, composition.qualifiedRunner, false),
    implementationExportDigest: computeImplementationExportDigest(root, composition.qualifiedRunner),
  } as const;
  const predicateAdapters: Array<GeneratedReleaseRoleManifestV1["predicateAdapters"][number]> = [];
  for (const entry of composition.predicateAdapters) {
    const adapterPath = repoPath(root, entry.modulePath);
    assertDirectNamedExport(root, { modulePath: adapterPath, exportName: entry.exportName });
    const oraclePath = repoPath(root, entry.oracleModulePath);
    assertDirectNamedExport(root, { modulePath: oraclePath, exportName: entry.oracleExportName });
    const materialProviderPath = repoPath(root, entry.materialProviderModulePath);
    assertDirectNamedExport(root, { modulePath: materialProviderPath, exportName: entry.materialProviderExportName });
    const predicateImplementationExportDigest = computeImplementationExportDigest(root, {
      modulePath: adapterPath,
      exportName: entry.exportName,
    });
    const oracleImplementationExportDigest = computeImplementationExportDigest(root, {
      modulePath: oraclePath,
      exportName: entry.oracleExportName,
    });
    const materialProviderImplementationExportDigest = computeImplementationExportDigest(root, {
      modulePath: materialProviderPath,
      exportName: entry.materialProviderExportName,
    });
    const normalizedEntry = Object.freeze({
      ...entry,
      modulePath: adapterPath,
      oracleModulePath: oraclePath,
      materialProviderModulePath: materialProviderPath,
    });
    const compositionLeafDigest = computePredicateCompositionLeafDigest({
      ...normalizedEntry,
      predicateImplementationExportDigest,
      oracleImplementationExportDigest,
      materialProviderImplementationExportDigest,
    });
    predicateAdapters.push(Object.freeze({
      ...normalizedEntry,
      commonEnvelopeRoleContractVersion: composition.commonEnvelopeRoleContractVersion,
      compositionLeafDigest,
      predicateImplementationExportDigest,
      oracleImplementationExportDigest,
      materialProviderImplementationExportDigest,
      entrypointId: compilerEntrypointId(root, { modulePath: adapterPath, exportName: entry.exportName }, false),
      oracleEntrypointId: compilerEntrypointId(root, { modulePath: oraclePath, exportName: entry.oracleExportName }, false),
      materialProviderEntrypointId: compilerEntrypointId(root, { modulePath: materialProviderPath, exportName: entry.materialProviderExportName }, false),
    }));
  }
  if (new Set(predicateAdapters.map((entry) => entry.compositionLeafDigest)).size !== predicateAdapters.length) {
    throw new TypeError("duplicate derived composition leaf in release composition");
  }
  const predicateCompositionRootDigest = computePredicateCompositionRootDigest(predicateAdapters);
  const manifestWithoutRoot = {
    schemaVersion: 1 as const,
    commonEnvelopeRoleContractVersion: composition.commonEnvelopeRoleContractVersion,
    genericCore,
    qualifiedRunner,
    predicateAdapters: Object.freeze(predicateAdapters),
    releaseRuntime,
    predicateCompositionRootDigest,
  };
  const manifest = Object.freeze({ ...manifestWithoutRoot, rootDigest: releaseManifestRootDigest(manifestWithoutRoot) });
  const outputText = renderManifest(manifest);
  const generatedOutputs: GeneratedOutputV1[] = [
    { path: PRODUCTION_PREDICATE_COMPOSITION_PATH, text: renderPredicateComposition(PRODUCTION_PREDICATE_COMPOSITION_PATH, predicateAdapters) },
    { path: outputPath, text: outputText },
    { path: PRODUCTION_RELEASE_RUNTIME_PATH, text: renderReleaseRuntime() },
  ];
  const fixedOutputs: GeneratedOutputV1[] = [
    { path: PRODUCTION_RELEASE_AUTHORITY_PATH, text: renderReleaseAuthority() },
  ];
  const generatedTextByPath = new Map([...generatedOutputs, ...fixedOutputs].map((output) => [repoPath(root, output.path), output.text] as const));
  const excluded = new Set([...generatedTextByPath.keys(), ledgerPath]);
  const inputRoots = [compositionPath, composition.genericCore.modulePath, composition.qualifiedRunner.modulePath, composition.releaseRuntime.modulePath, ...predicateAdapters.flatMap((entry) => [entry.modulePath, entry.oracleModulePath, entry.materialProviderModulePath])];
  const inputSourcePaths = transitiveTrackedSources(root, inputRoots, excluded);
  const inputPaths = [...new Set([...inputSourcePaths, ...metadataInputsFor(root, inputSourcePaths)])].sort();
  const generatorSourcePaths = compilerSourceClosure(root, GENERATOR_SOURCE_PATHS);
  const generatorPaths = [...new Set([...generatorSourcePaths, ...metadataInputsFor(root, generatorSourcePaths)])].sort();
  if (generatorSourcePaths.length === 0) throw new TypeError("generator closure must not be empty");
  const inputFiles = inputPaths.map((path) => generatedTextByPath.has(path)
    ? recordFromText(root, path, generatedTextByPath.get(path)!)
    : recordFor(root, path));
  const generatorFiles = generatorPaths.map((path) => recordFor(root, path));
  const inputRoot = contentRoot("aloha/release-role-manifest-input/v1", inputFiles);
  const generatorRoot = contentRoot("aloha/release-role-manifest-generator/v1", generatorFiles);
  const outputs = generatedOutputs.map((output) => ({
    ...recordFromText(root, output.path, output.text),
    manifestRootDigest: output.path === outputPath ? manifest.rootDigest : null,
  }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const fixedOutputRecords = fixedOutputs.map((output) => recordFromText(root, output.path, output.text))
    .sort((left, right) => left.path.localeCompare(right.path));
  const ledgerWithoutHash = {
    schemaVersion: 1 as const,
    manifestPath: outputPath,
    compositionPath,
    inputFiles: Object.freeze(inputFiles),
    generatorFiles: Object.freeze(generatorFiles),
    outputs: Object.freeze(outputs),
    fixedOutputs: Object.freeze(fixedOutputRecords),
    inputRoot,
    generatorRoot,
  };
  const ledger = Object.freeze({ ...ledgerWithoutHash, ledgerHash: withoutLedgerHash(ledgerWithoutHash) });
  const ledgerText = renderLedger(ledger);
  return {
    manifest,
    ledger,
    outputText,
    ledgerText,
    generatedOutputs: Object.freeze(generatedOutputs),
    fixedOutputs: Object.freeze(fixedOutputs),
  };
}

export function writeGeneratedReleaseRoleManifest(result: GeneratedReleaseRoleManifestResultV1, options: GenerateOptionsV1): void {
  assertProductionOptions(options);
  const root = resolve(options.repositoryRoot);
  for (const output of result.generatedOutputs) writeFileSync(resolve(root, repoPath(root, output.path)), output.text, "utf8");
  for (const output of result.fixedOutputs) writeFileSync(resolve(root, repoPath(root, output.path)), output.text, "utf8");
  writeFileSync(resolve(root, repoPath(root, PRODUCTION_LEDGER_PATH)), result.ledgerText, "utf8");
}

/**
 * Exact regeneration check used by CI/release. It does not write anything:
 * every generated byte and the content-addressed ledger must already equal a
 * fresh result from the fixed composition and generator closure.
 */
export async function checkGeneratedReleaseRoleManifest(options: GenerateOptionsV1): Promise<readonly string[]> {
  try {
    assertProductionOptions(options);
  } catch (error) {
    return Object.freeze([`generation-failed:${error instanceof Error ? error.message : String(error)}`]);
  }
  const root = resolve(options.repositoryRoot);
  let result: GeneratedReleaseRoleManifestResultV1;
  try {
    result = await generateReleaseRoleManifest(options);
  } catch (error) {
    return Object.freeze([`generation-failed:${error instanceof Error ? error.message : String(error)}`]);
  }
  const errors = [...verifyReleaseRoleManifestLedger(root, result.ledger)];
  for (const output of [...result.generatedOutputs, ...result.fixedOutputs]) {
    try {
      const actual = readFileSync(resolve(root, repoPath(root, output.path)), "utf8");
      if (actual !== output.text) errors.push(`generated-content:${output.path}`);
    } catch {
      errors.push(`generated-missing:${output.path}`);
    }
  }
  try {
    const actualLedgerText = readFileSync(resolve(root, repoPath(root, PRODUCTION_LEDGER_PATH)), "utf8");
    if (actualLedgerText !== result.ledgerText) errors.push("ledger-content");
    const actualLedger = parseLedger(JSON.parse(actualLedgerText));
    if (verifyReleaseRoleManifestLedger(root, actualLedger).length !== 0) errors.push("ledger-verification");
  } catch {
    errors.push("ledger-missing-or-invalid");
  }
  return Object.freeze([...new Set(errors)].sort());
}

export function verifyReleaseRoleManifestLedger(
  rootInput: string,
  ledger: ReleaseRoleManifestLedgerV1,
): readonly string[] {
  const root = resolve(rootInput);
  const errors: string[] = [];
  if (ledger.compositionPath !== PRODUCTION_COMPOSITION_PATH) errors.push("production-composition-path");
  if (ledger.manifestPath !== PRODUCTION_ROLE_MANIFEST_PATH) errors.push("production-manifest-path");
  const checkRecords = (records: readonly ContentRecordV1[], label: string): void => {
    const sorted = [...records].sort((left, right) => left.path.localeCompare(right.path));
    if (canonical(records) !== canonical(sorted) || new Set(records.map((record) => record.path)).size !== records.length) errors.push(`${label}-order-or-duplicate`);
    for (const record of records) {
      try {
        const actual = recordFor(root, record.path);
        if (actual.contentSha256 !== record.contentSha256 || actual.byteLength !== record.byteLength) errors.push(`${label}-content:${record.path}`);
      } catch {
        errors.push(`${label}-missing:${record.path}`);
      }
    }
  };
  if (ledger.schemaVersion !== 1) errors.push("schema");
  checkRecords(ledger.inputFiles, "input");
  checkRecords(ledger.generatorFiles, "generator");
  const generatorSources = compilerSourceClosure(root, GENERATOR_SOURCE_PATHS);
  const expectedGeneratorPaths = generatorSources.concat(metadataInputsFor(root, generatorSources)).filter((path, index, all) => all.indexOf(path) === index).sort();
  if (canonical(ledger.generatorFiles.map((record) => record.path)) !== canonical(expectedGeneratorPaths)) errors.push("generator-set");
  try {
    const composition = staticCompositionValue(root, ledger.compositionPath);
    const inputRoots = [ledger.compositionPath, composition.genericCore.modulePath, composition.qualifiedRunner.modulePath, composition.releaseRuntime.modulePath, ...composition.predicateAdapters.flatMap((entry) => [entry.modulePath, entry.oracleModulePath, entry.materialProviderModulePath])];
    const inputSources = transitiveTrackedSources(root, inputRoots, new Set(PRODUCTION_GENERATED_OUTPUT_PATHS));
    const expectedInputPaths = inputSources.concat(metadataInputsFor(root, inputSources)).filter((path, index, all) => all.indexOf(path) === index).sort();
    if (canonical(ledger.inputFiles.map((record) => record.path)) !== canonical(expectedInputPaths)) errors.push("input-set");
  } catch {
    errors.push("input-composition-unreadable");
  }
  const expectedInputRoot = contentRoot("aloha/release-role-manifest-input/v1", ledger.inputFiles);
  if (ledger.inputRoot !== expectedInputRoot) errors.push("input-root");
  const expectedGeneratorRoot = contentRoot("aloha/release-role-manifest-generator/v1", ledger.generatorFiles);
  if (ledger.generatorRoot !== expectedGeneratorRoot) errors.push("generator-root");
  const expectedOutputs = PRODUCTION_GENERATED_OUTPUT_PATHS;
  const outputPaths = ledger.outputs.map((record) => record.path);
  const sortedOutputPaths = [...outputPaths].sort();
  if (canonical(outputPaths) !== canonical(sortedOutputPaths) || new Set(outputPaths).size !== outputPaths.length) errors.push("output-order-or-duplicate");
  if (canonical(outputPaths) !== canonical(expectedOutputs)) errors.push("output-set");
  for (const output of ledger.outputs) {
    try {
      const actual = recordFor(root, output.path);
      if (actual.contentSha256 !== output.contentSha256 || actual.byteLength !== output.byteLength) errors.push(`output-content:${output.path}`);
    } catch {
      errors.push(`output-missing:${output.path}`);
    }
  }
  const fixedOutputPaths = ledger.fixedOutputs.map((record) => record.path);
  const sortedFixedOutputPaths = [...fixedOutputPaths].sort();
  if (canonical(fixedOutputPaths) !== canonical(sortedFixedOutputPaths) || new Set(fixedOutputPaths).size !== fixedOutputPaths.length) errors.push("fixed-output-order-or-duplicate");
  if (canonical(fixedOutputPaths) !== canonical(PRODUCTION_FIXED_OUTPUT_PATHS)) errors.push("fixed-output-set");
  const expectedAuthorityText = renderReleaseAuthority();
  for (const fixed of ledger.fixedOutputs) {
    try {
      const actual = recordFor(root, fixed.path);
      if (actual.contentSha256 !== fixed.contentSha256 || actual.byteLength !== fixed.byteLength) errors.push(`fixed-output-content:${fixed.path}`);
      if (fixed.path === PRODUCTION_RELEASE_AUTHORITY_PATH) {
        const expected = recordFromText(root, fixed.path, expectedAuthorityText);
        if (fixed.contentSha256 !== expected.contentSha256 || fixed.byteLength !== expected.byteLength) errors.push("fixed-authority-render-mismatch");
        if (readFileSync(resolve(root, fixed.path), "utf8") !== expectedAuthorityText) errors.push("fixed-authority-bytes");
      }
    } catch {
      errors.push(`fixed-output-missing:${fixed.path}`);
    }
  }
  const manifestOutput = ledger.outputs.find((output) => output.path === ledger.manifestPath);
  if (manifestOutput === undefined || manifestOutput.manifestRootDigest === null) errors.push("manifest-output-binding");
  const { ledgerHash: _ledgerHash, ...withoutHash } = ledger;
  if (withoutLedgerHash(withoutHash) !== ledger.ledgerHash) errors.push("ledger-hash");
  return Object.freeze(errors);
}

export function parseLedger(value: unknown): ReleaseRoleManifestLedgerV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("ledger must be an object");
  const record = value as Record<string, unknown>;
  exactKeys(record, ["schemaVersion", "manifestPath", "compositionPath", "inputFiles", "generatorFiles", "outputs", "fixedOutputs", "inputRoot", "generatorRoot", "ledgerHash"], "release role manifest ledger");
  if (record.schemaVersion !== 1 || typeof record.manifestPath !== "string" || typeof record.compositionPath !== "string" || !Array.isArray(record.inputFiles) || !Array.isArray(record.generatorFiles) || !Array.isArray(record.outputs) || !Array.isArray(record.fixedOutputs) || !isHash(record.inputRoot) || !isHash(record.generatorRoot) || !isHash(record.ledgerHash)) throw new TypeError("invalid release role manifest ledger");
  const parseContentRecord = (item: unknown, label: string, withManifestRoot: boolean): ContentRecordV1 & { readonly manifestRootDigest?: Hash | null } => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new TypeError(`${label} must be an object`);
    const candidate = item as Record<string, unknown>;
    exactKeys(candidate, withManifestRoot ? ["path", "contentSha256", "byteLength", "manifestRootDigest"] : ["path", "contentSha256", "byteLength"], label);
    if (typeof candidate.path !== "string" || !isHash(candidate.contentSha256) || typeof candidate.byteLength !== "number" || !Number.isSafeInteger(candidate.byteLength) || candidate.byteLength < 0 || (withManifestRoot && candidate.manifestRootDigest !== null && !isHash(candidate.manifestRootDigest))) throw new TypeError(`invalid ${label}`);
    return { path: candidate.path, contentSha256: candidate.contentSha256, byteLength: candidate.byteLength, ...(withManifestRoot ? { manifestRootDigest: candidate.manifestRootDigest as Hash | null } : {}) };
  };
  const inputFiles = record.inputFiles.map((item, index) => parseContentRecord(item, `inputFiles[${index}]`, false));
  const generatorFiles = record.generatorFiles.map((item, index) => parseContentRecord(item, `generatorFiles[${index}]`, false));
  const outputs = record.outputs.map((item, index) => parseContentRecord(item, `outputs[${index}]`, true) as ContentRecordV1 & { readonly manifestRootDigest: Hash | null });
  const fixedOutputs = record.fixedOutputs.map((item, index) => parseContentRecord(item, `fixedOutputs[${index}]`, false));
  return Object.freeze({
    schemaVersion: 1,
    manifestPath: record.manifestPath,
    compositionPath: record.compositionPath,
    inputFiles: Object.freeze(inputFiles),
    generatorFiles: Object.freeze(generatorFiles),
    outputs: Object.freeze(outputs),
    fixedOutputs: Object.freeze(fixedOutputs),
    inputRoot: record.inputRoot,
    generatorRoot: record.generatorRoot,
    ledgerHash: record.ledgerHash,
  });
}
