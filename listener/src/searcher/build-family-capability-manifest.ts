import {
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { familyId, type FamilyId } from "./venues/adapter-family-identifiers.js";
import {
  generateAbsentCapabilityIdentity,
  generateCapabilityClosure,
  generateRuntimeSourceClosure,
} from "./venues/capability-content-hash.js";
import {
  FAMILY_CAPABILITIES_BY_DOMAIN,
  FAMILY_CAPABILITY_NAMES,
  type FamilyCapabilityName,
} from "./venues/family-capability-catalog.js";
import {
  createFamilyCapabilityShadowArtifact,
  legacyWholeFamilyShadowObservation,
  serializeFamilyCapabilityShadowArtifact,
  type CapabilityEntryRootReceipt,
  type CapabilityExactShadowRecord,
  type FamilyCapabilityShadowArtifact,
  type FamilyCapabilityShadowBuildIssue,
  type LegacyWholeFamilyShadowObservation,
} from "./venues/family-capability-shadow.js";
import {
  PRODUCTION_ENTRY_PATTERN,
  productionFamilySourceDirectory,
} from "./venues/production-families/tracked-sources.js";
type StrictFamilyDomain = "swap" | "protocol" | "funding" | "credit";

const STRICT_DOMAIN_CONSTRUCTORS: Readonly<
  Record<string, StrictFamilyDomain>
> = Object.freeze({
  defineSwapFamily: "swap",
  defineProtocolFamily: "protocol",
  defineFundingFamily: "funding",
  defineCreditFamily: "credit",
});

export interface BuildFamilyCapabilityShadowOptions {
  readonly rootDirectory: string;
  readonly productionRegistryFile?: string;
  readonly productionDirectory?: string;
  readonly productionEntryFiles?: readonly string[];
  readonly provenanceCommit?: string | null;
}

interface ProgramContext {
  readonly rootDirectory: string;
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly compilerOptions: ts.CompilerOptions;
}

interface DirectImportRoot {
  readonly localName: string;
  readonly exportName: string;
  readonly sourceFile: string;
}

interface LegacyRoot {
  readonly familyId: FamilyId;
  readonly rootSourceFile: string;
  readonly rootExport: string;
  readonly ownedActionAdapterIds: readonly string[];
  readonly actionSourceFiles: readonly string[];
  readonly actionClosureComplete: boolean;
}

interface ActiveActionSource {
  readonly sourceFiles: readonly string[];
}

export async function buildFamilyCapabilityShadowArtifact(
  options: BuildFamilyCapabilityShadowOptions,
): Promise<FamilyCapabilityShadowArtifact> {
  const rootDirectory = resolve(options.rootDirectory);
  const context = loadProgram(rootDirectory);
  const provenanceCommit = options.provenanceCommit ?? null;
  const productionRegistryFile = resolve(
    options.productionRegistryFile ??
      resolve(rootDirectory, "src/searcher/venues/production-registry.ts"),
  );
  const productionDirectory = options.productionDirectory === undefined
    ? productionFamilySourceDirectory(rootDirectory)
    : resolve(options.productionDirectory);
  const productionEntryFiles = options.productionEntryFiles === undefined
    ? (await readdir(productionDirectory, { withFileTypes: true }))
      .filter((entry) =>
        entry.isFile() && PRODUCTION_ENTRY_PATTERN.test(entry.name)
      )
      .map((entry) => resolve(productionDirectory, entry.name))
      .sort()
    : [...options.productionEntryFiles].map((file) => resolve(file)).sort();

  const exact: CapabilityExactShadowRecord[] = [];
  const legacy: LegacyWholeFamilyShadowObservation[] = [];
  const issues: FamilyCapabilityShadowBuildIssue[] = [];
  const activeActionSources = deriveActiveActionSources(context);
  let registryLegacyRoots: readonly LegacyRoot[] = [];

  const registry = context.program.getSourceFile(productionRegistryFile);
  if (registry !== undefined) {
    registryLegacyRoots = legacyRegistryRoots(
      context,
      registry,
      activeActionSources,
      issues,
    );
  } else if (options.productionRegistryFile !== undefined) {
    issues.push(issue(
      repoRelative(rootDirectory, productionRegistryFile),
      "invalid_production_entry",
      "production registry is absent from the TypeScript program",
    ));
  }

  for (const entryFile of productionEntryFiles) {
    const source = context.program.getSourceFile(entryFile);
    const sourceLabel = repoRelative(rootDirectory, entryFile);
    if (source === undefined) {
      issues.push(issue(
        sourceLabel,
        "invalid_production_entry",
        "production entry is absent from the TypeScript program",
      ));
      continue;
    }
    const legacyDeclaration = findVariable(source, "productionFamilyModule");
    const strictDeclaration = findVariable(source, "plugin");
    if ((legacyDeclaration === null) === (strictDeclaration === null)) {
      issues.push(issue(
        sourceLabel,
        "invalid_production_entry",
        "entry must export exactly one of productionFamilyModule or plugin",
      ));
      continue;
    }
    if (legacyDeclaration !== null) {
      const root = legacyProductionModuleRoot(
        context,
        source,
        legacyDeclaration,
        issues,
      );
      if (root !== null) {
        await appendLegacyObservation({
          context,
          root,
          provenanceCommit,
          legacy,
          issues,
        });
      }
      continue;
    }
    const records = await strictProductionRecords({
      context,
      source,
      declaration: strictDeclaration!,
      provenanceCommit,
      issues,
    });
    exact.push(...records);
  }

  // A strict direct-root production entry supersedes its legacy registry
  // shadow. During migration the registry may still carry the old Adapter
  // Family, but generated capability identity is owned by the terminal entry
  // set and must never contain mixed precision for the same Family.
  const exactFamilyIds = new Set(
    exact.map((record) => record.identity.familyId),
  );
  for (const root of registryLegacyRoots) {
    if (exactFamilyIds.has(root.familyId)) continue;
    await appendLegacyObservation({
      context,
      root,
      provenanceCommit,
      legacy,
      issues,
    });
  }

  return createFamilyCapabilityShadowArtifact({ exact, legacy, issues });
}

export interface GeneratedProductionFamilyEntryModule {
  readonly sourceFile: string;
  readonly module: Readonly<Record<string, unknown>>;
}

export function serializeProductionFamilyStaticImports(
  productionEntryFiles: readonly string[],
): string {
  const names = [...productionEntryFiles].sort();
  const imports = names.map((name, index) =>
    `import * as entry${index} from ` +
      `"../venues/production-families/${name.replace(/\.ts$/, ".js")}";`
  );
  const entries = names.map((name, index) =>
    `  Object.freeze({ sourceFile: ${JSON.stringify(name)}, module: entry${index} }),`
  );
  return [
    "// Generated by build-family-capability-manifest.ts. Do not edit.",
    ...imports,
    "",
    "export const GENERATED_PRODUCTION_FAMILY_ENTRIES = Object.freeze([",
    ...entries,
    "]);",
    "",
  ].join("\n");
}

export async function writeProductionFamilyStaticImports(input: {
  readonly productionEntryFiles: readonly string[];
  readonly outputFile: string;
}): Promise<void> {
  await mkdir(dirname(resolve(input.outputFile)), { recursive: true });
  await writeFile(
    resolve(input.outputFile),
    serializeProductionFamilyStaticImports(input.productionEntryFiles),
  );
}

export async function checkProductionFamilyStaticImports(input: {
  readonly productionEntryFiles: readonly string[];
  readonly outputFile: string;
}): Promise<void> {
  const expected = serializeProductionFamilyStaticImports(
    input.productionEntryFiles,
  );
  let actual: string;
  try {
    actual = await readFile(resolve(input.outputFile), "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(
        `generated production Family imports are missing: ${input.outputFile}`,
      );
    }
    throw error;
  }
  if (actual !== expected) {
    throw new Error(
      `generated production Family imports are stale: ${input.outputFile}`,
    );
  }
}

