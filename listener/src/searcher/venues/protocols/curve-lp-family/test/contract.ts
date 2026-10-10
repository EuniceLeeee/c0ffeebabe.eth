import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { plugin, activation } from "../../../production-families/curve-lp.production.js";
import { ABI, DECIMALS, FUNCTIONS } from "../codec.js";
import { program, requests } from "../exact.js";
import { mintQuote, invariant } from "../model.js";
import { decodeState, stateRequests } from "../state.js";
import { lpProgram } from "../execution.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { RuntimeAmountProgram } from "../../../../../adapters/runtime-amount-program.js";
import { createBlockScanSimAmountSelector } from "../../../../simulator/blockscan-sim-amount-selector.js";
import { actor, addr, source, fixture, attest, setup, reads, mockWithdraw, type Fixture } from "./fixtures.js";
import { samples } from "../identity.js";

test("default off; registry + source + minter + actual effects, not a pool allowlist; four conversion edges", () => {
  assert.equal(activation.enabled, false); assert.equal(attest().decision.status, "verified");
  const f = fixture(); f.pool = addr(181); f.lp = addr(182); f.coins = [addr(183), addr(184)]; f.minter = f.pool; f.registeredPool = f.pool;
  const { rs } = setup(f); assert.deepEqual(rs.map(r => [r.direction, r.index]), [["mint", 0], ["mint", 1], ["redeem", 0], ["redeem", 1]]);
});
for (const [name, change] of Object.entries({ code: (f: Fixture) => { f.poolCode += "00"; }, lpCode: (f: Fixture) => { f.lpCode += "00"; },
  minter: (f: Fixture) => { f.minter = addr(111); }, reverse: (f: Fixture) => { f.registeredPool = addr(111); },
  decimals: (f: Fixture) => { f.decimals[1] = 18; }, ramp: (f: Fixture) => { f.future += 1n; }, killed: (f: Fixture) => { f.killed = true; },
  debit: (f: Fixture) => { f.mutate = r => { r.effects.tokenDeltas[0].delta = 0n; }; },
  receipt: (f: Fixture) => { f.mutate = r => { r.effects.tokenDeltas[2].delta -= 1n; }; },
  supply: (f: Fixture) => { f.mutate = r => { r.effects.totalSupplyDeltas[0].delta = 0n; }; },
  missing: (f: Fixture) => { f.mutate = r => { r.effects.tokenDeltas.pop(); }; },
  native: (f: Fixture) => { f.mutate = r => { r.effects.nativeDeltas[0].delta = -1n; }; },
  source: (f: Fixture) => { f.mutate = r => { r.source = { ...source, hash: ethers.id("foreign") }; }; },
})) test("strict fails closed: " + name, () => { const f = fixture(); change(f); assert.notEqual(attest(f).decision.status, "verified"); });

test("independent behavior probes admit 4-LP capacity and bound smaller redemptions", () => {
  const f = fixture(); f.balances = [2n * 10n ** 18n, 2n * 10n ** 6n]; f.totalSupply = 4n * 10n ** 18n;
  assert.equal(attest(f).decision.status, "verified");
  for (const supply of [4n * 10n ** 18n, 2n * 10n ** 18n, 10n ** 18n, 30n]) {
    const q = samples({ phase: "behavior", binding: setup(f).d, state: { ...f, source, totalSupply: supply } });
    assert.equal(q.length, 8); assert(q.filter(p => p.direction === "redeem").every(p => p.amount > 0n && p.amount < supply));
  }
});

