import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { StateCallAbortedError } from "../../shared/state/state-backend.js";
import { runUniv2Lifecycle } from "../architecture-migration-fixture-replay.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { buildEffectiveMids, effectiveMidRowCarried } from "../blockscan-effective-mid.js";
import { StrictCurrentRuntimeCoordinator } from "../strict-current-runtime-coordinator.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { StrictProductionRuntimeRoot } from "../strict-production-runtime-session.js";
import { defineSwapFamily, definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";
import { capabilityManifestHash, FAMILY_CAPABILITY_NAMES, FamilyCapabilityCatalog } from "../venues/family-capability-catalog.js";
import { blockScanEdgeKey, createVerifiedGraphView } from "../venues/blockscan-state-capability.js";
import { plugin as base } from "../venues/production-families/univ2-standard.production.js";
import { UNIV2_PAIR_INTERFACE, UNIV2_TOKEN_INTERFACE } from "../venues/swaps/univ2-family/codec.js";

// Offline production Family/root/coordinator/builder fixture. No remote calls,
// historical execution or representative performance result is claimed.
const addr = (n: number) => ethers.toBeHex(n, 20);
const pools = [0x701, 0x702, 0x703, 0x704].map(addr);
const token = addr(705), executor = addr(706), sharedKey = "shared-static-state";
const source = (generation: number) => ({ number: 26_000_000,
  hash: ethers.id("same-pin-raw-refresh-policy"), generation });
function mutable<T>(value: T): T {
  if (Array.isArray(value)) return value.map(mutable) as T;
  return value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mutable(item)])) as T : value;
}

async function fixture(failFirstShared = false) {
  const definition = mutable(base);
  const plugin = defineSwapFamily({ ...definition, actionAdapters: base.actionAdapters,
    pricing: { ...definition.pricing,
      stateKey: route => (route.pool === pools[1] ? `${route.instanceKey}:${route.direction}`
        : route.pool === pools[2] || route.pool === pools[3] ? sharedKey : route.instanceKey) as typeof route.instanceKey,
      compileDraft: input => base.pricing.compileDraft({ ...input, stateKey: input.descriptor.instanceKey }),
      refreshPolicyForInstance: ({ descriptor, routes }) => descriptor.pool === pools[0] ||
        descriptor.pool === pools[1] && routes[0]!.direction === "zero-for-one" ? "each-block" : "on-touch",
      mutation: undefined,
    },
  });
  const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({ familyId: plugin.manifest.familyId, capability,
    contractVersion: "startup-raw-policy-v1", contentHash: ethers.id(capability).slice(2),
    semanticDependencies: [`contract:${capability}`], provenanceCommit: null }));
  const catalog = new FamilyCapabilityCatalog({ modules: [{ sourceFile: "fixture/startup-raw-policy.production.ts", plugin,
    definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) } });
  const issued = await Promise.all(pools.map(pool => runUniv2Lifecycle(source(1), {
    pool, factory: addr(707), token0: ADDR.WETH, token1: token,
    reserves: { reserve0: 10n ** 24n, reserve1: 10n ** 24n, blockTimestampLast: source(1).number },
  }, catalog)));
  const instances = issued.flatMap(item => item.instances);
  const edges = buildFamilyRouteGraphView({ routes: instances.flatMap(instance => instance.routes.map((route, index) => ({
    family: catalog.forFamily(instance.familyId), descriptor: instance.descriptor,
    route, handle: instance.routeHandles[index],
  }))) }).edges;
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: source(1), readyGraph: edges,
    readyInstances: instances, readyFundingAssets: [] });
  const index = root.pricingIndex();
  assert.equal(index.perBlockRefreshStateKeys.length, 2);
  assert.equal(index.instanceIndexesByStateKey.get(sharedKey)?.length, 2);
  const graph = (generation: number) => createVerifiedGraphView({ id: "startup-raw-policy", edges,
    generation, sourceBlock: source(generation).number, sourceBlockHash: source(generation).hash,
    completenessWatermark: source(generation).number,
    familyIdForEdge: edge => index.familyIdByEdgeKey.get(blockScanEdgeKey(edge))!,
    perSourceCoverage: [{ familyId: plugin.manifest.familyId, sourceId: "fixture", sourceFingerprint: "startup-raw-policy-v1",
      completeThroughBlock: source(generation).number, completeThroughHash: source(generation).hash }] });
  const reads: { generation: number; pool: string }[] = [];
  const sessions: { generation: number; refreshed: number; selected: number }[] = [];
  const quotes: { generation: number; edgeKey: string }[] = [];
  const raw: { generation: number; unresolved: number; resolved: number; carried: number }[] = [];
  let publications = 0;
  const coordinator = new StrictCurrentRuntimeCoordinator(async request => {
    const session = await root.createSession({ source: request.source, fundingAssets: [],
      kind: request.purpose === "exact-execution" ? "exact" : "pricing", control: request.control,
      touchedPools: request.touchedPools, requiredEdgeIds: request.requiredEdgeIds,
      runtime: createStrictCentralAdapterRuntime({ executor,
        generationFence: { assertCurrent(generation, actual) {
          assert.equal(generation, request.source.generation); assert.deepEqual(actual, request.source);
        } }, provider: {
          getCode: async () => { throw new Error("unexpected code read"); },
          getStorage: async () => { throw new Error("unexpected storage read"); },
          call: async call => {
            if (call.data.slice(0, 10) === UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector) {
              const pool = call.to.toLowerCase(); reads.push({ generation: request.source.generation, pool });
              if (failFirstShared && request.source.generation === 1 && pool === pools[2]) {
                throw new Error("fixture temporary shared raw failure");
              }
              return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [10n ** 24n, 10n ** 24n, source(1).number]);
            }
            assert.equal(call.data.slice(0, 10), UNIV2_TOKEN_INTERFACE.getFunction("balanceOf")!.selector);
            return UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [10n ** 24n]);
          },
        },
      }),
    });
    sessions.push({ generation: request.source.generation, refreshed: session.creationTiming.refreshedInstanceCount,
      selected: session.creationTiming.selectedInstanceCount });
    return session;
  }, () => {}, () => { publications++; }, async (pricing, control, _backend, reuse) => {
    raw.push({ generation: pricing.generation, unresolved: pricing.coverage.unresolvedEdgeKeys.length,
      resolved: pricing.coverage.resolvedEdgeKeys.length, carried: pricing.coverage.carriedEdgeKeys.length });
    return buildEffectiveMids({ pricing, previous: reuse?.previous, resumeSameSource: reuse?.resumeSameSource,
      touchedStateKeys: reuse?.touchedStateKeys, disabledEdgeIds: reuse?.disabledEdgeIds,
      quoteGraph: reuse?.quoteGraph, weth: ADDR.WETH, gasCostWei: null, enumerationSpreadBps: 0,
      control, concurrency: 1, quote: async ({ edge, amountIn }) => {
        quotes.push({ generation: pricing.generation, edgeKey: blockScanEdgeKey(edge) });
        if (pricing.generation === 1 && edge.target === pools[3] && edge.tokenIn.toLowerCase() === ADDR.WETH.toLowerCase()) {
          currentController.abort(new StateCallAbortedError("fixture partial startup deadline", "deadline"));
        }
        return { source: source(pricing.generation), amountIn, amountOut: amountIn * 2n };
      },
    });
  });
  let currentController = new AbortController();
  const start = graph(1), cursor = coordinator.startStartupWarmResume(start);
  const prepare = async (generation: number, mode: "cursor" | "ordinary" | "coarse" = "cursor") => {
    currentController = new AbortController();
    const input = { graph: graph(generation), deadlineAtMs: Date.now() + 10_000,
      signal: currentController.signal, validateBeforePublish: async () => {} };
    return mode === "coarse" ? coordinator.prepareCoarsePricing(input)
      : coordinator.prepare({ ...input, fundingTokens: [], ...(mode === "cursor" ? { startupWarmResume: cursor } : {}) });
  };
  return { coordinator, prepare, reads, sessions, quotes, raw, publications: () => publications };
}

