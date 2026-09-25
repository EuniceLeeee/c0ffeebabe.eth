import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import { runUniv2Lifecycle } from "../../../architecture-migration-fixture-replay.js";
import { buildFamilyRouteGraphView } from "../../../adapter-family-graph-runtime.js";
import { createAdapterFamilyExactQuoteCache, type AdapterExactStateCacheAddress } from "../../../adapter-family-exact-quote-cache.js";
import { buildEffectiveMids } from "../../../blockscan-effective-mid.js";
import { createStrictCentralAdapterRuntime } from "../../../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../../../strict-family-lifecycle-runner.js";
import { StrictCurrentRuntimeCoordinator } from "../../../strict-current-runtime-coordinator.js";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../../../strict-production-runtime-session.js";
import type { CanonicalSource } from "../../../venues/adapter-request-program.js";
import { blockScanEdgeKey, createVerifiedGraphView } from "../../../venues/blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../venues/production-family-composition.js";
import { POOL, TOKEN, GOVERNANCE, FEE_DENOMINATOR, MOONISWAP_ID, lower } from "../../../venues/swaps/mooniswap-family/codec.js";
import { SWAPPED_TOPIC } from "../../../venues/swaps/mooniswap-family/discovery.js";
import { UNIV2_PAIR_INTERFACE, UNIV2_TOKEN_INTERFACE } from "../../../venues/swaps/univ2-family/codec.js";

// Offline wiring evidence only. Real cached runtime/receipt nominate Mooniswap;
// state getter replies and source blocks are synthetic. No provider sockets,
// manual admitted instances, injected Graph edges, or alternate price producer.
const cacheDir = process.env.MOONISWAP_EVIDENCE_DIR;
assert(cacheDir, "MOONISWAP_EVIDENCE_DIR must name the cached corpus");
const pool = "0x2c4ea51d9dec7cdabe2d1bde01882f87b5231d21";
const tx = "0x03d2dc13a13e6a71bcf21c1f3134c4167eb29cd20bb96ad7853249d1816a2dd8";
const html = readFileSync(join(cacheDir, "contracts", pool + ".html"), "utf8");
const runtimeCode = html.slice(html.indexOf("Deployed Bytecode")).match(/0x[0-9a-fA-F]{200,}/)![0];
const args = ethers.AbiCoder.defaultAbiCoder().decode(["address", "address", "string", "string", "address"],
  "0x" + html.slice(html.indexOf("Constructor Arguments")).match(/<pre[^>]*>([0-9a-f]+)/)![1]);
const token0 = lower(String(args[0])), token1 = lower(String(args[1])), governance = lower(String(args[4]));
const cached = JSON.parse(readFileSync(join(cacheDir, "raw", tx + ".json"), "utf8"));
const log = cached.receipt.logs.find((l: { address: string; topics: string[] }) => l.address === pool && l.topics[0] === SWAPPED_TOPIC);
assert(log);
const executor = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const replacement = "0x5555555555555555555555555555555555555555";
const unit = 10n ** 18n;
const source = (number: number): CanonicalSource => ({ number, generation: number, hash: ethers.toBeHex(number, 32) });
const start = source(900);
const word = (value: string | bigint) => ethers.toBeHex(BigInt(value), 32);
const stablePools = ["0x4141414141414141414141414141414141414141", "0x4343434343434343434343434343434343434343"];
let failed = false, active = true, currentGovernance = governance;
const reads: { lane: string; target: string; method: string; block: number }[] = [];

