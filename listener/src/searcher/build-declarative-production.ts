import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { FAMILY_CAPABILITY_APPLICABILITY, type FamilyDomain } from "./venues/adapter-family-plugin.js";
import { productionFamilySourceDirectory } from "./venues/production-families/tracked-sources.js";

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
  readonly definitionFile: string;
  readonly entryFile: string;
  readonly familyId: string;
  readonly domain: FamilyDomain;
  readonly source: string;
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
  if (doc.version !== 1) throw new Error("unsupported production definition version");
  if (typeof p.domain !== "string" || !Object.hasOwn(CONSTRUCTORS, p.domain)) throw new Error("unknown production domain");
  const domain = p.domain as FamilyDomain;
  const activation = object(p.activation, "production activation");
  keys(activation, ["enabled", "envKey"], "production activation");
  if (typeof activation.enabled !== "boolean" || typeof activation.envKey !== "string" ||
      !/^SEARCHER_FAMILY_[A-Z0-9_]+_ENABLED$/.test(activation.envKey)) throw new Error("invalid production activation");
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
  const entryFile = resolve(input.productionDirectory ?? productionFamilySourceDirectory(root), `${stem}.production.ts`);
  localPath(sourceRoot, entryFile);
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
  return Object.freeze({ definitionFile, entryFile, familyId: scope.family, domain, source });
}

/** Build-time only. Runtime keeps the existing generated static imports and
 * domain constructors; JSON cannot import code dynamically or issue authority. */
export async function syncDeclarativeProductionEntries(input: {
  rootDirectory: string; productionDirectory?: string; mode: "write" | "check";
}): Promise<ReadonlyMap<string, DeclarativeProductionEntry>> {
  const root = resolve(input.rootDirectory), sourceRoot = resolve(root, "src");
  const productionDirectory = resolve(input.productionDirectory ?? productionFamilySourceDirectory(root));
  const entries = new Map<string, DeclarativeProductionEntry>(), familyIds = new Set<string>();
  async function regular(path: string): Promise<void> {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`production source must be a regular file: ${path}`);
    localPath(await realpath(sourceRoot), await realpath(path));
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
      const references = Object.keys(FAMILY_CAPABILITY_APPLICABILITY[entry.domain])
        .filter(key => key !== "actionAdapters" && Object.hasOwn(document, key))
        .map(key => binding(document[key].binding));
      for (const b of [...references, ...document.actionAdapters as Binding[]])
        await regular(resolve(path, b.module.replace(/\.js$/, ".ts")));
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
  for (const entry of pending) await writeFile(entry.entryFile, entry.source);
  return entries;
}
