import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ethers } from "ethers";
import { plugin, activation } from "../../../production-families/peapods-debond.production.js";
import type { AdapterRequest, AdapterRequestResult } from "../../../adapter-request-program.js";
import { declareRequestProgram } from "../../../adapter-request-program.js";
import { ABI, Q96, WAD } from "../codec.js";
import { IMMUTABLES, proveRuntime } from "../runtime-shape.js";
import { debond } from "../math.js";
import { program, quoteTrial } from "../exact.js";
import { verifyBehavior } from "../identity.js";
import { decodeState } from "../state.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { createBlockScanSimAmountSelector } from "../../../../simulator/blockscan-sim-amount-selector.js";
import { RuntimeAmountProgram } from "../../../../../adapters/runtime-amount-program.js";
import { emptyExactTrialState, applyExactTrialState } from "../../../../exact-trial-state.js";
import { tokenBalanceState } from "../../../local-state-models/resources.js";
const address = (n: number) => ethers.toBeHex(n, 20), actor = address(71);
const source = { number: 26152716, generation: 1, hash: ethers.id("peapods-fixture") };
const template = JSON.parse(readFileSync(new URL("./weighted-runtime.json", import.meta.url), "utf8")).bytecode as string;
function runtimeCode(fee = 200n) {
  let code = template;
  for (const [name, offsets] of Object.entries(IMMUTABLES)) {
    const value = name === "DEBOND_FEE" ? fee : name === "BOND_FEE" ? 100n : 99n;
    for (const offset of offsets) code = code.slice(0, 2 + offset * 2) + ethers.toBeHex(value, 32).slice(2) + code.slice(2 + (offset + 32) * 2);
  }
  return code;
}
function fixture() { return { pod: address(81), asset: address(82), staking: address(83), code: runtimeCode(),
  assetCode: "0x6000", stakingCode: "0x6001", assets: 1, reverse: "", supply: 1000000n * WAD, backing: 1200000n * WAD, fee: 200n,
  decimals: 18, probeMutate: (_x: any) => {} }; }
type Fixture = ReturnType<typeof fixture>;
const returned = (id: string, data: string): AdapterRequestResult => ({ id, ok: true, source, data, completion: "returned",
  provenance: { kind: "synthetic", fingerprint: "peapods-contract" } });
function reads(f: Fixture, requests: readonly AdapterRequest[]): AdapterRequestResult[] {
  return requests.map(r => {
    if (r.kind === "get-code") return returned(r.id, r.address.toLowerCase() === f.pod ? f.code : r.address.toLowerCase() === f.asset ? f.assetCode : f.stakingCode);
    assert.equal(r.kind, "eth-call"); if (r.kind !== "eth-call") throw Error("unexpected fixture request");
    const call = ABI.parseTransaction({ data: r.data })!; let value: unknown[];
    switch (call.name) {
      case "getAllAssets": value = [Array.from({ length: f.assets }, () => [f.asset, WAD, 0n, ethers.ZeroAddress, WAD * Q96])]; break;
      case "indexType": value = [0]; break;
      case "decimals": value = [r.to.toLowerCase() === f.asset ? f.decimals : 18]; break;
      case "lpStakingPool": value = [f.staking]; break;
      case "DEBOND_FEE": value = [f.fee]; break;
      case "indexFund": value = [f.reverse || f.pod]; break;
      case "totalSupply": value = [f.supply]; break;
      case "balanceOf": value = [f.backing]; break;
      case "isAsset": value = [true]; break;
      default: throw Error("unexpected fixture read " + call.name);
    }
    return returned(r.id, ABI.encodeFunctionResult(call.name, value));
  });
}
function effects(f: Fixture, step: any): AdapterRequestResult {
  // Synthetic effects only. Independent EVM comparison remains a separate gate.
  const p = step.evidence, q = debond(p.state, p.amountIn), event = ABI.encodeEventLog(ABI.getEvent("Debond")!, [actor, p.amountIn]);
  const result: any = { ...returned("peapods-active-debond", "0x"), effects: { tokenDeltas: [
    { token: f.pod, account: actor, delta: -p.amountIn }, { token: f.pod, account: f.pod, delta: q.feeShares },
    { token: f.asset, account: actor, delta: q.amountOut }, { token: f.asset, account: f.pod, delta: -q.amountOut }],
    totalSupplyDeltas: [{ token: f.pod, delta: -q.burned }], logs: [{ address: f.pod, ...event }] } };
  f.probeMutate(result); return result;
}
function attest(f = fixture()) {
  let step: any = { candidate: { candidateKind: "peapods-debond", pod: f.pod }, step: 0 };
  const variant = plugin.identity.variants[0];
  for (let n = 0; n < 4; n++) {
    const request = declareRequestProgram({ requirements: variant.requirements, buildRequests: variant.buildRequests, decode: () => null }, step);
    const results = request.requests.map(r => r.kind === "effect-delta-simulation" ? effects(f, step) : reads(f, [r])[0]);
    step = { ...step, step: n + 1, evidence: variant.decode({ step, results }) };
    const decision = variant.decide(step);
    if (decision.status !== "continue") return { decision, step };
  }
  throw Error("identity did not finish");
}
function setup(f = fixture()) {
  const { decision } = attest(f); assert.equal(decision.status, "verified"); if (decision.status !== "verified") throw Error("fixture admission");
  const d = plugin.instance.finalizeDescriptor({ draft: plugin.instance.compileDraft(decision.identity), sharedBindings: [] } as any);
  const r = plugin.routes.project({ descriptor: d })[0];
  const input = (amountIn: bigint): any => ({ descriptor: d, route: r, source, executor: actor, amountIn, prefix: [], runtimeEvidence: [] });
  return { d, r, input };
}