export async function writeFamilyCapabilityShadowArtifact(input: {
  readonly artifact: FamilyCapabilityShadowArtifact;
  readonly outputFile: string;
}): Promise<void> {
  await mkdir(dirname(resolve(input.outputFile)), { recursive: true });
  await writeFile(
    resolve(input.outputFile),
    serializeFamilyCapabilityShadowArtifact(input.artifact),
  );
}

export async function checkFamilyCapabilityShadowArtifact(input: {
  readonly artifact: FamilyCapabilityShadowArtifact;
  readonly outputFile: string;
}): Promise<void> {
  if (!input.artifact.complete) {
    throw new Error(
      `capability shadow is incomplete (${input.artifact.issues.length} issues)`,
    );
  }
  const expected = serializeFamilyCapabilityShadowArtifact(input.artifact);
  let actual: string;
  try {
    actual = await readFile(resolve(input.outputFile), "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(`generated capability artifact is missing: ${input.outputFile}`);
    }
    throw error;
  }
  if (actual !== expected) {
    throw new Error(`generated capability artifact is stale: ${input.outputFile}`);
  }
}

async function strictProductionRecords(input: {
  readonly context: ProgramContext;
  readonly source: ts.SourceFile;
  readonly declaration: ts.VariableDeclaration;
  readonly provenanceCommit: string | null;
  readonly issues: FamilyCapabilityShadowBuildIssue[];
}): Promise<readonly CapabilityExactShadowRecord[]> {
  const sourceLabel = repoRelative(
    input.context.rootDirectory,
    input.source.fileName,
  );
  const initializer = input.declaration.initializer;
  if (
    initializer === undefined ||
    !ts.isCallExpression(unwrapExpression(initializer))
  ) {
    input.issues.push(issue(
      sourceLabel,
      "strict_root_not_direct_import",
      "strict plugin must be assembled by a strict Domain constructor in the production entry",
    ));
    return [];
  }
  const call = unwrapExpression(initializer) as ts.CallExpression;
  if (
    !ts.isIdentifier(call.expression) ||
    STRICT_DOMAIN_CONSTRUCTORS[call.expression.text] === undefined ||
    call.arguments.length !== 1
  ) {
    input.issues.push(issue(
      sourceLabel,
      "strict_root_not_direct_import",
      "strict plugin cannot be preassembled or use an unknown constructor",
    ));
    return [];
  }
  const definition = unwrapObjectLiteral(call.arguments[0]);
  if (definition === null) {
    input.issues.push(issue(
      sourceLabel,
      "strict_root_not_direct_import",
      "strict constructor argument must be an object literal of direct-import bindings",
    ));
    return [];
  }
  const domain = STRICT_DOMAIN_CONSTRUCTORS[call.expression.text]!;
  const capabilities = FAMILY_CAPABILITIES_BY_DOMAIN[domain].filter(
    (capability) => capability !== "victim",
  );
  const semanticKeys = domain === "swap" || domain === "protocol"
    ? [...capabilities, domain]
    : [...capabilities];
  const requiredKeys = [
    "manifest",
    ...semanticKeys,
    "actionAdapters",
  ];
  const properties = objectProperties(definition);
  if (requiredKeys.some((key) => !properties.has(key))) {
    const missing = requiredKeys.filter((key) => !properties.has(key));
    input.issues.push(issue(
      sourceLabel,
      "strict_root_not_direct_import",
      `strict plugin is missing production bindings: ${missing.join(",")}`,
    ));
    return [];
  }

  const roots = new Map<string, DirectImportRoot>();
  for (const key of ["manifest", ...semanticKeys]) {
    const expression = properties.get(key)!;
    if (!ts.isIdentifier(unwrapExpression(expression))) {
      input.issues.push(issue(
        sourceLabel,
        "strict_root_not_direct_import",
        `${key} must be a direct-import identifier, not inline or preassembled code`,
      ));
      return [];
    }
    const root = directImportRoot(
      input.context,
      input.source,
      unwrapExpression(expression) as ts.Identifier,
    );
    if (root === null) {
      input.issues.push(issue(
        sourceLabel,
        "strict_root_not_direct_import",
        `${key} is not a resolvable direct import`,
      ));
      return [];
    }
    roots.set(key, root);
  }

  const semanticRootOwners = new Map<string, string>();
  for (const key of semanticKeys) {
    const root = roots.get(key)!;
    const existing = semanticRootOwners.get(root.sourceFile);
    if (existing !== undefined) {
      input.issues.push(issue(
        sourceLabel,
        "strict_root_shared_module",
        `${existing} and ${key} share ${repoRelative(input.context.rootDirectory, root.sourceFile)}`,
      ));
      return [];
    }
    semanticRootOwners.set(root.sourceFile, key);
  }

  const manifestRoot = roots.get("manifest")!;
  const resolvedFamilyId = readExportedStringProperty(
    input.context,
    manifestRoot,
    "familyId",
  );
  if (resolvedFamilyId === null) {
    input.issues.push(issue(
      sourceLabel,
      "strict_family_id_unresolved",
      "strict manifest familyId is not a statically resolvable string",
    ));
    return [];
  }
  const strictFamilyId = familyId(resolvedFamilyId);
  const actionsExpression = unwrapExpression(properties.get("actionAdapters")!);
  if (!ts.isArrayLiteralExpression(actionsExpression)) {
    input.issues.push(issue(
      sourceLabel,
      "strict_root_not_direct_import",
      "actionAdapters must be an array literal of direct-import identifiers",
    ));
    return [];
  }
  const actionRoots: DirectImportRoot[] = [];
  for (const element of actionsExpression.elements) {
    const expression = unwrapExpression(element as ts.Expression);
    if (!ts.isIdentifier(expression)) {
      input.issues.push(issue(
        sourceLabel,
        "strict_root_not_direct_import",
        "every owned ActionAdapter must be a direct-import identifier",
      ));
      return [];
    }
    const root = directImportRoot(input.context, input.source, expression);
    if (root === null) {
      input.issues.push(issue(
        sourceLabel,
        "strict_root_not_direct_import",
        `ActionAdapter ${expression.text} is not a resolvable direct import`,
      ));
      return [];
    }
    actionRoots.push(root);
  }

  const records: CapabilityExactShadowRecord[] = [];
  try {
    for (const capability of capabilities) {
      const root = roots.get(capability)!;
      const additional = [manifestRoot.sourceFile];
      if (capability === "execution" || capability === "funding") {
        additional.push(...actionRoots.map((action) => action.sourceFile));
      }
      const generated = await generateCapabilityClosure({
        familyId: strictFamilyId,
        capability,
        rootDirectory: input.context.rootDirectory,
        entryFile: root.sourceFile,
        additionalEntryFiles: additional,
        provenanceCommit: input.provenanceCommit,
      });
      records.push(exactRecord(
        generated.identity,
        capability,
        root,
        additional,
        input.context.rootDirectory,
      ));
    }

    if (domain === "swap" || domain === "protocol") {
      const domainRoot = roots.get(domain)!;
      const victimBinding = resolveVictimCapabilityBinding(
        input.context,
        domainRoot,
        domain,
      );
      if (victimBinding.kind === "invalid") {
        input.issues.push(issue(
          sourceLabel,
          "strict_root_not_direct_import",
          victimBinding.message,
        ));
        return [];
      }
      if (victimBinding.kind === "absent") {
        records.push(absentRecord(
          strictFamilyId,
          "victim",
          input.provenanceCommit,
        ));
      } else {
        const victimRoot = victimBinding.root;
        const existingOwner = semanticRootOwners.get(victimRoot.sourceFile);
        if (
          existingOwner !== undefined &&
          victimRoot.sourceFile !== domainRoot.sourceFile
        ) {
          input.issues.push(issue(
            sourceLabel,
            "strict_root_shared_module",
            `${existingOwner} and victim share ${repoRelative(
              input.context.rootDirectory,
              victimRoot.sourceFile,
            )}`,
          ));
          return [];
        }
        const additional = [manifestRoot.sourceFile];
        if (victimRoot.sourceFile !== domainRoot.sourceFile) {
          additional.push(domainRoot.sourceFile);
        }
        const generated = await generateCapabilityClosure({
          familyId: strictFamilyId,
          capability: "victim",
          rootDirectory: input.context.rootDirectory,
          entryFile: victimRoot.sourceFile,
          additionalEntryFiles: additional,
          provenanceCommit: input.provenanceCommit,
        });
        records.push(exactRecord(
          generated.identity,
          "victim",
          victimRoot,
          additional,
          input.context.rootDirectory,
        ));
      }
    }

    const present = new Set(records.map((record) => record.identity.capability));
    for (const capability of FAMILY_CAPABILITY_NAMES) {
      if (!present.has(capability)) {
        records.push(absentRecord(
          strictFamilyId,
          capability,
          input.provenanceCommit,
        ));
      }
    }
  } catch (error) {
    input.issues.push(issue(
      sourceLabel,
      "capability_generation_failed",
      errorMessage(error),
    ));
    return [];
  }
  return Object.freeze(records);
}

