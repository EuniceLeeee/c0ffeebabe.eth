/** Runtime/coordinator/session/backend integration. All transport is a local HTTP fixture. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { ethers } from "ethers";
import {
  BlockScanRuntimeLoop, type BlockScanRuntimeLoopDependencies, type BlockScanExecutionWorker,
} from "../blockscan-runtime-loop.js";
import { StrictCurrentRuntimeCoordinator, type PrepareStrictRuntimeInput, type StrictSessionRequest } from "../strict-current-runtime-coordinator.js";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../strict-production-runtime-session.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { PinnedRethQuoteBackend } from "../pinned-reth-quote-backend.js";
import { RethTransportScheduler } from "../reth-transport-scheduler.js";
import { buildEffectiveMids } from "../blockscan-effective-mid.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { StrictReadyGraphViewCoordinator } from "../strict-ready-graph-view.js";
import type { ReadyUniverseGeneration } from "../universe-rebuild-checkpoint.js";
import { readBlockTouchedStateKeys, type BlockTouchedProvider } from "../blockscan-touched-state.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../venues/production-family-composition.js";
import { UNIV2_PAIR_INTERFACE } from "../venues/swaps/univ2-family/codec.js";
import {
  runUniv2Lifecycle, UNIV2_FIXTURE_FACTORY, UNIV2_FIXTURE_POOL,
  UNIV2_FIXTURE_TOKEN0, UNIV2_FIXTURE_TOKEN1,
} from "../architecture-migration-fixture-replay.js";
import { StateCallAbortedError, type StateBackend } from "../../shared/state/state-backend.js";
import type { BlockScanStateSnapshot } from "../blockscan-state-coordinator.js";
import type { AdapterRuntimeSnapshot } from "../adapter-runtime-coordinator.js";
import { assertAtomicBlockScanRuntime } from "../detector/blockscan-scanner-production.js";
import { readBlockScanObservedHeader } from "../blockscan-observed-header.js";

const N = 101;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const EXECUTOR = `0x${"64".repeat(20)}`;
const TRANSACTION_ORIGIN = `0x${"ab".repeat(20)}`;
const QUOTER = `0x${"65".repeat(20)}`;
const TAIL = "0xbeef02";
const balance = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
const pool = { pool: UNIV2_FIXTURE_POOL, factory: UNIV2_FIXTURE_FACTORY,
  token0: UNIV2_FIXTURE_TOKEN0, token1: UNIV2_FIXTURE_TOKEN1,
  reserves: { reserve0: 10n ** 20n, reserve1: 2n * 10n ** 20n, blockTimestampLast: 1 } };
const readySource = { number: N - 1, hash: hash(N - 1), generation: 1 };
const ready = await runUniv2Lifecycle(readySource, pool);
const family = catalog.forFamily(ready.familyId);
const view = buildFamilyRouteGraphView({ routes: ready.instances.flatMap(instance =>
  instance.routes.map((route, index) => ({ family, descriptor: instance.descriptor,
    route, handle: instance.routeHandles[index]! }))) });
const root = new StrictProductionRuntimeRoot({ catalog, readySource, readyGraph: view.edges,
  readyInstances: ready.instances, readyFundingAssets: catalog.listAll()
    .filter(f => f.plugin.manifest.domain === "funding")
    .map(f => ({ familyId: f.plugin.manifest.familyId, asset: pool.token0 })) });
const readyEnvelope = Object.freeze({ generation: 1, graphHash: "startup-fixture", catalogHash: "startup-fixture",
  sourceCoverage: [{ familyId: ready.familyId, sourceId: "fixture",
    completeThroughBlock: readySource.number, completeThroughHash: readySource.hash }],
}) as unknown as ReadyUniverseGeneration;
const topologyKey = `strict-ready:${readyEnvelope.generation}:${readyEnvelope.graphHash}`;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < end, `fixture timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
type Wire = { id: number; method: string; params: [{ to: string; data: string; from?: string },
  { blockHash: string; requireCanonical: boolean }] };
type Mode = "normal" | "resume" | "shutdown" | "fatal-source" | "fatal-429" | "revert" |
  "retry-hash" | "retry-height" | "publish-hash" | "resumed-publish-hash" | "canonical-timeout" |
  "ordinary-error" | "fake-deadline" | "empty-budget" | "queued" | "evidence" |
  "initial-header-429" | "retry-header-429" | "publish-header-429" | "late-header-429" | "header-revert" | "header-bare-429" |
  "raw-header-429" | "raw-header-held" | "raw-header-shutdown" | "range";

async function fixture(mode: Mode, exercise: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup(mode);
  try { await exercise(f); assert.deepEqual(f.errors, []); }
  catch (error) { f.restore(); console.error(mode, f.logs.slice(-6).join("\n")); throw error; }
  finally { await f.loop.shutdown(); f.restore(); f.server.closeAllConnections(); await new Promise<void>(resolve => f.server.close(() => resolve())); }
}

async function setup(mode: Mode) {
  const wire: Wire[] = [], errors: unknown[] = [], held: ServerResponse[] = [];
  const headerWire: number[] = [], headerHeld: ServerResponse[] = [];
  const releases: (() => void)[] = [];
  const requests: PrepareStrictRuntimeInput[] = [], sessions: StrictProductionRuntimeSession[] = [];
  const published: BlockScanStateSnapshot[] = [], bridged: BlockScanStateSnapshot[] = [];
  const snapshots: AdapterRuntimeSnapshot[] = [];
  const exacts: { session: StrictProductionRuntimeSession;
    quote: Awaited<ReturnType<StrictProductionRuntimeSession["issueExact"]>> }[] = [];
  const headers: number[] = [], starts: number[] = [], drops: number[] = [], logs: string[] = [];
  const backends = new Set<PinnedRethQuoteBackend>();
  const graphViews = new StrictReadyGraphViewCoordinator({ catalog, ready: readyEnvelope, edges: view.edges });
  const graphInputs: (Parameters<StrictReadyGraphViewCoordinator["build"]>[0])[] = [];
  const activityCalls: { number: number; previousSource?: { number: number; hash: string } }[] = [];
  const activityReads: number[] = [], activityHeaderReads: number[] = [];
  const resets: number[] = [];
  let activeActivityReads = 0, activeSessionPreparations = 0;
  const activityBehavior = { dirty: new Set<number>(), hashes: new Map<number, string>(),
    failAt: null as number | null, traceFailAt: null as number | null,
    headerFailAt: null as number | null, reorgAt: null as number | null };
  const canonicalHash = (number: number) => activityBehavior.hashes.get(number) ?? hash(number);
  const numberForHash = (value: string) => [...activityBehavior.hashes].find(([, candidate]) => candidate === value)?.[0]
    ?? Number(BigInt(value));
  const activityProvider: BlockTouchedProvider = {
    async getLogs(filter) {
      assert("blockHash" in filter);
      const number = numberForHash(filter.blockHash);
      activityReads.push(number);
      if (activityBehavior.failAt === number) throw new Error("fixture activity block unavailable");
      return activityBehavior.dirty.has(number)
        ? [{ address: pool.pool, topics: [], data: "0x", blockHash: canonicalHash(number) }] : [];
    },
    async send(method, params) {
      assert.equal(method, "debug_traceBlockByHash");
      if (activityBehavior.traceFailAt === numberForHash(params[0] as string)) throw new Error("fixture activity trace unavailable");
      return [];
    },
  };
  const oldCall = PinnedRethQuoteBackend.prototype.call;
  PinnedRethQuoteBackend.prototype.call = function (...args) { backends.add(this); return oldCall.apply(this, args); };
  const oldLog = console.log, oldWarn = console.warn;
  console.log = (...args) => { logs.push(args.join(" ")); };
  console.warn = (...args) => { logs.push(args.join(" ")); };
  let tailSeen = 0, activePrepare = 0, maxActivePrepare = 0, forkCount = 0;
  let releaseHeader: (() => void) | undefined;
  const budgetMs = 350;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      try {
        const parsed: Wire | Wire[] = JSON.parse(Buffer.concat(chunks).toString());
        if (!Array.isArray(parsed) && parsed.method === "eth_getBlockByNumber") {
          const payload = parsed as unknown as { id: number; params: [string, boolean] };
          const number = Number(BigInt(payload.params[0]));
          assert.equal(payload.params[1], true);
          headerWire.push(number);
          if (mode === "raw-header-429" && headerWire.length === 1) {
            res.statusCode = 429; res.end("rate limited"); return;
          }
          if (["raw-header-held", "raw-header-shutdown"].includes(mode) && number === N &&
              headerWire.filter(n => n === N).length === 2) {
            headerHeld.push(res); return;
          }
          res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {
            number: payload.params[0], hash: hash(number), parentHash: hash(number - 1),
            timestamp: "0x1", gasUsed: "0x0", gasLimit: "0x100000", transactions: [],
          } }));
          return;
        }
        const batch = Array.isArray(parsed) ? parsed : [parsed];
        wire.push(...batch);
        const replies = batch.map(call => {
          assert.equal(call.method, "eth_call");
          assert.equal(call.params[1].requireCanonical, true);
          assert.match(call.params[1].blockHash, /^0x[0-9a-f]{64}$/);
          const tx = call.params[0];
          let result: string;
          if (tx.to.toLowerCase() === QUOTER) {
            result = "0x1234";
            if (tx.data === TAIL) tailSeen++;
            const error = mode === "fatal-source"
              ? { code: -32000, message: "hash is not currently canonical" }
              : mode === "fatal-429" ? { code: 429, message: "rate limit" }
              : mode === "revert" ? { code: 3, message: "execution reverted: rate limit 429", data: "0xdeadbeef" }
              : null;
            if (error) return { jsonrpc: "2.0", id: call.id, error };
          } else if (tx.data.startsWith(balance.getFunction("balanceOf")!.selector)) {
            result = balance.encodeFunctionResult("balanceOf", [10n ** 24n]);
          } else {
            assert.equal(tx.to.toLowerCase(), pool.pool.toLowerCase());
            assert.equal(tx.data, UNIV2_PAIR_INTERFACE.encodeFunctionData("getReserves"));
            result = UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", Object.values(pool.reserves));
          }
          return { jsonrpc: "2.0", id: call.id, result };
        });
        const stalls = ["resume", "shutdown", "retry-hash", "retry-height", "resumed-publish-hash",
          "canonical-timeout", "evidence", "retry-header-429", "late-header-429"].includes(mode);
        const send = () => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
        };
        if ((stalls && (tailSeen === 1 || mode === "resume" && tailSeen === 2) &&
            batch.some(c => c.params[0].data === TAIL)) || mode === "queued" ||
            mode === "range" && batch.some(c => c.params[1].blockHash === hash(N + 5) &&
              c.params[0].to.toLowerCase() === QUOTER)) {
          held.push(res);
          releases.push(send);
          return;
        }
        send();
      } catch (error) { errors.push(error); res.end("fixture error"); }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const runtimeAbort = new AbortController();
  const sessionFor = async (request: StrictSessionRequest) => {
    const source = request.source;
    const forbidden = async (): Promise<never> => { throw new Error("unexpected direct provider transport"); };
    const runtime = createStrictCentralAdapterRuntime({
      provider: { call: forbidden, getCode: forbidden, getStorage: forbidden }, executor: EXECUTOR,
      transactionOrigin: TRANSACTION_ORIGIN,
      producerCallBackend: request.pricingCallBackend, exactCallBackend: request.exactCallBackend,
      generationFence: { assertCurrent(generation, current) {
        assert.equal(generation, source.generation); assert.deepEqual(current, source);
      } },
    });
    const callerAuthority = runtime.callerAuthority;
    const boundRuntime = { ...runtime, callerAuthority: { bind(input: Parameters<typeof callerAuthority.bind>[0]) {
      const authority = callerAuthority.bind(input);
      assert.equal(authority.transactionOrigin, TRANSACTION_ORIGIN);
      assert.equal(authority.executor, EXECUTOR);
      return authority;
    } } };
    activeSessionPreparations++;
    try {
      const session = await root.createSession({ source, runtime: boundRuntime, fundingAssets: request.fundingAssets,
        kind: request.purpose === "exact-execution" ? "exact" : "pricing", control: request.control,
        touchedPools: request.touchedPools, requiredEdgeIds: request.requiredEdgeIds });
      sessions.push(session);
      return session;
    } finally { activeSessionPreparations--; }
  };
  const coordinator = new StrictCurrentRuntimeCoordinator(sessionFor, () => {},
    publication => published.push(publication.snapshot), async (pricing, control, backend, reuse) => {
      assert(backend);
      const target = reuse?.quoteGraph ?? pricing;
      const source = { number: target.sourceBlock, hash: target.sourceBlockHash, generation: target.generation };
      let session: StrictProductionRuntimeSession | undefined;
      let index = 0;
      return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, control, weth: pool.token0, gasCostWei: null,
        enumerationSpreadBps: 20, concurrency: 1, previous: reuse?.previous, touchedStateKeys: reuse?.touchedStateKeys,
        prepareQuote: async requiredEdgeIds => {
          session = await sessionFor({ purpose: "exact-execution", source, fundingAssets: [], control,
            exactCallBackend: backend, requiredEdgeIds });
        },
        quote: async request => {
          assert(session, "effective quote requires the current source's lazy Exact session");
          // Synthetic expensive remote step plus real Family decode/authority.
          // Deliberately omit controls here to exercise the attempt call facade.
          await backend.call({ to: QUOTER, data: ++index === 1 ? "0xbeef01" : TAIL, from: EXECUTOR });
          const quote = await session.issueExact({ ...request, requireChainAmountQuote: false,
            executor: EXECUTOR, runtimeEvidence: [] });
          assert("amountIn" in quote);
          exacts.push({ session, quote });
          return quote;
        } });
    });
  const realReset = coordinator.resetDynamicStateForReplay.bind(coordinator);
  coordinator.resetDynamicStateForReplay = async () => {
    assert.equal(activeActivityReads, 0, "activity must settle before a reorg reset");
    assert.equal(activeSessionPreparations, 0, "Funding and pricing sessions must settle before a reorg reset");
    assert.equal(activePrepare, 0, "pricing preparation must settle before a reorg reset");
    for (const backend of backends) assertIdle(backend);
    resets.push(starts.at(-1)!);
    await realReset();
  };
  const realPrepare = coordinator.prepare.bind(coordinator);
  coordinator.prepare = async input => {
    requests.push(input);
    activePrepare++; maxActivePrepare = Math.max(maxActivePrepare, activePrepare);
    try {
      if (requests.length > 1) {
        const previous = requests.at(-2)!;
        if (!published.some(snapshot => snapshot.generation === previous.graph.generation &&
            snapshot.sourceBlock === previous.graph.sourceBlock)) {
          assert(previous.signal!.aborted, "retired unpublished attempt caller authority remains open");
        }
        // A new ordinary head already starts Funding speculatively. Only the
        // retained/previous backend must have drained at this boundary.
        for (const backend of backends) if (backend !== input.pricingCallBackend) assertIdle(backend);
      }
      if (mode === "ordinary-error") throw new Error("ordinary fixture failure");
      if (mode === "fake-deadline") throw new StateCallAbortedError("not the attempt cutoff", "deadline");
      if (mode === "evidence" && requests.length > 1) {
        assert.equal(input.validateBeforePublish, undefined, "evidence pass entered periodic resume");
        throw new Error("evidence successor observed");
      }
      if (mode === "queued") {
        const pending = Array.from({ length: 641 }, (_, i) => input.pricingCallBackend!.call({
          to: QUOTER, data: `0x${i.toString(16).padStart(8, "0")}`,
        }));
        await Promise.allSettled(pending);
        throw input.signal?.reason ?? new Error("queued fixture ended");
      }
      const result = await realPrepare(input);
      if (result.status !== "incomplete") snapshots.push(result.snapshot);
      return result;
    } finally { activePrepare--; }
  };
  const worker = { state: { async forkAt() { forkCount++; }, provider: {}, stop() {},
    async stopAndWait() {} }, solver: {}, simulator: {} } as unknown as BlockScanExecutionWorker;
  const planner = { setFlashLiquidity() {} } as unknown as ReturnType<BlockScanRuntimeLoopDependencies["blockScanPlanner"]>;
  const deps: BlockScanRuntimeLoopDependencies = {
    enabled: true, runtimeAbort, rpcUrl: `http://127.0.0.1:${address.port}`,
    executionWorkers: [worker], finalSimulationWorkers: [worker],
    sharedPlanner: planner!, backrunStatePublisher: { publish: snapshot => bridged.push(snapshot) },
    frozenTopology: { topologyKey, async observeHeader(number, control) {
      headers.push(number);
      if (activityBehavior.headerFailAt === number) throw new Error("fixture canonical header unavailable");
      if (mode.startsWith("raw-header-")) {
        assert(control?.signal, "production startup must supply physical cancellation");
        return readBlockScanObservedHeader(`http://127.0.0.1:${address.port}`, 1n, number, control);
      }
      const count = headers.filter(n => n === N).length;
      if (mode === "initial-header-429" ||
          ["retry-header-429", "publish-header-429"].includes(mode) && count === 2) {
        throw new Error("header provider failed", { cause: Object.assign(new Error("HTTP 429"), { status: 429 }) });
      }
      if (mode === "header-revert" && count === 2) {
        throw Object.assign(new Error("execution reverted: HTTP 429 rate limit"), { code: -32000, data: "0xdeadbeef" });
      }
      if (mode === "header-bare-429" && count === 2) throw new Error("block 429 not found");
      if (["canonical-timeout", "late-header-429"].includes(mode) && count === 2) {
        assert(control?.signal, "startup header must receive transport cancellation");
        assert(control.deadlineAtMs! > Date.now());
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(control.signal!.reason);
          releaseHeader = () => { control.signal!.removeEventListener("abort", abort); resolve(); };
          // The late-error case deliberately settles after retirement, testing
          // that the loop JOINs it, not merely that it observes a late rejection.
          if (mode === "canonical-timeout") control.signal!.addEventListener("abort", abort, { once: true });
        });
        if (mode === "late-header-429") throw Object.assign(new Error("late HTTP 429"), { status: 429 });
      }
      const mismatch = (mode === "retry-hash" || mode === "publish-hash") && count === 2 ||
        mode === "resumed-publish-hash" && count === 3;
      return { number: mode === "retry-height" && count === 2 ? number + 1 : number,
        hash: mismatch ? hash(999) : canonicalHash(number), parentHash: canonicalHash(number - 1) };
    } },
    blind: { enabled: false, activeSource: () => null, preparedBase: () => null,
      preparedArtifacts: () => null, dynamicResetNonce: () => null },
    startupWarmEnabled: true, startupWarmBudgetMs: budgetMs, runtimePublicationReserveMs: mode === "empty-budget" ? 500 : 20,
    passBudgetMs: budgetMs, largeGraphPassBudgetMs: budgetMs, largeGraphEdgeThreshold: 1000,
    refineCandidates: 5, solveReserveMs: 20, solverGridHalfWidth: 1, solverGssMaxTries: 1,
    solverQuoteConcurrency: 1, exactConcurrency: 1, exactProbeTimeoutMs: 100,
    executorAddress: EXECUTOR, currentHeadEvidenceFamilyForEdge: () => null,
    currentHeadEvidenceScopeKeyForEdge: () => null, currentHeadEvidenceScopeKeys: () => [],
    // Global abort must work without a main/supervisor updating this flag.
    isCurrentHeadEvidenceFamily: () => true, isShuttingDown: () => false,
    blockScanGraph: () => view.edges, blockScanPlanner: () => planner,
    currentRuntimeCoordinator: () => coordinator, flashTokens: () => [pool.token0],
    blockScanConfig: { maxHops: 3, minSpreadBps: 20, maxCandidates: 5, budgetMs: 350, pricedTokens: new Map() },
    buildGraphView: input => { graphInputs.push(input); return graphViews.build(input); },
    readBlockHash: async (_provider, number) => mode === "range" ? canonicalHash(number) : hash(starts.at(-1)!),
    readBlockSwapTouched: async (number, header, range) => {
      activityCalls.push({ number, ...(range === undefined ? {} : { previousSource: range.previousSource }) });
      if (mode !== "range") return new Set([pool.pool]);
      assert(header);
      activeActivityReads++;
      try {
        return await readBlockTouchedStateKeys(activityProvider, number, QUOTER,
          { hash: header.hash, parentHash: header.parentHash, transactionHashes: [] },
          range === undefined ? undefined : { ...range, readHeader: async block => {
            activityHeaderReads.push(block);
            return { hash: canonicalHash(block), parentHash: activityBehavior.reorgAt === block ? hash(999) : canonicalHash(block - 1),
              transactionHashes: [] };
          } });
      } finally { activeActivityReads--; }
    },
    formatRouteKey: () => "unused", formatRing: () => "unused", submitAtomic: async () => { throw new Error("unexpected submission"); },
    routeTelemetry: { beginPass(number) { starts.push(number); return null; },
      recordNotStarted: input => drops.push(input.sourceBlock) },
  };
  const loop = new BlockScanRuntimeLoop(deps);
  return { loop, coordinator, runtimeAbort, wire, requests, sessions, published, bridged, snapshots, exacts, headers, starts, drops,
    held, headerWire, headerHeld, releases, errors, backends, logs, server, deps,
    graphInputs, activityCalls, activityReads, activityHeaderReads, activityBehavior, resets,
    get maxActivePrepare() { return maxActivePrepare; },
    get forkCount() { return forkCount; }, releaseHeader: () => releaseHeader?.(),
    restore() { PinnedRethQuoteBackend.prototype.call = oldCall; console.log = oldLog; console.warn = oldWarn; } };
}

function assertIdle(backend: PinnedRethQuoteBackend): void {
  const s = backend.stats();
  assert.deepEqual([s.pendingItems, s.liveItems, s.inFlightBatches, s.activeTransports], [0, 0, 0, 0]);
  assert.equal(s.maxBatchSize, 64); assert.equal(s.maxConcurrentBatches, 8);
  assert.equal(s.allowSingleCallFallback, false); assert.equal(s.persistentCacheConfigured, false);
}
const observe = () => ({ sourceHeadSeenAtMs: Date.now(), sourceHeadSeenAtMonotonicMs: performance.now() });
const values = (snapshot: BlockScanStateSnapshot) => ({ mids: [...snapshot.mids],
  rows: [...snapshot.effectiveMids!.rows].map(([key, row]) => [key, row.amountIn, row.amountOut, row.status]) });

function attachTransport(f: Awaited<ReturnType<typeof setup>>) {
  const scheduler = new RethTransportScheduler({ capacity: 8, producerReserved: 4, retryDelayMs: 1 });
  let transitions = 0;
  const completeStartup = () => {
    transitions++;
    for (const backend of f.backends) assertIdle(backend);
    assert.equal(scheduler.snapshot().activeTotal, 0, "startup physical transport must drain before restoration");
    return scheduler.completeStartup();
  };
  Object.assign(f.deps, { rethTransportScheduler: { run: scheduler.run.bind(scheduler), completeStartup } });
  return { scheduler, get transitions() { return transitions; } };
}

await fixture("normal", async f => {
  const transport = attachTransport(f);
  const load = await transport.scheduler.run("producer-bulk", new AbortController().signal, async lease => lease.load!);
  load.retry(new StateCallAbortedError("startup socket timeout", "timeout"), [{}], load.limits(128, 4));
  let closing = false, release!: () => void;
  const drained = new Promise<void>(resolve => { release = resolve; });
  const sourceSimulationFactory: BlockScanRuntimeLoopDependencies["sourceSimulationFactory"] = () => ({
    transport: { async simulate() { return { data: "0x" }; } },
    async closeAndDrain() { closing = true; await drained; },
  });
  Object.assign(f.deps, { sourceSimulationFactory });
  const pass = f.loop.runHead(N, observe());
  try {
    await until(() => closing, "startup physical cleanup held");
    assert.equal(f.published.length, 1);
    assert.equal(transport.transitions, 0, "publication alone must not restore startup limits");
    assert.equal(load.limits(128, 4).concurrency, 2);
  } finally { release(); await pass; }
  assert.equal(transport.transitions, 1);
  assert.deepEqual(load.limits(128, 4), { version: 2, batchSize: 128, concurrency: 4 });
  load.retry(Object.assign(new Error("steady 429"), { code: 429 }), [{}], load.limits(128, 4));
  // This preparation fixture intentionally has no downstream Exact session.
  await assert.rejects(f.loop.runHead(N + 1, observe()), /requires a strict current-source session/);
  assert.equal(f.published.at(-1)!.sourceBlock, N + 1);
  assert.equal(transport.transitions, 1, "ordinary heads must not reset shared limits");
  assert.equal(load.limits(128, 4).batchSize, 64);
  assert.equal(load.limits(128, 4).concurrency, 2);
});

for (const mode of ["ordinary-error", "publish-hash"] as const) {
  await fixture(mode, async f => {
    const transport = attachTransport(f);
    await assert.rejects(f.loop.runHead(N, observe()));
    assert.equal(transport.transitions, 0, "failed startup must retain its current transport tier");
  });
}
for (const cleanup of ["failed", "shutdown"] as const) {
  await fixture("normal", async f => {
    const transport = attachTransport(f);
    const sourceSimulationFactory: BlockScanRuntimeLoopDependencies["sourceSimulationFactory"] = () => ({
      transport: { async simulate() { return { data: "0x" }; } },
      async closeAndDrain() {
        if (cleanup === "failed") throw new Error("fixture cleanup failure");
        f.runtimeAbort.abort(new Error("fixture shutdown during startup cleanup"));
      },
    });
    Object.assign(f.deps, { sourceSimulationFactory });
    if (cleanup === "failed") await assert.rejects(f.loop.runHead(N, observe()), /fixture cleanup failure/);
    else await f.loop.runHead(N, observe());
    assert.equal(f.published.length, 1);
    assert.equal(transport.transitions, 0, "failed/shutdown cleanup must not restore limits");
  });
}
let baseline: ReturnType<typeof values>;
await fixture("normal", async f => {
  await f.loop.runHead(N, observe());
  assert.equal(f.published.length, 1); assert.equal(f.bridged.length, 1);
  assert.equal(f.loop.isStartupWarmPending(), false); assert.equal(f.forkCount, 0);
  assert.deepEqual(f.headers, [N, N]); baseline = values(f.published[0]!);
  assert(f.requests[0]!.signal!.aborted);
  assert(f.snapshots[0]!.funding.sources.size > 0, "exercise nonempty Funding after attempt retirement");
  assertAtomicBlockScanRuntime(f.snapshots[0]!);
  for (const backend of f.backends) assertIdle(backend);
});
await fixture("resume", async f => {
  const transport = attachTransport(f);
  f.loop.schedule(N);
  await until(() => f.held.length === 1, "first attempt effective tail");
  assert.equal(f.published.length, 0); assert.equal(f.coordinator.latestPricingSnapshot(), null);
  f.loop.schedule(N + 1);
  await until(() => f.held.length === 2, "resumed attempt effective tail");
  assert.equal(transport.transitions, 0, "startup retries must not reset transport limits");
  f.loop.schedule(N + 2);
  f.releases[1]!();
  await until(() => f.starts.includes(N + 2) && f.published.length === 2, "warm then newest pending head");
  assert.equal(transport.transitions, 1, "restore exactly once before the queued steady head");
  assert.deepEqual(f.starts, [N, N + 2]); assert(f.drops.includes(N + 1));
  assert.deepEqual(f.requests.map(r => r.graph.sourceBlock), [N, N, N + 2]);
  assert.deepEqual(f.requests.map(r => r.graph.generation), [1, 2, 3]);
  assert.notEqual(f.requests[0]!.graph.edges[0], view.edges[0], "the strict Graph view clones its source shell");
  assert(f.graphInputs.every(input => input.edges.every((edge, index) => edge === view.edges[index])),
    "startup retries must return original Ready edges to the real Graph coordinator");
  assert.equal(f.maxActivePrepare, 1); assert.equal(f.requests[0]!.signal!.aborted, true);
  assert.notEqual(f.requests[0]!.pricingCallBackend, f.requests[1]!.pricingCallBackend);
  assert.equal(f.requests[2]!.validateBeforePublish, undefined, "hot path must keep ordinary publication");
  assert.deepEqual(values(f.published[0]!), baseline!);
  assert.equal(f.published[0]!.generation, 2);
  const warmWire = f.wire.filter(c => c.params[1].blockHash === hash(N));
  assert.equal(warmWire.length, 8, "three raw + two Funding + two effective reads + only the interrupted tail repeated");
  assert.equal(warmWire.filter(c => c.params[0].data === "0xbeef01").length, 1);
  assert.equal(warmWire.filter(c => c.params[0].data === TAIL).length, 2);
  const oldExact = f.sessions.find(s => s.source.generation === 1 && s.creationTiming.refreshedInstanceCount === 0)!;
  const freshExact = f.sessions.find(s => s.source.generation === 2 && s.creationTiming.refreshedInstanceCount === 0)!;
  assert(oldExact && freshExact); assert.notEqual(oldExact, freshExact);
  const oldQuote = f.exacts.find(e => e.session === oldExact)!.quote;
  const freshQuote = f.exacts.find(e => e.session === freshExact)!.quote;
  assert.throws(() => freshExact.buildExecution({ edge: freshExact.edges[0]!, exact: oldQuote,
    minAmountOut: 1n, executor: EXECUTOR }), /same session-issued/);
  assert.equal(freshExact.buildExecution({ edge: freshExact.edges[0]!, exact: freshQuote,
    minAmountOut: 1n, executor: EXECUTOR }).status, "resolved");
  assertAtomicBlockScanRuntime(f.snapshots[0]!);
  for (const request of f.requests.slice(0, 2)) {
    assert.equal(request.deadlineAtMs - request.preparationSettleDeadlineAtMs!, 20);
    assert.equal(request.pricingFamilySettleDeadlineAtMs, request.preparationSettleDeadlineAtMs);
    assert.deepEqual(request.canonicalActivity!.source, { number: N, hash: hash(N), generation: request.graph.generation });
  }
  const resumeLog = f.logs.find(s => s.startsWith("[searcher/blockscan-startup-warm-resume]"))!;
  assert(JSON.parse(resumeLog.slice(resumeLog.indexOf("{"))).processMemory.heapUsed > 0);
  assert.equal(f.sessions.filter(s => s.source.number === N).length, 4, "raw and exact sessions must both be recreated");
  const before = f.wire.length;
  await assert.rejects(f.requests[0]!.pricingCallBackend!.call({ to: QUOTER, data: "0xbeef01" }));
  await turn(); assert.equal(f.wire.length, before);
  assert(f.held[0]!.destroyed, "attempt drain left its HTTP envelope open");
});

for (const mode of ["retry-hash", "retry-height", "publish-hash", "resumed-publish-hash", "canonical-timeout"] as const) {
  await fixture(mode, async f => {
    await assert.rejects(f.loop.runHead(N, observe()));
    assert.equal(f.published.length, 0); assert.equal(f.bridged.length, 0);
    assert.equal(f.coordinator.latestPricingSnapshot(), null); assert(f.loop.isStartupWarmPending());
    assert.equal(f.requests.length, mode === "resumed-publish-hash" ? 2 : 1);
    const count = f.wire.length; f.releaseHeader(); await turn();
    for (const backend of f.backends) {
      assertIdle(backend);
      await assert.rejects(backend.call({ to: QUOTER, data: "0xbeef01" }));
    }
    assert.equal(f.wire.length, count);
  });
}
for (const mode of ["fatal-source", "fatal-429"] as const) {
  await fixture(mode, async f => {
    // Exercise bounded physical 429 retries within the 350ms fixture budget;
    // the production 1s backoff would outlast each synthetic warm attempt.
    const transport = mode === "fatal-429" ? attachTransport(f) : null;
    await assert.rejects(f.loop.runHead(N, observe()));
    if (transport) assert.equal(transport.transitions, 0);
    assert.equal(f.requests.length, 1); assert.equal(f.published.length, 0);
    assert.equal(f.runtimeAbort.signal.aborted, mode === "fatal-429");
    const markers = f.logs.filter(s => s.startsWith("[pinned-reth-quote-backend]") &&
      s.includes(mode === "fatal-429" ? "HTTP 429" : "source-unavailable"));
    assert.equal(markers.length, 1);
    for (const backend of f.backends) assertIdle(backend);
  });
}
for (const mode of ["initial-header-429", "retry-header-429", "publish-header-429", "header-revert", "header-bare-429"] as const) {
  await fixture(mode, async f => {
    const throttle = mode.endsWith("header-429");
    await assert.rejects(f.loop.runHead(N, observe()));
    assert.equal(f.runtimeAbort.signal.aborted, throttle);
    assert.equal(f.published.length, 0);
    assert.equal(f.requests.length, mode === "initial-header-429" ? 0 : 1);
    const markers = f.logs.filter(s => s.startsWith("[searcher/blockscan-startup-warm] HTTP 429"));
    assert.equal(markers.length, throttle ? 1 : 0);
    if (throttle) {
      const before = f.wire.length, headerCount = f.headers.length;
      f.loop.schedule(N + 1); await turn();
      assert.equal(f.wire.length, before); assert.equal(f.headers.length, headerCount);
    }
    for (const backend of f.backends) assertIdle(backend);
  });
}
await fixture("late-header-429", async f => {
  let ended = false;
  const pending = f.loop.runHead(N, observe()).finally(() => { ended = true; });
  const rejected = assert.rejects(pending);
  await until(() => f.headers.length === 2, "late header pending");
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(ended, false, "retired header must be joined before the pass finishes");
  assert.equal(f.runtimeAbort.signal.aborted, false, "timeout alone is not throttle evidence");
  const count = f.wire.length, headerCount = f.headers.length;
  f.releaseHeader(); await rejected; await turn();
  assert.equal(f.runtimeAbort.signal.aborted, true, "late underlying header throttle must still stop the runtime");
  f.loop.schedule(N + 1); await turn();
  assert.equal(f.wire.length, count); assert.equal(f.headers.length, headerCount);
  assert.equal(f.published.length, 0);
});
await fixture("raw-header-429", async f => {
  await assert.rejects(f.loop.runHead(N, observe()));
  assert.equal(f.runtimeAbort.signal.aborted, true);
  assert.deepEqual(f.headerWire, [N], "first HTTP 429 must not be retried into a 200");
  assert.equal(f.wire.length, 0); assert.equal(f.published.length, 0);
  f.loop.schedule(N + 1); await turn();
  assert.deepEqual(f.headerWire, [N]);
});
for (const mode of ["raw-header-held", "raw-header-shutdown"] as const) {
  await fixture(mode, async f => {
    f.loop.schedule(N);
    await until(() => f.headerHeld.length === 1, "real HTTP publication header held");
    assert.equal(f.published.length, 0);
    if (mode === "raw-header-shutdown") {
      f.loop.schedule(N + 1);
      await f.loop.shutdown();
      assert.deepEqual(f.starts, [N]);
    } else {
      f.loop.schedule(N + 1);
      await until(() => f.published.length === 1, "successor after timed-out header retirement");
      assert.equal(f.published[0]!.sourceBlock, N + 1);
      assert.deepEqual(f.starts, [N, N + 1]);
    }
    await until(() => f.headerHeld[0]!.destroyed, "retired local HTTP header socket closes");
    assert(!f.headerHeld[0]!.writableFinished, "no response was needed to retire header I/O");
    assert(f.published.every(snapshot => snapshot.sourceBlock !== N));
  });
}
await fixture("revert", async f => {
  await f.loop.runHead(N, observe());
  assert.equal(f.runtimeAbort.signal.aborted, false); assert.equal(f.requests.length, 1);
  assert.equal(f.published.length, 1);
  assert([...f.published[0]!.effectiveMids!.rows.values()].every(row => row.status === "quote-failed"));
});
for (const mode of ["shutdown", "queued"] as const) {
  await fixture(mode, async f => {
    f.loop.schedule(N);
    await until(() => f.held.length === (mode === "queued" ? 8 : 1), "outstanding work");
    f.loop.schedule(N + 1);
    const before = f.wire.length;
    await f.loop.shutdown(); await turn();
    assert.equal(f.requests.length, 1); assert.equal(f.published.length, 0);
    assert.equal(f.wire.length, before); assert.deepEqual(f.starts, [N]);
    if (mode === "queued") assert.equal(before, 512, "queued ninth and later batches must never be sent");
    for (const backend of f.backends) { assertIdle(backend); await assert.rejects(backend.call({ to: QUOTER, data: TAIL })); }
  });
}
for (const mode of ["ordinary-error", "fake-deadline", "empty-budget"] as const) {
  await fixture(mode, async f => {
    await assert.rejects(f.loop.runHead(N, observe()));
    assert.equal(f.requests.length, 1, "non-deadline/zero-window failure must not tight-loop");
    assert.equal(f.published.length, 0);
  });
}

await fixture("evidence", async f => {
  f.loop.schedule(N);
  await until(() => f.held.length === 1, "evidence interrupts warm work");
  const txHash = hash(500), payload = "0x1234", payloadHash = ethers.keccak256(payload);
  const evidenceHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "bytes32", "uint256", "bytes32", "bytes32"], ["univ4", txHash, N, hash(N), payloadHash]));
  assert(f.loop.schedulePendingEvidence({ txHash, head: { number: N, hash: hash(N) },
    observedAtMs: Date.now(), observedAtMonotonicMs: performance.now(),
    evidenceReadyAtMs: Date.now(), evidenceReadyAtMonotonicMs: performance.now(),
    evidence: [{ familyId: "univ4", txHash, headBlockNumber: N, headHash: hash(N),
      canonicalPayload: payload, payloadHash, evidenceHash }] }));
  await until(() => f.requests.length === 2, "existing evidence scheduler successor");
  await f.loop.shutdown();
  assert.deepEqual(f.starts, [N, N]); assert.equal(f.requests[1]!.validateBeforePublish, undefined);
  assert.equal(f.published.length, 0); assert.equal(f.logs.some(s => s.startsWith("[searcher/blockscan-startup-warm-resume]")), false);
});

await fixture("range", async f => {
  await f.loop.runHead(N, observe());
  const warm = f.published[0]!;
  const warmQuotes = f.exacts.length;
  assert.equal(warmQuotes, 2);
  // Downstream execution is intentionally absent from this preparation fixture.
  await assert.rejects(f.loop.runHead(N + 3, observe()), /requires a strict current-source session/);
  const clean = f.published.at(-1)!;
  assert.equal(clean.sourceBlock, N + 3);
  assert.deepEqual(f.activityCalls, [{ number: N },
    { number: N + 3, previousSource: { number: N, hash: hash(N) } }]);
  assert.deepEqual(f.activityReads, [N, N + 1, N + 2, N + 3], "catch-up must inspect every intervening block");
  assert.deepEqual(f.activityHeaderReads, [N + 1, N + 2]);
  assert.equal(f.exacts.length, warmQuotes, "an all-clean multi-block range must carry without new effective calls");
  assert.equal(clean.effectiveMids!.rows, warm.effectiveMids!.rows);
  assert.equal(clean.mids, warm.mids);
  assert.deepEqual(clean.rawMidSource, { number: N, hash: hash(N), generation: warm.generation });
  assert.equal(clean.coverage.carriedEdgeKeys?.length, 2);

  // The only mutation is in an intermediate block, never the latest target.
  f.activityBehavior.dirty.add(N + 4);
  f.loop.schedule(N + 5);
  await until(() => f.held.length === 1, "dirty effective preparation held after complete range");
  assert.equal(f.coordinator.latestPricingSnapshot(), clean);
  f.loop.schedule(N + 7);
  await until(() => f.published.at(-1)?.sourceBlock === N + 7, "cancelled preparation followed by range catch-up");
  assert.deepEqual(f.published.map(snapshot => snapshot.sourceBlock), [N, N + 3, N + 7],
    "cancelled source must not move the published pricing anchor");
  assert.deepEqual(f.activityCalls.slice(-2), [N + 5, N + 7].map(number => ({ number,
    previousSource: { number: N + 3, hash: hash(N + 3) } })));
  for (const request of f.requests.filter(request => request.graph.sourceBlock >= N + 5)) {
    assert.deepEqual(request.canonicalActivity!.previousSource, { number: N + 3, hash: hash(N + 3) });
    assert(request.canonicalActivity!.touchedStateKeys.has(pool.pool.toLowerCase()),
      "the cancelled predecessor's intermediate mutation remains in the completed union");
  }
  assert.deepEqual(f.activityReads, Array.from({ length: 8 }, (_, index) => N + index),
    "completed block activity may be reused, without dropping an intermediate mutation");
  assert.deepEqual(f.activityHeaderReads, [N + 1, N + 2, N + 4, N + 6]);
  const refreshed = f.published.at(-1)!;
  assert.equal(refreshed.mids, warm.mids);
  assert.deepEqual(refreshed.rawMidSource, warm.rawMidSource);
  assert.equal(refreshed.coverage.refreshedEdgeKeys?.length, 2);
  assert.equal(refreshed.coverage.carriedEdgeKeys?.length, 0);
  assert.equal(f.exacts.length, warmQuotes + 2, "dirty directions are quoted only by the successful current attempt");
  for (const row of refreshed.effectiveMids!.rows.values()) assert.equal(row.quotedAt!.number, N + 7);
  assert(f.sessions.filter(session => session.source.number > N)
    .every(session => session.creationTiming.refreshedInstanceCount === 0), "catch-up never refreshes raw sizing");
  await until(() => f.held[0]!.destroyed, "cancelled effective HTTP request drained");
  assert.deepEqual(f.resets, [], "ordinary supersession must not reset the published pricing anchor");
});

for (const failure of ["read", "trace", "reorg"] as const) {
  await fixture("range", async f => {
    await f.loop.runHead(N, observe());
    const warm = f.published[0]!;
    if (failure === "read") f.activityBehavior.failAt = N + 2;
    else if (failure === "trace") f.activityBehavior.traceFailAt = N + 2;
    else f.activityBehavior.reorgAt = N + 2;
    await assert.rejects(f.loop.runHead(N + 3, observe()), failure === "read"
      ? /fixture activity block unavailable/ : failure === "trace"
        ? /fixture activity trace unavailable/ : /activity range canonical hash chain mismatch/);
    assert.deepEqual(f.activityCalls.at(-1), { number: N + 3, previousSource: { number: N, hash: hash(N) } });
    assert.equal(f.published.length, 1);
    assert.equal(f.coordinator.latestPricingSnapshot(), warm);
    assert.equal(f.requests.length, 1, "failed or reorganized ranges cannot issue a pricing publication proof");
    assert.deepEqual(f.resets, [], "ordinary reads or an unchanged published base cannot authorize reset");
    assert.equal(f.loop.isStartupWarmPending(), false);
    assert.equal(f.headers.filter(number => number === N).length, failure === "reorg" ? 3 : 2,
      "only a typed range invalidation may independently recheck the published source");
    f.activityBehavior.failAt = null; f.activityBehavior.traceFailAt = null; f.activityBehavior.reorgAt = null;
    await assert.rejects(f.loop.runHead(N + 4, observe()), /requires a strict current-source session/);
    assert.equal(f.published.at(-1)!.sourceBlock, N + 4);
    assert.equal(f.published.at(-1)!.mids, warm.mids, "read recovery retains the valid frozen raw basis");
    assert.equal(f.exacts.length, 2, "ordinary read recovery still carries clean effective rows");
    assert.deepEqual(f.resets, []);
  });
}

await fixture("range", async f => {
  await f.loop.runHead(N, observe());
  const warm = f.published[0]!;
  for (let number = N; number <= N + 3; number++) f.activityBehavior.hashes.set(number, hash(number + 1000));
  let closing = false, release!: () => void;
  const drained = new Promise<void>(resolve => { release = resolve; });
  const sourceSimulationFactory: BlockScanRuntimeLoopDependencies["sourceSimulationFactory"] = () => ({
    transport: { async simulate() { return { data: "0x" }; } },
    async closeAndDrain() { closing = true; await drained; },
  });
  Object.assign(f.deps, { sourceSimulationFactory });
  const failure = assert.rejects(f.loop.runHead(N + 1, observe()), /activity range canonical hash chain mismatch/);
  try {
    await until(() => closing, "reorg pass physical cleanup held");
    assert.equal(f.coordinator.latestPricingSnapshot(), warm, "old publication remains until all pass resources drain");
    assert.deepEqual(f.resets, [], "a confirmed reorg cannot reset before the drain boundary");
    assert.equal(f.published.length, 1, "the invalidated pass cannot publish even after confirming a reorg");
  } finally { release(); await failure; }
  assert.equal(f.headers.filter(number => number === N).length, 3, "recovery independently rechecks the published base");
  assert.deepEqual(f.resets, [N + 1]);
  assert.equal(f.coordinator.latestPricingSnapshot(), null);
  assert.equal(f.loop.isStartupWarmPending(), true);
  assert.equal(f.requests.length, 1, "invalid activity cannot enter pricing preparation");

  await f.loop.runHead(N + 2, observe());
  const recovered = f.published.at(-1)!;
  assert.deepEqual(f.published.map(snapshot => snapshot.sourceBlock), [N, N + 2]);
  assert.equal(recovered.sourceBlockHash, hash(N + 1002));
  assert.deepEqual(f.activityCalls.at(-1), { number: N + 2 }, "the successor must bootstrap without the orphaned range anchor");
  assert.equal(f.requests.at(-1)!.cacheMode, "warm");
  assert.equal(f.requests.at(-1)!.canonicalActivity!.previousSource, undefined);
  assert.notEqual(recovered.mids, warm.mids, "reorg recovery must replace the orphaned raw sizing basis");
  assert.deepEqual(recovered.rawMidSource, { number: N + 2, hash: hash(N + 1002), generation: recovered.generation });
  assert(f.sessions.some(session => session.source.number === N + 2 && session.creationTiming.refreshedInstanceCount > 0));
  assert.equal(f.exacts.length, 4, "bootstrap requotes both directions instead of carrying orphaned effective rows");
  assert(recovered.effectiveMids!.complete);
  for (const row of recovered.effectiveMids!.rows.values()) assert.deepEqual(row.quotedAt, recovered.effectiveMids!.source);
  assert.equal(f.loop.isStartupWarmPending(), false);

  await assert.rejects(f.loop.runHead(N + 3, observe()), /requires a strict current-source session/);
  assert.equal(f.published.at(-1)!.mids, recovered.mids);
  assert.equal(f.published.at(-1)!.effectiveMids!.rows, recovered.effectiveMids!.rows);
  assert.deepEqual(f.activityCalls.at(-1), { number: N + 3, previousSource: { number: N + 2, hash: hash(N + 1002) } });
  assert.equal(f.exacts.length, 4);
  assert.deepEqual(f.resets, [N + 1], "the repaired chain resumes ordinary clean carry without repeated resets");
});

await fixture("range", async f => {
  await f.loop.runHead(N, observe());
  const warm = f.published[0]!;
  for (let number = N; number <= N + 1; number++) f.activityBehavior.hashes.set(number, hash(number + 1000));
  f.activityBehavior.headerFailAt = N;
  await assert.rejects(f.loop.runHead(N + 1, observe()));
  assert.equal(f.headers.filter(number => number === N).length, 3, "a failed independent base recheck was attempted");
  assert.equal(f.coordinator.latestPricingSnapshot(), warm, "an unavailable recheck is not proof of a reorg");
  assert.deepEqual(f.resets, []);
  assert.equal(f.loop.isStartupWarmPending(), false);
  assert.equal(f.requests.length, 1);
});

await fixture("range", async f => {
  await f.loop.runHead(N, observe());
  const warm = f.published[0]!;
  for (let number = N; number <= N + 1; number++) f.activityBehavior.hashes.set(number, hash(number + 1000));
  let rangeFailed = false, release!: () => void;
  const settled = new Promise<void>(resolve => { release = resolve; });
  const readActivity = f.deps.readBlockSwapTouched;
  f.deps.readBlockSwapTouched = async (...args) => {
    try { return await readActivity(...args); }
    catch (error) { rangeFailed = true; await settled; throw error; }
  };
  const pass = f.loop.runHead(N + 1, observe()).catch(() => {});
  try {
    await until(() => rangeFailed, "range mismatch awaiting retirement");
    f.runtimeAbort.abort(new Error("fixture activity cancellation"));
  } finally { release(); await pass; }
  assert.equal(f.headers.filter(number => number === N).length, 2, "cancelled activity cannot start an independent base recheck");
  assert.equal(f.coordinator.latestPricingSnapshot(), warm);
  assert.deepEqual(f.resets, [], "a cancelled typed range error cannot authorize a reset");
  assert.equal(f.loop.isStartupWarmPending(), false);
  assert.equal(f.requests.length, 1);
});

console.log("blockscan-startup-warm-resume PASS (same-hash memo, real Ready Graph retry, published-anchor activity catch-up, clean carry/dirty requote, confirmed-reorg drain/reset/bootstrap recovery, fail-closed read/trace/recheck/cancellation, fresh sessions/generations, canonical publication, fatal controls, shutdown/queue drain)");
