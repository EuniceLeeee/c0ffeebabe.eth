import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { createBlockScanPriceRuntime, resolveBlockScanCoreConfig } from "../main.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import { LivePricingContinuationStore, LivePricingContinuationWriter } from "../blockscan-live-continuation.js";
import { createBlockScanStartupExecutionPreflight } from "../blockscan-startup-execution-preflight.js";
import { RevmStrictError } from "../revm-sim-client.js";
import type { StrictSimulationTransport } from "../strict-central-adapter-runtime.js";
import type { StartupNodeInvocation, StartupNodeSimulation } from "../blockscan-startup-node-simulation.js";
import { StrictCurrentRuntimeCoordinator } from "../strict-current-runtime-coordinator.js";
import { StrictProductionRuntimeRoot } from "../strict-production-runtime-session.js";
import { runUniv2Lifecycle, UNIV2_FIXTURE_FACTORY, UNIV2_FIXTURE_TOKEN0 } from "../architecture-migration-fixture-replay.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../venues/production-family-composition.js";
import { blockScanEdgeKey, createVerifiedGraphView } from "../venues/blockscan-state-capability.js";
import { UNIV2_PAIR_INTERFACE, UNIV2_TOKEN_INTERFACE } from "../venues/swaps/univ2-family/codec.js";
import { effectiveEnumerationMids, effectiveAmountReferences } from "../blockscan-effective-mid.js";
import { buildBlockScanEthView } from "../blockscan-eth-view.js";
import { ADDR } from "../../shared/constants/addresses.js";
import type { BlockScanStateSnapshot } from "../blockscan-state-coordinator.js";
import type { SimulationResult } from "../simulator/botvm-simulator.js";

// Exercise the real main.ts pricing callback, binding sessions and Exact math.
// Only chain reads are fixtures. No live process, RPC or full Ready warmup.
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const sourceAt = (n: number) => ({ number: 25_800_000 + n,
  hash: `0x${n.toString(16).padStart(64, "0")}`, generation: n + 1 });
const startup = sourceAt(0);
const publications = await Promise.all([1, 2, 3].map(n => runUniv2Lifecycle(startup, {
  pool: address(0x1000 + n), factory: UNIV2_FIXTURE_FACTORY,
  token0: UNIV2_FIXTURE_TOKEN0, token1: ADDR.WETH,
  reserves: { reserve0: 10n ** 24n, reserve1: 2n * 10n ** 24n, blockTimestampLast: 1 },
})));
const instances = publications.flatMap(p => p.instances);
const family = catalog.forFamily(publications[0]!.familyId);
const view = buildFamilyRouteGraphView({ routes: instances.flatMap(instance => instance.routes.map((route, i) =>
  ({ family, descriptor: instance.descriptor, route, handle: instance.routeHandles[i] }))) });
const edges = view.edges, ids = edges.map(blockScanEdgeKey);
const root = new StrictProductionRuntimeRoot({ catalog, readySource: startup,
  readyGraph: edges, readyInstances: instances, readyFundingAssets: [] });
const prepared: string[] = [], called: string[] = [];
const createSession = root.createSession.bind(root);
const observedCreateSession: typeof root.createSession = async input => {
  prepared.push(...input.requiredEdgeIds ?? []);
  return createSession(input);
};
const observedRoot = new Proxy(root, { get(target, property) {
  return property === "createSession" ? observedCreateSession : Reflect.get(target, property);
} });
const reject = new BlockScanSimRejectCache();
const provider = new ethers.JsonRpcProvider("http://127.0.0.1:1");
// Any accidental provider fallback fails immediately, never reaches a network.
provider.send = async () => { throw new Error("unexpected network fallback"); };
const factoryInput = { provider, rpcUrl: "http://127.0.0.1:1", executor: address(9999),
  transactionOrigin: address(9998), strictRuntimeRoot: observedRoot, blockScanRuntimeAbort: new AbortController(),
  fixedEffectiveWethInput: 20_000_000_000_000_000n,
  blockScanCfg: resolveBlockScanCoreConfig({}), recordPricing: () => {},
  isPoolSimRejected: (edge: typeof edges[number]) => reject.hasPool(edge) };
