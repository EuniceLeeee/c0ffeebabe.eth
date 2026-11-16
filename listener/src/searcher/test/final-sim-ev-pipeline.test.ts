import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { AbiCoder } from "ethers";
import { maybeSubmitBlockScanAtomic, resolveBlockScanAtomicPolicy, type BlockScanFinalSimEvTelemetry } from "../main.js";
import { createFinalSimulationWorkRuntime } from "../final-simulation-work-runtime.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import { RevmFatalError } from "../revm-sim-client.js";
import type { EvEvaluation } from "../ev-evaluator.js";
import type { ProfitTokenValuation } from "../profit-token-valuation.js";
import type { ResolvedPlan } from "../solver/solver.js";
import type { SimulationResult } from "../simulator/botvm-simulator.js";
import type { BundleSubmission } from "../execution/bundle-router.js";

// These tests exercise the production atomic entry, the reserved final-sim
// runtime and real EV implementation. Only the external runner/RPC are fakes.
// Barriers prove ordering and ownership; timeouts only guard broken tests.
const HASH = "0x" + "12".repeat(32);
const OTHER_HASH = "0x" + "34".repeat(32);
const TOKEN = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const SOURCE = Object.freeze({ number: 100, hash: HASH, generation: 1 });
const TIMESTAMP = 1_800_000_000;
const BYTES = "0x1234";
type AtomicParams = Parameters<typeof maybeSubmitBlockScanAtomic>[0];

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function watched<T>(promise: Promise<T>) {
  let settled = false;
  const result = promise.then(
    (value) => { settled = true; return value; },
    (error: unknown) => { settled = true; throw error; },
  );
  void result.catch(() => {});
  return { promise: result, settled: () => settled };
}

interface FixtureOptions {
  quoteProfit?: bigint;
  simProfit?: bigint;
  simGrossProfit?: bigint;
  gasUsed?: bigint;
  simSuccess?: boolean;
  simError?: Error;
  simGate?: ReturnType<typeof barrier>;
  oracleGate?: ReturnType<typeof barrier>;
  oracle?: boolean;
  oracleError?: Error;
  valuation?: ProfitTokenValuation;
  baseFee?: bigint;
  rawPatch?: Record<string, unknown>;
  feeHash?: string;
  initialHead?: { number: number; hash: string };
  rawHook?: (read: number, raw: Record<string, unknown>) => void;
  onSuccessfulSimulation?: () => void;
  historical?: boolean;
  submit?: boolean;
  mode?: "positive-ev" | "positive-gross-profit";
}

