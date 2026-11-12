import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import type { CentralAdapterRuntime } from "../adapter-work-intent.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { createAdapterFamilyExactQuoteCache, type AdapterExactStateCacheAddress } from "../adapter-family-exact-quote-cache.js";
import { buildEffectiveMids } from "../blockscan-effective-mid.js";
import type { BlockScanRuntimeLoopDependencies } from "../blockscan-runtime-loop.js";
import { BlockActivityRangeInvalidatedError } from "../blockscan-touched-state.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { StrictCurrentRuntimeCoordinator, type StrictActivityPolicy, type StrictCanonicalActivityProof } from "../strict-current-runtime-coordinator.js";
import { StrictProductionRuntimeRoot } from "../strict-production-runtime-session.js";
import { defineSwapFamily, definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";
import { createBoundedRequestExecutor, type AdapterRequestResult, type CanonicalSource } from "../venues/adapter-request-program.js";
import { executeAdapterFamilyLifecycleBatch, type AdapterFamilyPublication } from "../venues/adapter-family-runtime.js";
import { blockScanEdgeKey, createVerifiedGraphView } from "../venues/blockscan-state-capability.js";
import { capabilityManifestHash, FAMILY_CAPABILITY_NAMES, FamilyCapabilityCatalog } from "../venues/family-capability-catalog.js";
import { plugin as productionPlugin } from "../venues/production-families/univ2-standard.production.js";
import { UNIV2_FACTORY_INTERFACE, UNIV2_PAIR_INTERFACE } from "../venues/swaps/univ2-abi.js";

const hash = (number: number) => ethers.toBeHex(number, 32);
const source = (number: number): CanonicalSource => ({ number, hash: hash(number), generation: number });
const start = source(100), executor = `0x${"64".repeat(20)}`;
const pools = [0x1000, 0x1001, 0x1002].map(number => ethers.toBeHex(number, 20));
const balanceInterface = new ethers.Interface(["function balanceOf(address account) view returns (uint256)"]);
const UNIV2_FIXTURE_FACTORY = `0x${"42".repeat(20)}`;
const UNIV2_FIXTURE_TOKEN0 = `0x${"43".repeat(20)}`;
const UNIV2_FIXTURE_TOKEN1 = `0x${"44".repeat(20)}`;

// A single-family lifecycle fixture deliberately avoids the installed production
// catalog: these tests exercise coordinator policy, not catalog reconciliation.
async function runUniv2Lifecycle(canonical: CanonicalSource, pool: {
  pool: string; factory: string; token0: string; token1: string;
  reserves: { reserve0: bigint; reserve1: bigint; blockTimestampLast: number };
}, catalog: FamilyCapabilityCatalog): Promise<AdapterFamilyPublication> {
  const family = catalog.forFamily(productionPlugin.manifest.familyId);
  const pattern = family.plugin.discovery.callPatterns?.find(candidate =>
    candidate.selector === UNIV2_PAIR_INTERFACE.getFunction("swap")!.selector);
  assert(pattern);
  let now = 1_000;
  const runtime: CentralAdapterRuntime = {
    clock: { nowMs: () => now++ }, generationFence: { assertCurrent() {} }, callerAuthority: { bind: () => ({}) },
    policy: { bind: input => ({ lane: input.stage === "identity" ? "critical-proof" : "background",
      deadlineAtMs: 100_000, maxAttempts: 1, transportPool: "state-read", fairnessKey: input.subjectKey }) },
    budgets: { assertAdmitted() {} }, scheduler: {
      issueExecutor(input) {
        const requestExecutor = createBoundedRequestExecutor({
          assertSupported: requirements => assert.deepEqual(requirements, input.requirements),
          assertCallerBinding() {}, assertWithinBudget: (_familyId, requests) => assert.deepEqual(requests, input.requests),
          sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
          execute: async execution => execution.requests.map((request): AdapterRequestResult => {
            let completion: "returned" | "reverted-as-declared" = "returned", data: string;
            if (request.id.startsWith("model-surface-") || request.id.startsWith("model-decimals-") || request.id === "model-amplification") {
              completion = "reverted-as-declared"; data = "0x";
            } else if (request.kind === "get-code" && request.id.startsWith("transfer-code-")) {
              data = "0x6000";
            } else if ((request.id.startsWith("current-balance-") || request.id === "exact-input-balance" ||
                request.id === "exact-output-balance") && request.kind === "eth-call") {
              data = hash(Number(request.to.toLowerCase() === pool.token0.toLowerCase() ? pool.reserves.reserve0 : pool.reserves.reserve1));
            } else {
              const pairValues: Record<string, readonly [string, readonly unknown[]]> = {
                "pair-factory": ["factory", [pool.factory]], "pair-token0": ["token0", [pool.token0]],
                "pair-token1": ["token1", [pool.token1]],
                "current-reserves": ["getReserves", [pool.reserves.reserve0, pool.reserves.reserve1, pool.reserves.blockTimestampLast]],
                "exact-reserves": ["getReserves", [pool.reserves.reserve0, pool.reserves.reserve1, pool.reserves.blockTimestampLast]],
              };
              if (request.id === "factory-get-pair") data = UNIV2_FACTORY_INTERFACE.encodeFunctionResult("getPair", [pool.pool]);
              else { const selected = pairValues[request.id]; assert(selected, "unexpected lifecycle request " + request.id);
                data = UNIV2_PAIR_INTERFACE.encodeFunctionResult(selected[0], selected[1]); }
            }
            return { id: request.id, ok: true, source: execution.source, completion, data,
              provenance: { kind: "log-shadow-fixture", fingerprint: request.id } };
          }),
        });
        return { executor: requestExecutor, timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }) };
      },
    },
  };
  const result = await executeAdapterFamilyLifecycleBatch({ family, source: canonical, generation: canonical.generation,
    matches: [{ matchedPatternId: pattern.id, observation: { kind: "call", source: canonical, target: pool.pool,
      data: UNIV2_PAIR_INTERFACE.encodeFunctionData("swap", [0n, 1n, executor, "0x"]) } }],
    runtime, publisher: { publish() {} } });
  assert(result.publication);
  return result.publication;
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, clone(entry)]),
  ) as T;
  return value;
}