const runtime = createBlockScanPriceRuntime(factoryInput);
type Effective = NonNullable<ConstructorParameters<typeof StrictCurrentRuntimeCoordinator>[3]>;
// Inspect the existing callback, without adding a production test interface.
const quote = (runtime.currentRuntimeCoordinator as unknown as { effectivePricing: Effective }).effectivePricing;
const backend: NonNullable<Parameters<Effective>[2]> = { async call(tx) {
  called.push(String(tx.to).toLowerCase());
  if (String(tx.data).startsWith(UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector))
    return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [10n ** 24n, 2n * 10n ** 24n, 1]);
  assert(String(tx.data).startsWith(UNIV2_TOKEN_INTERFACE.getFunction("balanceOf")!.selector));
  return UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [10n ** 24n]);
} };
const graphAt = (n: number) => {
  const source = sourceAt(n);
  return createVerifiedGraphView({ id: `pool-effective-${n}`, sourceBlock: source.number,
    sourceBlockHash: source.hash, generation: source.generation, completenessWatermark: source.number,
    familyIdForEdge: () => publications[0]!.familyId,
    perSourceCoverage: [{ familyId: publications[0]!.familyId, sourceId: "offline-fixture",
      sourceFingerprint: "offline-fixture", completeThroughBlock: source.number, completeThroughHash: source.hash }], edges });
};
const prices = (n: number) => ({ sourceBlock: sourceAt(n).number, sourceBlockHash: sourceAt(n).hash,
  generation: sourceAt(n).generation, graph: { edges }, mids: new Map(), coverage: { resolvedEdgeKeys: ids },
  pricingStateKeyByEdgeKey: root.pricingIndex().stateKeyByEdgeKey } as unknown as BlockScanStateSnapshot);
const resetCounts = () => { prepared.length = 0; called.length = 0; };
const baseline = await quote(prices(1), {}, backend);
assert.equal(baseline.rows.size, 6);
assert([...baseline.rows.values()].every(row => row.status === "quoted"));
const failed = edges[0]!, failedIds = ids.filter((_, i) => edges[i]!.instanceKey === failed.instanceKey);
const revert: SimulationResult = { success: false, profitToken: ADDR.WETH,
  grossProfit: 0n, netProfit: 0n, gasUsed: 0n, calldata: "0x",
  failure: { kind: "revert", code: "TRANSACTION_REVERTED", cause: new Error("fixture attributed revert") } };
const p = { amount: 1n, p: 1n };
reject.record("route-only", revert, p);
resetCounts();
const routeOnly = await quote(prices(1), {}, backend, { previous: baseline, quoteGraph: graphAt(2), touchedStateKeys: new Set() });
assert([...routeOnly.rows.values()].every(row => row.status === "quoted"), "route revert does not blacklist pools");
assert.equal(prepared.length, 0); assert.equal(called.length, 0);
assert(reject.recordPool(failed, revert, p));
const existingDisabled = new Set([ids.at(-1)!]);
resetCounts();
const invalidated = await quote(prices(1), {}, backend, { previous: routeOnly, quoteGraph: graphAt(3),
  touchedStateKeys: new Set(), disabledEdgeIds: existingDisabled });
const expectedDisabled = new Set([...failedIds, ...existingDisabled]);
for (const [id, row] of invalidated.rows) {
  if (expectedDisabled.has(id)) {
    assert.equal(row.status, "disabled-for-run", "confirmed pool must invalidate a previously valid price");
    assert.equal(row.amountIn, null); assert.equal(row.amountOut, null); assert.equal(row.effectiveMid, null);
  } else assert.strictEqual(row, routeOnly.rows.get(id), "healthy cached price stays unchanged");
}
assert.deepEqual(existingDisabled, new Set([ids.at(-1)!]), "do not mutate automatic exclusions");
assert.equal(prepared.length, 0, "excluded cached edges need no bindings");
assert.equal(called.length, 0, "excluded cached edges need no quote RPC");
const mids = effectiveEnumerationMids({ ...prices(3), effectiveMids: invalidated });
for (const id of expectedDisabled) assert(!mids.has(id), "invalid prices cannot enter enumeration");
const ethView = buildBlockScanEthView(edges, mids, 50, true);
assert(ethView.quotes.every(q => !expectedDisabled.has(q.id)), "invalid prices cannot seed ETH signals");
for (const ref of effectiveAmountReferences(invalidated)!.values())
  assert(ref.path.every(row => !expectedDisabled.has(row.edgeId)), "no reference path through excluded prices");