test("real ABI call/log nominations validate payloads and retain the pool", () => {
  const f = fixture();
  for (const [index, fn] of FUNCTIONS.entries()) { const data = ABI.encodeFunctionData(fn, index ? [10n, 1, 1n] : [[0n, 10n], 1n]);
    const observation = { kind: "call" as const, source, target: f.pool, data }, matchedPatternId = `curve-lp-${fn}`;
    assert.equal(plugin.discovery.decodeCandidate({ observation, matchedPatternId })?.pool, f.pool);
    assert.equal(plugin.discovery.decodeCandidate({ observation: { ...observation, data: data + "00" }, matchedPatternId }), null);
  }
  const event = ABI.encodeEventLog(ABI.getEvent("AddLiquidity")!, [actor, [0n, 10n], [0n, 0n], 10n, 99n]);
  assert.equal(plugin.discovery.decodeCandidate({ observation: { kind: "log", source, address: f.pool, ...event }, matchedPatternId: "curve-lp-AddLiquidity" })?.pool, f.pool);
});
test("mint uses fee-adjusted D2, not fee-free calc_token_amount; checked uint operations and initial-liquidity refusal", () => {
  const f = fixture(), amount = 36977795n, after: [bigint, bigint] = [f.balances[0], f.balances[1] + amount];
  const d0 = invariant(f.balances, f.amp), feeFree = (invariant(after, f.amp) - d0) * f.totalSupply / d0, out = mintQuote(f, 1, amount);
  assert(out < feeFree); assert.equal(mintQuote({ ...f, fee: 0n }, 1, amount), feeFree);
  assert.throws(() => mintQuote(f, 1, 0n)); assert.throws(() => mintQuote(f, 1, ethers.MaxUint256));
  assert.throws(() => mintQuote({ ...f, totalSupply: 0n }, 1, amount)); assert.throws(() => mintQuote({ ...f, balances: [0n, 1n] }, 1, amount));
});
test("both directions quote exact requested input, bind source and retain quoted execution; prefix is not silently ignored", () => {
  const f = fixture(), { d, rs, input } = setup(f);
  for (const r of rs) for (const n of [1n, 37n, 268n]) { const amount = n * 10n ** BigInt(r.direction === "mint" ? DECIMALS[r.index] : 18), i = input(r, amount);
    const q = program.decode({ programInput: i, initialResults: reads(f, requests(i)), dependentEvidence: [] });
    assert.equal(q.amountOut, r.direction === "mint" ? mintQuote(f, r.index, amount) : mockWithdraw(amount, r.index));
    const fragment = plugin.execution.buildFragment({ ...i, exactEvidence: q.evidence, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut });
    assert.equal(fragment.nodes[0].amount, amount);
    assert.throws(() => plugin.execution.buildFragment({ ...i, exactEvidence: { ...q.evidence, amountIn: amount + 1n }, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut }));
    assert.throws(() => program.buildRequests({ ...i, prefix: [{}] }));
  }
  assert.throws(() => decodeState(d, reads(f, stateRequests(d)).map(r => ({ ...r, source: { ...source, generation: 2 } })), source));
});

