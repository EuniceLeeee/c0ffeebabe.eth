import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ethers } from "ethers";
import { BlockScanRuntimeLoop, SourceSimulationWork, type BlockScanRuntimeLoopDependencies,
  type SourceSimulationFactory } from "../blockscan-runtime-loop.js";
import { createLiveRuntimeStop, createLiveSourceSimulationFactory } from "../main.js";
import { RevmFatalError, RevmStrictError, type RevmFatalReason, type StrictSimulateRequest } from "../revm-sim-client.js";
import { StateCallAbortedError } from "../../shared/state/state-backend.js";
import { blockScanEdgeKey, createVerifiedGraphView, exactSetHash, type VerifiedGraphView } from "../venues/blockscan-state-capability.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const source = (generation = 1, number = 101) => ({ number, hash: hash(number), generation });
const control = () => ({ signal: new AbortController().signal, deadlineAtMs: Date.now() + 10_000 });
const actor = `0x${"aa".repeat(20)}`, origin = `0x${"bb".repeat(20)}`, target = `0x${"cc".repeat(20)}`;
const invocation = (s = source()) => ({ source: s, request: {
  id: "generic-effect", kind: "effect-delta-simulation" as const,
  call: { caller: { kind: "executor" as const }, executionMode: "impersonated-call-frame" as const, to: target, data: "0x" },
  overrideIntent: { caller: { kind: "executor" as const } }, observe: ["return-data" as const],
}, callerAuthority: { executor: actor, transactionOrigin: origin } });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { assert(Date.now() < deadline, "fixture boundary not reached"); await turn(); }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

test("fatal stop reports once after latching, and exits only after all runtime drains join", async () => {
  const runtimeAbort = new AbortController(), sourceDrain = deferred(), passDrain = deferred();
  const markers: RevmFatalReason["kind"][] = [], exits: number[] = []; let drains = 0;
  const stop = createLiveRuntimeStop({ runtimeAbort, exit: code => { exits.push(code); }, emitFatal: kind => {
    assert(runtimeAbort.signal.aborted); markers.push(kind);
    stop.shutdown(); // A supervisor SIGTERM must not downgrade the fatal code.
  } });
  stop.installDrain(async () => { drains++; await Promise.all([sourceDrain.promise, passDrain.promise]); });
  stop.fatal({ kind: "rpc-throttle", category: "http429", httpStatus: 429 });
  stop.fatal({ kind: "source-fault" }); stop.shutdown();
  await turn(); assert.equal(drains, 1); assert.deepEqual(markers, ["rpc-throttle"]); assert.deepEqual(exits, []);
  sourceDrain.resolve(); await turn(); assert.deepEqual(exits, []);
  passDrain.resolve(); await turn(); assert.deepEqual(exits, [1]);
  stop.fatal({ kind: "protocol-fault" }); stop.shutdown();
  stop.installDrain(async () => { throw new Error("must not replace the original drain"); });
  await turn(); assert.equal(drains, 1); assert.deepEqual(exits, [1]);
});

test("early fatal survives callback installation and cannot reopen source work", async () => {
  const runtimeAbort = new AbortController(), gate = deferred(), exits: number[] = [];
  const markers: string[] = []; let drains = 0, created = 0;
  const stop = createLiveRuntimeStop({ runtimeAbort, exit: code => { exits.push(code); }, emitFatal: kind => { markers.push(kind); } });
  stop.fatal({ kind: "source-fault" }); stop.fatal({ kind: "protocol-fault" }); stop.shutdown();
  await turn(); assert(runtimeAbort.signal.aborted); assert.deepEqual(exits, []); assert.deepEqual(markers, ["source-fault"]);
  const factory = createLiveSourceSimulationFactory({ rpcUrl: "http://127.0.0.1:1/not-opened", chainId: 1,
    executablePath: process.execPath, timeoutMs: 1000, runtimeAbort, onFatal: stop.fatal,
    createClient() { created++; throw new Error("no client may be created"); } });
  assert.throws(() => factory({ source: source(), control: control() }), RevmFatalError);
  stop.installDrain(async () => { drains++; await gate.promise; });
  await turn(); assert.equal(drains, 1); assert.deepEqual(exits, []);
  assert.throws(() => factory({ source: source(2), control: control() }), RevmFatalError);
  gate.resolve(); await turn(); assert.deepEqual(exits, [1]); assert.equal(created, 0);
});

