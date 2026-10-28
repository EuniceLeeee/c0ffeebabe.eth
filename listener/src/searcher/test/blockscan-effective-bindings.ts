import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runUniv2Lifecycle, UNIV2_FIXTURE_FACTORY, UNIV2_FIXTURE_TOKEN0,
  UNIV2_FIXTURE_TOKEN1 } from "../architecture-migration-fixture-replay.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../strict-production-runtime-session.js";
import * as current from "../blockscan-effective-mid.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../venues/production-family-composition.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import { UNIV2_PAIR_INTERFACE, UNIV2_TOKEN_INTERFACE } from "../venues/swaps/univ2-family/codec.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";

// Offline cohort over the real lifecycle, binding and Exact implementations.
// Optional argv[2] points to an immutable baseline effective-mid module; no RPC,
// wallet, live loop or alternate quote math is used by this test.
const reference: typeof current = process.argv[2]
  ? await import(pathToFileURL(resolve(process.argv[2])).href) : current;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const at = (n: number): CanonicalSource => ({number: 25_800_000 + n,
  hash: `0x${n.toString(16).padStart(64, "0")}`, generation: n + 1});
const startup = at(0), source = at(1), next = at(2), executor = address(9999);
const pools = Array.from({length: 34}, (_, i) => ({pool: address(0x1000 + i),
  factory: UNIV2_FIXTURE_FACTORY, token0: i === 33 ? address(888) : UNIV2_FIXTURE_TOKEN0,
  token1: i === 0 || i === 33 ? ADDR.WETH : UNIV2_FIXTURE_TOKEN1,
  reserves: {reserve0: 10n ** 24n, reserve1: 2n * 10n ** 24n, blockTimestampLast: 1}}));
const publications = await Promise.all(pools.map(pool => runUniv2Lifecycle(startup, pool)));
const instances = publications.flatMap(p => p.instances);
const family = catalog.forFamily(publications[0]!.familyId);
const view = buildFamilyRouteGraphView({routes: instances.flatMap(instance => instance.routes.map((route, i) =>
  ({family, descriptor: instance.descriptor, route, handle: instance.routeHandles[i]})))});
const root = new StrictProductionRuntimeRoot({catalog, readySource: startup, readyGraph: view.edges,
  readyInstances: instances, readyFundingAssets: []});
const allIds = new Set(view.edges.map(blockScanEdgeKey));
const prices = (source: CanonicalSource) => ({sourceBlock: source.number, sourceBlockHash: source.hash,
  generation: source.generation, graph: {edges: view.edges}, mids: new Map(),
  coverage: {resolvedEdgeKeys: []}, pricingStateKeyByEdgeKey: root.pricingIndex().stateKeyByEdgeKey});
const touched = new Set([root.pricingIndex().stateKeyByEdgeKey.get(blockScanEdgeKey(
  view.edges.find(e => e.instanceKey === instances[1]!.instanceKey)!))!]);
const healthyTouched = new Set([root.pricingIndex().stateKeyByEdgeKey.get(blockScanEdgeKey(
  view.edges.find(e => e.instanceKey === instances.at(-1)!.instanceKey)!))!]);