await runtime.currentRuntimeCoordinator.resetDynamicStateForReplay();
resetCounts();
const dirty = await quote(prices(1), {}, backend, { previous: invalidated, quoteGraph: graphAt(4),
  touchedStateKeys: new Set(root.pricingIndex().stateKeyByEdgeKey.values()), disabledEdgeIds: existingDisabled });
for (const id of expectedDisabled) assert.equal(dirty.rows.get(id)!.status, "disabled-for-run");
assert(prepared.length > 0 && called.length > 0, "healthy touched pools still refresh");
assert(prepared.every(id => !expectedDisabled.has(id)), "excluded dirty edges never request bindings");
assert(!called.includes(failed.target.toLowerCase()), "attributed pool never reaches RPC");
reject.clear();
resetCounts();
const fresh = await quote(prices(5), {}, backend);
assert([...fresh.rows.values()].every(row => row.status === "quoted"), "existing new-run clear restores eligibility");
assert(called.includes(failed.target.toLowerCase()));
provider.destroy();
const startupFixture = (concurrency = 2, filterTargetReverts = false) => {
  const cache = new BlockScanSimRejectCache();
  let currentTransport: StrictSimulationTransport | undefined;
  const progress: Readonly<Record<string, number | string>>[] = [];
  const simulation = Object.assign(async (invocation: StartupNodeInvocation) =>
    (currentTransport as unknown as TestTransport).simulateStandalone(invocation), {
    stats: () => ({ requests: 0, retries: 0, simulations: 0, headers: 0, maxCuIn1000Ms: 0 }) });
  const preflight = createBlockScanStartupExecutionPreflight({ executor: factoryInput.executor,
    transactionOrigin: factoryInput.transactionOrigin, simRejects: cache, concurrency,
    simulateStandalone: simulation, filterTargetReverts,
    onProgress: snapshot => progress.push(snapshot) });
  const factory = createBlockScanPriceRuntime({ ...factoryInput, startupExecutionPreflight: preflight,
    isPoolSimRejected: edge => cache.hasPool(edge) });
  return { cache, preflight, progress,
    quote: ((...args: [...Parameters<Effective>]) => {
      currentTransport = args[4];
      return (factory.currentRuntimeCoordinator as unknown as { effectivePricing: Effective }).effectivePricing(...args);
    }) as unknown as (...args: [Parameters<Effective>[0], Parameters<Effective>[1], Parameters<Effective>[2],
      Parameters<Effective>[3], TestTransport]) => ReturnType<Effective> };
};
const startupTrial = startupFixture();
const skippedIds = new Set(ids.slice(-2));
const checkedInputs: bigint[] = [];
let simulationCalls = 0;
type TestTransport = Omit<StrictSimulationTransport, "simulateStandalone"> & {
  simulateStandalone(input: StartupNodeInvocation): ReturnType<StartupNodeSimulation>;
};
const executed = (input: StartupNodeInvocation, kind: "success" | "revert" = "success") => ({ kind,
  returnData: "0x1234", gasUsed: 1n, scriptHash: ethers.keccak256("0x1234"), inputFundingMode: "native-prefix" as const,
  targetBlock: input.source.number + 1, simulationMs: 1, nodeQueueMs: 0,
  receipts: kind === "revert" ? [] : [{ hop: -1, amountIn: input.amount, amountOut: input.amount },
    ...input.legs.map((_, hop) => ({ hop, amountIn: input.amount, amountOut: input.amount }))],
  ...(kind === "revert" ? { failure: { hop: input.legs.length - 1, callTarget: failed.target, reason: "0x" } } : {}) });
