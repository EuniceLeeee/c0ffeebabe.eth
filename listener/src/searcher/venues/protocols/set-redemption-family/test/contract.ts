import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import sample from "./public-sample.json";
import sourceAbi from "./source-abi.json";
import { plugin } from "../../../production-families/set-redemption.production.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { compileAddressMutations } from "../../../mutation-index.js";
import { readBlockTouchedStateKeys } from "../../../../blockscan-touched-state.js";
import { assertBalanceAdapter } from "../../../../../adapters/assert-balance.js";
import { declareRequestProgram } from "../../../adapter-request-program.js";
import type { AdapterRequestResult } from "../../../adapter-request-program.js";
import { ACTION, FAMILY, LINEAGE } from "../manifest.js";
import { SET_CODE_HASH, MODULE_CODE_HASH, MODULE, SET, TOKEN, MAX, WAD } from "../codec.js";
import { binding, key } from "../instance.js";
import { dependencies } from "../pricing.js";
import { decodeState, redemptionOutputs, capacity, stateRequests } from "../state.js";
import { program } from "../exact.js";
import type { Descriptor } from "../types.js";
import { actor, set, module, controller, components, fixtureProvider, source, state, type Fixture } from "./fixture.js";
const at = source();
test("Set reads use the exact verified external ABI, not Position library helpers", () => {
  const verified = new ethers.Interface(sourceAbi.abi);
  for (const fragment of SET.fragments.filter(f => f.type === "function")) {
    const declared = SET.getFunction(fragment.format("sighash"))!;
    const actual = verified.getFunction(declared.selector);
    assert(actual, `missing external selector ${declared.format("sighash")}`);
    assert.equal(actual.format("minimal"), declared.format("minimal"));
  }
  assert.equal(verified.getFunction("hasExternalPosition(address)"), null);
  assert(verified.getFunction("getExternalPositionModules(address)"));
});
const descriptor = (s = state()): Descriptor => ({ familyId: FAMILY, lineageId: LINEAGE, instanceKey: instanceKey(key({ set: s.setAddress, module: s.moduleAddress })),
  set: s.setAddress, module: s.moduleAddress, controller, controllerCodeHash: ethers.keccak256("0x6000"), components: [...s.components], provenance: [], runtimeRequirements: [] });
