import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { runUniv2Lifecycle } from "../architecture-migration-fixture-replay.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { buildEffectiveMids, effectiveEnumerationMids } from "../blockscan-effective-mid.js";
import { StrictCurrentRuntimeCoordinator } from "../strict-current-runtime-coordinator.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { StrictProductionRuntimeRoot } from "../strict-production-runtime-session.js";
import { defineSwapFamily, definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";
import { capabilityManifestHash, FAMILY_CAPABILITY_NAMES, FamilyCapabilityCatalog } from "../venues/family-capability-catalog.js";
import { blockScanEdgeKey, createVerifiedGraphView } from "../venues/blockscan-state-capability.js";
import { plugin as base } from "../venues/production-families/univ2-standard.production.js";
import { UNIV2_PAIR_INTERFACE, UNIV2_TOKEN_INTERFACE } from "../venues/swaps/univ2-family/codec.js";

// Synthetic states/amount responses, real lifecycle-issued handles, root,
// coordinator and effective builder. Not historical, EVM or latency evidence.
const addr = (n: number) => ethers.toBeHex(n, 20);
const pools = [101, 102, 103, 104].map(addr);
const token = addr(201), executor = addr(202);
const at = (n: number) => ({ number: 26_000_000 + n, hash: ethers.id("refresh-contract-" + n), generation: n + 1 });
type Path = "coarse" | "runtime";
type Failure = "quote-failed" | "unsupported" | "no-output";
type Draft = "normal" | "incomplete" | "wrong-hash" | "wrong-number" | "wrong-generation" | "abort" | "canonical" | "superseded" | "reset";
function mutable<T>(value: T): T {
  if (Array.isArray(value)) return value.map(mutable) as T;
  return value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mutable(v)])) as T : value;
}
function gate() { let release!: () => void; return { promise: new Promise<void>(r => { release = r; }), release: () => release() }; }

