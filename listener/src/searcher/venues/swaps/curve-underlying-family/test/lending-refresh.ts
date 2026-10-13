import assert from "node:assert/strict";
import { createBlockScanSimAmountSelector } from "../../../../simulator/blockscan-sim-amount-selector.js";
import test from "node:test";
import { ethers } from "ethers";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { createAdapterFamilyExactQuoteCache } from "../../../../adapter-family-exact-quote-cache.js";
import { buildEffectiveMids } from "../../../../blockscan-effective-mid.js";
import { readBlockTouchedStateKeys, type BlockTouchedProvider } from "../../../../blockscan-touched-state.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { StrictCurrentRuntimeCoordinator } from "../../../../strict-current-runtime-coordinator.js";
import { runStrictFamilyLifecycle } from "../../../../strict-family-lifecycle-runner.js";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../../../../strict-production-runtime-session.js";
import type { CanonicalSource } from "../../../adapter-request-program.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import type { UnifiedObservation } from "../../../adapter-family-plugin.js";
import { blockScanEdgeKey, createVerifiedGraphView } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { plugin } from "../../../production-families/curve-underlying.production.js";
import { LENDING_ABI as ABI } from "../lending.js";
import { lendingTestReply, lendingTestDescriptor, LENDING_TEST_SOURCE as START, LENDING_TEST_EXECUTOR as EXECUTOR } from "./lending-fixture.js";
import { CURVE_METAREGISTRY, CURVE_UNDERLYING_ERC20_INTERFACE as ERC20,
  CURVE_UNDERLYING_META_INTERFACE as REGISTRY, CURVE_UNDERLYING_POOL_INTERFACE as POOL_ABI } from "../codec.js";
import { CURVE_UNDERLYING_FAMILY_ID } from "../manifest.js";
import type { CurveUnderlyingDescriptor, CurveUnderlyingRoute } from "../types.js";

// Synthetic transport through the production lifecycle/coordinator. This
// proves source freshness, withdrawal and recovery, not historical performance.
const model = lendingTestDescriptor(), POOL = model.pool, COINS = model.coins;
const ACTOR = "0x1000000000000000000000000000000000000001";
const ROUTER = "0x1000000000000000000000000000000000000003";
const OTHER = "0x1000000000000000000000000000000000000004";
const INPUT = 10n ** 18n, UNITS = [10n ** 18n, 10n ** 6n, 10n ** 6n, 10n ** 18n];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
type Activity = { kind: "call"; target: string; data: string; nested?: boolean } |
  { kind: "log"; address: string; topics: readonly string[]; data: string };
