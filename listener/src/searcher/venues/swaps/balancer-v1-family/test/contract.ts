import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { plugin, activation } from "../../../production-families/balancer-v1.production.js";
import { definedFamilyPluginContractSummary } from "../../../adapter-family-plugin.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { RuntimeAmountProgram } from "../../../../../adapters/runtime-amount-program.js";
import { createBlockScanSimAmountSelector } from "../../../../simulator/blockscan-sim-amount-selector.js";
import { BONE, FACTORY_CODE_HASH, MAX_UINT, members, POOL, POOL_CODE_HASH, TOKEN } from "../codec.js";
import { bdiv, bmul, decodeState, guardInput, guardOutput, spotPrice, stateRequests } from "../state.js";
import { answer, CANDIDATE, descriptor, EXECUTOR, PINNED, PUBLIC, quote, result, SOURCE, syntheticDescriptor, word } from "./fixtures.js";

test("production contract is default-off and supports every directed pair in finalized 2..8-token pools", () => {
  assert(definedFamilyPluginContractSummary(plugin)); assert.equal(activation.defaultEnabled, false);
  assert.equal(activation.envKey, "SEARCHER_FAMILY_BALANCER_V1_ENABLED");
  assert.equal(ethers.keccak256(PUBLIC.poolCode), POOL_CODE_HASH);
  assert.equal(ethers.keccak256(PUBLIC.factoryCode), FACTORY_CODE_HASH);
  for (const n of [2, 3, 8]) {
    const tokens = Array.from({ length: n }, (_, i) => ethers.toBeHex(BigInt(101 + i), 20));
    const d = syntheticDescriptor(tokens, tokens.map(() => BONE));
    const routes = plugin.routes.project({ descriptor: d }); assert.equal(routes.length, n * (n - 1));
    for (const route of routes) {
      assert.equal(plugin.routes.projectGraph({ descriptor: d, route }).executionTarget, d.pool);
      assert(plugin.execution.buildRuntimeLeg!({ descriptor: d, route, executor: EXECUTOR, runtimeEvidence: [] }));
    }
  }
});
test("exact-in and exact-out observations nominate only; canonical swap logs and calldata are enforced", () => {
  const d = descriptor();
  for (const fn of ["swapExactAmountIn", "swapExactAmountOut"]) {
    const observation = { kind: "call" as const, source: SOURCE, target: d.pool,
      data: POOL.encodeFunctionData(fn, [d.tokens[0], 10n, d.tokens[1], 1n, MAX_UINT]) };
    assert.deepEqual(plugin.discovery.decodeCandidate({ observation, matchedPatternId: `balancer-v1-${fn}` }), CANDIDATE);
    assert.equal(plugin.discovery.decodeCandidate({ observation: { ...observation, data: observation.data + "00" }, matchedPatternId: `balancer-v1-${fn}` }), null);
  }
  const event = POOL.encodeEventLog(POOL.getEvent("LOG_SWAP")!, [EXECUTOR, d.tokens[0], d.tokens[1], 10n, 20n]);
  const log = { kind: "log" as const, source: SOURCE, address: d.pool, ...event };
  assert.deepEqual(plugin.discovery.decodeCandidate({ observation: log, matchedPatternId: "balancer-v1-LOG_SWAP" }), CANDIDATE);
  assert.equal(plugin.discovery.decodeCandidate({ observation: { ...log, data: log.data + "00" }, matchedPatternId: "balancer-v1-LOG_SWAP" }), null);
  assert.equal(plugin.actionAdapters[0].matchTrace(d.pool, POOL.getFunction("swapExactAmountOut")!.selector), false);
});
test("identity requires reverse factory creation; matching code alone never admits a pool", () => {
  assert.throws(() => descriptor(r => r.id === "registered" ? result(r.id, word(0n)) : answer(r)), /chain-proven-rejected/);
  assert.throws(() => descriptor(r => r.id === "pool-code" ? result(r.id, "0x6000") : answer(r)), /retryable/);
  assert.throws(() => descriptor(r => r.id === "factory-code" ? result(r.id, "0x6000") : answer(r)), /factory code/);
  // An arbitrary pool address is admitted by this contract only if its own
  // chain-response fixture supplies creation membership and matching code.
  const pool = ethers.toBeHex(999n, 20);
  const other = descriptor(r => {
    if (r.kind !== "eth-call") return answer(r);
    if (r.id === "registered") return result(r.id, word(1n));
    return answer({ ...r, to: r.to.toLowerCase() === pool ? PUBLIC.pool : r.to });
  }, { ...CANDIDATE, pool });
  assert.equal(other.pool, pool);
});
test("unfinalized permission is retryable; malformed members, weights and mixed source fail closed", () => {
  for (const id of ["finalized", "public"]) assert.throws(() => descriptor(r => r.id === id ? result(id, word(0n)) : answer(r)), /retryable/);
  for (const data of ["0x", POOL.encodeFunctionResult("getFinalTokens", [[]]), POOL.encodeFunctionResult("getFinalTokens", [[PINNED.tokens[0], PINNED.tokens[0]]])]) assert.throws(() => members(data));
  for (const [id, value] of [["fee", BONE], ["weight:0", 0n], ["weight:0", 50n * BONE]] as const)
    assert.throws(() => descriptor(r => r.id === id ? result(id, word(value)) : answer(r)));
  const v = plugin.identity.variants[0], step = { candidate: CANDIDATE, step: 0 }, rs = v.buildRequests(step).map(answer);
  for (const bad of [rs.slice(1), [...rs, rs[0]], rs.map((r, i) => i ? r : { ...r, source: { ...SOURCE, hash: ethers.ZeroHash } })])
    assert.throws(() => v.decode({ step, results: bad }));
  assert.throws(() => descriptor(r => r.id === "registered" ? { id: r.id, source: SOURCE, ok: false, failure: "deadline" } : answer(r)), /unresolved/);
});
test("two-direction pinned calculator outputs remain full specified amounts, not the original pre-call receipt", () => {
  for (const c of PINNED.cases.filter((c: { amountOut: string }) => c.amountOut !== "0")) {
    const q = quote(BigInt(c.amountIn), c.i);
    assert.equal(q.method.chainAmountQuote, true);
    assert.equal(q.quoted.amountOut, BigInt(c.amountOut)); assert.equal(q.quoted.evidence.amountIn, BigInt(c.amountIn));
    assert.equal(q.initialResults.length, 2); assert.equal(q.round?.requests.length, 1);
    const s = decodeState(q.input.descriptor, q.initialResults, SOURCE), d = q.input.descriptor;
    assert.equal(spotPrice(s.balances[c.i], d.weights[c.i], s.balances[c.j], d.weights[c.j], d.swapFee), BigInt(c.spotBefore));
    assert.equal(spotPrice(s.balances[c.i] + BigInt(c.amountIn), d.weights[c.i], s.balances[c.j] - BigInt(c.amountOut), d.weights[c.j], d.swapFee), BigInt(c.spotAfter));
  }
  assert.notEqual(quote(8444695829171278n).quoted.amountOut, 1313743479005274328n, "N end-state is not the original call pre-state");
  const a = quote(8444695829171278n), b = quote(84446958291712780n);
  assert(b.quoted.amountOut < a.quoted.amountOut * 10n);
});
test("zero, dust, MAX_IN_RATIO, checked half-up rounding and native ERR_MATH_APPROX boundaries", () => {
  assert.equal(quote(0n).quoted.amountOut, 0n); assert.throws(() => quote(1n), /spendable/);
  const d = descriptor(), r = plugin.routes.project({ descriptor: d })[0], s = decodeState(d, stateRequests(d).map(answer));
  const max = bmul(s.balances[r.i], BONE / 2n);
  guardInput(d, r, s, max); assert.throws(() => guardInput(d, r, s, max + 1n), /MAX_IN_RATIO/);
  assert.throws(() => guardInput(d, r, { ...s, balances: [0n, s.balances[1]] }, 1n), /empty/);
  assert.throws(() => guardOutput(d, r, s, 10n ** 18n, s.balances[r.j]), /spendable/);
  assert.throws(() => guardOutput(d, r, s, 10n ** 18n, s.balances[r.j] / 2n), /MATH_APPROX/);
  assert.equal(bmul(1n, BONE / 2n), 1n); assert.equal(bdiv(1n, 2n * BONE), 1n);
  for (const f of [() => bmul(MAX_UINT, 2n), () => bdiv(MAX_UINT, BONE), () => bdiv(1n, 0n), () => quote(-1n)]) assert.throws(f);
});
test("Exact rejects foreign caller, route, missing/extra rounds and source mismatches", () => {
  const q = quote(8444695829171278n);
  for (const executor of [ethers.ZeroAddress, q.input.descriptor.pool, ...q.input.descriptor.tokens]) assert.throws(() => q.method.program.buildRequests({ ...q.input, executor }));
  assert.throws(() => q.method.program.buildRequests({ ...q.input, route: { ...q.input.route, i: 0 } }));
  for (const evidence of [[], [...q.dependentEvidence, ...q.dependentEvidence]])
    assert.throws(() => q.method.program.decode({ programInput: q.input, initialResults: q.initialResults, dependentEvidence: evidence }));
  assert.throws(() => q.method.program.decode({ programInput: { ...q.input, source: { ...SOURCE, generation: 2 } }, initialResults: q.initialResults, dependentEvidence: q.dependentEvidence }));
});
test("quoted fragment binds amount, executor and quote, honors minOut, and owns temporary approvals", () => {
  for (const i of [0, 1]) {
    const q = quote(BigInt(PINNED.cases.find((c: { i: number; amountIn: string }) => c.i === i && c.amountIn !== "1").amountIn), i);
    const input = { ...q.input, quotedAmountOut: q.quoted.amountOut, minAmountOut: q.quoted.amountOut, exactEvidence: q.quoted.evidence };
    const f = plugin.execution.buildFragment(input); assert.equal(f.requirements.length, 0);
    assert.equal(f.nodes[0].params.minAmountOut, q.quoted.amountOut);
    assert(plugin.actionAdapters[0].encode(f.nodes[0], EXECUTOR, new Uint8Array()).length > 500);
    for (const change of [{ amountIn: input.amountIn + 1n }, { minAmountOut: 0n }, { minAmountOut: input.quotedAmountOut + 1n },
      { executor: ethers.toBeHex(1n, 20) }, { exactEvidence: { ...input.exactEvidence, binding: "foreign" } }])
      assert.throws(() => plugin.execution.buildFragment({ ...input, ...change }));
    assert.throws(() => plugin.actionAdapters[0].encode(f.nodes[0], EXECUTOR, new Uint8Array([1])));
  }
});
test("runtime reads no trial amount or Exact; ABI patches input only and cleanup/debit/receipt guards execute", () => {
  const d = descriptor();
  for (const route of plugin.routes.project({ descriptor: d })) for (const amount of [19n, 8444695829171278n, 84446958291712780n]) {
    const input: any = { descriptor: d, route, executor: EXECUTOR, runtimeEvidence: [], source: SOURCE };
    for (const key of ["amountIn", "exactEvidence", "quotedAmountOut", "minAmountOut"]) Object.defineProperty(input, key, { get() { throw Error("read " + key); } });
    const leg = plugin.execution.buildRuntimeLeg!(input)!;
    const run = (extra: bigint, received: bigint, clear = true) => {
      let swapped = false, allowance = 77n;
      return inspectRuntime(leg.program, amount, { call(c) {
        if (c.data.startsWith(TOKEN.getFunction("balanceOf")!.selector)) return word(c.target.toLowerCase() === route.tokenIn ? 100n + amount - (swapped ? amount + extra : 0n) : 62n + (swapped ? received : 0n));
        if (c.data.startsWith(TOKEN.getFunction("approve")!.selector)) { const a = TOKEN.decodeFunctionData("approve", c.data); assert.equal(a[0].toLowerCase(), d.pool); if (clear || a[1] !== 0n) allowance = a[1]; return word(1n); }
        if (c.data.startsWith(TOKEN.getFunction("allowance")!.selector)) return word(allowance);
        const args = POOL.decodeFunctionData("swapExactAmountIn", c.data);
        assert.equal(args[0].toLowerCase(), route.tokenIn); assert.equal(args[1], amount); assert.equal(args[2].toLowerCase(), route.tokenOut);
        assert.equal(args[3], 1n); assert.equal(args[4], MAX_UINT); assert.equal(allowance, amount); swapped = true; return word(received) + word(0n).slice(2);
      } });
    };
    const trace = run(0n, 123n);
    assert.deepEqual(trace.calls.filter(c => c.data.startsWith(TOKEN.getFunction("approve")!.selector)).map(c => TOKEN.decodeFunctionData("approve", c.data)[1]), [0n, amount, 0n]);
    assert.equal(trace.registers[5], 123n); assert.equal(trace.registers[0], amount);
    assert.throws(() => run(1n, 123n)); assert.throws(() => run(0n, 0n)); assert.throws(() => run(0n, 123n, false));
  }
});
test("raw prices share one balance round and pool-only mutation refresh includes non-swap calls", () => {
  const d = descriptor(), routes = plugin.routes.project({ descriptor: d });
  const pd = plugin.pricing.finalizePricingDescriptor({ draft: plugin.pricing.compileDraft({ descriptor: d, routes, stateKey: d.pool }), sharedBindings: [] });
  const requests = plugin.pricing.current.buildRequests({ descriptor: pd, routes, source: SOURCE }); assert.equal(requests.length, 2);
  const snapshot = plugin.pricing.current.decodeSnapshot({ descriptor: pd, initialResults: requests.map(answer), dependentEvidence: [] });
  const mids = plugin.pricing.current.deriveMids({ descriptor: pd, routes, snapshot }); assert.equal(mids.size, 2);
  const dependencies = plugin.pricing.dependencies({ descriptor: pd, routes }); assert.deepEqual(dependencies, [d.pool]);
  const index = plugin.pricing.mutation!.compile!({ entries: [{ descriptor: pd, routes, stateKey: d.pool, dependencies }] });
  const call = { kind: "call" as const, source: SOURCE, target: d.pool, data: "0xdeadbeef" };
  assert.deepEqual(index.affectedStateKeys({ observation: call }), [d.pool]);
  assert.deepEqual(index.affectedStateKeys({ observation: { ...call, target: d.tokens[0] } }), []);
  assert.notDeepEqual(plugin.pricing.current.deriveMids({ descriptor: pd, routes, snapshot: { ...snapshot, balances: [snapshot.balances[0] * 2n, snapshot.balances[1]] } }), mids);
});
test("production sim selector uses the real Family emitter with zero Exact, RPC and quoted fallback", async () => {
  const d = descriptor();
  for (const route of plugin.routes.project({ descriptor: d })) {
    const input = { descriptor: d, route, executor: EXECUTOR, source: SOURCE, runtimeEvidence: [] };
    const edges: any[] = [{ adapterId: "family-leg", target: d.pool, tokenIn: route.tokenIn, tokenOut: route.tokenOut },
      { adapterId: "fixture-return", target: EXECUTOR, tokenIn: route.tokenOut, tokenOut: route.tokenIn }];
    let exact = 0, quoted = 0, simulated = 0; const events: any[] = [];
    const session: any = { source: SOURCE, fundingActionIds: () => ["fixture-funding"],
      buildRuntimeAmountLeg({ edge }: any) { return edge === edges[0] ? plugin.execution.buildRuntimeLeg!(input) : { actionAdapterId: "fixture-return", program: ethers.hexlify(new RuntimeAmountProgram().constant(1, 1n).bytes()) }; },
      issueExact() { exact++; throw Error("unexpected Exact"); }, buildExecution() { quoted++; throw Error("quoted fallback"); },
      buildFundingRoot(i: any) { return { adapterId: "fixture", target: EXECUTOR, tokenIn: route.tokenIn, tokenOut: route.tokenIn, amount: i.amount, params: {}, children: i.children }; } };
    const selector = createBlockScanSimAmountSelector({ source: SOURCE, executor: EXECUTOR, record: e => events.push(e), async simulate(plan) {
      simulated++; assert.equal(plan.root.children[0].adapterId, "runtime-amount-flow");
      assert.equal(JSON.parse(plan.root.children[0].params.legs as string)[0].program, plugin.execution.buildRuntimeLeg!(input)!.program);
      return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: route.tokenIn, calldata: "0x" };
    } });
    await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n }, flashToken: route.tokenIn, profitToken: route.tokenIn },
      tokenPath: { edges }, maxFlashAmount: 10000n, templateName: "synthetic-contract-not-history" } as any,
    { call() { throw Error("unexpected RPC"); } } as any, { executor: EXECUTOR } as any,
    { strictSession: session, deferPhase2Sim: true, gssMaxTries: 2, deadlineAtMs: Date.now() + 10000 });
    assert.equal(exact, 0); assert.equal(quoted, 0); assert(simulated >= 4);
    assert(events.filter(e => e.type === "sim_amount_construction").every(e => e.mode === "runtime-actual"));
  }
});

test("official source recompilation differs only in counted Solidity metadata hashes, including embedded BPool", () => {
  const compiled = JSON.parse(readFileSync(new URL("./compiled-source.json", import.meta.url), "utf8"));
  assert.equal(compiled.compiler, "0.5.12+commit.7709ece9");
  // Only the 32-byte bzzr1 value is replaced; all executable opcodes, embedded
  // creation code, metadata structure/version and lengths must still match.
  const normalized = (s: string, count: number) => {
    let found = 0;
    const value = s.replace(/(a265627a7a72315820)[0-9a-f]{64}(64736f6c634300050c0032)/g, (_x, head, tail) => { found++; return head + "00".repeat(32) + tail; });
    assert.equal(found, count); return value;
  };
  assert.equal(normalized(compiled.poolRuntime, 1), normalized(PUBLIC.poolCode, 1));
  assert.equal(normalized(compiled.factoryRuntime, 2), normalized(PUBLIC.factoryCode, 2));
  assert(compiled.verification.every((v: any) => v.githubMatches.every((s: any) => s.equal)));
});
