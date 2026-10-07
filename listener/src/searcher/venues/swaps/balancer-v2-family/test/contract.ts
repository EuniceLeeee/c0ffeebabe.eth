import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { plugin, activation } from "../../../production-families/balancer-v2.production.js";
import { createBlockScanSimAmountSelector } from "../../../../simulator/blockscan-sim-amount-selector.js";
import { RuntimeAmountProgram } from "../../../../../adapters/runtime-amount-program.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { VAULT, VAULT_ABI, POOL_ABI, MAX_INPUT, MAX_UINT, SWAP_AMOUNT_OFFSET, lower, poolIdentity, quoteOutput, probeAmounts } from "../codec.js";
import { LOG_ID, CALL_ID, SURFACE, SURFACE_ID, SWAP_TOPIC, decodeSwapLog } from "../discovery.js";
import { reverseBinding } from "../nomination.js";
import { receiptObservation } from "../swap.js";
import type { AdapterRequestResult } from "../../../adapter-request-program.js";
import { SOURCE, POOL, TOKENS, EXTRA, FOREIGN, EXECUTOR, idFor, word, success, candidate, fixture, setup, identityDecision, exact, currentPricing } from "./fixtures.js";

const erc20 = new ethers.Interface(["function approve(address,uint256) returns(bool)", "function allowance(address,address) view returns(uint256)"]);
const observation = (poolId = idFor()) => ({ kind: "log" as const, source: SOURCE, address: VAULT,
  ...VAULT_ABI.encodeEventLog(VAULT_ABI.getEvent("Swap")!, [poolId, ...TOKENS, 6917984563928420n, 95034526410411689937n]),
});
const runtime = (s = setup(), r = s.routes[0]) => plugin.execution.buildRuntimeLeg!({
  descriptor: s.descriptor, route: r, executor: EXECUTOR, runtimeEvidence: [], source: SOURCE,
})!;
function interpretApprovals(program: string, amount: bigint, options: {
  ignoreGrant?: boolean; ignoreClear?: boolean; noReturn?: boolean; spend?: bigint;
} = {}) {
  let allowance = 100n, swapped = false;
  return inspectRuntime(program, amount, { call(c) {
    if (c.static) {
      const args = erc20.decodeFunctionData("allowance", c.data);
      assert.equal(args[0], EXECUTOR); assert.equal(args[1], VAULT);
      return word(allowance);
    }
    if (c.target === VAULT) {
      assert.equal(allowance, amount); swapped = true;
      allowance -= options.spend ?? amount; return word(1n);
    }
    const [, grant] = erc20.decodeFunctionData("approve", c.data);
    if ((options.ignoreGrant && grant > 0n) || (options.ignoreClear && swapped && grant === 0n)) return word(0n);
    allowance = grant; return options.noReturn ? "0x" : word(1n);
  } });
}

