import assert from "node:assert/strict";
import test from "node:test";
import { deserialize, serialize } from "node:v8";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { runUniv2Lifecycle, UNIV2_FIXTURE_FACTORY, UNIV2_FIXTURE_TOKEN0, UNIV2_FIXTURE_TOKEN1 } from "../architecture-migration-fixture-replay.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { StrictProductionRuntimeRoot } from "../strict-production-runtime-session.js";
import { StrictCurrentRuntimeCoordinator, type StrictCanonicalActivityProof, type StrictPricingPublication, type StrictSessionRequest } from "../strict-current-runtime-coordinator.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../venues/production-family-composition.js";
import { UNIV2_PAIR_INTERFACE } from "../venues/swaps/univ2-family/codec.js";
import { blockScanEdgeKey, createVerifiedGraphView } from "../venues/blockscan-state-capability.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import { buildEffectiveMids, exportEffectiveMidReplayDelta, effectiveMidRowCarried } from "../blockscan-effective-mid.js";
import { collectReorgActivity, type ReorgActivityHeader } from "../blockscan-reorg-activity.js";
import { LivePricingContinuationStore, LivePricingContinuationWriter } from "../blockscan-live-continuation.js";
import { BlockScanAmountReference } from "../blockscan-amount-reference.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const source = (number: number, id: number, generation: number): CanonicalSource => ({ number, hash: hash(id), generation });
const ancestor = source(99, 99, 1), orphan = source(100, 1000, 2), repaired = source(101, 101, 3);
const executor = `0x${"64".repeat(20)}`, origin = `0x${"65".repeat(20)}`;
const balanceInterface = new ethers.Interface(["function balanceOf(address account) view returns (uint256)"]);

