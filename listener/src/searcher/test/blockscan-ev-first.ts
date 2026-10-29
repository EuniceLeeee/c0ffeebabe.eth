import assert from "node:assert/strict";
import { test } from "node:test";
import { maybeSubmitBlockScanAtomic, resolveBlockScanAtomicPolicy } from "../main.js";
import { createFinalSimulationWorkRuntime } from "../final-simulation-work-runtime.js";
import { SubmissionPreference } from "../execution/submission-preference.js";
import { SubmissionCoordinator } from "../execution/submission-coordinator.js";
import type { BlockScanAtomicResult } from "../blockscan-runtime-loop.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import { blockScanRouteId } from "../blockscan-route-identity.js";
import type { ResolvedPlan } from "../solver/solver.js";
import type { SimulationResult } from "../simulator/botvm-simulator.js";

const address = "0x" + "1".repeat(40), hash = "0x" + "2".repeat(64);
function fixture(mode: "positive-ev" | "positive-gross-profit" = "positive-gross-profit") {
  const controller = new AbortController(), deadlineAtMs = Date.now() + 5000;
  let head = 100, simulations = 0, sequence = 0, routerThrows = false;
  const sent: Array<{ profitMode?: string; bribeWei?: bigint }> = [];
  const rejected = new BlockScanSimRejectCache(), coordinator = new SubmissionCoordinator();
  const preference = new SubmissionPreference<BlockScanAtomicResult>({ signal: controller.signal, deadlineAtMs });
  const runtime = createFinalSimulationWorkRuntime<ResolvedPlan, SimulationResult, null>({
    reservedResources: [{ id: "mock", value: null }],
    runner: { async simulate(input) { simulations++; return { success: true, profitToken: address,
      grossProfit: input.resolvedPlan.netProfit, netProfit: input.resolvedPlan.netProfit, gasUsed: 100n,
      calldata: input.resolvedPlan.root.params.bytes as string, scriptHex: input.resolvedPlan.root.params.bytes as string }; } },
    generationFence: { assertCurrent(g, s) { assert.equal(g, 1); assert.equal(s.hash, hash); } },
    planIdentity: { bytesHex: plan => plan.root.params.bytes as string, resultBytesHex: sim => sim.scriptHex },
    timeoutMs: 5000, maxQueued: 1,
  });
  const run = async (profit: bigint) => {
    const bytes = "0x" + (++sequence).toString(16).padStart(2, "0");
    const raw = { number: "0x" + head.toString(16), hash, timestamp: "0x6b49d200", baseFeePerGas: "0x1",
      gasUsed: "0x1c9c380", gasLimit: "0x3938700", transactions: [] };
    const result = await maybeSubmitBlockScanAtomic({
      config: { ...resolveBlockScanAtomicPolicy({ SEARCHER_BLOCKSCAN_PROFIT_MODE: mode, SEARCHER_EV_GATE: "1",
        SEARCHER_ENABLE_BACKRUN: "0", SEARCHER_BRIBE_BPS: "9900" }), dryRun: true, blockScanSubmit: true, finalVerifyFloorBps: 0n },
      provider: { async send() { return { ...raw, number: "0x" + head.toString(16) }; },
        async getBlock() { return { number: 100, hash, timestamp: 1_800_000_000, baseFeePerGas: 1n, gasUsed: 30_000_000n, gasLimit: 60_000_000n }; } } as any,
      finalSimulationRuntime: runtime, sourceGeneration: 1, sourceBlock: 100, sourceBlockHash: hash,
      opp: { seedEdges: [], flashToken: address, affectedTokens: [], cycleId: "mock-" + sequence,
        cycleFingerprint: "mock-" + sequence, leavesStandingPosition: false } as any,
      resolved: { root: { adapterId: "mock", target: address, tokenIn: address, tokenOut: address, amount: 10_000n,
        params: { bytes }, children: [] }, profitToken: address, flashAmount: 10_000n, netProfit: profit, templateName: "mock" },
      bundleRouter: { async submit(bundle) { sent.push(bundle); if (routerThrows) throw Error("indeterminate relay outcome");
        return [{ builder: "mock", accepted: false, backrunTxHash: hash }]; } },
      submissionCoordinator: coordinator, ring: "mock", protoRing: false, plans: 1, passDeadlineAtMs: deadlineAtMs,
      simRejects: rejected, profitTokenValuation: { valueInEth: (_t: string, n: bigint) => n } as any,
      signal: controller.signal, collectBlindAudit: true, strategyVersions: { strategy_view_version: "mock", blockscan_view_hash: hash },
    });
    if (result.deferredSubmission) preference.defer(result.deferredSubmission);
    else if ((result.submitted || result.submissionAttempted) && result.profitMode === "positive-ev") preference.notePreferredSubmission();
    return result;
  };
  return { run, sent, rejected, preference, controller, setHead: (n: number) => { head = n; },
    setRouterThrows: () => { routerThrows = true; }, simulations: () => simulations, close: () => runtime.close() };
}