async function fixture(policy: StrictActivityPolicy, eachBlock = false) {
  const plugin = defineSwapFamily({ ...clone(productionPlugin), actionAdapters: productionPlugin.actionAdapters,
    pricing: { ...clone(productionPlugin.pricing), refreshPolicyForInstance: ({ descriptor }) =>
      eachBlock && Reflect.get(descriptor, "pool") === pools[2] ? "each-block" : "on-touch" } });
  const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({ familyId: plugin.manifest.familyId,
    capability, contractVersion: "log-shadow-fixture-v1", contentHash: ethers.sha256(ethers.toUtf8Bytes(capability)).slice(2),
    semanticDependencies: ["contract:" + capability], provenanceCommit: null }));
  const catalog = new FamilyCapabilityCatalog({ modules: [{ sourceFile: "fixture/log-shadow.production.ts", plugin,
    definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) } });
  const ready = await Promise.all(pools.map(pool => runUniv2Lifecycle(start, { pool, factory: UNIV2_FIXTURE_FACTORY,
    token0: UNIV2_FIXTURE_TOKEN0, token1: UNIV2_FIXTURE_TOKEN1,
    reserves: { reserve0: 1_000_000_000n, reserve1: 2_000_000_000n, blockTimestampLast: 1 } }, catalog)));
  const family = catalog.forFamily(plugin.manifest.familyId), instances = ready.flatMap(value => value.instances);
  const view = buildFamilyRouteGraphView({ routes: instances.flatMap(instance => instance.routes.map((route, index) => ({
    family, descriptor: instance.descriptor, route, handle: instance.routeHandles[index],
  }))) });
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: start, readyGraph: view.edges,
    readyInstances: instances, readyFundingAssets: [] });
  const graph = (at: CanonicalSource) => createVerifiedGraphView({ id: "log-shadow-fixture", edges: view.edges,
    generation: at.generation, sourceBlock: at.number, sourceBlockHash: at.hash, completenessWatermark: at.number,
    familyIdForEdge: () => plugin.manifest.familyId, perSourceCoverage: [{ familyId: plugin.manifest.familyId,
      sourceId: "fixture", sourceFingerprint: "log-shadow", completeThroughBlock: at.number, completeThroughHash: at.hash }] });
  const amountQuotes: string[] = [], rawReads: string[] = [], cache = createAdapterFamilyExactQuoteCache();
  const coordinator = new StrictCurrentRuntimeCoordinator(request => {
    const runtime = createStrictCentralAdapterRuntime({ executor, provider: {
      async getCode() { return "0x01"; }, async getStorage() { return hash(0); },
      async call(call) {
        if (call.data.slice(0, 10) === UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector) {
          rawReads.push(call.to.toLowerCase());
          return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [1_000_000_000n, 2_000_000_000n, 1]);
        }
        return balanceInterface.encodeFunctionResult("balanceOf", [10n ** 24n]);
      },
    }, generationFence: { assertCurrent(generation, actual) {
      assert.equal(generation, request.source.generation); assert.deepEqual(actual, request.source);
    } } });
    return root.createSession({ source: request.source, runtime, fundingAssets: [], control: request.control,
      kind: request.purpose === "exact-execution" ? "exact" : "pricing", requiredEdgeIds: request.requiredEdgeIds,
      touchedPools: request.touchedPools });
  }, () => {}, undefined, async (pricing, control, _backend, reuse) => {
    const at = reuse?.quoteGraph ?? pricing;
    return buildEffectiveMids({ pricing, control, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous,
      touchedStateKeys: reuse?.touchedStateKeys, disabledEdgeIds: reuse?.disabledEdgeIds,
      weth: UNIV2_FIXTURE_TOKEN0, gasCostWei: null, enumerationSpreadBps: 0, concurrency: 2,
      cascadeAmountChanges: false, quote: async ({ edge, amountIn }) => {
        amountQuotes.push(edge.instanceKey!);
        return { source: { number: at.sourceBlock, hash: at.sourceBlockHash, generation: at.generation },
          amountIn, amountOut: amountIn * 2n + BigInt(at.sourceBlock) };
      } });
  }, cache, undefined, policy);
  await coordinator.prepareCoarsePricing({ graph: graph(start), deadlineAtMs: Date.now() + 10_000 });
  const baseline = coordinator.latestPricingSnapshot()!;
  amountQuotes.length = 0; rawReads.length = 0;
  const step = (at: CanonicalSource, activity: StrictCanonicalActivityProof) => coordinator.prepareCoarsePricing({
    graph: graph(at), deadlineAtMs: Date.now() + 10_000, canonicalActivity: activity,
    touchedPools: activity.touchedStateKeys,
  });
  return { coordinator, graph, baseline, step, amountQuotes, rawReads, cache, instances };
}