function exactRecord(
  identity: CapabilityExactShadowRecord["identity"],
  capability: FamilyCapabilityName,
  root: DirectImportRoot,
  additional: readonly string[],
  rootDirectory: string,
): CapabilityExactShadowRecord {
  const rootReceipt: CapabilityEntryRootReceipt = Object.freeze({
    capability,
    entrySourceFile: repoRelative(rootDirectory, root.sourceFile),
    entryExport: root.exportName,
    additionalSourceFiles: Object.freeze(
      [...new Set(additional)]
        .map((file) => repoRelative(rootDirectory, file))
        .sort(),
    ),
    absence: null,
  });
  return Object.freeze({
    precision: "capability-exact" as const,
    identity,
    root: rootReceipt,
  });
}

function absentRecord(
  strictFamilyId: FamilyId,
  capability: FamilyCapabilityName,
  provenanceCommit: string | null,
): CapabilityExactShadowRecord {
  return Object.freeze({
    precision: "capability-exact" as const,
    identity: generateAbsentCapabilityIdentity({
      familyId: strictFamilyId,
      capability,
      provenanceCommit,
    }),
    root: Object.freeze({
      capability,
      entrySourceFile: null,
      entryExport: null,
      additionalSourceFiles: Object.freeze([]),
      absence: "declared-absent" as const,
    }),
  });
}