test("definition keeps independent funding semantics and is disabled by default", () => {
  assert.equal(plugin.manifest.domain, "swap"); assert.deepEqual(plugin.manifest.ownedActionAdapterIds, ["balancer-v2-vault-swap"]);
  assert.equal(activation.enabled, false); assert.equal(activation.envKey, "SEARCHER_FAMILY_BALANCER_V2_ENABLED");
});
test("arbitrary Vault-registered pools produce every ordered direction, no sample pool allowlist", () => {
  for (const n of [2, 3, 8]) {
    const tokens = [...TOKENS, ...Array.from({ length: n - 2 }, (_, i) => ethers.toBeHex(i + 30, 20))];
    const f = fixture(tokens, tokens.map((_, i) => i === 2 ? 6 : 18), idFor(FOREIGN, n === 2 ? 2 : 1));
    const s = setup(f);
    assert.equal(s.identity.subject, FOREIGN); assert.equal(s.routes.length, n * (n - 1));
    assert.equal(new Set(s.routes.map(r => r.routeKey)).size, n * (n - 1));
    assert.equal(s.descriptor.instanceKey, f.poolId);
    for (const route of s.routes) {
      const projected = plugin.routes.projectGraph({ descriptor: s.descriptor, route });
      assert.equal(projected.executionTarget, s.descriptor.pool);
      assert.deepEqual(projected.venueIdentity, { kind: "vault-pool-id", vault: lower(VAULT), poolId: f.poolId });
      assert(runtime(s, route));
    }
  }
});
test("discovery decodes bytes32 pool identity, not the common Vault address", () => {
  const log = observation(), decode = (o: any = log, matchedPatternId = LOG_ID) => plugin.discovery.decodeCandidate({ observation: o, matchedPatternId });
  assert.equal(decode()!.poolId, idFor()); assert.equal(decode()!.pool, POOL);
  assert.equal(plugin.discovery.candidateKey(decode()!), idFor());
  for (const o of [{ ...log, address: FOREIGN }, { ...log, data: log.data + "00" },
    { ...log, topics: [...log.topics, ethers.ZeroHash] },
    { ...log, topics: [ethers.ZeroHash, ...log.topics.slice(1)] },
    { ...log, topics: [SWAP_TOPIC, idFor(POOL, 3), ...log.topics.slice(2)] },
    { ...log, topics: [SWAP_TOPIC, log.topics[1], log.topics[2], log.topics[2]] }]) assert.equal(decode(o), null);
  const data = VAULT_ABI.encodeFunctionData("swap", [[idFor(), 0, ...TOKENS, 10n, "0x"], [EXECUTOR, false, EXECUTOR, false], 1n, MAX_UINT]);
  assert(decode({ kind: "call", source: SOURCE, target: VAULT, data }, CALL_ID));
  assert.equal(decode({ kind: "call", source: SOURCE, target: FOREIGN, data }, CALL_ID), null);
  assert.equal(decode({ kind: "call", source: SOURCE, target: VAULT, data: data + "00" }, CALL_ID), null);
  const surface = { kind: "address-surface", source: SOURCE, address: POOL, codeHash: ethers.ZeroHash,
    implementationWord: ethers.ZeroHash, interfaceFingerprints: [SURFACE], opaque: { poolId: idFor() } };
  assert(decode(surface, SURFACE_ID)); assert.equal(decode({ ...surface, address: VAULT }, SURFACE_ID), null);
  assert.throws(() => poolIdentity(idFor(POOL, 3))); assert.throws(() => poolIdentity(ethers.ZeroHash));
});
test("reverse nomination accepts the generic singleton poolId shape and rejects foreign evidence", async () => {
  const f = fixture(), provider: any = {
    getCode: async () => "0x60006000",
    call: async ({ to, data }: any, block: number) => { assert.equal(block, SOURCE.number); return (f.answer({ id: "reverse", kind: "eth-call", to, data, completion: "return-data" }) as any).data; },
  };
  const input: any = { source: SOURCE, provider, nominations: [{ address: VAULT, opaque: { adapter: "balancer-v2", poolId: idFor() } }] };
  const result = await reverseBinding(input); assert.equal(result[0].status, "verified");
  if (result[0].status === "verified") {
    assert.equal(result[0].observation.kind, "address-surface");
    assert("address" in result[0].observation); assert.equal(result[0].observation.address, POOL);
  }
  const foreign = await reverseBinding({ ...input, nominations: [{ address: FOREIGN, opaque: input.nominations[0].opaque }] });
  assert.equal(foreign[0].status, "failed");
  const unrelated = await reverseBinding({ ...input, nominations: [{ address: VAULT, opaque: { adapter: "univ2", poolId: idFor() } }] });
  assert.equal(unrelated[0].status, "unsupported");
});
test("identity rejects contradictory bindings; transport failures and source mismatch cannot verify", () => {
  const f = fixture();
  const overrides = [
    ["membership", VAULT_ABI.encodeFunctionResult("getPool", [FOREIGN, 2]), "no-vault-membership"],
    ["pool-vault", POOL_ABI.encodeFunctionResult("getVault", [FOREIGN]), "foreign-pool-binding"],
    ["pool-id", POOL_ABI.encodeFunctionResult("getPoolId", [idFor(FOREIGN)]), "foreign-pool-binding"],
    ["pool-code", "0x", "no-pool-code"],
  ];
  for (const [id, data, reasonCode] of overrides) {
    const result = identityDecision(req => req.id === id ? success(id, data) : f.answer(req));
    assert.equal(result.status, "chain-proven-rejected");
    if (result.status === "chain-proven-rejected") assert.equal(result.reasonCode, reasonCode);
  }
  assert.throws(() => identityDecision(req => req.id === "membership" ?
    { id: req.id, ok: false, failure: "rpc", source: SOURCE } : f.answer(req)), /unresolved/);
  assert.throws(() => identityDecision(req => req.id === "membership" ?
    { ...f.answer(req), source: { ...SOURCE, generation: 2 } } : f.answer(req)), /foreign source/);
  assert.throws(() => identityDecision(f.answer, { ...candidate(), hintedTokenIn: FOREIGN }), /not registered/);
  assert.throws(() => identityDecision(req => req.id === "decimals:0" ? success(req.id, word(37n)) : f.answer(req)), /scale/);
  const old = plugin.identity.variants[0].buildRequests({ candidate: candidate(), step: 0 });
  assert.equal(old.filter(r => r.kind === "get-code").length, 2);
});
test("current quote rechecks registration tokens and last-change source", () => {
  for (const data of [
    VAULT_ABI.encodeFunctionResult("getPoolTokens", [[...TOKENS].reverse(), [100n, 100n], SOURCE.number]),
    VAULT_ABI.encodeFunctionResult("getPoolTokens", [TOKENS, [100n, 100n], SOURCE.number + 1]),
    VAULT_ABI.encodeFunctionResult("getPoolTokens", [TOKENS, [0n, 100n], SOURCE.number]),
  ]) {
    const f = fixture(), answer = f.answer;
    f.answer = r => r.id === "current-tokens" ? success(r.id, data) : answer(r);
    assert.throws(() => currentPricing(setup(f)).run(), /binding changed|liquidity/);
  }
});
test("chain quote preserves every specified amount and caller, never linearizes a point rate", () => {
  const s = setup(fixture([...TOKENS, EXTRA], [18, 18, 6]));
  for (const route of s.routes) for (const amount of [10n ** BigInt(s.descriptor.binding.decimals[route.i]), 6917984563928420n, 10n ** 20n]) {
    const q = exact(s, amount, route); assert(q.quote.amountOut > 0n);
    assert.equal(q.method.chainAmountQuote, true); assert.equal(s.f.quotes.at(-1), amount);
    const request = q.requests[0]; assert(request.kind === "eth-call");
    assert.deepEqual(request.caller, { kind: "executor" });
    const args = VAULT_ABI.decodeFunctionData("queryBatchSwap", request.data);
    assert.equal(args[1][0].amount, amount);
    assert.deepEqual([...args[2]], [route.tokenIn, route.tokenOut]);
    assert.deepEqual([...args[3]], [EXECUTOR, false, EXECUTOR, false]);
  }
  const small = exact(setup(), 10n ** 18n), large = exact(setup(), 10n ** 23n);
  assert(large.quote.amountOut < small.quote.amountOut * 100000n);
  assert.equal(exact(setup(), 0n).quote.amountOut, 0n);
});
test("quote delta signs/count/bounds, foreign sources, actor and route tampering fail closed", () => {
  const q = exact(), decode = (initialResults: readonly AdapterRequestResult[]) =>
    q.method.program.decode({ programInput: q.input, initialResults, dependentEvidence: [] });
  for (const deltas of [[q.input.amountIn, 1n], [q.input.amountIn, 0n], [q.input.amountIn + 1n, -1n],
    [q.input.amountIn, -1n, 0n], [q.input.amountIn, -(1n << 255n)]])
    assert.throws(() => decode([success("exact-in", VAULT_ABI.encodeFunctionResult("queryBatchSwap", [deltas]))]), /deltas/);
  assert.throws(() => decode([{ ...q.results[0], source: { ...SOURCE, hash: ethers.ZeroHash } }]), /foreign source/);
  assert.throws(() => decode([...q.results, ...q.results]), /result set/);
  assert.throws(() => decode([success("exact-in", "0x")]));
  assert.throws(() => exact(setup(), -1n), /input/); assert.throws(() => exact(setup(), MAX_INPUT + 1n), /input/);
  assert.throws(() => q.method.program.buildRequests({ ...q.input, executor: ethers.ZeroAddress }), /zero/);
  assert.throws(() => q.method.program.buildRequests({ ...q.input, route: { ...q.input.route, poolId: idFor(FOREIGN) } }), /descriptor/);
  assert.equal(quoteOutput(VAULT_ABI.encodeFunctionResult("queryBatchSwap", [[1n, 0n]]), 1n, true), 0n);
});
test("current pricing first-success optimization and zero/revert fallback preserve probe order", () => {
  const s = setup(), p = currentPricing(s), amounts = probeAmounts(18, s.f.balances[0]);
  const first = p.run(); assert.equal(first.batches.length, 1); assert.equal(first.batches[0].length, 1);
  const zero = success("current-quote:0", VAULT_ABI.encodeFunctionResult("queryBatchSwap", [[amounts[0], 0n]]));
  const reverted: AdapterRequestResult = { ...success("current-quote:0", "0x"), completion: "reverted-as-declared" };
  for (const fail of [zero, reverted]) {
    const run = p.run(req => req.id === fail.id ? fail : s.f.answer(req));
    assert.equal(run.batches.length, 2);
    assert.equal(run.batches[1].length, amounts.length - 1);
    assert.equal(run.snapshot.amountIn, amounts[2]); // amount=1 rounds to zero; the next larger probe succeeds.
  }
  const mid = plugin.pricing.current.deriveMids({ descriptor: p.descriptor, routes: [p.route], snapshot: first.snapshot }).get(p.route.routeKey)!;
  assert.equal(mid.mid, Number(first.snapshot.amountOut) / Number(first.snapshot.amountIn));
  assert.equal(mid.feeBps, 0); assert.equal(mid.pool, s.descriptor.pool);
});
test("all directions construct without reading trial input/quote/RPC; runtime ABI patches the exact input word", () => {
  const s = setup(fixture([...TOKENS, EXTRA], [18, 18, 6]));
  for (const route of s.routes) {
    const input: any = { descriptor: s.descriptor, route, executor: EXECUTOR, runtimeEvidence: [], source: SOURCE };
    for (const key of ["amountIn", "quotedAmountOut", "exactEvidence", "provider"])
      Object.defineProperty(input, key, { get() { throw Error("unexpected " + key); } });
    const leg = plugin.execution.buildRuntimeLeg!(input)!;
    for (const amount of [1n, 123456789n, MAX_INPUT]) {
      const result = interpretApprovals(leg.program, amount);
      assert.equal(result.calls.length, 6); assert.equal(result.allowances.length, 0);
      const approvals = result.calls.filter(c => c.target === route.tokenIn && !c.static);
      assert.deepEqual(approvals.map(c => [...erc20.decodeFunctionData("approve", c.data)]), [[VAULT, 0n], [VAULT, amount], [VAULT, 0n]]);
      const call = result.calls.find(c => c.target === VAULT)!;
      assert.deepEqual(call.patches, [{ offset: SWAP_AMOUNT_OFFSET, reg: 0 }]);
      const args = VAULT_ABI.decodeFunctionData("swap", call.data);
      assert.deepEqual([...args[0]], [s.descriptor.poolId, 0n, route.tokenIn, route.tokenOut, amount, "0x"]);
      assert.deepEqual([...args[1]], [EXECUTOR, false, EXECUTOR, false]);
      assert.equal(args[2], 1n); assert.equal(args[3], MAX_UINT);
    }
    assert.throws(() => inspectRuntime(leg.program, MAX_INPUT + 1n), /mismatch/);
    assert.throws(() => plugin.execution.buildRuntimeLeg!({ ...input, route: { ...route, tokenOut: FOREIGN } }), /descriptor/);
  }
});
test("quoted execution independently preserves exact evidence, min-out and temporary approvals", () => {
  const q = exact(), args = { ...q.input, quotedAmountOut: q.quote.amountOut, minAmountOut: q.quote.amountOut - 1n, exactEvidence: q.quote.evidence };
  const fragment = plugin.execution.buildFragment(args), node = fragment.nodes[0];
  const bytes = plugin.actionAdapters[0].encode(node, EXECUTOR, new Uint8Array());
  assert.equal(bytes[0], 14);
  assert.equal(BigInt(ethers.hexlify(bytes.slice(1, 33))), q.input.amountIn);
  assert.equal(Number(BigInt(ethers.hexlify(bytes.slice(33, 36)))), bytes.length - 36);
  const program = ethers.hexlify(bytes.slice(36)), interpreted = interpretApprovals(program, q.input.amountIn);
  const swap = VAULT_ABI.encodeFunctionData("swap", [[idFor(), 0, q.input.route.tokenIn, q.input.route.tokenOut, q.input.amountIn, "0x"],
    [EXECUTOR, false, EXECUTOR, false], args.minAmountOut, MAX_UINT]);
  assert.equal(interpreted.calls.find(c => c.target === VAULT)!.data, swap);
  interpretApprovals(program, q.input.amountIn, { noReturn: true });
  assert.throws(() => interpretApprovals(program, q.input.amountIn, { ignoreGrant: true }), /mismatch/);
  assert.throws(() => interpretApprovals(program, q.input.amountIn, { ignoreClear: true, spend: q.input.amountIn - 1n }), /mismatch/);
  assert.throws(() => plugin.execution.buildFragment({ ...args, amountIn: args.amountIn + 1n }), /evidence/);
  assert.throws(() => plugin.execution.buildFragment({ ...args, executor: FOREIGN }), /evidence/);
  assert.throws(() => plugin.execution.buildFragment({ ...args, minAmountOut: args.quotedAmountOut + 1n }), /evidence/);
  assert.throws(() => plugin.actionAdapters[0].encode({ ...node, target: FOREIGN }, EXECUTOR, new Uint8Array()), /action/);
  assert.throws(() => plugin.actionAdapters[0].encode(node, EXECUTOR, new Uint8Array([0])), /action/);
});
test("receipt observation separates two pools sharing a Vault and token pair", async () => {
  const a = setup(), b = setup(fixture(TOKENS, [18, 18], idFor(FOREIGN)));
  const graph: any[] = [a, b].map(s => ({ adapterId: "balancer-v2-vault-swap", target: s.descriptor.pool,
    tokenIn: s.routes[0].tokenIn, tokenOut: s.routes[0].tokenOut }));
  const ctx: any = { matchedOwnedTriggers: [{ triggerId: "t", logIndex: 0, emitter: VAULT, topic0: SWAP_TOPIC }],
    logs: [observation(b.descriptor.poolId)], graph, sourceGeneration: 1,
    control: { signal: new AbortController().signal, deadlineAtMs: Date.now() + 1000 },
    resolveBinding: (edge: any) => ({ familyId: "balancer-v2", descriptor: edge === graph[0] ? a.descriptor : b.descriptor }) };
  const result = await receiptObservation.decodeReceiptImpacts!(ctx);
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") {
    assert.equal(result.impacts[0].impact.pool, b.descriptor.pool);
    assert.equal(result.impacts[0].impact.poolId, undefined);
  }
  const absent = await receiptObservation.decodeReceiptImpacts!({ ...ctx, graph: graph.slice(0, 1) });
  assert.equal(absent.status, "unresolved"); assert.equal(decodeSwapLog(ctx.logs[0])!.poolId, b.descriptor.poolId);
});