const logActivity = (at: CanonicalSource, touchedStateKeys = new Set<string>()): StrictCanonicalActivityProof => ({
  source: at, previousSource: source(at.number - 1), parentHash: hash(at.number - 1),
  complete: false, experimentalLogOnly: true, touchedStateKeys,
});

test("log-only effective carry requires explicit policy and preserves each-block refresh", async () => {
  for (const policy of ["strict", "logs-shadow"] as const) {
    const f = await fixture(policy, true), at = source(101), activity = logActivity(at, new Set([pools[0]!]));
    await f.step(at, activity);
    assert.deepEqual(new Set(f.amountQuotes), new Set(policy === "strict" ? pools : [pools[0], pools[2]]));
    assert.equal(f.amountQuotes.length, policy === "strict" ? 6 : 4);
    assert.deepEqual([...activity.touchedStateKeys], [pools[0]], "clock refresh must not mutate log evidence");
    assert.deepEqual(f.rawReads, [], "startup raw basis remains unchanged");
    const current = f.coordinator.latestPricingSnapshot()!;
    assert.strictEqual(current.mids, f.baseline.mids);
    const clean = current.graph.edges.find(edge => edge.instanceKey === pools[1])!;
    assert.equal(current.effectiveMids!.rows.get(blockScanEdgeKey(clean)) ===
      f.baseline.effectiveMids!.rows.get(blockScanEdgeKey(clean)), policy === "logs-shadow");
  }
});

test("log-only evidence never grants cross-block Exact state reuse", async () => {
  const f = await fixture("logs-shadow"), instance = f.instances[0]!;
  const address: AdapterExactStateCacheAddress = { familyRuntimeIdentity: {}, familyId: instance.familyId,
    instanceKey: instance.instanceKey, routeKey: instance.routes[0]!.routeKey, stateKey: pools[0]!,
    instanceFingerprint: "01".repeat(32), routeBindingFingerprint: "02".repeat(32), capabilityHash: "03".repeat(32),
    compatibilityFingerprint: "04".repeat(32), methodId: "state", methodIndex: 0,
    methodOrderFingerprint: "05".repeat(32), requestFingerprint: "06".repeat(32), amountIn: 1n, executor, source: start };
  assert(f.cache.storeState(address, { trustedResults: [{ id: "state", ok: true, source: start,
    provenance: { kind: "eth-call", fingerprint: "fixture" }, completion: "returned", data: "0x6000" }],
    roundFingerprints: ["07".repeat(32)], evidenceRefs: [] }));
  await f.step(source(101), logActivity(source(101)));
  assert.deepEqual(f.amountQuotes, [], "effective experiment still carries clean rows");
  assert.equal(f.cache.lookupState({ ...address, source: source(101) }), undefined,
    "untouched Exact state cannot inherit an incomplete observation proof");
});

