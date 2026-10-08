import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import type { SwapObservationBindingResolver } from "../../../swap-observation.js";

// This entry runs in its own Node test process. Enable only for this offline
// production-pipeline contract; it never changes the entry's default.
process.env.SEARCHER_FAMILY_BALANCER_V2_ENABLED = "1";
const { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog } =
  await import("../../../production-family-composition.js");
const { executeAdapterFamilyLifecycle, recheckFamilyInstanceMemoBinding } =
  await import("../../../adapter-family-runtime.js");
const { createStrictCentralAdapterRuntime } = await import("../../../../strict-central-adapter-runtime.js");
const { buildFamilyRouteGraphView } = await import("../../../../adapter-family-graph-runtime.js");
const { createVictimSourceGeneration, detectImpactTransitionFromLogs } =
  await import("../../../../detector/pool-impact.js");
const { SOURCE, EXECUTOR, POOL, FOREIGN, TOKENS, EXTRA, fixture, candidate, idFor } = await import("./fixtures.js");
const { VAULT, VAULT_ABI } = await import("../codec.js");
const { LOG_ID } = await import("../discovery.js");
const { BALANCER_V2_FAMILY_ID } = await import("../manifest.js");
const family = catalog.forFamily(BALANCER_V2_FAMILY_ID);
function runtime(f: ReturnType<typeof fixture>) {
  return createStrictCentralAdapterRuntime({
    executor: EXECUTOR,
    generationFence: { assertCurrent(generation, source) {
      assert.equal(generation, SOURCE.generation); assert.deepEqual(source, SOURCE);
    } },
    provider: {
      async getCode(_address, block) { assert.equal(block, SOURCE.number); return "0x60006000"; },
      async getStorage() { throw Error("unexpected storage read"); },
      async call(tx, block) {
        assert.equal(block ?? tx.blockTag, SOURCE.number);
        const result = f.answer({ id: "offline-contract", kind: "eth-call", to: tx.to, data: tx.data, completion: "return-data" });
        assert(result.ok); return result.data;
      },
    },
  });
}
function log(f: ReturnType<typeof fixture>) {
  return { address: VAULT, ...VAULT_ABI.encodeEventLog(VAULT_ABI.getEvent("Swap")!,
    [f.poolId, ...f.tokens.slice(0, 2), 10n, 20n]) };
}
async function publish(f: ReturnType<typeof fixture>) {
  const result = await executeAdapterFamilyLifecycle({
    family, match: { observation: { kind: "log", source: SOURCE, ...log(f) }, matchedPatternId: LOG_ID },
    source: SOURCE, generation: SOURCE.generation, runtime: runtime(f), publisher: { publish() {} },
  });
  assert(result.publication, JSON.stringify(result.outcomes)); assert.equal(result.publication.instances.length, 1);
  return result.publication.instances[0]!;
}
function graph(instance: Awaited<ReturnType<typeof publish>>) {
  return buildFamilyRouteGraphView({ routes: instance.routes.map(route => {
    const handle = instance.routeHandles.find(h => h.routeKey === route.routeKey); assert(handle);
    return { family, descriptor: instance.descriptor, route, handle };
  }) });
}

test("production lifecycle Graph and public receipt detector distinguish shared-Vault pools without injected triggers", async () => {
  const a = fixture(), b = fixture(TOKENS, [18, 18], idFor(FOREIGN));
  const instances = [await publish(a), await publish(b)], views = instances.map(graph);
  const edges = views.flatMap(v => [...v.edges]);
  assert.equal(edges.length, 4);
  for (let i = 0; i < 2; i++) for (const edge of views[i].edges) {
    assert.equal(ethers.getAddress(edge.target), [a, b][i].pool);
    assert.equal(edge.instanceKey, [a, b][i].poolId); assert.equal(edge.poolId, undefined);
  }
  const logs = [log(b)], source = createVictimSourceGeneration({ sourceBlock: SOURCE.number,
    sourceBlockHash: SOURCE.hash, receiptId: "offline-contract", logs, logsCompleteness: "fragment" });
  const resolve: SwapObservationBindingResolver = edge => {
    const i = views.findIndex(v => v.edges.some(candidate => candidate === edge));
    return i < 0 ? null : { familyId: "balancer-v2", descriptor: instances[i].descriptor };
  };
  const transition = await detectImpactTransitionFromLogs(logs, edges, source, null, null, resolve);
  assert.equal(transition.steps.length, 1, JSON.stringify(transition, (_k, v) => typeof v === "bigint" ? v.toString() : v));
  const impact = transition.steps[0].impact;
  assert.equal(ethers.getAddress(impact.pool), b.pool); assert.equal(impact.amountIn, 10n);
  assert.equal(impact.amountOut, 20n); assert.equal(impact.poolId, undefined);
  assert(!transition.unresolved.some(x => x.reason === "observer-decode-failed" || x.reason === "observer-produced-unadmitted-impact"));
  const missing = await detectImpactTransitionFromLogs(logs, [...views[0].edges], source, null, null, resolve);
  assert.equal(missing.steps.length, 0);
  const wrongBinding = await detectImpactTransitionFromLogs(logs, edges, source, null, null,
    () => ({ familyId: "balancer-v2", descriptor: instances[0].descriptor }));
  assert.equal(wrongBinding.steps.length, 0);
  assert(wrongBinding.unresolved.some(x => x.reason === "observer-decode-failed"));
});

test("production memo identity recheck detects registered token changes before routes are reissued", async () => {
  const poolId = idFor(POOL, 1), a = fixture(TOKENS, [18, 18], poolId);
  const b = fixture([...TOKENS, EXTRA], [18, 18, 6], poolId);
  const recheck = (f: typeof a) => recheckFamilyInstanceMemoBinding({
    family, candidate: candidate(poolId), source: SOURCE, generation: SOURCE.generation, runtime: runtime(f),
  });
  const old = await recheck(a), changed = await recheck(b);
  assert(old); assert(changed); assert.notDeepEqual(changed, old);
  const fresh = await publish(b);
  assert.equal(graph(fresh).edges.length, 6);
});
