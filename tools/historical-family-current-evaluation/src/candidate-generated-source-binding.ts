import ts from "typescript";
import type { GeneratedFamilyRuntimeFactoryMetadataV1 } from "../../../packages/family-composition/src/internal/generated-runtime-composition.ts";

type FamilyMetadata = GeneratedFamilyRuntimeFactoryMetadataV1["families"][number];

export interface CandidateGeneratedStaticImportV1 {
  readonly alias: string;
  readonly exportName: string;
  readonly moduleSpecifier: string;
}

export interface CandidateGeneratedSourceBindingV1 {
  readonly familyOrdinal: number;
  readonly adapterOrdinal: number;
  readonly adapterImport: CandidateGeneratedStaticImportV1;
  readonly extensionImports: readonly CandidateGeneratedStaticImportV1[];
  readonly actionOwnerImports: readonly CandidateGeneratedStaticImportV1[];
}

function fail(message: string): never {
  throw new TypeError(message);
}

function parseSource(source: string): ts.SourceFile {
  const file = ts.createSourceFile(
    "generated/runtime-composition/index.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics = (file as unknown as { readonly parseDiagnostics: readonly unknown[] }).parseDiagnostics;
  if (diagnostics.length !== 0) fail("generated source is not valid TypeScript");
  return file;
}

function imports(file: ts.SourceFile): ReadonlyMap<string, CandidateGeneratedStaticImportV1> {
  const selected = new Map<string, CandidateGeneratedStaticImportV1>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.importClause?.namedBindings === undefined
      || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      const alias = element.name.text;
      if (!alias.startsWith("FAMILY_")) continue;
      if (selected.has(alias)) fail(`generated source static alias is duplicated ${alias}`);
      selected.set(alias, Object.freeze({
        alias,
        exportName: element.propertyName?.text ?? alias,
        moduleSpecifier: statement.moduleSpecifier.text,
      }));
    }
  }
  return selected;
}

function selectedImport(
  values: ReadonlyMap<string, CandidateGeneratedStaticImportV1>,
  alias: string,
  exportName: string,
): CandidateGeneratedStaticImportV1 {
  const selected = values.get(alias);
  if (selected === undefined) fail(`generated source static import is missing ${alias}`);
  if (selected.exportName !== exportName) fail(`generated source static import export mismatch ${alias}`);
  return selected;
}

function aliases(prefix: string, length: number): readonly string[] {
  return Object.freeze(Array.from({ length }, (_, index) => `${prefix}${index}`));
}

function variables(file: ts.SourceFile): ReadonlyMap<string, ts.VariableDeclaration> {
  const selected = new Map<string, ts.VariableDeclaration>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      if (selected.has(name)) fail(`generated source top-level variable is duplicated ${name}`);
      selected.set(name, declaration);
    }
  }
  return selected;
}

function frozenArray(value: ts.Expression | undefined, label: string): ts.ArrayLiteralExpression {
  if (value === undefined
    || !ts.isCallExpression(value)
    || value.arguments.length !== 1
    || !ts.isPropertyAccessExpression(value.expression)
    || !ts.isIdentifier(value.expression.expression)
    || value.expression.expression.text !== "Object"
    || value.expression.name.text !== "freeze"
    || !ts.isArrayLiteralExpression(value.arguments[0]!)) {
    fail(`generated source ${label} must be an exact Object.freeze array`);
  }
  return value.arguments[0];
}

function frozenObject(value: ts.Expression, label: string): ts.ObjectLiteralExpression {
  if (!ts.isCallExpression(value)
    || value.arguments.length !== 1
    || !ts.isPropertyAccessExpression(value.expression)
    || !ts.isIdentifier(value.expression.expression)
    || value.expression.expression.text !== "Object"
    || value.expression.name.text !== "freeze"
    || !ts.isObjectLiteralExpression(value.arguments[0]!)) {
    fail(`generated source ${label} must be an exact Object.freeze object`);
  }
  return value.arguments[0];
}

function propertyMap(value: ts.ObjectLiteralExpression, label: string): ReadonlyMap<string, ts.Expression> {
  const properties = new Map<string, ts.Expression>();
  for (const property of value.properties) {
    if (!ts.isPropertyAssignment(property)
      || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) {
      fail(`generated source ${label} has a non-static property`);
    }
    const name = property.name.text;
    if (properties.has(name)) fail(`generated source ${label} duplicates property ${name}`);
    properties.set(name, property.initializer);
  }
  return properties;
}