for (const synchronous of [false, true]) test(`fatal exits nonzero after ${synchronous ? "synchronous" : "async"} drain failure`, async () => {
  const exits: number[] = []; let drains = 0;
  const stop = createLiveRuntimeStop({ runtimeAbort: new AbortController(), exit: code => { exits.push(code); },
    emitFatal() { throw new Error("fixture reporter unavailable"); } });
  stop.installDrain(() => {
    drains++;
    if (synchronous) throw new Error("fixture synchronous drain failure");
    return Promise.reject(new Error("fixture async drain failure"));
  });
  stop.fatal({ kind: "protocol-fault" }); stop.fatal({ kind: "protocol-fault" });
  await turn(); assert.deepEqual(exits, [1]); assert.equal(drains, 1);
});

test("ordinary shutdown remains zero unless a fatal arrives during its joined drain", async () => {
  for (const fatalDuringDrain of [false, true]) {
    const gate = deferred(), exits: number[] = [];
    const stop = createLiveRuntimeStop({ runtimeAbort: new AbortController(), emitFatal() {}, exit: code => { exits.push(code); } });
    stop.installDrain(() => gate.promise); stop.shutdown(); await turn(); assert.deepEqual(exits, []);
    if (fatalDuringDrain) stop.fatal({ kind: "source-fault" });
    gate.resolve(); await turn(); assert.deepEqual(exits, [fatalDuringDrain ? 1 : 0]);
  }
});

