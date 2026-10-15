import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { ERC4626_FIXTURE_VAULT, ERC4626_FIXTURE_ASSET,
  erc4626SiloFixtureRuntime, ERC4626_SILO_FIXTURE_VAULT, ERC4626_SILO_FIXTURE_PAYOUT,
  runUniv2Lifecycle } from "../../../../architecture-migration-fixture-replay.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { buildEffectiveMids } from "../../../../blockscan-effective-mid.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../../../../strict-family-lifecycle-runner.js";
import { StrictCurrentRuntimeCoordinator } from "../../../../strict-current-runtime-coordinator.js";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../../../../strict-production-runtime-session.js";
import { blockScanEdgeKey, createVerifiedGraphView } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { UNIV2_PAIR_INTERFACE, UNIV2_TOKEN_INTERFACE } from "../../../swaps/univ2-family/codec.js";
import { ERC4626_INTERFACE, ERC4626_ERC20_INTERFACE, ERC4626_PROBE_ACTOR } from "../abi.js";
import { ERC4626_FAMILY_ID } from "../manifest.js";
import { ERC4626_SILO_REDEEM_FAMILY_ID } from "../../erc4626-silo-redeem-family/manifest.js";
import { ERC4626_SILO_INTERFACE, ERC4626_SILO_PAYOUT_INTERFACE } from "../../erc4626-silo-redeem-family/shared.js";

