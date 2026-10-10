import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { plugin, activation } from "../../../production-families/yearn-auction.production.js";
import { ABI, NEED, TAKE, TAKES, WAD, scales } from "../codec.js";
import { program } from "../exact.js";
import { cost, decodeState, quoteBudget, stateRequests } from "../state.js";
import { takeProgram } from "../execution.js";
import { cloneImplementation, proveImplementation } from "../runtime-shape.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { RuntimeAmountProgram, runtimeAmountFlowAdapter } from "../../../../../adapters/runtime-amount-program.js";
import { createBlockScanSimAmountSelector } from "../../../../simulator/blockscan-sim-amount-selector.js";
import { addr, actor, source, fixture, attest, reads, setup, cloneCode, contractCost, type Fixture } from "./fixtures.js";

test("default off; source-bound clone and sold registration admit other addresses without a pool list", () => {
  assert.equal(activation.enabled, false); assert.equal(attest().decision.status, "verified");
  const f = fixture(); f.target = addr(181); f.want = addr(183); f.sold = addr(184); assert.equal(attest(f).decision.status, "verified");
  assert.equal(cloneImplementation(cloneCode(f)), f.implementation); assert.throws(() => cloneImplementation("0x6000")); assert.throws(() => proveImplementation("0x6000"));
});
for (const [name, change] of Object.entries({ wrongCode: (f: Fixture): void => { f.code += "00"; }, duplicateToken: (f: Fixture): void => { f.sold = f.want; },
  version: (f: Fixture): void => { f.version = "0.0.0"; }, inactive: (f: Fixture): void => { f.rawPrice = 0n; }, empty: (f: Fixture): void => { f.available = 0n; },
  wrongDebit: (f: Fixture): void => { f.mutate = (r: any): void => { r.effects.tokenDeltas[0].delta = 0n; }; },
  receiverDebit: (f: Fixture): void => { f.mutate = (r: any): void => { r.effects.tokenDeltas[1].delta -= 1n; }; },
  missingReceipt: (f: Fixture): void => { f.mutate = (r: any): void => { r.effects.tokenDeltas.pop(); }; },
  nativeLoss: (f: Fixture): void => { f.mutate = (r: any): void => { r.effects.nativeDeltas[0].delta = -1n; }; },
  wrongSource: (f: Fixture): void => { f.mutate = (r: any): void => { r.source = { ...source, hash: ethers.id("wrong") }; }; },
})) test("identity fails closed: " + name, () => { const f = fixture(); change(f); assert.notEqual(attest(f).decision.status, "verified"); });

test("call/log/surface nominations retain auction AND sold token; malformed calls do not nominate", async () => {
  const f = fixture(); const args = [[f.sold], [f.sold, 123n], [f.sold, 123n, actor], [f.sold, 123n, actor, "0x1234"]];
  for (const [index, signature] of TAKES.entries()) {
    const data = ABI.encodeFunctionData(signature, args[index]), observation = { kind: "call" as const, source, target: f.target, data };
    const c = plugin.discovery.decodeCandidate({ observation, matchedPatternId: `yearn-take-${index}` });
    assert(c); assert.equal(c.sold, f.sold); assert.equal(plugin.discovery.candidateKey(c), `${f.target}:${f.sold}`);
    assert.equal(plugin.discovery.decodeCandidate({ observation: { ...observation, data: data + "00" }, matchedPatternId: `yearn-take-${index}` }), null);
  }
  for (const [name, values] of [["AuctionEnabled", [f.sold, f.want]], ["AuctionKicked", [f.sold, 123n]], ["AuctionSettled", [f.sold]]] as const) {
    const event = ABI.encodeEventLog(ABI.getEvent(name)!, values);
    assert.equal(plugin.discovery.decodeCandidate({ observation: { kind: "log", source, address: f.target, ...event }, matchedPatternId: `yearn-${name}` })?.sold, f.sold);
  }
  const observed = await plugin.discovery.nominate!.nominate({ nominations: [{ address: f.target, opaque: { adapter: "yearn-auction" } }], source,
    provider: { async getCode() { return cloneCode(f); }, async call() { return ABI.encodeFunctionResult("getAllEnabledAuctions", [[f.sold, addr(99)]]); } } as any });
  assert.deepEqual(observed.map(o => plugin.discovery.decodeCandidate({ observation: o, matchedPatternId: "yearn-registered" })?.sold), [f.sold, addr(99)]);
});

test("historical floor inversion preserves two-wei residual and maximizes the purchasable raw quantity", () => {
  const f = fixture(), q = quoteBudget(f, f, 267759246788654353810n);
  assert.deepEqual(q, { amountOut: 106378642455288485048n, spent: 267759246788654353808n });
  assert(contractCost(f, q.amountOut + 1n) > 267759246788654353810n);
  const low = { ...f, rawPrice: 6n * WAD / 10n, available: 100n };
  assert.deepEqual(quoteBudget(low, low, 1n), { amountOut: 3n, spent: 1n });
});

