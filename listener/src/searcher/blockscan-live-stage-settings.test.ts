import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createBlockScanLiveAmountSelectorFactory, resolveBlockScanLiveStageSettings } from "./main.js";
import { RethTransportScheduler } from "./reth-transport-scheduler.js";
import type { CandidatePlan } from "./planner/planner.js";
import type { SolveOptions, Solver } from "./solver/solver.js";
import type { SimulationResult } from "./simulator/botvm-simulator.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";

test("live stage defaults include the original budgets, worker counts and 4+16 transport", () => {
  assert.deepEqual(resolveBlockScanLiveStageSettings({}), {
    passBudgetMs: 11000, largeGraphPassBudgetMs: 30000, largeGraphEdgeThreshold: 20000,
    startupWarmBudgetMs: 300000, hotPricingFamilyBudgetMs: 5000, runtimePublicationReserveMs: 1500,
    solveReserveMs: 8000, solveConcurrency: 4, finalSimulationConcurrency: 1, sourceSimulationTimeoutMs: 60000,
    refineCandidates: 512, exactRefineHardBudgetMs: 4000, exactConcurrency: 512,
    exactProbeTimeoutMs: 4000, exactRpcBatchSize: 64, exactRpcBatchConcurrency: 16,
    stateRpcBatchConcurrency: 4, transport: { capacity: 20, producerReserved: 4 },
    solverSearch: { amountGrid: "multiples", gridHalfWidth: 2, gssMaxTries: 8,
      quoteConcurrency: 16, quoteToleranceRawUnits: 0n },
  });
});

test("all stage overrides are forwarded without changing the independent core configuration", () => {
  const env = Object.freeze({
    SEARCHER_BLOCKSCAN_PASS_BUDGET_MS: "12345.9", SEARCHER_BLOCKSCAN_LARGE_GRAPH_PASS_BUDGET_MS: "45678.9",
    SEARCHER_BLOCKSCAN_LARGE_GRAPH_EDGE_THRESHOLD: "23456.9", SEARCHER_BLOCKSCAN_STARTUP_PREWARM_BUDGET_MS: "345678",
    SEARCHER_BLOCKSCAN_STATE_HOT_FAMILY_BUDGET_MS: "5678.9", SEARCHER_BLOCKSCAN_RUNTIME_PUBLICATION_RESERVE_MS: "2345.9",
    SEARCHER_BLOCKSCAN_SOLVE_RESERVE_MS: "6789.9", SEARCHER_BLOCKSCAN_SOLVE_CONCURRENCY: "6.9",
    SEARCHER_BLOCKSCAN_FINAL_SIM_CONCURRENCY: "3.9", SEARCHER_BLOCKSCAN_REFINE_CANDIDATES: "600.9",
    SEARCHER_BLOCKSCAN_EXACT_REFINE_HARD_BUDGET_MS: "6789.9", SEARCHER_BLOCKSCAN_EXACT_CONCURRENCY: "9.9",
    SEARCHER_BLOCKSCAN_EXACT_PROBE_TIMEOUT_MS: "3456.9", SEARCHER_BLOCKSCAN_EXACT_RPC_BATCH_SIZE: "32.9",
    SEARCHER_BLOCKSCAN_EXACT_RPC_BATCH_CONCURRENCY: "7.9", SEARCHER_BLOCKSCAN_STATE_RPC_BATCH_CONCURRENCY: "3",
    SEARCHER_BLOCKSCAN_SOLVER_AMOUNT_GRID: "geometric", SEARCHER_BLOCKSCAN_SOLVER_GRID_HALF_WIDTH: "3",
    SEARCHER_BLOCKSCAN_SOLVER_GSS_MAX_TRIES: "12", SEARCHER_BLOCKSCAN_SOLVER_QUOTE_CONCURRENCY: "5",
    SEARCHER_BLOCKSCAN_QUOTE_TOLERANCE_ENABLED: "1", SEARCHER_BLOCKSCAN_SCAN_BUDGET_MS: "not a stage setting",
    SEARCHER_REVM_TIMEOUT_MS: "1234",
  });
  assert.deepEqual(resolveBlockScanLiveStageSettings(env, 700), {
    passBudgetMs: 12345, largeGraphPassBudgetMs: 45678, largeGraphEdgeThreshold: 23456,
    startupWarmBudgetMs: 345678, hotPricingFamilyBudgetMs: 5678, runtimePublicationReserveMs: 2345,
    solveReserveMs: 6789, solveConcurrency: 6, finalSimulationConcurrency: 3, sourceSimulationTimeoutMs: 1234,
    refineCandidates: 700, exactRefineHardBudgetMs: 6789, exactConcurrency: 9,
    exactProbeTimeoutMs: 3456, exactRpcBatchSize: 32, exactRpcBatchConcurrency: 7,
    stateRpcBatchConcurrency: 3, transport: { capacity: 10, producerReserved: 3 },
    solverSearch: { amountGrid: "geometric", gridHalfWidth: 3, gssMaxTries: 12,
      quoteConcurrency: 5, quoteToleranceRawUnits: 1n },
  });
});