function fixture(t: TestContext, options: FixtureOptions = {}) {
  const controller = new AbortController();
  const simEntered = barrier(), simReturned = barrier(), oracleEntered = barrier();
  const calls: string[] = [], sent: BundleSubmission[] = [];
  const telemetry: BlockScanFinalSimEvTelemetry[] = [];
  const values: Array<{ amount: bigint; ethUsd: number }> = [];
  const baseFee = options.baseFee ?? 10n;
  const parent = { number: 100, hash: HASH, timestamp: TIMESTAMP,
    baseFeePerGas: baseFee, gasUsed: 30_000_000n, gasLimit: 60_000_000n };
  const raw: Record<string, unknown> = { number: "0x64", hash: HASH,
    parentHash: OTHER_HASH, stateRoot: OTHER_HASH,
    timestamp: "0x" + TIMESTAMP.toString(16), baseFeePerGas: "0x" + baseFee.toString(16),
    gasUsed: "0x1c9c380", gasLimit: "0x3938700", transactions: [], ...options.rawPatch };
  let head = options.initialHead ?? { number: 100, hash: HASH };
  let simulations = 0, oracleCalls = 0, rawReads = 0, successfulCallbacks = 0, offers = 0;
  let lastPlan: ResolvedPlan | undefined;
  let historicalEv: EvEvaluation | undefined;
  const resolved: ResolvedPlan = {
    root: { adapterId: "pipeline-fixture", target: TOKEN, tokenIn: TOKEN, tokenOut: TOKEN,
      amount: 1_000_000n, params: { bytes: BYTES }, children: [] },
    flashAmount: 1_000_000n, profitToken: TOKEN,
    netProfit: options.quoteProfit ?? 100_000n, templateName: "pipeline-fixture",
  };
  const before = structuredClone(resolved);
  Object.freeze(resolved.root.params); Object.freeze(resolved.root.children);
  Object.freeze(resolved.root); Object.freeze(resolved);
  const simProfit = options.simProfit ?? 100_000n;
  const sim: SimulationResult = {
    success: options.simSuccess ?? true, netProfit: simProfit,
    grossProfit: options.simGrossProfit ?? simProfit, profitToken: TOKEN,
    gasUsed: options.gasUsed ?? 100n, calldata: BYTES, scriptHex: BYTES,
    ...(options.simSuccess === false ? { revertReason: "fixture non-domain failure" } : {}),
    ...(options.historical ? { sourceBlockEvidence: {
      executionMode: "source-block", source: SOURCE,
      repaymentVerified: true, conservationVerified: true, baseFeePerGas: baseFee.toString(),
    } } : {}),
  };
  const valuation = options.valuation ?? (options.oracle
    ? { canValue: () => true, valueInEth: (_token: string, amount: bigint, usd: number) =>
        Number.isFinite(usd) ? amount : null }
    : { source: SOURCE, canValue: () => true, valueInEth: (_token: string, amount: bigint) => amount });
  const observedValuation: ProfitTokenValuation = {
    ...(valuation.source === undefined ? {} : { source: valuation.source }),
    canValue: (token) => valuation.canValue(token),
    valueInEth: (token, amount, usd) => {
      values.push({ amount, ethUsd: usd });
      return valuation.valueInEth(token, amount, usd);
    },
  };
  const runtime = createFinalSimulationWorkRuntime<null, ResolvedPlan, SimulationResult>({
    reservedResources: [{ id: "mandatory-pipeline-final-sim", value: null }],
    runner: {
      async simulate(input) {
        simulations++;
        lastPlan = input.resolvedPlan;
        assert.equal(input.resolvedPlan, resolved, "run the caller's exact selected plan");
        assert.equal(input.resolvedPlanBytesHex, BYTES);
        assert.deepEqual(input.source, SOURCE);
        calls.push("sim:start"); simEntered.release();
        await options.simGate?.promise;
        calls.push("sim:return"); simReturned.release();
        if (options.simError) throw options.simError;
        return sim;
      },
    },
    generationFence: { assertCurrent(g, source) {
      assert.equal(g, SOURCE.generation); assert.deepEqual(source, SOURCE);
    } },
    planIdentity: { bytesHex: (plan) => plan.root.params.bytes as string, resultBytesHex: (result) => result.scriptHex },
    parentSignal: controller.signal,
    timeoutMs: 20_000, maxQueued: 1,
  });
  const oracle = async (blockTag: unknown): Promise<string> => {
    assert.equal(blockTag, SOURCE.number);
    oracleCalls++; calls.push("oracle:start"); oracleEntered.release();
    await options.oracleGate?.promise;
    calls.push("oracle:return");
    if (options.oracleError) throw options.oracleError;
    return AbiCoder.defaultAbiCoder().encode(
      ["uint80", "int256", "uint256", "uint256", "uint80"],
      [1n, 2000_00000000n, 0n, BigInt(TIMESTAMP - 1), 1n],
    );
  };
  const provider = {
    async send(method: string, rpcParams: unknown[]) {
      if (method === "eth_call") {
        assert(options.historical, "live valuation uses the ordinary provider call");
        assert.deepEqual(rpcParams[1], { blockHash: HASH, requireCanonical: true });
        return oracle(SOURCE.number);
      }
      assert.equal(method, "eth_getBlockByNumber");
      assert.equal(rpcParams[0], options.historical ? "0x64" : "latest");
      calls.push("raw:" + rpcParams[0]); rawReads++;
      raw.number = "0x" + head.number.toString(16); raw.hash = head.hash;
      options.rawHook?.(rawReads, raw);
      return raw;
    },
    async getBlock(tag: number | "latest") {
      assert.equal(tag, SOURCE.number); calls.push("fee:" + tag);
      return { ...parent, hash: options.feeHash ?? HASH };
    },
    async call(tx: { blockTag?: number }) { return oracle(tx.blockTag); },
  };
  const params: AtomicParams = {
    historicalReadOnly: options.historical,
    ...(options.historical ? { historicalExecutionMode: "source-block" as const } : {}),
    config: { ...resolveBlockScanAtomicPolicy({ SEARCHER_BLOCKSCAN_PROFIT_MODE: options.mode ?? "positive-ev",
      SEARCHER_ENABLE_BACKRUN: "0", SEARCHER_EV_GATE: "1",
      SEARCHER_BRIBE_BPS: options.mode === "positive-gross-profit" ? "9900" : "5000" }),
      dryRun: true, blockScanSubmit: options.submit ?? false, finalVerifyFloorBps: 0n },
    provider: provider as unknown as AtomicParams["provider"],
    finalSimulationRuntime: runtime, sourceGeneration: 1, sourceBlock: 100, sourceBlockHash: HASH,
    opp: { kind: "block-scan-arb", sourceBlock: 100, stateBlock: 100,
      seedEdges: [], flashToken: TOKEN, affectedTokens: [], cycleId: "pipeline-fixture",
      cycleFingerprint: "pipeline-fixture", leavesStandingPosition: false,
      searchSeed: { startToken: TOKEN, searchCenter: 1_000_000n, maxInput: 1_000_000n } },
    resolved,
    bundleRouter: { async submit(bundle) {
      sent.push(bundle);
      return [{ builder: "fixture", accepted: false, backrunTxHash: HASH }];
    } },
    submissionCoordinator: { offer() { offers++; return { admit: true }; } },
    ring: "pipeline-fixture", protoRing: false, plans: 1, passDeadlineAtMs: Date.now() + 20_000,
    simRejects: new BlockScanSimRejectCache(), profitTokenValuation: observedValuation,
    signal: controller.signal, collectBlindAudit: true,
    strategyVersions: { strategy_view_version: "pipeline-fixture", blockscan_view_hash: HASH },
    onSuccessfulSimulation() { successfulCallbacks++; options.onSuccessfulSimulation?.(); },
    onHistoricalEv(input) { historicalEv = input.evaluation; },
    onFinalSimEvTelemetry(event) { telemetry.push(event); },
  };
  t.after(() => {
    options.simGate?.release(); options.oracleGate?.release(); runtime.close();
  });
  return { run: () => maybeSubmitBlockScanAtomic(params), calls, sent, values, telemetry, raw, resolved, before,
    simEntered, simReturned, oracleEntered, runtime, controller, params,
    simulations: () => simulations, oracleCalls: () => oracleCalls, rawReads: () => rawReads,
    successfulCallbacks: () => successfulCallbacks, offers: () => offers,
    lastPlan: () => lastPlan, historicalEv: () => historicalEv,
    setHead(number: number, hash = HASH) { head = { number, hash }; },
  };
}