test("cross-decimal full-price recovery, capacity capping and checked arithmetic", () => {
  for (const soldDecimals of [0, 6, 18]) for (const wantDecimals of [0, 6, 18]) {
    const f = { ...fixture(), soldDecimals, wantDecimals, rawPrice: 2517039516660451875n, available: 700n * 10n ** BigInt(soldDecimals) };
    const s = scales(f); assert.equal(contractCost(f, s.priceProbe), f.rawPrice);
    for (const budget of [1n, 17n, 3n * 10n ** BigInt(wantDecimals)]) {
      try { const q = quoteBudget(f, f, budget); assert.equal(q.spent, contractCost(f, q.amountOut)); assert(q.spent > 0n && q.spent <= budget);
        assert(q.amountOut === f.available || contractCost(f, q.amountOut + 1n) > budget); }
      catch (e) { assert.match(String(e), /no positive payable output/); }
    }
  }
  const f = fixture(); assert.deepEqual(quoteBudget(f, { ...f, available: 2n }, 100n), { amountOut: 2n, spent: 5n });
  assert.throws(() => quoteBudget(f, f, ethers.MaxUint256), /bounds/);
  assert.throws(() => quoteBudget(f, { ...f, rawPrice: ethers.MaxUint256 }, 1n), /bounds/);
  assert.throws(() => quoteBudget({ ...f, wantDecimals: 0 }, { ...f, rawPrice: 1n }, 1n), /inactive/);
  assert.throws(() => quoteBudget(f, { ...f, rawPrice: 1n, available: 1n }, 1n), /no positive payable output/);
});

test("exact uses the requested budget and source; does not silently use point amount or sequential prefix", () => {
  const f = fixture(), { d, input } = setup(f);
  for (const amount of [7n, 2517039516660451874n, 267759246788654353810n]) {
    const i = input(amount), result = program.decode({ programInput: i, initialResults: reads(f, stateRequests(d)), dependentEvidence: [] });
    assert.deepEqual({ amountOut: result.amountOut, spent: result.evidence.spent }, quoteBudget(d, f, amount));
    const fragment = plugin.execution.buildFragment({ ...i, quotedAmountOut: result.amountOut, minAmountOut: result.amountOut, exactEvidence: result.evidence });
    assert.equal(fragment.nodes[0].amount, amount);
  }
  const i = input(100n), responses = reads(f, stateRequests(d));
  assert.throws(() => program.decode({ programInput: i, initialResults: responses.slice(1), dependentEvidence: [] }));
  assert.throws(() => program.decode({ programInput: i, initialResults: responses.map(r => ({ ...r, source: { ...source, generation: 2 } })), dependentEvidence: [] }));
  assert.throws(() => program.buildRequests({ ...i, prefix: [{}] })); assert.throws(() => program.buildRequests({ ...i, runtimeEvidence: [{}] }));
  assert.throws(() => decodeState(d, reads({ ...f, receiver: actor }, stateRequests(d))) && program.decode({ programInput: i, initialResults: reads({ ...f, receiver: actor }, stateRequests(d)), dependentEvidence: [] }));
});

function run(f: Fixture, bytes: string, budget: bigint, changes: { debit?: bigint; receipt?: bigint; returnOut?: bigint; approval?: boolean; initial?: bigint } = {}) {
  let traded = false; const approvals: bigint[] = [];
  const oldInput = changes.initial ?? budget + 999n, oldOutput = 777n;
  const result = inspectRuntime(bytes, budget, { call(c) {
    const call = ABI.parseTransaction({ data: c.data })!;
    if (call.name === "getAmountNeeded") return ABI.encodeFunctionResult(NEED, [contractCost(f, call.args[1])]);
    if (call.name === "approve") { approvals.push(call.args[1]); return ABI.encodeFunctionResult("approve", [changes.approval ?? true]); }
    if (call.name === "take") {
      const actual = call.args[1] < f.available ? call.args[1] : f.available; traded = true;
      assert(contractCost(f, actual) > 0n && contractCost(f, actual) <= budget);
      return ABI.encodeFunctionResult(TAKE, [changes.returnOut ?? actual]);
    }
    if (call.name === "balanceOf") { const q = quoteBudget(f, f, budget), amount = c.target.toLowerCase() === f.want
      ? oldInput - (traded ? changes.debit ?? q.spent : 0n) : oldOutput + (traded ? changes.receipt ?? q.amountOut : 0n);
      return ABI.encodeFunctionResult("balanceOf", [amount]); }
    throw new Error("unexpected program call " + call.name);
  } });
  assert.deepEqual(approvals, [0n, budget, 0n]); return result;
}
test("runtime derives output from r0/current price, approves only budget and clears; quoted mode checks real debit/receipt", () => {
  for (const f of [fixture(), { ...fixture(), soldDecimals: 6, wantDecimals: 18, available: 772943155n },
    { ...fixture(), soldDecimals: 18, wantDecimals: 6 }]) {
    const { d, rs } = setup(f), leg = plugin.execution.buildRuntimeLeg!({ descriptor: d, route: rs[0], source, executor: actor, runtimeEvidence: [] }); assert(leg);
    assert.equal(leg.inputMode, "maximum");
    for (const budget of [3n, 10n, 1000n].map(n => n * 10n ** BigInt(f.wantDecimals))) {
      const q = quoteBudget(d, f, budget), runtime = run(f, leg.program, budget);
      assert.equal(runtime.calls.filter(c => c.target.toLowerCase() === d.target).length, 2);
      const quoted = ethers.hexlify(takeProgram(d, actor, q.amountOut).bytes()); run(f, quoted, budget);
      assert.throws(() => run(f, quoted, budget, { debit: 0n }));
      assert.throws(() => run(f, quoted, budget, { debit: budget + 1n }));
      assert.throws(() => run(f, quoted, budget, { receipt: q.amountOut - 1n }));
      assert.throws(() => run(f, quoted, budget, { returnOut: q.amountOut + 1n }));
      assert.throws(() => run(f, quoted, budget, { initial: budget - 1n }));
      assert.throws(() => run(f, leg.program, budget, { approval: false }));
    }
  }
});