// Offline transport fixtures exercise the unchanged production lifecycle,
// Family, Exact, coordinator and publication. No RPC, EVM or pricing formula claim.
for (const silo of [false, true]) test(`${silo ? "Silo" : "standard ERC4626"} quiet effective refresh, bounded failure withdrawal/recovery and unrelated carry`, async () => {
  const vault = silo ? ERC4626_SILO_FIXTURE_VAULT : ERC4626_FIXTURE_VAULT;
  const asset = silo ? ERC4626_SILO_FIXTURE_PAYOUT : ERC4626_FIXTURE_ASSET;
  const familyId = silo ? ERC4626_SILO_REDEEM_FAMILY_ID : ERC4626_FAMILY_ID;
  const unit = 10n ** 18n, executor = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const at = (tick: number) => ({ number: 500 + tick, generation: 500 + tick, hash: ethers.toBeHex(500 + tick, 32) });
  const source = at(0), pools = ["0x4141414141414141414141414141414141414141", "0x4242424242424242424242424242424242424242"];
  const factory = "0x4343434343434343434343434343434343434343";
  const deposit = silo ? ERC4626_SILO_INTERFACE.encodeFunctionData("redeem", [asset, unit, executor, executor])
    : ERC4626_INTERFACE.encodeFunctionData("deposit", [unit, executor]);
  const standardIdentityRuntime = createStrictCentralAdapterRuntime({ executor,
    verifiedActors: { "erc4626-probe-actor": ERC4626_PROBE_ACTOR },
    generationFence: { assertCurrent(generation, requested) { assert.equal(generation, source.generation); assert.deepEqual(requested, source); } },
    provider: {
      async getCode(_address, block) { assert.equal(block, source.number); return "0x6001600055"; },
      async getStorage() { throw new Error("unexpected standard fixture proxy storage"); },
      async call(request, block) {
        assert.equal(block, source.number);
        const call = ERC4626_INTERFACE.parseTransaction({ data: request.data }) ?? ERC4626_ERC20_INTERFACE.parseTransaction({ data: request.data });
        assert(call, "unrecognized optional variant or standard call");
        if (call.name === "asset") return ERC4626_INTERFACE.encodeFunctionResult(call.name, [asset]);
        if (["totalAssets", "totalSupply"].includes(call.name)) return ERC4626_INTERFACE.encodeFunctionResult(call.name, [10n ** 30n]);
        if (call.name === "balanceOf") return ERC4626_ERC20_INTERFACE.encodeFunctionResult(call.name, [10n ** 30n]);
        if (call.name === "decimals") return ERC4626_ERC20_INTERFACE.encodeFunctionResult(call.name, [18]);
        assert(["convertToShares", "convertToAssets", "previewDeposit", "previewRedeem"].includes(call.name));
        return ERC4626_INTERFACE.encodeFunctionResult(call.name, [BigInt(call.args[0])]);
      },
    },
    simulator: { async simulate({ request, source: requested }) {
      assert.deepEqual(requested, source);
      assert(["active-deposit", "active-redeem"].includes(request.id));
      const deposit = request.id === "active-deposit", name = deposit ? "deposit" : "redeem";
      const amount = BigInt(ERC4626_INTERFACE.decodeFunctionData(name, request.call.data)[0]);
      const actor = ERC4626_PROBE_ACTOR.toLowerCase();
      const event = ERC4626_INTERFACE.encodeEventLog(ERC4626_INTERFACE.getEvent(deposit ? "Deposit" : "Withdraw")!,
        deposit ? [actor, actor, amount, amount] : [actor, actor, actor, amount, amount]);
      return { data: ERC4626_INTERFACE.encodeFunctionResult(name, [amount]), effects: {
        tokenDeltas: [{ token: deposit ? asset : vault, account: actor, delta: -amount },
          { token: deposit ? vault : asset, account: actor, delta: amount }],
        totalSupplyDeltas: [{ token: vault, delta: deposit ? amount : -amount }],
        logs: [{ address: vault, ...event }],
      } };
    } },
  });
  const admitted = await runStrictFamilyLifecycle({ catalog, familyId, source,
    observations: [{ kind: "call", target: vault, data: deposit, source }], runtime: silo ? erc4626SiloFixtureRuntime() : standardIdentityRuntime });
  assert.equal(admitted.instances.length, 1);
  assert.equal(admitted.instances[0]!.routes.length, silo ? 1 : 2);
  const background = await Promise.all(pools.map((pool, i) => runUniv2Lifecycle(source, { pool, factory,
    token0: ADDR.WETH, token1: [asset, vault][i]!, reserves: { reserve0: 1000n * unit,
      reserve1: 2000n * unit, blockTimestampLast: source.number } }, catalog)));
  const instances = [...admitted.instances, ...background.flatMap(r => r.instances)];
  const edges = buildFamilyRouteGraphView({ routes: instances.flatMap(instance => instance.routes.map((route, i) => ({
    family: catalog.forFamily(instance.familyId), descriptor: instance.descriptor, route, handle: instance.routeHandles[i],
  }))) }).edges;
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: source, readyGraph: edges,
    readyInstances: instances, readyFundingAssets: [] });
  const ownKeys = edges.map(blockScanEdgeKey).filter(key => root.pricingIndex().familyIdByEdgeKey.get(key) === familyId);
  const otherKeys = edges.map(blockScanEdgeKey).filter(k => !ownKeys.includes(k));
  assert.equal(ownKeys.length, silo ? 1 : 2); assert.equal(otherKeys.length, 4);
  assert.deepEqual(root.pricingIndex().perBlockRefreshStateKeys,
    [root.pricingIndex().stateKeyByEdgeKey.get(ownKeys[0]!)!]);
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
          if (selector === ERC4626_ERC20_INTERFACE.getFunction("decimals")!.selector)
            return ERC4626_ERC20_INTERFACE.encodeFunctionResult("decimals", [18]);
          if (silo && target === asset) {
            const call = ERC4626_SILO_PAYOUT_INTERFACE.parseTransaction({ data: request.data }); assert(call);
            assert.equal(call.name, "previewWithdraw"); reads.push({ lane, method: call.name, tick });
            return ERC4626_SILO_PAYOUT_INTERFACE.encodeFunctionResult(call.name, [BigInt(call.args[0])]);
          }
          assert.equal(target, vault);
          const call = ERC4626_INTERFACE.parseTransaction({ data: request.data }); assert(call);
          assert(["previewDeposit", "previewRedeem"].includes(call.name));
          reads.push({ lane, method: call.name, tick });
          if (failed) throw new Error("synthetic external dependency unavailable");
          // Deliberately canned response drift without any vault activity.
          // Tick 5 retains tick 4 output as the unchanged-state control.
          return ERC4626_INTERFACE.encodeFunctionResult(call.name, [BigInt(call.args[0]) + BigInt(Math.min(tick, 4))]);
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
    const graph = createVerifiedGraphView({ id: "standard-refresh-" + tick, edges, generation: current.generation,
      sourceBlock: current.number, sourceBlockHash: current.hash, completenessWatermark: current.number,
      familyIdForEdge: e => root.pricingIndex().familyIdByEdgeKey.get(blockScanEdgeKey(e))!,
      perSourceCoverage: [...new Set(instances.map(i => i.familyId))].map(familyId => ({ familyId,
        sourceId: "offline", sourceFingerprint: "standard-refresh", completeThroughBlock: current.number, completeThroughHash: current.hash })),
    });
    await coordinator.prepareCoarsePricing({ graph, deadlineAtMs: Date.now() + 10000, touchedPools: touched,
      canonicalActivity: { source: current, parentHash: tick === 0 ? ethers.ZeroHash : at(tick - 1).hash,
        touchedStateKeys: touched, complete: true } });
    assert.equal(touched.size, 0);
    const snapshot = coordinator.latestPricingSnapshot()!;
    if (tick > 0) {
      assert(!reads.some(r => r.lane === "raw"), "no bootstrap raw reread");
      assert(!reads.some(r => r.method === "getReserves"), "unrelated on-touch pools remain carried");
      assert.equal(reads.length, failed ? (silo ? 2 : 4) : 2, "only selected effective directions/dependent rounds; existing bounded retry only");
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
