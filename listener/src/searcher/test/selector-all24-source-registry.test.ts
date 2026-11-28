import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { compileSelectorExecutionSource } from "../build-selector-execution-source.js";
import { readSelectorDiscoveryRuleHash } from "../venues/selector-discovery-rule-hash.js";
import { normalizeSelectorNativeExecutionDefinition } from "../venues/selector-native-definition.js";
import { selectSingleExecution } from "../venues/selector-program-role.js";

test("every swap/protocol selector family with discover.mjs + edge-discovery.json owns canonical execution.source.json and identity.source.json", async () => {
  const nativeRoot = fileURLToPath(new URL("../venues/selector-native/", import.meta.url));
  const scriptsUrl = new URL("../../../../scripts/", import.meta.url);
  const dirs = readdirSync(nativeRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^selector-[0-9a-f]{8}-family$/.test(d.name))
    .map(d => d.name)
    .sort();

  const discoveredSwapProtocol: string[] = [];
  const discoveredCredit: string[] = [];

  for (const dirName of dirs) {
    const tag = dirName.slice("selector-".length, "selector-".length + 8);
    const fullDir = path.join(nativeRoot, dirName);
    const hasDiscover = existsSync(path.join(fullDir, "discover.mjs"));
    const hasEdgeJson = existsSync(path.join(fullDir, "edge-discovery.json"));
    if (!hasDiscover && !hasEdgeJson) continue;
    assert.equal(hasDiscover && hasEdgeJson, true, `${dirName} must pair discover.mjs and edge-discovery.json`);

    const selectorJsonPath = path.join(fullDir, `selector-${tag}.json`);
    assert.equal(existsSync(selectorJsonPath), true, `missing ${selectorJsonPath}`);
    const generated = JSON.parse(readFileSync(selectorJsonPath, "utf8"));

    if (generated.domain === "credit") {
      discoveredCredit.push(tag);
      continue;
    }

    assert(generated.domain === "swap" || generated.domain === "protocol", `unexpected domain ${generated.domain} in ${dirName}`);
    discoveredSwapProtocol.push(tag);

    const execSourcePath = path.join(fullDir, "execution.source.json");
    const idSourcePath = path.join(fullDir, "identity.source.json");
    assert.equal(existsSync(execSourcePath), true, `missing execution.source.json in ${dirName}`);
    assert.equal(existsSync(idSourcePath), true, `missing identity.source.json in ${dirName}`);

    const execSrc = JSON.parse(readFileSync(execSourcePath, "utf8"));
    const idSrc = JSON.parse(readFileSync(idSourcePath, "utf8"));
    const dirUrl = new URL(`../venues/selector-native/${dirName}/`, import.meta.url);
    const ruleHash = await readSelectorDiscoveryRuleHash(dirUrl, scriptsUrl);
    const compiled = compileSelectorExecutionSource(execSrc, ruleHash, idSrc);
    assert.deepEqual(generated, compiled, `${dirName} generated IR differs from compiled source`);

    const def = normalizeSelectorNativeExecutionDefinition(compiled);
    assert(def.directState && def.directState.discoveryRuleHash === ruleHash, `${dirName} missing directState discoveryRuleHash`);
    const single = selectSingleExecution(def);
    assert(single.programKey.length > 0);
    const idPrograms = def.programs.filter(p => p.type === "independentIdentity");
    assert(idPrograms.length >= 1, `${dirName} must compile at least one independentIdentity program`);
  }

  assert.deepEqual(discoveredCredit, ["032d2276"]);
  assert.equal(discoveredSwapProtocol.length, 51);
});