for (const first of ["simulation", "oracle"] as const) {
  test(`oracle preparation overlaps mandatory final sim; ${first} settles first`, { timeout: 5000 }, async (t) => {
    const simGate = barrier(), oracleGate = barrier();
    const f = fixture(t, { oracle: true, simGate, oracleGate });
    const run = watched(f.run());
    await Promise.all([f.simEntered.promise, f.oracleEntered.promise]);
    assert.equal(f.rawReads(), 1, "no post-source check before either independent branch settles");
    if (first === "simulation") simGate.release(); else oracleGate.release();
    await nextTurn();
    assert(!run.settled(), "the other branch is still owned by this invocation");
    assert.equal(f.rawReads(), 1);
    simGate.release(); oracleGate.release();
    const result = await run.promise;
    assert.equal(result.decision, "blockscan_submit_disabled");
    assert.equal(result.finalSimStatus, "succeeded");
    assert.equal(result.audit?.ev.reason, "ev_gate_pass");
    assert.equal(f.simulations(), 1); assert.equal(f.oracleCalls(), 1); assert.equal(f.rawReads(), 2);
    assert.equal(f.lastPlan(), f.resolved); assert.deepEqual(f.resolved, f.before);
    assert(f.calls.lastIndexOf("raw:latest") > f.calls.indexOf("sim:return"));
    assert(f.calls.lastIndexOf("raw:latest") > f.calls.indexOf("oracle:return"));
    assert.equal(f.telemetry.length, 1); assert(Object.isFrozen(f.telemetry[0]));
    assert.equal(f.telemetry[0]!.sourceBlock, SOURCE.number);
    assert.equal(f.telemetry[0]!.sourceBlockHash, SOURCE.hash);
    assert.equal(f.telemetry[0]!.sourceGeneration, SOURCE.generation);
    assert(f.telemetry[0]!.pipelineWallMs >= f.telemetry[0]!.joinWallMs);
    assert(f.telemetry[0]!.pipelineWallMs >= f.telemetry[0]!.remainingEVWaitMs);
    assert(f.telemetry[0]!.overlapMs <= Math.min(f.telemetry[0]!.simWallMs, f.telemetry[0]!.prepWallMs));
    if (first === "simulation") {
      assert.equal(result.timing.evStartedAtMs, result.timing.finalSimFinishedAtMs);
      assert(result.timing.evMs >= f.telemetry[0]!.remainingEVWaitMs,
        "legacy EV timing includes the non-overlapped preparation tail measured from simulation settlement");
    }
  });
}

