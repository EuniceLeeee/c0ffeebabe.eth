import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { ethers } from "ethers";
import { BlockScanRuntimeLoop, SourceSimulationWork, startBlockScanBackgroundFork, type BlockScanRuntimeLoopDependencies,
  type SourceSimulationFactory } from "../blockscan-runtime-loop.js";
import { createLiveRuntimeStop, createLiveSourceSimulationFactory, maybeSubmitBlockScanAtomic,
  resolveBlockScanAtomicPolicy, createBlockScanLiveAmountSelectorFactory } from "../main.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import { blockScanRouteId } from "../blockscan-route-identity.js";
import type { SimulationResult } from "../simulator/botvm-simulator.js";
import { RevmFatalError, RevmStrictError, type RevmFatalReason, type StrictSimulateRequest } from "../revm-sim-client.js";
import { StateCallAbortedError } from "../../shared/state/state-backend.js";
import { BlockActivityRangeInvalidatedError } from "../blockscan-touched-state.js";
import { isRpcThrottleError } from "../rpc-throttle-guard.js";
import { BlockScanActivityPrefetch } from "../blockscan-activity-prefetch.js";
import { PinnedRethQuoteBackend } from "../pinned-reth-quote-backend.js";
import { blockScanEdgeKey, createVerifiedGraphView, exactSetHash, type VerifiedGraphView } from "../venues/blockscan-state-capability.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import { AnvilSolver } from "../solver/solver.js";
import { createBlockScanSimAmountSelector } from "../simulator/blockscan-sim-amount-selector.js";
import { createTrialLimiter } from "../simulator/sim-amount-selector.js";
import { ADDR } from "../../shared/constants/addresses.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const source = (generation = 1, number = 101) => ({ number, hash: hash(number), generation });
const control = () => ({ signal: new AbortController().signal, deadlineAtMs: Date.now() + 10_000 });
const actor = `0x${"aa".repeat(20)}`, origin = `0x${"bb".repeat(20)}`, target = `0x${"cc".repeat(20)}`;
const priceFundingToken = ADDR.WETH.toLowerCase(), priceOutputToken = ADDR.USDC.toLowerCase();
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