function runtime(at: CanonicalSource, lane: string) {
  return createStrictCentralAdapterRuntime({ executor,
    generationFence: { assertCurrent(generation, requested) { assert.equal(generation, at.generation); assert.deepEqual(requested, at); } },
    provider: {
      async getCode(address, block) {
        assert.equal(block, at.number);
        if (lower(address) === pool) return runtimeCode;
        assert([token0, token1].includes(lower(address))); return "0x60006000";
      },
      async getStorage() { throw new Error("unexpected storage read"); },
      async call(request, block) {
        assert.equal(block, at.number);
        const target = lower(request.to), selector = request.data.slice(0, 10);
        if (stablePools.includes(target)) {
          assert.equal(selector, UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector);
          reads.push({ lane, target, method: "getReserves", block });
          return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [1000n * unit, 2000n * unit, 900]);
        }
        if (selector === TOKEN.getFunction("balanceOf")!.selector) {
          const owner = lower(String(TOKEN.decodeFunctionData("balanceOf", request.data)[0]));
          if (stablePools.includes(owner)) return UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [target === lower(ADDR.WETH) ? 1000n * unit : 2000n * unit]);
          assert.equal(owner, pool); assert.equal(request.from, executor);
          return word(target === token0 ? 1000n * unit : 2000n * unit);
        }
        assert.equal(request.from, executor);
        if ([token0, token1].includes(target)) {
          assert.equal(selector, TOKEN.getFunction("decimals")!.selector); return word(18n);
        }
        if ([governance, replacement].includes(target)) {
          assert.equal(target, currentGovernance, "dependent reads must rebind to current getter");
          assert.equal(request.data, GOVERNANCE.encodeFunctionData("isActive"));
          reads.push({ lane, target, method: "isActive", block });
          if (failed) throw new Error("synthetic offline fresh-read failure");
          return word(active ? 1n : 0n);
        }
        assert.equal(target, pool);
        const parsed = POOL.parseTransaction({ data: request.data }); assert(parsed);
        reads.push({ lane, target, method: parsed.name, block });
        const delta = BigInt(at.number - start.number);
        switch (parsed.name) {
          case "token0": return word(token0);
          case "token1": return word(token1);
          case "mooniswapFactoryGovernance": return word(currentGovernance);
          case "fee":
            if (failed) throw new Error("synthetic offline fresh-read failure");
            return word((3n + delta) * 10n ** 15n);
          case "slippageFee": return word(FEE_DENOMINATOR);
          case "getBalanceForAddition": return word((lower(String(parsed.args[0])) === token0 ? 1500n - delta : 3000n - delta) * unit);
          case "getBalanceForRemoval": return word((lower(String(parsed.args[0])) === token0 ? 900n + delta : 1200n + delta) * unit);
          // Synthetic transport response, NOT a local Mooniswap quote formula.
          case "getReturn": return word(BigInt(parsed.args.amount) * (10n + delta) / 10n);
          default: throw new Error("unexpected method " + parsed.name);
        }
      },
    },
  });
}

const moonReady = await runStrictFamilyLifecycle({ catalog, familyId: MOONISWAP_ID, source: start,
  observations: [{ kind: "log", address: log.address, topics: log.topics, data: log.data, source: start }],
  runtime: runtime(start, "identity") });
