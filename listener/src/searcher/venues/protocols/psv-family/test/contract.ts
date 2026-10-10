import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { plugin, activation } from "../../../production-families/psv.production.js";
import { ABI, WAD } from "../codec.js";
import { requests, program } from "../exact.js";
import { formula, decodeState, stateRequests } from "../state.js";
import { probes } from "../identity.js";
import { proveImplementation, proveProxy } from "../runtime-shape.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { RuntimeAmountProgram } from "../../../../../adapters/runtime-amount-program.js";
import { createBlockScanSimAmountSelector } from "../../../../simulator/blockscan-sim-amount-selector.js";
import { addr, actor, source, fixture, attest, reads, setup } from "./fixtures.js";
test("disabled by default; source identity admits unrelated deployment addresses, not a pool list", () => {
  assert.equal(activation.enabled, false); assert.equal(attest().decision.status, "verified");
  const f = fixture(); f.target = addr(181); f.gem = addr(184); f.stable = addr(185); assert.equal(attest(f).decision.status, "verified");
  assert.throws(() => proveProxy("0x6000")); assert.throws(() => proveImplementation(f.code, addr(999)));
});
for (const [name, change] of Object.entries({ wrongCode: (f: any): void => { f.code += "00"; }, wrongProxy: (f: any): void => { f.proxyCode = "0x6000"; },
  duplicateToken: (f: any): void => { f.stable = f.gem; }, pause: (f: any): void => { f.paused = true; }, capacity: (f: any): void => { f.maxPerTransaction = 1n; },
  wrongDebit: (f: any): void => { f.mutate = (r: any): void => { r.effects.tokenDeltas[0].delta = 0n; }; },
  wrongFee: (f: any): void => { f.mutate = (r: any): void => { r.effects.tokenDeltas[4].delta += 1n; }; },
  missingReceipt: (f: any): void => { f.mutate = (r: any): void => { r.effects.tokenDeltas.pop(); }; },
  wrongSource: (f: any): void => { f.mutate = (r: any): void => { r.source = { ...source, hash: ethers.id("wrong") }; }; },
})) test("identity fails closed: " + name, () => { const f = fixture(); change(f); assert.notEqual(attest(f).decision.status, "verified"); });
test("colliding Sky selector only nominates; PSV-specific log also nominates without granting identity", () => {
  const f = fixture(), data = ABI.encodeFunctionData("sellGem", [actor, 123n]);
  const find = (data: string) => plugin.discovery.decodeCandidate({ observation: { kind: "call", source, target: f.target, data }, matchedPatternId: "psv-sellGem" });
  assert.equal(find(data)?.target, f.target); assert.equal(find(data + "00"), null);
  const event = ABI.encodeEventLog(ABI.getEvent("Swap")!, [actor, actor, f.gem, f.stable, 1n, 1n, 0n]);
  assert.equal(plugin.discovery.decodeCandidate({ observation: { kind: "log", source, address: f.target, ...event }, matchedPatternId: "psv-swap" })?.target, f.target);
});
test("legal small-capacity vaults use bounded distinct probes, or the sole positive raw amount", () => {
  for (const cap of [5n * WAD, 10n ** 12n]) {
    const f = fixture(); f.maxPerTransaction = cap; f.maxPerBlock = cap; f.remaining = cap;
    const a = attest(f); assert.equal(a.decision.status, "verified");
  }
  const f = fixture(); f.gemReserve = 5000000n; f.stableReserve = 5000000n; assert.equal(attest(f).decision.status, "verified");
});
test("cross-decimal small capacity probes both distinct legal amounts, not a zero-output half", () => {
  for (const gemDecimals of [6, 18]) for (const fee of [0n, WAD / 10n]) {
    const f = fixture(); f.gemDecimals = gemDecimals; f.stableDecimals = 24 - gemDecimals;
    f.gemReserve = f.stableReserve = 1000n * WAD; f.tin = f.tout = fee;
    f.maxPerTransaction = 1500000000000n;
    const a = attest(f); assert.equal(a.decision.status, "verified");
    const direction = gemDecimals === 18 ? "sell-gem" : "buy-gem";
    assert.deepEqual(probes(a.step.evidence).filter(p => p.direction === direction).map(p => p.amount), [1000000000000n, 1500000000000n]);
    assert(probes(a.step.evidence).every(p => p.amountOut > 0n));
    f.maxPerTransaction = 1000000000000n;
    const sole = attest(f); assert.equal(sole.decision.status, "verified");
    assert.deepEqual(probes(sole.step.evidence).filter(p => p.direction === direction).map(p => p.amount), [1000000000000n]);
    f.maxPerBlock = f.maxPerTransaction; f.remaining = 0n;
    assert.notEqual(attest(f).decision.status, "verified");
  }
});
test("exact uses actual amount, recipient preview and output fee; both swaps consume INPUT", () => {
  const f = fixture(), { input } = setup(f);
  for (const dir of [0, 1]) for (const amount of [1n, 1234567n, 7361655916n]) {
    const i = input(amount, dir), q = program.decode({ programInput: i, initialResults: reads(f, requests(i)), dependentEvidence: [] });
    assert.equal(q.amountOut, amount - amount * (dir ? f.tin : f.tout) / WAD);
    const exempt = { ...f, exempt: true }, qe = program.decode({ programInput: i, initialResults: reads(exempt, requests(i)), dependentEvidence: [] });
    assert.equal(qe.amountOut, amount);
    const c = requests(i).find(r => r.id === "amount-preview") as any;
    assert.equal(ABI.parseTransaction({ data: c.data })!.args[0], amount); assert.equal(ABI.parseTransaction({ data: c.data })!.args[1].toLowerCase(), actor);
  }
});
test("asymmetric decimals preserve multiply-before-fee and both integer floors", () => {
  const f = fixture(); f.gemDecimals = 18; f.stableDecimals = 6; f.gemReserve = 1000n * WAD; const { d } = setup(f), s = decodeState(d, reads(f, stateRequests(d)));
  assert.deepEqual(formula(d, { ...s, tout: WAD / 10n }, "sell-gem", 1999999999999n), { amountOut: 1n, fee: 0n });
  assert.throws(() => formula(d, s, "buy-gem", ethers.MaxUint256));
});
test("preview is not admission to spend beyond gross reserves or rate caps", () => {
  const f = fixture(), { input } = setup(f), i = input(1000000n);
  for (const altered of [{ ...f, stableReserve: 999999n }, { ...f, maxPerTransaction: WAD - 1n },
    { ...f, maxPerBlock: WAD, remaining: WAD - 1n }, { ...f, paused: true }])
    assert.throws(() => program.decode({ programInput: i, initialResults: reads(altered, requests(i)), dependentEvidence: [] }));
  const ok = { ...f, maxPerTransaction: WAD, maxPerBlock: WAD, remaining: WAD };
  assert(program.decode({ programInput: i, initialResults: reads(ok, requests(i)), dependentEvidence: [] }).amountOut > 0n);
});
test("quote source and mutable topology failures cannot reuse successful evidence", () => {
  const f = fixture(), { input } = setup(f), i = input(1000000n), rr = reads(f, requests(i));
  assert.throws(() => program.decode({ programInput: i, initialResults: rr.slice(1), dependentEvidence: [] }));
  assert.throws(() => program.decode({ programInput: i, initialResults: rr.map(r => ({ ...r, source: { ...source, generation: 2 } })), dependentEvidence: [] }));
  assert.throws(() => program.decode({ programInput: i, initialResults: reads({ ...f, gem: addr(900) }, requests(i)), dependentEvidence: [] }));
  assert.throws(() => requests({ ...i, prefix: [{}] })); assert.throws(() => requests({ ...i, runtimeEvidence: [{}] }));
});
test("runtime supplies r0 input, exact approval and checked cleanup; quoted minimum observes receipt", () => {
  const f = fixture(), { d, rs, input } = setup(f);
  for (const [index, r] of rs.entries()) {
    const runtime = plugin.execution.buildRuntimeLeg!({ descriptor: d, route: r, source, executor: actor, runtimeEvidence: [] }); assert(runtime);
    const calls = inspectRuntime(runtime.program, 7654321n, { call(c) { return ABI.encodeFunctionResult(c.target.toLowerCase() === d.target ? (index ? "buyGem" : "sellGem") : "approve", [1n]); } }).calls;
    const swap = calls.filter(c => c.target.toLowerCase() === d.target); assert.equal(swap.length, 1);
    assert.equal(ABI.parseTransaction({ data: swap[0].data })!.args[1], 7654321n);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.filter(c => c.target.toLowerCase() !== d.target).map(c => ABI.decodeFunctionData("approve", c.data)[1]), [0n, 7654321n, 0n]);
    assert.throws(() => inspectRuntime(runtime.program, 7654321n, { call: () => ABI.encodeFunctionResult("approve", [false]) }));
    const i = input(1000000n,index), q = program.decode({ programInput: i, initialResults: reads(f, requests(i)), dependentEvidence: [] });
    const fragment = plugin.execution.buildFragment({ ...i, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: q.evidence } as any);
    const encoded = fragment.nodes[0].params.runtimeAmountProgram as string;
    const run = (out: bigint) => { let traded = false; return inspectRuntime(encoded, i.amountIn, { call(c) {
      if (c.target.toLowerCase() === d.target) { traded = true; return ABI.encodeFunctionResult(index ? "buyGem" : "sellGem", [q.amountOut]); }
      const fn = ABI.parseTransaction({ data: c.data })!.name;
      return ABI.encodeFunctionResult(fn, [fn === "balanceOf" ? 99999999n + (traded ? out : 0n) : true]);
    } }); }; run(q.amountOut); assert.throws(() => run(q.amountOut - 1n));
  }
});
test("production amount selector calls runtime and not Exact/quoted/RPC", async () => {
  const { d, rs } = setup();
  for (const r of rs) {
    let exact = 0, quoted = 0, rpc = 0, sim = 0;
    const build = () => plugin.execution.buildRuntimeLeg!({ descriptor: d, route: r, source, executor: actor, runtimeEvidence: [] });
    const edges = [{ adapterId: "family-leg", target: d.target, tokenIn: r.tokenIn, tokenOut: r.tokenOut }, { adapterId: "fixture-return", target: actor, tokenIn: r.tokenOut, tokenOut: r.tokenIn }];
    const session: any = { source, fundingActionIds: () => ["fixture-funding"], buildRuntimeAmountLeg({ edge }: any) {
      return edge === edges[0] ? build() : { actionAdapterId: "fixture-return", program: ethers.hexlify(new RuntimeAmountProgram().constant(1,1n).bytes()) }; },
      issueExact() { exact++; throw Error("forbidden"); }, buildExecution() { quoted++; throw Error("forbidden"); },
      buildFundingRoot(i: any) { return { adapterId: "fixture-funding", target: actor, tokenIn: r.tokenIn, tokenOut: r.tokenIn, amount: i.amount, params: {}, children: i.children }; } };
    const selector = createBlockScanSimAmountSelector({ source, executor: actor, async simulate(plan) {
      sim++; assert.equal(plan.root.children[0].adapterId, "runtime-amount-flow");
      assert.equal(JSON.parse(plan.root.children[0].params.legs as string)[0].program, build()!.program);
      return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: r.tokenIn, calldata: "0x" };
    } });
    await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n }, flashToken: r.tokenIn, profitToken: r.tokenIn }, tokenPath: { edges }, maxFlashAmount: 10000n, templateName: "psv-construction" } as any,
      { call() { rpc++; throw Error("forbidden"); } } as any, { executor: actor } as any, { strictSession: session, deferPhase2Sim: true, gssMaxTries: 2, deadlineAtMs: Date.now() + 10000 });
    assert(sim >= 4); assert.equal(exact,0); assert.equal(quoted,0); assert.equal(rpc,0);
  }
});
test("block cap resets are not carried; compiled touched index scopes reserve transfers", () => {
  const { d, rs } = setup(); assert.equal(plugin.pricing.refreshPolicy, "each-block");
  const index = plugin.pricing.mutation!.compile!({ entries: [{ descriptor: d, routes: rs, stateKey: d.instanceKey, dependencies: plugin.pricing.dependencies({ descriptor: d, routes: rs }) }] });
  const transfer = (from: string, to: string): any => ({ kind: "log", source, address: d.gem, ...ABI.encodeEventLog(ABI.getEvent("Transfer")!, [from,to,1n]) });
  assert.deepEqual(index.affectedStateKeys({ observation: transfer(actor,addr(100)) }), []);
  assert.deepEqual(index.affectedStateKeys({ observation: transfer(actor,d.target) }), [d.instanceKey]);
  const change: any = { kind: "call", source, target: d.target, data: "0x12345678" };
  assert.deepEqual(index.affectedStateKeys({ observation: change }), [d.instanceKey]);
});