test("production sim amount selector uses runtime construction with zero off-chain Exact or quoted fallback", async () => {
  const s = setup(fixture([...TOKENS, EXTRA], [18, 18, 6]));
  for (const route of s.routes) {
    const edges: any[] = [{ adapterId: "balancer-v2-vault-swap", target: s.descriptor.pool, tokenIn: route.tokenIn, tokenOut: route.tokenOut },
      { adapterId: "fixture-return", target: FOREIGN, tokenIn: route.tokenOut, tokenOut: route.tokenIn }];
    let exactCalls = 0, quotedBuilds = 0, sims = 0;
    const events: any[] = [];
    const session: any = {
      source: SOURCE, fundingActionIds: () => ["fixture-funding"],
      buildRuntimeAmountLeg({ edge }: any) { return edge === edges[0] ? runtime(s, route) :
        { actionAdapterId: "fixture-return", program: ethers.hexlify(new RuntimeAmountProgram().constant(1, 1n).bytes()) }; },
      issueExact() { exactCalls++; throw Error("unexpected Exact"); },
      buildExecution() { quotedBuilds++; throw Error("unexpected quoted fallback"); },
      buildFundingRoot(i: any) { return { adapterId: "fixture", target: EXECUTOR, tokenIn: route.tokenIn,
        tokenOut: route.tokenIn, amount: i.amount, params: {}, children: i.children }; },
    };
    const selector = createBlockScanSimAmountSelector({ source: SOURCE, executor: EXECUTOR, record: e => events.push(e),
      async simulate(plan) {
        sims++; const flow = plan.root.children[0]!;
        assert.equal(flow.adapterId, "runtime-amount-flow");
        assert.equal(JSON.parse(flow.params.legs as string)[0].program, runtime(s, route).program);
        return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: route.tokenIn, calldata: "0x" };
      },
    });
    await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n },
      flashToken: route.tokenIn, profitToken: route.tokenIn }, tokenPath: { edges }, maxFlashAmount: 10000n, templateName: "synthetic-v2" } as any,
      { call() { throw Error("unexpected RPC"); } } as any, { executor: EXECUTOR } as any,
      { strictSession: session, deferPhase2Sim: true, gssMaxTries: 2, deadlineAtMs: Date.now() + 10000 });
    assert.equal(exactCalls, 0); assert.equal(quotedBuilds, 0); assert(sims >= 4);
    assert(events.filter(e => e.type === "sim_amount_construction").every(e => e.mode === "runtime-actual"));
  }
});