async function setup() {
  let reads = 0;
  let rate = 999n, failed = false, badBinding = false, previous = START, sequence = 0;
  const quotedEdges: string[] = [], cache = createAdapterFamilyExactQuoteCache();
  const known = [POOL, ...COINS, ...model.lending!.wrappedCoins, model.lending!.lpToken];
  function runtime(source: CanonicalSource) {
    return createStrictCentralAdapterRuntime({ executor: EXECUTOR, transactionOrigin: ACTOR, exactQuoteCache: cache,
      generationFence: { assertCurrent(generation, at) { assert.equal(generation, source.generation); assert.deepEqual(at, source); } },
      provider: {
        async call(tx, block) {
          reads++; assert.equal(block, source.number);
          if (!known.some(a => same(a, tx.to))) return "0x";
          return lendingTestReply({ id: "read", kind: "eth-call", to: tx.to, data: tx.data, completion: "return-data" }, source).data;
        },
        async getCode(address, block) {
          reads++; assert.equal(block, source.number);
          if (!known.some(a => same(a, address))) return "0x";
          if (badBinding && same(address, model.lending!.wrappedCoins[0])) return "0x6000";
          return lendingTestReply({ id: "code", kind: "get-code", address }, source).data;
        },
        async getStorage(address, slot, block) {
          reads++; assert.equal(block, source.number);
          return lendingTestReply({ id: "storage", kind: "get-storage", address, slot }, source).data;
        },
      },
      simulator: {
        async simulate({ request, source: requested }) {
          reads++; assert.deepEqual(requested, source);
          if (failed) throw new Error("synthetic wrapper execution failure");
          assert(request.kind === "effect-delta-simulation");
          const [i, j, amount] = ABI.decodeFunctionData("exchange_underlying", request.call.data);
          const reply = lendingTestReply(request, source,
            amount * UNITS[Number(j)] / UNITS[Number(i)] * rate / 1000n);
          assert(reply.ok); return { data: reply.data, effects: reply.effects };
        },
      } });
  }
  const publication = await runStrictFamilyLifecycle({ catalog, familyId: CURVE_UNDERLYING_FAMILY_ID,
    source: START, runtime: runtime(START), observations: [{ kind: "call", source: START,
      target: POOL, sender: ACTOR, data: POOL_ABI.encodeFunctionData("exchange_underlying", [0, 1, INPUT, 0]) }] });
  assert.equal(publication.instances.length, 1);
  const instance = publication.instances[0];
  const descriptor = instance.descriptor as CurveUnderlyingDescriptor;
  assert(descriptor.lending);
  assert.equal(instance.routes.length, 12, "all twelve routes must pass real pricing materialization");
  for (const pricing of instance.pricingInstances) {
    assert.equal(new Set(pricing.dependencies.map(a => a.toLowerCase())).size, pricing.dependencies.length);
  }
  const family = catalog.forFamily(CURVE_UNDERLYING_FAMILY_ID);
  const edges = buildFamilyRouteGraphView({ routes: instance.routes.map((route, i) => ({ family,
    descriptor, route, handle: instance.routeHandles[i] })) }).edges;
  const target = edges.find(e => same(e.tokenIn, COINS[0]) && same(e.tokenOut, COINS[1])); assert(target);
  const key = blockScanEdgeKey(target);
  const route = instance.routes.find(r => same(r.tokenIn, COINS[0]) && same(r.tokenOut, COINS[1])) as CurveUnderlyingRoute;
  assert(route);
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: START,
    readyGraph: edges, readyInstances: publication.instances, readyFundingAssets: [] });
  const coordinator = new StrictCurrentRuntimeCoordinator(request => root.createSession({
    source: request.source, runtime: runtime(request.source), fundingAssets: [],
    kind: request.purpose === "exact-execution" ? "exact" : "pricing",
    touchedPools: request.touchedPools, requiredEdgeIds: request.requiredEdgeIds, control: request.control,
  }), () => {}, undefined, async (pricing, control, _backend, reuse) => {
    const graph = reuse?.quoteGraph ?? pricing;
    const source = { number: graph.sourceBlock, hash: graph.sourceBlockHash, generation: graph.generation };
    let exact: StrictProductionRuntimeSession | undefined;
    return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous,
      touchedStateKeys: reuse?.touchedStateKeys, disabledEdgeIds: reuse?.disabledEdgeIds, control,
      // Synthetic DAI valuation anchor isolates refresh; it is not production P.
      weth: COINS[0], fixedWethInput: INPUT, gasCostWei: null, enumerationSpreadBps: 200, concurrency: 2,
      prepareQuote: async requiredEdgeIds => {
        exact = await root.createSession({ source, runtime: runtime(source), fundingAssets: [],
          kind: "exact", requiredEdgeIds, control });
      },
      quote: async request => {
        assert(exact); quotedEdges.push(blockScanEdgeKey(request.edge));
        const result = await exact.issueExact({ ...request, executor: EXECUTOR, runtimeEvidence: [] });
        assert("amountIn" in result, "production Exact did not resolve"); return result;
      },
    });
  }, cache);

  async function step(activity?: Activity) {
    sequence++;
    const source = { number: START.number + sequence, hash: ethers.id(`offline-lending-block-${sequence}`),
      generation: START.generation + sequence };
    const txHash = ethers.id(`offline-lending-tx-${sequence}`);
    const frame = (from: string, to: string, input: string) => ({ type: "CALL", from, to, input,
      gas: "0x100000", gasUsed: "0x100", output: "0x" });
    const direct = activity?.kind === "call" ? frame(ACTOR, activity.target, activity.data)
      : activity ? frame(ACTOR, activity.address, "0x") : undefined;
    const result = activity?.kind === "call" && activity.nested
      ? { ...frame(ACTOR, ROUTER, "0x12345678"), calls: [frame(ROUTER, activity.target, activity.data)] } : direct;
    const logs = activity?.kind === "log" ? [{ ...activity, blockHash: source.hash, transactionHash: txHash }] : [];
    const reads: string[] = [];
    const provider: BlockTouchedProvider = {
      async getLogs(filter) { assert.deepEqual(filter, { blockHash: source.hash }); reads.push("logs"); return logs; },
      async send(method, params) {
        assert.equal(method, "debug_traceBlockByHash");
        assert.deepEqual(params, [source.hash, { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }]);
        reads.push("full-call-trace"); return result ? [{ txHash, result }] : [];
      },
    };
    const touched = await readBlockTouchedStateKeys(provider, source.number, ethers.ZeroAddress,
      { hash: source.hash, parentHash: previous.hash, transactionHashes: result ? [txHash] : [] },
      undefined, root.resolveBlockTouchedStateKeys);
    assert.deepEqual(reads.sort(), ["full-call-trace", "logs"]);
    quotedEdges.length = 0;
    await coordinator.prepareCoarsePricing({ graph: createVerifiedGraphView({
      id: `offline-lending-refresh-${sequence}`, edges, generation: source.generation,
      sourceBlock: source.number, sourceBlockHash: source.hash, completenessWatermark: source.number,
      familyIdForEdge: () => CURVE_UNDERLYING_FAMILY_ID,
      perSourceCoverage: [{ familyId: CURVE_UNDERLYING_FAMILY_ID, sourceId: "offline-fixture",
        sourceFingerprint: "legacy-plain-refresh-synthetic", completeThroughBlock: source.number,
        completeThroughHash: source.hash }],
    }), deadlineAtMs: Date.now() + 20_000, touchedPools: touched,
      canonicalActivity: { source, parentHash: previous.hash, touchedStateKeys: touched, complete: true } });
    previous = source;
    const snapshot = coordinator.latestPricingSnapshot(); assert(snapshot?.effectiveMids);
    assert.deepEqual(snapshot.effectiveMids.source, source);
    const row = snapshot.effectiveMids.rows.get(key); assert(row);
    return { source, touched, snapshot, row, calls: [...quotedEdges], logCount: logs.length };
  }
  return { step, descriptor, route, key, edges, reads: () => reads,
    session: () => root.createSession({ source: START, runtime: runtime(START), fundingAssets: [], kind: "exact-execution" }),
    rate(value: bigint) { rate = value; }, fail(value: boolean) { failed = value; },
    binding(value: boolean) { badBinding = value; },
  };
}
test("lending rates refresh each block through the production publisher, including unrelated and empty blocks", async () => {
  const h = await setup(), first = await h.step();
  assert.equal(first.row.status, "quoted"); assert.equal(first.row.amountOut, 999000n);
  for (const activity of [undefined, { kind: "call" as const, target: OTHER, data: "0x12345678" }]) {
    h.rate(997n);
    const next = await h.step(activity);
    assert.equal(next.row.status, "quoted"); assert.equal(next.row.amountOut, 997000n);
    assert.deepEqual(next.row.quotedAt, next.source);
    assert(next.calls.includes(h.key), "unlogged wrapper accrual cannot carry the old quote");
    assert(!next.touched.has(h.route.routeKey.toLowerCase()), "unrelated activity is not relabeled as target work");
  }
  h.rate(995n);
  const updated = await h.step({ kind: "call", target: model.lending!.wrappedCoins[0], data: "0x12345678", nested: true });
  assert.equal(updated.row.amountOut, 995000n); assert.deepEqual(updated.row.quotedAt, updated.source);
});
test("lending failed wrapper execution and changed binding withdraw old prices; the next valid source recovers", async () => {
  const h = await setup(); await h.step();
  for (const mode of ["execution", "binding"] as const) {
    if (mode === "execution") h.fail(true); else h.binding(true);
    for (let i = 0; i < 2; i++) {
      const failed = await h.step();
      assert.notEqual(failed.row.status, "quoted"); assert.equal(failed.row.amountOut, null);
      assert.equal(failed.row.effectiveMid, null); assert.equal(failed.row.quotedAt, undefined);
    }
    h.fail(false); h.binding(false);
    const recovered = await h.step();
    assert.equal(recovered.row.status, "quoted"); assert.equal(recovered.row.amountOut, 999000n);
    assert.deepEqual(recovered.row.quotedAt, recovered.source);
  }
});

