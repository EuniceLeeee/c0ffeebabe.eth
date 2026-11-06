import assert from "node:assert/strict";
import { getAddress, id } from "ethers";
import { plugin } from "../venues/production-families/angstrom-v4.production.js";
import { UNIV4_STATE_VIEW_INTERFACE as stateView } from "../venues/swaps/univ4-abi.js";
import { v4PoolId } from "../venues/swaps/univ4-common.js";
import sample from "./fixtures/adapter-families/angstrom-signed-tx85-call.json" with { type: "json" };

const Q96 = 1n << 96n;
const call = { kind: "call" as const, transactionHash: sample.transactionHash, source: sample.source,
  target: sample.target, data: sample.data, sender: sample.from };
const discovery = plugin.discovery!;
const candidate = discovery.decodeCandidate({ observation: call, matchedPatternId: "angstrom-v4-adapter-swap-call" });
assert(candidate);
const hookKey = { currency0: candidate.currency0, currency1: candidate.currency1, hooks: candidate.hooks,
  fee: candidate.fee, tickSpacing: candidate.tickSpacing };
const binding = { manager: candidate.manager, hook: candidate.hooks, adapter: sample.target,
  controller: getAddress("0x4000000000000000000000000000000000000044"),
  quoter: getAddress("0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203") };
const pricing = plugin.pricing!;
function compile(tickSpacing: number) {
  const poolKey = { ...hookKey, tickSpacing };
  const poolId = v4PoolId(poolKey);
  const descriptor = { familyId: plugin.manifest.familyId, lineageId: plugin.manifest.supportedLineages[0],
    instanceKey: poolId, poolKey, poolId, immutableBinding: binding, provenance: [], runtimeRequirements: [] };
  const routes = plugin.routes!.project({ descriptor });
  assert.deepEqual(routes.map(r => r.tokenIn.toLowerCase()), [poolKey.currency0, poolKey.currency1].map(a => a.toLowerCase()));
  assert(routes.every(r => r.target.toLowerCase() === sample.target.toLowerCase()));
  const draft = pricing.compileDraft({ descriptor, routes, stateKey: poolId });
  const pd = pricing.finalizePricingDescriptor({ draft, staticEvidence: {}, sharedBindings: [] });
  return { descriptor: pd, routes, stateKey: poolId, dependencies: pricing.dependencies({ descriptor: pd, routes }) };
}

export function checkAngstromTwoWaySpot() {
  const entry = compile(hookKey.tickSpacing), current = pricing.current;
  const requests = current.buildRequests({ ...entry, source: sample.source });
  assert.equal(requests.length, 2);
  const values = new Map([["getSlot0", [2n * Q96, 0, 0, 3000]], ["getLiquidity", [10n ** 21n]]]);
  const results = requests.map(request => {
    assert.equal(request.kind, "eth-call");
    if (request.kind !== "eth-call") throw new Error("expected a pool state read");
    const fn = stateView.getFunction(request.data.slice(0, 10))!;
    assert.deepEqual([...stateView.decodeFunctionData(fn, request.data)], [entry.stateKey]);
    const words = values.get(fn.name);
    assert(words); values.delete(fn.name);
    return { id: request.id, data: stateView.encodeFunctionResult(fn, words), source: sample.source,
      ok: true as const, completion: "returned" as const, provenance: { kind: "fixture", fingerprint: "slot0-liquidity" } };
  });
  assert.equal(values.size, 0);
  const snapshot = current.decodeSnapshot({ descriptor: entry.descriptor, initialResults: results, dependentEvidence: [] });
  const mids = current.deriveMids({ descriptor: entry.descriptor, routes: entry.routes, snapshot });
  assert.equal(mids.size, 2);
  assert.deepEqual(entry.routes.map(route => mids.get(route.routeKey)?.mid), [4, 0.25]);
}

export function checkAngstromPoolIsolation() {
  const first = compile(hookKey.tickSpacing), second = compile(hookKey.tickSpacing + 1);
  assert.notEqual(first.stateKey, second.stateKey);
  const mutation = pricing.mutation!.compile!;
  const topic = id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
  const touched = (poolId: string) => ({ kind: "log" as const, address: binding.manager,
    topics: [topic, poolId], data: "0x", source: sample.source });
  const firstOnly = mutation({ entries: [first] });
  const both = mutation({ entries: [first, second] });
  assert.deepEqual(firstOnly.affectedStateKeys({ observation: touched(first.stateKey) }), [first.stateKey]);
  assert.deepEqual(firstOnly.affectedStateKeys({ observation: touched(second.stateKey) }), []);
  for (const entry of [first, second]) {
    assert.deepEqual(both.affectedStateKeys({ observation: touched(entry.stateKey) }), [entry.stateKey]);
    assert.deepEqual(both.affectedStateKeys({ observation: { ...touched(entry.stateKey), address: sample.target } }), []);
  }
}
