import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { runStrictFamilyLifecycle } from "../../../../strict-family-lifecycle-runner.js";
import { runUniv2Lifecycle } from "../../../../architecture-migration-fixture-replay.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { StrictCurrentRuntimeCoordinator } from "../../../../strict-current-runtime-coordinator.js";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../../../../strict-production-runtime-session.js";
import { buildEffectiveMids, effectiveEnumerationMids } from "../../../../blockscan-effective-mid.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_LOAD as load } from "../../../production-family-composition.js";
import { FamilyCapabilityCatalog } from "../../../family-capability-catalog.js";
import { generatedCapabilityManifestFromShadowArtifact } from "../../../family-capability-shadow.js";
import artifact from "../../../../generated/family-capability-shadow.generated.json";
import { blockScanEdgeKey, createVerifiedGraphView } from "../../../blockscan-state-capability.js";
import { UNIV2_PAIR_INTERFACE, UNIV2_TOKEN_INTERFACE } from "../../../swaps/univ2-family/codec.js";
import { FAMILY } from "../manifest.js";
import { ABI } from "../codec.js";
import { addr, actor, source, fixture, attest, reads } from "./fixtures.js";

// Include the installed but default-disabled Family only in this test catalog.
const modules = [...load.plugins, ...load.disabledPlugins];
const catalog = new FamilyCapabilityCatalog({ modules, requireCapture: true,
  generatedManifest: generatedCapabilityManifestFromShadowArtifact({ artifact, strictFamilyIds: modules.map(m => m.familyId) }) });