test("private recording failure joins the ordinary drain but exits nonzero without a simulation-fatal marker", async () => {
  const gate = deferred(), runtimeAbort = new AbortController(), exits: number[] = [], markers: string[] = [];
  const stop = createLiveRuntimeStop({ runtimeAbort, emitFatal: kind => { markers.push(kind); },
    exit: code => { exits.push(code); } });
  const failure = new Error("private solver execution input recording failed");
  stop.fail(failure); stop.shutdown();
  assert.equal(runtimeAbort.signal.reason, failure);
  stop.installDrain(() => gate.promise);
  await turn(); assert.deepEqual(exits, []);
  gate.resolve(); await turn();
  assert.deepEqual(exits, [1]); assert.deepEqual(markers, []);
  const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  assert.match(main, /private solver execution input recording failed"\);\s+requestRuntimeStop\.fail\(failure\);/);
});

test("actual shared activity provider latches throttle before joined reads settle and bars successor I/O", async () => {
  // Extract only the real thin main wiring, not a parallel copy of its behavior.
  const text = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
  const names = new Set(["activityReadFailed", "timedActivityRead", "blockScanRawActivityProvider"]);
  const statements: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && names.has(declaration.name.text))) statements.push(node.getText(ast));
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.equal(statements.length, 3);
  const js = ts.transpileModule(`${statements.join("\n")}\nblockScanRawActivityProvider;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  for (const method of ["logs", "trace"] as const) {
    const runtimeAbort = new AbortController();
    const slow = deferred(); const exits: number[] = []; let calls = 0;
    const stop = createLiveRuntimeStop({ runtimeAbort, emitFatal() {}, exit: code => { exits.push(code); } });
    stop.installDrain(() => slow.promise);
    const throttle = Object.assign(new Error("fixture HTTP 429"), { statusCode: 429 });
    const provider = {
      async getLogs(_filter: unknown) { calls++; if (method === "logs") throw throttle; await slow.promise; return []; },
      async send(_method: string, _params: unknown[]) { calls++; if (method === "trace") throw throttle; await slow.promise; return []; },
    };
    const guarded = runInNewContext(js, {
      provider, blockScanRuntimeAbort: runtimeAbort, console: { error() {} },
      process: { env: {} },
      isRpcThrottleError,
      onSimulationFatal: stop.fatal,
    }, { timeout: 1000 }) as typeof provider;
    const a = guarded.getLogs({ fromBlock: 1, toBlock: 1 }), b = guarded.send("debug_traceBlockByNumber", ["0x1"]);
    const failed = assert.rejects(method === "logs" ? a : b, error => error === throttle);
    await failed;
    assert(runtimeAbort.signal.aborted);
    assert.deepEqual(exits, [], "stop still joins the already-running sibling");
    assert.throws(() => guarded.getLogs({ fromBlock: 1, toBlock: 1 }));
    assert.throws(() => guarded.send("debug_traceBlockByNumber", ["0x1"]));
    assert.equal(calls, 2, "a caller retry cannot dispatch after the throttle");
    slow.resolve(); await Promise.allSettled([a, b]); await turn();
    assert.deepEqual(exits, [1]);
  }
});

test("actual full-header throttle latches before speculative trace drain, then exits after drain", async () => {
  const text = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
  const names = new Set(["frozenProducerTopology", "activityReadFailed", "timedActivityRead",
    "blockScanRawActivityProvider", "blockScanActivityProvider"]);
  const statements: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && names.has(declaration.name.text))) statements.push(node.getText(ast));
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.equal(statements.length, 5);
  const js = ts.transpileModule(`${statements.join("\n")}\n({frozenProducerTopology, blockScanActivityProvider});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  for (const controlled of [true, false]) {
    const runtimeAbort = new AbortController(), slow = deferred(), exits: number[] = [];
    let fatalities = 0, done = false, traces = 0;
    const throttle = Object.assign(new Error("fixture header HTTP 429"), { statusCode: 429 });
    const stop = createLiveRuntimeStop({ runtimeAbort, emitFatal() { fatalities++; }, exit: code => { exits.push(code); } });
    const wired = runInNewContext(js, {
      readyUniverse: { generation: 4, graphHash: hash(4) }, config: { rpcUrl: "http://fixture.invalid" },
      blockScanChainId: 1n, blockScanRuntimeAbort: runtimeAbort, ethers, BlockScanActivityPrefetch,
      provider: { getLogs: async () => [], send: async (method: string) => {
        if (method === "eth_getBlockByNumber") throw throttle;
        traces++; await slow.promise; return [];
      } },
      readBlockScanObservedHeader: async () => { throw throttle; },
      parseBlockScanObservedHeader: () => { throw new Error("unexpected successful header"); },
      process: { env: {} }, console: { error() {}, log() {} }, isRpcThrottleError,
      onSimulationFatal: stop.fatal,
    }, { timeout: 1000 }) as { frozenProducerTopology: { observeHeader: (n: number, c?: unknown) => Promise<unknown> };
      blockScanActivityProvider: BlockScanActivityPrefetch };
    stop.installDrain(() => wired.blockScanActivityProvider.closeAndDrain());
    wired.blockScanActivityProvider.noteHead(42, hash(42));
    const pending = wired.frozenProducerTopology.observeHeader(42, controlled ? control() : undefined)
      .finally(() => { done = true; });
    const rejected = assert.rejects(pending, e => e === throttle);
    await turn();
    assert.equal(traces, 1); assert.equal(fatalities, 1); assert(runtimeAbort.signal.aborted);
    assert.equal(done, false); assert.deepEqual(exits, []);
    slow.resolve(); await rejected; await turn(); assert.deepEqual(exits, [1]);
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

function loopFixture(factory: SourceSimulationFactory, startupWarmEnabled = false) {
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
    startupWarmEnabled, startupWarmBudgetMs: 100, passBudgetMs: 10_000, largeGraphPassBudgetMs: 10_000,
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

test("runtime rejects disabled Exact refinement with evidence-promoting modes", () => {
  const makeDeps = (): BlockScanRuntimeLoopDependencies => {
    const base = loopFixture(() => ({
      transport: { async simulate() { return { data: "0x" }; } },
      async closeAndDrain() {},
    })).deps;
    return { ...base, executionWorkers: [...base.executionWorkers], finalSimulationWorkers: [...base.finalSimulationWorkers] };
  };
  assert.throws(
    () => new BlockScanRuntimeLoop({
      ...makeDeps(),
      exactRefineEnabled: false,
      nMinusOneFallbackEnabled: true,
    }),
    /incompatible with N-minus-one fallback/,
  );
  assert.throws(
    () => new BlockScanRuntimeLoop({
      ...makeDeps(),
      exactRefineEnabled: false,
      blind: {
        enabled: true,
        activeSource: () => null,
        preparedBase: () => null,
        preparedArtifacts: () => null,
        dynamicResetNonce: () => null,
      },
    }),
    /incompatible with blind production audit/,
  );
});

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

test("startup retains64-item batches; steady source-N pricing uses1000 with the same8-batch limit", async context => {
  const records: Array<Record<string, number>> = [];
  const marker = "[searcher/blockscan-source-n-call-stats-final] ";
  context.mock.method(console, "log", (line: string) => {
    if (line.startsWith(marker)) records.push(JSON.parse(line.slice(marker.length)));
  });
  for (const startup of [true, false]) {
    records.length = 0;
    const f = loopFixture(() => ({ transport: { async simulate() { return { data: "0x" }; } },
      async closeAndDrain() {} }), startup);
    try {
      await assert.rejects(f.loop.runHead(101, { sourceHeadSeenAtMs: Date.now(), sourceHeadSeenAtMonotonicMs: performance.now() }),
        /fixture prepared boundary/);
      assert.equal(records.length, 1, "the real phase-owned backend emits one drained receipt");
      const stats = records[0]!;
      assert.equal(stats.maxBatchSize, startup ? 64 : 1000);
      assert.equal(stats.maxConcurrentBatches, 8);
      assert.equal(stats.totalCalls, 0, "phase selection is offline and does not manufacture calls");
      assert.equal(stats.singleCallFallbacks, 0);
    } finally { await f.loop.shutdown(); }
  }
});

test("source-N binds the full published-to-target activity range, with bounded full-refresh fallback", async () => {
  for (const targetBlock of [101, 219, 356, 357]) {
  const f = loopFixture(() => ({ transport: { async simulate() { return { data: "0x" }; } }, async closeAndDrain() {} }));
  const base = { sourceBlock: 100, sourceBlockHash: hash(100) };
  f.coordinator.latestPricingSnapshot = () => base;
  const touched = new Set([target]);
  let activityReads = 0;
  f.deps.readBlockSwapTouched = async (number, header, range) => {
    activityReads++;
    assert.equal(number, targetBlock); assert.equal(header!.hash, hash(targetBlock));
    if (targetBlock <= 356) {
      assert.deepEqual(range!.previousSource, { number: 100, hash: hash(100) });
      assert.equal(range!.signal!.aborted, false);
      assert(range!.deadlineAtMs! > Date.now());
    } else assert.equal(range, undefined, "an oversized range supplies no carry proof");
    return touched;
  };
  try {
    await assert.rejects(f.loop.runHead(targetBlock, { sourceHeadSeenAtMs: Date.now(), sourceHeadSeenAtMonotonicMs: performance.now() }),
      /fixture prepared boundary/);
    assert.equal(activityReads, 1, "one shared activity request, not a separate effective reader");
    const prepared = f.inputs.find(input => input.kind === "runtime");
    assert.equal(prepared.touchedPools, touched);
    assert.equal(prepared.canonicalActivity.touchedStateKeys, touched);
    assert.deepEqual(prepared.canonicalActivity.previousSource,
      targetBlock <= 356 ? { number: 100, hash: hash(100) } : undefined);
  } finally { await f.loop.shutdown(); }
  }
});

test("orphaned range anchor resets only after independent canonical check and owned work drain", async () => {
  for (const kind of ["orphaned", "canonical", "ordinary-error", "recheck-failed"] as const) {
    let closed = false, reset = false, checked = false;
    const funding = deferred();
    const f = loopFixture(() => ({ transport: { async simulate() { return { data: "0x" }; } },
      async closeAndDrain() { closed = true; } }));
    const base = { sourceBlock: 100, sourceBlockHash: hash(100) };
    f.coordinator.latestPricingSnapshot = () => base;
    f.coordinator.startFundingPreparation = () => ({ settle: () => funding.promise });
    f.coordinator.resetDynamicStateForReplay = async () => {
      assert(closed, "old simulation work must be drained before retiring publication");
      reset = true;
    };
    f.deps.frozenTopology.observeHeader = async number => {
      if (number === 100) {
        checked = true;
        if (kind === "recheck-failed") throw new Error("anchor recheck failed");
        return { number, hash: hash(kind === "orphaned" ? 900 : 100), parentHash: hash(99) };
      }
      return { number, hash: hash(number), parentHash: hash(number - 1) };
    };
    f.deps.readBlockSwapTouched = async () => {
      if (kind === "ordinary-error") throw new Error("trace unavailable");
      throw new BlockActivityRangeInvalidatedError("fixture broken range");
    };
    const run = f.loop.runHead(103, {
      sourceHeadSeenAtMs: Date.now(), sourceHeadSeenAtMonotonicMs: performance.now(),
    });
    const result = kind === "orphaned"
      ? assert.doesNotReject(run, "a separately confirmed reorg retires the pass without stopping the runtime")
      : assert.rejects(run, /fixture broken range|trace unavailable|anchor recheck failed/);
    try {
      await until(() => closed);
      assert.equal(reset, false, "pending Funding still owns old generation work");
      funding.resolve();
      await result;
      assert.equal(checked, kind !== "ordinary-error");
      assert.equal(reset, kind === "orphaned");
      assert.equal(f.inputs.some(input => input.kind === "runtime"), false,
        "failed activity never reaches pricing publication");
    } finally { funding.resolve(); await f.loop.shutdown(); }
  }
});

test("N-1 producer also uses one current-block activity set for both prices", async () => {
  const f = loopFixture(() => ({ transport: { async simulate() { return { data: "0x" }; } }, async closeAndDrain() {} }));
  let latest: any = { sourceBlock: 100, sourceBlockHash: hash(100) };
  f.coordinator.latestPricingSnapshot = () => latest;
  const touched = new Set([target]);
  let activityReads = 0;
  f.deps.readBlockSwapTouched = async (number, header, range) => {
    activityReads++;
    assert.equal(number, 101); assert.equal(header!.hash, hash(101));
    assert.equal(range, undefined);
    return touched;
  };
  f.coordinator.prepareCoarsePricing = async (input: any) => {
    assert.equal(input.touchedPools, touched);
    assert.equal(input.canonicalActivity.touchedStateKeys, touched);
    latest = pricingFixture(input.graph);
    return { ...latest, snapshot: latest, status: "complete", issues: [] };
  };
  const graph = f.deps.buildGraphView({ id: "fixture", generation: 0, sourceBlock: 101,
    sourceBlockHash: hash(101), edges: [], landedCoverage: [], topologyKey: "fixture" });
  try {
    (f.loop as any).startCoarsePricing({ coordinator: f.coordinator, graph });
    await (f.loop as any).coarsePricingActive;
    assert.equal(activityReads, 1);
    assert.equal(latest.sourceBlock, 101);
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
      [], { async drain() {}, abort() {}, stats: () => ({}) }, pass, work), /second attempt observed/);
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

// Generic synthetic effective quotes; no chain/provider is involved. The real
// scanner must emit a candidate before the production Exact callsite is reached.
function pricingFixture(graph: VerifiedGraphView): any {
  const keys = graph.edges.map(blockScanEdgeKey).sort();
  const coverage: Record<string, unknown> = {};
  for (const axis of ["State", "Read", "Edge"]) for (const disposition of ["expected", "resolved", "unresolved", ...(axis === "Edge" ? ["unavailable"] : [])]) {
    const values = axis === "Edge" && ["expected", "resolved"].includes(disposition) ? keys : [];
    coverage[`${disposition}${axis}Keys`] = values; coverage[`${disposition}${axis}KeyHash`] = exactSetHash(values);
  }
  const mids = new Map(graph.edges.map(edge => {
      const a = edge.target === target ? 1000 : 1100, b = 2_000_000;
      const [reserveA, reserveB] = edge.tokenIn === priceFundingToken ? [a, b] : [b, a];
      return [blockScanEdgeKey(edge), { kind: "v2", pool: edge.target, edges: [edge], mid: reserveB / reserveA,
        feeBps: 30, reserveA: BigInt(reserveA) * 10n ** 18n, reserveB: BigInt(reserveB) * 10n ** 18n, depthProxy: reserveA }] as const;
    }));
  const quoteSource = source(graph.generation, graph.sourceBlock);
  const rows = new Map(graph.edges.map(edge => {
    const edgeId = blockScanEdgeKey(edge), mid = mids.get(edgeId)!;
    const amountIn = 1_000_000n;
    const amountOut = amountIn * mid.reserveB * 9970n / (mid.reserveA * 10000n);
    return [edgeId, { edgeId, instanceKey: edge.target, tokenIn: edge.tokenIn, tokenOut: edge.tokenOut,
      amountIn, amountOut, effectiveMid: Number(amountOut) / Number(amountIn), status: "quoted", quotedAt: quoteSource }];
  }));
  return { generation: graph.generation, sourceBlock: graph.sourceBlock, sourceBlockHash: graph.sourceBlockHash, graph,
    mids, effectiveMids: { source: quoteSource, reference: "default", referenceWethInput: 1_000_000n,
      rows, complete: true, wallMs: 0 }, coverage, coverageByReadKey: new Map(), freshnessByReadKey: new Map(), stateByStateKey: new Map(),
    coverageByEdgeKey: new Map(keys.map(k => [k, { status: "resolved" }])), resolvedFamilyIds: ["fixture"],
    incompleteFamilyIds: [], laneTelemetry: [] };
}

function twoWayPoolEdges(pools: readonly string[]) {
  return pools.flatMap(pool => [[priceFundingToken, priceOutputToken], [priceOutputToken, priceFundingToken]].map(([tokenIn, tokenOut]) => ({
    adapterId: "univ2-swap", slotKind: "swap" as const, target: pool, tokenIn: tokenIn!, tokenOut: tokenOut!, ...deriveEdgeTaxonomy("swap"),
  })));
}

function completeRuntimeFixture(graph: VerifiedGraphView): any {
  const pricing = pricingFixture(graph), empty = exactSetHash([]);
  const funding = { generation: graph.generation, sourceBlock: graph.sourceBlock, sourceBlockHash: graph.sourceBlockHash,
    coverage: { expectedKeys: [], resolvedKeys: [], unresolvedKeys: [], expectedHash: empty, resolvedHash: empty, unresolvedHash: empty },
    coverageByFundingId: new Map(), freshnessByFundingId: new Map(), sources: new Map(), borrowable: () => 0n, source: () => null };
  return { status: "complete", pricing: { ...pricing, status: "complete", issues: [] }, issues: [], timing: {},
    snapshot: { completeness: "complete", graph, pricing, funding, generation: graph.generation,
      sourceBlock: graph.sourceBlock, sourceBlockHash: graph.sourceBlockHash } };
}

function pendingEvidenceFixture(number: number) {
  const txHash = hash(999), canonicalPayload = "0x", payloadHash = ethers.keccak256(canonicalPayload);
  const now = Date.now(), mono = performance.now();
  return { txHash, head: { number, hash: hash(number) }, observedAtMs: now, observedAtMonotonicMs: mono,
    evidenceReadyAtMs: now, evidenceReadyAtMonotonicMs: mono,
    evidence: [{ familyId: "fixture" as any, txHash, headBlockNumber: number, headHash: hash(number), canonicalPayload, payloadHash,
      evidenceHash: ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "bytes32", "uint256", "bytes32", "bytes32"], ["fixture", txHash, number, hash(number), payloadHash])) }] };
}

test("periodic Source-N settles its original budget, publishes the baseline, drains, then searches only the newest head", async context => {
  const activity = deferred(), preparation = deferred(), drain = deferred();
  const contexts: Parameters<SourceSimulationFactory>[0][] = [], closing: number[] = [], logs: string[] = [];
  context.mock.method(console, "log", (line: string) => logs.push(line));
  const f = loopFixture(input => { contexts.push(input); return {
    transport: { async simulate() { throw new Error("unexpected simulation"); } },
    async closeAndDrain() { closing.push(input.source.number); if (input.source.number === 101) await drain.promise; },
  }; });
  const consumers: Array<[string, number]> = [], activityRanges: Array<[number, number | undefined]> = [];
  const edges = twoWayPoolEdges([target, `0x${"dd".repeat(20)}`]);
  let latest: any = { sourceBlock: 100, sourceBlockHash: hash(100) }, sourceActivity: any;
  const published: number[] = [];
  f.coordinator.latestPricingSnapshot = () => latest;
  f.coordinator.prepare = async (input: any) => {
    f.inputs.push({ kind: "runtime", ...input });
    if (input.graph.sourceBlock === 101) {
      await preparation.promise;
      input.signal.throwIfAborted();
      assert.equal(input.deadlineAtMs, observedAt + f.deps.passBudgetMs);
      assert.equal(input.preparationSettleDeadlineAtMs, input.deadlineAtMs - 1500);
      assert.equal(input.pricingFamilySettleDeadlineAtMs, familyDeadline);
      // Observe another head at the actual preparation/backend-drain handoff.
      const realDrain = input.pricingCallBackend.drain.bind(input.pricingCallBackend);
      let once = false;
      context.mock.method(input.pricingCallBackend, "drain", async () => {
        await realDrain();
        if (!once) { once = true; f.loop.schedule(104); }
      });
    }
    assert(Date.now() < input.deadlineAtMs);
    assert.equal(input.graph.sourceBlockHash, hash(input.graph.sourceBlock));
    const result = completeRuntimeFixture(input.graph);
    latest = result.snapshot.pricing; published.push(latest.sourceBlock);
    return result;
  };
  Object.assign(f.deps, {
    blockScanGraph: () => edges,
    blockScanConfig: { ...f.deps.blockScanConfig, minSpreadBps: 0,
      pricedTokens: new Map([[priceFundingToken, { maxBorrow: 10n ** 20n }]]) },
    readBlockSwapTouched: async (number: number, _header: unknown, range: any) => {
      activityRanges.push([number, range?.previousSource.number]);
      if (number === 101) { sourceActivity = range; await activity.promise; }
      return new Set();
    },
    backrunStatePublisher: { publish(pricing: any) { consumers.push(["backrun", pricing.sourceBlock]); } },
    blockScanPlanner: () => ({ setFlashLiquidity(funding: any) { consumers.push(["planner", funding.sourceBlock]); } }),
    sharedPlanner: { setFlashLiquidity(funding: any) { consumers.push(["shared-planner", funding.sourceBlock]); } },
    strictSession: async (input: any) => {
      consumers.push(["exact", input.source.number]);
      assert.equal(input.control.signal.aborted, false);
      // Once search starts, head supersession must again abort immediately.
      (f.loop as any).advanceLatestHead(105);
      assert(input.control.signal.aborted);
      throw input.control.signal.reason;
    },
    submitAtomic: async () => { consumers.push(["final-sim", 101]); throw new Error("unexpected final sim"); },
  });
  context.mock.method(AnvilSolver.prototype, "solve", async () => {
    consumers.push(["solver", 101]); throw new Error("unexpected Solver");
  });
  const observedAt = Date.now(); let familyDeadline: number;
  try {
    f.loop.schedule(101, { sourceHeadSeenAtMs: observedAt, sourceHeadSeenAtMonotonicMs: performance.now() });
    await until(() => sourceActivity !== undefined && contexts.length === 1);
    f.loop.schedule(102);
    assert.equal(sourceActivity.signal.aborted, false, "activity catch-up belongs to preparation");
    assert.equal(sourceActivity.deadlineAtMs, observedAt + f.deps.passBudgetMs);
    activity.resolve();
    await until(() => f.inputs.some(input => input.kind === "runtime"));
    familyDeadline = f.inputs.find(input => input.kind === "runtime").pricingFamilySettleDeadlineAtMs;
    f.loop.schedule(103);
    assert.equal(contexts[0]!.control.signal.aborted, false);
    assert.equal(contexts[0]!.control.deadlineAtMs, sourceActivity.deadlineAtMs);
    preparation.resolve();
    await until(() => closing.includes(101));
    assert.deepEqual(published, [101]); assert.equal(latest.sourceBlockHash, hash(101));
    assert.deepEqual(consumers, [], "no obsolete snapshot reaches backrun, planner, Exact, Solver or final sim");
    assert(!logs.some(line => line.startsWith("[searcher/blockscan-enumeration]")), "no obsolete enumeration");
    assert(contexts[0]!.control.signal.aborted, "stale pass is retired only after publication");
    assert.equal(contexts.length, 1, "successor waits for physical source drain");
    drain.resolve();
    await until(() => closing.includes(104) && (f.loop as any).activePass === null);
    assert.deepEqual(contexts.map(c => c.source.number), [101, 104]);
    assert.deepEqual(activityRanges, [[101, 100], [104, 101]], "successor consumes the settled baseline");
    assert.deepEqual(published, [101, 104]);
    assert.deepEqual(consumers, [["backrun", 104], ["planner", 104], ["shared-planner", 104], ["exact", 104]]);
    const timing = logs.filter(line => line.includes('"type":"block_scan_timing"'));
    assert(timing.some(line => line.includes("source_head_superseded")));
  } finally { activity.resolve(); preparation.resolve(); drain.resolve(); await f.loop.shutdown(); }
});

test("superseded preparation never hands a snapshot to diagnostic search consumers", async context => {
  context.mock.method(console, "log", () => {});
  const f = loopFixture(() => ({ transport: { async simulate() { return { data: "0x" }; } }, async closeAndDrain() {} }));
  let published = false, snapshots = 0, enumerations = 0, reason: string | undefined;
  f.coordinator.prepare = async (input: any) => {
    const result = completeRuntimeFixture(input.graph);
    published = true;
    (f.loop as any).advanceLatestHead(102);
    return result;
  };
  try {
    await f.loop.runHead(101, { sourceHeadSeenAtMs: Date.now(), sourceHeadSeenAtMonotonicMs: performance.now() }, {
      through: "enumerate", onSnapshot() { snapshots++; }, onEnumeration() { enumerations++; },
      onComplete(result) { reason = result.reason; },
    });
    assert(published); assert.equal(snapshots, 0); assert.equal(enumerations, 0);
    assert.equal(reason, "source_head_superseded");
  } finally { await f.loop.shutdown(); }
});

for (const cause of ["runtime", "fatal", "shutdown", "evidence", "source-invalid"] as const)
test(`deferred Source-N preparation still aborts immediately for ${cause}`, async context => {
  context.mock.method(console, "log", () => {});
  context.mock.method(console, "warn", () => {});
  const drain = deferred(); let request: any, closing = false, published = false;
  const f = loopFixture(() => ({ transport: { async simulate() { return { data: "0x" }; } },
    async closeAndDrain() { closing = true; await drain.promise; } }));
  f.coordinator.prepare = async (input: any) => {
    request = input;
    await new Promise<void>((_, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }));
    published = true; return completeRuntimeFixture(input.graph);
  };
  let stopped: Promise<void> | undefined;
  try {
    f.loop.schedule(101);
    await until(() => request !== undefined);
    f.loop.schedule(102); assert.equal(request.signal.aborted, false);
    if (cause === "runtime") f.runtimeAbort.abort(new Error("fixture runtime abort"));
    if (cause === "fatal") f.runtimeAbort.abort(new RevmFatalError({ kind: "source-fault" }));
    if (cause === "shutdown") stopped = f.loop.shutdown();
    if (cause === "evidence") assert(f.loop.schedulePendingEvidence(pendingEvidenceFixture(102)));
    if (cause === "source-invalid") {
      const error = Object.assign(new Error("hash is not currently canonical"), { code: -32000 });
      // Drive the real source-unavailable callback without dispatching RPC.
      assert.throws(() => request.pricingCallBackend.abortForRpcFailure(error), e => e === error);
      assert.equal(request.signal.reason, error);
    }
    assert(request.signal.aborted, "only head supersession may be deferred");
    await until(() => closing);
    assert.equal(published, false);
    stopped ??= f.loop.shutdown();
    let done = false; void stopped.then(() => { done = true; });
    await turn(); assert.equal(done, false);
    drain.resolve(); await stopped; assert.equal(done, true);
  } finally { drain.resolve(); await f.loop.shutdown(); }
});

for (const mode of ["blind", "n-minus-one", "combined", "evidence-only", "startup"] as const)
test(`preparation head-cancellation policy leaves ${mode} unchanged`, async context => {
  context.mock.method(console, "log", () => {});
  const header = deferred(); let headerControl: any;
  const f = loopFixture(() => { throw new Error("header must not reach source preparation"); }, mode === "startup");
  if (mode === "blind") Object.assign(f.deps.blind, { enabled: true });
  if (mode === "n-minus-one") Object.assign(f.deps, { nMinusOneFallbackEnabled: true });
  f.deps.frozenTopology.observeHeader = async (number, control) => {
    headerControl = control; await header.promise; control!.signal!.throwIfAborted();
    return { number, hash: hash(number), parentHash: hash(number - 1) };
  };
  let running: Promise<unknown> | undefined;
  try {
    if (mode === "combined" || mode === "evidence-only") {
      if (mode === "evidence-only") (f.loop as any).completedOrdinaryHeads.set(101, hash(101));
      assert(f.loop.schedulePendingEvidence(pendingEvidenceFixture(101)));
    } else {
      running = f.loop.runHead(101, { sourceHeadSeenAtMs: Date.now(), sourceHeadSeenAtMonotonicMs: performance.now() })
        .catch(error => error);
    }
    await until(() => headerControl !== undefined);
    const active = (f.loop as any).activePass;
    assert.equal(active.sourceNPreparation, false);
    assert.equal(active.mode, mode === "combined" || mode === "evidence-only" ? mode : "periodic");
    (f.loop as any).advanceLatestHead(102);
    assert.equal(headerControl.signal.aborted, mode !== "startup");
    // This header-only fixture has no blind audit graph/artifacts. The policy
    // assertions are complete; omit audit serialization during fixture cleanup.
    if (mode === "blind") Object.assign(f.deps.blind, { enabled: false });
    f.runtimeAbort.abort(new Error("fixture stop")); header.resolve();
    await running;
    await f.loop.shutdown();
    assert.equal(f.inputs.length, 0);
  } finally { header.resolve(); await f.loop.shutdown(); }
});

test("deferred preparation deadline still aborts queued quote work and drains before its successor", async context => {
  context.mock.method(console, "log", () => {});
  const physicalDrain = deferred(); const starts: number[] = [], requests: any[] = [];
  let transportSignal: AbortSignal | undefined, published = false, transportCalls = 0;
  const f = loopFixture(input => { starts.push(input.source.number); return {
    transport: { async simulate() { return { data: "0x" }; } }, async closeAndDrain() {},
  }; });
  Object.assign(f.deps, { passBudgetMs: 120, runtimePublicationReserveMs: 10,
    rethTransportScheduler: { async run(_lane: unknown, signal: AbortSignal) {
      transportCalls++; transportSignal = signal;
      // Do not invoke the network callback. Model physically pending work
      // which observes cancellation immediately but drains only on release.
      await physicalDrain.promise; signal.throwIfAborted();
      throw new Error("fixture expected deadline cancellation");
    } } });
  f.coordinator.prepare = async (input: any) => {
    requests.push(input);
    if (input.graph.sourceBlock !== 101) throw new Error("fixture successor reached");
    await input.pricingCallBackend.call({ to: target, data: "0x1234" });
    published = true; return completeRuntimeFixture(input.graph);
  };
  const observedAt = Date.now();
  try {
    f.loop.schedule(101, { sourceHeadSeenAtMs: observedAt, sourceHeadSeenAtMonotonicMs: performance.now() });
    await until(() => transportSignal !== undefined);
    f.loop.schedule(102);
    assert.equal(requests[0].signal.aborted, false);
    assert.equal(requests[0].deadlineAtMs, observedAt + 120);
    assert.equal(requests[0].preparationSettleDeadlineAtMs, observedAt + 110);
    await until(() => transportSignal!.aborted);
    assert(transportSignal!.reason instanceof StateCallAbortedError);
    assert.equal(published, false); assert.deepEqual(starts, [101]);
    assert.equal(requests.length, 1); assert.equal(transportCalls, 1, "no renewed budget or retry");
    // Latest observation owns a fresh head budget; no pass may start before drain.
    f.loop.schedule(103); await turn(); assert.deepEqual(starts, [101]);
    physicalDrain.resolve();
    await until(() => starts.includes(103) && (f.loop as any).activePass === null);
    assert.deepEqual(starts, [101, 103]);
    assert.deepEqual(requests.map(input => input.graph.sourceBlock), [101, 103]);
    assert.equal(published, false);
  } finally { physicalDrain.resolve(); await f.loop.shutdown(); }
});

for (const nMinusOne of [false, true]) test(`${nMinusOne ? "N-1 enumeration" : "source-N pass"} Exact retains current-N source and selected generation despite newer publication`, async () => {
  const contexts: Parameters<SourceSimulationFactory>[0][] = []; const transports: unknown[] = []; let closes = 0;
  const f = loopFixture(input => { contexts.push(input); const transport = { async simulate() { return { data: "0x" }; } };
    transports.push(transport); return { transport, async closeAndDrain() { closes++; } }; });
  const edges = twoWayPoolEdges([target, `0x${"dd".repeat(20)}`, `0x${"ee".repeat(20)}`, `0x${"ff".repeat(20)}`]);
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
      pricedTokens: new Map([[priceFundingToken, { maxBorrow: 10n ** 20n }]]) },
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

// Execute main's actual dependency expression with an isolated cache. This
// catches wiring/key drift as well as exercising the real runtime dispatch.
function liveSimRejectPredicate(cache: BlockScanSimRejectCache):
  NonNullable<BlockScanRuntimeLoopDependencies["isRouteSimRejected"]> {
  const text = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
  let expression: ts.Expression | undefined;
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && node.expression.getText(ast) === "BlockScanRuntimeLoop") {
      const deps = node.arguments?.[0];
      assert(deps && ts.isObjectLiteralExpression(deps));
      const property = deps.properties.find(p => p.name?.getText(ast) === "isRouteSimRejected");
      assert(property && ts.isPropertyAssignment(property));
      expression = property.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert(expression, "main must wire the existing rejection cache into runtime dependencies");
  return runInNewContext(ts.transpileModule(`(${expression.getText(ast)})`, {}).outputText,
    { blockScanSimRejects: cache, blockScanRouteId });
}

for (const cacheCase of ["absent", "known", "unknown", "queued", "in-flight", "fresh-cache", "cleared-cache"] as const)
for (const historicalExecutionMode of cacheCase === "known" || cacheCase === "in-flight"
  ? [undefined, "source-block"] as const : [undefined])
test(`disabled independent Exact keeps Solver strict-session wiring; sim reject policy ${cacheCase} ${historicalExecutionMode ?? "next-block"}`, async () => {
  const contexts: Parameters<SourceSimulationFactory>[0][] = []; const transports: unknown[] = []; let closes = 0;
  const f = loopFixture(input => { contexts.push(input); const transport = { async simulate() { return { data: "0x" }; } };
    transports.push(transport); return { transport, async closeAndDrain() { closes++; } }; });
  const edges = twoWayPoolEdges([
    target,
    `0x${"dd".repeat(20)}`,
    `0x${"ee".repeat(20)}`,
    `0x${"ff".repeat(20)}`,
  ]);
  const simRejects = new BlockScanSimRejectCache();
  const productionPredicate = liveSimRejectPredicate(simRejects);
  const retiredCache = new BlockScanSimRejectCache();
  const revert: SimulationResult = {
    success: false, profitToken: priceFundingToken, grossProfit: 0n, netProfit: 0n,
    gasUsed: 0n, calldata: "0x", scriptHex: "0x", revertReason: "fixture revert",
    failure: { kind: "revert", code: "TRANSACTION_REVERTED", cause: new Error("fixture revert") },
  };
  const plannedRoutes: string[] = [], solvedRoutes: string[] = [], simulatedRoutes: string[] = [];
  const enumeratedRoutes: string[] = [];
  const predicateChecks: Array<{ routeId: string; rejected: boolean }> = [];
  const atomicResults: Awaited<ReturnType<typeof maybeSubmitBlockScanAtomic>>[] = [];
  let quoteCalls = 0, finalSimCalls = 0, sourceChecks = 0;
  let activeRoute = "";
  const exactQuoteState = Object.freeze({
    async call() {
      assert(solvedRoutes.length > quoteCalls, "no pre-Solver amount quote is allowed");
      quoteCalls++;
      return "0x";
    },
  });
  const empty = exactSetHash([]);
  f.coordinator.prepare = async (input: any) => {
    f.inputs.push({ kind: "runtime", ...input });
    const pricing = pricingFixture(input.graph);
    const funding = { generation: input.graph.generation, sourceBlock: 101, sourceBlockHash: hash(101),
      coverage: { expectedKeys: [], resolvedKeys: [], unresolvedKeys: [], expectedHash: empty, resolvedHash: empty, unresolvedHash: empty },
      coverageByFundingId: new Map(), freshnessByFundingId: new Map(), sources: new Map(), borrowable: () => 0n, source: () => null };
    return { status: "complete", pricing: { ...pricing, status: "complete", issues: [] }, issues: [], timing: {},
      snapshot: { completeness: "complete", graph: input.graph, pricing, funding, generation: input.graph.generation,
        sourceBlock: 101, sourceBlockHash: hash(101) } };
  };
  let issueExactCalls = 0;
  let strictSessionCalls = 0;
  let strictSessionDeadlineAtMs = 0;
  let exactFactoryDeadlineAtMs = 0;
  let solverCalls = 0;
  const plannerCenters: bigint[] = [];
  let telemetryEnumeration = 0;
  let telemetryCoarseEnumeration = 0;
  let telemetryCoarseSelected = 0;
  let telemetryExact = 0;
  let telemetryPlanner = 0;
  let telemetrySolver = 0;
  let telemetryFinish: {
    passOutcome: string;
    passReason: string | null;
  } | null = null;
  const strictSessionFixture = Object.freeze({
    edges,
    async issueExact() {
      issueExactCalls++;
      throw new Error("disabled independent Exact must not call issueExact before Solver");
    },
    runtimeEvidenceFromPendingExecution() { return []; },
    familyIdForEdge() { return "fixture"; },
  });
  const fakePlanner = {
    setFlashLiquidity() {},
    setGraph() {},
    async planBlockScanFromSeedEdges(opp: any) {
      plannerCenters.push(opp.searchSeed.searchCenter);
      const routeId = blockScanRouteId(opp.seedEdges);
      plannedRoutes.push(routeId);
      if (cacheCase === "known" || cacheCase === "absent" || cacheCase === "cleared-cache") {
        assert(simRejects.record(routeId, revert));
        if (cacheCase === "cleared-cache") simRejects.clear();
      }
      if (cacheCase === "fresh-cache") {
        assert(retiredCache.record(routeId, revert));
        assert(retiredCache.has(routeId));
        assert(!simRejects.has(routeId), "new process cache must start empty");
      }
      if (cacheCase === "unknown") {
        const otherRoute = blockScanRouteId([...opp.seedEdges].reverse());
        assert.notEqual(otherRoute, routeId);
        assert(simRejects.record(otherRoute, revert));
      }
      return [{
        templateName: "fixture",
        root: {},
        opportunity: { ...opp, startToken: opp.flashToken, profitToken: opp.flashToken, victimAmountIn: opp.searchSeed.searchCenter },
        tokenPath: { edges: [...opp.seedEdges] },
        flashAdapterIds: ["fixture-flash"],
        flashAdapterId: "fixture-flash",
        maxFlashAmount: opp.searchSeed.maxInput,
        cycleTokens: [opp.flashToken],
        borrowableTokens: [{ token: opp.flashToken, amount: opp.searchSeed.maxInput, adapterId: "fixture-flash" }],
      }];
    },
  };
  const originalSolve = AnvilSolver.prototype.solve;
  const originalLog = console.log;
  const logs: string[] = [];
  (AnvilSolver.prototype.solve as any) = async function(plan: any, state: any, _probe: any, opts: any) {
    solverCalls++;
    assert.equal(state, exactQuoteState, "Solver must receive the source-pinned quote backend");
    assert.equal(opts.strictSession, strictSessionFixture, "Solver must receive the strict session");
    assert.equal(opts.quoteToleranceRawUnits, 1n, "live loop must forward the one-raw-unit tolerance");
    assert.equal(opts.quoteSafetyBps, undefined, "live must not add a percentage haircut");
    assert.deepEqual(opts.runtimeEvidence, []);
    const routeId = blockScanRouteId(plan.tokenPath.edges);
    solvedRoutes.push(routeId);
    await state.call();
    opts.timing.quoteMs += 1;
    opts.timing.amountPoints += 1;
    opts.timing.hopExactCalls += 2;
    opts.timing.gssPoints += 1;
    if (cacheCase === "queued") {
      assert.equal(solverCalls, 1, "the second queued route must never enter Solver");
      assert.equal(plannedRoutes.length, 2);
      assert.notEqual(routeId, plannedRoutes[1]);
      assert(!simRejects.has(plannedRoutes[1]!));
      await turn();
      assert(simRejects.record(plannedRoutes[1]!, revert));
    }
    if (cacheCase === "in-flight") {
      assert(!simRejects.has(routeId), "the route was eligible when Solver began");
      await turn();
      assert(simRejects.record(routeId, revert));
    }
    // Keep the original absent-dependency harness's non-positive result.
    if (cacheCase === "absent") return { netProfit: 0n };
    return { root: { adapterId: "skip", target: actor, children: [],
      tokenIn: priceFundingToken, tokenOut: priceFundingToken, amount: 123n, params: {} },
      profitToken: priceFundingToken, netProfit: 1n, flashAmount: 123n, templateName: "fixture" };
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  const sourceHeadSeenAtMs = Date.now();
  Object.assign(f.deps, {
    historicalExecutionMode,
    exactRefineEnabled: false,
    exactRefineHardBudgetMs: 1_000,
    solverQuoteToleranceRawUnits: 1n,
    passBudgetMs: 5_000,
    blockScanGraph: () => edges,
    blockScanPlanner: () => fakePlanner,
    formatRouteKey: (opp: any) => blockScanRouteId(opp.seedEdges),
    ...(cacheCase === "absent" ? {} : {
      isRouteSimRejected: (opp: any) => {
        const routeId = blockScanRouteId(opp.seedEdges), rejected = productionPredicate(opp);
        predicateChecks.push({ routeId, rejected });
        return rejected;
      },
    }),
    frozenTopology: { topologyKey: "fixture", async observeHeader(number: number) {
      return { number, hash: hash(number), parentHash: hash(number - 1), timestamp: 1,
        baseFeePerGas: 1n, gasUsed: 0n, gasLimit: 30_000_000n, transactionHashes: [] };
    } },
    directFinalSimulation: { concurrency: 1, async simulate(_plan: unknown, context: any) {
      assert.deepEqual(context.source, source(1));
      assert(!context.signal.aborted);
      finalSimCalls++;
      simulatedRoutes.push(activeRoute);
      return revert;
    } },
    async submitAtomic(input: Parameters<BlockScanRuntimeLoopDependencies["submitAtomic"]>[0]) {
      activeRoute = blockScanRouteId(input.opp.seedEdges);
      const result = await maybeSubmitBlockScanAtomic({ ...input,
        historicalReadOnly: historicalExecutionMode === "source-block", historicalExecutionMode,
        config: { ...resolveBlockScanAtomicPolicy({}), dryRun: true, blockScanSubmit: false, finalVerifyFloorBps: 0n },
        provider: { async send(method: string, params: unknown[]) {
          sourceChecks++;
          assert.equal(method, "eth_getBlockByNumber");
          assert.deepEqual(params, [historicalExecutionMode === "source-block" ? "0x65" : "latest", false]);
          return { number: "0x65", hash: hash(101) };
        } } as any,
        simRejects, collectBlindAudit: true,
        bundleRouter: { async submit() { throw new Error("fixture must never submit"); } },
        submissionCoordinator: { offer() { throw new Error("fixture must never submit"); } },
        strategyVersions: { strategy_view_version: "fixture", blockscan_view_hash: hash(101) },
      });
      atomicResults.push(result);
      return result;
    },
    exactQuoteStateFactory: (input: any) => {
      exactFactoryDeadlineAtMs = input.deadlineAtMs;
      return exactQuoteState;
    },
    routeTelemetry: {
      beginPass(sourceBlock: number) {
        assert.equal(sourceBlock, 101);
        return {
          recordEnumeration(opportunities: readonly any[], coarse?: readonly unknown[], selected?: number) {
            enumeratedRoutes.push(...opportunities.map(opp => blockScanRouteId(opp.seedEdges)));
            telemetryEnumeration = opportunities.length;
            telemetryCoarseEnumeration = coarse?.length ?? 0;
            telemetryCoarseSelected = selected ?? opportunities.length;
          },
          recordExact() {
            telemetryExact++;
            throw new Error("disabled Exact must not record compact exact diagnostics");
          },
          recordPlanner() {
            telemetryPlanner++;
          },
          recordSolver() {
            telemetrySolver++;
          },
          finish(input: { passOutcome: string; passReason: string | null }) {
            telemetryFinish = input;
          },
        };
      },
      recordNotStarted() {
        throw new Error("fixture starts a pass");
      },
    },
    amountReference: {
      prepare(input: any) {
        return new Map(input.opportunities.map((opp: any, index: number) => [
          opp,
          index === 1 ? 10n ** 30n : 123n,
        ]));
      },
    },
    blockScanConfig: { ...f.deps.blockScanConfig, minSpreadBps: 0, exactAdmissionSpreadBps: 0,
      // Keep enough fixture routes to test downstream selection independently
      // of the production hop-width defaults.
      hopTokensPerStep: 3, hopPoolsPerPair: 3,
      maxCandidates: cacheCase === "queued" ? 2 : 1,
      pricedTokens: new Map([[priceFundingToken, { maxBorrow: 10n ** 20n }]]) },
    refineCandidates: 10,
    strictSession: async (input: any) => {
      strictSessionCalls++;
      strictSessionDeadlineAtMs = input.control.deadlineAtMs;
      assert.deepEqual(input.source, source(1));
      assert.equal(input.simulationTransport, transports[0]);
      assert(input.requiredEdgeIds.size > 0, "real enumeration reached strict session setup");
      return strictSessionFixture;
    },
  });
  try {
    await f.loop.runHead(101, {
      sourceHeadSeenAtMs,
      sourceHeadSeenAtMonotonicMs: performance.now(),
    });
    assert.equal(strictSessionCalls, 1);
    assert.equal(issueExactCalls, 0);
    assert.equal(solverCalls, cacheCase === "known" ? 0 : 1);
    assert.equal(quoteCalls, solverCalls, "skipped routes must issue zero amount quotes");
    assert.equal(finalSimCalls, ["known", "in-flight", "absent"].includes(cacheCase) ? 0 : 1);
    assert.equal(sourceChecks, cacheCase === "known" || cacheCase === "absent" ? 0 : 1);
    assert(plannerCenters.length > 0);
    assert(plannerCenters.every(center => center === 123n), "Solver candidates must be anchored at prepared P");
    assert(strictSessionDeadlineAtMs - sourceHeadSeenAtMs >= 4_500,
      "disabled mode strict-session setup must use the full pass deadline");
    assert(exactFactoryDeadlineAtMs - sourceHeadSeenAtMs >= 4_500,
      "disabled mode quote backend setup must use the full pass deadline");
    const skip = logs.find(line => line.includes("[searcher/blockscan-exact-refine-skip]"));
    assert(skip, "disabled mode must emit an explicit skip log");
    const skipPayload = JSON.parse(skip.slice(skip.indexOf("{")));
    assert.equal(skipPayload.enabled, false);
    assert.equal(skipPayload.selected, cacheCase === "queued" ? 2 : 1);
    assert.equal(skipPayload.rejectedOverCap, 1);
    if (cacheCase !== "queued") assert(skipPayload.eligibleNotSelected > 0,
      "disabled mode must preserve coarse order and cap without promoting every valid route");
    assert.deepEqual(plannedRoutes, enumeratedRoutes.filter((_, index) => index !== 1).slice(0, skipPayload.selected),
      "cache policy must not alter natural selection, rank or refill from outside selected candidates");
    assert.equal(skipPayload.amountSource, "effective-first-edge");
    assert.equal(telemetryExact, 0, "disabled mode must not record compact Exact diagnostics");
    assert(telemetryEnumeration >= skipPayload.selected + skipPayload.rejectedOverCap);
    assert.equal(telemetryCoarseSelected, telemetryEnumeration);
    assert(telemetryCoarseEnumeration >= telemetryEnumeration);
    assert.equal(telemetryPlanner, plannerCenters.length);
    assert.equal(telemetrySolver, solverCalls);
    const telemetryFinishPayload = telemetryFinish as {
      passOutcome: string;
      passReason: string | null;
    } | null;
    assert(telemetryFinishPayload, "route telemetry pass must finish");
    assert.equal(telemetryFinishPayload.passOutcome, "ran");
    assert.equal(telemetryFinishPayload.passReason, null);
    const timing = logs.find(line => line.includes('"type":"block_scan_timing"'));
    assert(timing, "runtime must emit pass timing");
    const timingPayload = JSON.parse(timing.slice(timing.indexOf("{")));
    assert.equal(timingPayload.stages.exact_refine.status, "not-run");
    assert.equal(timingPayload.stage_timing_ms.exact_refine, 0);
    assert.equal(timingPayload.planned, plannedRoutes.length);
    assert.equal(timingPayload.planner_solver_detail.solverPlans, solverCalls);
    assert.equal(timingPayload.planner_solver_detail.solverQuoteMs, quoteCalls);
    assert.equal(timingPayload.planner_solver_detail.solverAmountPoints, quoteCalls);
    assert.equal(timingPayload.planner_solver_detail.solverHopExactCalls, quoteCalls * 2);
    assert.equal(timingPayload.planner_solver_detail.solverGssPoints, quoteCalls);
    assert.equal(timingPayload.quote_positive, cacheCase === "absent" ? 0 : solverCalls);
    const solverSkips = logs.filter(line => line.startsWith("[searcher/blockscan-solver-skip]"))
      .map(line => JSON.parse(line.slice(line.indexOf("{"))));
    assert.equal(solverSkips.length, cacheCase === "known" || cacheCase === "queued" ? 1 : 0);
    if (solverSkips.length > 0) {
      const index = cacheCase === "queued" ? 1 : 0;
      assert.deepEqual(solverSkips[0], { block: 101, sourceBlockHash: hash(101),
        targetBlock: historicalExecutionMode === "source-block" ? 101 : 102, solverIndex: index,
        routeId: plannedRoutes[index], stage: "planner_solver", reason: "sim_revert_seen_this_live" });
      assert(!solvedRoutes.includes(plannedRoutes[index]!));
      assert(!simulatedRoutes.includes(plannedRoutes[index]!));
    }
    if (cacheCase === "absent") {
      assert.equal(f.deps.isRouteSimRejected, undefined);
      assert(simRejects.has(plannedRoutes[0]!));
    } else {
      assert.deepEqual(predicateChecks, plannedRoutes.map((routeId, index) => ({ routeId,
        rejected: cacheCase === "known" || (cacheCase === "queued" && index === 1) })));
    }
    assert.equal(atomicResults.length, sourceChecks);
    if (cacheCase === "known") {
      // Existing aggregate fallback reports absence of positive quotes, not
      // the per-route policy cause. No Solver/sim/EV execution is implied.
      assert.equal(timingPayload.decision, "no_positive_quote");
      assert.equal(timingPayload.first_solver_started_at_ms, null);
      assert.equal(timingPayload.stages.planner_solver.status, "ran");
      assert.equal(timingPayload.stages.final_sim.status, "not-run");
      assert.equal(timingPayload.stages.ev.status, "not-run");
    }
    for (const result of atomicResults) {
      assert(!result.submitted);
      assert.equal(result.decision, cacheCase === "in-flight" ? "sim_revert_seen_this_live" : "sim_revert");
      assert.equal(result.finalSimStatus, cacheCase === "in-flight" ? "not-run" : "failed");
      assert.equal(result.audit?.simulation.executed, cacheCase !== "in-flight");
      assert.equal(result.audit?.ev.executionStatus, "not_run");
      assert.equal(result.audit?.ev.reason, result.decision);
    }
    assert.equal(closes, 1);
  } finally {
    (AnvilSolver.prototype.solve as any) = originalSolve;
    console.log = originalLog;
    await f.loop.shutdown();
  }
});

test("Anvil preparation belongs to the pass, while cancelled leases drain before worker reuse", async () => {
  const text = readFileSync(new URL("../blockscan-runtime-loop.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("blockscan-runtime-loop.ts", text, ts.ScriptTarget.Latest, true);
  const names = new Set(["ensureExecutionWorkerForked", "amountWorkers", "limitAmountTrials", "simulateAmount"]);
  const statements: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d =>
      ts.isIdentifier(d.name) && names.has(d.name.text))) statements.push(node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.equal(statements.length, 4);
  const js = ts.transpileModule(`(function() { ${statements.join("\n")}\n return simulateAmount; }).call(owner)`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const cancelDuringPreparation of [false, true]) {
    const pass = new AbortController(), a = new AbortController(), b = new AbortController(), gate = deferred();
    const preparations = new Map(); let forks = 0, simulations = 0, stops = 0, settled = false;
    const worker = { state: { stop() { stops++; }, async stopAndWait() {} },
      simulator: { async simulate() { simulations++; return { success: true }; } } };
    const deadlineAtMs = Date.now() + 10000;
    const simulate = runInNewContext(js, {
      owner: { deps: { solverQuoteConcurrency: 1, isShuttingDown: () => false } },
      directFinalSimulation: undefined, blockScanExecutionWorkers: [worker], allExecutionWorkers: [worker],
      runtimeSourceBlock: 101, exactSourceBlockHash: hash(101), exactSource: source(1),
      backgroundFinalSimForks: preparations, passSignal: pass.signal, passDeadlineAtMs: deadlineAtMs,
      createTrialLimiter, startBlockScanBackgroundFork,
      async forkExecutionWorker(_worker: unknown, _index: number, input: any) {
        forks++;
        if (cancelDuringPreparation && forks === 1) await gate.promise;
        input.signal.throwIfAborted();
      },
    });
    const first = simulate({}, { signal: a.signal, deadlineAtMs }).finally(() => { settled = true; });
    const reason = new Error("first search cancelled after another coarse trial failed");
    if (cancelDuringPreparation) {
      const rejected = assert.rejects(first, error => error === reason);
      await until(() => forks === 1); a.abort(reason); await turn();
      assert(!settled, "cancelled preparation is still owned until its physical drain settles");
      gate.resolve(); await rejected;
    } else {
      await first; a.abort(reason);
    }
    assert(!b.signal.aborted);
    await simulate({}, { signal: b.signal, deadlineAtMs });
    assert.equal(forks, cancelDuringPreparation ? 2 : 1);
    assert.equal(simulations, cancelDuringPreparation ? 1 : 2);
    assert.equal(stops > 0, cancelDuringPreparation);
    await Promise.all([...preparations.values()].map(p => p.close(new Error("test finished"))));
  }
});

function liveSimAmountFactory(): NonNullable<BlockScanRuntimeLoopDependencies["amountSelectorFactory"]> {
  const text = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
  let expression: ts.Expression | undefined;
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && node.expression.getText(ast) === "BlockScanRuntimeLoop") {
      const deps = node.arguments?.[0]; assert(deps && ts.isObjectLiteralExpression(deps));
      const property = deps.properties.find(p => p.name?.getText(ast) === "amountSelectorFactory");
      assert(property && ts.isPropertyAssignment(property)); expression = property.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast); assert(expression);
  return runInNewContext(ts.transpileModule(`(${expression.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, { createBlockScanSimAmountSelector, createBlockScanLiveAmountSelectorFactory,
    blockScanSolverSearch: { quoteConcurrency: 3 }, blockScanAmountTrials: createTrialLimiter(3),
    executionIdentity: { executor: actor }, console });
}

for (const backend of ["direct", "anvil"] as const)
for (const outcome of ["positive", "nonpositive", "source-fault", "cancel"] as const)
for (const stopAtSizing of [false, true])
test(`ordinary live factory selects actual sim profit through runtime (${backend}, ${outcome}, sizingOnly=${stopAtSizing})`, async () => {
  const f = loopFixture(() => ({ transport: { async simulate() { return { data: "0x" }; } }, async closeAndDrain() {} }));
  const edges = twoWayPoolEdges([target, `0x${"dd".repeat(20)}`]);
  const trialAmounts: bigint[] = [], finalAmounts: bigint[] = [], logs: string[] = [];
  let active = 0, peak = 0, trialForks = 0, finalForks = 0, retired = 0;
  const fault = new Error("fixture amount source failure");
  const result = (profit: bigint): SimulationResult => ({ success: profit > 0n, profitToken: priceFundingToken,
    netProfit: profit, grossProfit: profit, gasUsed: 10n, calldata: "0x", scriptHex: "0x" });
  const trial = async (plan: any, signal: AbortSignal) => {
    trialAmounts.push(plan.flashAmount); peak = Math.max(peak, ++active);
    try {
      if (outcome === "cancel") f.runtimeAbort.abort(new Error("fixture new head"));
      await turn(); signal.throwIfAborted();
      if (outcome === "source-fault") throw fault;
      return result(outcome === "nonpositive" ? 0n : plan.flashAmount === 1230n ? 55n : 1n);
    } finally { active--; }
  };
  const final = async (plan: any) => {
    assert.equal(active, 0, "this single candidate's search must settle before final verification");
    finalAmounts.push(plan.flashAmount);
    return { ...result(0n), failure: { kind: "revert", code: 3, cause: new Error("independent final revert") } };
  };
  const worker = (kind: "trial" | "final"): any => ({
    state: { provider: {}, async forkAt() { if (kind === "trial") trialForks++; else finalForks++; },
      stop() { if (kind === "trial") retired++; }, async stopAndWait() {} }, solver: {},
    simulator: { async simulate(plan: any, signal: AbortSignal) { return kind === "trial" ? trial(plan, signal) : final(plan); } },
  });
  const session: any = {
    source: source(1), edges, runtimeEvidenceFromPendingExecution: () => [], familyIdForEdge: () => "fixture",
    blocksPrefixInversion: () => false,
    async issueExact(input: any) { return { amountIn: input.amountIn, amountOut: input.amountIn + 10n }; },
    fundingActionIds: () => ["fixture-flash"],
    buildExecution: () => ({ status: "resolved", fragment: { nodes: [], requirements: [] } }),
    buildFundingRoot(input: any) { return { adapterId: "skip", target: actor, tokenIn: priceFundingToken,
      tokenOut: priceFundingToken, amount: input.amount, children: [], params: {} }; },
  };
  f.coordinator.prepare = async (input: any) => completeRuntimeFixture(input.graph);
  const originalSolve = AnvilSolver.prototype.solve, originalLog = console.log;
  AnvilSolver.prototype.solve = async () => { throw new Error("ordinary live must not call old Solver"); };
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  const cache = new BlockScanSimRejectCache();
  Object.assign(f.deps, {
    exactRefineEnabled: false, solverGssMaxTries: 0, solverAmountGrid: "multiples", solverQuoteConcurrency: 3,
    amountSelectorFactory: liveSimAmountFactory(), executionWorkers: [worker("trial")],
    finalSimulationWorkers: backend === "anvil" ? [worker("final")] : [],
    ...(backend === "direct" ? { directFinalSimulation: { concurrency: 1, async simulate(plan: any, context: any) {
      assert.deepEqual(context.source, source(1)); assert.equal(context.header.hash, hash(101));
      assert.equal(context.header.timestamp, 1000); assert(!context.signal.aborted);
      return plan.netProfit === 0n ? trial(plan, context.signal) : final(plan);
    } } } : {}),
    frozenTopology: { topologyKey: "fixture", async observeHeader(number: number) {
      return { number, hash: hash(number), parentHash: hash(number - 1), timestamp: 1000, baseFeePerGas: 1n,
        gasUsed: 0n, gasLimit: 30_000_000n, transactionHashes: [] };
    } },
    strictSession: async () => session,
    exactQuoteStateFactory: () => ({ async call() { throw new Error("must use strict quotes"); } }),
    blockScanGraph: () => edges,
    blockScanPlanner: () => ({ setFlashLiquidity() {}, setGraph() {}, async planBlockScanFromSeedEdges(opp: any) {
      return [{ opportunity: { ...opp, profitToken: opp.flashToken }, tokenPath: { edges: [...opp.seedEdges] },
        templateName: "fixture", maxFlashAmount: 123000n, flashAdapterIds: ["fixture-flash"],
        flashAdapterId: "fixture-flash", cycleTokens: [opp.flashToken], borrowableTokens: [] }];
    } }),
    amountReference: { prepare(input: any) { return new Map(input.opportunities.map((opp: any) => [opp, 123n])); } },
    blockScanConfig: { ...f.deps.blockScanConfig, minSpreadBps: 0, exactAdmissionSpreadBps: 0,
      hopTokensPerStep: 3, hopPoolsPerPair: 3, maxCandidates: 1,
      pricedTokens: new Map([[priceFundingToken, { maxBorrow: 10n ** 20n }]]) },
    async submitAtomic(input: Parameters<BlockScanRuntimeLoopDependencies["submitAtomic"]>[0]) {
      if (finalAmounts.length === 0) {
        assert.equal(input.resolved.flashAmount, 1230n); assert.equal(input.resolved.netProfit, 55n);
      }
      return maybeSubmitBlockScanAtomic({ ...input, collectBlindAudit: true, simRejects: cache,
        config: { ...resolveBlockScanAtomicPolicy({}), dryRun: true, blockScanSubmit: false, finalVerifyFloorBps: 0n },
        provider: { async send() { return { number: "0x65", hash: hash(101) }; } } as any,
        bundleRouter: { async submit() { throw new Error("must not submit"); } },
        submissionCoordinator: { offer() { throw new Error("must not submit"); } },
        strategyVersions: { strategy_view_version: "fixture", blockscan_view_hash: hash(101) },
      });
    },
  });
  try {
    type Diagnostic = NonNullable<Parameters<BlockScanRuntimeLoop["runHead"]>[2]>;
    let completion: Parameters<Diagnostic["onComplete"]>[0] | undefined, enumerationCalls = 0;
    const routeRecords: Array<Parameters<NonNullable<Diagnostic["onSolver"]>>[0]> = [];
    if (stopAtSizing) Object.assign(f.deps, { diagnosticForHead: (): Diagnostic => ({
      through: "solver", onSnapshot() {}, onEnumeration() { enumerationCalls++; },
      onSolver(value) { routeRecords.push(value); }, onComplete(value) { completion = value; },
    }) });
    const observation = { sourceHeadSeenAtMs: Date.now(), sourceHeadSeenAtMonotonicMs: performance.now() };
    const run = stopAtSizing
      ? (f.loop.schedule(101, observation), f.loop.waitForIdle())
      : f.loop.runHead(101, observation);
    if (outcome === "cancel" && !stopAtSizing) await assert.rejects(run, /fixture new head/);
    else await run;
    assert.deepEqual(trialAmounts, outcome === "positive" ? [123n, 1230n, 12300n, 123000n] : [123n]);
    assert.deepEqual(finalAmounts, outcome === "positive" && !stopAtSizing ? [1230n, 123n, 12300n] : []);
    assert.equal(active, 0); assert.equal(peak, backend === "direct" && outcome === "positive" ? 3 : 1);
    assert.equal(trialForks, backend === "anvil" ? 1 : 0);
    assert.equal(finalForks, backend === "anvil" ? 1 : 0);
    if (backend === "anvil" && ["cancel", "source-fault"].includes(outcome)) assert(retired > 0);
    if (outcome === "nonpositive") {
      assert(logs.some(l => l.includes("sim_amount_no_opportunity")));
      assert(!logs.some(l => l.includes("solve_failed")));
    }
    if (outcome === "source-fault") {
      assert(logs.some(l => l.includes("solve_failed") && l.includes(fault.message)));
      assert(!logs.some(l => l.includes("sim_amount_no_opportunity")));
    }
    if (stopAtSizing) {
      assert.equal(enumerationCalls, 1, "diagnostic retains natural production enumeration");
      assert.equal(routeRecords.length, 1, "real worker reports every outcome, including failure/cancel");
      assert.equal(routeRecords[0]!.maxFlashAmount, 123000n);
      assert.equal(routeRecords[0]!.opportunity.searchSeed.searchCenter, 123n);
      assert.equal(routeRecords[0]!.timing.amountPoints, outcome === "positive" ? 4 : 1);
      assert.equal(completion!.atomicResults.length, 0, "sizing stop never enters independent final sim/EV");
      assert.equal(completion!.timing.finalSimMs, 0);
      assert.equal(completion!.timing.evMs, 0);
      assert.equal(completion!.detail!.solverPlans, 1);
      assert(completion!.detail!.solverWallMs >= 0);
      assert(completion!.timing.plannerSolverMs >= completion!.detail!.solverWallMs);
    }
    assert(!logs.some(l => l.includes("ordinary live must not call old Solver")));
  } finally {
    AnvilSolver.prototype.solve = originalSolve; console.log = originalLog; await f.loop.shutdown();
  }
});

for (const mode of ["live", "shared-diagnostic", "independent", "observer-throws",
  "prerequisite-timeout", "sizing-timeout", "parent-abort", "new-head", "drain-timeout"] as const)
test(`scheduled sizing budget controls survive long prerequisites: ${mode}`, async context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const start = Date.now(), independent = mode !== "live" && mode !== "shared-diagnostic";
  const contexts: Parameters<SourceSimulationFactory>[0][] = [], c = clients();
  const quoteGate = deferred(); let quoteEntered = false, settled = false;
  const logs: string[] = [];
  context.mock.method(console, "log", (line: string) => { logs.push(line); });
  context.mock.method(console, "warn", () => {});
  const f = loopFixture(input => { contexts.push(input); return c.factory(input); });
  const edges = twoWayPoolEdges([target, `0x${"dd".repeat(20)}`]);
  let exactBackend: PinnedRethQuoteBackend | undefined;
  let sessionRequest: any, solverDeadline: number | undefined, trialDeadline: number | undefined;
  let sessionCalls = 0, quoteCalls = 0;
  const expectedDeadline = start + (independent ? 89_000 : 60_000);
  const session: any = {
    source: source(), edges, runtimeEvidenceFromPendingExecution: () => [], familyIdForEdge: () => "fixture",
    blocksPrefixInversion: () => false,
    async issueExact(input: any) {
      quoteCalls++;
      solverDeadline = input.control.deadlineAtMs;
      assert.equal(solverDeadline, expectedDeadline, "quotes receive the actual stage deadline, not the lifetime ceiling");
      if (!quoteEntered) {
        quoteEntered = true;
        if (["sizing-timeout", "parent-abort", "new-head"].includes(mode)) await quoteGate.promise;
        else context.mock.timers.tick(independent ? 2_000 : 500);
      }
      input.control.signal.throwIfAborted();
      // The real pinned backend's scope and producer cache must remain usable
      // past the original head deadline; no cache miss is dispatched as RPC.
      assert.equal(await exactBackend!.callCached({ to: target, data: "0x" }, input.control), undefined);
      const pricingBackend = f.inputs.find(i => i.kind === "runtime").pricingCallBackend;
      assert.equal(await pricingBackend.callCached({ to: target, data: "0x" }, input.control), undefined);
      await sessionRequest.simulationTransport.simulate({ ...invocation(), control: input.control });
      assert.equal(c.made[0]!.controls.at(-1).deadlineAtMs, expectedDeadline,
        "the real SourceSimulationWork owner must not clamp trials to preparation time");
      return { amountIn: input.amountIn, amountOut: input.amountIn + 10n };
    },
    fundingActionIds: () => ["fixture-flash"],
    buildExecution: () => ({ status: "resolved", fragment: { nodes: [], requirements: [] } }),
    buildFundingRoot(input: any) { return { adapterId: "skip", target: actor, tokenIn: priceFundingToken,
      tokenOut: priceFundingToken, amount: input.amount, children: [], params: {} }; },
  };
  f.coordinator.prepare = async (input: any) => {
    f.inputs.push({ kind: "runtime", ...input });
    assert.equal(input.deadlineAtMs, start + 60_000, "prerequisite control is never widened");
    context.mock.timers.tick(50_000);
    await input.simulationTransport.simulate({ ...invocation(), control: { signal: input.signal, deadlineAtMs: input.deadlineAtMs } });
    assert.equal(c.made[0]!.controls[0].deadlineAtMs, start + 60_000);
    return completeRuntimeFixture(input.graph);
  };
  type Diagnostic = NonNullable<Parameters<BlockScanRuntimeLoop["runHead"]>[2]>;
  let completion: Parameters<Diagnostic["onComplete"]>[0] | undefined;
  Object.assign(f.deps, {
    passBudgetMs: 60_000, exactRefineEnabled: false,
    solverAmountGrid: "multiples", solverGssMaxTries: 0, solverQuoteConcurrency: 1,
    amountSelectorFactory: liveSimAmountFactory(), finalSimulationWorkers: [],
    diagnosticForHead: mode === "live" ? undefined : () => ({ through: "solver",
      ...(independent ? { sizingBudgetMs: 30_000 } : {}),
      ...(mode === "observer-throws" ? { onSizingStart() { throw new Error("observer is not the budget owner"); } } : {}),
      onSnapshot() {}, onEnumeration() {}, onComplete(value: Parameters<Diagnostic["onComplete"]>[0]) { completion = value; } }),
    directFinalSimulation: { concurrency: 1, async simulate(_plan: any, control: any) {
      trialDeadline = control.deadlineAtMs; assert.equal(trialDeadline, expectedDeadline);
      control.signal.throwIfAborted();
      if (mode === "drain-timeout") c.made[0]!.hold = true;
      return { success: true, profitToken: priceFundingToken, grossProfit: 0n, netProfit: 0n, gasUsed: 1n,
        calldata: "0x", scriptHex: "0x" };
    } },
    frozenTopology: { topologyKey: "fixture", async observeHeader(number: number) {
      return { number, hash: hash(number), parentHash: hash(number - 1), timestamp: 1000,
        baseFeePerGas: 1n, gasUsed: 0n, gasLimit: 30_000_000n, transactionHashes: [] };
    } },
    blockScanGraph: () => edges,
    blockScanPlanner: () => ({ setFlashLiquidity() {}, setGraph() {}, async planBlockScanFromSeedEdges(opp: any) {
      assert.equal(Date.now(), start + 59_000, "all prerequisite setup precedes the real sizing boundary");
      return [{ opportunity: { ...opp, profitToken: opp.flashToken }, tokenPath: { edges: [...opp.seedEdges] },
        templateName: "fixture", maxFlashAmount: 123n, flashAdapterIds: ["fixture-flash"],
        flashAdapterId: "fixture-flash", cycleTokens: [opp.flashToken], borrowableTokens: [] }];
    } }),
    exactQuoteStateFactory: (input: any) => {
      assert.equal(input.deadlineAtMs, start + (independent ? 90_000 : 60_000));
      return exactBackend = new PinnedRethQuoteBackend(f.deps.rpcUrl, input.sourceBlockHash, input);
    },
    strictSession: async (input: any) => {
      sessionCalls++; sessionRequest = input;
      assert.equal(input.control.deadlineAtMs, start + 60_000);
      assert(Object.isFrozen(input.control));
      context.mock.timers.tick(mode === "prerequisite-timeout" ? 10_000 : 9_000);
      return session;
    },
    amountReference: { prepare(input: any) { return new Map(input.opportunities.map((opp: any) => [opp, 123n])); } },
    blockScanConfig: { ...f.deps.blockScanConfig, minSpreadBps: 0, exactAdmissionSpreadBps: 0,
      maxCandidates: 1, pricedTokens: new Map([[priceFundingToken, { maxBorrow: 10n ** 20n }]]) },
  });
  try {
    f.loop.schedule(101, { sourceHeadSeenAtMs: start, sourceHeadSeenAtMonotonicMs: performance.now() });
    const pending = f.loop.waitForIdle().finally(() => { settled = true; });
    if (["sizing-timeout", "parent-abort", "new-head"].includes(mode)) {
      // Advance microtasks only: all phase time is controlled by the test clock.
      while (!quoteEntered && !settled) await turn();
      assert(quoteEntered);
      if (mode === "sizing-timeout") context.mock.timers.tick(30_000);
      if (mode === "parent-abort") f.runtimeAbort.abort(new Error("fixture parent abort"));
      if (mode === "new-head") { f.loop.schedule(102); Object.assign(f.deps, { enabled: false }); }
      assert(contexts[0]!.control.signal.aborted, "phase timeout, parent and new-head cancellation reach the source owner");
      await turn(); assert.equal(settled, false, "scheduler cannot finish before in-flight quote drains");
      quoteGate.resolve();
    }
    if (mode === "drain-timeout") {
      while (c.made[0]?.closes !== 1 && !settled) await turn();
      assert.equal(settled, false);
      context.mock.timers.tick(expectedDeadline - Date.now());
      assert(contexts[0]!.control.signal.aborted);
      await turn(); assert.equal(settled, false, "drain stays joined after its sizing deadline");
      c.made[0]!.release();
    }
    await pending;
    assert.equal(sessionCalls, 1, "no second preparation/session or duplicate dispatch");
    assert.equal(contexts.length, 1, "source authority is never rebound");
    assert.equal(c.made[0]!.closes, 1);
    const timing = logs.find(line => line.includes('"type":"block_scan_timing"'))!;
    const receipt = JSON.parse(timing.slice(timing.indexOf("{")));
    assert.equal(completion?.outcome ?? receipt.outcome,
      mode.endsWith("timeout") ? "budget_exceeded" : ["parent-abort", "new-head"].includes(mode) ? "stale_state" : "ran");
    if (mode === "prerequisite-timeout") assert.equal(quoteCalls, 0, "expired preparation never renews sizing");
    else assert.equal(solverDeadline, expectedDeadline);
    if (["live", "shared-diagnostic", "independent", "observer-throws", "drain-timeout"].includes(mode)) assert.equal(trialDeadline, expectedDeadline);
    if (mode === "new-head") assert.equal(completion!.reason, "source_head_superseded");
    const aborted = contexts[0]!.control.signal.aborted;
    context.mock.timers.tick(100_000);
    assert.equal(contexts[0]!.control.signal.aborted, aborted, "diagnostic phase timer must be cleared after drain");
  } finally { quoteGate.resolve(); c.made[0]?.release(); await f.loop.shutdown(); }
});

test("sizing override is admitted only for bounded, non-startup solver diagnostics", async () => {
  for (const through of ["prices", "enumerate", "ev"] as const) {
    const f = loopFixture(() => { throw new Error("invalid diagnostic allocated a source"); });
    await assert.rejects(f.loop.runHead(101, { sourceHeadSeenAtMs: Date.now(), sourceHeadSeenAtMonotonicMs: performance.now() },
      { through, sizingBudgetMs: 1000, onSnapshot() {}, onEnumeration() {}, onComplete() {} }), /sizingBudgetMs/);
    await f.loop.shutdown();
  }
  for (const budget of [0, -1, NaN, Infinity, 3_600_001, 1000]) {
    const f = loopFixture(() => { throw new Error("invalid diagnostic allocated a source"); }, budget === 1000);
    await assert.rejects(f.loop.runHead(101, { sourceHeadSeenAtMs: Date.now(), sourceHeadSeenAtMonotonicMs: performance.now() },
      { through: "solver", sizingBudgetMs: budget, onSnapshot() {}, onEnumeration() {}, onComplete() {} }), /sizingBudgetMs/);
    await f.loop.shutdown();
  }
});

test("disabled independent Exact checks deadline after setup before Planner/Solver", async () => {
  const contexts: Parameters<SourceSimulationFactory>[0][] = []; const transports: unknown[] = []; let closes = 0;
  const f = loopFixture(input => { contexts.push(input); const transport = { async simulate() { return { data: "0x" }; } };
    transports.push(transport); return { transport, async closeAndDrain() { closes++; } }; });
  const edges = twoWayPoolEdges([target, `0x${"dd".repeat(20)}`]);
  const exactQuoteState = Object.freeze({ async call() { throw new Error("no pre-Solver quote"); } });
  const empty = exactSetHash([]);
  f.coordinator.prepare = async (input: any) => {
    f.inputs.push({ kind: "runtime", ...input });
    const pricing = pricingFixture(input.graph);
    const funding = { generation: input.graph.generation, sourceBlock: 101, sourceBlockHash: hash(101),
      coverage: { expectedKeys: [], resolvedKeys: [], unresolvedKeys: [], expectedHash: empty, resolvedHash: empty, unresolvedHash: empty },
      coverageByFundingId: new Map(), freshnessByFundingId: new Map(), sources: new Map(), borrowable: () => 0n, source: () => null };
    return { status: "complete", pricing: { ...pricing, status: "complete", issues: [] }, issues: [], timing: {},
      snapshot: { completeness: "complete", graph: input.graph, pricing, funding, generation: input.graph.generation,
        sourceBlock: 101, sourceBlockHash: hash(101) } };
  };
  let strictSessionCalls = 0;
  let plannerCalls = 0;
  let solverCalls = 0;
  const strictSessionFixture = Object.freeze({
    async issueExact() {
      throw new Error("disabled independent Exact must not issue pre-Solver quotes");
    },
    runtimeEvidenceFromPendingExecution() { return []; },
    familyIdForEdge() { return "fixture"; },
  });
  const fakePlanner = {
    setFlashLiquidity() {},
    setGraph() {},
    async planBlockScanFromSeedEdges(opp: any) {
      plannerCalls++;
      return [{
        templateName: "fixture",
        root: {},
        opportunity: { ...opp, startToken: opp.flashToken, profitToken: opp.flashToken, victimAmountIn: opp.searchSeed.searchCenter },
        tokenPath: { edges: [...opp.seedEdges] },
        flashAdapterIds: ["fixture-flash"],
        flashAdapterId: "fixture-flash",
        maxFlashAmount: opp.searchSeed.maxInput,
        cycleTokens: [opp.flashToken],
        borrowableTokens: [{ token: opp.flashToken, amount: opp.searchSeed.maxInput, adapterId: "fixture-flash" }],
      }];
    },
  };
  const originalSolve = AnvilSolver.prototype.solve;
  const originalLog = console.log;
  const originalDateNow = Date.now;
  const logs: string[] = [];
  let nowMs = originalDateNow();
  (AnvilSolver.prototype.solve as any) = async function() {
    solverCalls++;
    return { netProfit: 0n };
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  Date.now = () => nowMs;
  const sourceHeadSeenAtMs = nowMs;
  Object.assign(f.deps, {
    exactRefineEnabled: false,
    passBudgetMs: 5_000,
    blockScanGraph: () => edges,
    blockScanPlanner: () => fakePlanner,
    exactQuoteStateFactory: () => exactQuoteState,
    amountReference: {
      prepare(input: any) {
        return new Map(input.opportunities.map((opp: any) => [opp, 123n]));
      },
    },
    blockScanConfig: { ...f.deps.blockScanConfig, minSpreadBps: 0, exactAdmissionSpreadBps: 0,
      maxCandidates: 1, pricedTokens: new Map([[priceFundingToken, { maxBorrow: 10n ** 20n }]]) },
    strictSession: async () => {
      strictSessionCalls++;
      nowMs = sourceHeadSeenAtMs + 5_001;
      return strictSessionFixture;
    },
  });
  try {
    await f.loop.runHead(101, {
      sourceHeadSeenAtMs,
      sourceHeadSeenAtMonotonicMs: performance.now(),
    });
    assert.equal(strictSessionCalls, 1);
    assert.equal(plannerCalls, 0, "expired off-mode pass must not start Planner");
    assert.equal(solverCalls, 0, "expired off-mode pass must not start Solver");
    const skip = logs.find(line => line.includes("[searcher/blockscan-exact-refine-skip]"));
    assert(skip, "disabled mode still logs local selection before the deadline stop");
    const timing = logs.find(line => line.includes('"type":"block_scan_timing"'));
    assert(timing, "runtime must emit pass timing");
    const timingPayload = JSON.parse(timing.slice(timing.indexOf("{")));
    assert.equal(timingPayload.outcome, "budget_exceeded");
    assert.equal(timingPayload.decision, "post_refinement_deadline");
    assert.equal(timingPayload.stages.exact_refine.status, "not-run");
    assert.equal(timingPayload.stages.planner_solver.status, "not-run");
    assert.equal(closes, 1);
  } finally {
    Date.now = originalDateNow;
    (AnvilSolver.prototype.solve as any) = originalSolve;
    console.log = originalLog;
    await f.loop.shutdown();
  }
});

test("production call sites carry transport rather than a constructor-bound fallback", () => {
  const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const loop = readFileSync(new URL("../blockscan-runtime-loop.ts", import.meta.url), "utf8");
  assert.doesNotMatch(main, /createRevmStrictSimulationTransport\(/);
  assert.match(main, /const quoteTarget = reuse\?\.quoteGraph \?\? pricing/);
  assert.match(main, /quoteTarget\.sourceBlockHash[\s\S]*?generation: quoteTarget\.generation/);
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