test("pinned valuation sends actual final-sim net profit and gas, preserving candidate and bytes", async (t) => {
  const f = fixture(t, { quoteProfit: 1n, simProfit: 2000n, simGrossProfit: 9000n, gasUsed: 100n, submit: true });
  const result = await f.run();
  assert.equal(result.decision, "bundle_submitted_unaccepted");
  assert.equal(result.audit?.simulation.profitRaw, "2000");
  assert.equal(result.audit?.simulation.gasUsed, "100");
  assert.equal(f.simulations(), 1); assert.equal(f.oracleCalls(), 0);
  assert.deepEqual(f.resolved, f.before); assert.equal(f.lastPlan(), f.resolved);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.backrunCalldata, BYTES);
  assert.equal(f.sent[0]!.expectedProfit, 2000n);
  assert.equal(f.sent[0]!.expectedProfitEth, 2000n);
  assert.equal(f.sent[0]!.gasUsed, 100n);
  assert.equal(f.sent[0]!.bribeWei, 500n);
  assert.equal(f.rawReads(), 3, "submission retains its own fresh head check");
});

for (const [simProfit, gasUsed, decision] of [
  [1n, 100n, "below_ev_gate"],
  [100_000n, 0n, "missing_gas_estimate"],
] as const) {
  test(`optimistic solver quote cannot replace actual final-sim inputs: ${decision}`, async (t) => {
    const f = fixture(t, { quoteProfit: 900_000n, simProfit, gasUsed, submit: true });
    const result = await f.run();
    assert.equal(result.decision, decision); assert.equal(f.simulations(), 1);
    assert.equal(result.finalSimStatus, "succeeded"); assert.equal(f.successfulCallbacks(), 1);
    assert.equal(result.audit?.simulation.profitRaw, simProfit.toString());
    assert.equal(result.audit?.simulation.gasUsed, gasUsed.toString());
    assert.deepEqual(f.sent, []); assert.equal(f.offers(), 0); assert.deepEqual(f.resolved, f.before);
  });
}