const transport: TestTransport = {
  async simulate() { throw new Error("preflight must execute the real runtime program"); },
  async simulatePrefix() { throw new Error("startup must not execute an Exact prefix"); },
  async simulateStandalone(input) {
    simulationCalls++;
    assert.deepEqual(input.source, sourceAt(6));
    assert.deepEqual(input.callerAuthority, { executor: factoryInput.executor, transactionOrigin: factoryInput.transactionOrigin });
    const script = input.legs.map(leg => leg.program).join("");
    if (input.legs.length) assert.equal(input.legs[0]!.tokenIn.toLowerCase(), ADDR.WETH.toLowerCase());
    assert(input.legs.length <= 5, "at most four input hops and one target");
    assert.equal(input.amount, baseline.referenceWethInput, "seed recorded path's WETH amount");
    checkedInputs.push(input.amount);
    assert(!script.includes(edges.at(-1)!.target.slice(2)), "unpriced/disabled pool never simulated");
    return executed(input, input.legs.at(-1)?.program.includes(failed.target.slice(2)) ? "revert" : "success");
  },
};
resetCounts();
const prefiltered = await startupTrial.quote(prices(1), {}, backend, { previous: baseline, quoteGraph: graphAt(6),
  touchedStateKeys: new Set(), disabledEdgeIds: skippedIds }, transport);
assert(simulationCalls > 0 && checkedInputs.every(amount => amount > 0n));
assert.equal(called.length, 0, "preflight observation does not reprice the full table");
assert(edges.every(edge => !startupTrial.cache.hasPool(edge)), "startup revert never writes the live sim reject cache");
for (const id of failedIds) assert.equal(prefiltered.rows.get(id)!.status, "quoted", "startup revert does not invalidate prices");
const observedMids = effectiveEnumerationMids({ ...prices(1), ...graphAt(6), effectiveMids: prefiltered });
for (const id of failedIds) assert(observedMids.has(id), "startup-marked directions remain available to enumeration");
assert.equal(startupTrial.progress.at(-1)!.mode, "observe-only");
assert.equal(startupTrial.progress.at(-1)!.reverted, failedIds.length, "all priced directions retain their own observation");
for (const id of ids.filter(id => !failedIds.includes(id) && !skippedIds.has(id)))
  assert.equal(prefiltered.rows.get(id)!.status, "quoted", "healthy prices survive preflight");
assert(prepared.every(id => !skippedIds.has(id)), "only valid priced directions bind for execution");
const previousCalls = simulationCalls;
resetCounts();
await startupTrial.quote(prices(1), {}, backend, { previous: prefiltered, quoteGraph: graphAt(7),
  touchedStateKeys: new Set(root.pricingIndex().stateKeyByEdgeKey.values()), disabledEdgeIds: skippedIds }, transport);
assert.equal(simulationCalls, previousCalls, "startup preflight runs once, not every block");
assert(called.includes(failed.target.toLowerCase()), "startup-marked pools still refresh when touched");

// A later ordinary sim rejection still owns the existing price/graph filter.
assert(startupTrial.cache.recordPool(failed, revert, p));
resetCounts();
const afterLiveRevert = await startupTrial.quote(prices(1), {}, backend, { previous: prefiltered,
  quoteGraph: graphAt(8), touchedStateKeys: new Set(), disabledEdgeIds: skippedIds }, transport);
for (const id of failedIds) assert.equal(afterLiveRevert.rows.get(id)!.status, "disabled-for-run");
const filteredMids = effectiveEnumerationMids({ ...prices(1), ...graphAt(8), effectiveMids: afterLiveRevert });
for (const id of failedIds) assert(!filteredMids.has(id), "ordinary sim revert still excludes enumeration prices");
assert.equal(called.length, 0, "ordinary sim-rejected pools are not repriced");
assert.equal(simulationCalls, previousCalls, "ordinary sim filtering does not restart startup screening");