function legacyRegistryRoots(
  context: ProgramContext,
  source: ts.SourceFile,
  activeActionSources: ReadonlyMap<string, ActiveActionSource>,
  issues: FamilyCapabilityShadowBuildIssue[],
): readonly LegacyRoot[] {
  const declaration = findVariable(source, "LEGACY_PRODUCTION_ADAPTER_FAMILIES");
  if (declaration?.initializer === undefined) return [];
  const array = firstArrayLiteral(declaration.initializer);
  if (array === null) return [];
  const roots: LegacyRoot[] = [];
  for (const element of array.elements) {
    const expression = unwrapExpression(element as ts.Expression);
    if (!ts.isIdentifier(expression)) continue;
    const root = directImportRoot(context, source, expression);
    if (root === null) {
      issues.push(issue(
        repoRelative(context.rootDirectory, source.fileName),
        "legacy_family_id_unresolved",
        `legacy registry binding ${expression.text} is not a direct import`,
      ));
      continue;
    }
    const id = readExportedStringProperty(context, root, "id");
    if (id === null) {
      issues.push(issue(
        repoRelative(context.rootDirectory, root.sourceFile),
        "legacy_family_id_unresolved",
        `cannot resolve ${root.exportName}.id`,
      ));
      continue;
    }
    const ownedActionAdapterIds = readExportedStringArrayProperty(
      context,
      root,
      "ownedActionAdapterIds",
    ) ?? [];
    const actionSourceFiles = new Set<string>();
    let actionClosureComplete = true;
    for (const actionId of ownedActionAdapterIds) {
      const action = activeActionSources.get(actionId);
      if (action === undefined) {
        actionClosureComplete = false;
        continue;
      }
      for (const file of action.sourceFiles) actionSourceFiles.add(file);
    }
    roots.push({
      familyId: familyId(id),
      rootSourceFile: root.sourceFile,
      rootExport: root.exportName,
      ownedActionAdapterIds,
      actionSourceFiles: Object.freeze([...actionSourceFiles].sort()),
      actionClosureComplete,
    });
  }
  return Object.freeze(roots);
}