const row = (id: string, data: string): AdapterRequestResult => ({ id, data, source: at, ok: true, completion: "returned", provenance: { kind: "fixture", fingerprint: "synthetic-not-chain" } });
async function read(s: Fixture, reqs: ReturnType<typeof stateRequests>): Promise<AdapterRequestResult[]> {
  const p = fixtureProvider(s, at);
  return Promise.all(reqs.map(async r => row(r.id, r.kind === "get-code" ? await p.getCode(r.address, at.number) :
    r.kind === "eth-call" ? await p.call({ to: r.to, data: r.data }, at.number) : (() => { throw Error("unexpected request"); })())));
}
async function attest(s = state()) {
  const v = plugin.identity.variants[0]; let evidence: unknown;
  for (let step = 0; step < 4; step++) {
    const i = { candidate: { candidateKind: "set-redemption" as const, set: s.setAddress, module: s.moduleAddress }, evidence, step };
    const reqs = v.buildRequests(i); evidence = v.decode({ step: i, results: await read(s, [...reqs]) });
    const decision = v.decide({ ...i, evidence }); if (decision.status !== "continue") return decision;
  }
  throw new Error("identity did not terminate");
}
test("saved exact runtimes authenticate implementations, not address allowlists", async () => {
  assert.equal(ethers.keccak256(sample.setRuntime), SET_CODE_HASH); assert.equal(ethers.keccak256(sample.moduleRuntime), MODULE_CODE_HASH);
  assert.equal((await attest()).status, "verified");
  const s = state(); s.setAddress = ethers.toBeHex(88n, 20); s.moduleAddress = ethers.toBeHex(89n, 20);
  assert.equal((await attest(s)).status, "verified");
  const variant = plugin.identity.variants[0], step = { candidate: { candidateKind: "set-redemption" as const, set, module }, step: 0 };
  const evidence = variant.decode({ step, results: [row("set-code", "0x6000"), row("module-code", sample.moduleRuntime)] });
  assert.equal(variant.decide({ ...step, evidence }).status, "chain-proven-rejected");
  assert.throws(() => variant.decode({ step, results: [row("set-code", sample.setRuntime), row("set-code", sample.setRuntime)] }));
});
test("reciprocal identity and mutable eligibility fail closed without permanent rejection", async () => {
  const s = state(); s.moduleController = actor; assert.equal((await attest(s)).status, "chain-proven-rejected");
  for (const flag of ["enabled", "registered", "initialized"] as const) { const x = state(); x[flag] = false; assert.equal((await attest(x)).status, "retryable", flag); }
  for (const flag of ["locked", "external"] as const) { const x = state(); x[flag] = true; assert.equal((await attest(x)).status, "retryable", flag); }
});
test("canonical call/log discovery retains composite identity and rejects malformed evidence", () => {
  const data = MODULE.encodeFunctionData("redeem", [set, 100n, actor]), o = { kind: "call" as const, target: module, data, source: at };
  assert.equal(plugin.discovery.candidateKey(plugin.discovery.decodeCandidate({ observation: o, matchedPatternId: "set-redeem-call" })!), key({ set, module }));
  assert.equal(plugin.discovery.decodeCandidate({ observation: { ...o, data: data + "00" }, matchedPatternId: "set-redeem-call" }), null);
  const ev = MODULE.encodeEventLog(MODULE.getEvent("SetTokenRedeemed")!, [set, actor, actor, 100n]);
  assert.equal(plugin.discovery.decodeCandidate({ observation: { kind: "log", address: module, ...ev, source: at }, matchedPatternId: "set-redeemed" })!.set, set);
});
test("all directions consume the same whole redemption once, with every positive output guarded", async () => {
  const d = descriptor(), s = decodeState(d, await read(state(), stateRequests(d))), routes = plugin.routes.project({ descriptor: d });
  assert.equal(routes.length, 4); assert.equal(new Set(routes.map(r => r.instanceKey)).size, 1);
  assert.equal(typeof plugin.execution.buildRuntimeLeg, "function");
  for (const r of routes) {
    const i = { descriptor: d, route: r, amountIn: 66538227599871553n, source: at, executor: actor, runtimeEvidence: [] };
    const q = program.decode({ programInput: i, initialResults: await read(state(), stateRequests(d)), dependentEvidence: [] });
    assert.deepEqual(q.evidence.outputs, [1080580816221914020n, 25754286374806283304n, 34599878351933207n, 1129819104645818969n]);
    const f = plugin.execution.buildFragment({ ...i, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: q.evidence });
    assert.equal(f.nodes.filter(n => n.adapterId === ACTION).length, 1); assert.equal(f.nodes.length, 5);
    const bytes = plugin.actionAdapters[0].encode(f.nodes[0], actor, new Uint8Array());
    const data = MODULE.encodeFunctionData("redeem", [set, i.amountIn, actor]);
    assert(ethers.hexlify(bytes).endsWith(data.slice(2)));
    for (let n = 1; n < f.nodes.length; n++) { const g = f.nodes[n]; assert(g.amount > 0n); assert.equal(g.tokenIn, g.target); assert.equal(g.tokenOut, g.target);
      assert.equal(assertBalanceAdapter.encode(g, actor, new Uint8Array())[0], 8); }
    assert.equal(plugin.execution.expectedEffects({ ...i, quotedAmountOut: q.amountOut }).length, 6);
    assert.throws(() => plugin.execution.buildFragment({ ...i, amountIn: i.amountIn + 1n, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: q.evidence }));
  }
  assert.equal(capacity(s), s.supply);
});
test("same-source state checks membership, permissions, units, supply and headroom; no issue ceil", async () => {
  const d = descriptor();
  for (const mutate of [
    (s: Fixture) => { s.components[0] = actor; }, (s: Fixture) => { s.external = true; }, (s: Fixture) => { s.enabled = false; },
    (s: Fixture) => { s.registered = false; }, (s: Fixture) => { s.locked = true; }, (s: Fixture) => { s.units[0] = -1n; },
    (s: Fixture) => { s.multiplier = 0n; },
  ]) { const s = state(); mutate(s); await assert.rejects(async () => decodeState(d, await read(s, stateRequests(d)))); }
  const s = decodeState(d, await read(state(), stateRequests(d)));
  assert.throws(() => redemptionOutputs(s, s.supply + 1n), /supply/);
  assert.throws(() => redemptionOutputs({ ...s, balances: s.balances.map(() => 0n) }, 10n ** 18n), /supply|balance/);
  assert.throws(() => redemptionOutputs({ ...s, supply: MAX, units: [MAX], balances: [MAX] }, 2n), /overflow/);
  assert.equal(redemptionOutputs({ ...s, units: [WAD / 2n], balances: [1n] }, 3n)[0], 1n);
  assert.equal(capacity({ ...s, units: [WAD / 2n], balances: [1n] }), 3n);
  const r = await read(state(), stateRequests(d)); assert.throws(() => decodeState(d, r.slice(1)));
  assert.throws(() => decodeState(d, r.map((v, i) => i ? v : { ...v, source: source(101) })));
});
test("real current-source exact request uses amount-independent shared reads and declares no false chain quote", async () => {
  const d = descriptor(), route = plugin.routes.project({ descriptor: d })[0], i = { descriptor: d, route, source: at, executor: actor, amountIn: 100n, runtimeEvidence: [] };
  const declared = declareRequestProgram({ requirements: () => program.requirements(i), buildRequests: () => program.buildRequests(i), decode: () => null }, i);
  assert(declared.requests.length > 0);
  assert.deepEqual(program.buildRequests(i), program.buildRequests({ ...i, amountIn: 200n }));
  assert(!("chainAmountQuote" in plugin.exact.methods(i)[1]));
  assert.throws(() => program.buildRequests({ ...i, amountIn: -1n }));
  assert.throws(() => program.buildRequests({ ...i, prefix: [{}] as any }), /EVM prefix/);
});
test("production touched reader dispatches every component/controller/module dependency and excludes unrelated activity", async () => {
  const d = descriptor(), routes = plugin.routes.project({ descriptor: d }), dep = dependencies(d);
  const index = plugin.pricing.mutation!.compile!({ entries: [{ descriptor: d, routes, dependencies: dep, stateKey: d.instanceKey }] });
  for (const target of [...dep, actor]) {
    const keys = await readBlockTouchedStateKeys({ getLogs: async () => [{ address: target, topics: [], data: "0x", blockHash: at.hash }], send: async () => [] },
      at.number, actor, { hash: at.hash, parentHash: source(99).hash, transactionHashes: [] }, undefined,
      (o, b) => index.affectedStateKeys({ observation: { ...o, source: { ...at, ...b } } }));
    assert.equal(keys.has(d.instanceKey), target !== actor, target);
  }
  assert.equal(compileAddressMutations !== undefined, true);
});