async function fixture(reverse: boolean, path: Path) {
  const definition = mutable(base);
  const plugin = defineSwapFamily({ ...definition, actionAdapters: base.actionAdapters,
    pricing: { ...definition.pricing,
      // One physical instance really has two pricing groups, only one dynamic.
      stateKey: route => (route.pool === pools[1] ? `${route.instanceKey}:${route.direction}` : route.instanceKey) as typeof route.instanceKey,
      compileDraft: input => base.pricing.compileDraft({ ...input, stateKey: input.descriptor.instanceKey }),
      refreshPolicyForInstance: ({ descriptor, routes }) => descriptor.pool === pools[0] ||
        descriptor.pool === pools[1] && routes[0]!.direction === "zero-for-one" ? "each-block" : "on-touch",
      mutation: undefined,
    },
  });
  const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({ familyId: plugin.manifest.familyId, capability,
    contractVersion: "refresh-contract-v1", contentHash: ethers.id(capability).slice(2),
    semanticDependencies: [`contract:${capability}`], provenanceCommit: null }));
  const catalog = new FamilyCapabilityCatalog({ modules: [{ sourceFile: "fixture/refresh.production.ts", plugin,
    definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) } });
  const issued = await Promise.all(pools.map(pool => runUniv2Lifecycle(at(0), { pool, factory: addr(203), token0: ADDR.WETH,
    token1: token, reserves: { reserve0: 10n ** 24n, reserve1: 10n ** 24n, blockTimestampLast: at(0).number } }, catalog)));
  const instances = issued.flatMap(i => i.instances);
  const edges = [...buildFamilyRouteGraphView({ routes: instances.flatMap(i => i.routes.map((route, n) => ({
    family: catalog.forFamily(i.familyId), descriptor: i.descriptor, route, handle: i.routeHandles[n],
  }))) }).edges];
  if (reverse) edges.reverse();
  assert.equal(edges.length, 8);
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: at(0), readyGraph: edges, readyInstances: instances, readyFundingAssets: [] });
  const index = root.pricingIndex();
  assert.equal(index.perBlockRefreshStateKeys.length, 2);
  const keys = pools.map(pool => edges.filter(e => e.instanceKey === pool).map(blockScanEdgeKey));
  assert.notEqual(index.stateKeyByEdgeKey.get(keys[1]![0]!), index.stateKeyByEdgeKey.get(keys[1]![1]!));
  assert.equal(keys[1]!.filter(k => index.perBlockRefreshStateKeys.includes(index.stateKeyByEdgeKey.get(k)!)).length, 1);
  const calls: string[] = [], prepared: string[] = [];
  const failing = new Set<string>();
  let failure: Failure = "quote-failed", draft: Draft = "normal", publications = 0;
  let controller = new AbortController();
  const entered = gate(), barrier = gate();
  const coordinator = new StrictCurrentRuntimeCoordinator(request => root.createSession({ source: request.source,
    kind: request.purpose === "exact-execution" ? "exact" : "pricing", fundingAssets: [], control: request.control,
    requiredEdgeIds: request.requiredEdgeIds, runtime: createStrictCentralAdapterRuntime({ executor,
      generationFence: { assertCurrent(generation, source) { assert.equal(generation, request.source.generation); assert.deepEqual(source, request.source); } },
      provider: {
        async getCode() { throw new Error("unexpected pricing code read"); },
        async getStorage() { throw new Error("unexpected pricing storage read"); },
        async call(call, block) {
        assert.equal(block, request.source.number);
        if (pools.includes(call.to.toLowerCase())) return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [10n ** 24n, 10n ** 24n, at(0).number]);
        assert.equal(call.data.slice(0, 10), UNIV2_TOKEN_INTERFACE.getFunction("balanceOf")!.selector);
        return UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [10n ** 24n]);
      } },
    }),
  }), () => {}, () => { publications++; }, async (pricing, control, _backend, reuse) => {
    const mode = draft, current = reuse?.quoteGraph ?? pricing;
    const result = await buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous,
      touchedStateKeys: reuse?.touchedStateKeys, disabledEdgeIds: reuse?.disabledEdgeIds,
      control, weth: ADDR.WETH, gasCostWei: null, enumerationSpreadBps: 0, concurrency: 2,
      prepareQuote: async ids => { prepared.push(...ids); },
      quote: async ({ edge, amountIn }) => {
        const key = blockScanEdgeKey(edge); calls.push(key);
        if (failing.has(key)) {
          if (failure === "quote-failed") throw new Error("synthetic quote failure");
          if (failure === "unsupported") throw Object.assign(new Error("synthetic unavailable"), { code: "CHAIN_AMOUNT_QUOTE_UNAVAILABLE" });
        }
        return { source: { number: current.sourceBlock, hash: current.sourceBlockHash, generation: current.generation },
          amountIn, amountOut: failing.has(key) ? 0n : amountIn * 2n };
      },
    });
    if (mode === "incomplete") return { ...result, complete: false };
    if (mode.startsWith("wrong-")) return { ...result, source: { ...result.source,
      ...(mode === "wrong-hash" ? { hash: ethers.id("wrong") } : mode === "wrong-number"
        ? { number: result.source.number - 1 } : { generation: result.source.generation - 1 }) } };
    if (mode === "abort") controller.abort(new Error("fixture aborted"));
    if (mode === "superseded" || mode === "reset") { entered.release(); await barrier.promise; }
    return result;
  });
  async function step(tick: number) {
    const source = at(tick), mode = draft;
    const graph = createVerifiedGraphView({ id: "refresh-contract-" + tick, edges,
      generation: source.generation, sourceBlock: source.number, sourceBlockHash: source.hash, completenessWatermark: source.number,
      familyIdForEdge: e => index.familyIdByEdgeKey.get(blockScanEdgeKey(e))!,
      perSourceCoverage: [{ familyId: plugin.manifest.familyId, sourceId: "fixture", sourceFingerprint: "refresh-contract",
        completeThroughBlock: source.number, completeThroughHash: source.hash }] });
    const args = { graph, signal: controller.signal, deadlineAtMs: Date.now() + 10000,
      canonicalActivity: { source, parentHash: at(tick - 1).hash, complete: true as const,
        touchedStateKeys: new Set(keys.slice(0, 3).flat().map(k => index.stateKeyByEdgeKey.get(k)!)) } };
    if (path === "coarse") await coordinator.prepareCoarsePricing(args);
    else await coordinator.prepare({ ...args, fundingTokens: [], validateBeforePublish: mode === "canonical"
      ? async () => { throw new Error("fixture canonical recheck failed"); } : undefined });
    const s = coordinator.latestPricingSnapshot()!;
    assert.equal(s.sourceBlock, source.number); assert.equal(s.sourceBlockHash, source.hash); assert.equal(s.generation, source.generation);
    return s;
  }
  return { coordinator, keys, calls, prepared, failing, step, entered, barrier,
    setFailure: (value: Failure) => { failure = value; }, setDraft: (value: Draft) => { draft = value; },
    resetSignal: () => { controller = new AbortController(); }, publications: () => publications,
  };
}