async function fixture(beforeRetire?: (coordinator: StrictCurrentRuntimeCoordinator) => Promise<void>) {
  const pools = [0x1000, 0x1001, 0x1002].map(n => `0x${n.toString(16).padStart(40, "0")}`);
  const publications = await Promise.all(pools.map(pool => runUniv2Lifecycle(ancestor, {
    pool, factory: UNIV2_FIXTURE_FACTORY, token0: UNIV2_FIXTURE_TOKEN0, token1: UNIV2_FIXTURE_TOKEN1,
    reserves: { reserve0: 1_000_000_000n, reserve1: 2_000_000_000n, blockTimestampLast: 1 },
  })));
  const instances = publications.flatMap(p => p.instances);
  const familyId = publications[0]!.familyId, family = catalog.forFamily(familyId);
  const view = buildFamilyRouteGraphView({ routes: instances.flatMap(instance => instance.routes.map((route, index) => ({
    family, descriptor: instance.descriptor, route, handle: instance.routeHandles[index],
  }))) });
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: ancestor, readyGraph: view.edges,
    readyInstances: instances, readyFundingAssets: [] });
  const graph = (s: CanonicalSource) => createVerifiedGraphView({ id: "reorg-integration", generation: s.generation,
    sourceBlock: s.number, sourceBlockHash: s.hash, completenessWatermark: s.number,
    perSourceCoverage: [{ familyId, sourceId: "reorg-integration", sourceFingerprint: "reorg-integration-v1",
      completeThroughBlock: s.number, completeThroughHash: s.hash }], familyIdForEdge: () => familyId, edges: view.edges });
  const amountQuotes: string[] = [], rawReads: string[] = [], requests: StrictSessionRequest[] = [];
  const published: StrictPricingPublication[] = [];
  let resets = 0, afterQuote: (() => void) | undefined;
  const makeCoordinator = () => new StrictCurrentRuntimeCoordinator(request => {
    requests.push(request);
    const runtime = createStrictCentralAdapterRuntime({ provider: {
      call: async call => {
        if (call.data.slice(0, 10) === UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector) {
          rawReads.push(call.to.toLowerCase());
          return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [1_000_000_000n, 2_000_000_000n, 1]);
        }
        return balanceInterface.encodeFunctionResult("balanceOf", [10n ** 24n]);
      }, getCode: async () => "0x01", getStorage: async () => hash(0),
    }, executor, transactionOrigin: origin, generationFence: { assertCurrent(generation, actual) {
      assert.equal(generation, request.source.generation); assert.deepEqual(actual, request.source);
    } } });
    return root.createSession({ source: request.source, runtime, fundingAssets: request.fundingAssets,
      control: request.control, kind: request.purpose === "exact-execution" ? "exact" : "pricing",
      requiredEdgeIds: request.requiredEdgeIds, touchedPools: request.touchedPools });
  }, () => { resets++; }, publication => { published.push(publication); }, async (pricing, control, _backend, reuse) => {
    const target = reuse?.quoteGraph ?? pricing;
    // Controlled amount responses test production orchestration, not EVM execution/performance.
    return buildEffectiveMids({ pricing, control, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous,
      touchedStateKeys: reuse?.touchedStateKeys, disabledEdgeIds: reuse?.disabledEdgeIds,
      weth: UNIV2_FIXTURE_TOKEN0, gasCostWei: null, enumerationSpreadBps: 0, concurrency: 2,
      cascadeAmountChanges: false, quote: async ({ edge, amountIn }) => {
        amountQuotes.push(edge.instanceKey!); afterQuote?.();
        return { source: { number: target.sourceBlock, hash: target.sourceBlockHash, generation: target.generation },
          amountIn, amountOut: amountIn * 2n + BigInt(target.sourceBlock) };
      } });
  });
  const coordinator = makeCoordinator();
  await coordinator.prepareCoarsePricing({ graph: graph(ancestor), deadlineAtMs: Date.now() + 10_000 });
  assert.equal(amountQuotes.length, 6);
  const raw = coordinator.continuationPricing().raw;
  await coordinator.prepareCoarsePricing({ graph: graph(orphan), deadlineAtMs: Date.now() + 10_000,
    canonicalActivity: { source: orphan, previousSource: ancestor, parentHash: ancestor.hash,
      complete: true, touchedStateKeys: new Set([pools[0]!]) } });
  const previous = coordinator.latestPricingSnapshot()!;
  const block = (s: CanonicalSource, parent: string): ReorgActivityHeader => ({ ...s, parentHash: parent,
    transactionHashes: [], passiveTouchedAddresses: [] });
  const oldHeader = block(orphan, ancestor.hash), ancestorHeader = block(ancestor, hash(98));
  const replacement = block(source(100, 100, 2), ancestor.hash), target = block(repaired, replacement.hash);
  const canonical = new Map([[99, ancestorHeader], [100, replacement], [101, target]]);
  const proof = await collectReorgActivity({ previousSource: orphan, target, deadlineAtMs: Date.now() + 10_000,
    readCanonicalHeader: async n => canonical.get(n),
    readHeaderByHash: async h => h === oldHeader.hash ? oldHeader : h === ancestor.hash ? ancestorHeader : null,
    readTouched: async (_n, h) => new Set(h.hash === oldHeader.hash ? [pools[0]!] : h.hash === replacement.hash ? [pools[1]!] : []),
  });
  const activity: StrictCanonicalActivityProof = { source: repaired, previousSource: orphan, complete: true,
    touchedStateKeys: proof.touchedStateKeys, reorg: proof };
  await beforeRetire?.(coordinator);
  await coordinator.retirePricingForReorg(orphan);
  amountQuotes.length = 0; rawReads.length = 0; requests.length = 0;
  return { coordinator, makeCoordinator, graph, pools, amountQuotes, rawReads, requests, published, previous, raw, activity,
    canonical, setAfterQuote: (callback: () => void) => { afterQuote = callback; }, resets: () => resets };
}

