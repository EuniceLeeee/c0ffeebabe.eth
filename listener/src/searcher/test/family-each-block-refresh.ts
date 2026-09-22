import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { runUniv2Lifecycle } from "../architecture-migration-fixture-replay.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { createAdapterFamilyExactQuoteCache, type AdapterExactStateCacheAddress } from "../adapter-family-exact-quote-cache.js";
import { buildEffectiveMids } from "../blockscan-effective-mid.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { StrictCurrentRuntimeCoordinator } from "../strict-current-runtime-coordinator.js";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../strict-production-runtime-session.js";
import { defineSwapFamily, definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import { blockScanEdgeKey, createVerifiedGraphView } from "../venues/blockscan-state-capability.js";
import { capabilityManifestHash, FAMILY_CAPABILITY_NAMES, FamilyCapabilityCatalog } from "../venues/family-capability-catalog.js";
import { plugin as productionPlugin } from "../venues/production-families/univ2-standard.production.js";
import { UNIV2_PAIR_INTERFACE, UNIV2_TOKEN_INTERFACE } from "../venues/swaps/univ2-family/codec.js";

// Wiring-only fixture: the production V2 programs are unchanged. Opting a
// cloned definition into each-block lets identical state transitions exercise
// both policies through the actual lifecycle, root, publisher and Exact.
const pool = "0x4141414141414141414141414141414141414141";
const factory = "0x4242424242424242424242424242424242424242";
const token = "0x4444444444444444444444444444444444444444";
const executor = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const unit = 10n ** 18n;
const source = (number: number): CanonicalSource => ({
  number, generation: number, hash: ethers.toBeHex(number, 32),
});
const start = source(900);
function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, clone(entry)]),
  ) as T;
  return value;
}
function definition(refreshPolicy?: "on-touch" | "each-block") {
  return defineSwapFamily({
    ...clone(productionPlugin),
    actionAdapters: productionPlugin.actionAdapters,
    pricing: { ...clone(productionPlugin.pricing), ...(refreshPolicy ? { refreshPolicy } : {}) },
  });
}
assert.throws(() => defineSwapFamily({
  ...clone(productionPlugin),
  actionAdapters: productionPlugin.actionAdapters,
  pricing: { ...clone(productionPlugin.pricing), refreshPolicy: "invalid" as "each-block" },
}), /refreshPolicy/);

