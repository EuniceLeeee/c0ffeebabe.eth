import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { instanceKey, routeKey } from "../../../adapter-family-identifiers.js";
import { hashCanonical } from "../../../canonical-value.js";
import type { AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import { defineSwapFamily } from "../../../adapter-family-plugin.js";
import { plugin as univ2StrictFamilyPlugin } from "../../../production-families/univ2-standard.production.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import type { ResolvedPlanNode } from "../../../../../types.js";
import { mooniswapAction } from "../action.js";
import { MOONISWAP_ACTION, MOONISWAP_ID, MOONISWAP_LINEAGE, MAX_UINT, POOL, TOKEN, binding, routeIdentity } from "../codec.js";
import { mooniswapExact, mooniswapQuoteProgram as program } from "../exact.js";
import type { MooniswapDescriptor, MooniswapRoute } from "../types.js";
import { mooniswapExecution } from "../execution.js";

// All replies below are synthetic local contracts, not identity/chain evidence.
const source: CanonicalSource = { number: 100, hash: `0x${"11".repeat(32)}`, generation: 1 };
const pool = `0x${"44".repeat(20)}`, token0 = `0x${"22".repeat(20)}`, token1 = `0x${"33".repeat(20)}`;
const governance = `0x${"55".repeat(20)}`, executor = `0x${"66".repeat(20)}`;
const descriptor: MooniswapDescriptor = { familyId: MOONISWAP_ID, lineageId: MOONISWAP_LINEAGE,
  instanceKey: instanceKey(pool), provenance: [], runtimeRequirements: [{ kind: "source-state", freshness: "current-head" }],
  pool, token0, token1, codeHash: `0x${"88".repeat(32)}` };
function input(amountIn = 123456789123456789n, reverse = false) {
  const tokenIn = reverse ? token1 : token0, tokenOut = reverse ? token0 : token1;
  const key = routeIdentity(descriptor, tokenIn, tokenOut);
  const route: MooniswapRoute = { familyId: MOONISWAP_ID, lineageId: MOONISWAP_LINEAGE, instanceKey: descriptor.instanceKey,
    tokenIn, tokenOut, pool, routeKey: routeKey(key), bindingRef: { bindingKey: key, fingerprint: hashCanonical(binding(descriptor)) },
    taxonomy: { slotKind: "swap" }, runtimeRequirements: descriptor.runtimeRequirements };
  return { descriptor, route, amountIn, source, executor, runtimeEvidence: [] };
}
const word = (v: string | bigint) => ethers.toBeHex(BigInt(v), 32);
function results(i = input(), amountOut = 987654321n): AdapterRequestResult[] {
  const data: Record<string, string> = { quote: word(amountOut), "output-balance": word(amountOut + 1n),
    governance: word(governance), "input-balance": word(1000000n), token0: word(token0), token1: word(token1) };
  return program.buildRequests(i).map(r => ({ id: r.id, ok: true, source: i.source, completion: "returned", data: data[r.id],
    provenance: { kind: "synthetic-unit-test", fingerprint: "not-chain-evidence" } }));
}
function activeResult(i = input(), data = word(1n)): AdapterRequestResult {
  return { id: "active", ok: true, source: i.source, completion: "returned", data,
    provenance: { kind: "synthetic-unit-test", fingerprint: "not-chain-evidence" } };
}
function decode(i = input(), reads = results(i), active = activeResult(i)) {
  return program.decode({ programInput: i, initialResults: reads, dependentEvidence: i.amountIn === 0n ? [] : [{ results: [active] }] });
}
function replace(reads: AdapterRequestResult[], id: string, data: string) {
  return reads.map(r => r.id === id && r.ok ? { ...r, data } : r);
}

test("generated production catalog owns Mooniswap with mandatory each-block policy", () => {
  const family = catalog.forFamily(MOONISWAP_ID);
  assert.equal(family.plugin.manifest.domain, "swap");
  assert.equal(Reflect.get(family.plugin, "pricing").refreshPolicy, "each-block");
  assert.equal(catalog.listAll().filter(f => f.plugin.actionAdapters.some(a => a.id === MOONISWAP_ACTION)).length, 1);
});
test("existing always-direct policy cannot be declared in strict PricingSemantics", () => {
  // The older CompiledStateInstance policy exists, but this strict definition
  // validator explicitly rejects it. No central slot is added by this test.
  assert.throws(() => defineSwapFamily({ ...univ2StrictFamilyPlugin,
    pricing: { ...univ2StrictFamilyPlugin.pricing, carryPolicy: "always-direct" } as typeof univ2StrictFamilyPlugin.pricing }), /unsupported key carryPolicy|unexpected.*carryPolicy|unknown.*carryPolicy/);
});
test("both directions use exact requested raw amount through getReturn with executor caller", () => {
  for (const reverse of [false, true]) for (const amount of [1n, 123456789123456789n, MAX_UINT]) {
    const i = input(amount, reverse), requests = program.buildRequests(i);
    assert.equal(requests.length, 6);
    assert.deepEqual(program.requirements(i), { transports: ["eth-call"], caller: "executor" });
    for (const r of requests) { assert.equal(r.kind, "eth-call"); if (r.kind === "eth-call") assert.deepEqual(r.caller, { kind: "executor" }); }
    const request = requests[0]; assert.equal(request.kind, "eth-call");
    if (request.kind !== "eth-call") throw new Error("wrong request");
    assert.equal(request.to, pool);
    assert.deepEqual([...POOL.decodeFunctionData("getReturn", request.data)].map(String), [i.route.tokenIn, i.route.tokenOut, String(amount)]);
    const round = program.buildDependentProgram!({ programInput: i, initialResults: results(i), completedRound: 0, priorEvidence: [] });
    assert(round); assert.equal(round.requests[0].kind, "eth-call");
    if (round.requests[0].kind === "eth-call") assert.equal(round.requests[0].to, governance);
    const q = decode(i);
    assert.equal(q.amountOut, 987654321n); assert.equal(q.evidence.amountIn, amount); assert.deepEqual(q.evidence.source, source);
  }
});
test("time-sensitive exact has no cross-block state-only/carry declaration", () => {
  const method = mooniswapExact.methods()[1];
  assert.equal(method.kind, "request-program"); assert.equal("chainAmountQuote" in method && method.chainAmountQuote, true);
  assert(!("stateOnlyReads" in method)); assert(!("reusePolicy" in method));
  const i = input(), next = { ...i, source: { ...source, number: 101, hash: `0x${"aa".repeat(32)}`, generation: 2 } };
  assert.equal(decode(i).amountOut, 987654321n);
  assert.equal(decode(next, results(next, 987654333n)).amountOut, 987654333n);
  assert.throws(() => decode(next, results(i)), /foreign source/);
});
test("zero issues no calls; negative/overflow/native/same-pool callers reject", () => {
  const z = input(0n); assert.deepEqual(program.buildRequests(z), []); assert.equal(decode(z, []).amountOut, 0n);
  for (const amount of [-1n, MAX_UINT + 1n]) assert.throws(() => program.buildRequests(input(amount)), /uint256/);
  assert.throws(() => program.buildRequests({ ...input(), executor: pool }), /executor equals pool/);
  assert.throws(() => program.buildRequests({ ...input(), executor: ethers.ZeroAddress }), /zero/);
  const i = input(); assert.throws(() => program.buildRequests({ ...i, descriptor: { ...descriptor, token0: ethers.ZeroAddress } }), /zero/);
  assert.throws(() => decode(z, results(i)), /unexpected/);
});
test("route/descriptor/direction fingerprints are checked before any request", () => {
  const i = input();
  for (const route of [{ ...i.route, tokenOut: token0 }, { ...i.route, pool: governance },
    { ...i.route, bindingRef: { ...i.route.bindingRef, fingerprint: "0".repeat(64) } }]) {
    assert.throws(() => program.buildRequests({ ...i, route }), /binding/);
  }
  assert.throws(() => program.buildRequests({ ...i, descriptor: { ...descriptor, token0: token1, token1: token0 } }), /binding/);
});
test("shutdown, changed binding, malformed bool and capacity fail closed", () => {
  const i = input(), reads = results(i);
  for (const [id, value] of [["input-balance", word(0n)], ["governance", word(0n)],
    ["token0", word(token1)], ["token1", word(token0)], ["quote", word(0n)], ["output-balance", word(1n)],
    ["governance", word(1n << 160n)]]) assert.throws(() => decode(i, replace(reads, id, value)));
  for (const value of [0n, 2n]) assert.throws(() => decode(i, reads, activeResult(i, word(value))), /governance/);
  assert.equal(decode(i, replace(reads, "output-balance", word(987654321n))).amountOut, 987654321n);
});
test("missing/extra/duplicate/failed/reverted/foreign and malformed result rejects", () => {
  const i = input(), reads = results(i);
  assert.throws(() => decode(i, reads.slice(1)), /unexpected/);
  assert.throws(() => decode(i, [...reads, reads[0]]), /unexpected/);
  assert.throws(() => decode(i, [reads[0], ...reads.slice(0, 5)]), /duplicate|missing/);
  for (const key of ["quote", "output-balance", "governance", "input-balance", "token0", "token1"]) {
    assert.throws(() => decode(i, reads.map(r => r.id === key ? { id: key, ok: false, source, failure: "rpc" } : r)), /unresolved/);
    assert.throws(() => decode(i, reads.map(r => r.id === key && r.ok ? { ...r, completion: "reverted-as-declared" } : r)), /reverted/);
    assert.throws(() => decode(i, reads.map(r => r.id === key ? { ...r, source: { ...source, generation: 2 } } : r)), /foreign/);
    assert.throws(() => decode(i, replace(reads, key, word(1n) + "00")), /noncanonical/);
  }
});
test("mutable governance is resolved at the same source and can recover without changing Ready", () => {
  const i = input(), reads = replace(results(i), "governance", word(executor));
  const round = program.buildDependentProgram!({ programInput: i, initialResults: reads, completedRound: 0, priorEvidence: [] });
  assert(round); assert.equal(round.requests[0].kind, "eth-call");
  if (round.requests[0].kind === "eth-call") assert.equal(round.requests[0].to, executor);
  assert.equal(decode(i, reads).evidence.governance, executor);
  assert.throws(() => decode(i, reads, activeResult(i, word(0n))), /inactive/);
  assert.equal(decode(i, reads).amountOut, 987654321n);
  assert.throws(() => decode(i, reads, { ...activeResult(i), source: { ...source, generation: 2 } }), /foreign/);
  assert.throws(() => program.decode({ programInput: i, initialResults: reads, dependentEvidence: [] }), /governance round/);
});
test("execution binds exact input, output, receiver, route and minimum", () => {
  const i = input(), q = decode(i);
  const execution = { ...i, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: q.evidence };
  const f = mooniswapExecution.buildFragment(execution);
  assert.deepEqual(f.requirements, [{ kind: "approve", token: i.route.tokenIn, spender: pool, amount: i.amountIn }]);
  assert.equal(f.nodes.length, 1); assert.equal(f.nodes[0].amount, i.amountIn);
  assert.equal(f.nodes[0].params.minAmountOut, q.amountOut);
  for (const bad of [{ ...execution, executor: governance }, { ...execution, amountIn: i.amountIn + 1n },
    { ...execution, minAmountOut: q.amountOut + 1n }, { ...execution, quotedAmountOut: q.amountOut + 1n },
    { ...execution, exactEvidence: { ...q.evidence, routeKey: routeKey("foreign") } }]) {
    assert.throws(() => mooniswapExecution.buildFragment(bad));
  }
});
function node(): ResolvedPlanNode {
  return { adapterId: MOONISWAP_ACTION, target: pool, tokenIn: token0, tokenOut: token1,
    amount: 123456789123456789n, params: { minAmountOut: 789n }, children: [] };
}
function calls(bytes: Uint8Array) {
  const decoded: { to: string; data: string }[] = [];
  for (let offset = 0; offset < bytes.length;) {
    assert.equal(bytes[offset], 0, "only ordinary CALL, no value transfer");
    const size = (bytes[offset + 21] << 16) | (bytes[offset + 22] << 8) | bytes[offset + 23];
    assert(offset + 24 + size <= bytes.length);
    decoded.push({ to: ethers.hexlify(bytes.slice(offset + 1, offset + 21)), data: ethers.hexlify(bytes.slice(offset + 24, offset + 24 + size)) });
    offset += 24 + size;
  }
  return decoded;
}
test("swapFor action delegates approval to requirements and preserves receiver/amount/minimum", () => {
  for (const reverse of [false, true]) {
    const n = reverse ? { ...node(), tokenIn: token1, tokenOut: token0 } : node();
    const encoded = calls(mooniswapAction.encode(n, executor, new Uint8Array()));
    assert.deepEqual(encoded.map(c => c.to), [pool], "no hidden approvals or cleanup in the Family action");
    const swap = encoded[0]; assert.equal(swap.data.slice(0, 10), "0xe331d039");
    assert.deepEqual([...POOL.decodeFunctionData("swapFor", swap.data)],
      [n.tokenIn, n.tokenOut, n.amount, n.params.minAmountOut, ethers.ZeroAddress, executor]);
    assert(mooniswapAction.matchTrace(pool, swap.data.slice(0, 10)));
    assert(!mooniswapAction.matchTrace(pool, "0x00000000"));
  }
});
test("invalid encoder amounts, native assets, self swaps and nested actions reject", () => {
  for (const n of [{ ...node(), amount: 0n }, { ...node(), amount: MAX_UINT + 1n },
    { ...node(), params: { minAmountOut: -1n } }, { ...node(), params: { minAmountOut: MAX_UINT + 1n } },
    { ...node(), tokenIn: ethers.ZeroAddress }, { ...node(), tokenOut: token0 }, { ...node(), target: executor },
    { ...node(), adapterId: "foreign" }, { ...node(), children: [node()] }]) {
    assert.throws(() => mooniswapAction.encode(n, executor, new Uint8Array()));
  }
  assert.throws(() => mooniswapAction.encode(node(), executor, new Uint8Array([1])));
});
