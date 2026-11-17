import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRebuildWiring, familyDefinitionHash, familyMemoDefinitionHash } from "../src/searcher/universe-rebuild-production.js";
import { createReadyRuleCompatibility, sealReadyRuleBindings } from "../src/searcher/ready-rule-bindings.js";

const id = "univ2-standard", old = "a".repeat(64), rulesHash = "b".repeat(64);
const current = { full: familyDefinitionHash(id), memo: familyMemoDefinitionHash(id), discovery: "c".repeat(64) };
const bindings = sealReadyRuleBindings({ version: 1,
  origin: { generation: 19, checkpointFingerprint: "d".repeat(64), sourceSha256: "e".repeat(64), archiveManifestSha256: "f".repeat(64) },
  families: { [id]: { full: { rulesHash, definitionHashes: [old] }, memo: { rulesHash, definitionHashes: [old] },
    discovery: { rulesHash, definitionHashes: [old] } } } });
// This boundary checks definition/projection compatibility only; this synthetic
// memo is not an identity attestation and must never be published into Ready.
const memo: any = { familyId: id, familyDefinitionHash: old, staticProjection: { routes: [{}], pricingInstances: [{}] } };

test("benchmark uses live's sealed-rule resolver and memo predicate, retaining historical and projection boundaries", () => {
  const source = readFileSync(new URL("./live-stage.ts", import.meta.url), "utf8");
  assert.match(source, /ruleCompatibility: await readyRuleCompatibilityFor\(envelope\.readyGeneration\.ruleBindings\)/);
  assert.match(source, /wiring\.isReadyMemoDefinitionCurrent!\(memo\)/);
  assert.equal(createRebuildWiring({ rpcUrl: "http://127.0.0.1:1" }).isReadyMemoDefinitionCurrent!(memo), false, "legacy hash-only gate rejects this old definition");
  const wiring = (currentMemoRule: string) => createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", ruleCompatibility: createReadyRuleCompatibility({
    bindings, currentHashes: { [id]: current }, currentRules: { [id]: { full: rulesHash, memo: currentMemoRule, discovery: rulesHash } },
  }) });
  assert.equal(wiring(rulesHash).isReadyMemoDefinitionCurrent!(memo), true);
  assert.equal(wiring("0".repeat(64)).isReadyMemoDefinitionCurrent!(memo), false, "changed rules cannot inherit");
  assert.equal(wiring(rulesHash).isReadyMemoDefinitionCurrent!({ ...memo, familyDefinitionHash: "1".repeat(64) }), false, "unbound hash cannot inherit");
  assert.equal(wiring(rulesHash).isReadyMemoDefinitionCurrent!({ ...memo, staticProjection: { routes: [], pricingInstances: [] } }), false,
    "matching hash never supplies missing pricing projection");
  assert.throws(() => createReadyRuleCompatibility({ bindings: { ...bindings, fingerprint: "0".repeat(64) },
    currentRules: {}, currentHashes: {} }), /fingerprint/);
});