test("timestamp-dependent effective refresh is explicitly each-block; unrelated token transfers are excluded", () => {
  const f = fixture(), { d, rs } = setup(f); assert.equal(plugin.pricing.refreshPolicy, "each-block");
  const state = decodeState(d, reads(f, stateRequests(d))), changed = decodeState(d, reads({ ...f, rawPrice: f.rawPrice - 1n }, stateRequests(d)));
  assert.notEqual(state.rawPrice, changed.rawPrice);
  const args: any = { descriptor: d, routes: rs, stateKey: d.instanceKey, source };
  assert.equal(plugin.pricing.current.deriveMids({ ...args, snapshot: state }).size, 1);
  assert.equal(plugin.pricing.current.deriveMids({ ...args, snapshot: { ...state, available: 0n } }).size, 0);
  const event = ABI.encodeEventLog(ABI.getEvent("Transfer")!, [addr(301), addr(302), 1n]);
  assert.deepEqual(plugin.pricing.mutation!.affectedStateKeys({ descriptor: d, routes: rs, observation: { kind: "log", source, address: d.sold, ...event } }), []);
});

test("production sim selector retains budget mask and performs no Exact/quoted/RPC construction", async () => {
  const { d, rs } = setup(), r = rs[0]; let exact = 0, quoted = 0, rpc = 0, simulated = 0;
  const edges = [{ adapterId: "yearn-auction", target: d.target, tokenIn: d.want, tokenOut: d.sold }, { adapterId: "fixture-return", target: actor, tokenIn: d.sold, tokenOut: d.want }];
  const session: any = { source, fundingActionIds: () => ["fixture-funding"], buildRuntimeAmountLeg({ edge }: any) {
    return edge === edges[0] ? plugin.execution.buildRuntimeLeg!({ descriptor: d, route: r, source, executor: actor, runtimeEvidence: [] }) :
      { actionAdapterId: "fixture-return", program: ethers.hexlify(new RuntimeAmountProgram().constant(1, 1n).bytes()) }; },
    issueExact() { exact++; throw new Error("forbidden Exact"); }, buildExecution() { quoted++; throw new Error("forbidden quoted"); },
    buildFundingRoot(i: any) { return { adapterId: "fixture-funding", target: actor, tokenIn: d.want, tokenOut: d.want, amount: i.amount, params: {}, children: i.children }; } };
  const selector = createBlockScanSimAmountSelector({ source, executor: actor, async simulate(plan) {
    simulated++; const flow = plan.root.children[0]!; assert.equal(JSON.parse(flow.params.legs as string)[0].inputMode, "maximum");
    const bytes = runtimeAmountFlowAdapter.encode(flow, actor, new Uint8Array()); assert.equal(bytes[36], 0x42); assert.equal(bytes[37], 1);
    return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: d.want, calldata: "0x" }; } });
  await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n }, flashToken: d.want, profitToken: d.want },
    tokenPath: { edges }, maxFlashAmount: 10000n, templateName: "yearn-fixture" } as any,
    { call() { rpc++; throw new Error("forbidden RPC"); } } as any, { executor: actor } as any,
    { strictSession: session, deferPhase2Sim: true, gssMaxTries: 2, deadlineAtMs: Date.now() + 10000 });
  assert.equal(exact, 0); assert.equal(quoted, 0); assert.equal(rpc, 0); assert(simulated >= 6);
});
