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
import { LEGACY_PLAIN_ABI as ABI, LEGACY_PLAIN_KILLED_SLOT, quoteLegacyPlain } from "../legacy-plain.js";
import { CURVE_METAREGISTRY, CURVE_UNDERLYING_ERC20_INTERFACE as ERC20,
  CURVE_UNDERLYING_META_INTERFACE as REGISTRY, CURVE_UNDERLYING_POOL_INTERFACE as POOL_ABI } from "../codec.js";
import { CURVE_UNDERLYING_FAMILY_ID } from "../manifest.js";
import type { CurveUnderlyingDescriptor, CurveUnderlyingRoute } from "../types.js";

// Offline lifecycle regression through the production block reader, Ready
// resolver, current coordinator and publisher. Public state/bytecode are pinned;
// registry transport and neighboring blocks are synthetic, not historical proof.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/legacy-plain-susd.json", import.meta.url), "utf8"));
const code = gunzipSync(Buffer.from(fixture.runtimeGzipBase64, "base64")).toString();
const POOL: string = fixture.pool, COINS: string[] = fixture.coins, START: CanonicalSource = fixture.source;
const ACTOR = "0x1000000000000000000000000000000000000001";
const EXECUTOR = "0x1000000000000000000000000000000000000002";
const ROUTER = "0x1000000000000000000000000000000000000003";
const OTHER = "0x1000000000000000000000000000000000000004";
const INPUT = 67378445856171186n, UNITS = [10n ** 18n, 10n ** 6n, 10n ** 6n, 10n ** 18n];
const word = (v: bigint) => ethers.toBeHex(v, 32);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const PAD = <T>(values: readonly T[], length: number, zero: T) => [...values, ...Array<T>(length - values.length).fill(zero)];
type Activity = { kind: "call"; target: string; data: string; nested?: boolean } |
  { kind: "log"; address: string; topics: readonly string[]; data: string };