test("production atomic path sends later positive EV and discards an earlier gross fallback", async () => {
  const f = fixture();
  try {
    const gross = await f.run(50n); assert(gross.deferredSubmission); assert(!gross.terminalForQuoteSet);
    assert.deepEqual(f.sent, []);
    const ev = await f.run(1000n); assert(ev.submitted); assert.equal(ev.profitMode, "positive-ev");
    const outcomes: string[] = [];
    await f.preference.flush((_e, r) => outcomes.push(r.decision));
    assert.deepEqual(outcomes, ["positive_ev_preferred"]);
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0]!.bribeWei, 891n);
    assert.equal(f.simulations(), 2, "no fallback re-simulation");
  } finally { f.close(); }
});

test("gross mode alone defers then sends the original 99%-gross bid without re-simulation", async () => {
  const f = fixture();
  try {
    assert((await f.run(50n)).deferredSubmission); assert.deepEqual(f.sent, []);
    await f.preference.flush(() => {});
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0]!.profitMode, "positive-gross-profit");
    assert.equal(f.sent[0]!.bribeWei, 49n); assert.equal(f.simulations(), 1);
  } finally { f.close(); }
});

test("an indeterminate positive-EV submission cannot enable a lossy fallback", async () => {
  const f = fixture();
  try {
    await f.run(50n); f.setRouterThrows();
    const r = await f.run(1000n);
    assert.equal(r.decision, "blockscan_submit_error"); assert(r.submissionAttempted); assert(!r.submitted);
    await f.preference.flush(() => {});
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0]!.profitMode, "positive-ev");
  } finally { f.close(); }
});

test("plain positive-EV mode rejects a loss and never defers a gross submission", async () => {
  const f = fixture("positive-ev");
  try {
    const r = await f.run(50n); assert.equal(r.decision, "below_ev_gate");
    assert.equal(r.deferredSubmission, undefined); await f.preference.flush(() => {});
    assert.deepEqual(f.sent, []);
  } finally { f.close(); }
});

for (const mutation of ["head", "abort", "revert"] as const) test(`deferred gross submission rechecks ${mutation}`, async () => {
  const f = fixture();
  try {
    await f.run(50n);
    if (mutation === "head") f.setHead(101);
    if (mutation === "abort") f.controller.abort(new Error("new head"));
    if (mutation === "revert") f.rejected.record(blockScanRouteId([]), {
      success: false, failure: { kind: "revert", code: "TRANSACTION_REVERTED", cause: null },
    } as SimulationResult, { amount: 1n, p: 1n });
    const decisions: string[] = [];
    const flush = f.preference.flush((_e, r) => decisions.push(r.decision));
    if (mutation === "abort") await assert.rejects(flush, /new head/); else await flush;
    assert.deepEqual(f.sent, []); assert.equal(f.simulations(), 1);
    assert.deepEqual(decisions, [mutation === "head" ? "blockscan_stale_state" : mutation === "revert" ? "sim_revert_seen_this_live" : "gross_profit_fallback_cancelled"]);
  } finally { f.close(); }
});
