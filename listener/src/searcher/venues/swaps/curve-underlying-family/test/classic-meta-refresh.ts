import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gunzipSync } from "node:zlib";
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
import { classicBaseExchangeAmount, type ClassicBasePoolState } from "../base-pool-math.js";
import { CURVE_METAREGISTRY, CURVE_UNDERLYING_ERC20_INTERFACE as ERC20,
  CURVE_UNDERLYING_META_INTERFACE as REGISTRY, CURVE_UNDERLYING_POOL_INTERFACE as POOL_ABI } from "../codec.js";
import { CURVE_UNDERLYING_FAMILY_ID } from "../manifest.js";
import type { CurveUnderlyingDescriptor, CurveUnderlyingRoute } from "../types.js";

// Offline wiring regression, not historical execution/Ready evidence. Runtime
// bytes/topology come from the saved public fixture; registry/view responses and
// neighboring blocks are synthetic. The reviewed base->base amount is calculated
// by production Exact from state reads, never supplied by this test's publisher.
// Trace-shaped inputs enter the SAME readBlockTouchedStateKeys -> Ready resolver
// -> prepareCoarsePricing -> effective publisher chain wired by main.ts. No RPC,
// trace provider completeness, live delivery, or EVM execution is asserted.
interface BindingFixture {
  source: CanonicalSource;
  runtimeBytecodesGzipBase64: string;
  calls: { to: string; data: string; result: string }[];
  storage: { address: string; slot: string; result: string }[];
  samples: { i: number; tokenIn: string }[];
}
const fixture: BindingFixture = JSON.parse(readFileSync(
  new URL("./fixtures/classic-meta-binding.json", import.meta.url), "utf8"));
const codes: Record<string, { address: string; code: string }> = JSON.parse(
  gunzipSync(Buffer.from(fixture.runtimeBytecodesGzipBase64, "base64")).toString());
const POOL = ethers.getAddress(codes.meta.address);
const COINS = [0, 1, 2, 3].map(i => {
  const sample = fixture.samples.find(s => s.i === i); assert(sample);
  return ethers.getAddress(sample.tokenIn);
});
const BASE = ethers.getAddress("0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7");
const ACTOR = "0x1000000000000000000000000000000000000001";
const EXECUTOR = "0x1000000000000000000000000000000000000002";
const ROUTER = "0x1000000000000000000000000000000000000003";
const OTHER = "0x1000000000000000000000000000000000000004";
const DONATE = ethers.id("donate_admin_fees()").slice(0, 10);
const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const START: CanonicalSource = { number: fixture.source.number, hash: fixture.source.hash,
  generation: fixture.source.generation };
