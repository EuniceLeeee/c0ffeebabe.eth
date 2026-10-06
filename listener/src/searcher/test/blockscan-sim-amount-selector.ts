import { AmountNotExecutableError } from "../solver/amount-rejection.js";
import { BlockScanFamilyAttributedError, blockScanFailureCircuitAttribution } from "../detector/blockscan-family-budget.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createBlockScanSimAmountSelector } from "../simulator/blockscan-sim-amount-selector.js";
import { createTrialLimiter, SimAmountNoOpportunityError } from "../simulator/sim-amount-selector.js";
import type { SimulationResult } from "../simulator/botvm-simulator.js";

const addr = (n: string) => `0x${n.repeat(40)}`;
const executor = addr("a"), token = addr("b"), middle = addr("c");
const source = { number: 100, generation: 7, hash: `0x${"d".repeat(64)}` };
function fixture() {
  const edges = [
    { adapterId: "skip", target: addr("1"), tokenIn: token, tokenOut: middle },
    { adapterId: "skip", target: addr("2"), tokenIn: middle, tokenOut: token },
  ];
  const quotes: any[] = [], builds: any[] = [], funding: any[] = [];
  const session: any = {
    source,
    blocksPrefixInversion: () => false,
    async issueExact(input: any) { quotes.push(input); return { amountIn: input.amountIn, amountOut: input.amountIn + 1000n }; },
    fundingActionIds: () => ["verified-flash"],
    buildExecution(input: any) {
      builds.push(input);
      return { status: "resolved", fragment: { requirements: [], nodes: [{ ...input.edge,
        amount: input.exact.amountIn, params: {}, children: [] }] } };
    },
    buildFundingRoot(input: any) {
      funding.push(input);
      return { adapterId: "skip", target: executor, tokenIn: token, tokenOut: token,
        amount: input.amount, params: { funding: input.actionAdapterId }, children: input.children };
    },
  };
  const plan: any = { opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n },
    flashToken: token, profitToken: token }, tokenPath: { edges }, maxFlashAmount: 10000n, templateName: "fixture" };
  const opts = { strictSession: session, deferPhase2Sim: true, gssMaxTries: 0,
    deadlineAtMs: Date.now() + 10000, quoteToleranceRawUnits: 1n };
  const result = (profit: bigint): SimulationResult => ({ success: profit > 0n, netProfit: profit, grossProfit: profit,
    gasUsed: 123n, profitToken: token, calldata: "0x" });
  const probe: any = { executor, simulate() { throw Error("old Solver probe must not run"); } };
  const state: any = { async call() { throw new Error("fixture quotes must use strict session"); } };
  return { session, plan, opts, probe, result, quotes, builds, funding, state };
}

test("production quote/build/sim ranks actual profit and only passes verified funding with exact handles", async () => {
  const f = fixture(), calls: bigint[] = []; let finalists: any[] = [];
  const selector = createBlockScanSimAmountSelector({ source, executor, async simulate(plan, control) {
    control.signal.throwIfAborted(); calls.push(plan.flashAmount);
    assert.equal(plan.netProfit, 0n, "quoted profit must not enter simulation scoring");
    assert.equal(plan.root.params.funding, "verified-flash");
    return f.result(plan.flashAmount === 100n ? 55n : 1n);
  } });
  const selected = await selector.solve(f.plan, f.state, f.probe,
    { ...f.opts, onDeferredCandidates: x => { finalists = [...x]; } });
  assert.deepEqual(calls, [10n, 100n, 1000n, 10000n]);
  assert.equal(selected.flashAmount, 100n); assert.equal(selected.netProfit, 55n);
  assert.equal(finalists.length, 3); assert.equal(f.quotes.length, 8);
  for (const q of f.quotes) { assert.equal(q.executor, executor); assert.equal(q.priorQuotes, undefined); }
  for (const b of f.builds) assert.equal(b.minAmountOut, b.exact.amountOut - 1n);
  for (const b of f.funding) assert.equal(b.minProfit, 1n);
});

test("repeated-instance trial still quotes later hops on the preceding trial state", async () => {
  const f = fixture(); f.plan.tokenPath.edges[1].target = f.plan.tokenPath.edges[0].target;
  const selector = createBlockScanSimAmountSelector({ source, executor, async simulate() { return f.result(0n); } });
  await assert.rejects(selector.solve(f.plan, f.state, f.probe, f.opts), SimAmountNoOpportunityError);
  assert.equal(f.quotes[0].priorQuotes.length, 0); assert.equal(f.quotes[1].priorQuotes.length, 1);
  assert.equal(f.quotes[1].amountIn, f.quotes[1].priorQuotes[0].amountOut);
});