for (const policy of [undefined, "on-touch", "each-block"] as const) {
  const plugin = definition(policy);
  const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({
    familyId: plugin.manifest.familyId, capability, contractVersion: "refresh-fixture-v1",
    contentHash: ethers.sha256(ethers.toUtf8Bytes(capability)).slice(2),
    semanticDependencies: ["contract:" + capability], provenanceCommit: null,
  }));
  const catalog = new FamilyCapabilityCatalog({
    modules: [{ sourceFile: "fixture/refresh.production.ts", plugin,
      definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
    generatedManifest: { format: "adapter-family-capabilities-v1", entries,
      manifestHash: capabilityManifestHash(entries) },
  });
  const family = catalog.forFamily(plugin.manifest.familyId);
  const ready = await runUniv2Lifecycle(start, { pool, factory, token0: ADDR.WETH,
    token1: token, reserves: { reserve0: 1_000n * unit, reserve1: 2_000n * unit,
      blockTimestampLast: start.number } }, catalog);
  const edges = buildFamilyRouteGraphView({ routes: ready.instances.flatMap(instance =>
    instance.routes.map((route, i) => ({ family, descriptor: instance.descriptor,
      route, handle: instance.routeHandles[i] }))) }).edges;
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: start,
    readyGraph: edges, readyInstances: ready.instances, readyFundingAssets: [] });
  const eachBlock = policy === "each-block";
  const stateKey = root.pricingIndex().stateKeyByEdgeKey.get(blockScanEdgeKey(edges[0]!))!;
  assert.deepEqual(root.pricingIndex().perBlockRefreshStateKeys, eachBlock ? [stateKey] : []);
  const graph = (at: CanonicalSource) => createVerifiedGraphView({
    id: "refresh-" + at.number, edges, generation: at.generation,
    sourceBlock: at.number, sourceBlockHash: at.hash, completenessWatermark: at.number,
    familyIdForEdge: () => plugin.manifest.familyId,
    perSourceCoverage: [{ familyId: plugin.manifest.familyId, sourceId: "fixture",
      sourceFingerprint: "each-block", completeThroughBlock: at.number, completeThroughHash: at.hash }],
  });
  const reads: string[] = [];
  let failed = false;
  function runtime(at: CanonicalSource, lane: string) {
    return createStrictCentralAdapterRuntime({
      executor,
      generationFence: { assertCurrent(generation, current) {
        assert.equal(generation, at.generation); assert.deepEqual(current, at);
      } },
      provider: {
        async getCode() { throw new Error("unexpected code read"); },
        async getStorage() { throw new Error("unexpected storage read"); },
        async call(request, block) {
          assert.equal(block, at.number);
          const selector = request.data.slice(0, 10);
          const reserve0 = 1_000n * unit;
          const reserve1 = BigInt(at.number - start.number + 2) * 1_000n * unit;
          if (selector === UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector) {
            reads.push(lane);
            if (failed) throw new Error("fixture state unavailable");
            return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [reserve0, reserve1, at.number]);
          }
          if (selector === UNIV2_TOKEN_INTERFACE.getFunction("balanceOf")!.selector) {
            return UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf",
              [request.to.toLowerCase() === ADDR.WETH.toLowerCase() ? reserve0 : reserve1]);
          }
          throw new Error("unexpected fixture call " + selector);
        },
      },
    });
  }
  const cache = createAdapterFamilyExactQuoteCache();
  const coordinator = new StrictCurrentRuntimeCoordinator(request => root.createSession({
    source: request.source, runtime: runtime(request.source, "raw"),
    fundingAssets: [], kind: "pricing", touchedPools: request.touchedPools, control: request.control,
  }), () => {}, undefined, async (pricing, control, _backend, reuse) => {
    const target = reuse?.quoteGraph ?? pricing;
    const at = { number: target.sourceBlock, hash: target.sourceBlockHash, generation: target.generation };
    let exact: StrictProductionRuntimeSession | undefined;
    return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous,
      touchedStateKeys: reuse?.touchedStateKeys, control, weth: ADDR.WETH,
      gasCostWei: null, enumerationSpreadBps: 50, concurrency: 2,
      prepareQuote: async requiredEdgeIds => {
        exact = await root.createSession({ source: at, runtime: runtime(at, "exact"),
          fundingAssets: [], kind: "exact", requiredEdgeIds, control });
      },
      quote: async request => {
        assert(exact);
        const quoted = await exact.issueExact({ ...request, executor, runtimeEvidence: [] });
        assert("amountIn" in quoted); return quoted;
      },
    });
  }, cache);
  const step = async (at: CanonicalSource, touchedStateKeys = new Set<string>()) => {
    await coordinator.prepareCoarsePricing({ graph: graph(at), deadlineAtMs: Date.now() + 10_000,
      touchedPools: touchedStateKeys, canonicalActivity: {
        source: at, parentHash: source(at.number - 1).hash, touchedStateKeys, complete: true,
      } });
    assert.equal(touchedStateKeys.size, 0, "must not mutate the observed activity Set");
    return coordinator.latestPricingSnapshot()!;
  };
  const before = await step(start);
  assert.equal(before.mids.size, 2); assert.equal(before.effectiveMids!.rows.size, 2);
  assert([...before.effectiveMids!.rows.values()].every(row => row.status === "quoted"));
  assert.deepEqual(before.perBlockRefreshStateKeys, eachBlock ? [stateKey] : []);

  // Sentinel cache entries prove actual coordinator invalidation is selective.
  const instance = ready.instances[0]!;
  const cacheAddress: AdapterExactStateCacheAddress = {
    familyRuntimeIdentity: {}, familyId: instance.familyId, instanceKey: instance.instanceKey,
    routeKey: instance.routes[0]!.routeKey, stateKey, instanceFingerprint: "01".repeat(32),
    routeBindingFingerprint: "02".repeat(32), capabilityHash: "03".repeat(32),
    compatibilityFingerprint: "04".repeat(32), methodId: "state", methodIndex: 0,
    methodOrderFingerprint: "05".repeat(32), requestFingerprint: "06".repeat(32),
    amountIn: 1n, executor, source: start,
  };
  const cached = { trustedResults: [{ id: "state", ok: true as const, source: start,
    provenance: { kind: "eth-call", fingerprint: "fixture" },
    completion: "returned" as const, data: "0x6000" }],
    roundFingerprints: ["07".repeat(32)], evidenceRefs: [] };
  assert(cache.storeState(cacheAddress, cached));
  const otherAddress = { ...cacheAddress, stateKey: "state:unrelated" };
  assert(cache.storeState(otherAddress, cached));
  reads.length = 0;
  const after = await step(source(901));
  assert.deepEqual(reads, eachBlock ? ["raw", "exact", "exact"] : []);
  assert(cache.lookupState({ ...otherAddress, source: source(901) }), "unrelated state must remain reusable");
  assert.equal(Boolean(cache.lookupState({ ...cacheAddress, source: source(901) })), !eachBlock);
  for (const [key, row] of before.effectiveMids!.rows) {
    const updated = after.effectiveMids!.rows.get(key)!;
    if (eachBlock) {
      assert.notEqual(updated.amountOut, row.amountOut);
      assert.deepEqual(updated.quotedAt, source(901));
      assert.equal(after.pricingProvenanceByEdgeKey!.get(key), "refreshed");
    } else {
      assert.equal(updated, row, "default policy must preserve clean effective rows");
      assert.equal(after.pricingProvenanceByEdgeKey!.get(key), "carried");
    }
  }
  if (!eachBlock) {
    assert.equal(after.mids, before.mids, "quiet default path must reuse the raw Map");
    assert.equal(after.effectiveMids!.rows, before.effectiveMids!.rows);
    continue;
  }
  // Failed quiet blocks must drop prices, not carry source-stale outputs.
  failed = true;
  const failure = await step(source(902));
  assert.equal(failure.mids.size, 0);
  assert.equal(failure.effectiveMids!.rows.size, 0);
  const stillFailed = await step(source(903));
  assert.equal(stillFailed.mids.size, 0); assert.equal(stillFailed.effectiveMids!.rows.size, 0);
  failed = false;
  const recovered = await step(source(904));
  assert.equal(recovered.mids.size, 2); assert.equal(recovered.effectiveMids!.rows.size, 2);
  // Sizing uses the last published raw table. After a total price outage,
  // WETH can quote immediately; other tokens regain their conversion on
  // the next block. Never manufacture an old reference during recovery.
  assert([...recovered.effectiveMids!.rows.values()].some(row => row.status === "quoted"));
  const fullyRecovered = await step(source(905));
  assert([...fullyRecovered.effectiveMids!.rows.values()].every(row => row.status === "quoted"));

  // Repeating the same source must not invalidate refreshed state again.
  const retryAddress = { ...cacheAddress, source: source(905) };
  assert(cache.storeState(retryAddress, { ...cached,
    trustedResults: cached.trustedResults.map(result => ({ ...result, source: source(905) })) }));
  await step(source(905));
  assert(cache.lookupState(retryAddress), "same-source retry preserves refreshed state");
}
console.log("Family refresh policy: production raw/effective, selective cache, failure/recovery and default delta reuse PASS");