test("ABI and default-disabled registration identify debond, not standard ERC4626", () => {
  assert.equal(ABI.getFunction("debond")!.selector, "0xee9c79da");
  assert.equal(ABI.getFunction("debond")!.outputs.length, 0); assert.equal(activation.defaultEnabled, false);
});
test("compiled runtime recognition is instance-independent and masks only compiler immutables", () => {
  assert.equal(proveRuntime(runtimeCode(317n)).feeBps, 317n);
  assert.throws(() => proveRuntime("0x6001"), /runtime/);
  const changed = runtimeCode().slice(0, 1000) + "ff" + runtimeCode().slice(1002);
  assert.throws(() => proveRuntime(changed), /runtime/);
  const bad = runtimeCode().slice(0, 2 + 7321 * 2) + "1".repeat(64) + runtimeCode().slice(2 + (7321 + 32) * 2);
  assert.throws(() => proveRuntime(bad), /immutable/);
  assert.throws(() => proveRuntime(runtimeCode(10001n)), /fee/);
});
test("source recognition plus reciprocal binding and positive effects admits arbitrary compatible instances", () => {
  assert.equal(attest().decision.status, "verified");
  const f = fixture(); f.pod = address(191); f.asset = address(192); f.staking = address(193);
  assert.equal(attest(f).decision.status, "verified");
});
for (const failure of ["runtime", "multi-asset", "reverse", "empty-asset", "zero-backing", "fee-mismatch"])
  test("identity keeps " + failure + " unavailable, never admits by selector", () => {
    const f = fixture();
    if (failure === "runtime") f.code = "0x6001";
    if (failure === "multi-asset") f.assets = 2;
    if (failure === "reverse") f.reverse = actor;
    if (failure === "empty-asset") f.assetCode = "0x";
    if (failure === "zero-backing") f.backing = 0n;
    if (failure === "fee-mismatch") f.fee = 3n;
    assert.equal(attest(f).decision.status, "retryable");
  });
for (const failure of ["input", "output", "backing", "fee-shares", "supply", "caller", "source", "revert", "extra-supply"])
  test("behavior rejects " + failure + " mismatch", () => {
    const f = fixture(); f.probeMutate = x => {
      if (failure === "input") x.effects.tokenDeltas[0].delta = 0n;
      if (failure === "output") x.effects.tokenDeltas[2].delta--;
      if (failure === "backing") x.effects.tokenDeltas[3].delta++;
      if (failure === "fee-shares") x.effects.tokenDeltas[1].delta = 0n;
      if (failure === "supply") x.effects.totalSupplyDeltas[0].delta--;
      if (failure === "caller") x.effects.tokenDeltas[2].account = address(999);
      if (failure === "source") x.source = { ...source, hash: ethers.id("wrong") };
      if (failure === "revert") x.completion = "reverted";
      if (failure === "extra-supply") x.effects.totalSupplyDeltas.push({ token: f.pod, delta: 0n });
    }; assert.equal(attest(f).decision.status, "retryable");
  });