test("actual idle child exits nonzero after fatal drain instead of remaining in disabled-hint wait", { timeout: 10_000 }, async () => {
  const mainUrl = new URL("../main.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { createLiveRuntimeStop } from ${JSON.stringify(mainUrl)};
    setInterval(() => {}, 60_000); // Same persistent wait as disabled hints; no RPC.
    const stop = createLiveRuntimeStop({ runtimeAbort: new AbortController(),
      emitFatal: kind => console.log(JSON.stringify({ type: "strict_simulation_fatal", kind })),
      exit: code => process.exit(code) });
    stop.fatal({ kind: "rpc-throttle", category: "http429", httpStatus: 429 });
    stop.fatal({ kind: "source-fault" });
    stop.installDrain(async () => {
      const released = new Promise(resolve => process.stdin.once("data", resolve));
      console.log("drain-start"); await released; console.log("drain-done");
    });
  `], { cwd: new URL("../../../", import.meta.url), stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, SEARCHER_TEST_DISABLE_DOTENV: "1" } });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    await until(() => stdout.includes("drain-start") || child.exitCode !== null || child.signalCode !== null);
    assert(stdout.includes("drain-start"), stderr); assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    assert.equal(stdout.split("strict_simulation_fatal").length - 1, 1);
    assert(stdout.includes('"kind":"rpc-throttle"'));
    child.stdin.end("release");
    assert.deepEqual(await closed, { code: 1, signal: null }); assert(stdout.includes("drain-done")); assert.equal(stderr, "");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
});

function clients() {
  const made: { requests: StrictSimulateRequest[]; controls: any[]; closes: number;
    onFatal: (reason: RevmFatalReason) => void; release: () => void; hold: boolean }[] = [];
  const runtimeAbort = new AbortController(); const reports: RevmFatalReason[] = [];
  const factory = createLiveSourceSimulationFactory({ rpcUrl: "http://127.0.0.1:1", chainId: 1,
    executablePath: process.execPath, timeoutMs: 1000, runtimeAbort,
    onFatal: r => { assert(runtimeAbort.signal.aborted); reports.push(r); },
    createClient({ onFatal }) {
      const gate = deferred(); const row = { requests: [] as StrictSimulateRequest[], controls: [] as any[],
        closes: 0, onFatal, release: gate.resolve, hold: false };
      made.push(row);
      return { isTerminal: false,
        async strictSimulate(request, requestControl) {
          row.requests.push(request); row.controls.push(requestControl);
          return { ok: true, success: true, output: "0x", gasUsed: "0", latencyMs: 0,
            sourceAttestation: { kind: "node-attested" as const, chainId: 1, blockNumber: request.blockNumber,
              blockHash: request.sourcePin!.blockHash, stateRoot: hash(7), parentHash: hash(100) },
            strict: { outcome: { kind: "Success" as const, output: "0x", phase: "main" as const }, executionGasUsed: "0",
              tokenDeltas: [], nativeDeltas: [], totalSupplyDeltas: [], logs: [] } };
        },
        async closeAndDrain() { row.closes++; if (row.hold) await gate.promise; },
      };
    } });
  return { factory, made, runtimeAbort, reports };
}

test("live factory binds explicit engine budget and per-invocation authority on an independent strict client", async () => {
  const f = clients(); const work = new SourceSimulationWork(f.factory); const c = control();
  const transport = work.transportFor(source(), c)!;
  assert.equal(f.made.length, 0, "slot admission is lazy, not a startup daemon or RPC");
  await transport.simulate(invocation());
  await transport.simulate({ ...invocation(), callerAuthority: { executor: target, transactionOrigin: actor } });
  assert.equal(f.made.length, 1); const [a, b] = f.made[0]!.requests;
  assert.equal(a!.executionGasLimit, 0x1000000); assert.equal(a!.gasLimit, 0x1000000);
  assert.equal(a!.from, actor); assert.equal(a!.transactionOrigin, origin);
  assert.equal(b!.from, target); assert.equal(b!.transactionOrigin, actor);
  assert.equal(a!.blockNumber, 101); assert.deepEqual(a!.sourcePin, { chainId: 1, blockHash: hash(101) });
  assert.equal(f.made[0]!.controls[0].deadlineAtMs, c.deadlineAtMs);
  await work.closeAndDrain(); assert.equal(f.made[0]!.closes, 1);
});

test("a short first quote never replaces the source control, and a changed source never acquires", async () => {
  const f = clients(); const work = new SourceSimulationWork(f.factory); const c = control();
  const transport = work.transportFor(source(), c)!;
  const quote = new AbortController(); quote.abort();
  await assert.rejects(transport.simulate({ ...invocation(), control: { signal: quote.signal } }));
  assert.equal(f.made.length, 0);
  await transport.simulate(invocation());
  assert.equal(f.made[0]!.controls[0].deadlineAtMs, c.deadlineAtMs);
  await assert.rejects(transport.simulate(invocation(source(2))), RevmFatalError);
  assert.deepEqual(f.reports, [{ kind: "source-fault" }]);
  assert.throws(() => f.factory({ source: source(3), control: c }), RevmFatalError);
  assert.equal(f.made.length, 1); await work.closeAndDrain();
});

test("blockscan, pending and hint slots never share clients or generation counters", async () => {
  const f = clients(); const works = [new SourceSimulationWork(f.factory), new SourceSimulationWork(f.factory), new SourceSimulationWork(f.factory)];
  try {
    const transports = works.map(w => w.transportFor(source(), control())!);
    assert.equal(new Set(transports).size, 3);
    await Promise.all(transports.map(t => t.simulate(invocation())));
    assert.equal(f.made.length, 3);
    await works[1]!.closeAndDrain(); assert.deepEqual(f.made.map(c => c.closes), [0, 1, 0]);
    await transports[0]!.simulate(invocation()); await transports[2]!.simulate(invocation());
    assert.deepEqual(f.made.map(c => c.requests.length), [2, 1, 2]);
  } finally { await Promise.all(works.map(w => w.closeAndDrain())); }
  assert.deepEqual(f.made.map(c => c.closes), [1, 1, 1]);
});

for (const fatal of [{ kind: "rpc-throttle", category: "http429", httpStatus: 429 }, { kind: "source-fault" }, { kind: "protocol-fault" }] as const) {
  test(`task fixture fatal synchronously bars all new slots and drains ${fatal.kind}`, async () => {
    const f = clients(); const work = new SourceSimulationWork(f.factory);
    const t = work.transportFor(source(), control())!; await t.simulate(invocation());
    const client = f.made[0]!; client.hold = true; client.onFatal(fatal);
    assert(f.runtimeAbort.signal.aborted); assert.deepEqual(f.reports, [fatal]);
    assert.throws(() => f.factory({ source: source(2), control: control() }), RevmFatalError);
    await assert.rejects(t.simulate(invocation()), RevmFatalError);
    let closed = false; const drain = work.closeAndDrain().then(() => { closed = true; });
    await turn(); assert.equal(closed, false); assert.equal(client.closes, 1);
    client.release(); await drain; assert.equal(closed, true); assert.equal(f.made.length, 1);
  });
}

test("slot memoizes rejected creation, retains first source control, and joins every drain", async () => {
  const calls: Parameters<SourceSimulationFactory>[0][] = []; const gate = deferred(); let closed = 0;
  const work = new SourceSimulationWork(input => {
    calls.push(input); if (input.source.generation === 2) throw new Error("failed generation");
    return { transport: { async simulate() { return { data: "0x" }; } }, async closeAndDrain() { closed++; await gate.promise; } };
  });
  const c = control(); const t = work.transportFor(source(), c);
  assert.equal(work.transportFor(source(), control()), t); assert.equal(calls[0]!.control.signal, c.signal);
  assert.throws(() => work.transportFor({ ...source(), hash: hash(102) }, c), /rebound/);
  for (let i = 0; i < 2; i++) assert.throws(() => work.transportFor(source(2), c), /failed generation/);
  assert.equal(calls.length, 2); let done = false;
  const drain = work.closeAndDrain().then(() => { done = true; }); await turn(); assert.equal(done, false);
  assert.throws(() => work.transportFor(source(3), c), /closed/);
  gate.resolve(); await drain; await work.closeAndDrain(); assert.equal(closed, 1);
});

test("source cancellation retires the client without reopening the generation or dispatching another quote", async () => {
  const f = clients(); const work = new SourceSimulationWork(f.factory); const controller = new AbortController();
  const transport = work.transportFor(source(), { signal: controller.signal, deadlineAtMs: Date.now() + 1000 })!;
  await transport.simulate(invocation());
  controller.abort(new Error("fixture source cancelled"));
  assert.equal(work.transportFor(source(), control()), transport);
  for (let i = 0; i < 2; i++) await assert.rejects(transport.simulate(invocation()),
    (error: unknown) => error instanceof RevmStrictError && error.kind === "execution");
  await work.closeAndDrain();
  assert.equal(f.made.length, 1); assert.equal(f.made[0]!.requests.length, 1); assert.equal(f.made[0]!.closes, 1);
  assert.deepEqual(f.reports, [], "expected cancellation is not a physical fatal");
});

function loopFixture(factory: SourceSimulationFactory) {
  const inputs: any[] = []; const runtimeAbort = new AbortController();
  const worker: any = { state: { provider: {}, async forkAt() {}, stop() {}, async stopAndWait() {} }, solver: {}, simulator: {} };
  const coordinator: any = { latestPricingSnapshot: () => null,
    startFundingPreparation(input: any) { inputs.push({ kind: "funding", ...input }); return { settle: async () => {} }; },
    async prepare(input: any) { inputs.push({ kind: "runtime", ...input }); throw new Error("fixture prepared boundary"); },
  };
  const deps: BlockScanRuntimeLoopDependencies = {
    enabled: true, runtimeAbort, rpcUrl: "http://127.0.0.1:1", sourceSimulationFactory: factory,
    executionWorkers: [worker], finalSimulationWorkers: [worker], sharedPlanner: { setFlashLiquidity() {} },
    backrunStatePublisher: { publish() {} }, frozenTopology: { topologyKey: "fixture",
      async observeHeader(number) { return { number, hash: hash(number), parentHash: hash(number - 1) }; } },
    blind: { enabled: false, activeSource: () => null, preparedBase: () => null, preparedArtifacts: () => null, dynamicResetNonce: () => null },
    startupWarmEnabled: false, startupWarmBudgetMs: 100, passBudgetMs: 10_000, largeGraphPassBudgetMs: 10_000,
    largeGraphEdgeThreshold: 1000, refineCandidates: 5, solveReserveMs: 20, solverGridHalfWidth: 1,
    solverGssMaxTries: 1, solverQuoteConcurrency: 1, exactConcurrency: 1, exactProbeTimeoutMs: 100,
    executorAddress: actor, currentHeadEvidenceFamilyForEdge: () => null, currentHeadEvidenceScopeKeyForEdge: () => null,
    currentHeadEvidenceScopeKeys: () => [], isCurrentHeadEvidenceFamily: () => true, isShuttingDown: () => false,
    blockScanGraph: () => [], blockScanPlanner: () => ({ setFlashLiquidity() {} } as any), currentRuntimeCoordinator: () => coordinator,
    flashTokens: () => [], blockScanConfig: { maxHops: 3, minSpreadBps: 20, maxCandidates: 5, budgetMs: 350, pricedTokens: new Map() },
    buildGraphView: input => createVerifiedGraphView({ ...input, completenessWatermark: input.sourceBlock, familyIdForEdge: () => "fixture" as any, perSourceCoverage: [] }),
    readBlockHash: async () => hash(101), readBlockSwapTouched: async () => new Set(),
    formatRouteKey: () => "unused", formatRing: () => "unused", submitAtomic: async () => { throw new Error("unexpected submission"); },
  };
  return { loop: new BlockScanRuntimeLoop(deps), deps, inputs, coordinator, runtimeAbort };
}

test("runHead creates SOURCE-controlled context before prefunding and drains it on failed runtime", async () => {
  const contexts: Parameters<SourceSimulationFactory>[0][] = []; let closes = 0;
  const transport = { async simulate() { return { data: "0x" }; } };
  const f = loopFixture(input => { contexts.push(input); return { transport, async closeAndDrain() { closes++; } }; });
  try {
    await assert.rejects(f.loop.runHead(101, { sourceHeadSeenAtMs: Date.now(), sourceHeadSeenAtMonotonicMs: performance.now() }), /fixture prepared/);
    assert.equal(contexts.length, 1); assert.deepEqual(contexts[0]!.source, source());
    assert.deepEqual(f.inputs.map(i => i.kind), ["funding", "runtime"]);
    for (const i of f.inputs) { assert.equal(i.simulationTransport, transport); assert.equal(i.signal, contexts[0]!.control.signal);
      assert.equal(i.deadlineAtMs, contexts[0]!.control.deadlineAtMs); }
    assert.equal(closes, 1);
  } finally { await f.loop.shutdown(); }
});

test("startup retry retires the old generation before creating a new source context", async () => {
  const contexts: Parameters<SourceSimulationFactory>[0][] = []; const closes: number[] = [];
  const f = loopFixture(input => { contexts.push(input); return { transport: { async simulate() { return { data: "0x" }; } },
    async closeAndDrain() { closes.push(input.source.generation); } }; });
  const work = new SourceSimulationWork(f.deps.sourceSimulationFactory); const pass = new AbortController();
  const graph = f.deps.buildGraphView({ id: "fixture", generation: f.loop.nextGeneration(), sourceBlock: 101,
    sourceBlockHash: hash(101), edges: [], landedCoverage: [], topologyKey: "fixture" });
  let attempts = 0;
  f.coordinator.prepare = async (input: any) => {
    attempts++; assert.equal(input.simulationTransport, contexts.length && work.transportFor({ number: 101,
      hash: hash(101), generation: input.graph.generation }, control()));
    if (attempts === 1) {
      await new Promise(resolve => setTimeout(resolve, 35)); throw new StateCallAbortedError("fixture attempt deadline", "deadline");
    }
    assert.deepEqual(closes, [graph.generation]); throw new Error("second attempt observed");
  };
  try {
    await assert.rejects((f.loop as any).prepareStartupWarm(f.coordinator, { graph, fundingTokens: [],
      deadlineAtMs: Date.now() + 30, preparationSettleDeadlineAtMs: Date.now() + 20 },
      { async drain() {}, abort() {}, stats: () => ({}) }, pass, work), /second attempt observed/);
    assert.equal(contexts.length, 2); assert.equal(contexts[0]!.source.generation + 1, contexts[1]!.source.generation);
    assert.equal(contexts[0]!.control.signal, pass.signal); assert.equal(contexts[1]!.control.signal, pass.signal);
  } finally { await work.closeAndDrain(); await f.loop.shutdown(); }
  assert.deepEqual(closes, contexts.map(c => c.source.generation));
});

for (const mode of ["success", "incomplete-again", "source-hash", "source-number", "header-429", "source-fatal", "quota-fatal", "late-quota-fatal"] as const) {
test(`producer bootstrap retires, revalidates and quotes in a fresh generation: ${mode}`, async () => {
  const clientsFixture = clients(); const contexts: Parameters<SourceSimulationFactory>[0][] = [];
  const f = loopFixture(input => { contexts.push(input); return clientsFixture.factory(input); });
  let headers = 0, latest: any = null, firstReturned = false;
  Object.assign(f.deps, { runtimeAbort: clientsFixture.runtimeAbort, nMinusOneStateBudgetMs: 50, startupWarmBudgetMs: 1000,
    frozenTopology: { topologyKey: "fixture", async observeHeader(number: number, control?: any) {
      headers++;
      if (headers === 2) {
        assert.equal(clientsFixture.made[0]!.closes, 1, "canonical revalidation follows retired daemon drain");
        assert.equal(clientsFixture.made.length, 1, "no new daemon before canonical revalidation");
        assert(control.signal && control.deadlineAtMs > Date.now());
        if (mode === "header-429") throw Object.assign(new Error("fixture HTTP quota"), { status: 429 });
      }
      return { number: headers === 2 && mode === "source-number" ? number + 1 : number,
        hash: headers === 2 && mode === "source-hash" ? hash(999) : hash(number), parentHash: hash(number - 1) };
    } } });
  const calls: any[] = [];
  f.coordinator.latestPricingSnapshot = () => latest;
  f.coordinator.prepareCoarsePricing = async (input: any) => {
    calls.push(input);
    if (calls.length === 1) {
      await input.simulationTransport.simulate(invocation(contexts[0]!.source));
      clientsFixture.made[0]!.hold = true;
      if (mode === "source-fatal") clientsFixture.made[0]!.onFatal({ kind: "source-fault" });
      if (mode === "quota-fatal") clientsFixture.made[0]!.onFatal({ kind: "rpc-throttle", category: "http429", httpStatus: 429 });
      await new Promise(resolve => setTimeout(resolve, Math.max(1, input.deadlineAtMs - Date.now() + 5)));
      firstReturned = true;
      return { status: "incomplete" };
    }
    assert.equal(calls.length, 2, "the existing producer permits exactly one bootstrap escalation");
    assert.equal(headers, 2); assert.equal(clientsFixture.made[0]!.closes, 1);
    assert.deepEqual(contexts.map(c => c.source), [source(1), source(2)]);
    assert.equal(calls[0]!.graph.generation, 1, "old graph/issued activity remains immutable");
    assert.equal(calls[0]!.canonicalActivity.source.generation, 1);
    assert.equal(input.graph.generation, 2); assert.deepEqual(input.canonicalActivity.source, source(2));
    assert.notEqual(input.simulationTransport, calls[0]!.simulationTransport);
    assert.equal(input.pricingCallBackend, calls[0]!.pricingCallBackend, "same-hash successful view bytes retain their backend");
    assert.equal(contexts[1]!.control.deadlineAtMs, input.deadlineAtMs);
    assert(input.deadlineAtMs > contexts[0]!.control.deadlineAtMs);
    await assert.rejects(calls[0]!.simulationTransport.simulate(invocation(source(1))));
    await input.simulationTransport.simulate(invocation(source(2)));
    const snapshot = pricingFixture(input.graph);
    if (mode === "success") latest = snapshot;
    return { ...snapshot, snapshot, status: mode === "incomplete-again" ? "incomplete" : "complete", issues: [] };
  };
  const graph = f.deps.buildGraphView({ id: "fixture", generation: 0, sourceBlock: 101,
    sourceBlockHash: hash(101), edges: [], landedCoverage: [], topologyKey: "fixture" });
  try {
    (f.loop as any).startCoarsePricing({ coordinator: f.coordinator, graph });
    const result = (f.loop as any).coarsePricingActive.then(() => null, (error: unknown) => error);
    await until(() => firstReturned && clientsFixture.made[0]?.closes === 1);
    assert.equal(contexts.length, 1, "no new generation before physical drain");
    assert.equal(headers, 1); assert.equal(calls.length, 1);
    if (mode === "late-quota-fatal") clientsFixture.made[0]!.onFatal({ kind: "rpc-throttle", category: "http429", httpStatus: 429 });
    clientsFixture.made[0]!.release();
    const error = await result;
    if (mode === "success" || mode === "incomplete-again") {
      assert.equal(error, null); assert.equal(calls.length, 2); assert.equal(contexts.length, 2);
      assert.deepEqual(clientsFixture.made.map(c => [c.requests.length, c.closes]), [[1, 1], [1, 1]]);
      assert.deepEqual(clientsFixture.reports, []); assert.equal(latest?.generation ?? null, mode === "success" ? 2 : null);
    } else {
      assert(error); assert.equal(calls.length, 1); assert.equal(contexts.length, 1); assert.equal(clientsFixture.made.length, 1);
      assert.equal(clientsFixture.made[0]!.requests.length, 1);
      if (mode.includes("fatal") || mode === "header-429") assert(clientsFixture.runtimeAbort.signal.aborted);
      if (mode.includes("fatal")) assert.equal(headers, 1, "fatal drainage must bar even canonical retry I/O");
    }
  } finally { for (const c of clientsFixture.made) c.release(); await turn(); await f.loop.shutdown().catch(() => {}); }
});
}

test("scheduled pass shutdown cancels source authority and joins its physical drain before returning", async () => {
  const gate = deferred(); const contexts: Parameters<SourceSimulationFactory>[0][] = []; let closing = 0;
  const f = loopFixture(input => { contexts.push(input); return {
    transport: { async simulate() { return { data: "0x" }; } }, async closeAndDrain() { closing++; await gate.promise; },
  }; });
  f.coordinator.prepare = async (input: any) => {
    await new Promise<void>((_, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }));
  };
  try {
    f.loop.schedule(101);
    await until(() => contexts.length === 1);
    let done = false; const stopped = f.loop.shutdown().then(() => { done = true; });
    await until(() => closing === 1);
    assert(contexts[0]!.control.signal.aborted); assert.equal(done, false);
    f.loop.schedule(102); await turn(); assert.equal(contexts.length, 1);
    gate.resolve(); await stopped; assert.equal(done, true); assert.equal(closing, 1);
  } finally { gate.resolve(); await f.loop.shutdown(); }
});

test("task fatal bars new head and pending admissions before allocating any generation", async () => {
  let creates = 0;
  const f = loopFixture(() => { creates++; throw new Error("unexpected source admission"); });
  Object.assign(f.deps, { nMinusOneFallbackEnabled: true, buildGraphView: (input: unknown) => input });
  f.runtimeAbort.abort(new RevmFatalError({ kind: "source-fault" }));
  try {
    f.loop.schedule(101);
    assert.equal(f.loop.currentGeneration(), 0);
    assert.equal(f.loop.schedulePendingEvidence({} as any), false, "terminal intake rejects before evidence processing");
    await f.loop.runHead(102, { sourceHeadSeenAtMs: Date.now(), sourceHeadSeenAtMonotonicMs: performance.now() });
    assert.equal(creates, 0); assert.equal(f.inputs.length, 0);
  } finally { await f.loop.shutdown(); }
});

test("actual pending evidence passes use their own source generation without advancing blockscan's counter", async () => {
  const contexts: Parameters<SourceSimulationFactory>[0][] = []; let closing = 0;
  const transports: unknown[] = [];
  const f = loopFixture(input => { contexts.push(input); const transport = { async simulate() { return { data: "0x" }; } };
    transports.push(transport); return { transport, async closeAndDrain() { closing++; } }; });
  f.loop.nextGeneration(); f.loop.nextGeneration();
  try {
    await assert.rejects(f.loop.runHead(101, { sourceHeadSeenAtMs: Date.now(), sourceHeadSeenAtMonotonicMs: performance.now() }));
    const txHash = hash(999), canonicalPayload = "0x", payloadHash = ethers.keccak256(canonicalPayload);
    const evidence = { familyId: "fixture" as any, txHash, headBlockNumber: 101, headHash: hash(101),
      canonicalPayload, payloadHash, evidenceHash: ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "bytes32", "uint256", "bytes32", "bytes32"], ["fixture", txHash, 101, hash(101), payloadHash])) };
    const now = Date.now(), mono = performance.now();
    assert(f.loop.schedulePendingEvidence({ txHash, head: { number: 101, hash: hash(101) },
      observedAtMs: now, observedAtMonotonicMs: mono, evidenceReadyAtMs: now, evidenceReadyAtMonotonicMs: mono,
      evidence: [evidence] }));
    await until(() => closing === 2 && (f.loop as any).activePass === null);
    assert.deepEqual(contexts.map(c => c.source), [source(3), source(1)]);
    assert.equal(f.loop.currentGeneration(), 3); assert.notEqual(transports[0], transports[1]);
    assert.equal(f.loop.nextGeneration(), 4);
  } finally { await f.loop.shutdown(); }
});

// Generic synthetic two-venue prices; no chain/provider is involved. The real
// scanner must emit a candidate before the production Exact callsite is reached.
function pricingFixture(graph: VerifiedGraphView): any {
  const keys = graph.edges.map(blockScanEdgeKey).sort();
  const coverage: Record<string, unknown> = {};
  for (const axis of ["State", "Read", "Edge"]) for (const disposition of ["expected", "resolved", "unresolved", ...(axis === "Edge" ? ["unavailable"] : [])]) {
    const values = axis === "Edge" && ["expected", "resolved"].includes(disposition) ? keys : [];
    coverage[`${disposition}${axis}Keys`] = values; coverage[`${disposition}${axis}KeyHash`] = exactSetHash(values);
  }
  return { generation: graph.generation, sourceBlock: graph.sourceBlock, sourceBlockHash: graph.sourceBlockHash, graph,
    mids: new Map(graph.edges.map(edge => {
      const a = edge.target === target ? 1000 : 1100, b = 2_000_000;
      const [reserveA, reserveB] = edge.tokenIn === actor ? [a, b] : [b, a];
      return [blockScanEdgeKey(edge), { kind: "v2", pool: edge.target, edges: [edge], mid: reserveB / reserveA,
        feeBps: 30, reserveA: BigInt(reserveA) * 10n ** 18n, reserveB: BigInt(reserveB) * 10n ** 18n, depthProxy: reserveA }];
    })), coverage, coverageByReadKey: new Map(), freshnessByReadKey: new Map(), stateByStateKey: new Map(),
    coverageByEdgeKey: new Map(keys.map(k => [k, { status: "resolved" }])), resolvedFamilyIds: ["fixture"],
    incompleteFamilyIds: [], laneTelemetry: [] };
}

for (const nMinusOne of [false, true]) test(`${nMinusOne ? "N-1 enumeration" : "source-N pass"} Exact retains current-N source and selected generation despite newer publication`, async () => {
  const contexts: Parameters<SourceSimulationFactory>[0][] = []; const transports: unknown[] = []; let closes = 0;
  const f = loopFixture(input => { contexts.push(input); const transport = { async simulate() { return { data: "0x" }; } };
    transports.push(transport); return { transport, async closeAndDrain() { closes++; } }; });
  const edges = [target, `0x${"dd".repeat(20)}`].flatMap(pool => [[actor, origin], [origin, actor]].map(([tokenIn, tokenOut]) => ({
    adapterId: "univ2-swap", slotKind: "swap" as const, target: pool, tokenIn: tokenIn!, tokenOut: tokenOut!, ...deriveEdgeTaxonomy("swap"),
  })));
  const graph = (number: number, generation: number) => f.deps.buildGraphView({ id: "fixture", generation,
    sourceBlock: number, sourceBlockHash: hash(number), edges, landedCoverage: [], topologyKey: "fixture" });
  let latest = nMinusOne ? pricingFixture(graph(100, 70)) : null;
  const newerPublication = pricingFixture(graph(101, 900));
  f.coordinator.latestPricingSnapshot = () => latest;
  f.coordinator.prepare = async (input: any) => {
    f.inputs.push({ kind: "runtime", ...input });
    const pricing = pricingFixture(input.graph); const empty = exactSetHash([]);
    const funding = { generation: input.graph.generation, sourceBlock: 101, sourceBlockHash: hash(101),
      coverage: { expectedKeys: [], resolvedKeys: [], unresolvedKeys: [], expectedHash: empty, resolvedHash: empty, unresolvedHash: empty },
      coverageByFundingId: new Map(), freshnessByFundingId: new Map(), sources: new Map(), borrowable: () => 0n, source: () => null };
    latest = newerPublication;
    return { status: "complete", pricing: { ...pricing, status: "complete", issues: [] }, issues: [], timing: {},
      snapshot: { completeness: "complete", graph: input.graph, pricing, funding, generation: input.graph.generation,
        sourceBlock: 101, sourceBlockHash: hash(101) } };
  };
  let exactCalls = 0;
  Object.assign(f.deps, { nMinusOneFallbackEnabled: nMinusOne, blockScanGraph: () => edges,
    blockScanConfig: { ...f.deps.blockScanConfig, minSpreadBps: 0,
      pricedTokens: new Map([[actor, { maxBorrow: 10n ** 20n }]]) },
    frozenTopology: { topologyKey: "fixture", async observeHeader(number: number) {
      if (number === 100) latest = newerPublication;
      return { number, hash: hash(number), parentHash: hash(number - 1) };
    } },
    strictSession: async (input: any) => {
      exactCalls++; assert.deepEqual(input.source, source(1), "never use predecessor pin or advancing latest generation");
      assert.equal(input.simulationTransport, transports[0]); assert.equal(contexts.length, 1);
      assert.equal(input.control.signal, contexts[0]!.control.signal);
      assert(input.requiredEdgeIds.size > 0, "real enumeration reached exact");
      if (!nMinusOne) for (const call of f.inputs) assert.equal(call.simulationTransport, input.simulationTransport);
      throw new Error("fixture exact boundary reached");
    },
  });
  try {
    await assert.rejects(f.loop.runHead(101, { sourceHeadSeenAtMs: Date.now(), sourceHeadSeenAtMonotonicMs: performance.now() }),
      /fixture exact boundary reached/);
    assert.equal(exactCalls, 1); assert.equal(closes, 1);
  } finally { await f.loop.shutdown(); }
});

test("production call sites carry transport rather than a constructor-bound fallback", () => {
  const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const loop = readFileSync(new URL("../blockscan-runtime-loop.ts", import.meta.url), "utf8");
  assert.doesNotMatch(main, /createRevmStrictSimulationTransport\(/);
  assert.match(main, /pricing\.sourceBlockHash[\s\S]*?generation: pricing\.generation/);
  assert.match(main, /async \(pricing, control, pricingBackend, reuse, simulationTransport\)/);
  assert.match(main, /purpose: "exact-execution", source,\s+simulationTransport,/);
  assert.match(main, /pricingCallCache === undefined && request\.simulationTransport === undefined/);
  assert.match(main, /createRebuildWiring\(\{[\s\S]*?executionIdentity,\s+onSimulationFatal,/);
  assert.match(main, /createLiveRuntimeStop\(\{\s+runtimeAbort: blockScanRuntimeAbort,[\s\S]*?type: "strict_simulation_fatal", kind/);
  assert.match(main, /const onSimulationFatal[\s\S]*?shuttingDown = true;\s+requestRuntimeStop\.fatal\(reason\)/);
  assert.match(main, /requestRuntimeStop\.installDrain\(stopRuntime\);\s+const shutdown = requestRuntimeStop\.shutdown/);
  assert.match(loop, /const producerSnapshot = amountPricingSnapshot/);
  assert.match(loop, /executionContext === null \? this\.nextGeneration\(\) : \+\+this\.pendingGeneration/);
});