test("all lending directions reach the live sim selector with zero construction Exact, quoted fallback or transport", async () => {
  const h = await setup(), before = h.reads();
  const session = await h.session();
  assert.equal(h.reads(), before);
  for (const first of h.edges) for (const selected of [0n, 1n]) {
    const reverse = h.edges.find(e => same(e.tokenIn, first.tokenOut) && same(e.tokenOut, first.tokenIn)); assert(reverse);
    const path = [first, reverse], events: any[] = [];
    let runtimeCalls = 0, exactCalls = 0, quotedCalls = 0, rpcCalls = 0, simulated = 0;
    const selectorSession = new Proxy(session, { get(target, name) {
      if (name === "fundingActionIds") return () => ["fixture-funding"];
      if (name === "buildFundingRoot") return (input: any) => ({ adapterId: "fixture-funding",
        target: EXECUTOR, tokenIn: first.tokenIn, tokenOut: first.tokenIn, amount: input.amount, params: {}, children: input.children });
      if (name === "issueExact") return () => { exactCalls++; throw Error("unexpected Exact"); };
      if (name === "buildExecution") return () => { quotedCalls++; throw Error("unexpected quoted fallback"); };
      if (name === "buildRuntimeAmountLeg") return (input: Parameters<typeof session.buildRuntimeAmountLeg>[0]) => {
        runtimeCalls++; return target.buildRuntimeAmountLeg(input);
      };
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    // Funding and external EVM results are synthetic; the real source/route
    // issuers and production amount-selector construction are under test.
    const selector = createBlockScanSimAmountSelector({ source: START, executor: EXECUTOR,
      record: event => events.push(event), async simulate(plan) {
        simulated++;
        const flow = plan.root.children[0]; assert(flow && flow.adapterId === "runtime-amount-flow");
        assert.equal(flow.params.quoteToleranceRawUnits, selected);
        const legs = JSON.parse(flow.params.legs as string); assert.equal(legs.length, 2);
        assert(legs.every((leg: any) => typeof leg.program === "string" && leg.program.startsWith("0x01")));
        return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: first.tokenIn, calldata: "0x" };
      } });
    await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n },
      flashToken: first.tokenIn, profitToken: first.tokenIn }, tokenPath: { edges: path }, maxFlashAmount: 10000n,
      templateName: "offline-lending-real-session-contract" } as any,
      { call() { rpcCalls++; throw Error("unexpected RPC"); } } as any, { executor: EXECUTOR } as any,
      { strictSession: selectorSession, quoteToleranceRawUnits: selected, deferPhase2Sim: true,
        gssMaxTries: 2, deadlineAtMs: Date.now() + 30000 });
    assert(simulated >= 4); assert.equal(runtimeCalls, simulated * 2);
    assert.deepEqual([exactCalls, quotedCalls, rpcCalls], [0, 0, 0]); assert.equal(h.reads(), before);
    const construction = events.filter(e => e.type === "sim_amount_construction");
    assert(construction.length > 0 && construction.every(e => e.mode === "runtime-actual"));
  }
});