async function setup() {
  let state = { balances: fixture.balances.map(BigInt), amplification: BigInt(fixture.amplification),
    fee: BigInt(fixture.fee), adminFee: BigInt(fixture.adminFee), killed: false };
  let failControl = false, previous = START, sequence = 0;
  const quotedEdges: string[] = [], cache = createAdapterFamilyExactQuoteCache();
  function runtime(source: CanonicalSource) {
    return createStrictCentralAdapterRuntime({ executor: EXECUTOR, transactionOrigin: ACTOR, exactQuoteCache: cache,
      generationFence: { assertCurrent(generation, at) { assert.equal(generation, source.generation); assert.deepEqual(at, source); } },
      provider: {
        async call(tx, block) {
          assert.equal(block, source.number);
          if (same(tx.to, CURVE_METAREGISTRY)) {
            const parsed = REGISTRY.parseTransaction({ data: tx.data }); assert(parsed);
            const values: Record<string, unknown[]> = {
              get_registry_handlers_from_pool: [PAD([POOL], 10, ethers.ZeroAddress)],
              get_underlying_coins: [PAD(COINS, 8, ethers.ZeroAddress)],
              get_underlying_decimals: [[18n, 6n, 6n, 18n, 0n, 0n, 0n, 0n]],
              get_underlying_balances: [PAD(state.balances, 8, 0n)],
            };
            assert(values[parsed.name]); return REGISTRY.encodeFunctionResult(parsed.name, values[parsed.name]);
          }
          if (tx.data === ERC20.encodeFunctionData("decimals")) {
            const i = COINS.findIndex(token => same(token, tx.to)); assert(i >= 0);
            return ERC20.encodeFunctionResult("decimals", [i === 1 || i === 2 ? 6 : 18]);
          }
          assert(same(tx.to, POOL));
          if (tx.data.startsWith(POOL_ABI.getFunction("get_dy_underlying")!.selector)) {
            const [i, j, amount] = POOL_ABI.decodeFunctionData("get_dy_underlying", tx.data);
            return word(BigInt(amount) * UNITS[Number(j)] / UNITS[Number(i)]);
          }
          const parsed = ABI.parseTransaction({ data: tx.data }); assert(parsed);
          const i = Number(parsed.args.length ? parsed.args[0] : 0);
          const value = parsed.name === "A" ? state.amplification : parsed.name === "fee" ? state.fee
            : parsed.name === "admin_fee" ? state.adminFee : parsed.name === "balances" ? state.balances[i] : COINS[i];
          return ABI.encodeFunctionResult(parsed.name, [value]);
        },
        async getCode(address, block) { assert.equal(block, source.number); assert(same(address, POOL)); return code; },
        async getStorage(address, slot, block) {
          assert.equal(block, source.number); assert(same(address, POOL)); assert.equal(BigInt(slot), BigInt(LEGACY_PLAIN_KILLED_SLOT));
          if (failControl) throw new Error("synthetic control read failure");
          return word(state.killed ? 1n : 0n);
        },
      } });
  }
  const publication = await runStrictFamilyLifecycle({ catalog, familyId: CURVE_UNDERLYING_FAMILY_ID,
    source: START, runtime: runtime(START), observations: [{ kind: "call", source: START,
      target: POOL, sender: ACTOR, data: POOL_ABI.encodeFunctionData("exchange_underlying", [0, 1, INPUT, 0]) }] });
  assert.equal(publication.instances.length, 1);
  const instance = publication.instances[0];
  const descriptor = instance.descriptor as CurveUnderlyingDescriptor;
  assert(descriptor.legacyPlain);
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
    const source = { number: START.number + sequence, hash: ethers.id(`offline-legacy-plain-block-${sequence}`),
      generation: START.generation + sequence };
    const txHash = ethers.id(`offline-legacy-plain-tx-${sequence}`);
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
      id: `offline-legacy-plain-refresh-${sequence}`, edges, generation: source.generation,
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
  return { step, descriptor, route, key,
    kill(value: boolean) { state = { ...state, killed: value }; },
    fail(value: boolean) { failControl = value; },
    fee(value: bigint) { state = { ...state, fee: value }; },
    expected() { return quoteLegacyPlain(state, 0, 1, INPUT); },
  };
}
for (const nested of [false, true]) test(`${nested ? "nested" : "top-level"} legacy kill withdraws price and unkill restores through production lifecycle`, async () => {
  const h = await setup(), before = await h.step();
  assert.equal(before.row.status, "quoted"); assert.equal(before.row.amountOut, 67369n);
  h.kill(true);
  const killed = await h.step({ kind: "call", target: POOL, data: ethers.id("kill_me()").slice(0, 10), nested });
  assert.equal(killed.logCount, 0); assert(killed.touched.has(h.route.routeKey.toLowerCase()));
  assert.equal(killed.row.status, "quote-failed"); assert.equal(killed.row.amountOut, null);
  assert.equal(killed.row.effectiveMid, null); assert.equal(killed.row.quotedAt, undefined);
  const clean = await h.step();
  assert.notEqual(clean.row.status, "quoted"); assert.equal(clean.row.amountOut, null);
  h.kill(false);
  const restored = await h.step({ kind: "call", target: POOL, data: ethers.id("unkill_me()").slice(0, 10), nested });
  assert(restored.touched.has(h.route.routeKey.toLowerCase())); assert.equal(restored.row.status, "quoted");
  assert.equal(restored.row.amountOut, before.row.amountOut); assert.deepEqual(restored.row.quotedAt, restored.source);
});
test("legacy unchanged and unrelated blocks carry without expanding pricing work; fee logs refresh", async () => {
  const h = await setup(), before = await h.step();
  for (const activity of [undefined,
    { kind: "call" as const, target: OTHER, data: ethers.id("kill_me()").slice(0, 10) },
    { kind: "call" as const, target: POOL, data: ethers.id("withdraw_admin_fees()").slice(0, 10) }]) {
    const clean = await h.step(activity);
    assert(!clean.touched.has(h.route.routeKey.toLowerCase())); assert(!clean.calls.includes(h.key));
    assert.equal(clean.row.status, "quoted"); assert.equal(clean.row.amountOut, before.row.amountOut);
    assert.deepEqual(clean.row.quotedAt, before.row.quotedAt);
  }
  h.fee(100000000n);
  const changed = await h.step({ kind: "log", address: POOL, topics: [ethers.id("NewParameters(uint256,uint256,uint256)")], data: "0x" });
  assert(changed.touched.has(h.route.routeKey.toLowerCase())); assert.equal(changed.row.status, "quoted");
  assert.equal(changed.row.amountOut, h.expected()); assert(changed.row.amountOut !== before.row.amountOut);
  assert.deepEqual(changed.row.quotedAt, changed.source);
});
test("legacy control RPC failure cannot republish a stale quote and a later touched source recovers", async () => {
  const h = await setup(); await h.step(); h.fail(true);
  const activity = { kind: "call" as const, target: POOL, data: ethers.id("unkill_me()").slice(0, 10) };
  const failed = await h.step(activity);
  assert.equal(failed.row.status, "quote-failed"); assert.equal(failed.row.amountOut, null);
  const clean = await h.step(); assert.notEqual(clean.row.status, "quoted"); assert.equal(clean.row.amountOut, null);
  h.fail(false); const recovered = await h.step(activity);
  assert.equal(recovered.row.status, "quoted"); assert.equal(recovered.row.amountOut, 67369n);
  assert.deepEqual(recovered.row.quotedAt, recovered.source);
});