function deriveActiveActionSources(
  context: ProgramContext,
): ReadonlyMap<string, ActiveActionSource> {
  const actionIndexPath = resolve(context.rootDirectory, "src/adapters/index.ts");
  const source = context.program.getSourceFile(actionIndexPath);
  if (source === undefined) return new Map();
  const declaration = findVariable(source, "PRODUCTION_ACTION_CATALOG");
  const catalog = declaration?.initializer
    ? firstArrayLiteral(declaration.initializer)
    : null;
  if (catalog === null) return new Map();
  const imports = directNamedImports(context, source);
  const output = new Map<string, ActiveActionSource>();
  const bind = (id: string, sourceFiles: readonly string[]): void => {
    const normalized = Object.freeze([...new Set(sourceFiles)].sort());
    const existing = output.get(id);
    if (
      existing !== undefined &&
      JSON.stringify(existing.sourceFiles) !== JSON.stringify(normalized)
    ) {
      return;
    }
    output.set(id, Object.freeze({ sourceFiles: normalized }));
  };
  for (const element of catalog.elements) {
    if (ts.isIdentifier(element)) {
      const root = imports.get(element.text);
      if (root === undefined) continue;
      const id = readExportedStringProperty(context, root, "id");
      if (id !== null) bind(id, [root.sourceFile]);
      continue;
    }
    if (!ts.isSpreadElement(element)) continue;
    const expression = unwrapExpression(element.expression);
    if (
      !ts.isCallExpression(expression) ||
      !ts.isPropertyAccessExpression(expression.expression) ||
      expression.expression.name.text !== "map" ||
      !ts.isIdentifier(expression.expression.expression) ||
      expression.arguments.length !== 1 ||
      !ts.isIdentifier(expression.arguments[0])
    ) {
      continue;
    }
    const descriptors = imports.get(expression.expression.expression.text);
    const factory = imports.get(expression.arguments[0].text);
    if (descriptors === undefined || factory === undefined) continue;
    for (const id of readExportedArrayObjectStringProperties(
      context,
      descriptors,
      "id",
    )) {
      bind(id, [descriptors.sourceFile, factory.sourceFile]);
    }
  }
  return output;
}

function readExportedArrayObjectStringProperties(
  context: ProgramContext,
  root: DirectImportRoot,
  propertyName: string,
): readonly string[] {
  const initializer = exportedInitializer(context.program, root);
  const array = initializer ? firstArrayLiteral(initializer) : null;
  if (array === null) return [];
  const values = new Set<string>();
  for (const element of array.elements) {
    const object = unwrapObjectLiteral(element as ts.Expression);
    if (object === null) continue;
    const value = objectProperties(object).get(propertyName);
    if (value === undefined) continue;
    const resolved = evaluateStaticString(
      context,
      value,
      object.getSourceFile(),
      new Set(),
    );
    if (resolved !== null) values.add(resolved);
  }
  return Object.freeze([...values].sort());
}

function legacyProductionModuleRoot(
  context: ProgramContext,
  source: ts.SourceFile,
  declaration: ts.VariableDeclaration,
  issues: FamilyCapabilityShadowBuildIssue[],
): LegacyRoot | null {
  const sourceLabel = repoRelative(context.rootDirectory, source.fileName);
  const initializer = declaration.initializer &&
    unwrapExpression(declaration.initializer);
  if (!initializer || !ts.isCallExpression(initializer) ||
      !ts.isIdentifier(initializer.expression) ||
      initializer.expression.text !== "defineProductionFamilyModule" ||
      initializer.arguments.length !== 1) {
    issues.push(issue(
      sourceLabel,
      "invalid_production_entry",
      "legacy production module must directly call defineProductionFamilyModule",
    ));
    return null;
  }
  const object = unwrapObjectLiteral(initializer.arguments[0]);
  if (object === null) {
    issues.push(issue(
      sourceLabel,
      "invalid_production_entry",
      "legacy production module argument must be an object literal",
    ));
    return null;
  }
  const properties = objectProperties(object);
  const familyExpression = properties.get("family");
  const actionsExpression = properties.get("actionAdapters");
  if (!familyExpression || !ts.isIdentifier(unwrapExpression(familyExpression)) ||
      !actionsExpression || !ts.isArrayLiteralExpression(unwrapExpression(actionsExpression))) {
    issues.push(issue(
      sourceLabel,
      "invalid_production_entry",
      "legacy family and actionAdapters must be direct production bindings",
    ));
    return null;
  }
  const familyRoot = directImportRoot(
    context,
    source,
    unwrapExpression(familyExpression) as ts.Identifier,
  );
  if (familyRoot === null) {
    issues.push(issue(
      sourceLabel,
      "legacy_family_id_unresolved",
      "legacy family root is not a direct import",
    ));
    return null;
  }
  const id = readExportedStringProperty(context, familyRoot, "id");
  if (id === null) {
    issues.push(issue(
      sourceLabel,
      "legacy_family_id_unresolved",
      `cannot resolve ${familyRoot.exportName}.id`,
    ));
    return null;
  }
  const actionRoots: DirectImportRoot[] = [];
  for (const element of (unwrapExpression(actionsExpression) as ts.ArrayLiteralExpression).elements) {
    const expression = unwrapExpression(element as ts.Expression);
    if (!ts.isIdentifier(expression)) continue;
    const actionRoot = directImportRoot(context, source, expression);
    if (actionRoot !== null) actionRoots.push(actionRoot);
  }
  return {
    familyId: familyId(id),
    rootSourceFile: familyRoot.sourceFile,
    rootExport: familyRoot.exportName,
    ownedActionAdapterIds: readExportedStringArrayProperty(
      context,
      familyRoot,
      "ownedActionAdapterIds",
    ) ?? [],
    actionSourceFiles: Object.freeze(
      [...new Set(actionRoots.map((root) => root.sourceFile))].sort(),
    ),
    actionClosureComplete: actionRoots.length ===
      (unwrapExpression(actionsExpression) as ts.ArrayLiteralExpression).elements.length,
  };
}