function run(f: Fixture, d: any, r: any, bytes: string, amount: bigint, fault: { debit?: bigint; receipt?: bigint; returned?: bigint; approval?: boolean; oldInput?: bigint } = {}) {
  const out = r.direction === "mint" ? mintQuote(f, r.index, amount) : mockWithdraw(amount, r.index), approvals: bigint[] = [];
  let traded = false; const oldInput = fault.oldInput ?? amount + 111n, oldOut = 999n;
  const value = inspectRuntime(bytes, amount, { call(c) { const data = ABI.parseTransaction({ data: c.data })!;
    if (data.name === "approve") { approvals.push(data.args[1]); return ABI.encodeFunctionResult("approve", [fault.approval ?? true]); }
    if (FUNCTIONS.includes(data.name as any)) { traded = true;
      if (r.direction === "mint") assert.deepEqual([...data.args[0]], r.index === 0 ? [amount, 0n] : [0n, amount]);
      else { assert.equal(data.args[0], amount); assert.equal(data.args[1], BigInt(r.index)); }
      return ABI.encodeFunctionResult(data.name, [fault.returned ?? out]); }
    if (data.name === "balanceOf") return ABI.encodeFunctionResult("balanceOf", [c.target.toLowerCase() === r.tokenIn ? oldInput - (traded ? fault.debit ?? amount : 0n) : oldOut + (traded ? fault.receipt ?? out : 0n)]);
    throw new Error("unexpected VM call " + data.name);
  } });
  assert.deepEqual(approvals, r.direction === "mint" ? [0n, amount, 0n] : []); return value;
}
test("runtime patches actual r0 into array/burn; no LP approval; quoted path measures receipts, rejects inventory subsidy", () => {
  const f = fixture(), { d, rs } = setup(f);
  for (const r of rs) for (const n of [2n, 37n]) { const amount = n * 10n ** BigInt(r.direction === "mint" ? DECIMALS[r.index] : 18);
    const out = r.direction === "mint" ? mintQuote(f, r.index, amount) : mockWithdraw(amount, r.index);
    const runtime = plugin.execution.buildRuntimeLeg!({ descriptor: d, route: r, source, executor: actor, runtimeEvidence: [] }); assert(runtime);
    run(f, d, r, runtime.program, amount); const quoted = ethers.hexlify(lpProgram(d, r, actor, out).bytes()); run(f, d, r, quoted, amount);
    for (const fault of [{ debit: amount - 1n }, { debit: amount + 1n }, { receipt: out - 1n }, { returned: out + 1n }, { oldInput: amount - 1n }]) assert.throws(() => run(f, d, r, quoted, amount, fault));
    if (r.direction === "mint") assert.throws(() => run(f, d, r, runtime.program, amount, { approval: false }));
  }
});
test("mutation catches pool, LP mint/burn and minter calls; unrelated token transfer/approval carries", () => {
  const { d, rs } = setup(), mutation = plugin.pricing.mutation!;
  const affect = (observation: any) => mutation.affectedStateKeys({ descriptor: d, routes: rs, observation });
  const transfer = (a: string, b: string, target = d.lp) => ({ kind: "log", source, address: target, ...ABI.encodeEventLog(ABI.getEvent("Transfer")!, [a, b, 1n]) });
  assert.deepEqual(affect(transfer(addr(1), addr(2))), []); assert.deepEqual(affect(transfer(ethers.ZeroAddress, addr(2))), [d.instanceKey]);
  assert.deepEqual(affect(transfer(d.pool, addr(2), d.coins[0])), [d.instanceKey]);
  assert.deepEqual(affect({ kind: "call", source, target: d.lp, data: "0x12345678" }), [d.instanceKey]);
  assert.deepEqual(affect({ kind: "call", source, target: d.pool, data: ethers.id("donate_admin_fees()").slice(0, 10) }), [d.instanceKey]);
});
test("all four directions enter production sim selector without Exact, quoted fallback or construction RPC", async () => {
  const { d, rs } = setup(); let exact = 0, quoted = 0, rpc = 0, simulated = 0;
  for (const r of rs) {
    const edges = [{ adapterId: "curve-lp", target: d.pool, tokenIn: r.tokenIn, tokenOut: r.tokenOut }, { adapterId: "fixture-return", target: actor, tokenIn: r.tokenOut, tokenOut: r.tokenIn }];
    const session: any = { source, fundingActionIds: () => ["fixture-funding"], buildRuntimeAmountLeg({ edge }: any) { return edge === edges[0]
      ? plugin.execution.buildRuntimeLeg!({ descriptor: d, route: r, source, executor: actor, runtimeEvidence: [] })
      : { actionAdapterId: "fixture-return", program: ethers.hexlify(new RuntimeAmountProgram().constant(1, 1n).bytes()) }; },
      issueExact() { exact++; throw new Error("forbidden Exact"); }, buildExecution() { quoted++; throw new Error("forbidden quoted"); },
      buildFundingRoot(i: any) { return { adapterId: "fixture-funding", target: actor, tokenIn: r.tokenIn, tokenOut: r.tokenIn, amount: i.amount, params: {}, children: i.children }; } };
    const selector = createBlockScanSimAmountSelector({ source, executor: actor, async simulate() { simulated++; return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: r.tokenIn, calldata: "0x" }; } });
    await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n }, flashToken: r.tokenIn, profitToken: r.tokenIn }, tokenPath: { edges }, maxFlashAmount: 10000n, templateName: "curve-lp-fixture" } as any,
      { call() { rpc++; throw new Error("forbidden RPC"); } } as any, { executor: actor } as any, { strictSession: session, deferPhase2Sim: true, gssMaxTries: 2, deadlineAtMs: Date.now() + 10000 });
  }
  assert.equal(exact, 0); assert.equal(quoted, 0); assert.equal(rpc, 0); assert(simulated >= 24);
});