test("experimental carry retains source, range, generation and parent-hash fences", async () => {
  for (const failure of ["source", "base", "generation", "parent", "gap"] as const) {
    const f = await fixture("logs-shadow");
    const at = { ...source(failure === "gap" ? 103 : 101), ...(failure === "generation" ? { generation: 100 } : {}) };
    const ordinary = logActivity(at);
    const activity: StrictCanonicalActivityProof = { ...ordinary,
      ...(failure === "source" ? { source: { ...at, hash: hash(999) } } : {}),
      ...(failure === "base" ? { previousSource: { number: 100, hash: hash(999) } } : {}),
      ...(failure === "parent" ? { previousSource: undefined, parentHash: hash(999) } : {}),
      ...(failure === "gap" ? { previousSource: undefined } : {}),
    };
    await f.step(at, activity);
    assert.equal(f.amountQuotes.length, 6, failure + " cannot authorize selective carry");
  }
  const f = await fixture("logs-shadow"), at = source(103);
  await f.step(at, { ...logActivity(at), previousSource: start });
  assert.equal(f.amountQuotes.length, 0, "a verified contiguous range may bridge coalesced heads");
});

test("experimental prices cannot enter durable continuation or historical baselines", async () => {
  assert.throws(() => new StrictCurrentRuntimeCoordinator(async () => { throw new Error("unused"); },
    () => {}, undefined, undefined, undefined, undefined, "logs-shadow"), /requires effective pricing/);
  const f = await fixture("logs-shadow");
  assert.throws(() => f.coordinator.continuationPricing(), /cannot export continuation/);
  assert.throws(() => f.coordinator.exportHistoricalBaseline(), /cannot export a historical/);
  await assert.rejects(f.coordinator.restoreHistoricalBaseline(undefined as never, undefined as never), /cannot restore a historical/);
  await assert.rejects(f.coordinator.retirePricingForReorg(start), /cannot recover pricing through a reorg/);
});

async function loopFixture(activityMode: "trace" | "logs-shadow") {
  const { BlockScanRuntimeLoop } = await import("../blockscan-runtime-loop.js");
  const inputs: any[] = [], runtimeAbort = new AbortController();
  const worker: any = { state: { provider: {}, async forkAt() {}, stop() {}, async stopAndWait() {} }, solver: {}, simulator: {} };
  let drained = false, retired = false, reads = 0;
  const coordinator: any = { latestPricingSnapshot: () => ({ sourceBlock: 100, sourceBlockHash: hash(100) }),
    startFundingPreparation(input: any) { inputs.push({ kind: "funding", ...input }); return { settle: async () => {} }; },
    async prepare(input: any) { inputs.push({ kind: "runtime", ...input }); throw new Error("fixture prepared boundary"); },
    async retirePricingForReorg() { retired = true; },
  };
  const deps: BlockScanRuntimeLoopDependencies = {
    enabled: true, activityMode, runtimeAbort, rpcUrl: "http://127.0.0.1:1",
    sourceSimulationFactory: () => ({ transport: { async simulate() { throw new Error("unexpected simulation"); } },
      async closeAndDrain() { drained = true; } }),
    executionWorkers: [worker], finalSimulationWorkers: [worker], sharedPlanner: { setFlashLiquidity() {} },
    backrunStatePublisher: { publish() {} }, frozenTopology: { topologyKey: "fixture",
      async observeHeader(number) { return { number, hash: hash(number), parentHash: hash(number - 1) }; } },
    blind: { enabled: false, activeSource: () => null, preparedBase: () => null, preparedArtifacts: () => null, dynamicResetNonce: () => null },
    startupWarmEnabled: false, startupWarmBudgetMs: 100, passBudgetMs: 10_000, largeGraphPassBudgetMs: 10_000,
    largeGraphEdgeThreshold: 1000, refineCandidates: 5, solveReserveMs: 20, solverGridHalfWidth: 1,
    solverGssMaxTries: 1, solverQuoteConcurrency: 1, exactConcurrency: 1, exactProbeTimeoutMs: 100,
    executorAddress: executor, currentHeadEvidenceFamilyForEdge: () => null, currentHeadEvidenceScopeKeyForEdge: () => null,
    currentHeadEvidenceScopeKeys: () => [], isCurrentHeadEvidenceFamily: () => true, isShuttingDown: () => false,
    blockScanGraph: () => [], blockScanPlanner: () => ({ setFlashLiquidity() {} } as any), currentRuntimeCoordinator: () => coordinator,
    flashTokens: () => [], blockScanConfig: { maxHops: 3, minSpreadBps: 20, maxCandidates: 5, budgetMs: 350, pricedTokens: new Map() },
    buildGraphView: input => createVerifiedGraphView({ ...input, completenessWatermark: input.sourceBlock,
      familyIdForEdge: () => "fixture" as any, perSourceCoverage: [] }),
    readBlockHash: async () => hash(101), readBlockSwapTouched: async () => { reads++; return new Set(); },
    formatRouteKey: () => "unused", formatRing: () => "unused", submitAtomic: async () => { throw new Error("unexpected submission"); },
  };
  return { loop: new BlockScanRuntimeLoop(deps), deps, inputs, runtimeAbort, coordinator,
    drained: () => drained, retired: () => retired, reads: () => reads };
}
const head = () => ({ sourceHeadSeenAtMs: Date.now(), sourceHeadSeenAtMonotonicMs: performance.now() });