function exactIdentifier(value: ts.Expression | undefined, expected: string, label: string): void {
  if (value === undefined || !ts.isIdentifier(value) || value.text !== expected) {
    fail(`generated source ${label} identifier mismatch`);
  }
}

function exactString(value: ts.Expression | undefined, expected: string, label: string): void {
  if (value === undefined || !ts.isStringLiteral(value) || value.text !== expected) {
    fail(`generated source ${label} string mismatch`);
  }
}

function exactIdentifierRow(value: ts.Expression | undefined, expected: readonly string[], label: string): void {
  const row = frozenArray(value, label);
  if (row.elements.length !== expected.length) fail(`generated source ${label} length mismatch`);
  row.elements.forEach((element, index) => exactIdentifier(element, expected[index]!, `${label}[${index}]`));
}

function exactAssembly(
  file: ts.SourceFile,
  familyOrdinal: number,
  extensionAliases: readonly string[],
  actionAliases: readonly string[],
): void {
  const matches = file.statements.filter((statement): statement is ts.VariableStatement =>
    ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && declaration.name.text === "createReleaseFamilyRuntimeComposition"));
  if (matches.length !== 1) fail("generated source release factory declaration is missing or duplicated");
  const statement = matches[0]!;
  if (!statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    || !(statement.declarationList.flags & ts.NodeFlags.Const)) {
    fail("generated source release factory must be an exported const");
  }
  const declaration = statement.declarationList.declarations.find(candidate =>
    ts.isIdentifier(candidate.name) && candidate.name.text === "createReleaseFamilyRuntimeComposition")!;
  const initializer = declaration.initializer;
  if (initializer === undefined
    || !ts.isCallExpression(initializer)
    || !ts.isIdentifier(initializer.expression)
    || initializer.expression.text !== "createGeneratedFamilyRuntimeFactory"
    || initializer.arguments.length !== 1
    || !ts.isObjectLiteralExpression(initializer.arguments[0]!)) {
    fail("generated source release factory assembly is invalid");
  }
  const assembly = propertyMap(initializer.arguments[0], "release factory assembly");
  exactIdentifier(assembly.get("descriptor"), "FAMILY_RUNTIME_DESCRIPTOR", "release descriptor");
  const extensions = assembly.get("extensions");
  const actionOwners = assembly.get("actionOwners");
  const runtimeAdapters = assembly.get("runtimeAdapters");
  if (!extensions || !ts.isArrayLiteralExpression(extensions)
    || !actionOwners || !ts.isArrayLiteralExpression(actionOwners)
    || !runtimeAdapters || !ts.isArrayLiteralExpression(runtimeAdapters)) {
    fail("generated source release adapter assembly arrays are invalid");
  }
  exactIdentifierRow(extensions.elements[familyOrdinal], extensionAliases, `extensions[${familyOrdinal}] assembly`);
  exactIdentifierRow(actionOwners.elements[familyOrdinal], actionAliases, `actionOwners[${familyOrdinal}] assembly`);
  exactIdentifier(runtimeAdapters.elements[familyOrdinal], `FAMILY_RUNTIME_ADAPTERS_${familyOrdinal}`, `runtimeAdapters[${familyOrdinal}] assembly`);
}