// Canned chain responses through actual lifecycle/root/Exact/coordinator wiring.
// This proves recovery policy, not real-chain re-kick execution or performance.
for (const path of ["coarse", "runtime"] as const) test(`Yearn ${path}: active -> empty/expired -> re-kick without stale effective carry`, async () => {
  const f = fixture(), initial = { ...f }, effects = new Map<string, { data: string; effects: any }>();
  f.mutate = r => { effects.set(r.id, { data: r.data, effects: r.effects }); };
  assert.equal(attest(f).decision.status, "verified");
  const at = (tick: number) => ({ number: source.number + tick, hash: tick ? ethers.id("yearn-refresh-" + tick) : source.hash, generation: tick + 1 });
  const pools = [addr(301), addr(302)], tokens = [f.want, f.sold], observations: { lane: string; name: string; tick: number }[] = [];
  const runtime = (tick: number, lane: string) => createStrictCentralAdapterRuntime({ executor: actor,
    generationFence: { assertCurrent(generation, requested) { assert.equal(generation, at(tick).generation); assert.deepEqual(requested, at(tick)); } },
    simulator: { executorProgramCodeHash: ethers.keccak256("0x6000"),
      async simulate({ request, source: requested }) { assert.deepEqual(requested, source); assert.equal(tick, 0);
      const result = effects.get(request.id); assert(result); return result; } },
    provider: {
      async getStorage() { throw new Error("unexpected auction storage read"); },
      async getCode(address, block) { assert.equal(block, at(tick).number);
        const r = reads(f, [{ id: "code", kind: "get-code", address }])[0]!; assert(r.ok); return r.data; },
      async call(request, block) {
        assert.equal(block, at(tick).number);
        if (pools.includes(request.to.toLowerCase())) {
          assert.equal(request.data.slice(0, 10), UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector);
          observations.push({ lane, name: "getReserves", tick });
          return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [10n ** 24n, 10n ** 24n, source.number]);
        }
        if (request.data.slice(0, 10) === UNIV2_TOKEN_INTERFACE.getFunction("balanceOf")!.selector)
          return UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [10n ** 24n]);
        const call = ABI.parseTransaction({ data: request.data }); assert(call); observations.push({ lane, name: call.name, tick });
        const r = reads(f, [{ id: "read", kind: "eth-call", to: request.to, data: request.data, completion: "return-data" }])[0]!;
        assert(r.ok); return r.data;
      },
    },
  });
  const event = ABI.encodeEventLog(ABI.getEvent("AuctionKicked")!, [f.sold, f.available]);
  const admitted = await runStrictFamilyLifecycle({ catalog, familyId: FAMILY, source, runtime: runtime(0, "identity"),
    observations: [{ kind: "log", source, address: f.target, ...event }] });
  assert.equal(admitted.instances.length, 1); assert.equal(admitted.instances[0]!.routes.length, 1);
  const background = await Promise.all(pools.map((pool, i) => runUniv2Lifecycle(source, { pool, factory: addr(303), token0: ADDR.WETH,
    token1: tokens[i]!, reserves: { reserve0: 10n ** 24n, reserve1: 10n ** 24n, blockTimestampLast: source.number } }, catalog)));
  const instances = [...admitted.instances, ...background.flatMap(p => p.instances)];
  const edges = buildFamilyRouteGraphView({ routes: instances.flatMap(i => i.routes.map((route, n) => ({
    family: catalog.forFamily(i.familyId), descriptor: i.descriptor, route, handle: i.routeHandles[n],
  }))) }).edges;
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: source, readyGraph: edges, readyInstances: instances, readyFundingAssets: [] });
  const index = root.pricingIndex(), own = edges.filter(e => index.familyIdByEdgeKey.get(blockScanEdgeKey(e)) === FAMILY).map(blockScanEdgeKey);
  assert.equal(own.length, 1); const key = own[0]!;
  assert.deepEqual(index.perBlockRefreshStateKeys, [index.stateKeyByEdgeKey.get(key)]);
  const coordinator = new StrictCurrentRuntimeCoordinator(request => root.createSession({ source: request.source, fundingAssets: [],
    kind: request.purpose === "exact-execution" ? "exact" : "pricing", requiredEdgeIds: request.requiredEdgeIds, control: request.control,
    runtime: runtime(request.source.number - source.number, "raw"),
  }), () => {}, undefined, async (pricing, control, _backend, reuse) => {
    const current = reuse?.quoteGraph ?? pricing, requested = { number: current.sourceBlock, hash: current.sourceBlockHash, generation: current.generation };
    let exact: StrictProductionRuntimeSession | undefined;
    return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous, touchedStateKeys: reuse?.touchedStateKeys,
      disabledEdgeIds: reuse?.disabledEdgeIds, control, weth: ADDR.WETH, gasCostWei: null, enumerationSpreadBps: 0, concurrency: 2,
      prepareQuote: async requiredEdgeIds => { exact = await root.createSession({ source: requested, fundingAssets: [], kind: "exact", requiredEdgeIds,
        control, runtime: runtime(requested.number - source.number, "exact") }); },
      quote: async request => { assert(exact); const q = await exact.issueExact({ ...request, executor: actor, runtimeEvidence: [] }); assert("amountIn" in q); return q; },
    });
  });
  const modes = ["active", "empty", "empty", "re-kick", "expired", "expired", "re-kick"];
  let baseline: ReturnType<typeof coordinator.latestPricingSnapshot>;
  for (const [tick, mode] of modes.entries()) {
    f.available = mode === "empty" ? 0n : initial.available;
    f.rawPrice = mode === "expired" ? 0n : initial.rawPrice - BigInt(tick);
    observations.length = 0; const current = at(tick), touched = new Set<string>();
    const graph = createVerifiedGraphView({ id: "yearn-refresh-" + tick, edges, generation: current.generation, sourceBlock: current.number,
      sourceBlockHash: current.hash, completenessWatermark: current.number,
      familyIdForEdge: e => index.familyIdByEdgeKey.get(blockScanEdgeKey(e))!,
      perSourceCoverage: [...new Set(instances.map(i => i.familyId))].map(familyId => ({ familyId,
        sourceId: "fixture", sourceFingerprint: "yearn-refresh", completeThroughBlock: current.number, completeThroughHash: current.hash })) });
    const args = { graph, deadlineAtMs: Date.now() + 10000, touchedPools: touched,
      canonicalActivity: { source: current, parentHash: tick ? at(tick - 1).hash : ethers.ZeroHash, touchedStateKeys: touched, complete: true as const } };
    if (path === "coarse") await coordinator.prepareCoarsePricing(args); else await coordinator.prepare({ ...args, fundingTokens: [] });
    const snapshot = coordinator.latestPricingSnapshot()!, row = snapshot.effectiveMids!.rows.get(key)!;
    assert.equal(snapshot.sourceBlock, current.number); assert.equal(snapshot.sourceBlockHash, current.hash);
    const healthy = mode === "active" || mode === "re-kick";
    assert.equal(row.status, healthy ? "quoted" : "quote-failed");
    if (healthy) { assert.deepEqual(row.quotedAt, current); assert(row.amountOut! > 0n); }
    else { assert.equal(row.amountOut, null); assert.equal(row.quotedAt, undefined); assert(!effectiveEnumerationMids(snapshot).has(key)); }
    if (!tick) baseline = snapshot;
    else {
      assert(!observations.some(o => o.lane === "raw" || o.name === "getReserves"));
      assert(observations.some(o => o.lane === "exact" && o.name === "available"), "must probe current state again even after all directions fail");
      for (const [id, prior] of baseline!.effectiveMids!.rows) if (id !== key) assert.strictEqual(snapshot.effectiveMids!.rows.get(id), prior);
    }
    assert.equal(touched.size, 0);
  }
});