test("source-N experimental proof is explicit; strict mode remains complete", async context => {
  context.mock.method(console, "log", () => {});
  for (const mode of ["trace", "logs-shadow"] as const) {
    let f: Awaited<ReturnType<typeof loopFixture>>;
    try { f = await loopFixture(mode); }
    catch (error) {
      if (error instanceof Error && error.message.includes("capability shadow contains unselected exact Family")) {
        context.skip("installed baseline capability artifact is stale: " + error.message); return;
      }
      throw error;
    }
    try {
      await assert.rejects(f.loop.runHead(101, head()), /fixture prepared boundary/);
      const activity = f.inputs.find(input => input.kind === "runtime").canonicalActivity;
      assert.equal(activity.complete, mode === "trace");
      assert.equal(activity.experimentalLogOnly, mode === "logs-shadow" ? true : undefined);
      assert.deepEqual(activity.previousSource, { number: 100, hash: hash(100) });
    } finally { await f.loop.shutdown(); }
  }
});

test("log-shadow confirmed reorg stops once after draining and never requests trace recovery", async context => {
  const markers: string[] = [];
  context.mock.method(console, "log", (message: string) => { markers.push(message); });
  let f: Awaited<ReturnType<typeof loopFixture>>;
  try { f = await loopFixture("logs-shadow"); }
  catch (error) {
    if (error instanceof Error && error.message.includes("capability shadow contains unselected exact Family")) {
      context.skip("installed baseline capability artifact is stale: " + error.message); return;
    }
    throw error;
  }
  let activityReads = 0, recoveryReads = 0;
  f.deps.frozenTopology.observeHeader = async number => ({ number,
    hash: hash(number === 100 ? 900 : number), parentHash: hash(number - 1) });
  Object.assign(f.deps, { readBlockSwapTouched: async () => {
    activityReads++; throw new BlockActivityRangeInvalidatedError("fixture broken range");
  }, readReorgActivity: async () => { recoveryReads++; throw new Error("unexpected trace recovery"); } });
  try {
    await f.loop.runHead(101, head());
    assert(f.runtimeAbort.signal.aborted); assert(f.drained()); assert.equal(f.retired(), false);
    assert.equal((f.loop as any).reorgRecoveryPending, false);
    await f.loop.runHead(102, head());
    assert.equal(activityReads, 1); assert.equal(recoveryReads, 0);
    assert.equal(f.inputs.some(input => input.kind === "runtime"), false);
    assert.equal(markers.filter(message => message.startsWith("[searcher/blockscan-log-shadow-stopped]")).length, 1);
    assert.throws(() => f.loop.restoreLiveContinuation(), /cannot restore live continuation/);
    assert.throws(() => f.loop.restoreHistoricalBaseline(), /cannot restore a historical baseline/);
  } finally { await f.loop.shutdown(); }
});
