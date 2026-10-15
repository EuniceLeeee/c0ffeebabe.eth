import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { fluidDexFixtureRuntime, FLUID_DEX_FIXTURE_POOL, FLUID_DEX_FIXTURE_TOKEN0,
  FLUID_DEX_FIXTURE_TOKEN1, runUniv2Lifecycle } from "../../../../architecture-migration-fixture-replay.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { buildEffectiveMids } from "../../../../blockscan-effective-mid.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../../../../strict-family-lifecycle-runner.js";
import { StrictCurrentRuntimeCoordinator } from "../../../../strict-current-runtime-coordinator.js";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../../../../strict-production-runtime-session.js";
import { blockScanEdgeKey, createVerifiedGraphView } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { UNIV2_PAIR_INTERFACE, UNIV2_TOKEN_INTERFACE } from "../../../swaps/univ2-family/codec.js";
import { FLUID_DEX_INTERFACE } from "../codec.js";
import { FLUID_DEX_FAMILY_ID } from "../manifest.js";

// Offline transport fixtures exercise the unchanged production lifecycle,
// Family, Exact, coordinator and publication. No RPC, EVM or pricing formula claim.
test("Fluid DEX quiet effective refresh, failure withdrawal/recovery and unrelated carry", async () => {
  const vault = FLUID_DEX_FIXTURE_POOL, asset = FLUID_DEX_FIXTURE_TOKEN0;
  const familyId = FLUID_DEX_FAMILY_ID;
  const unit = 10n ** 18n, executor = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const at = (tick: number) => ({ number: 500 + tick, generation: 500 + tick, hash: ethers.toBeHex(500 + tick, 32) });
  const source = at(0), pools = ["0x4141414141414141414141414141414141414141", "0x4242424242424242424242424242424242424242"];
  const factory = "0x4343434343434343434343434343434343434343";
  const admitted = await runStrictFamilyLifecycle({ catalog, familyId, source,
    observations: [{ kind: "call", target: vault, data: FLUID_DEX_INTERFACE.encodeFunctionData("swapIn", [true, unit, 0n,
      "0x000000000000000000000000000000000000dEaD"]), source }], runtime: fluidDexFixtureRuntime() });
  assert.equal(admitted.instances.length, 1);
  assert.equal(admitted.instances[0]!.routes.length, 2);
  const background = await Promise.all(pools.map((pool, i) => runUniv2Lifecycle(source, { pool, factory,
    token0: ADDR.WETH, token1: [asset, FLUID_DEX_FIXTURE_TOKEN1][i]!, reserves: { reserve0: 1000n * unit,
      reserve1: 2000n * unit, blockTimestampLast: source.number } }, catalog)));
  const instances = [...admitted.instances, ...background.flatMap(r => r.instances)];
  const edges = buildFamilyRouteGraphView({ routes: instances.flatMap(instance => instance.routes.map((route, i) => ({
    family: catalog.forFamily(instance.familyId), descriptor: instance.descriptor, route, handle: instance.routeHandles[i],
  }))) }).edges;
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: source, readyGraph: edges,
    readyInstances: instances, readyFundingAssets: [] });
  const ownKeys = edges.map(blockScanEdgeKey).filter(key => root.pricingIndex().familyIdByEdgeKey.get(key) === familyId);
  const otherKeys = edges.map(blockScanEdgeKey).filter(k => !ownKeys.includes(k));
  assert.equal(ownKeys.length, 2); assert.equal(otherKeys.length, 4);
  assert.deepEqual(root.pricingIndex().perBlockRefreshStateKeys,
    ownKeys.map(key => root.pricingIndex().stateKeyByEdgeKey.get(key)!));
  let failed = false;
  const reads: { lane: string; method: string; tick: number }[] = [];
  function runtime(tick: number, lane: string) {
    const current = at(tick);
    return createStrictCentralAdapterRuntime({ executor,
      generationFence: { assertCurrent(generation, requested) { assert.equal(generation, current.generation); assert.deepEqual(requested, current); } },
      provider: {
        async getCode() { throw new Error("unexpected refresh code read"); },
        async getStorage() { throw new Error("unexpected refresh storage read"); },
        async call(request, block) {
          assert.equal(block, current.number);
          const target = request.to.toLowerCase(), selector = request.data.slice(0, 10);
          if (pools.includes(target)) {
            assert.equal(selector, UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector);
            reads.push({ lane, method: "getReserves", tick });
            return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [1000n * unit, 2000n * unit, source.number]);
          }
          if (selector === UNIV2_TOKEN_INTERFACE.getFunction("balanceOf")!.selector) {
            const holder = String(UNIV2_TOKEN_INTERFACE.decodeFunctionData("balanceOf", request.data)[0]).toLowerCase();
            assert(pools.includes(holder));
            return UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [target === ADDR.WETH.toLowerCase() ? 1000n * unit : 2000n * unit]);
          }
          assert.equal(target, vault);
          const call = FLUID_DEX_INTERFACE.parseTransaction({ data: request.data }); assert(call);
          assert.equal(call.name, "swapIn");
          reads.push({ lane, method: call.name, tick });
          if (failed) throw new Error("synthetic external liquidity dependency unavailable");
          // Canned transport drift proves scheduling only; on-chain formula is
          // independently established by the same-N verified runtime source.
          throw Object.assign(new Error("execution reverted"), {
            data: FLUID_DEX_INTERFACE.encodeErrorResult("FluidDexSwapResult", [BigInt(call.args[1]) + BigInt(Math.min(tick, 4))]),
          });
        },
      },
    });
  }
  const coordinator = new StrictCurrentRuntimeCoordinator(request => root.createSession({ source: request.source,
    runtime: runtime(request.source.number - source.number, "raw"), fundingAssets: [],
    kind: request.purpose === "exact-execution" ? "exact" : "pricing", touchedPools: request.touchedPools,
    requiredEdgeIds: request.requiredEdgeIds, control: request.control,
  }), () => {}, undefined, async (pricing, control, _backend, reuse) => {
    const current = reuse?.quoteGraph ?? pricing;
    const requested = { number: current.sourceBlock, hash: current.sourceBlockHash, generation: current.generation };
    let exact: StrictProductionRuntimeSession | undefined;
    return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous,
      touchedStateKeys: reuse?.touchedStateKeys, disabledEdgeIds: reuse?.disabledEdgeIds, control,
      weth: ADDR.WETH, gasCostWei: null, enumerationSpreadBps: 50, concurrency: 2,
      prepareQuote: async requiredEdgeIds => { exact = await root.createSession({ source: requested,
        runtime: runtime(requested.number - source.number, "exact"), fundingAssets: [], kind: "exact", requiredEdgeIds, control }); },
      quote: async request => { assert(exact); const q = await exact.issueExact({ ...request, executor, runtimeEvidence: [] });
        assert("amountIn" in q); return q; },
    });
  });
  async function step(tick: number) {
    reads.length = 0;
    const current = at(tick), touched = new Set<string>();
    const graph = createVerifiedGraphView({ id: "fluid-refresh-" + tick, edges, generation: current.generation,
      sourceBlock: current.number, sourceBlockHash: current.hash, completenessWatermark: current.number,
      familyIdForEdge: e => root.pricingIndex().familyIdByEdgeKey.get(blockScanEdgeKey(e))!,
      perSourceCoverage: [...new Set(instances.map(i => i.familyId))].map(familyId => ({ familyId,
        sourceId: "offline", sourceFingerprint: "fluid-refresh", completeThroughBlock: current.number, completeThroughHash: current.hash })),
    });
    await coordinator.prepareCoarsePricing({ graph, deadlineAtMs: Date.now() + 10000, touchedPools: touched,
      canonicalActivity: { source: current, parentHash: tick === 0 ? ethers.ZeroHash : at(tick - 1).hash,
        touchedStateKeys: touched, complete: true } });
    assert.equal(touched.size, 0);
    const snapshot = coordinator.latestPricingSnapshot()!;
    if (tick > 0) {
      assert(!reads.some(r => r.lane === "raw"), "no bootstrap raw reread");
      assert(!reads.some(r => r.method === "getReserves"), "unrelated on-touch pools remain carried");
      assert.equal(reads.length, failed ? 4 : 2, "only selected effective directions/dependent rounds; existing bounded retry only");
    }
    return snapshot;
  }
  const baseline = await step(0);
  let recovered: ReturnType<typeof coordinator.latestPricingSnapshot>;
  for (const [tick, fail] of [[1, false], [2, true], [3, true], [4, false], [5, false]] as const) {
    failed = fail; const snapshot = await step(tick);
    assert.strictEqual(snapshot.mids, baseline.mids); assert.deepEqual(snapshot.rawMidSource, source);
    for (const key of otherKeys) {
      assert.strictEqual(snapshot.effectiveMids!.rows.get(key), baseline.effectiveMids!.rows.get(key));
      assert.equal(snapshot.pricingProvenanceByEdgeKey!.get(key), "carried");
    }
    for (const key of ownKeys) {
      const row = snapshot.effectiveMids!.rows.get(key)!;
      assert.equal(row.status, fail ? "quote-failed" : "quoted");
      if (fail) { assert.equal(row.amountOut, null); assert.equal(row.quotedAt, undefined);
        assert(snapshot.coverage.unresolvedEdgeKeys.includes(key)); assert(!snapshot.coverage.resolvedEdgeKeys.includes(key)); }
      else { assert.notEqual(row.amountOut, baseline.effectiveMids!.rows.get(key)!.amountOut);
        assert.deepEqual(row.quotedAt, at(tick)); assert(snapshot.coverage.resolvedEdgeKeys.includes(key));
        if (tick === 5) assert.equal(row.amountOut, recovered!.effectiveMids!.rows.get(key)!.amountOut); }
    }
    if (tick === 4) recovered = snapshot;
  }
});
