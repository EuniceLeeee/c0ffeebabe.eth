import assert from "node:assert/strict";
import test from "node:test";
import { FunctionFragment, Interface, toBeHex } from "ethers";
import { readySelectorCandidatePattern } from "../ready-selector-candidate-pattern.js";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import { attestPoolIdentitiesStrict } from "../strict-identity-attestation.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { defineSelectorFamilyModule } from "../venues/selector-family-module.js";
import { definedFamilyPluginContractSummary, type UnifiedObservation } from "../venues/adapter-family-plugin.js";
import { FamilyCapabilityCatalog, FAMILY_CAPABILITY_NAMES, capabilityManifestHash } from "../venues/family-capability-catalog.js";
import { hashCanonical } from "../venues/canonical-value.js";

const a = (n: number) => toBeHex(n, 20), h = (n: number) => toBeHex(n, 32);
const TARGET = a(1), TOKEN_IN = a(2), TOKEN_OUT = a(3), SENDER = a(4), EXECUTOR = a(5);
const source = { number: 100, hash: h(100), generation: 1 };
function fixture() {
  const signature = "function convert(address,address,uint256,address,bytes32)", selector = FunctionFragment.from(signature).selector;
  const parameters = [{ path: [0], role: "tokenIn" }, { path: [1], role: "tokenOut" }, { path: [2], role: "amountIn" }, { path: [3], role: "recipient" }, { path: [4], role: "poolId" }];
  const plugin = defineSelectorFamilyModule({ selector, signature, programs: [
    { parameters, payment: { kind: "none" } }, { parameters, payment: { kind: "approval" } },
  ] }).plugin;
  const familyId = plugin.manifest.familyId;
  const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({ familyId, capability, contractVersion: "v2-pattern-test",
    contentHash: hashCanonical({ familyId, capability }), semanticDependencies: [`contract:${capability}`], provenanceCommit: null }));
  const catalog = new FamilyCapabilityCatalog({ modules: [{ sourceFile: "fixture/pattern.production.ts", plugin,
    definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) } });
  const census = readySelectorCensusFromTransaction({ chainId: 1, blockNumber: source.number, blockHash: source.hash, transactionHash: h(200), transactionIndex: 0,
    status: 1, from: SENDER, to: TARGET, input: new Interface([signature]).encodeFunctionData(selector, [TOKEN_IN, TOKEN_OUT, 7n, SENDER, h(7)]), logs: [], traces: [] });
  const observation: UnifiedObservation = { kind: "call", source, target: TARGET, sender: SENDER, transactionHash: census.transactionHash!,
    data: census.calls[0]!.calldata!, traceAddress: [], opaque: { selectorCensus: census, callId: census.calls[0]!.id } as any };
  assert("discovery" in plugin);
  const rows = catalog.matches(observation).filter(match => match.familyId === familyId).map(match => ({ patternId: match.patternId,
    candidate: plugin.discovery.decodeCandidate({ observation, matchedPatternId: match.patternId }) as Record<string, any> }));
  assert.equal(rows.length, 2); assert(rows.every(row => row.candidate));
  return { familyId, catalog, observation, rows };
}
test("Ready replays each full program candidate instead of requiring one pattern per selector Family", () => {
  const f = fixture();
  assert.notEqual(f.rows[0].candidate.programKey, f.rows[1].candidate.programKey);
  for (const row of f.rows) assert.equal(readySelectorCandidatePattern({ ...f, candidate: row.candidate }), row.patternId);
  for (const mutate of [
    (c: any) => { c.programKey = "foreign-program"; },
    (c: any) => { c.programKeys = [f.rows[1].candidate.programKey]; },
    (c: any) => { c.scope.poolId = h(99); },
    (c: any) => { c.immutableParameters[0].value = h(99); },
    (c: any) => { c.declarationFingerprint = h(99); },
    (c: any) => { c.arguments[2] = "999"; },
  ]) {
    const changed = JSON.parse(JSON.stringify(f.rows[0].candidate)); mutate(changed);
    assert.throws(() => readySelectorCandidatePattern({ ...f, candidate: changed }));
  }
  assert.throws(() => readySelectorCandidatePattern({ ...f, candidate: f.rows[0].candidate,
    observation: { ...f.observation, sender: EXECUTOR } as UnifiedObservation }));
});
test("strict current-source attestation preserves the selected later recipe and rejects foreign patterns", async () => {
  const f = fixture();
  const provider = { async getCode() { return "0x6000"; }, async getStorage() { return h(0); }, async call() { assert.fail("parameter binding must not query state"); } };
  const runtime = createStrictCentralAdapterRuntime({ executor: EXECUTOR, transactionOrigin: SENDER, provider,
    generationFence: { assertCurrent(g, current) { assert.equal(g, source.generation); assert.deepEqual(current, source); } } });
  const run = (patternId: string) => attestPoolIdentitiesStrict({ catalog: f.catalog, provider, runtime, source,
    pools: [{ address: TARGET }], onlyFamilyId: f.familyId, onlyPatternId: patternId, suppliedObservations: [f.observation] });
  for (const row of f.rows) {
    const selected = readySelectorCandidatePattern({ ...f, candidate: row.candidate }), result = await run(selected);
    assert.equal(result.accepted.length, 1, JSON.stringify(result.rejected));
    assert.equal(result.publications[0]!.instances.length, 1);
    assert.equal((result.publications[0]!.instances[0]!.descriptor as any).programKey, row.candidate.programKey);
  }
  const bad = await run("foreign-pattern"); assert.equal(bad.accepted.length, 0); assert.equal(bad.publications.filter(Boolean).length, 0);
});