assert.equal(moonReady.instances.length, 1);
assert.equal(moonReady.instances[0]!.routes.length, 2);
const otherReady = await Promise.all(stablePools.map((address, index) => runUniv2Lifecycle(start, {
  pool: address, factory: "0x4242424242424242424242424242424242424242",
  token0: ADDR.WETH, token1: index === 0 ? token0 : token1,
  reserves: { reserve0: 1000n * unit, reserve1: 2000n * unit, blockTimestampLast: 900 },
}, catalog)));
const instances = [...moonReady.instances, ...otherReady.flatMap(r => r.instances)];
const edges = buildFamilyRouteGraphView({ routes: instances.flatMap(instance => instance.routes.map((route, i) => ({
  family: catalog.forFamily(instance.familyId), descriptor: instance.descriptor, route, handle: instance.routeHandles[i],
}))) }).edges;
assert.equal(edges.length, 6);
const root = new StrictProductionRuntimeRoot({ catalog, readySource: start, readyGraph: edges, readyInstances: instances, readyFundingAssets: [] });
const moonKeys = edges.filter(e => root.pricingIndex().familyIdByEdgeKey.get(blockScanEdgeKey(e)) === MOONISWAP_ID).map(blockScanEdgeKey);
const stableKeys = edges.map(blockScanEdgeKey).filter(k => !moonKeys.includes(k));
const stateKey = root.pricingIndex().stateKeyByEdgeKey.get(moonKeys[0])!;
assert.deepEqual(root.pricingIndex().perBlockRefreshStateKeys, [stateKey]);
const graph = (at: CanonicalSource) => createVerifiedGraphView({ id: "mooniswap-offline-" + at.number,
  edges, generation: at.generation, sourceBlock: at.number, sourceBlockHash: at.hash, completenessWatermark: at.number,
  familyIdForEdge: e => root.pricingIndex().familyIdByEdgeKey.get(blockScanEdgeKey(e))!,
  perSourceCoverage: [...new Set(instances.map(i => i.familyId))].map(familyId => ({ familyId,
    sourceId: "synthetic-state", sourceFingerprint: "mooniswap-each-block-contract",
    completeThroughBlock: at.number, completeThroughHash: at.hash })),
});
const exactCache = createAdapterFamilyExactQuoteCache();
const coordinator = new StrictCurrentRuntimeCoordinator(request => root.createSession({
  source: request.source, runtime: runtime(request.source, "raw"), fundingAssets: [],
  kind: request.purpose === "exact-execution" ? "exact" : "pricing",
  touchedPools: request.touchedPools, requiredEdgeIds: request.requiredEdgeIds, control: request.control,
}), () => {}, undefined, async (pricing, control, _backend, reuse) => {
  const target = reuse?.quoteGraph ?? pricing;
  const at = { number: target.sourceBlock, hash: target.sourceBlockHash, generation: target.generation };
  let exact: StrictProductionRuntimeSession | undefined;
  return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous,
    touchedStateKeys: reuse?.touchedStateKeys, control, weth: ADDR.WETH, gasCostWei: null,
    enumerationSpreadBps: 50, concurrency: 2,
    prepareQuote: async requiredEdgeIds => { exact = await root.createSession({ source: at,
      runtime: runtime(at, "exact"), fundingAssets: [], kind: "exact", requiredEdgeIds, control }); },
    quote: async request => { assert(exact);
      const quoted = await exact.issueExact({ ...request, executor, runtimeEvidence: [] });
      assert("amountIn" in quoted); return quoted;
    },
  });
}, exactCache);
const reports: object[] = [];
async function step(number: number) {
  reads.length = 0;
  const at = source(number), touched = new Set<string>();
  await coordinator.prepareCoarsePricing({ graph: graph(at), deadlineAtMs: Date.now() + 10_000, touchedPools: touched,
    canonicalActivity: { source: at, parentHash: source(number - 1).hash, touchedStateKeys: touched, complete: true } });
  assert.equal(touched.size, 0);
  const snapshot = coordinator.latestPricingSnapshot()!;
  assert.equal(snapshot.sourceBlock, number);
  assert.deepEqual(snapshot.perBlockRefreshStateKeys, [stateKey]);
  if (number !== start.number) {
    assert(!reads.some(r => r.lane === "raw"), "startup raw references must not trigger steady-state reads");
    assert(!reads.some(r => stablePools.includes(r.target)), "unrelated on-touch pools must not be reread");
  }
  reports.push({ source: at, touched: [], realBalances: [String(1000n * unit), String(2000n * unit)],
    governance: currentGovernance, active, failed,
    reads: [...reads], mooniswap: moonKeys.map(key => ({ key,
    mid: snapshot.mids.get(key)?.mid ?? null, provenance: snapshot.pricingProvenanceByEdgeKey?.get(key) ?? null,
    effective: snapshot.effectiveMids?.rows.get(key) ?? null })) });
  return snapshot;
}
const before = await step(900);
assert.equal(before.mids.size, 6); assert.equal(before.effectiveMids!.rows.size, 6);
assert([...before.effectiveMids!.rows.values()].every(row => row.status === "quoted"));
// Generic sentinels test actual coordinator invalidation, not invented Family
// state-only support: Mooniswap's getReturn is deliberately amount-dependent.
const cacheAddress: AdapterExactStateCacheAddress = {
  familyRuntimeIdentity: {}, familyId: MOONISWAP_ID, instanceKey: moonReady.instances[0]!.instanceKey,
  routeKey: moonReady.instances[0]!.routes[0]!.routeKey, stateKey, instanceFingerprint: "01".repeat(32),
  routeBindingFingerprint: "02".repeat(32), capabilityHash: "03".repeat(32), compatibilityFingerprint: "04".repeat(32),
  methodId: "sentinel", methodIndex: 0, methodOrderFingerprint: "05".repeat(32), requestFingerprint: "06".repeat(32),
  amountIn: 1n, executor, source: start,
};
const cachedState = { trustedResults: [{ id: "sentinel", ok: true as const, source: start,
  provenance: { kind: "synthetic", fingerprint: "sentinel" }, completion: "returned" as const, data: "0x6000" }],
  roundFingerprints: ["07".repeat(32)], evidenceRefs: [] };