test("call and log discovery are both natural nomination, not injected admission", () => {
  const f = fixture(), data = ABI.encodeFunctionData("debond", [123n, [], []]);
  const nominate = (d: string) => plugin.discovery.decodeCandidate({ observation: { kind: "call", target: f.pod, source, data: d }, matchedPatternId: "peapods-debond-call" });
  assert.equal(nominate(data)?.pod, f.pod); assert.equal(nominate(data + "00"), null);
  const log = ABI.encodeEventLog(ABI.getEvent("Debond")!, [actor, 123n]);
  assert.equal(plugin.discovery.decodeCandidate({ observation: { kind: "log", address: f.pod, ...log, source }, matchedPatternId: "peapods-debond-log" })?.pod, f.pod);
  const { d } = setup(f); const routes = plugin.routes.project({ descriptor: d }); assert.equal(routes.length, 1);
  assert.equal(routes[0].tokenIn, f.pod); assert.equal(routes[0].tokenOut, f.asset);
});
test("source amount semantics preserve both floors, fee shares and near-total exemption", () => {
  const s = { source, supply: 10000n, backing: 10000n, feeBps: 200n };
  const q = debond(s, 1000n); assert.deepEqual([q.burned, q.feeShares, q.amountOut, q.state.supply], [980n, 20n, 979n, 9020n]);
  assert.equal(debond(s, 9799n).exempt, false); assert.equal(debond(s, 9800n).exempt, true);
  assert.equal(debond(s, 9800n).amountOut, 9799n); assert.equal(debond(s, 10000n).amountOut, 10000n);
  assert.equal(debond({ ...s, feeBps: 10000n }, 1000n).amountOut, 0n);
  for (const amount of [0n, -1n, 10001n, ethers.MaxUint256 + 1n]) assert.throws(() => debond(s, amount));
  assert.throws(() => debond({ ...s, supply: 0n }, 1n));
});
test("captured N state amount is distinct from original execution evidence", () => {
  const s = { source, supply: 2535006550096062157911310n, backing: 2535006550096062157911311n, feeBps: 200n };
  assert.equal(debond(s, 11759600366451075559109n).amountOut, 11524408359122054047926n);
});
test("shared Exact state honors the actual amount, source and sequential backing changes", () => {
  const f = fixture(), { input } = setup(f), i = input(WAD), requests = program.buildRequests(i), results = reads(f, requests);
  const q = program.decode({ programInput: i, initialResults: results, dependentEvidence: [] });
  assert.equal(q.amountOut, debond({ source, supply: f.supply, backing: f.backing, feeBps: f.fee }, WAD).amountOut);
  assert.notEqual(program.decode({ programInput: input(9n * WAD), initialResults: results, dependentEvidence: [] }).amountOut, q.amountOut);
  assert.throws(() => program.decode({ programInput: input(WAD), initialResults: results.map((r,n) => n ? r : { ...r, source: { ...source, generation: 4 } }), dependentEvidence: [] }));
  const s = decodeState(i.descriptor, results), trial = emptyExactTrialState(), firstInput = { ...i, trialState: trial.view };
  const first = quoteTrial(firstInput, s)!;
  const next = applyExactTrialState(trial, first.stateChanges ?? [], first.stateEffects ?? []);
  assert.equal(quoteTrial({ ...i, trialState: next.view })!.amountOut, debond(debond(s, WAD).state, WAD).amountOut);
  const dirty = applyExactTrialState(next, [], [tokenBalanceState(f.asset, f.pod)]);
  assert.throws(() => quoteTrial({ ...i, trialState: dirty.view }, s));
});
test("runtime construction passes only r0 into one debond; quoted mode keeps a measured minimum", () => {
  const f = fixture(), { d, r, input } = setup(f), runtime = plugin.execution.buildRuntimeLeg!({ descriptor: d, route: r, source, executor: actor, runtimeEvidence: [] });
  assert(runtime); const inspected = inspectRuntime(runtime.program, 12345n);
  assert.equal(inspected.calls.length, 1); assert.equal(inspected.allowances.length, 0);
  assert.equal(inspected.calls[0].data, ABI.encodeFunctionData("debond", [12345n, [], []]));
  const i = input(WAD), q = program.decode({ programInput: i, initialResults: reads(f, program.buildRequests(i)), dependentEvidence: [] });
  const fragment = plugin.execution.buildFragment({ ...i, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: q.evidence } as any);
  const quoted = fragment.nodes[0].params.runtimeAmountProgram as string;
  let exchanged = false;
  const run = (received: bigint) => { exchanged = false; return inspectRuntime(quoted, WAD, { call(c) {
    if (c.target.toLowerCase() === f.pod) { exchanged = true; return "0x"; }
    return ABI.encodeFunctionResult("balanceOf", [1000000n + (exchanged ? received : 0n)]);
  } }); };
  run(q.amountOut); assert.throws(() => run(q.amountOut - 1n));
  assert.throws(() => plugin.execution.buildRuntimeLeg!({ descriptor: d, route: { ...r, tokenOut: actor }, source, executor: actor, runtimeEvidence: [] }));
});
test("production sim selector constructs runtime trials with throwing Exact/RPC/fallback sentinels", async () => {
  const { d, r } = setup(); const build = () => plugin.execution.buildRuntimeLeg!({ descriptor: d, route: r, source, executor: actor, runtimeEvidence: [] });
  const expected = build()!, edges = [{ adapterId: "family-leg", target: d.pod, tokenIn: d.pod, tokenOut: d.asset },
    { adapterId: "fixture-return", target: actor, tokenIn: d.asset, tokenOut: d.pod }];
  let exact = 0, quoted = 0, rpc = 0, simulated = 0; const events: any[] = [];
  const session: any = { source, fundingActionIds: () => ["fixture-funding"],
    buildRuntimeAmountLeg({ edge }: any) { return edge === edges[0] ? build() : { actionAdapterId: "fixture-return", program: ethers.hexlify(new RuntimeAmountProgram().constant(1,1n).bytes()) }; },
    issueExact() { exact++; throw Error("Exact must not construct runtime"); }, buildExecution() { quoted++; throw Error("quoted fallback forbidden"); },
    buildFundingRoot(i: any) { return { adapterId: "fixture-funding", target: actor, tokenIn: d.pod, tokenOut: d.pod, amount: i.amount, params: {}, children: i.children }; } };
  const selector = createBlockScanSimAmountSelector({ source, executor: actor, record: event => events.push(event), async simulate(plan) {
    simulated++; assert.equal(plan.root.children[0].adapterId, "runtime-amount-flow");
    assert.equal(JSON.parse(plan.root.children[0].params.legs as string)[0].program, expected.program);
    return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: d.pod, calldata: "0x" };
  } });
  await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n }, flashToken: d.pod, profitToken: d.pod },
    tokenPath: { edges }, maxFlashAmount: 10000n, templateName: "peapods-construction-contract" } as any,
    { call() { rpc++; throw Error("RPC forbidden"); } } as any, { executor: actor } as any,
    { strictSession: session, deferPhase2Sim: true, gssMaxTries: 2, deadlineAtMs: Date.now()+10000 });
  assert(simulated >= 4); assert.equal(exact,0); assert.equal(quoted,0); assert.equal(rpc,0);
  const construction = events.filter(e => e.type === "sim_amount_construction"); assert(construction.length);
  assert(construction.every(e => e.mode === "runtime-actual"));
});
test("backing donation refreshes; unrelated Transfer does not dirty every POD holding that asset", () => {
  const { d } = setup(); const change = (from: string, to: string) => plugin.pricing.mutation!.affectedStateKeys({ descriptor: d,
    observation: { kind: "log", address: d.asset, source, ...ABI.encodeEventLog(ABI.getEvent("Transfer")!,[from,to,10n]) } } as any);
  assert.deepEqual(change(actor,d.pod),[d.instanceKey]); assert.deepEqual(change(d.pod,actor),[d.instanceKey]);
  assert.deepEqual(change(actor,address(500)),[]);
});