const INPUT = 100n * 10n ** 18n;
const UNITS = [10n ** 18n, 10n ** 18n, 10n ** 6n, 10n ** 6n];
const BASELINE: ClassicBasePoolState = {
  balances: [48584016423561599164952509n, 47983845606201n, 63151726663480n],
  precisions: [1n, 10n ** 12n, 10n ** 12n], amplification: 4000n,
  fee: 1500000n, lpTotalSupply: 153602243283618865987372153n,
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const word = (v: bigint) => ethers.toBeHex(v, 32);
const PAD = <T>(values: readonly T[], length: number, zero: T) =>
  [...values, ...Array<T>(length - values.length).fill(zero)];
const BALANCES = new ethers.Interface(["function balances(uint256) view returns (uint256)"]);
const DIRECT = new ethers.Interface(["function get_dy(int128,int128,uint256) view returns (uint256)"]);

type Activity = { kind: "call"; target: string; data: string; nested?: boolean } |
  { kind: "log"; address: string; topics: readonly string[]; data: string };

async function setup() {
  let state = structuredClone(BASELINE), failBalances = false, previous = START, sequence = 0;
  const quotedEdges: string[] = [];
  const cache = createAdapterFamilyExactQuoteCache();
  function runtime(source: CanonicalSource) {
    return createStrictCentralAdapterRuntime({ executor: EXECUTOR, transactionOrigin: ACTOR,
      exactQuoteCache: cache,
      generationFence: { assertCurrent(generation, at) {
        assert.equal(generation, source.generation); assert.deepEqual(at, source);
      } }, provider: {
        async call(tx, block) {
          assert.equal(block, source.number);
          if (same(tx.to, CURVE_METAREGISTRY)) {
            const parsed = REGISTRY.parseTransaction({ data: tx.data }); assert(parsed);
            const values: Record<string, unknown[]> = {
              get_registry_handlers_from_pool: [PAD([POOL], 10, ethers.ZeroAddress)],
              get_underlying_coins: [PAD(COINS, 8, ethers.ZeroAddress)],
              get_underlying_decimals: [[18n, 18n, 6n, 6n, 0n, 0n, 0n, 0n]],
              get_underlying_balances: [[10n ** 24n, ...state.balances, 0n, 0n, 0n, 0n]],
            };
            assert(values[parsed.name]); return REGISTRY.encodeFunctionResult(parsed.name, values[parsed.name]);
          }
          if (tx.data === ERC20.encodeFunctionData("decimals")) {
            const index = COINS.findIndex(token => same(token, tx.to)); assert(index >= 0);
            return ERC20.encodeFunctionResult("decimals", [index < 2 ? 18 : 6]);
          }
          if (same(tx.to, BASE) && tx.data.startsWith(BALANCES.getFunction("balances")!.selector)) {
            if (failBalances) throw new Error("offline injected base balance read failure");
            const i = Number(BALANCES.decodeFunctionData("balances", tx.data)[0]);
            assert(i >= 0 && i < 3); return word(state.balances[i]);
          }
          if (same(tx.to, POOL) && tx.data.startsWith(POOL_ABI.getFunction("get_dy_underlying")!.selector)) {
            // ABI-valid synthetic behavior/raw view only. The selected base->base
            // Exact method reads balances and runs its real local execution math.
            const [i, j, amount] = POOL_ABI.decodeFunctionData("get_dy_underlying", tx.data);
            return word(BigInt(amount) * UNITS[Number(j)] / UNITS[Number(i)]);
          }
          if (same(tx.to, POOL) && tx.data.startsWith(DIRECT.getFunction("get_dy")!.selector)) {
            return word(BigInt(DIRECT.decodeFunctionData("get_dy", tx.data)[2]));
          }
          const saved = fixture.calls.find(row => same(row.to, tx.to) && same(row.data, tx.data));
          assert(saved, `unexpected offline call ${tx.to} ${tx.data}`); return saved.result;
        },
        async getCode(address, block) {
          assert.equal(block, source.number);
          const saved = Object.values(codes).find(row => same(row.address, address));
          assert(saved, `unexpected offline code ${address}`); return saved.code;
        },
        async getStorage(address, slot, block) {
          assert.equal(block, source.number);
          const saved = fixture.storage.find(row => same(row.address, address) && BigInt(row.slot) === BigInt(slot));
          assert(saved, `unexpected offline storage ${address} ${slot}`); return saved.result;
        },
      } });
  }
  const publication = await runStrictFamilyLifecycle({ catalog, familyId: CURVE_UNDERLYING_FAMILY_ID,
    source: START, runtime: runtime(START), observations: [{ kind: "call", source: START,
      target: POOL, sender: ACTOR, data: POOL_ABI.encodeFunctionData("exchange_underlying", [1, 2, INPUT, 0]) }] });
  assert.equal(publication.instances.length, 1);
  const instance = publication.instances[0];
  const descriptor = instance.descriptor as CurveUnderlyingDescriptor;
  assert(descriptor.quoteModel);
  assert.equal(instance.routes.length, 12, "all twelve routes must pass real pricing materialization");
  for (const pricing of instance.pricingInstances) {
    assert.equal(new Set(pricing.dependencies.map(a => a.toLowerCase())).size, pricing.dependencies.length);
  }
  const family = catalog.forFamily(CURVE_UNDERLYING_FAMILY_ID);
  const edges = buildFamilyRouteGraphView({ routes: instance.routes.map((route, i) => ({ family,
    descriptor, route, handle: instance.routeHandles[i] })) }).edges;
  const target = edges.find(e => same(e.tokenIn, COINS[1]) && same(e.tokenOut, COINS[2])); assert(target);
  const key = blockScanEdgeKey(target);
  const route = instance.routes.find(r => same(r.tokenIn, COINS[1]) && same(r.tokenOut, COINS[2])) as CurveUnderlyingRoute;
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
      weth: COINS[1], fixedWethInput: INPUT, gasCostWei: null, enumerationSpreadBps: 200, concurrency: 2,
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
    const source = { number: START.number + sequence, hash: ethers.id(`offline-curve-block-${sequence}`),
      generation: START.generation + sequence };
    const txHash = ethers.id(`offline-curve-tx-${sequence}`);
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
      id: `offline-curve-refresh-${sequence}`, edges, generation: source.generation,
      sourceBlock: source.number, sourceBlockHash: source.hash, completenessWatermark: source.number,
      familyIdForEdge: () => CURVE_UNDERLYING_FAMILY_ID,
      perSourceCoverage: [{ familyId: CURVE_UNDERLYING_FAMILY_ID, sourceId: "offline-fixture",
        sourceFingerprint: "classic-meta-refresh-synthetic", completeThroughBlock: source.number,
        completeThroughHash: source.hash }],
    }), deadlineAtMs: Date.now() + 20_000, touchedPools: touched,
      canonicalActivity: { source, parentHash: previous.hash, touchedStateKeys: touched, complete: true } });
    previous = source;
    const snapshot = coordinator.latestPricingSnapshot(); assert(snapshot?.effectiveMids);
    assert.deepEqual(snapshot.effectiveMids.source, source);
    const row = snapshot.effectiveMids.rows.get(key); assert(row);
    return { source, touched, snapshot, row, calls: [...quotedEdges], logCount: logs.length };
  }
  return { step, descriptor, route, key,
    donate() { state = { ...state, balances: [state.balances[0] + 10n ** 23n, ...state.balances.slice(1)] }; },
    fail() { failBalances = true; },
    expected() { return classicBaseExchangeAmount(state, 0, 1, INPUT); },
  };
}