for (const rejection of ["zero-output", "minimum-output"] as const)
test(`larger ${rejection} rejection retains profitable P without skipping infrastructure faults`, async () => {
  const f = fixture(), simulated: bigint[] = []; let finalists: any[] = [];
  f.session.issueExact = async ({ amountIn }: any) => ({ amountIn,
    amountOut: amountIn >= 1000n ? (rejection === "zero-output" ? 0n : 1n) : amountIn + 5n });
  const selector = createBlockScanSimAmountSelector({ source, executor, async simulate(plan) {
    simulated.push(plan.flashAmount); return f.result(10n);
  } });
  const selected = await selector.solve(f.plan, f.state, f.probe,
    { ...f.opts, onDeferredCandidates(values) { finalists = [...values]; } });
  assert.deepEqual(simulated.sort((a, b) => Number(a - b)), [10n, 100n]);
  assert.equal(selected.flashAmount, 10n); assert.equal(finalists.length, 2);
});

test("a typed amount rejection preserves successful amounts and is not a source failure", async () => {
  const f = fixture(), simulated: bigint[] = [];
  f.session.issueExact = async ({ amountIn }: any) => {
    if (amountIn >= 1000n) throw new AmountNotExecutableError("exact-amount-not-executable");
    return { amountIn, amountOut: amountIn + 5n };
  };
  const selector = createBlockScanSimAmountSelector({ source, executor, async simulate(plan) {
    simulated.push(plan.flashAmount); return f.result(plan.flashAmount === 100n ? 20n : 10n);
  } });
  const selected = await selector.solve(f.plan, f.state, f.probe, f.opts);
  assert.deepEqual(simulated.sort((a, b) => Number(a - b)), [10n, 100n]);
  assert.equal(selected.flashAmount, 100n);
  f.session.issueExact = async ({ amountIn }: any) => {
    if (amountIn >= 1000n) throw new Error("exact-amount-not-executable");
    return { amountIn, amountOut: amountIn + 5n };
  };
  await assert.rejects(selector.solve(f.plan, f.state, f.probe, f.opts));
});
test("an attributed quote source failure after profitable P still aborts the whole search", async () => {
  const f = fixture(), fault = new Error("fixture quote source unavailable"); let published = false;
  f.session.issueExact = async ({ amountIn }: any) => {
    if (amountIn >= 1000n) throw fault;
    return { amountIn, amountOut: amountIn + 5n };
  };
  const selector = createBlockScanSimAmountSelector({ source, executor, async simulate() { return f.result(10n); } });
  await assert.rejects(selector.solve(f.plan, f.state, f.probe,
    { ...f.opts, onDeferredCandidates() { published = true; } }),
    (error: any) => error.failureCause === fault);
  assert(!published);
});

for (const kind of ["revert", "nonpositive", "rpc", "throttle-revert-code", "malformed", "token"] as const)
test(`production sim selection classifies ${kind} without quote-profit fallback`, async () => {
  const f = fixture(), fault = Object.assign(new Error("fixture source failure"),
    kind === "throttle-revert-code" ? { statusCode: 429, code: 3 } : {});
  let trials = 0, published = false;
  const selector = createBlockScanSimAmountSelector({ source, executor, async simulate() {
    trials++;
    if (kind === "rpc") return { ...f.result(0n), failure: { kind: "source-fault", code: 429, cause: fault } };
    if (kind === "throttle-revert-code") return { ...f.result(0n), failure: { kind: "revert", code: 3, cause: fault } };
    if (kind === "malformed") return { ...f.result(1n), success: false };
    if (kind === "token") return { ...f.result(1n), profitToken: middle };
    if (kind === "revert") return { ...f.result(0n), failure: { kind: "revert", code: "TRANSACTION_REVERTED", cause: fault } };
    return f.result(0n);
  } });
  await assert.rejects(selector.solve(f.plan, f.state, f.probe,
    { ...f.opts, onDeferredCandidates() { published = true; } }), error => {
      if (kind === "rpc" || kind === "throttle-revert-code") return error === fault;
      if (kind === "revert" || kind === "nonpositive") return error instanceof SimAmountNoOpportunityError;
      return error instanceof Error && !(error instanceof SimAmountNoOpportunityError);
    });
  assert.equal(trials, 1); assert(!published);
});

test("quote failure logs the failing hop input without changing rejection or circuit scope", async () => {
  const f = fixture(), events: any[] = [];
  const edge = f.plan.tokenPath.edges[1];
  edge.canonicalEdgeId = "swap:fixture\u001ffixture-instance\u001freverse";
  const fault = new Error(`strict exact unresolved for ${edge.canonicalEdgeId}: exact-decode:fixture-boundary data=0x12345678`);
  f.session.issueExact = async ({ edge: current, amountIn }: any) => {
    if (current === edge) { assert.equal(amountIn, 38n); throw fault; }
    return { amountIn, amountOut: 38n };
  };
  const selector = createBlockScanSimAmountSelector({ source, executor, record: event => events.push(event),
    async simulate() { throw new Error("quote rejection must never reach final sim"); } });
  await assert.rejects(selector.solve(f.plan, f.state, f.probe, f.opts), error => {
    assert(error instanceof BlockScanFamilyAttributedError);
    assert.equal(error.failureCause, fault);
    assert.equal(blockScanFailureCircuitAttribution(f.plan.tokenPath.edges, error).scope, "family");
    return true;
  });
  const failures = events.filter(e => e.type === "sim_amount_failure");
  assert.equal(failures.length, 1);
  const logged = failures[0];
  assert.equal(logged.amount, "10");
  assert.equal(logged.sourceBlock, source.number);
  assert.equal(logged.sourceBlockHash, source.hash);
  assert.equal(logged.generation, source.generation);
  assert.equal(logged.familyId, "swap:fixture");
  assert.equal(logged.failureStage, "amount propagation");
  assert.equal(logged.quoteContext.hopIndex, 1);
  assert.equal(logged.quoteContext.canonicalEdgeId, edge.canonicalEdgeId);
  assert.equal(logged.quoteContext.tokenIn, middle);
  assert.equal(logged.quoteContext.tokenOut, token);
  assert.equal(logged.quoteContext.amountIn, "38");
  assert.equal(logged.exactReasonCode, "exact-decode:fixture-boundary data=0x12345678");
  assert(!events.some(e => e.type === "sim_amount_execution"));
});

