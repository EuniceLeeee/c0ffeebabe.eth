import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadFamilyJsonSamples } from "./protocol-json-samples.js";

export const swapJsonSamplesPath = fileURLToPath(new URL("./fixtures/swap-json/index.json", import.meta.url));

/** Same data validator and execution runner as Protocol. This wrapper checks the
 * task's frozen app-run2 enabled-Swap scope; it never starts RPC or live work. */
export function loadSwapJsonSamples(indexPath = swapJsonSamplesPath) {
  const result = loadFamilyJsonSamples(indexPath, "swap"), scope = result.index.scopeReference;
  assert(typeof scope.run === "string" && scope.run.startsWith("live-"), "missing app-run2 run scope");
  assert(/^[a-f0-9]{64}$/.test(scope.configSha256) && /^[a-f0-9]{40}$/.test(scope.appRun2Head), "invalid app-run2 scope pins");
  assert(scope.provenance && typeof scope.provenance.file === "string" && /^[a-f0-9]{64}$/.test(scope.provenance.sha256), "scope requires provenance");
  assert(Array.isArray(scope.enabledFamilies) && scope.enabledFamilies.length === scope.familyIds.length, "enabled scope size mismatch");
  const flags = new Set<string>();
  for (const entry of scope.enabledFamilies) {
    assert(entry.value === "1" && /^SEARCHER_FAMILY_[A-Z0-9_]+_ENABLED$/.test(entry.flag), "sample scope contains a disabled or invalid Family flag");
    assert(!flags.has(entry.flag), "duplicate enabled Family flag"); flags.add(entry.flag);
  }
  assert.deepEqual(scope.enabledFamilies.map((entry: any) => entry.familyId).sort(), [...scope.familyIds].sort(), "enabled sample Family scope changed");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 2, "sample inventory takes no RPC or execution arguments");
  const result = loadSwapJsonSamples();
  console.log(JSON.stringify({ families: result.summary, totalCaseInputs: result.cases.length,
    claim: "Input library integrity only; no Family correctness acceptance or historical execution performed" }, null, 2));
}
