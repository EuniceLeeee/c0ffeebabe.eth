import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson } from "./universe-rebuild-checkpoint.js";
import { generateRuntimeSourceClosure } from "./venues/capability-content-hash.js";
import { inactiveDeclarativeModules } from "./venues/declarative-module-dependencies.js";
import type { FamilyCapabilityShadowArtifact } from "./venues/family-capability-shadow.js";
import { syncDeclarativeProductionEntries } from "./build-declarative-production.js";
import type { ReadyRuleScope, ReadyRuleHashes, ReadyRuleDefinitions } from "./ready-rule-bindings.js";
const memoCapabilities = new Set(["identity", "instance", "routes", "pricing", "funding"]);
const discoveryCapabilities = new Set(["capture", "discovery"]);
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Ready binds actual Family runtime inputs. The production generator itself
 * is not an admission rule: bind its generated entry instead. All runtime
 * imports, including top-level side effects, stay in the ordinary collector.
 * This is conservative within the shared compiler, not function-level slicing. */
export async function calculateReadyRuleDefinitions(input: {
  rootDirectory: string; artifact: FamilyCapabilityShadowArtifact;
  definitionBoundaryHashes: Readonly<Record<string, string>>;
}): Promise<ReadyRuleDefinitions> {
  const entries = await syncDeclarativeProductionEntries({ rootDirectory: input.rootDirectory, mode: "check" });
  const generated = new Map([...entries.values()].map(entry => [entry.familyId, entry]));
  const byFamily = new Map<string, typeof input.artifact.exact[number][]>();
  for (const record of input.artifact.exact) {
    const id = String(record.identity.familyId);
    const rows = byFamily.get(id) ?? []; rows.push(record); byFamily.set(id, rows);
  }
  const result: Record<string, ReadyRuleHashes> = {};
  // Every JSON capability has the same compiler inputs. Recompute that closure
  // once per Family, not once per candidate or capability.
  const closures = new Map<string, Promise<string>>();
  for (const [familyId, rows] of byFamily) {
    const boundary = input.definitionBoundaryHashes[familyId];
    if (boundary === undefined) continue;
    const parts: Array<{ capability: string; contract: string; closure: string }> = [];
    for (const row of rows) {
      if (!row.root.entrySourceFile) continue;
      const additional = row.root.additionalSourceFiles.filter(file =>
        file !== "src/searcher/build-declarative-production.ts" &&
        file !== "src/searcher/venues/declarative-types.ts");
      const entry = generated.get(familyId);
      if (entry) additional.push(entry.entryFile);
      const documents: Record<string, any>[] = [];
      for (const file of additional.filter(file => file.endsWith(".json")))
        documents.push(JSON.parse(await readFile(resolve(input.rootDirectory, file), "utf8")));
      const inactive = documents.length ? inactiveDeclarativeModules(documents) : [];
      const key = canonicalJson([row.root.entrySourceFile, additional, inactive]);
      let pending = closures.get(key);
      if (!pending) {
        pending = generateRuntimeSourceClosure({ rootDirectory: input.rootDirectory,
          entryFile: resolve(input.rootDirectory, row.root.entrySourceFile),
          additionalEntryFiles: additional.map(file => resolve(input.rootDirectory, file)),
          inactiveRuntimeModules: inactive }).then(result => result.closureHash);
        closures.set(key, pending);
      }
      parts.push({ capability: row.identity.capability,
        contract: row.identity.contractVersion, closure: await pending });
    }
    const digest = (scope: ReadyRuleScope) => hash({ scheme: "ready-family-rules-v1", familyId, scope,
      ...(scope === "full" ? { definitionBoundaryHash: boundary } : {}),
      capabilities: parts.filter(p => scope === "memo" ? memoCapabilities.has(p.capability)
        : scope === "discovery" ? discoveryCapabilities.has(p.capability)
          : true)
        .sort((a, b) => a.capability.localeCompare(b.capability)) });
    result[familyId] = Object.freeze({ full: digest("full"), memo: digest("memo"), discovery: digest("discovery") });
  }
  return Object.freeze(result);
}