test("shared trial cap covers quotes and plan construction, not just the simulation RPC", async () => {
  const f = fixture(); let active = 0, peak = 0, completed = 0;
  const issue = f.session.issueExact;
  f.session.issueExact = async (input: any) => {
    assert.equal(active, 0, "a later trial must not quote while the only slot is occupied");
    return issue(input);
  };
  const selector = createBlockScanSimAmountSelector({ source, executor, runTrial: createTrialLimiter(1),
    async simulate() {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setImmediate(resolve));
      active--; completed++; return f.result(1n);
    },
  });
  await selector.solve(f.plan, f.state, f.probe, f.opts);
  assert.equal(peak, 1); assert.equal(completed, 4);
});

for (const invalid of ["source", "executor", "funding"] as const)
test(`production sim selection rejects missing/mismatched ${invalid} before simulation`, async () => {
  const f = fixture(); let called = false;
  if (invalid === "source") f.session.source = { ...source, generation: source.generation + 1 };
  if (invalid === "executor") f.probe.executor = middle;
  if (invalid === "funding") f.session.fundingActionIds = () => [];
  const selector = createBlockScanSimAmountSelector({ source, executor, async simulate() { called = true; return f.result(5n); } });
  await assert.rejects(selector.solve(f.plan, f.state, f.probe, f.opts), /mismatch|missing verified funding/);
  assert(!called);
});

test("runtime trial constructs from admitted legs without any hop Exact and preserves amount search/finalists", async () => {
  const f = fixture(), modes: unknown[] = [], tried: bigint[] = [];
  f.session.issueExact = async () => { throw new Error("runtime trial must not issue Exact"); };
  f.session.buildRuntimeAmountLeg = ({ edge, executor: caller }: any) => {
    assert.equal(caller, executor); assert(f.plan.tokenPath.edges.includes(edge));
    return { actionAdapterId: "fixture-owned", program: "0x010001" };
  };
  let finalists: any[] = [];
  const selector = createBlockScanSimAmountSelector({ source, executor,
    record: event => { if (event.type === "sim_amount_construction") modes.push(event.mode); },
    async simulate(plan) {
      tried.push(plan.flashAmount);
      const flow = plan.root.children[0]!;
      assert.equal(flow.adapterId, "runtime-amount-flow");
      assert.equal(flow.amount, plan.flashAmount);
      assert.equal(JSON.parse(flow.params.legs as string).length, 2);
      return f.result(plan.flashAmount === 100n ? 55n : 1n);
    },
  });
  const selected = await selector.solve(f.plan, f.state, f.probe,
    { ...f.opts, gssMaxTries: 2, onDeferredCandidates: x => { finalists = [...x]; } });
  assert.equal(selected.flashAmount, 100n); assert.equal(selected.netProfit, 55n);
  assert(tried.length > 4, "positive runtime trials must retain fine search");
  assert.equal(f.quotes.length, 0); assert.equal(f.builds.length, 0);
  assert.equal(finalists.length, 3); assert(modes.every(mode => mode === "runtime-actual"));
});

test("one unsupported runtime leg preserves the complete quoted route and reports fallback", async () => {
  const f = fixture(), events: any[] = [];
  f.session.buildRuntimeAmountLeg = ({ edge }: any) => edge === f.plan.tokenPath.edges[0]
    ? { actionAdapterId: "fixture-owned", program: "0x010001" } : null;
  const selector = createBlockScanSimAmountSelector({ source, executor, record: event => events.push(event),
    async simulate() { return f.result(1n); } });
  await selector.solve(f.plan, f.state, f.probe, f.opts);
  assert.equal(f.quotes.length, 8);
  const construction = events.filter(e => e.type === "sim_amount_construction");
  assert.equal(construction.length, 4);
  assert(construction.every(e => e.mode === "quoted" && e.unsupportedLegs === 1));
});

test("quoted control never invokes runtime construction even when the session supports it", async () => {
  const f = fixture();
  f.session.buildRuntimeAmountLeg = () => { throw new Error("quoted control must not construct runtime legs"); };
  const selector = createBlockScanSimAmountSelector({ source, executor, runtimeAmounts: false,
    async simulate() { return f.result(1n); } });
  await selector.solve(f.plan, f.state, f.probe, f.opts);
  assert.equal(f.quotes.length, 8);
  assert.equal(f.builds.length, 8);
});