for (const path of ["coarse", "runtime"] as const) for (const reverse of [false, true]) {
  for (const failure of ["quote-failed", "unsupported", "no-output"] as const) {
    test(`${path}/${reverse ? "reverse" : "forward"}/${failure}: dynamic recovery, mixed-key veto, static exclusion`, async () => {
      const f = await fixture(reverse, path), dynamic = f.keys.slice(0, 2).flat(), stationary = f.keys[2]!, healthy = f.keys[3]!;
      const baseline = await f.step(0); assert.equal(effectiveEnumerationMids(baseline).size, 8);
      f.setFailure(failure); [...dynamic, ...stationary].forEach(k => f.failing.add(k));
      for (const tick of [1, 2, 3]) {
        f.calls.length = 0; f.prepared.length = 0;
        const snapshot = await f.step(tick);
        assert.deepEqual(new Set(f.calls), new Set(tick === 1 ? [...dynamic, ...stationary] : dynamic));
        assert.deepEqual(new Set(f.prepared), new Set(f.calls));
        for (const k of dynamic) {
          const row = snapshot.effectiveMids!.rows.get(k)!;
          assert.equal(row.status, failure); assert(row.amountIn! > 0n); assert.equal(row.amountOut, failure === "no-output" ? 0n : null);
          assert.equal(row.quotedAt, undefined); assert(!snapshot.coverage.resolvedEdgeKeys.includes(k));
          assert(!effectiveEnumerationMids(snapshot).has(k));
        }
        for (const k of stationary) assert.equal(snapshot.effectiveMids!.rows.get(k)!.status, tick === 1 ? failure : "disabled-for-run");
        for (const k of healthy) assert.strictEqual(snapshot.effectiveMids!.rows.get(k), baseline.effectiveMids!.rows.get(k));
      }
      // Recover one direction of each dynamic instance, then both.
      [f.keys[0]![0]!, f.keys[1]![0]!].forEach(k => f.failing.delete(k));
      const partial = await f.step(4);
      for (const k of dynamic) assert.equal(partial.effectiveMids!.rows.get(k)!.status, f.failing.has(k) ? failure : "quoted");
      f.failing.clear(); const recovered = await f.step(5);
      for (const k of dynamic) { assert.equal(recovered.effectiveMids!.rows.get(k)!.status, "quoted"); assert.deepEqual(recovered.effectiveMids!.rows.get(k)!.quotedAt, at(5)); }
      assert.equal(effectiveEnumerationMids(recovered).size, 6);
      await f.coordinator.resetDynamicStateForReplay(); f.calls.length = 0;
      const reset = await f.step(6);
      assert.equal(effectiveEnumerationMids(reset).size, 6);
      assert.deepEqual(new Set(f.calls), new Set([...dynamic, ...healthy]));
      for (const k of stationary) assert.equal(reset.effectiveMids!.rows.get(k)!.status, "disabled-for-run");
    });
  }
}

for (const path of ["coarse", "runtime"] as const) for (const mode of ["incomplete", "wrong-hash", "wrong-number", "wrong-generation", "abort", "canonical", "superseded", "reset"] as const) {
  if (path === "coarse" && mode === "canonical") continue;
  test(`${path}/${mode}: unpublished failed draft cannot retire instances or revive old prices`, async () => {
    const f = await fixture(false, path), baseline = await f.step(0);
    f.keys.slice(0, 3).flat().forEach(k => f.failing.add(k)); f.setDraft(mode);
    const pending = f.step(1), rejected = assert.rejects(pending);
    if (mode === "superseded" || mode === "reset") {
      await f.entered.promise;
      assert.strictEqual(f.coordinator.latestPricingSnapshot(), baseline);
      f.setDraft("normal"); f.failing.clear();
      if (mode === "superseded") await f.step(2); else await f.coordinator.resetDynamicStateForReplay();
      const latest = f.coordinator.latestPricingSnapshot(); f.barrier.release(); await rejected;
      assert.strictEqual(f.coordinator.latestPricingSnapshot(), latest);
    } else { await rejected; assert.strictEqual(f.coordinator.latestPricingSnapshot(), baseline); assert.equal(f.publications(), 1); }
    f.setDraft("normal"); f.failing.clear(); f.resetSignal();
    const recovered = await f.step(mode === "superseded" ? 3 : 2);
    assert.equal(effectiveEnumerationMids(recovered).size, 8);
    for (const row of recovered.effectiveMids!.rows.values()) assert.equal(row.status, "quoted");
  });
}