for (const first of ["simulation", "oracle"] as const) {
  test(`fresh combined source check sees a reorg after ${first} preparation completes`, { timeout: 5000 }, async (t) => {
    const simGate = barrier(), oracleGate = barrier();
    const f = fixture(t, { oracle: true, simGate, oracleGate });
    const run = watched(f.run());
    await Promise.all([f.simEntered.promise, f.oracleEntered.promise]);
    if (first === "simulation") simGate.release(); else oracleGate.release();
    await nextTurn(); f.setHead(100, OTHER_HASH);
    simGate.release(); oracleGate.release();
    const result = await run.promise;
    assert.equal(result.decision, "blockscan_stale_after_sim");
    assert.equal(result.audit?.ev.decision, "reject");
    assert.equal(f.successfulCallbacks(), 0); assert.deepEqual(f.sent, []);
    assert.equal(f.simulations(), 1); assert.equal(f.rawReads(), 2);
  });
}

test("actual-profit-dependent oracle need is filled before the final fresh source check", { timeout: 5000 }, async (t) => {
  const oracleGate = barrier();
  const f = fixture(t, { quoteProfit: 100_000n, simProfit: 20_000n, oracleGate,
    valuation: { canValue: () => true, valueInEth: (_token, amount, usd) =>
      amount === 100_000n || Number.isFinite(usd) ? amount : null } });
  const run = watched(f.run());
  await f.oracleEntered.promise;
  assert.equal(f.simulations(), 1);
  assert.equal(f.runtime.snapshot().completed, 1, "the new oracle need comes from the actual final-sim amount");
  assert.equal(f.rawReads(), 1, "the source observation must follow this late dependency too");
  f.setHead(101); oracleGate.release();
  const result = await run.promise;
  assert.equal(result.decision, "blockscan_stale_after_sim");
  assert.equal(f.oracleCalls(), 1); assert.equal(f.rawReads(), 2);
  assert.deepEqual(f.sent, []); assert.equal(f.successfulCallbacks(), 0);
});

for (const failure of ["revert", "exception"] as const) {
  test(`final-sim ${failure} drains already-started oracle preparation`, { timeout: 5000 }, async (t) => {
    const oracleGate = barrier();
    const f = fixture(t, { oracle: true, oracleGate,
      ...(failure === "revert" ? { simSuccess: false } : { simError: new Error("fixture runner error") }) });
    const run = watched(f.run());
    await Promise.all([f.simReturned.promise, f.oracleEntered.promise]);
    await nextTurn(); assert(!run.settled());
    assert.equal(f.rawReads(), 1); oracleGate.release();
    const result = await run.promise;
    assert.equal(result.decision, failure === "revert" ? "sim_revert" : "final_sim_unresolved");
    assert.equal(f.simulations(), 1); assert.equal(f.oracleCalls(), 1);
    assert.equal(f.rawReads(), 1, "failed simulation cannot publish an EV decision");
    assert.deepEqual(f.sent, []); assert.equal(f.successfulCallbacks(), 0);
  });
}

test("caller cancellation drains new oracle work and retires the interrupted final-sim resource", { timeout: 5000 }, async (t) => {
  const simGate = barrier(), oracleGate = barrier(), reason = new Error("fixture new head");
  const f = fixture(t, { oracle: true, simGate, oracleGate });
  const run = watched(f.run());
  await Promise.all([f.simEntered.promise, f.oracleEntered.promise]);
  f.controller.abort(reason); await nextTurn();
  assert(!run.settled(), "new EV work is not abandoned on cancellation");
  assert.equal(f.runtime.snapshot().retiredResources, 1);
  assert.equal(f.runtime.snapshot().healthyResources, 0);
  // The pre-existing runtime retires the resource; its lower runner is not
  // claimed drained merely because its task promise rejected. Release it here.
  simGate.release(); await f.simReturned.promise;
  assert(!run.settled()); oracleGate.release();
  await assert.rejects(run.promise, (error: unknown) => error === reason);
  assert.equal(f.rawReads(), 1); assert.deepEqual(f.sent, []);
});