const unrelatedAddress = { ...cacheAddress, stateKey: root.pricingIndex().stateKeyByEdgeKey.get(stableKeys[0])! };
assert(exactCache.storeState(cacheAddress, cachedState)); assert(exactCache.storeState(unrelatedAddress, cachedState));
const after = await step(901);
assert(!exactCache.lookupState({ ...cacheAddress, source: source(901) }));
assert(exactCache.lookupState({ ...unrelatedAddress, source: source(901) }));
assert.strictEqual(after.mids, before.mids, "quiet-block effective refresh preserves startup raw references");
assert.deepEqual(after.rawMidSource, start);
for (const key of moonKeys) {
  assert.equal(after.effectiveMids!.rows.get(key)!.status, "quoted");
  assert.equal(after.pricingProvenanceByEdgeKey!.get(key), "refreshed");
  assert.notEqual(after.effectiveMids!.rows.get(key)!.amountOut, before.effectiveMids!.rows.get(key)!.amountOut);
  assert.deepEqual(after.effectiveMids!.rows.get(key)!.quotedAt, source(901));
}
assert.equal(reads.filter(r => r.method === "getReturn").length, 2);
assert.equal(reads.filter(r => r.method === "isActive").length, 2);
for (const key of stableKeys) {
  assert.equal(after.effectiveMids!.rows.get(key), before.effectiveMids!.rows.get(key));
  assert.equal(after.pricingProvenanceByEdgeKey!.get(key), "carried");
}
currentGovernance = replacement;
const rebound = await step(902);
assert.equal(reads.filter(r => r.method === "isActive" && r.target === replacement).length, 2);
assert.strictEqual(rebound.mids, before.mids);
for (const key of moonKeys) {
  assert(rebound.mids.has(key)); assert.equal(rebound.effectiveMids!.rows.get(key)!.status, "quoted");
  assert.deepEqual(rebound.effectiveMids!.rows.get(key)!.quotedAt, source(902));
}
failed = true;
for (const number of [903, 904]) {
  const broken = await step(number);
  assert.strictEqual(broken.mids, before.mids);
  for (const key of moonKeys) {
    assert.equal(broken.effectiveMids!.rows.get(key)!.status, "quote-failed");
    assert(broken.coverage.unresolvedEdgeKeys.includes(key));
    assert(!broken.coverage.resolvedEdgeKeys.includes(key));
  }
  for (const key of stableKeys) assert.equal(broken.effectiveMids!.rows.get(key), before.effectiveMids!.rows.get(key));
}
failed = false; active = false;
const shutdown = await step(905);
assert.strictEqual(shutdown.mids, before.mids);
for (const key of moonKeys) {
  assert.equal(shutdown.effectiveMids!.rows.get(key)!.status, "quote-failed");
  assert(shutdown.coverage.unresolvedEdgeKeys.includes(key));
}
active = true;
const recovered = await step(906);
assert.strictEqual(recovered.mids, before.mids);
for (const key of moonKeys) {
  assert(recovered.mids.has(key)); assert.equal(recovered.effectiveMids!.rows.get(key)!.status, "quoted");
  assert.deepEqual(recovered.effectiveMids!.rows.get(key)!.quotedAt, source(906));
}
console.log(JSON.stringify({ evidence: "offline synthetic production wiring; not historical EVM parity", reports },
  (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
console.log("Mooniswap production lifecycle + frozen raw/current effective + quiet-block Exact invalidation + failure/shutdown/recovery + unrelated reuse PASS");