for (const nested of [false, true]) {
  test(`${nested ? "nested" : "top-level"} eventless donation reaches blockscan update and refreshes Exact`, async () => {
    const h = await setup(), before = await h.step();
    assert.equal(before.row.amountOut, 99984648n);
    h.donate(); assert.equal(h.expected(), 99984591n);
    const next = await h.step({ kind: "call", target: BASE, data: DONATE, nested });
    assert.equal(next.logCount, 0);
    assert(next.touched.has(h.route.routeKey.toLowerCase()), "reader/resolver did not deliver the donation");
    assert.equal(next.calls.filter(key => key === h.key).length, 1);
    assert.equal(next.row.status, "quoted"); assert.equal(next.row.amountOut, h.expected());
    assert.deepEqual(next.row.quotedAt, next.source); assert.notStrictEqual(next.row, before.row);
  });
}

test("base-pool logs still refresh through the same production update entry", async () => {
  const h = await setup(), before = await h.step(); h.donate();
  const next = await h.step({ kind: "log", address: BASE,
    topics: [ethers.id("TokenExchange(address,int128,uint256,int128,uint256)")], data: "0x" });
  assert(next.touched.has(h.route.routeKey.toLowerCase()));
  assert(next.calls.includes(h.key)); assert.equal(next.row.amountOut, h.expected());
  assert.notEqual(next.row.amountOut, before.row.amountOut);
});

test("unrelated base calls, same selector at other targets and ordinary token transfers stay clean", async () => {
  const h = await setup(), before = await h.step();
  const activities: Activity[] = [
    ...["withdraw_admin_fees()", "get_virtual_price()"].map(signature => ({
      kind: "call" as const, target: BASE, data: ethers.id(signature).slice(0, 10), nested: true })),
    ...[POOL, h.descriptor.quoteModel!.baseLPToken, OTHER].map(target => ({ kind: "call" as const, target, data: DONATE })),
    ...COINS.map(address => ({ kind: "log" as const, address,
      topics: [TRANSFER, ethers.zeroPadValue(ACTOR, 32), ethers.zeroPadValue(OTHER, 32)], data: word(1n) })),
  ];
  for (const activity of activities) {
    const next = await h.step(activity);
    assert(!next.touched.has(h.route.routeKey.toLowerCase()), JSON.stringify(activity));
    assert.deepEqual(next.calls, [], "clean activity must not requote any metapool direction");
    assert.strictEqual(next.row, before.row); assert.equal(next.row.amountOut, before.row.amountOut);
  }
});

test("unknown quote models do not acquire the base donation exception", async () => {
  const h = await setup();
  const unknown: CurveUnderlyingDescriptor = { ...h.descriptor, quoteModel: undefined,
    pool: BASE, instanceKey: instanceKey(BASE.toLowerCase()) };
  const route = plugin.routes.project({ descriptor: unknown })[0];
  const pd = plugin.pricing.finalizePricingDescriptor({ sharedBindings: [],
    draft: plugin.pricing.compileDraft({ descriptor: unknown, routes: [route], stateKey: route.routeKey }) });
  const entry = { descriptor: pd, routes: [route], stateKey: route.routeKey,
    dependencies: plugin.pricing.dependencies({ descriptor: pd, routes: [route] }) };
  const observation: UnifiedObservation = { kind: "call", source: START, target: BASE, data: DONATE };
  const mutation = plugin.pricing.mutation;
  assert(mutation?.compile, "Family must expose a compiled mutation index");
  assert.deepEqual(mutation.affectedStateKeys({ ...entry, observation }), []);
  assert.deepEqual(mutation.compile({ entries: [entry] }).affectedStateKeys({ observation }), []);
});