test("source-simulation timeout preserves the live Number parser; validation remains with its owner", () => {
  for (const value of ["", "0", "-1", "1.5", "60000", "NaN", "Infinity"]) {
    assert.equal(resolveBlockScanLiveStageSettings({ SEARCHER_REVM_TIMEOUT_MS: value }).sourceSimulationTimeoutMs, Number(value));
  }
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  const benchmark = readFileSync(new URL("../../benchmarks/live-stage.ts", import.meta.url), "utf8");
  assert.match(source, /timeoutMs: blockScanStageSettings\.sourceSimulationTimeoutMs/);
  assert.match(benchmark, /timeoutMs: settings\.sourceSimulationTimeoutMs/);
});

test("finite clamped settings keep empty/negative/fractional and nonfinite behavior", () => {
  const fields = [
    ["PASS_BUDGET_MS", "passBudgetMs", 11000, 1],
    ["LARGE_GRAPH_EDGE_THRESHOLD", "largeGraphEdgeThreshold", 20000, 1],
    ["SOLVE_RESERVE_MS", "solveReserveMs", 8000, 0],
    ["SOLVE_CONCURRENCY", "solveConcurrency", 4, 1],
    ["FINAL_SIM_CONCURRENCY", "finalSimulationConcurrency", 1, 1],
  ] as const;
  for (const [key, field, fallback, minimum] of fields) {
    const resolve = (value: string) => resolveBlockScanLiveStageSettings({ [`SEARCHER_BLOCKSCAN_${key}`]: value })[field];
    for (const value of ["", "0", "-3", "0.9"]) assert.equal(resolve(value), minimum, `${key}:${value}`);
    for (const value of ["NaN", "Infinity", "-Infinity", "invalid"]) assert.equal(resolve(value), fallback, `${key}:${value}`);
    assert.equal(resolve("123.9"), 123, key);
  }
});

test("positive-only settings keep their original lower bounds and fallback distinctions", () => {
  const fields = [
    ["STATE_HOT_FAMILY_BUDGET_MS", "hotPricingFamilyBudgetMs", 5000, 0],
    ["RUNTIME_PUBLICATION_RESERVE_MS", "runtimePublicationReserveMs", 1500, 0],
    ["EXACT_REFINE_HARD_BUDGET_MS", "exactRefineHardBudgetMs", 4000, 1000],
    ["EXACT_PROBE_TIMEOUT_MS", "exactProbeTimeoutMs", 4000, 100],
    ["EXACT_RPC_BATCH_SIZE", "exactRpcBatchSize", 64, 1],
    ["EXACT_RPC_BATCH_CONCURRENCY", "exactRpcBatchConcurrency", 16, 1],
  ] as const;
  for (const [key, field, fallback, minimum] of fields) {
    const resolve = (value: string) => resolveBlockScanLiveStageSettings({ [`SEARCHER_BLOCKSCAN_${key}`]: value })[field];
    for (const value of ["", "0", "-1", "NaN", "Infinity", "-Infinity"]) assert.equal(resolve(value), fallback, `${key}:${value}`);
    assert.equal(resolve("0.9"), minimum, key);
  }
});

