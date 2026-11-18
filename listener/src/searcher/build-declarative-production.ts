import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { FamilyDomain } from "./venues/adapter-family-plugin.js";
import { selectorNativeFamilyId } from "./venues/selector-native-definition.js";
import { selectorNativeFundingFamilyId } from "./venues/selector-native-funding-definition.js";
import { selectorNativeCreditFamilyId } from "./venues/selector-native-credit-definition.js";
import { normalizeSelectorFamilyDefinition } from "./venues/selector-family-definition.js";
import { productionFamilySourceDirectory } from "./venues/production-families/tracked-sources.js";

const MARKER = "// Generated from selector-native JSON. Do not edit.";
export interface DeclarativeProductionEntry {
  readonly format: "selector-family/v2";
  readonly definitionFile: string;
  readonly entryFile: string;
  readonly familyId: string;
  readonly domain: FamilyDomain;
  readonly source: string;
  readonly dependencyFiles: readonly string[];
  readonly childFiles: readonly string[];
  readonly ownedActionAdapterIds: readonly string[];
  readonly declaresOracleVictim?: boolean;
  readonly inactiveRuntimeModules?: readonly string[];
}
function within(root: string, path: string): string {
  const local = relative(root, path);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || resolve(root, local) !== path)
    throw new Error("selector-native source escapes its root");
  return local.split(sep).join("/");
}
/** The production authoring boundary accepts only self-contained selector data.
 * Legacy root/children, TypeScript binding handlers and compiler fallbacks have
 * no path through this generator. */
export function renderDeclarativeProductionEntry(input: {
  readonly rootDirectory: string;
  readonly productionDirectory?: string;
  readonly definitionFile: string;
  readonly entryFile?: string;
  readonly document: unknown;
}): DeclarativeProductionEntry {
  const root = resolve(input.rootDirectory), sourceRoot = resolve(root, "src");
  const definitionFile = resolve(input.definitionFile);
  within(sourceRoot, definitionFile);
  const doc = normalizeSelectorFamilyDefinition(input.document);
  const funding = doc.domain === "funding";
  const rawDomain: unknown = funding ? "funding" : doc.domain;
  if (rawDomain !== "funding" && rawDomain !== "credit" && rawDomain !== "protocol" && rawDomain !== "swap")
    throw new Error("unsupported selector-native execution domain");
  const domain = rawDomain;
  const familyId = String(funding ? selectorNativeFundingFamilyId(doc) : doc.domain === "credit" ? selectorNativeCreditFamilyId(doc) : selectorNativeFamilyId(doc));
  const moduleFile = resolve(sourceRoot, "searcher/venues/selector-family-module.ts");
  const production = resolve(input.productionDirectory ?? productionFamilySourceDirectory(root));
  within(sourceRoot, production);
  const name = basename(definitionFile, ".json");
  if (!/^selector-[a-z0-9-]+$/.test(name)) throw new Error("selector-native definition requires a selector filename");
  const entryFile = resolve(input.entryFile ?? resolve(production, `${name}.production.ts`));
  if (dirname(entryFile) !== production) throw new Error("production entry must be inside its source directory");
  const modulePath = (path: string) => {
    const local = relative(dirname(entryFile), path).split(sep).join("/");
    return local.startsWith(".") ? local : `./${local}`;
  };
  const source = [MARKER,
    `// Definition: ${within(root, definitionFile)}`,
    '// Regenerate with: npm run family-capability-manifest:generate',
    `import { defineSelectorFamilyModule } from ${JSON.stringify(modulePath(moduleFile).replace(/\.ts$/, ".js"))};`,
    `import definition from ${JSON.stringify(modulePath(definitionFile))};`, "",
    `export const selectorFamilyModule = defineSelectorFamilyModule(definition);`, "",
  ].join("\n");
  return Object.freeze({ format: "selector-family/v2", definitionFile, entryFile, familyId, domain, source,
    dependencyFiles: Object.freeze([definitionFile, moduleFile]), childFiles: Object.freeze([]),
    ownedActionAdapterIds: Object.freeze([`${familyId}:call`]),
  });
}
/** Build-time scan of the sole authored execution registry. A stale or foreign
 * production entry is an error; generation never re-enables a retired adapter. */
export async function syncDeclarativeProductionEntries(input: {
  readonly rootDirectory: string;
  readonly productionDirectory?: string;
  readonly mode: "write" | "check";
}): Promise<ReadonlyMap<string, DeclarativeProductionEntry>> {
  const root = resolve(input.rootDirectory), sourceRoot = resolve(root, "src");
  const registry = resolve(sourceRoot, "searcher/venues/selector-native");
  const production = resolve(input.productionDirectory ?? productionFamilySourceDirectory(root));
  const entries = new Map<string, DeclarativeProductionEntry>(), ids = new Set<string>();
  async function regular(path: string) {
    within(sourceRoot, path);
    let current = path;
    while (current !== sourceRoot) {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (current === path ? !stat.isFile() : !stat.isDirectory()))
        throw new Error("selector-native source must use regular files and directories");
      current = dirname(current);
    }
    within(await realpath(sourceRoot), await realpath(path));
  }
  const directories = await readdir(registry, { withFileTypes: true });
  for (const item of directories.sort((a,b) => a.name.localeCompare(b.name))) {
    if (!item.isDirectory() || !item.name.endsWith("-family")) continue;
    const definitionFile = resolve(registry, item.name, `${item.name.slice(0,-7)}.json`);
    await regular(definitionFile);
    const entry = renderDeclarativeProductionEntry({ rootDirectory: root, productionDirectory: production,
      definitionFile, document: JSON.parse(await readFile(definitionFile, "utf8")) });
    if (entries.has(entry.entryFile) || ids.has(entry.familyId)) throw new Error("duplicate selector-native family or output entry");
    for (const path of entry.dependencyFiles) await regular(path);
    entries.set(entry.entryFile, entry); ids.add(entry.familyId);
  }
  if (!entries.size) throw new Error("selector-native production catalog is empty");
  await mkdir(production, { recursive: true });
  for (const file of await readdir(production)) {
    if (!file.endsWith(".production.ts")) continue;
    const path = resolve(production, file);
    if (!entries.has(path)) throw new Error(`retired/unregistered production entry must be removed: ${file}`);
  }
  for (const entry of entries.values()) {
    let previous: string | undefined;
    try { await regular(entry.entryFile); previous = await readFile(entry.entryFile, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (previous !== entry.source) {
      if (input.mode === "check") throw new Error(`selector-native production entry missing or stale: ${entry.entryFile}`);
      if (previous !== undefined && !previous.startsWith(MARKER))
        throw new Error(`retired production source must be removed before migration: ${entry.entryFile}`);
      await writeFile(entry.entryFile, entry.source);
    }
  }
  const registryFile = resolve(sourceRoot, "searcher/generated/selector-execution-families.generated.ts");
  const content = '// Generated from selector-native execution declarations. Do not edit.\n' +
    `export const PRODUCTION_SELECTOR_EXECUTION_FAMILY_IDS: readonly string[] = Object.freeze(${JSON.stringify([...entries.values()].map(entry=>entry.familyId).sort(),null,2)});\n`;
  const previous = await readFile(registryFile,"utf8").catch(error=>{if(error.code==="ENOENT")return null;throw error;});
  if (previous !== content) {
    if (input.mode === "check") throw new Error("selector-native family registry is stale");
    await mkdir(dirname(registryFile),{recursive:true}); await writeFile(registryFile,content);
  }
  return entries;
}