/** Strict AST observation of the stable generated top-level composition. */
export function verifyCandidateGeneratedSourceBindingV1(input: Readonly<{
  source: string;
  metadata: GeneratedFamilyRuntimeFactoryMetadataV1;
  familyId: string;
}>): CandidateGeneratedSourceBindingV1 {
  const families = input.metadata.families;
  const familyOrdinal = families.findIndex((family) => family.familyId === input.familyId);
  if (familyOrdinal < 0) fail(`generated metadata family is missing ${input.familyId}`);
  if (families.filter((family) => family.familyId === input.familyId).length !== 1) fail(`generated metadata family is duplicated ${input.familyId}`);
  const family: FamilyMetadata = families[familyOrdinal]!;
  const search = family.runtimeAdapters
    .map((adapter, ordinal) => Object.freeze({ adapter, ordinal }))
    .filter(({ adapter }) => adapter.role === "search/v1");
  if (search.length !== 1) fail(`generated search/v1 descriptor is missing or duplicated ${input.familyId}`);
  const adapterOrdinal = search[0]!.ordinal;
  const adapter = search[0]!.adapter;
  const capabilityRefs = Object.values(adapter.capabilityRefs);
  const actionOwnerRefs = Object.values(adapter.actionOwnerRefs);
  if (capabilityRefs.length !== family.extensions.length
    || new Set(capabilityRefs.map((ref) => JSON.stringify(ref))).size !== capabilityRefs.length
    || capabilityRefs.some((ref) => family.extensions.filter((extension) => JSON.stringify(extension.capabilityRef) === JSON.stringify(ref)).length !== 1)
    || family.extensions.some((extension) => capabilityRefs.filter((ref) => JSON.stringify(extension.capabilityRef) === JSON.stringify(ref)).length !== 1)) {
    fail("generated search/v1 capability imports are missing, duplicated, or cross-family");
  }
  if (actionOwnerRefs.length !== family.actionOwners.length
    || new Set(actionOwnerRefs).size !== actionOwnerRefs.length
    || actionOwnerRefs.some((ref) => family.actionOwners.filter((owner) => owner.ownerRef === ref).length !== 1)
    || family.actionOwners.some((owner) => actionOwnerRefs.filter((ref) => owner.ownerRef === ref).length !== 1)) {
    fail("generated search/v1 action-owner imports are missing or duplicated");
  }

  const file = parseSource(input.source);
  const parsedImports = imports(file);
  const adapterAlias = `FAMILY_${familyOrdinal}_RUNTIME_ADAPTER_${adapterOrdinal}`;
  const adapterImport = selectedImport(parsedImports, adapterAlias, adapter.exportName);
  const extensionAliases = aliases(`FAMILY_${familyOrdinal}_EXTENSION_`, family.extensions.length);
  const actionAliases = aliases(`FAMILY_${familyOrdinal}_ACTION_`, family.actionOwners.length);
  const extensionImports = Object.freeze(family.extensions.map((extension, ordinal) => selectedImport(parsedImports, extensionAliases[ordinal]!, extension.exportName)));
  const actionOwnerImports = Object.freeze(family.actionOwners.map((owner, ordinal) => selectedImport(parsedImports, actionAliases[ordinal]!, owner.exportName)));
  const expectedPublicModule = `../../families/${family.familyId}/src/public.ts`;
  for (const selected of [adapterImport, ...extensionImports, ...actionOwnerImports]) {
    if (selected.moduleSpecifier !== expectedPublicModule) fail(`generated source static import module mismatch ${selected.alias}`);
  }

  const declaration = variables(file).get(`FAMILY_RUNTIME_ADAPTERS_${familyOrdinal}`);
  const rows = frozenArray(declaration?.initializer, `FAMILY_RUNTIME_ADAPTERS_${familyOrdinal}`);
  if (rows.elements.length !== family.runtimeAdapters.length) fail(`generated source FAMILY_RUNTIME_ADAPTERS_${familyOrdinal} length mismatch`);
  family.runtimeAdapters.forEach((descriptor, ordinal) => {
    const row = propertyMap(frozenObject(rows.elements[ordinal]!, `FAMILY_RUNTIME_ADAPTERS_${familyOrdinal}[${ordinal}]`), `FAMILY_RUNTIME_ADAPTERS_${familyOrdinal}[${ordinal}]`);
    if (row.size !== 5) fail(`generated source runtime adapter row ${familyOrdinal}:${ordinal} has extra fields`);
    exactIdentifier(row.get("factory"), `FAMILY_${familyOrdinal}_RUNTIME_ADAPTER_${ordinal}`, "runtime adapter factory");
    exactString(row.get("modulePath"), descriptor.modulePath, "runtime adapter modulePath");
    exactString(row.get("exportName"), descriptor.exportName, "runtime adapter exportName");
    exactString(row.get("closureRoot"), descriptor.closureRoot, "runtime adapter closureRoot");
    exactString(row.get("leafDigest"), descriptor.leafDigest, "runtime adapter leafDigest");
  });
  exactAssembly(file, familyOrdinal, extensionAliases, actionAliases);

  return Object.freeze({ familyOrdinal, adapterOrdinal, adapterImport, extensionImports, actionOwnerImports });
}