let generationActive = true;
function runtime(source: CanonicalSource, failRoot = false) {
  return createStrictCentralAdapterRuntime({executor,
    generationFence: {assertCurrent(generation, actual) {
      assert(generationActive, "retired generation");
      assert.equal(generation, source.generation); assert.deepEqual(actual, source);
    }},
    provider: {
      async getCode() { throw new Error("unexpected code read"); },
      async getStorage() { throw new Error("unexpected storage read"); },
      async call(request, block) {
        assert.equal(block, source.number);
        if (request.data.startsWith(UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector)) {
          if (failRoot && request.to.toLowerCase() === pools[0]!.pool) throw new Error("fixture root unavailable");
          return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [10n ** 24n, 2n * 10n ** 24n, 1]);
        }
        assert(request.data.startsWith(UNIV2_TOKEN_INTERFACE.getFunction("balanceOf")!.selector));
        return UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [10n ** 24n]);
      },
    },
  });
}
type Snapshot = current.EffectiveMidSnapshot;
async function run(module: typeof current, demand: boolean, source: CanonicalSource,
  previous?: Snapshot, touchedStateKeys?: ReadonlySet<string>, failRoot = false, cascadeAmountChanges = false) {
  const stats = {sessions: 0, selectedInstances: 0, projectedRoutes: 0, prepareMs: 0, quoteCalls: 0};
  let broad: StrictProductionRuntimeSession | undefined;
  const prepare = async (ids: ReadonlySet<string>) => {
    const session = await root.createSession({source, runtime: runtime(source, failRoot),
      fundingAssets: [], kind: "exact", requiredEdgeIds: ids});
    stats.sessions++; stats.selectedInstances += session.creationTiming.selectedInstanceCount;
    stats.projectedRoutes += session.creationTiming.projectedRouteCount;
    stats.prepareMs += session.creationTiming.totalMs;
    return session;
  };
  const sessions = current.createEffectiveQuoteSessions(prepare);
  const snapshot = await module.buildEffectiveMids({pricing: prices(source), weth: ADDR.WETH,
    gasCostWei: null, enumerationSpreadBps: 0, concurrency: 4, control: {}, previous, touchedStateKeys,
    cascadeAmountChanges,
    prepareQuote: demand ? sessions.prepareQuote : async ids => {
      // With the baseline module this is exactly its production callback.
      // Without it, a full broad session is an output-equivalence reference.
      broad ??= await prepare(module === current ? allIds : ids);
    },
    quote: async request => {
      stats.quoteCalls++;
      const quote = await (demand ? sessions.sessionFor(request.edge) : broad!).issueExact({
        ...request, executor, runtimeEvidence: []});
      assert("amountIn" in quote); return quote;
    },
  });
  assert(snapshot.complete);
  return {snapshot, stats};
}
const output = [];
for (const scenario of ["cold", "quiet", "sparse", "cascade", "failed-frontier", "partial-failure", "recovery"] as const) {
  const pair = [];
  for (const demand of [false, true]) {
    const module = demand ? current : reference;
    const failed = scenario === "failed-frontier" || scenario === "partial-failure" || scenario === "recovery";
    const previous = scenario === "cold" ? undefined : (await run(module, demand, source,
      undefined, undefined, failed)).snapshot;
    const dirty = scenario === "partial-failure" ? healthyTouched : scenario === "sparse" || scenario === "cascade" ? touched
      : scenario === "recovery" ? new Set(root.pricingIndex().stateKeyByEdgeKey.values()) : new Set<string>();
    pair.push(await run(module, demand, next, previous, dirty,
      scenario === "failed-frontier" || scenario === "partial-failure", scenario === "cascade"));
  }
  const [base, demand] = pair;
  assert.deepEqual([...demand!.snapshot.rows], [...base!.snapshot.rows], scenario + " output parity");
  assert.deepEqual(current.effectiveAmountReferences(demand!.snapshot), reference.effectiveAmountReferences(base!.snapshot));
  assert.equal(demand!.stats.quoteCalls, base!.stats.quoteCalls);
  if (scenario === "sparse" || scenario === "cascade" || scenario === "partial-failure") {
    assert.equal(demand!.stats.selectedInstances, 1);
    assert.equal(demand!.stats.quoteCalls, 2);
  } else if (scenario === "quiet" || scenario === "failed-frontier") {
    assert.equal(demand!.stats.sessions, 0); assert.equal(demand!.stats.quoteCalls, 0);
  } else {
    assert.equal(demand!.stats.selectedInstances, instances.length, "cold/recovered instances bind once, not per layer");
    assert.equal(demand!.stats.quoteCalls, view.edges.length);
  }
  output.push({scenario, baseline: base!.stats, demand: demand!.stats});
}

// The pool's other direction shares its issued session, but a new build owns a
// different session. Source retirement still rejects quotes; prefix authority
// cannot cross those independently issued sessions, even at the same source.
let prepares = 0;
const makeSessions = () => current.createEffectiveQuoteSessions(async ids => {
  prepares++; return root.createSession({source, runtime: runtime(source), fundingAssets: [], kind: "exact", requiredEdgeIds: ids});
});
const one = makeSessions(), two = makeSessions();
const forward = view.edges[0]!, reverse = view.edges[1]!;
assert.throws(() => one.sessionFor(forward), /not prepared/);
await one.prepareQuote(new Set([blockScanEdgeKey(forward)]));
await one.prepareQuote(new Set([blockScanEdgeKey(reverse)]));
assert.equal(prepares, 1);
assert.equal(one.sessionFor(forward), one.sessionFor(reverse));
await two.prepareQuote(new Set([blockScanEdgeKey(reverse)]));
assert.equal(prepares, 2);
assert.notEqual(one.sessionFor(forward), two.sessionFor(reverse));
const first = await one.sessionFor(forward).issueExact({edge: forward, amountIn: 1_000_000n, executor, runtimeEvidence: []});
await assert.rejects(two.sessionFor(reverse).issueExact({edge: reverse, amountIn: first.amountOut,
  executor, runtimeEvidence: [], priorQuotes: [first]}), /same-session/);
generationActive = false;
await assert.rejects(one.sessionFor(forward).issueExact({edge: forward, amountIn: 1_000_000n,
  executor, runtimeEvidence: []}), /retired generation/);
console.log(JSON.stringify({test: "effective-binding-cohort", actualBaselineModule: !!process.argv[2],
  cases: output, sourceAndPrefixFences: "pass", verdict: "offline_pass_not_live_latency"}));