let passed = 0;
for (const mode of ["cursor", "ordinary", "coarse"] as const) {
  const f = await fixture();
  await assert.rejects(f.prepare(1), /fixture partial startup deadline/);
  assert.equal(f.publications(), 0); assert.equal(f.coordinator.latestPricingSnapshot(), null);
  await f.prepare(2, mode);
  assert.deepEqual(f.sessions.map(item => item.refreshed), mode === "cursor" ? [4, 2] : [4, 4]);
  assert.deepEqual(new Set(f.reads.filter(item => item.generation === 2).map(item => item.pool)),
    new Set(mode === "cursor" ? pools.slice(0, 2) : pools));
  const snapshot = f.coordinator.latestPricingSnapshot()!;
  assert(snapshot.effectiveMids!.complete); assert.equal(f.publications(), 1);
  const firstStatic = [...snapshot.effectiveMids!.rows.values()].find(row => row.instanceKey === pools[2] && row.tokenIn === ADDR.WETH.toLowerCase())!;
  assert.equal(firstStatic.quotedAt!.generation, mode === "cursor" ? 1 : 2);
  assert.equal(effectiveMidRowCarried(snapshot.effectiveMids!, firstStatic), mode === "cursor");
  for (const row of snapshot.effectiveMids!.rows.values()) if (pools.slice(0, 2).includes(row.instanceKey)) {
    assert.equal(row.quotedAt!.generation, 2, "default each-block union refreshes both keys of selected instances");
  }
  assert.equal(f.raw[1]!.carried, mode === "cursor" ? 4 : 0);
  passed++; console.log(`strict startup raw refresh policy: PASS ${mode}: default each-block refresh and ordinary isolation`);
}

{
  const f = await fixture(true);
  await assert.rejects(f.prepare(1), /fixture partial startup deadline/);
  assert.equal(f.raw[0]!.unresolved, 2);
  await f.prepare(2);
  assert.deepEqual(f.sessions.map(item => item.refreshed), [4, 4], "one unresolved shared key must select both Ready instances plus each-block defaults");
  assert.deepEqual(new Set(f.reads.filter(item => item.generation === 2).map(item => item.pool)), new Set(pools));
  assert.equal(f.raw[1]!.unresolved, 0); assert.equal(f.raw[1]!.resolved, 8);
  const snapshot = f.coordinator.latestPricingSnapshot()!;
  assert(snapshot.effectiveMids!.complete); assert.equal(f.publications(), 1);
  for (const row of snapshot.effectiveMids!.rows.values()) assert.equal(row.quotedAt!.generation, 2,
    "all refreshed shared-instance state must invalidate the old effective tuples");
  passed++; console.log("strict startup raw refresh policy: PASS shared unresolved key retries its entire Ready instance closure");
}
console.log(`strict startup raw refresh policy: ${passed} scenarios passed`);