const successTransport: TestTransport = { ...transport, async simulateStandalone(input) {
  simulationCalls++; return executed(input);
} };
startupTrial.cache.clear(); startupTrial.preflight.reset();
await startupTrial.quote(prices(1), {}, backend, { previous: baseline, quoteGraph: graphAt(8), touchedStateKeys: new Set() }, successTransport);
assert.equal(simulationCalls, previousCalls + 6, "explicit isolated-run reset checks all valid prices again");
const nextRun = startupFixture();
await nextRun.quote(prices(1), {}, backend, { previous: baseline, quoteGraph: graphAt(9), touchedStateKeys: new Set() }, successTransport);
assert.equal(simulationCalls, previousCalls + 12, "fresh live does not inherit prior execution checks");
for (const fault of [new Error("RPC 429 execution reverted"), new RevmStrictError("execution", "timeout"),
  Object.assign(new RevmStrictError("execution", "observation reverted"),
    { exactPrefixFailure: { phase: "main", kind: "Revert", output: "0x" } })]) {
  const trial = startupFixture();
  const failedTransport: TestTransport = { ...transport, async simulateStandalone() { throw fault; } };
  await assert.rejects(trial.quote(prices(1), {}, backend, { previous: baseline, quoteGraph: graphAt(10),
    touchedStateKeys: new Set() }, failedTransport), error => error === fault);
  assert(edges.every(edge => !trial.cache.hasPool(edge)), "infrastructure or observation failure never excludes a pool");
  const beforeRetry = simulationCalls;
  await trial.quote(prices(1), {}, backend, { previous: baseline, quoteGraph: graphAt(10),
    touchedStateKeys: new Set() }, successTransport);
  assert.equal(simulationCalls, beforeRetry + 6, "interrupted preflight is not considered completed");
}
// No EVM result is not a pool revert. The startup observation cannot
// convert failed simulator input preparation into either rejection or success.
const unavailableTrial = startupFixture(1);
let unavailableCalls = 0;
await assert.rejects(unavailableTrial.quote(prices(1), {}, backend, { previous: baseline, quoteGraph: graphAt(11), touchedStateKeys: new Set() },
  { ...transport, async simulateStandalone() {
    unavailableCalls++; throw new RevmStrictError("observation", "receipt unavailable");
  } }));
assert.equal(unavailableCalls, 1);
assert(edges.every(edge => !unavailableTrial.cache.hasPool(edge)));
assert.equal(unavailableTrial.progress.at(-1)!.phase, "interrupted");
assert.equal(unavailableTrial.progress.at(-1)!.infrastructureFailures, 1);
assert.equal(unavailableTrial.progress.at(-1)!.succeeded, 0);
for (const changeSource of [false, true]) {
  const resumed = startupFixture(1);
  const failure = new Error("retryable interruption");
  let attempts = 0;
  await assert.rejects(resumed.quote(prices(1), {}, backend,
    { previous: baseline, quoteGraph: graphAt(12), touchedStateKeys: new Set() },
    { ...transport, async simulateStandalone(input) {
      if (++attempts === 2) throw failure;
      return executed(input);
    } }), error => error === failure);
  const beforeResume = simulationCalls;
  await resumed.quote(prices(1), {}, backend,
    { previous: baseline, quoteGraph: graphAt(changeSource ? 13 : 12), touchedStateKeys: new Set() }, successTransport);
  assert.equal(simulationCalls - beforeResume, changeSource ? 6 : 5,
    "same source resumes successful scripts; changed source must execute anew");
  assert.equal(resumed.progress.at(-1)!.reusedSuccessful, changeSource ? 0 : 1);
}
// Enabled startup policy uses exactly the same production invalidation callback
// as search-sim reverts, before the first effective publication.
const filteringStartup = startupFixture(2, true);
const startupFiltered = await filteringStartup.quote(prices(1), {}, backend, { previous: baseline,
  quoteGraph: graphAt(6), touchedStateKeys: new Set(), disabledEdgeIds: skippedIds }, transport);