for (const simSuccess of [false, true]) {
  test(`cancellation while draining preparation is not hidden by a completed non-positive simulation (${simSuccess})`, { timeout: 5000 }, async (t) => {
    const oracleGate = barrier(), reason = new Error("fixture cancellation during drain");
    const f = fixture(t, { oracle: true, oracleGate, simSuccess, simProfit: 0n });
    const run = watched(f.run());
    await Promise.all([f.simReturned.promise, f.oracleEntered.promise]);
    await nextTurn(); assert.equal(f.runtime.snapshot().completed, 1);
    f.controller.abort(reason); await nextTurn();
    assert(!run.settled(), "already-started oracle still belongs to the cancelled invocation");
    oracleGate.release();
    await assert.rejects(run.promise, (error: unknown) => error === reason);
    assert.equal(f.rawReads(), 1); assert.deepEqual(f.sent, []);
  });
}

for (const earlier of ["ordinary-sim-error", "caller-abort"] as const) {
  test(`late oracle fatal retains identity after ${earlier}`, { timeout: 5000 }, async (t) => {
    const oracleGate = barrier(), fatal = new RevmFatalError({ kind: "source-fault" });
    const f = fixture(t, { oracle: true, oracleGate, oracleError: fatal,
      ...(earlier === "ordinary-sim-error" ? { simError: new Error("ordinary failure") } : {}) });
    const run = watched(f.run());
    await Promise.all([f.simReturned.promise, f.oracleEntered.promise]);
    if (earlier === "caller-abort") f.controller.abort(new Error("ordinary cancellation"));
    await nextTurn(); assert(!run.settled()); oracleGate.release();
    await assert.rejects(run.promise, (error: unknown) => error === fatal);
    assert.equal(f.rawReads(), 1); assert.deepEqual(f.sent, []);
  });
}

for (const simSuccess of [true, false]) {
  test(`deadline after completed simulation drains pending oracle and publishes no EV (${simSuccess})`, { timeout: 5000 }, async (t) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const oracleGate = barrier();
    const f = fixture(t, { oracle: true, oracleGate, simSuccess, simProfit: simSuccess ? 100_000n : 0n });
    const run = watched(f.run());
    await Promise.all([f.simReturned.promise, f.oracleEntered.promise]);
    await nextTurn(); assert.equal(f.runtime.snapshot().completed, 1);
    now = f.params.passDeadlineAtMs + 1;
    await nextTurn(); assert(!run.settled()); oracleGate.release();
    const result = await run.promise;
    assert.equal(result.decision, "ev_or_submit_deadline");
    assert.equal(f.rawReads(), 1); assert.equal(f.successfulCallbacks(), 0); assert.deepEqual(f.sent, []);
  });
}

test("ordinary oracle failure remains unpriceable after real simulation", async (t) => {
  const f = fixture(t, { oracle: true, oracleError: new Error("fixture unavailable oracle") });
  const result = await f.run();
  assert.equal(result.decision, "unpriceable_profit_token");
  assert.equal(result.finalSimStatus, "succeeded"); assert.equal(f.successfulCallbacks(), 1);
  assert.equal(f.simulations(), 1); assert.equal(f.oracleCalls(), 1);
  assert.deepEqual(f.sent, []);
});