test("real coordinator repairs both branches incrementally without rebuilding raw/session universe", async () => {
  const f = await fixture();
  assert.strictEqual(f.coordinator.latestPricingSnapshot(), f.previous);
  assert.strictEqual(f.coordinator.continuationPricing().raw, f.raw);
  assert.equal(f.coordinator.continuationPricing().pricing, null);
  const result = await f.coordinator.prepareCoarsePricing({ graph: f.graph(repaired), canonicalActivity: f.activity,
    touchedPools: f.activity.touchedStateKeys, deadlineAtMs: Date.now() + 10_000 });
  assert.equal(result.status, "complete");
  assert.deepEqual(f.rawReads, [], "no startup/raw refresh");
  assert.deepEqual(new Set(f.amountQuotes), new Set(f.pools.slice(0, 2)), "old-only and new-only touched pools reprice; clean pool carries");
  assert.equal(f.amountQuotes.length, 4);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.purpose, "exact-execution");
  assert.equal(f.requests[0]!.requiredEdgeIds?.size, 0, "no full binding projection");
  assert.strictEqual(f.coordinator.continuationPricing().raw, f.raw);
  assert.strictEqual(f.coordinator.continuationPricing().pricing, result.snapshot);
  assert.equal(f.published.at(-1)!.kind, "delta");
  const native = exportEffectiveMidReplayDelta(result.snapshot.effectiveMids!, f.previous.effectiveMids!);
  assert.deepEqual(native.source, repaired);
  assert.equal(native.updates.length, 4, "native delta remains connected to orphan data predecessor");
  for (const edge of result.snapshot.graph.edges.filter(edge => edge.instanceKey === f.pools[2])) {
    const key = blockScanEdgeKey(edge), row = result.snapshot.effectiveMids!.rows.get(key)!;
    assert.strictEqual(row, f.previous.effectiveMids!.rows.get(key));
    assert.equal(effectiveMidRowCarried(result.snapshot.effectiveMids!, row), true);
  }
  // Persistable data-only baseline remains loadable after successful repair.
  const baseline = deserialize(serialize(f.coordinator.exportHistoricalBaseline()));
  const restored = f.makeCoordinator();
  await restored.restoreHistoricalBaseline(baseline, { graph: f.graph(repaired), rawGraph: f.graph(ancestor),
    weth: UNIV2_FIXTURE_TOKEN0, control: { deadlineAtMs: Date.now() + 10_000 } });
  assert.equal(restored.latestPricingSnapshot()!.sourceBlockHash, repaired.hash);
  f.amountQuotes.length = 0;
  const next = source(102, 102, 4);
  await restored.prepareCoarsePricing({ graph: f.graph(next), deadlineAtMs: Date.now() + 10_000,
    canonicalActivity: { source: next, previousSource: repaired, parentHash: repaired.hash, complete: true, touchedStateKeys: new Set() } });
  assert.equal(f.amountQuotes.length, 0, "restored repaired table immediately resumes clean incremental carry");
});

test("retired data cannot authorize Funding/Exact/full prepare or missing/forged branch proof", async () => {
  const f = await fixture(), args = { graph: f.graph(repaired), fundingTokens: [], deadlineAtMs: Date.now() + 10_000 };
  await assert.rejects(f.coordinator.prepare(args), /pricing-only/);
  assert.throws(() => f.coordinator.startFundingPreparation(args), /bars Funding/);
  await assert.rejects(f.coordinator.prepareCurrentNExactExecutionContext({ ...args, requiredEdgeIds: new Set() }), /bars Exact/);
  assert.throws(() => f.coordinator.exportHistoricalBaseline(), /complete published/);
  for (const canonicalActivity of [undefined, { ...f.activity, reorg: undefined },
    { ...f.activity, reorg: { ...f.activity.reorg! } }, { ...f.activity, touchedStateKeys: new Set([f.pools[1]!]) }]) {
    await assert.rejects(f.coordinator.prepareCoarsePricing({ ...args, canonicalActivity }), /complete branch proof/);
  }
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.amountQuotes, []);
  assert.equal(f.resets(), 1);
  assert.strictEqual(f.coordinator.latestPricingSnapshot(), f.previous);
});

test("reorg during quotes rejects publication and leaves data pending for verified retry", async () => {
  const f = await fixture(), count = f.published.length;
  const target = f.canonical.get(101)!;
  f.setAfterQuote(() => f.canonical.set(101, { ...target, hash: hash(999) }));
  await assert.rejects(f.coordinator.prepareCoarsePricing({ graph: f.graph(repaired), canonicalActivity: f.activity,
    deadlineAtMs: Date.now() + 10_000 }), /target changed/);
  assert.equal(f.amountQuotes.length, 4);
  assert.equal(f.published.length, count);
  assert.strictEqual(f.coordinator.latestPricingSnapshot(), f.previous);
  assert.strictEqual(f.coordinator.continuationPricing().raw, f.raw);
  assert.equal(f.coordinator.continuationPricing().pricing, null);
  assert.throws(() => f.coordinator.exportHistoricalBaseline(), /complete published/);
  f.setAfterQuote(() => {});
  f.canonical.set(101, target);
  f.amountQuotes.length = 0;
  const retry = await f.coordinator.prepareCoarsePricing({ graph: f.graph(repaired), canonicalActivity: f.activity,
    deadlineAtMs: Date.now() + 10_000 });
  assert.equal(retry.status, "complete");
  assert.equal(f.amountQuotes.length, 4, "failed draft cannot suppress dirty recovery quotes on retry");
  assert.strictEqual(f.coordinator.continuationPricing().raw, f.raw);
  assert.equal(exportEffectiveMidReplayDelta(retry.snapshot.effectiveMids!, f.previous.effectiveMids!).updates.length, 4);
});

