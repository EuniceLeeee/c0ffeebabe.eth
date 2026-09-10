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
import { buildEffectiveMids } from "../blockscan-effective-mid.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { createVerifiedGraphView } from "../venues/blockscan-state-capability.js";
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
  "raw-header-429" | "raw-header-held" | "raw-header-shutdown";

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
            batch.some(c => c.params[0].data === TAIL)) || mode === "queued") {
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
      producerCallBackend: request.pricingCallBackend, exactCallBackend: request.exactCallBackend,
      generationFence: { assertCurrent(generation, current) {
        assert.equal(generation, source.generation); assert.deepEqual(current, source);
      } },
    });
    const session = await root.createSession({ source, runtime, fundingAssets: request.fundingAssets,
      kind: request.purpose === "exact-execution" ? "exact" : "pricing", control: request.control,
      touchedPools: request.touchedPools, requiredEdgeIds: request.requiredEdgeIds });
    sessions.push(session);
    return session;
  };
  const coordinator = new StrictCurrentRuntimeCoordinator(sessionFor, () => {},
    publication => published.push(publication.snapshot), async (pricing, control, backend) => {
      assert(backend);
      const source = { number: pricing.sourceBlock, hash: pricing.sourceBlockHash, generation: pricing.generation };
      const session = await sessionFor({ purpose: "exact-execution", source, fundingAssets: [], control,
        exactCallBackend: backend, requiredEdgeIds: new Set(pricing.mids.keys()) });
      let index = 0;
      return buildEffectiveMids({ pricing, control, weth: pool.token0, gasCostWei: null,
        enumerationSpreadBps: 20, concurrency: 1,
        quote: async request => {
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
  const realPrepare = coordinator.prepare.bind(coordinator);
  coordinator.prepare = async input => {
    requests.push(input);
    activePrepare++; maxActivePrepare = Math.max(maxActivePrepare, activePrepare);
    try {
      if (requests.length > 1) {
        assert(requests.at(-2)!.signal!.aborted, "old attempt caller authority remains open");
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
    frozenTopology: { topologyKey: "startup-fixture", async observeHeader(number, control) {
      headers.push(number);
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
        hash: mismatch ? hash(999) : hash(number), parentHash: hash(number - 1) };
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
    buildGraphView: input => createVerifiedGraphView({ ...input, completenessWatermark: input.sourceBlock,
      familyIdForEdge: () => ready.familyId, perSourceCoverage: [{ familyId: ready.familyId,
        sourceId: "fixture", sourceFingerprint: "fixture", completeThroughBlock: input.sourceBlock,
        completeThroughHash: input.sourceBlockHash }] }),
    readBlockHash: async () => hash(starts.at(-1)!), readBlockSwapTouched: async () => new Set([pool.pool]),
    formatRouteKey: () => "unused", formatRing: () => "unused", submitAtomic: async () => { throw new Error("unexpected submission"); },
    routeTelemetry: { beginPass(number) { starts.push(number); return null; },
      recordNotStarted: input => drops.push(input.sourceBlock) },
  };
  const loop = new BlockScanRuntimeLoop(deps);
  return { loop, coordinator, runtimeAbort, wire, requests, sessions, published, bridged, snapshots, exacts, headers, starts, drops,
    held, headerWire, headerHeld, releases, errors, backends, logs, server, deps, get maxActivePrepare() { return maxActivePrepare; },
    get forkCount() { return forkCount; }, releaseHeader: () => releaseHeader?.(),
    restore() { PinnedRethQuoteBackend.prototype.call = oldCall; console.log = oldLog; console.warn = oldWarn; } };
}

function assertIdle(backend: PinnedRethQuoteBackend): void {
  const s = backend.stats();
  assert.deepEqual([s.pendingItems, s.liveItems, s.inFlightBatches, s.activeTransports], [0, 0, 0, 0]);
  assert.equal(s.maxBatchSize, 128); assert.equal(s.maxConcurrentBatches, 4);
  assert.equal(s.allowSingleCallFallback, false); assert.equal(s.persistentCacheConfigured, false);
}
const observe = () => ({ sourceHeadSeenAtMs: Date.now(), sourceHeadSeenAtMonotonicMs: performance.now() });
const values = (snapshot: BlockScanStateSnapshot) => ({ mids: [...snapshot.mids],
  rows: [...snapshot.effectiveMids!.rows].map(([key, row]) => [key, row.amountIn, row.amountOut, row.status]) });
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
  f.loop.schedule(N);
  await until(() => f.held.length === 1, "first attempt effective tail");
  assert.equal(f.published.length, 0); assert.equal(f.coordinator.latestPricingSnapshot(), null);
  f.loop.schedule(N + 1);
  await until(() => f.held.length === 2, "resumed attempt effective tail");
  f.loop.schedule(N + 2);
  f.releases[1]!();
  await until(() => f.starts.includes(N + 2) && f.published.length === 2, "warm then newest pending head");
  assert.deepEqual(f.starts, [N, N + 2]); assert(f.drops.includes(N + 1));
  assert.deepEqual(f.requests.map(r => r.graph.sourceBlock), [N, N, N + 2]);
  assert.deepEqual(f.requests.map(r => r.graph.generation), [1, 2, 3]);
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
    await assert.rejects(f.loop.runHead(N, observe()));
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
    await until(() => f.held.length === (mode === "queued" ? 4 : 1), "outstanding work");
    f.loop.schedule(N + 1);
    const before = f.wire.length;
    await f.loop.shutdown(); await turn();
    assert.equal(f.requests.length, 1); assert.equal(f.published.length, 0);
    assert.equal(f.wire.length, before); assert.deepEqual(f.starts, [N]);
    if (mode === "queued") assert.equal(before, 512, "queued fifth/sixth batch must never be sent");
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

console.log("blockscan-startup-warm-resume PASS (same-hash memo, fresh sessions/generations, retired Funding data, canonical publication, latest-head/evidence scheduling, fatal controls, shutdown/queue drain, no tight loop)");
