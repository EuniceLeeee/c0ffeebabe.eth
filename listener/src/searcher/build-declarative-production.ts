import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { FAMILY_CAPABILITY_APPLICABILITY, type FamilyDomain } from "./venues/adapter-family-plugin.js";
import { productionFamilySourceDirectory } from "./venues/production-families/tracked-sources.js";
import { renderDeclarativeFamilyTypes, validateDeclarativeTypeMetadata } from "./venues/declarative-types.js";
import { protocolModuleCatalog, readProtocolModules } from "./venues/declarative-protocol-modules.js";

const MARKER = "// Generated from Family JSON by build-declarative-production.ts. Do not edit.";
const CONSTRUCTORS = { swap: "defineSwapFamily", protocol: "defineProtocolFamily", funding: "defineFundingFamily", credit: "defineCreditFamily" } as const;
type Binding = { readonly module: string; readonly export: string };
type Declaration = {
  readonly domain: FamilyDomain;
  readonly activation: { readonly enabled: boolean; readonly envKey: string };
  readonly bindings: Readonly<Record<string, Binding>>;
  readonly actionAdapters: readonly Binding[];
};
export interface DeclarativeProductionEntry {
  readonly format: "bindings-v1" | "protocol-json-v2";
  readonly definitionFile: string;
  readonly entryFile: string;
  readonly familyId: string;
  readonly domain: FamilyDomain;
  readonly source: string;
  /** Build-validated static data and compiler roots. Runtime never loads paths. */
  readonly dependencyFiles: readonly string[];
  readonly childFiles: readonly string[];
  readonly ownedActionAdapterIds: readonly string[];
  readonly typesFile?: string;
}
function object(value: unknown, label: string): Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, any>;
}
function keys(value: Record<string, unknown>, expected: readonly string[], label: string) {
  if (Object.keys(value).some(key => !expected.includes(key)) || expected.some(key => !Object.hasOwn(value, key)))
    throw new Error(`${label} has missing or unknown keys`);
}
function localPath(root: string, path: string): string {
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== path)
    throw new Error("declarative production path escaped source directory");
  return rel.split(sep).join("/");
}
function binding(value: unknown): Binding {
  const b = object(value, "production binding");
  keys(b, ["module", "export"], "production binding");
  if (typeof b.module !== "string" || !/^(?:\.\/|\.\.\/)[a-zA-Z0-9_./-]+\.js$/.test(b.module) ||
      typeof b.export !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(b.export) || ["default", "__proto__", "constructor", "prototype"].includes(b.export))
    throw new Error("production bindings require a relative source module and named export");
  return b as Binding;
}

function dataOnly(value: unknown): void {
  if (value === undefined || typeof value === "function" || typeof value === "bigint" ||
      typeof value === "symbol" || (typeof value === "number" && !Number.isSafeInteger(value)))
    throw new Error("Family definition must contain lossless JSON data");
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("forbidden definition key");
    if (["module", "export", "handler"].includes(key))
      throw new Error("declarative protocol cannot reference TypeScript handlers");
    dataOnly(child);
  }
}

/** Validate the authored format here; the shared compiler alone expands and
 * interprets its semantics. Ordinary evidence fields named binding are data. */
function variantDeclaration(child: Record<string, any>): void {
  // A child can depend on a root module; validate its own fields here and
  // resolve inherited capabilities in the common production compiler.
  if (Object.hasOwn(child, "modules")) protocolModuleCatalog().read(child.modules);
  if (!Object.hasOwn(child, "admission")) {
    object(child.identity, "variant identity"); // Existing expanded v2 declarations.
    return;
  }
  if (Object.hasOwn(child, "identity") || Object.hasOwn(child, "programs"))
    throw new Error("authored variant cannot mix admission with expanded identity/programs");
  const admission = object(child.admission, "variant admission");
  if (admission.version !== 1) throw new Error("unsupported variant admission version");
  for (const name of ["match", "surface", "dependencies", "active"]) {
    const stage = object(admission[name], `variant admission ${name}`);
    if (!Array.isArray(stage.reads) || Object.hasOwn(stage, "requests"))
      throw new Error("authored admission stages require declared reads");
  }
  object(child.models, "variant models");
  const requestSets = object(child.requestSets, "variant request sets");
  if (Object.values(requestSets).some(value => !Array.isArray(value)))
    throw new Error("variant request sets must contain read arrays");
  const reads = object(child.readPrograms, "variant read programs");
  for (const read of Object.values(reads))
    keys(object(read, "variant read program"), ["requests", "result"], "variant read program");
}