async function appendLegacyObservation(input: {
  readonly context: ProgramContext;
  readonly root: LegacyRoot;
  readonly provenanceCommit: string | null;
  readonly legacy: LegacyWholeFamilyShadowObservation[];
  readonly issues: FamilyCapabilityShadowBuildIssue[];
}): Promise<void> {
  const sourceLabel = repoRelative(
    input.context.rootDirectory,
    input.root.rootSourceFile,
  );
  try {
    const closure = await generateRuntimeSourceClosure({
      rootDirectory: input.context.rootDirectory,
      entryFile: input.root.rootSourceFile,
      additionalEntryFiles: input.root.actionSourceFiles,
    });
    const actionComplete = input.root.ownedActionAdapterIds.length === 0 ||
      input.root.actionClosureComplete;
    const missing = actionComplete ? [] : ["owned-action-adapters"];
    input.legacy.push(legacyWholeFamilyShadowObservation({
      familyId: input.root.familyId,
      rootSourceFile: sourceLabel,
      rootExport: input.root.rootExport,
      closure,
      ownedActionAdapterIds: input.root.ownedActionAdapterIds,
      closureCompleteness: actionComplete ? "complete" : "family-source-only",
      missingSemanticSurfaces: missing,
      manualAdapterSchemaRevision: uniqueStringProperty(
        input.context.program.getSourceFile(input.root.rootSourceFile),
        "adapterSchemaRevision",
      ),
      manualSnapshotCompatibilityRevision: uniqueStringProperty(
        input.context.program.getSourceFile(input.root.rootSourceFile),
        "snapshotCompatibilityRevision",
      ),
      provenanceCommit: input.provenanceCommit,
    }));
    if (!actionComplete) {
      input.issues.push(issue(
        sourceLabel,
        "legacy_action_closure_incomplete",
        `${input.root.familyId} whole-Family observation excludes ` +
          input.root.ownedActionAdapterIds.join(","),
      ));
    }
  } catch (error) {
    input.issues.push(issue(
      sourceLabel,
      "capability_generation_failed",
      errorMessage(error),
    ));
  }
}

function directImportRoot(
  context: ProgramContext,
  source: ts.SourceFile,
  identifier: ts.Identifier,
): DirectImportRoot | null {
  const imports = directNamedImports(context, source);
  return imports.get(identifier.text) ?? null;
}

function directNamedImports(
  context: ProgramContext,
  source: ts.SourceFile,
): ReadonlyMap<string, DirectImportRoot> {
  const imports = new Map<string, DirectImportRoot>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    const resolved = ts.resolveModuleName(
      statement.moduleSpecifier.text,
      source.fileName,
      context.compilerOptions,
      ts.sys,
    ).resolvedModule;
    if (resolved === undefined) continue;
    const sourceFile = resolve(resolved.resolvedFileName);
    for (const element of statement.importClause.namedBindings.elements) {
      if (element.isTypeOnly || statement.importClause.isTypeOnly) continue;
      const alias = context.checker.getSymbolAtLocation(element.name);
      if (alias === undefined || !(alias.flags & ts.SymbolFlags.Alias)) continue;
      const target = context.checker.getAliasedSymbol(alias);
      if (
        !target.declarations?.some((declaration) =>
          resolve(declaration.getSourceFile().fileName) === sourceFile
        )
      ) {
        continue;
      }
      imports.set(element.name.text, {
        localName: element.name.text,
        exportName: element.propertyName?.text ?? element.name.text,
        sourceFile,
      });
    }
  }
  return imports;
}

function readExportedStringProperty(
  context: ProgramContext,
  root: DirectImportRoot,
  propertyName: string,
): string | null {
  const initializer = exportedInitializer(context.program, root);
  const object = initializer && unwrapObjectLiteral(initializer);
  if (object === null) return null;
  const value = objectProperties(object).get(propertyName);
  return value === undefined
    ? null
    : evaluateStaticString(context, value, object.getSourceFile(), new Set());
}