test("production compiled mutation index preserves backing-transfer filtering across shared assets", () => {
  const first = setup(), f = fixture(); f.pod = address(181); f.staking = address(183);
  const second = setup(f), entries = [first, second].map(({ d, r }) => ({ descriptor: d, routes: [r],
    stateKey: d.instanceKey, dependencies: plugin.pricing.dependencies({ descriptor: d, routes: [r] }) }));
  const index = plugin.pricing.mutation!.compile!({ entries });
  const transfer = (from: string, to: string): any => ({ kind: "log", address: f.asset, source,
    ...ABI.encodeEventLog(ABI.getEvent("Transfer")!, [from, to, 10n]) });
  const assertBothPaths = (observation: any, expected: string[]) => {
    assert.deepEqual([...index.affectedStateKeys({ observation })].sort(), [...expected].sort());
    assert.deepEqual(entries.flatMap(e => plugin.pricing.mutation!.affectedStateKeys({ ...e, observation })).sort(), [...expected].sort());
  };
  assertBothPaths(transfer(actor, address(500)), []);
  assertBothPaths(transfer(actor, first.d.pod), [first.d.instanceKey]);
  assertBothPaths(transfer(second.d.pod, actor), [second.d.instanceKey]);
  assertBothPaths(transfer(first.d.pod, second.d.pod), [first.d.instanceKey, second.d.instanceKey]);
  assertBothPaths({ ...transfer(actor, address(500)), data: "0x12" }, [first.d.instanceKey, second.d.instanceKey]);
  assertBothPaths({ kind: "call", target: first.d.pod, data: "0x12345678", source }, [first.d.instanceKey]);
  assertBothPaths({ kind: "call", target: f.asset, data: "0x12345678", source }, [first.d.instanceKey, second.d.instanceKey]);
});