function uniqueIds(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !/^[a-z0-9][a-z0-9:._-]*$/.test(id)) ||
      new Set(value).size !== value.length) throw new Error(`invalid ${label}`);
  return value;
}

function renderProtocolEntry(input: {
  root: string; sourceRoot: string; definitionFile: string; entryFile: string;
  doc: Record<string, any>; activation: Record<string, any>;
}): DeclarativeProductionEntry {
  const { root, sourceRoot, definitionFile, entryFile, doc, activation } = input;
  dataOnly(doc);
  const required = ["version", "scope", "production", "manifest", "discovery", "identity", "instance", "routes",
    "pricing", "protocol", "standard", "actionAdapters", "variantFiles"];
  keys(doc, [...required, ...(Object.hasOwn(doc, "types") ? ["types"] : []), ...(Object.hasOwn(doc, "modules") ? ["modules"] : [])], "declarative protocol");
  readProtocolModules(doc.modules, doc.standard.modules);
  if (Object.hasOwn(doc, "types")) {
    validateDeclarativeTypeMetadata(doc.types);
    const contracts = object(doc.types.contracts, "protocol type contracts");
    keys(contracts, ["candidate", "identity", "descriptor", "route", "pricingDraft", "pricingDescriptor", "pricingStatic", "exactEvidence",
      ...(Object.hasOwn(contracts, "identityEvidence") ? ["identityEvidence"] : [])], "protocol type contracts");
  }
  if (doc.production.domain !== "protocol") throw new Error("declarative v2 supports protocol domain only");
  for (const key of ["manifest", "discovery", "identity", "instance", "routes", "pricing", "protocol", "standard"])
    object(doc[key], `${key} declaration`);
  const manifest = doc.manifest;
  if (manifest.familyId !== doc.scope.family || manifest.domain !== "protocol")
    throw new Error("JSON Family/domain disagrees with its semantic manifest");
  const ownedActionAdapterIds = uniqueIds(manifest.ownedActionAdapterIds, "owned action IDs");
  uniqueIds(manifest.requiredInfraActionAdapterIds, "infrastructure action IDs");
  const lineages = uniqueIds(manifest.supportedLineages, "supported lineages");
  if (lineages.length === 0 || ownedActionAdapterIds.length === 0) throw new Error("protocol requires actions and lineages");
  if (typeof doc.standard.id !== "string" || typeof doc.standard.lineageId !== "string" ||
      !lineages.includes(doc.standard.lineageId)) throw new Error("invalid standard variant identity/lineage");
  for (const key of ["abi", "constants", "expressions", "pricing", "exact", "readPrograms", "execution"])
    object(doc.standard[key], `standard ${key}`);
  object(doc.discovery.definition, "discovery definition");
  object(doc.identity.definition, "identity definition");
  if (!Array.isArray(doc.actionAdapters)) throw new Error("production actionAdapters must be an array");
  const actions = doc.actionAdapters.map((value: unknown) => {
    const action = object(value, "action declaration");
    const descriptor = object(action.descriptor, "action descriptor");
    return descriptor.adapterId;
  });
  uniqueIds(actions, "action descriptor IDs");
  if (JSON.stringify([...actions].sort()) !== JSON.stringify([...ownedActionAdapterIds].sort()))
    throw new Error("declared actions disagree with manifest owned actions");
  if (Object.hasOwn(doc.protocol, "oracleVictim")) throw new Error("v2 protocol victim semantics are not declared by this compiler");
  if (!Array.isArray(doc.variantFiles) || doc.variantFiles.some((name: unknown) =>
    typeof name !== "string" || !/^\.\/[a-z0-9][a-z0-9-]*\.json$/.test(name)))
    throw new Error("variants must be same-directory static JSON references");
  const childFiles = doc.variantFiles.map((name: string) => resolve(dirname(definitionFile), name));
  if (childFiles.includes(definitionFile) || new Set(childFiles).size !== childFiles.length)
    throw new Error("duplicate or cyclic child JSON reference");
  if (lineages.length !== childFiles.length + 1) throw new Error("variant references do not cover declared lineages");
  const compiler = resolve(root, "src/searcher/venues/declarative-protocol.ts");
  const relativeImport = (file: string) => {
    localPath(sourceRoot, file);
    const path = relative(dirname(entryFile), file).split(sep).join("/");
    return path.startsWith(".") ? path : `./${path}`;
  };
  const typesFile = Object.hasOwn(doc, "types") ? resolve(root, "src/searcher/generated/declarative-family-types",
    basename(definitionFile).replace(/\.json$/, ".generated.ts")) : undefined;
  const source = [MARKER, `// Definition: ${localPath(root, definitionFile)}`,
    '// Regenerate with: npm run family-capability-manifest:generate',
    'import { defineFamilyActivation } from "./activation.js";',
    'import { defineProtocolFamily } from "../adapter-family-plugin.js";',
    `import { compileDeclarativeProtocol } from ${JSON.stringify(relativeImport(compiler).replace(/\.ts$/, ".js"))};`,
    ...(typesFile ? [`import type { FamilyTypes } from ${JSON.stringify(relativeImport(typesFile).replace(/\.ts$/, ".js"))};`] : []),
    `import definition from ${JSON.stringify(relativeImport(definitionFile))};`,
    ...childFiles.map((file: string, index: number) => `import child${index} from ${JSON.stringify(relativeImport(file))};`),
    "", `export const activation = defineFamilyActivation(${JSON.stringify(activation)});`, "",
    `export const plugin = defineProtocolFamily(compileDeclarativeProtocol${typesFile ? "<FamilyTypes>" : ""}(definition, [${childFiles.map((_file: string, index: number) => `child${index}`).join(", ")}]));`, "",
  ].join("\n");
  return Object.freeze({ format: "protocol-json-v2", definitionFile, entryFile, familyId: doc.scope.family,
    domain: "protocol", source, childFiles: Object.freeze(childFiles), ownedActionAdapterIds: Object.freeze([...ownedActionAdapterIds]),
    ...(typesFile ? { typesFile } : {}),
    dependencyFiles: Object.freeze([definitionFile, ...childFiles, compiler, resolve(root, "src/searcher/build-declarative-production.ts"),
      ...(typesFile ? [resolve(root, "src/searcher/venues/declarative-types.ts")] : [])]) });
}
export function renderDeclarativeProductionEntry(input: {
  rootDirectory: string; definitionFile: string; productionDirectory?: string; document: unknown;
}): DeclarativeProductionEntry {
  const root = resolve(input.rootDirectory), sourceRoot = resolve(root, "src");
  const definitionFile = resolve(input.definitionFile);
  localPath(sourceRoot, definitionFile);
  const stem = basename(dirname(definitionFile)).replace(/-family$/, "");
  if (!dirname(definitionFile).endsWith("-family") || !/^[a-z0-9][a-z0-9-]*$/.test(stem) || basename(definitionFile) !== `${stem}.json`)
    throw new Error("production definition must be <name>-family/<name>.json");
  const doc = object(input.document, "Family definition"), scope = object(doc.scope, "Family scope");
  if (typeof scope.family !== "string" || !/^[a-z0-9][a-z0-9:-]*$/.test(scope.family)) throw new Error("Family scope requires a family ID");
  const p = object(doc.production, "production");
  keys(p, ["domain", "activation"], "production");
  if (doc.version !== 1 && doc.version !== 2) throw new Error("unsupported production definition version");
  if (typeof p.domain !== "string" || !Object.hasOwn(CONSTRUCTORS, p.domain)) throw new Error("unknown production domain");
  const domain = p.domain as FamilyDomain;
  const activation = object(p.activation, "production activation");
  keys(activation, ["enabled", "envKey"], "production activation");
  if (typeof activation.enabled !== "boolean" || typeof activation.envKey !== "string" ||
      !/^SEARCHER_FAMILY_[A-Z0-9_]+_ENABLED$/.test(activation.envKey)) throw new Error("invalid production activation");
  const entryFile = resolve(input.productionDirectory ?? productionFamilySourceDirectory(root), `${stem}.production.ts`);
  localPath(sourceRoot, entryFile);
  if (doc.version === 2) return renderProtocolEntry({ root, sourceRoot, definitionFile, entryFile, doc, activation });
  const slots = FAMILY_CAPABILITY_APPLICABILITY[domain];
  const allowed = ["version", "scope", "production", ...Object.keys(slots)];
  if (Object.keys(doc).some(key => !allowed.includes(key))) throw new Error("unknown Family definition block");
  const bindings: Record<string, Binding> = {};
  for (const key of Object.keys(slots).filter(key => key !== "actionAdapters" && Object.hasOwn(doc, key))) {
    const block = object(doc[key], `${key} block`);
    if (!Object.hasOwn(block, "binding") || Object.keys(block).some(name => !(key === "discovery" || key === "identity" ? ["binding", "definition"] : ["binding"]).includes(name)))
      throw new Error(`invalid ${key} definition block`);
    bindings[key] = binding(block.binding);
  }
  for (const [key, value] of Object.entries(bindings)) {
    if (!Object.hasOwn(slots, key) || key === "actionAdapters" || slots[key as keyof typeof slots] === "never")
      throw new Error(`unsupported ${domain} production binding: ${key}`);
    binding(value);
  }
  for (const [key, requirement] of Object.entries(slots)) {
    if (requirement === "required" && key !== "actionAdapters" && !Object.hasOwn(bindings, key))
      throw new Error(`missing ${domain} production binding: ${key}`);
  }
  if (!Array.isArray(doc.actionAdapters)) throw new Error("production actionAdapters must be an array");
  doc.actionAdapters.forEach(binding);
  const declarations: Declaration = { domain, activation: activation as Declaration["activation"], bindings, actionAdapters: doc.actionAdapters };
  const imports: string[] = [], assignments: string[] = [];
  function importBinding(b: Binding, alias: string): void {
    const module = resolve(dirname(definitionFile), b.module);
    localPath(sourceRoot, module);
    let path = relative(dirname(entryFile), module).split(sep).join("/");
    if (!path.startsWith(".")) path = `./${path}`;
    imports.push(`import { ${b.export} as ${alias} } from ${JSON.stringify(path)};`);
  }
  for (const key of Object.keys(bindings).sort()) {
    importBinding(bindings[key], `binding_${key}`);
    assignments.push(`  ${key}: binding_${key},`);
  }
  declarations.actionAdapters.forEach((b, i) => importBinding(b, `action${i}`));
  const source = [MARKER, `// Definition: ${localPath(root, definitionFile)}`,
    '// Regenerate with: npm run family-capability-manifest:generate',
    'import { defineFamilyActivation } from "./activation.js";',
    `import { ${CONSTRUCTORS[domain]} } from "../adapter-family-plugin.js";`,
    ...imports, "", `export const activation = defineFamilyActivation(${JSON.stringify(activation)});`, "",
    `export const plugin = ${CONSTRUCTORS[domain]}({`, ...assignments,
    `  actionAdapters: [${declarations.actionAdapters.map((_b, i) => `action${i}`).join(", ")}],`, "});", ""].join("\n");
  return Object.freeze({ format: "bindings-v1", definitionFile, entryFile, familyId: scope.family, domain, source,
    childFiles: Object.freeze([]), ownedActionAdapterIds: Object.freeze([]),
    dependencyFiles: Object.freeze([definitionFile, resolve(root, "src/searcher/build-declarative-production.ts")]) });
}