function readExportedStringArrayProperty(
  context: ProgramContext,
  root: DirectImportRoot,
  propertyName: string,
): readonly string[] | null {
  const initializer = exportedInitializer(context.program, root);
  const object = initializer && unwrapObjectLiteral(initializer);
  if (object === null) return null;
  const value = objectProperties(object).get(propertyName);
  if (value === undefined) return null;
  const expression = unwrapExpression(value);
  if (!ts.isArrayLiteralExpression(expression)) return null;
  const strings: string[] = [];
  for (const element of expression.elements) {
    const item = evaluateStaticString(
      context,
      element as ts.Expression,
      object.getSourceFile(),
      new Set(),
    );
    if (item === null) return null;
    strings.push(item);
  }
  return Object.freeze(strings);
}

function exportedInitializer(
  program: ts.Program,
  root: DirectImportRoot,
): ts.Expression | null {
  const source = program.getSourceFile(root.sourceFile);
  if (source === undefined) return null;
  return findVariable(source, root.exportName)?.initializer ?? null;
}

type VictimCapabilityBinding =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly root: DirectImportRoot }
  | { readonly kind: "invalid"; readonly message: string };

function resolveVictimCapabilityBinding(
  context: ProgramContext,
  root: DirectImportRoot,
  domain: "swap" | "protocol",
): VictimCapabilityBinding {
  const initializer = exportedInitializer(context.program, root);
  const object = initializer && unwrapObjectLiteral(initializer);
  if (object === null) {
    return {
      kind: "invalid",
      message: `${domain} semantics root is not a resolvable object`,
    };
  }
  const properties = objectProperties(object);
  if (domain === "protocol") {
    return properties.has("oracleVictim")
      ? directVictimBinding(context, object.getSourceFile(), properties, "oracleVictim")
      : { kind: "absent" };
  }
  const support = properties.get("victimSupport");
  const mode = support === undefined
    ? null
    : evaluateStaticString(context, support, object.getSourceFile(), new Set());
  switch (mode) {
    case "none":
      return { kind: "absent" };
    case "detect-only":
      return { kind: "present", root };
    case "local-apply":
      return directVictimBinding(
        context,
        object.getSourceFile(),
        properties,
        "localApply",
      );
    case "overlay":
      return directVictimBinding(
        context,
        object.getSourceFile(),
        properties,
        "overlay",
      );
    case "replay":
      return directVictimBinding(
        context,
        object.getSourceFile(),
        properties,
        "replay",
      );
    default:
      return {
        kind: "invalid",
        message: "swap victimSupport is not statically resolvable",
      };
  }
}

function directVictimBinding(
  context: ProgramContext,
  source: ts.SourceFile,
  properties: ReadonlyMap<string, ts.Expression>,
  property: "localApply" | "overlay" | "replay" | "oracleVictim",
): VictimCapabilityBinding {
  const expression = properties.get(property);
  if (expression === undefined || !ts.isIdentifier(unwrapExpression(expression))) {
    return {
      kind: "invalid",
      message: `${property} victim semantics must be a direct-import identifier`,
    };
  }
  const root = directImportRoot(
    context,
    source,
    unwrapExpression(expression) as ts.Identifier,
  );
  return root === null
    ? {
        kind: "invalid",
        message: `${property} victim semantics is not a resolvable direct import`,
      }
    : { kind: "present", root };
}

function evaluateStaticString(
  context: ProgramContext,
  expression: ts.Expression,
  source: ts.SourceFile,
  seen: Set<ts.Symbol>,
): string | null {
  const value = unwrapExpression(expression);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isCallExpression(value) && value.arguments.length > 0) {
    return evaluateStaticString(
      context,
      value.arguments[0],
      source,
      seen,
    );
  }
  if (!ts.isIdentifier(value)) return null;
  let symbol = context.checker.getSymbolAtLocation(value);
  if (symbol === undefined) return null;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = context.checker.getAliasedSymbol(symbol);
  }
  if (seen.has(symbol)) return null;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined
    ) {
      const resolved = evaluateStaticString(
        context,
        declaration.initializer,
        declaration.getSourceFile(),
        seen,
      );
      if (resolved !== null) return resolved;
    }
    if (
      ts.isPropertyAssignment(declaration) ||
      ts.isShorthandPropertyAssignment(declaration)
    ) {
      const initializer = ts.isPropertyAssignment(declaration)
        ? declaration.initializer
        : declaration.name;
      const resolved = evaluateStaticString(
        context,
        initializer,
        declaration.getSourceFile(),
        seen,
      );
      if (resolved !== null) return resolved;
    }
  }
  void source;
  return null;
}

function findVariable(
  source: ts.SourceFile,
  name: string,
): ts.VariableDeclaration | null {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration;
      }
    }
  }
  return null;
}

function firstArrayLiteral(expression: ts.Expression): ts.ArrayLiteralExpression | null {
  const value = unwrapExpression(expression);
  if (ts.isArrayLiteralExpression(value)) return value;
  let found: ts.ArrayLiteralExpression | null = null;
  ts.forEachChild(value, (child) => {
    if (found !== null) return;
    if (ts.isExpression(child)) found = firstArrayLiteral(child);
  });
  return found;
}