test("a failed donation refresh cannot republish the old quote, including the next clean block", async () => {
  const h = await setup(), before = await h.step(); h.donate(); h.fail();
  const failed = await h.step({ kind: "call", target: BASE, data: DONATE, nested: true });
  assert(failed.calls.includes(h.key)); assert.equal(failed.row.status, "quote-failed");
  assert.equal(failed.row.amountOut, null); assert.equal(failed.row.effectiveMid, null);
  assert.notStrictEqual(failed.row, before.row); assert.equal(failed.row.quotedAt, undefined);
  assert(failed.snapshot.coverage.unresolvedEdgeKeys.includes(h.key));
  const clean = await h.step();
  assert.equal(clean.row.status, "quote-failed"); assert.equal(clean.row.amountOut, null);
  assert.equal(clean.row.quotedAt, undefined);
});

test("bound LP ordinary transfers and approvals carry quotes; mint/burn and unknown events refresh", async () => {
  const h = await setup(), before = await h.step();
  const address = h.descriptor.quoteModel!.baseLPToken;
  const actor = ethers.zeroPadValue(ACTOR, 32), other = ethers.zeroPadValue(OTHER, 32);
  const zero = ethers.zeroPadValue(ethers.ZeroAddress, 32);
  for (const topics of [[TRANSFER, actor, other], [ethers.id("Approval(address,address,uint256)"), actor, other]]) {
    const next = await h.step({ kind: "log", address, topics, data: word(1n) });
    assert(!next.touched.has(h.route.routeKey.toLowerCase()), "LP activity must not dirty this Family's price state");
    assert.deepEqual(next.calls, [], "ordinary LP balance/allowance changes must not issue any quote");
    assert.strictEqual(next.row, before.row);
  }
  for (const topics of [[TRANSFER, zero, actor], [TRANSFER, actor, zero], [ethers.id("UnknownLpStateChange()")],
    [TRANSFER], [TRANSFER, word((1n << 160n) + 1n), other]]) {
    const next = await h.step({ kind: "log", address, topics, data: word(1n) });
    assert(next.touched.has(h.route.routeKey.toLowerCase()));
    assert(next.calls.includes(h.key));
    assert.equal(next.row.status, "quoted");
    assert.deepEqual(next.row.quotedAt, next.source);
  }
  const malformed = await h.step({ kind: "log", address, topics: [TRANSFER, actor, other], data: "0x01" });
  assert(malformed.touched.has(h.route.routeKey.toLowerCase()));
  assert(malformed.calls.includes(h.key));
});

test("LP filtering remains bound-model-only and compiled/uncompiled mutation agree", async () => {
  const h = await setup();
  const address = h.descriptor.quoteModel!.baseLPToken;
  const unknown: CurveUnderlyingDescriptor = { ...h.descriptor, quoteModel: undefined,
    pool: address, instanceKey: instanceKey(address.toLowerCase()) };
  const mutation = plugin.pricing.mutation; assert(mutation?.compile);
  const entries = [h.descriptor, unknown].map(descriptor => {
    const route = plugin.routes.project({ descriptor })[0];
    const pd = plugin.pricing.finalizePricingDescriptor({ sharedBindings: [],
      draft: plugin.pricing.compileDraft({ descriptor, routes: [route], stateKey: route.routeKey }) });
    return { descriptor: pd, routes: [route], stateKey: route.routeKey,
      dependencies: plugin.pricing.dependencies({ descriptor: pd, routes: [route] }) };
  });
  const index = mutation.compile({ entries });
  const ordinary: UnifiedObservation = { kind: "log", source: START, address,
    topics: [TRANSFER, ethers.zeroPadValue(ACTOR, 32), ethers.zeroPadValue(OTHER, 32)], data: word(1n) };
  assert.deepEqual(mutation.affectedStateKeys({ ...entries[0], observation: ordinary }), []);
  assert.deepEqual(mutation.affectedStateKeys({ ...entries[1], observation: ordinary }), [entries[1].stateKey]);
  assert.deepEqual(index.affectedStateKeys({ observation: ordinary }), [entries[1].stateKey.toLowerCase()]);
  for (const topics of [[TRANSFER, ethers.zeroPadValue(ethers.ZeroAddress, 32), ethers.zeroPadValue(ACTOR, 32)],
    [ethers.id("UnknownLpStateChange()")], [TRANSFER]]) {
    const observation: UnifiedObservation = { ...ordinary, topics };
    const direct: string[] = [...new Set(entries.flatMap((entry): readonly string[] =>
      mutation.affectedStateKeys({ ...entry, observation })).map(k => k.toLowerCase()))];
    assert.deepEqual(new Set(index.affectedStateKeys({ observation })), new Set(direct));
    assert.equal(direct.length, 2);
  }
});