/** Build-time only. Runtime keeps the existing generated static imports and
 * domain constructors; JSON cannot import code dynamically or issue authority. */
export async function syncDeclarativeProductionEntries(input: {
  rootDirectory: string; productionDirectory?: string; mode: "write" | "check";
}): Promise<ReadonlyMap<string, DeclarativeProductionEntry>> {
  const root = resolve(input.rootDirectory), sourceRoot = resolve(root, "src");
  const productionDirectory = resolve(input.productionDirectory ?? productionFamilySourceDirectory(root));
  const entries = new Map<string, DeclarativeProductionEntry>(), familyIds = new Set<string>();
  const typeArtifacts = new Map<string, string>();
  async function regular(path: string): Promise<void> {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`production source must be a regular file: ${path}`);
    localPath(await realpath(sourceRoot), await realpath(path));
    // Reject links in ancestor directories as well as at the leaf. A static
    // child reference must identify the exact on-disk file in this source tree.
    let current = dirname(path);
    while (current !== sourceRoot) {
      localPath(sourceRoot, current);
      if ((await lstat(current)).isSymbolicLink()) throw new Error("production source ancestor must not be a symlink");
      current = dirname(current);
    }
  }
  async function generatedParent(path: string): Promise<void> {
    let current = dirname(path);
    while (current !== sourceRoot) {
      localPath(sourceRoot, current);
      try {
        const stat = await lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("generated type ancestor must be a directory, not a symlink");
        localPath(await realpath(sourceRoot), await realpath(current));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      current = dirname(current);
    }
  }
  async function visit(directory: string): Promise<void> {
    let children;
    try { children = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!child.isDirectory()) continue; // Never traverse symlinks.
      const path = resolve(directory, child.name);
      if (!child.name.endsWith("-family")) { await visit(path); continue; }
      const definitionFile = resolve(path, `${child.name.slice(0, -7)}.json`);
      let text;
      try { await regular(definitionFile); text = await readFile(definitionFile, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const document = JSON.parse(text);
      if (!Object.hasOwn(object(document, "Family definition"), "production")) continue;
      const entry = renderDeclarativeProductionEntry({ rootDirectory: root, productionDirectory, definitionFile, document });
      if (entries.has(entry.entryFile) || familyIds.has(entry.familyId)) throw new Error("duplicate declarative production entry or Family ID");
      if (entry.format === "protocol-json-v2") {
        const ids = new Set<string>([document.standard.id]), lineages = new Set<string>([document.standard.lineageId]);
        const childTypes: unknown[] = [];
        for (const childFile of entry.childFiles) {
          await regular(childFile);
          const child = object(JSON.parse(await readFile(childFile, "utf8")), "variant JSON");
          dataOnly(child);
          if (Object.hasOwn(child, "variantFiles") || Object.hasOwn(child, "production"))
            throw new Error("nested or cyclic variant JSON references are unsupported");
          if (child.version !== 1 || typeof child.id !== "string" || typeof child.lineageId !== "string" ||
              !document.manifest.supportedLineages.includes(child.lineageId) || ids.has(child.id) || lineages.has(child.lineageId))
            throw new Error("invalid or duplicate variant identity/lineage");
          variantDeclaration(child);
          if (Object.hasOwn(child, "types")) {
            if (!entry.typesFile) throw new Error("child type metadata requires a root type declaration");
            childTypes.push(child.types);
          }
          ids.add(child.id); lineages.add(child.lineageId);
        }
        if (entry.typesFile) typeArtifacts.set(entry.typesFile, renderDeclarativeFamilyTypes(document.types, childTypes));
        for (const dependency of entry.dependencyFiles) await regular(dependency);
      } else {
        const references = Object.keys(FAMILY_CAPABILITY_APPLICABILITY[entry.domain])
          .filter(key => key !== "actionAdapters" && Object.hasOwn(document, key))
          .map(key => binding(document[key].binding));
        for (const b of [...references, ...document.actionAdapters as Binding[]])
          await regular(resolve(path, b.module.replace(/\.js$/, ".ts")));
      }
      entries.set(entry.entryFile, entry); familyIds.add(entry.familyId);
    }
  }
  await visit(resolve(root, "src/searcher/venues"));
  // Removed declarations must not leave an old generated module enabled.
  for (const file of await readdir(productionDirectory).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[]; throw error;
  })) {
    if (!file.endsWith(".production.ts")) continue;
    const path = resolve(productionDirectory, file);
    await regular(path);
    if ((await readFile(path, "utf8")).startsWith(MARKER) && !entries.has(path))
      throw new Error(`orphaned declarative production entry: ${path}`);
  }
  if (entries.size > 0) localPath(await realpath(sourceRoot), await realpath(productionDirectory));
  const pending: DeclarativeProductionEntry[] = [];
  for (const entry of entries.values()) {
    let current: string | undefined;
    try { await regular(entry.entryFile); current = await readFile(entry.entryFile, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current !== undefined && !current.startsWith(MARKER)) throw new Error(`refusing to overwrite a handwritten production entry: ${entry.entryFile}`);
    if (current !== entry.source) {
      if (input.mode === "check") throw new Error(`declarative production entry is missing or stale: ${entry.entryFile}`);
      pending.push(entry);
    }
  }
  const pendingTypes: { path: string; source: string }[] = [];
  const typesDirectory = resolve(sourceRoot, "searcher/generated/declarative-family-types");
  for (const file of await readdir(typesDirectory).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[]; throw error;
  })) {
    if (!file.endsWith(".generated.ts")) continue;
    const path = resolve(typesDirectory, file);
    await regular(path);
    if ((await readFile(path, "utf8")).startsWith("// Generated from Family JSON type metadata. Do not edit.") && !typeArtifacts.has(path))
      throw new Error(`orphaned declarative Family types: ${path}`);
  }
  for (const [path, source] of typeArtifacts) {
    await generatedParent(path);
    let current: string | undefined;
    try { await regular(path); current = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current !== undefined && !current.startsWith("// Generated from Family JSON type metadata. Do not edit."))
      throw new Error(`refusing to overwrite handwritten type output: ${path}`);
    if (current !== source) {
      if (input.mode === "check") throw new Error(`declarative Family types are missing or stale: ${path}`);
      pendingTypes.push({ path, source });
    }
  }
  for (const { path, source } of pendingTypes) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, source); }
  for (const entry of pending) await writeFile(entry.entryFile, entry.source);
  return entries;
}