test("startup requires a positive safe integer; large-graph budget cannot undercut the pass", () => {
  for (const value of ["", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"]) {
    assert.equal(resolveBlockScanLiveStageSettings({ SEARCHER_BLOCKSCAN_STARTUP_PREWARM_BUDGET_MS: value }).startupWarmBudgetMs, 300000);
  }
  assert.equal(resolveBlockScanLiveStageSettings({ SEARCHER_BLOCKSCAN_STARTUP_PREWARM_BUDGET_MS: "9007199254740991" }).startupWarmBudgetMs, Number.MAX_SAFE_INTEGER);
  for (const value of ["0", "-1", "", "NaN", "Infinity", "30000"]) {
    assert.equal(resolveBlockScanLiveStageSettings({ SEARCHER_BLOCKSCAN_PASS_BUDGET_MS: "40000",
      SEARCHER_BLOCKSCAN_LARGE_GRAPH_PASS_BUDGET_MS: value }).largeGraphPassBudgetMs, 40000);
  }
  assert.equal(resolveBlockScanLiveStageSettings({ SEARCHER_BLOCKSCAN_PASS_BUDGET_MS: "100",
    SEARCHER_BLOCKSCAN_LARGE_GRAPH_PASS_BUDGET_MS: "NaN" }).largeGraphPassBudgetMs, 30000);
});

test("refine cap and Exact/MID alias precedence preserve their existing fallback chain", () => {
  assert.equal(resolveBlockScanLiveStageSettings({}, 700).refineCandidates, 700);
  assert.equal(resolveBlockScanLiveStageSettings({ SEARCHER_BLOCKSCAN_REFINE_CANDIDATES: "NaN" }, 5).refineCandidates, 512);
  assert.equal(resolveBlockScanLiveStageSettings({ SEARCHER_BLOCKSCAN_REFINE_CANDIDATES: "-9" }, 5).refineCandidates, 5);
  assert.equal(resolveBlockScanLiveStageSettings({ SEARCHER_BLOCKSCAN_REFINE_CANDIDATES: "" }).refineCandidates, 0);
  assert.equal(resolveBlockScanLiveStageSettings({ SEARCHER_BLOCKSCAN_MID_CONCURRENCY: "7.9" }).exactConcurrency, 7);
  assert.equal(resolveBlockScanLiveStageSettings({ SEARCHER_BLOCKSCAN_MID_CONCURRENCY: "7", SEARCHER_BLOCKSCAN_EXACT_CONCURRENCY: "3" }).exactConcurrency, 3);
  for (const value of ["", "0", "-1", "NaN", "Infinity"]) {
    assert.equal(resolveBlockScanLiveStageSettings({ SEARCHER_BLOCKSCAN_MID_CONCURRENCY: "7",
      SEARCHER_BLOCKSCAN_EXACT_CONCURRENCY: value }, 700).exactConcurrency, 700);
  }
  assert.equal(resolveBlockScanLiveStageSettings({ SEARCHER_BLOCKSCAN_EXACT_CONCURRENCY: "0.9" }).exactConcurrency, 1);
});

test("state transport retains its validator boundary rather than silently rounding bad inputs", () => {
  for (const value of ["", "0", "-1", "0.9"]) {
    const settings = resolveBlockScanLiveStageSettings({ SEARCHER_BLOCKSCAN_STATE_RPC_BATCH_CONCURRENCY: value });
    assert.equal(settings.stateRpcBatchConcurrency, 1);
    assert.deepEqual(settings.transport, { capacity: 17, producerReserved: 1 });
  }
  for (const [value, expected] of [["2.5", 2.5], ["NaN", NaN], ["Infinity", Infinity]] as const) {
    const settings = resolveBlockScanLiveStageSettings({ SEARCHER_BLOCKSCAN_STATE_RPC_BATCH_CONCURRENCY: value });
    assert.equal(settings.stateRpcBatchConcurrency, expected);
    assert.throws(() => new RethTransportScheduler(settings.transport), /invalid reth transport capacity/);
  }
});

test("solver validation and process-environment default remain delegated to production", () => {
  for (const env of [{ SEARCHER_BLOCKSCAN_SOLVER_QUOTE_CONCURRENCY: "0" },
    { SEARCHER_BLOCKSCAN_SOLVER_GSS_MAX_TRIES: "1" }, { SEARCHER_BLOCKSCAN_QUOTE_TOLERANCE_ENABLED: "yes" }]) {
    assert.throws(() => resolveBlockScanLiveStageSettings(env), /must be/);
  }
  const before = process.env.SEARCHER_BLOCKSCAN_PASS_BUDGET_MS;
  try {
    process.env.SEARCHER_BLOCKSCAN_PASS_BUDGET_MS = "12345";
    assert.equal(resolveBlockScanLiveStageSettings().passBudgetMs, 12345);
  } finally {
    if (before === undefined) delete process.env.SEARCHER_BLOCKSCAN_PASS_BUDGET_MS;
    else process.env.SEARCHER_BLOCKSCAN_PASS_BUDGET_MS = before;
  }
});

const addr = (n: string) => `0x${n.repeat(40)}`;
const executor = addr("a"), token = addr("b"), middle = addr("c");
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const simulationResult = (): SimulationResult => ({ success: true, netProfit: 5n, grossProfit: 5n,
  gasUsed: 100n, profitToken: token, calldata: "0x" });
function fixture(generation: number, onFirstQuote = () => {}) {
  const source: CanonicalSource = { number: 100, hash: `0x${"d".repeat(64)}`, generation };
  const edges = [{ adapterId: "skip", target: addr("1"), tokenIn: token, tokenOut: middle },
    { adapterId: "skip", target: addr("2"), tokenIn: middle, tokenOut: token }];
  const session = {
    source, blocksPrefixInversion: () => false,
    async issueExact(input: { edge: typeof edges[number]; amountIn: bigint }) {
      if (input.edge.tokenIn === token) onFirstQuote();
      return { amountIn: input.amountIn, amountOut: input.amountIn + 1000n };
    },
    fundingActionIds: () => ["verified-flash"],
    buildExecution(input: { edge: typeof edges[number]; exact: { amountIn: bigint } }) {
      return { status: "resolved", fragment: { requirements: [], nodes: [{ ...input.edge,
        amount: input.exact.amountIn, params: {}, children: [] }] } };
    },
    buildFundingRoot(input: { amount: bigint; children: unknown[] }) {
      return { adapterId: "skip", target: executor, tokenIn: token, tokenOut: token,
        amount: input.amount, params: {}, children: input.children };
    },
  } as unknown as NonNullable<SolveOptions["strictSession"]>;
  const plan = { opportunity: { kind: "block-scan-arb", flashToken: token, profitToken: token,
    searchSeed: { searchCenter: 10n } }, tokenPath: { edges }, maxFlashAmount: 10000n, templateName: "fixture" } as CandidatePlan;
  const state = { async call() { throw new Error("fixture must use strict quotes"); } } as unknown as Parameters<Solver["solve"]>[1];
  const probe = { executor, async simulate() { throw new Error("legacy probe must not run"); } };
  const options: SolveOptions = { strictSession: session, deferPhase2Sim: true, gssMaxTries: 0, deadlineMs: 5000 };
  return { source, plan, state, probe, options };
}

test("one factory bounds whole trials across source/worker selectors and preserves record context", async () => {
  for (const quoteConcurrency of [1, 2]) {
    let active = 0, peak = 0;
    const events: { source: CanonicalSource; workerIndex: number; event: Record<string, unknown> }[] = [];
    const factory = createBlockScanLiveAmountSelectorFactory({ executor, quoteConcurrency, record: row => events.push(row) });
    const fixtures = [fixture(1, enter), fixture(2, enter)];
    function enter() { peak = Math.max(peak, ++active); }
    const workers = fixtures.map((f, workerIndex) => factory({ source: f.source, workerIndex,
      async simulate(plan, control) {
        control.signal.throwIfAborted(); assert.equal(plan.netProfit, 0n);
        await turn(); active--; return simulationResult();
      } }));
    await Promise.all(workers.map((worker, i) => {
      const f = fixtures[i]!; return worker.solve(f.plan, f.state, f.probe, f.options);
    }));
    assert.equal(active, 0); assert.equal(peak, quoteConcurrency);
    for (let workerIndex = 0; workerIndex < 2; workerIndex++) {
      const rows = events.filter(row => row.workerIndex === workerIndex);
      assert(rows.every(row => row.source === fixtures[workerIndex]!.source));
      assert.deepEqual(rows.filter(row => row.event.type === "amount_trial").map(row => row.event.amount), [10n, 100n, 1000n, 10000n]);
      assert.equal(rows.at(-1)!.event.type, "amount_search");
      assert.equal(rows.at(-1)!.event.status, "complete");
      assert(rows.every(row => row.event.searchId === 1));
      assert.deepEqual(Object.keys(rows[0]!).sort(), ["event", "source", "workerIndex"]);
    }
    const f = fixtures[0]!;
    await workers[0]!.solve(f.plan, f.state, f.probe, f.options);
    assert.equal(events.at(-1)!.event.searchId, 2, "worker-local search identity must survive reuse");
  }
});

test("queued selector cancellation does not quote or spend a shared slot and later work can reuse it", async () => {
  let release!: () => void, entered!: () => void, queuedQuotes = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const factory = createBlockScanLiveAmountSelectorFactory({ executor, quoteConcurrency: 1 });
  const first = fixture(1), queued = fixture(2, () => { queuedQuotes++; });
  const firstWorker = factory({ source: first.source, workerIndex: 0, async simulate() {
    entered(); await held; return simulationResult();
  } });
  const queuedWorker = factory({ source: queued.source, workerIndex: 1, async simulate() { return simulationResult(); } });
  const running = firstWorker.solve(first.plan, first.state, first.probe, first.options);
  await started;
  const abort = new AbortController(), reason = new Error("fixture cancellation");
  const cancelled = queuedWorker.solve(queued.plan, queued.state, queued.probe, { ...queued.options, signal: abort.signal });
  const rejected = assert.rejects(cancelled, error => error === reason);
  abort.abort(reason); await rejected;
  assert.equal(queuedQuotes, 0);
  release(); await running;
  await queuedWorker.solve(queued.plan, queued.state, queued.probe, queued.options);
  assert.equal(queuedQuotes, 4);
});

test("factory rejects invalid concurrency and preserves infrastructure-fault identity", async () => {
  for (const quoteConcurrency of [0, -1, 1.5, NaN]) assert.throws(() => createBlockScanLiveAmountSelectorFactory({ executor, quoteConcurrency }), /invalid trial concurrency/);
  const f = fixture(1), fault = new Error("fixture source fault");
  const factory = createBlockScanLiveAmountSelectorFactory({ executor, quoteConcurrency: 1 });
  const failed = factory({ source: f.source, workerIndex: 0, async simulate() { throw fault; } });
  await assert.rejects(failed.solve(f.plan, f.state, f.probe, f.options), error => error === fault);
  const next = factory({ source: f.source, workerIndex: 1, async simulate() { return simulationResult(); } });
  assert.equal((await next.solve(f.plan, f.state, f.probe, f.options)).netProfit, 5n);
});

test("main delegates stage parsing and amount dispatch to the shared exports", () => {
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  const live = source.slice(source.indexOf("async function main("));
  assert.match(live, /resolveBlockScanLiveStageSettings\(process\.env, blockScanCfg\?\.maxCandidates \?\? 0\)/);
  assert.match(live, /amountSelectorFactory: createBlockScanLiveAmountSelectorFactory\(/);
  assert.match(live, /new RethTransportScheduler\(blockScanStageSettings\.transport\)/);
  for (const key of ["PASS_BUDGET_MS", "LARGE_GRAPH_PASS_BUDGET_MS", "LARGE_GRAPH_EDGE_THRESHOLD",
    "STARTUP_PREWARM_BUDGET_MS", "STATE_HOT_FAMILY_BUDGET_MS", "RUNTIME_PUBLICATION_RESERVE_MS",
    "SOLVE_RESERVE_MS", "SOLVE_CONCURRENCY", "FINAL_SIM_CONCURRENCY", "REFINE_CANDIDATES",
    "EXACT_REFINE_HARD_BUDGET_MS", "EXACT_CONCURRENCY", "MID_CONCURRENCY", "EXACT_PROBE_TIMEOUT_MS",
    "EXACT_RPC_BATCH_SIZE", "EXACT_RPC_BATCH_CONCURRENCY", "STATE_RPC_BATCH_CONCURRENCY"])
    assert(!live.includes(`SEARCHER_BLOCKSCAN_${key}`), `main must not retain a second parser for ${key}`);
  assert(!live.includes("createTrialLimiter("));
});
