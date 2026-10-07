import assert from "node:assert/strict";
import test from "node:test";
process.env.SEARCHER_FAMILY_BALANCER_V1_ENABLED = "1";
const { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog } =
  await import("../../../production-family-composition.js");
const { executeAdapterFamilyLifecycle, recheckFamilyInstanceMemoBinding } =
  await import("../../../adapter-family-runtime.js");
const { createStrictCentralAdapterRuntime } = await import("../../../../strict-central-adapter-runtime.js");
const { buildFamilyRouteGraphView } = await import("../../../../adapter-family-graph-runtime.js");
const { createVictimSourceGeneration, detectImpactTransitionFromLogs } =
  await import("../../../../detector/pool-impact.js");
const { SOURCE, EXECUTOR, PUBLIC, PINNED, CANDIDATE, answer } = await import("./fixtures.js");
const { POOL, FACTORY_ADDRESS } = await import("../codec.js");
const { ID } = await import("../manifest.js");
const family = catalog.forFamily(ID);

// Saved public view results bound to a synthetic transport; real production
// issuers and detector are exercised, but no historical execution is claimed.
function runtime(unsupportedCode = false) {
  return createStrictCentralAdapterRuntime({
    executor: EXECUTOR, generationFence: { assertCurrent(generation, source) {
      assert.equal(generation, SOURCE.generation); assert.deepEqual(source, SOURCE);
    } },
    provider: {
      async getCode(address, block) {
        assert.equal(block, SOURCE.number);
        if (address.toLowerCase() === PUBLIC.pool) return unsupportedCode ? "0x6000" : PUBLIC.poolCode;
        assert.equal(address.toLowerCase(), FACTORY_ADDRESS); return PUBLIC.factoryCode;
      },
      async getStorage() { throw Error("unexpected storage read"); },
      async call(tx, block) {
        assert.equal(block ?? tx.blockTag, SOURCE.number);
        const result = answer({ id: "production-fixture-read", kind: "eth-call", to: tx.to, data: tx.data, completion: "return-data" });
        assert(result.ok); return result.data;
      },
    },
  });
}
function log(i = 0) {
  return { address: PUBLIC.pool, ...POOL.encodeEventLog(POOL.getEvent("LOG_SWAP")!,
    [EXECUTOR, PINNED.tokens[i], PINNED.tokens[1 - i], 10n, 20n]) };
}

test("declared per-round transports pass production lifecycle and the public receipt detector", async () => {
  const event = log();
  const result = await executeAdapterFamilyLifecycle({ family,
    match: { observation: { kind: "log", source: SOURCE, ...event }, matchedPatternId: "balancer-v1-LOG_SWAP" },
    source: SOURCE, generation: SOURCE.generation, runtime: runtime(), publisher: { publish() {} },
  });
  assert(result.publication, JSON.stringify(result.outcomes));
  assert.equal(result.publication.instances.length, 1);
  const instance = result.publication.instances[0]!;
  const view = buildFamilyRouteGraphView({ routes: instance.routes.map(route => {
    const handle = instance.routeHandles.find(h => h.routeKey === route.routeKey); assert(handle);
    return { family, descriptor: instance.descriptor, route, handle };
  }) });
  assert.equal(view.edges.length, 2);
  for (const edge of view.edges) assert.equal(edge.target.toLowerCase(), PUBLIC.pool);
  for (const i of [0, 1]) {
    const logs = [log(i)], source = createVictimSourceGeneration({ sourceBlock: SOURCE.number,
      sourceBlockHash: SOURCE.hash, receiptId: "offline-v1", logs, logsCompleteness: "fragment" });
    const transition = await detectImpactTransitionFromLogs(logs, [...view.edges], source, null, null,
      () => ({ familyId: ID, descriptor: instance.descriptor }));
    assert.equal(transition.steps.length, 1, JSON.stringify(transition, (_k, v) => typeof v === "bigint" ? v.toString() : v));
    assert.equal(transition.steps[0].impact.pool.toLowerCase(), PUBLIC.pool);
    assert.equal(transition.steps[0].impact.tokenIn.toLowerCase(), PINNED.tokens[i]);
    assert.equal(transition.steps[0].impact.amountOut, 20n);
    const unknown = await detectImpactTransitionFromLogs(logs, [], source);
    assert.equal(unknown.steps.length, 0);
  }
});

test("production memo binding recheck succeeds, declines changed code, and recovers valid evidence", async () => {
  const recheck = (changed = false) => recheckFamilyInstanceMemoBinding({
    family, candidate: CANDIDATE, source: SOURCE, generation: SOURCE.generation, runtime: runtime(changed),
  });
  const first = await recheck(); assert(first, "valid current code must recheck");
  assert.equal(await recheck(true), null);
  assert.deepEqual(await recheck(), first);
});