for (const head of [{ number: 101, hash: HASH }, { number: 100, hash: OTHER_HASH }]) {
  test(`wrong initial source ${head.number}/${head.hash.slice(0, 8)} never starts simulation or EV work`, async (t) => {
    const f = fixture(t, { initialHead: head, oracle: true });
    const result = await f.run();
    assert.equal(result.decision, "blockscan_stale_state");
    assert.equal(f.simulations(), 0); assert.equal(f.oracleCalls(), 0);
    assert.deepEqual(f.sent, []);
  });
}

test("incomplete initial fee header uses provider fallback and still finishes with fresh raw source", async (t) => {
  const f = fixture(t, { rawPatch: { baseFeePerGas: undefined } });
  const result = await f.run();
  assert.equal(result.decision, "blockscan_submit_disabled");
  assert.equal(f.simulations(), 1); assert.equal(f.rawReads(), 2);
  assert.equal(f.calls.filter((call) => call === "fee:100").length, 1);
  assert(f.calls.lastIndexOf("raw:latest") > f.calls.indexOf("fee:100"));
});

test("a wrong-hash fallback cannot provide a valid EV observation", async (t) => {
  const f = fixture(t, { rawPatch: { baseFeePerGas: undefined }, feeHash: OTHER_HASH });
  const result = await f.run();
  assert.notEqual(result.audit?.ev.decision, "allow");
  assert(!result.submitted); assert.deepEqual(f.sent, []);
});

test("successful-simulation callback cannot mutate the captured fee header", async (t) => {
  let f!: ReturnType<typeof fixture>;
  f = fixture(t, { submit: true, simProfit: 2000n, onSuccessfulSimulation() {
    f.raw.baseFeePerGas = "0xffff"; f.raw.timestamp = "0x1"; f.raw.gasUsed = "0x1";
  } });
  const result = await f.run();
  assert.equal(result.decision, "bundle_submitted_unaccepted");
  assert.equal(f.sent[0]!.maxBaseFeePerGas, 10n);
  assert.equal(f.sent[0]!.bribeWei, 500n); assert.equal(f.simulations(), 1);
});

test("historical zero-fee source remains valid with actual gas and one combined source check", async (t) => {
  const f = fixture(t, { historical: true, baseFee: 0n, simProfit: 100n, gasUsed: 123n });
  const result = await f.run();
  assert.equal(result.decision, "blockscan_submit_disabled");
  assert.equal(f.historicalEv()?.maxBaseFeePerGas, 0n);
  assert.equal(f.historicalEv()?.gasUnits, 123n);
  assert.equal(f.historicalEv()?.gasCostEth, 0n); assert.equal(f.historicalEv()?.feeStateAvailable, true);
  assert.equal(f.rawReads(), 2); assert.equal(f.simulations(), 1); assert.deepEqual(f.sent, []);
});

test("pre-submit head change still blocks sending after a successful combined decision", async (t) => {
  const f = fixture(t, { submit: true, rawHook(read, raw) { if (read === 3) raw.number = "0x65"; } });
  const result = await f.run();
  assert.equal(result.decision, "blockscan_stale_state");
  assert.equal(f.simulations(), 1); assert.equal(f.rawReads(), 3);
  assert.equal(f.offers(), 0); assert.deepEqual(f.sent, []);
});

test("gross fallback preserves actual result and rechecks head without another simulation", async (t) => {
  const f = fixture(t, { mode: "positive-gross-profit", submit: true, baseFee: 1n, simProfit: 50n });
  const result = await f.run();
  assert.equal(result.profitMode, "positive-gross-profit");
  assert.equal(result.decision, "gross_profit_fallback_deferred");
  assert(result.deferredSubmission); assert.deepEqual(f.sent, []);
  assert.equal(f.simulations(), 1); f.setHead(101);
  const deferred = await result.deferredSubmission.submit();
  assert.equal(deferred.decision, "blockscan_stale_state");
  assert.equal(f.simulations(), 1); assert.equal(f.rawReads(), 3); assert.deepEqual(f.sent, []);
});