test("runtime allowance checks reject ineffective false returns while supporting optional-return tokens", () => {
  const leg = runtime(), amount = 17n;
  interpretApprovals(leg.program, amount, { noReturn: true });
  assert.throws(() => interpretApprovals(leg.program, amount, { ignoreGrant: true }), /mismatch/);
  assert.throws(() => interpretApprovals(leg.program, amount, { ignoreClear: true, spend: amount - 1n }), /mismatch/);
});

test("mutable registration requests identity recheck and changed binding requires regenerated routes", () => {
  assert.equal(plugin.identity.memoReuse, "recheck-identity");
  const poolId = idFor(POOL, 1), old = setup(fixture(TOKENS, [18, 18], poolId));
  const changed = fixture([...TOKENS, EXTRA], [18, 18, 6], poolId);
  assert.throws(() => currentPricing({ ...old, f: changed }).run(), /binding changed/);
  const fresh = setup(changed);
  assert.equal(fresh.routes.length, 6); assert.equal(old.routes.length, 2);
  assert.notEqual(fresh.routes[0].bindingRef.fingerprint, old.routes[0].bindingRef.fingerprint);
  assert(currentPricing(fresh).run().snapshot.amountOut > 0n);
  assert.throws(() => runtime(fresh, old.routes[0]), /descriptor/);
});
