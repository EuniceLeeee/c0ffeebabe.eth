import { createServer } from "node:http";
import { compilePlan } from "../../shared/compiler/compiler.js";
import { buildExecuteCalldata } from "../../shared/executor/botvm-executor.js";
import { keccak256, toUtf8Bytes } from "ethers";
import { erc20TransferAdapter } from "../../adapters/erc20.js";
import { listAll, register } from "../../adapters/registry.js";
import { createBlockScanLiveAmountSelectorFactory } from "../main.js";
import { createBotVmFinalSimulationPlanIdentity } from "../final-simulation-work-runtime.js";
import { runBlockScanFinalWithAmountEvidence } from "../blockscan-final-simulation-method.js";
import { EthSimulateV1Simulator } from "../simulator/eth-simulate-v1.js";
import type { Solver, SolveOptions } from "../solver/solver.js";
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
  const providerMethods: string[] = [];
  const provider = {
    async getFeeData() { providerMethods.push("getFeeData"); throw Error("no external fee lookup"); },
    async estimateGas() { providerMethods.push("estimateGas"); throw Error("no separate gas estimate"); },
    async send(method: string, rpcParams: unknown[]) {
      providerMethods.push(method);
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
  return { run: () => maybeSubmitBlockScanAtomic(params), calls, sent, values, telemetry, raw, resolved, before, providerMethods,
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
  assert.equal(f.rawReads(), 2, "unwitnessed sizing reads the initial source and the canonical post-S5 source only");
  assert.equal(f.sent[0]!.targetBlock, SOURCE.number + 1);
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

test("an unobserved head advance after the decision does not retarget an immediate offer", async (t) => {
  let f!: ReturnType<typeof fixture>;
  f = fixture(t, { submit: true, onSuccessfulSimulation() { f.setHead(101, OTHER_HASH); } });
  const result = await f.run();
  assert.equal(result.decision, "bundle_submitted_unaccepted");
  assert.equal(f.simulations(), 1); assert.equal(f.rawReads(), 2);
  assert.equal(f.offers(), 1);
  assert.deepEqual(f.sent.map(b => b.targetBlock), [SOURCE.number + 1]);
});

test("a late gross fallback keeps its exact original slot and never resimulates or asks for a new target", async (t) => {
  const f = fixture(t, { mode: "positive-gross-profit", submit: true, baseFee: 1n, simProfit: 50n });
  const result = await f.run();
  assert.equal(result.profitMode, "positive-gross-profit");
  assert.equal(result.decision, "gross_profit_fallback_deferred");
  assert(result.deferredSubmission); assert.deepEqual(f.sent, []);
  assert.equal(f.simulations(), 1); f.setHead(101);
  const deferred = await result.deferredSubmission.submit();
  assert.equal(deferred.decision, "bundle_submitted_unaccepted");
  assert.equal(f.simulations(), 1); assert.equal(f.rawReads(), 2);
  assert.deepEqual(f.sent.map(b => [b.targetBlock, b.bribeWei, b.backrunCalldata]), [[SOURCE.number + 1, 49n, BYTES]]);
});

for (const signal of ["generation-aborted", "pass-deadline"] as const) {
  test(`a deferred original target cannot bypass its ${signal} before offering`, async (t) => {
    let now = Date.now(); t.mock.method(Date, "now", () => now);
    const f = fixture(t, { mode: "positive-gross-profit", submit: true, baseFee: 1n, simProfit: 50n });
    const result = await f.run(); assert(result.deferredSubmission);
    if (signal === "generation-aborted") {
      const replaced = Error("source superseded");
      f.controller.abort(replaced);
      await assert.rejects(result.deferredSubmission.submit(), e => e === replaced);
    } else {
      now = f.params.passDeadlineAtMs;
      assert.equal((await result.deferredSubmission.submit()).decision, "ev_or_submit_deadline");
    }
    assert.equal(f.rawReads(), 2); assert.equal(f.offers(), 0); assert.deepEqual(f.sent, []);
  });
}

// This is a transport/wiring test, not evidence about a specific DEX. The strict
// session supplies a compilable, amount-dependent action. Only chain RPC, funding
// semantics and the optional sender are fixtures: search, compilation, decoding,
// evidence admission, final verification and EV run production code.
test("4+8 whole-transaction amounts supply final profit/gas to EV without replay; changed bytes and stale heads fail separately", async (t) => {
  const owner = "0x" + "1".repeat(40), executor = "0x" + "2".repeat(40), middle = "0x" + "3".repeat(40);
  if (!listAll().some(a => a.id === erc20TransferAdapter.id)) register(erc20TransferAdapter);
  const p = 1_000_000n;
  const nodeFor = (amount: bigint) => ({ adapterId: "erc20-transfer", target: TOKEN, tokenIn: TOKEN,
    tokenOut: TOKEN, amount, params: { to: owner }, children: [] });
  const seedData = buildExecuteCalldata(compilePlan(nodeFor(p), executor));
  const targetHeader = { number: 100, hash: HASH, parentHash: OTHER_HASH, timestamp: TIMESTAMP,
    gasUsed: 60_000_000n, gasLimit: 60_000_000n, baseFeePerGas: 80n, transactionHashes: [] };
  const withFee = (options: FixtureOptions = {}) => fixture(t, { ...options, baseFee: 80n, rawPatch: { gasUsed: "0x3938700" } });
  const tag = keccak256(toUtf8Bytes("mev.static-balance-observer.result.v3"));
  const tagged = (v: bigint) => tag + v.toString(16).padStart(64, "0");
  const calls: string[] = [];
  const observed = new Map<string, { profit: bigint; gas: bigint }>();
  let revertPoint = false;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(rpc.method, "eth_simulateV1");
      assert.deepEqual(rpc.params[1], { blockHash: HASH, requireCanonical: true });
      const { blockOverrides, calls: wire } = rpc.params[0].blockStateCalls[0];
      const data: string = wire[1].data;
      calls.push(data);
      // Distinct observed values make a winner/loser or gas-field mixup visible.
      assert.equal(BigInt(blockOverrides.baseFeePerGas), 90n); // fully used parent, target fee = 80 * 9 / 8
      const profit = (data === seedData ? 200_000n : 100_000n) + BigInt(calls.length), gas = 100n + BigInt(calls.length);
      observed.set(data, { profit, gas });
      const call = (gasUsed: bigint, returnData: string) => ({ gasUsed: "0x" + gasUsed.toString(16), returnData, status: "0x1", logs: [] });
      res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result: [{ number: blockOverrides.number, parentHash: HASH,
        timestamp: blockOverrides.time, gasLimit: blockOverrides.gasLimit, baseFeePerGas: blockOverrides.baseFeePerGas,
        gasUsed: "0xf000", calls: [call(1n, tagged(7n)), revertPoint
          ? { ...call(gas, "0x"), status: "0x0", error: { code: 3, message: "execution reverted", data: "0x" } }
          : call(gas, "0x"), call(2n, tagged(revertPoint ? 7n : 7n + profit))] }] }));
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const addr = server.address(); assert(addr && typeof addr !== "string");
  const makeSimulator = () => Object.assign(new EthSimulateV1Simulator("http://127.0.0.1:" + addr.port, executor, owner), { concurrency: 1 });
  const simulator = makeSimulator();
  let finalSimulator = simulator;
  const selectionEvents: Array<Record<string, unknown>> = [];
  const solver = createBlockScanLiveAmountSelectorFactory({ executor, quoteConcurrency: 4,
    simRejects: new BlockScanSimRejectCache(), record: row => selectionEvents.push(row.event) })({
    source: SOURCE, workerIndex: 0,
    simulate(plan, control) { return simulator.simulate(plan, { source: SOURCE, header: targetHeader, ...control, captureAmountEvidence: true }); },
  });
  const edges = [{ adapterId: "fixture", target: owner, tokenIn: TOKEN, tokenOut: middle },
    { adapterId: "fixture", target: executor, tokenIn: middle, tokenOut: TOKEN }];
  const session = { source: SOURCE, buildRuntimeAmountLeg: () => ({ actionAdapterId: "fixture", program: "0x00" }),
    blocksPrefixInversion: () => false, issueExact: () => assert.fail("unexpected hop Exact"),
    fundingChoices: () => [{ actionAdapterId: "fixture", fundingId: "fixture" }],
    buildFundingRoot: ({ amount }: { amount: bigint }) => nodeFor(amount) } as unknown as NonNullable<SolveOptions["strictSession"]>;
  const candidate = { opportunity: { kind: "block-scan-arb", flashToken: TOKEN, profitToken: TOKEN, seedEdges: edges,
    searchSeed: { searchCenter: p } }, tokenPath: { edges }, maxFlashAmount: p * 1000n, templateName: "amount-final-integration" };
  let selected: readonly ResolvedPlan[] = [];
  const top = await solver.solve(candidate as unknown as Parameters<Solver["solve"]>[0],
    { call: () => assert.fail("no external state calls") } as unknown as Parameters<Solver["solve"]>[1],
    { executor, simulate: () => assert.fail("unused legacy probe") },
    { strictSession: session, deferPhase2Sim: true, gssMaxTries: 8, finalSimTopN: 3, deadlineAtMs: Date.now() + 10_000,
      onDeferredCandidates: plans => { selected = plans; } });
  assert.equal(selected[0], top); assert.equal(selected.length, 3); assert.equal(top.flashAmount, p);
  assert.equal(calls.length, 12); assert.equal(new Set(calls).size, 12);
  assert.deepEqual(["p", "coarse", "refine"].map(phase =>
    selectionEvents.filter(e => e.type === "amount_trial" && e.phase === phase).length), [1, 3, 8]);

  const dispositions: string[] = [];
  const runtime = createFinalSimulationWorkRuntime<null, ResolvedPlan, SimulationResult>({
    reservedResources: [{ id: "S5", value: null }], timeoutMs: 10_000, maxQueued: 1,
    planIdentity: createBotVmFinalSimulationPlanIdentity({ executor }),
    generationFence: { assertCurrent(g, s) { assert.equal(g, SOURCE.generation); assert.deepEqual(s, SOURCE); } },
    runner: { simulate(input) { return runBlockScanFinalWithAmountEvidence({
      simulator: finalSimulator, plan: input.resolvedPlan,
      context: { source: input.source, header: targetHeader, signal: input.signal, deadlineAtMs: input.schedule.deadlineAtMs },
      onDisposition: value => dispositions.push(value),
    }); } },
  });
  t.after(() => runtime.close());
  const atomic = (f: ReturnType<typeof fixture>, resolved: ResolvedPlan) =>
    maybeSubmitBlockScanAtomic({ ...f.params, resolved, finalSimulationRuntime: runtime });
  for (const plan of selected) {
    const f = withFee({ submit: true });
    const result = await atomic(f, plan);
    assert.equal(result.decision, "bundle_submitted_unaccepted"); // only an in-memory, unsigned offer
    assert.equal(f.rawReads(), 1, "checked amount parent supplies fees; only post-S5 canonicality reads latest, even on a send");
    assert.equal(f.telemetry[0]?.simulationFeeBasisUsed, true); assert.equal(f.telemetry[0]?.finalCanonicalCheckPerformed, true);
    assert.deepEqual(f.providerMethods, ["eth_getBlockByNumber"]);
    assert(!f.calls.some(c => c.startsWith("fee:")), "no second fee header lookup");
    assert.equal(f.sent.length, 1); const offered = f.sent[0]!;
    assert.equal(offered.targetBlock, SOURCE.number + 1);
    const measurement = observed.get(offered.backrunCalldata); assert(measurement);
    assert.equal(BigInt(result.audit!.simulation.profitRaw), measurement.profit);
    assert.equal(BigInt(result.audit!.simulation.gasUsed), measurement.gas);
    assert.equal(offered.expectedProfit, measurement.profit);
    assert.equal(offered.expectedProfitEth, measurement.profit);
    assert.equal(offered.gasUsed, measurement.gas);
    assert.equal(offered.maxBaseFeePerGas, 90n);
    assert.equal(offered.bribeWei, (measurement.profit - measurement.gas * 90n) / 2n);
    assert.equal(plan.netProfit, measurement.profit);
  }
  assert.deepEqual(dispositions, ["reused", "reused", "reused"]);
  assert.equal(calls.length, 12, "3 finalists must not add 3 executions");

  const noSend = withFee();
  assert.equal((await atomic(noSend, top)).decision, "blockscan_submit_disabled");
  assert.deepEqual(noSend.providerMethods, ["eth_getBlockByNumber"]);
  assert.equal(noSend.rawReads(), 1); assert.equal(noSend.sent.length, 0); assert.equal(calls.length, 12);
  const changed = { ...top, root: { ...top.root, params: { ...top.root.params, to: middle } } };
  const noWitness = withFee();
  const changedResult = await atomic(noWitness, changed);
  assert.equal(noWitness.rawReads(), 2, "no authenticated trial: normal pre-S5 and post-EV head reads");
  assert.equal(noWitness.telemetry[0]?.simulationFeeBasisUsed, false);
  assert.equal(dispositions.at(-1), "fresh");
  assert.equal(calls.length, 13); assert.equal(new Set(calls).size, 13);
  assert.equal(BigInt(changedResult.audit!.simulation.profitRaw), observed.get(calls[12]!)!.profit);

  for (const drift of ["same-height-reorg", "new-head"]) {
    const before = dispositions.length;
    const f = withFee({ submit: true, rawHook(read, raw) {
      assert.equal(read, 1); raw.hash = OTHER_HASH; if (drift === "new-head") raw.number = "0x65";
    } });
    const r = await atomic(f, top);
    assert.equal(r.decision, "blockscan_stale_after_sim");
    assert.equal(f.offers(), 0); assert.equal(f.sent.length, 0); assert.equal(f.rawReads(), 1);
    assert.equal(dispositions.length, before + 1); assert.equal(dispositions.at(-1), "reused");
    assert.equal(calls.length, 13, "neither an S5 cache hit nor a reorg implies a new execution");
  }

  for (const alter of [
    (raw: Record<string, unknown>) => { delete raw.gasLimit; },
    (raw: Record<string, unknown>) => { raw.baseFeePerGas = "0x51"; },
    (raw: Record<string, unknown>) => { raw.gasUsed = "0x39386ff"; },
    (raw: Record<string, unknown>) => { raw.timestamp = "0x" + (TIMESTAMP + 1).toString(16); },
  ]) {
    const f = withFee({ submit: true, rawHook(_read, raw) { alter(raw); } });
    const result = await atomic(f, top);
    assert.equal(result.decision, "blockscan_sim_fee_mismatch");
    assert.equal(f.rawReads(), 1); assert.equal(f.offers(), 0); assert.deepEqual(f.sent, []);
    assert.equal(f.successfulCallbacks(), 0); assert.equal(f.params.simRejects.exportContinuation().routes.length, 0);
    assert.equal(calls.length, 13, "bad canonical fee data must not trigger a different transaction");
  }

  // A genuine sizing result still pins fee facts even if another backend cannot
  // accept its S5 receipt. If fresh S5 reverts, re-check latest before recording P.
  finalSimulator = makeSimulator(); revertPoint = true;
  for (const stillCanonical of [false, true]) {
    const f = withFee({ submit: true, rawHook(_read, raw) { if (!stillCanonical) raw.hash = OTHER_HASH; } });
    const before = calls.length;
    const res = await atomic(f, top);
    assert.equal(dispositions.at(-1), "fresh"); assert.equal(calls.length, before + 1);
    assert.deepEqual(f.providerMethods, ["eth_getBlockByNumber"]);
    assert.equal(res.decision, stillCanonical ? "sim_revert" : "blockscan_stale_after_sim");
    assert.equal(f.params.simRejects.exportContinuation().routes.length, stillCanonical ? 1 : 0);
    assert.equal(f.sent.length, 0); assert.equal(f.offers(), 0);
  }
  const badFee = withFee({ submit: true, rawHook(_read, raw) { delete raw.baseFeePerGas; } });
  const badNegative = await atomic(badFee, top);
  assert.equal(badNegative.decision, "blockscan_sim_fee_mismatch");
  assert.equal(badFee.params.simRejects.exportContinuation().routes.length, 0);
  assert.equal(badFee.rawReads(), 1); assert.equal(badFee.sent.length, 0);
});