assert(filteringStartup.cache.hasPool(failed));
for (const id of failedIds) {
  assert.equal(startupFiltered.rows.get(id)!.status, "disabled-for-run");
  assert.equal(startupFiltered.rows.get(id)!.effectiveMid, null);
}
const startupMids = effectiveEnumerationMids({ ...prices(6), effectiveMids: startupFiltered });
for (const id of failedIds) assert(!startupMids.has(id));
resetCounts();
await filteringStartup.quote(prices(1), {}, backend, { previous: startupFiltered, quoteGraph: graphAt(7),
  touchedStateKeys: new Set(root.pricingIndex().stateKeyByEdgeKey.values()), disabledEdgeIds: skippedIds }, transport);
assert(!called.includes(failed.target.toLowerCase()), "startup-filtered pool does not update on the next touched block");
assert.equal(filteringStartup.progress.at(-1)!.targetRevertFilterEnabled, 1);

// The real main factory publishes organized prices before invoking its journal
// callback. Prove that those native deltas restore through the real coordinator.
const journalDirectory = await mkdtemp(join(tmpdir(), "main-publication-journal-"));
try {
  const cache = new BlockScanSimRejectCache();
  let writer: LivePricingContinuationWriter | undefined;
  const makeRuntime = (recordPricing = () => {}) => createBlockScanPriceRuntime({ ...factoryInput,
    recordPricing, isPoolSimRejected: edge => cache.hasPool(edge) });
  const producer = makeRuntime(() => writer?.capture());
  const store = new LivePricingContinuationStore(journalDirectory, "a".repeat(64)), events: any[] = [];
  writer = new LivePricingContinuationWriter({ store, coordinator: producer.currentRuntimeCoordinator,
    amounts: producer.blockScanAmountReference, simRejects: cache,
    startup: { exportContinuation: () => ({ version: 1, rows: [] }), takeContinuationDelta: () => ({ reset: false, rows: [] }) },
    onEvent: event => events.push(event) });
  const prepare = (target: ReturnType<typeof makeRuntime>, n: number) => target.currentRuntimeCoordinator.prepareCoarsePricing({
    graph: graphAt(n), pricingCallBackend: backend, deadlineAtMs: Date.now() + 10_000,
    canonicalActivity: { source: sourceAt(n), parentHash: sourceAt(n - 1).hash,
      touchedStateKeys: new Set(root.pricingIndex().stateKeyByEdgeKey.values()), complete: true },
  });
  await prepare(producer, 1); await writer.flush();
  cache.recordPool(failed, revert, p);
  await prepare(producer, 2); await writer.flush();
  cache.record("settled-pass-revert", revert, p); writer.capture(); await writer.flush();
  assert.equal(events.filter(event => event.kind === "baseline").length, 1);
  assert.equal(events.filter(event => event.kind === "delta").length, 2);
  const restored = (await new LivePricingContinuationStore(journalDirectory, store.identity).read())!;
  const consumer = makeRuntime();
  await consumer.currentRuntimeCoordinator.restoreHistoricalBaseline(restored.pricing, {
    graph: graphAt(2), rawGraph: graphAt(1), weth: ADDR.WETH, control: {},
  });
  assert.deepEqual(restored.simRejects, cache.exportContinuation());
  await prepare(producer, 3); await writer.flush();
  await prepare(consumer, 3);
  assert.deepEqual(consumer.currentRuntimeCoordinator.latestPricingSnapshot()!.effectiveMids!.rows,
    producer.currentRuntimeCoordinator.latestPricingSnapshot()!.effectiveMids!.rows);
  assert.equal(events.filter(event => event.phase === "save-failed").length, 0);
} finally { await rm(journalDirectory, { recursive: true, force: true }); }
console.log(JSON.stringify({ test: "pool-effective-production-wiring", verdict: "pass", directions: ids.length,
  checks: ["route-only", "old-price-invalidated", "no-bindings-or-rpc", "no-downstream-prices", "healthy-carry",
    "automatic-exclusion-union", "touched-and-reset", "new-run-clear", "startup-priced-only", "runtime-amountIn",
    "startup-observe-only", "startup-revert-preserves-prices-and-enumeration", "live-sim-revert-still-filters",
    "no-full-table-reprice", "startup-once", "startup-reset", "infrastructure-not-revert",
    "observation-unverified-not-revert", "resume-same-source", "invalidate-resume-on-source-change"] }));