function unwrapObjectLiteral(expression: ts.Expression): ts.ObjectLiteralExpression | null {
  const value = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(value)) return value;
  if (ts.isCallExpression(value) && value.arguments.length > 0) {
    return unwrapObjectLiteral(value.arguments[0]);
  }
  return null;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let value = expression;
  for (;;) {
    if (
      ts.isParenthesizedExpression(value) ||
      ts.isAsExpression(value) ||
      ts.isTypeAssertionExpression(value) ||
      ts.isNonNullExpression(value) ||
      ts.isSatisfiesExpression(value)
    ) {
      value = value.expression;
      continue;
    }
    return value;
  }
}

function objectProperties(
  object: ts.ObjectLiteralExpression,
): ReadonlyMap<string, ts.Expression> {
  const properties = new Map<string, ts.Expression>();
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = propertyName(property.name);
      if (name !== null) properties.set(name, property.initializer);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      properties.set(property.name.text, property.name);
    }
  }
  return properties;
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ||
      ts.isNumericLiteral(name)
    ? name.text
    : null;
}

function uniqueStringProperty(
  source: ts.SourceFile | undefined,
  propertyName: string,
): string | null {
  if (source === undefined) return null;
  const values = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      propertyName === (propertyNameOfNode(node.name)) &&
      ts.isStringLiteralLike(unwrapExpression(node.initializer))
    ) {
      values.add((unwrapExpression(node.initializer) as ts.StringLiteralLike).text);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return values.size === 1 ? [...values][0] : null;
}

function propertyNameOfNode(name: ts.PropertyName): string | null {
  return propertyName(name);
}

function loadProgram(rootDirectory: string): ProgramContext {
  const configPath = ts.findConfigFile(rootDirectory, ts.sys.fileExists);
  let compilerOptions: ts.CompilerOptions;
  let fileNames: string[];
  if (configPath === undefined) {
    compilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.Node16,
      moduleResolution: ts.ModuleResolutionKind.Node16,
      strict: true,
    };
    fileNames = ts.sys.readDirectory(rootDirectory, [".ts", ".tsx"]);
  } else {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error !== undefined) {
      throw new Error(
        ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
      );
    }
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      dirname(configPath),
      undefined,
      configPath,
    );
    if (parsed.errors.length > 0) {
      throw new Error(
        ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, "\n"),
      );
    }
    compilerOptions = parsed.options;
    fileNames = parsed.fileNames;
  }
  const program = ts.createProgram(fileNames, compilerOptions);
  return {
    rootDirectory,
    program,
    checker: program.getTypeChecker(),
    compilerOptions,
  };
}

function issue(
  sourceFile: string,
  code: FamilyCapabilityShadowBuildIssue["code"],
  message: string,
): FamilyCapabilityShadowBuildIssue {
  return Object.freeze({ sourceFile, code, message });
}

function repoRelative(rootDirectory: string, file: string): string {
  return relative(rootDirectory, file).split(sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === "object" &&
    "code" in error && (error as { readonly code?: string }).code === "ENOENT";
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args.includes("--check") ? "check" :
    args.includes("--write") ? "write" : null;
  if (mode === null || (args.includes("--check") && args.includes("--write"))) {
    throw new Error("use exactly one of --write or --check");
  }
  const rootDirectory = resolve(argumentValue(args, "--root") ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  const outputFile = resolve(argumentValue(args, "--out") ??
    resolve(
      rootDirectory,
      "src/searcher/generated/family-capability-shadow.generated.json",
    ));
  const staticImportsFile = resolve(argumentValue(args, "--static-out") ??
    resolve(
      rootDirectory,
      "src/searcher/generated/production-family-entries.generated.ts",
    ));
  const provenanceCommit = argumentValue(args, "--provenance") ?? null;
  const productionDirectory = productionFamilySourceDirectory(rootDirectory);
  const productionEntryFiles = (await readdir(productionDirectory, {
    withFileTypes: true,
  }))
    .filter((entry) =>
      entry.isFile() && PRODUCTION_ENTRY_PATTERN.test(entry.name)
    )
    .map((entry) => entry.name)
    .sort();
  const artifact = await buildFamilyCapabilityShadowArtifact({
    rootDirectory,
    productionDirectory,
    provenanceCommit,
  });
  if (mode === "write") {
    await writeFamilyCapabilityShadowArtifact({ artifact, outputFile });
    await writeProductionFamilyStaticImports({
      productionEntryFiles,
      outputFile: staticImportsFile,
    });
    if (!artifact.complete) {
      throw new Error(
        `wrote incomplete capability shadow with ${artifact.issues.length} issues`,
      );
    }
  } else {
    await checkFamilyCapabilityShadowArtifact({ artifact, outputFile });
    await checkProductionFamilyStaticImports({
      productionEntryFiles,
      outputFile: staticImportsFile,
    });
  }
}

function argumentValue(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  runCli().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