test("real continuation writer journals repaired delta once and store replays latest canonical pricing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "strict-reorg-journal-"));
  try {
    const identity = "a".repeat(64), store = new LivePricingContinuationStore(directory, identity);
    const events: Record<string, unknown>[] = [];
    let writer!: LivePricingContinuationWriter;
    const f = await fixture(async coordinator => {
      writer = new LivePricingContinuationWriter({ store, coordinator, amounts: new BlockScanAmountReference(),
        simRejects: new BlockScanSimRejectCache(), startup: {
          exportContinuation: () => ({ version: 1, rows: [] }),
          takeContinuationDelta: () => ({ reset: false, rows: [] }),
        }, onEvent: event => events.push(event) });
      writer.capture();
      await writer.flush();
    });
    const initialFiles = (await readdir(directory)).sort();
    const baselineFile = initialFiles.find(name => name.startsWith("baseline-"))!;
    assert.ok(baselineFile);
    assert.equal(initialFiles.filter(name => name.startsWith("baseline-")).length, 1);
    const baselineBytes = await readFile(join(directory, baselineFile));
    const pointerBytes = await readFile(join(directory, "current.bin"));
    assert.deepEqual(events.map(event => event.kind), ["baseline"]);
    writer.capture();
    await writer.flush();
    assert.deepEqual((await readdir(directory)).sort(), initialFiles, "retired pricing emits no journal record");
    assert.deepEqual(await readFile(join(directory, "current.bin")), pointerBytes, "pending repair cannot move durable source");
    const result = await f.coordinator.prepareCoarsePricing({ graph: f.graph(repaired), canonicalActivity: f.activity,
      deadlineAtMs: Date.now() + 10_000 });
    writer.capture();
    await writer.flush();
    writer.capture();
    await writer.flush();
    assert.deepEqual(events.map(event => [event.phase, event.kind, event.sourceBlock]),
      [["saved", "baseline", 100], ["saved", "delta", 101]], "repair appends once, never rewrites baseline");
    assert.deepEqual(await readFile(join(directory, baselineFile)), baselineBytes);
    const files = await readdir(directory);
    assert.equal(files.filter(name => name.startsWith("baseline-")).length, 1);
    assert.equal(files.filter(name => name.startsWith("delta-")).length, 1);
    const deltaBytes = await readFile(join(directory, files.find(name => name.startsWith("delta-"))!));
    const record = deserialize(deltaBytes.subarray(65));
    assert.deepEqual(record.delta.previous, orphan);
    assert.deepEqual(record.delta.source, repaired);
    assert.equal(record.delta.effective.updates.length, 4, "disk record uses producer-native dirty rows only");
    const restoredData = await new LivePricingContinuationStore(directory, identity).read();
    assert.ok(restoredData);
    assert.equal(restoredData.pricing.raw.sourceBlock, ancestor.number);
    assert.equal(restoredData.pricing.raw.sourceBlockHash, ancestor.hash);
    assert.equal(restoredData.pricing.pricing.sourceBlockHash, repaired.hash);
    const restored = f.makeCoordinator();
    await restored.restoreHistoricalBaseline(restoredData.pricing, { graph: f.graph(repaired), rawGraph: f.graph(ancestor),
      weth: UNIV2_FIXTURE_TOKEN0, control: { deadlineAtMs: Date.now() + 10_000 } });
    const compareRows = (snapshot: typeof result.snapshot) => [...snapshot.effectiveMids!.rows].map(([key, row]) =>
      [key, row.amountIn, row.amountOut, row.status, row.quotedAt]);
    assert.deepEqual(compareRows(restored.latestPricingSnapshot()!), compareRows(result.snapshot));
    f.amountQuotes.length = 0;
    const next = source(102, 102, 4);
    await restored.prepareCoarsePricing({ graph: f.graph(next), deadlineAtMs: Date.now() + 10_000,
      canonicalActivity: { source: next, previousSource: repaired, parentHash: repaired.hash, complete: true, touchedStateKeys: new Set() } });
    assert.equal(f.amountQuotes.length, 0, "actual journal replay resumes clean pricing without warming");
    assert.equal(restored.latestPricingSnapshot()!.sourceBlock, 102);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
