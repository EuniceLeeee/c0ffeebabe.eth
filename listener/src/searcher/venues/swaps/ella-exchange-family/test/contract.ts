import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import sample from "./public-sample.json";
import { plugin } from "../../../production-families/ella-exchange.production.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import { BOUGHT_ID, decodeBought } from "../discovery.js";
import { EXCHANGE_CODE_HASH, FACTORY_CODE_HASH, MAX_UINT, POOL, UNIT, same } from "../codec.js";
import { decodeState, quoteAmount, stateRequests } from "../state.js";
import { staticBinding } from "../instance.js";
import type { EllaCandidate } from "../types.js";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { DEFAULT_EFFECTIVE_WETH_INPUT } from "../../../../blockscan-effective-mid.js";
import { RuntimeAmountProgram } from "../../../../../adapters/runtime-amount-program.js";
import { encodeCall, encodeCallValue } from "../../../../../encoder.js";
import { applyQuotedAssetBoundary, applyRuntimeAssetBoundary } from "../../../../execution-asset-boundary.js";

const pool = "0x33c577296b0cdece6186ea48cd8fe98bd1a6e3a4";
const executor = "0x1000000000000000000000000000000000000002";
const candidate: EllaCandidate = { candidateKind: "ella-exchange", pool };
const word = (v: bigint | string) => ethers.toBeHex(BigInt(v), 32);
const source: CanonicalSource = { number: sample.states[0].block, hash: sample.states[0].blockHash, generation: 1 };
const result = (id: string, data: string): AdapterRequestResult => ({ id, ok: true, completion: "returned", data, source,
  provenance: { kind: "fixture-public-state", fingerprint: "ella-public-sample" } });
// Frozen public answers are offline regression data, not fresh strict evidence.
function answer(r: AdapterRequest): AdapterRequestResult {
  const s = sample.states[0];
  const values: Record<string, string> = {
    code: sample.poolCode, "factory-code": sample.factoryCode, "token-code": "0x6000", "oracle-code": "0x6000", "aggregator-code": "0x6000",
    token: s.slots[1], "factory-native": s.slots[2], secretary: s.slots[10], oracle: s.slots[15], decimals: word(18n),
    aggregator: word("0x3547473da7deb396acf07d57340a8ef931d7414e"),
    price: word(s.calls.tokenPrice), fee: word(s.calls.getFees), cut: word(s.calls.getSystemCut), "fees-address": word(s.calls.getFeesAddress),
    "token-balance": word(s.calls.balanceOf), "native-balance": word(s.nativeBalance), "base-fees-generated": word(0n), "fees-generated": word(0n),
    "current-oracle": s.slots[15], "current-aggregator": word("0x3547473da7deb396acf07d57340a8ef931d7414e"),
  };
  assert(r.id in values, r.id); return result(r.id, values[r.id]);
}
function identify(read = answer, c = candidate) {
  let evidence: unknown;
  const v = plugin.identity.variants[0];
  for (let step = 0; step <= 3; step++) {
    const input = { candidate: c, step, evidence };
    const decision = v.decide(input);
    if (decision.status !== "continue") return decision;
    const requests = v.buildRequests(input);
    assert.deepEqual([...v.requirements(input).transports].sort(), [...new Set(requests.map(r => r.kind))].sort(),
      "strict phase must declare exactly the transports it actually uses");
    evidence = v.decode({ step: input, results: requests.map(read) });
  }
  throw new Error("identity loop exceeded");
}
function setup() {
  const decision = identify(); assert.equal(decision.status, "verified");
  if (decision.status !== "verified") throw new Error("not verified");
  const identity = decision.identity;
  const descriptor = plugin.instance.finalizeDescriptor({ identity, draft: plugin.instance.compileDraft(identity), sharedBindings: [] });
  const routes = plugin.routes.project({ descriptor });
  return { descriptor, routes, state: decodeState(descriptor, stateRequests(descriptor).map(answer)) };
}
function exact(amountIn: bigint, direction = 0) {
  const s = setup();
  const input = { descriptor: s.descriptor, route: s.routes[direction], amountIn, source, executor, runtimeEvidence: [] };
  const method = plugin.exact.methods(input)[1]; assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") throw new Error("missing exact program");
  return { ...s, input, method, q: method.program.decode({ programInput: input, initialResults: method.program.buildRequests(input).map(answer), dependentEvidence: [] }) };
}
test("compiled implementation and reverse factory storage, no pool whitelist", () => {
  assert.equal(ethers.keccak256(sample.poolCode), EXCHANGE_CODE_HASH);
  assert.equal(ethers.keccak256(sample.factoryCode), FACTORY_CODE_HASH);
  assert.equal(sample.compiler, "0.6.0+commit.26b70077.Emscripten.clang");
  const d = identify(answer, { ...candidate, pool: executor }); assert.equal(d.status, "verified");
  const s = setup(); assert.equal(s.routes.length, 2);
  assert(same(s.routes[0].tokenIn, ADDR.WETH) && same(s.routes[1].tokenOut, ADDR.WETH));
  assert.equal(plugin.manifest.domain, "swap");
  assert(s.routes.every(route => plugin.routes.projectGraph({ descriptor: s.descriptor, route }).executionTarget === s.descriptor.pool));
});
test("wrong runtime/factory/native flag/scale rejected, uncertain reads never admitted", () => {
  for (const [id, data] of [["code", "0x6000"], ["factory-code", "0x6000"], ["factory-native", sample.states[0].slots[10]],
    ["secretary", word(executor)], ["decimals", word(6n)]]) {
    assert.equal(identify(r => r.id === id ? result(id, data) : answer(r)).status, "chain-proven-rejected");
  }
  assert.throws(() => identify(r => r.id === "factory-code" ? { id: r.id, ok: false, failure: "rpc", source } : answer(r)), /unresolved/);
  assert.throws(() => identify(r => r.id === "token" ? { ...answer(r), source: { ...source, generation: 9 } } : answer(r)), /mixed source/);
});
test("Bought is gross output only; emitter, canonical payload and selector are checked", () => {
  const q = quoteAmount(setup().state, "buy-token", BigInt(sample.amountIn));
  const event = POOL.encodeEventLog(POOL.getEvent("Bought")!, [setup().state.price, q.grossOut, sample.amountIn, pool, true, 1n]);
  const observation = { kind: "log" as const, source, address: pool, ...event };
  assert.equal(decodeBought(observation)!.grossOut, q.grossOut);
  assert.notEqual(q.grossOut, BigInt(sample.netAmountOut));
  assert(plugin.discovery.decodeCandidate({ observation, matchedPatternId: BOUGHT_ID }));
  assert.equal(decodeBought({ ...observation, address: executor }), null);
  assert.equal(decodeBought({ ...observation, data: observation.data + "00" }), null);
  assert(plugin.discovery.decodeCandidate({ observation: { kind: "call", source, target: pool, data: POOL.encodeFunctionData("swapBase1") }, matchedPatternId: "ella-swapBase1" }));
  assert.equal(plugin.discovery.decodeCandidate({ observation: { kind: "call", source, target: pool, data: POOL.encodeFunctionData("swapBase1") + "00" }, matchedPatternId: "ella-swapBase1" }), null);
});
test("shared Exact arithmetic agrees with actual original receipt output, not gross event", () => {
  const x = exact(BigInt(sample.amountIn));
  assert.equal(x.q.amountOut, BigInt(sample.netAmountOut));
  assert.equal(x.q.evidence.amountIn, BigInt(sample.amountIn));
  assert(!("chainAmountQuote" in x.method));
  const q2 = quoteAmount(x.state, "buy-token", BigInt(sample.amountIn) / 2n);
  assert(q2.amountOut > 0n && q2.amountOut < x.q.amountOut);
});
test("unproven transfer and oracle dependencies do not advertise sequential trial capability", () => {
  const x = exact(BigInt(sample.amountIn));
  assert.deepEqual(x.method.trialState, { unsupportedReason: "ella-token-oracle-dependency-models-unproven" });
  assert(x.q.amountOut > 0n, "single-leg quote remains available");
});
test("production P is quotable at N-1; depleted N and over-capacity inputs reject inventory", () => {
  const s = setup(), p = DEFAULT_EFFECTIVE_WETH_INPUT;
  const reference = exact(p).q;
  assert(reference.amountOut > 0n);
  assert.equal(reference.evidence.amountIn, p);
  assert.equal(reference.evidence.unavailableReason, undefined);
  const overCapacity = (s.state.tokenBalance + 1n) * s.state.price / UNIT + 1n;
  assert.equal(exact(overCapacity).q.evidence.unavailableReason, "gross-output-exceeds-inventory");
  const after = { ...s.state, tokenBalance: BigInt(sample.states[1].calls.balanceOf), nativeBalance: BigInt(sample.states[1].nativeBalance) };
  assert.equal(quoteAmount(after, "buy-token", p).amountOut, 0n);
  assert.equal(quoteAmount(after, "buy-token", BigInt(sample.amountIn)).amountOut, 0n);
  const within = after.tokenBalance * after.price / UNIT / 100n;
  assert(quoteAmount(after, "buy-token", within).amountOut > 0n);
  const q = quoteAmount(s.state, "buy-token", BigInt(sample.amountIn));
  assert.equal(quoteAmount({ ...s.state, tokenBalance: q.grossOut }, "buy-token", BigInt(sample.amountIn)).amountOut, q.amountOut);
  assert.equal(quoteAmount({ ...s.state, tokenBalance: q.grossOut - 1n }, "buy-token", BigInt(sample.amountIn)).amountOut, 0n);
});
test("checked intermediate arithmetic, fee rounding and fee-counter capacity", () => {
  const s = setup().state;
  assert.throws(() => quoteAmount(s, "buy-token", MAX_UINT), /overflow/);
  assert.throws(() => quoteAmount(s, "sell-token", MAX_UINT), /overflow/);
  assert.throws(() => quoteAmount(s, "buy-token", -1n), /amountIn/);
  assert.throws(() => quoteAmount({ ...s, fee: UNIT }, "buy-token", 1n), /state/);
  const q = quoteAmount({ ...s, price: UNIT, tokenBalance: MAX_UINT, fee: UNIT / 3n }, "buy-token", 10n);
  assert.equal(q.amountOut, 7n); assert.equal(q.fee, 3n); assert.equal(q.systemFee, 0n);
  assert.equal(quoteAmount({ ...s, feesGenerated: MAX_UINT }, "buy-token", BigInt(sample.amountIn)).unavailableReason, "fee-counter-overflow");
  assert.equal(quoteAmount(s, "buy-token", 0n).amountOut, 0n);
});
test("source, oracle/aggregator and duplicate state results fail closed", () => {
  const s = setup(), results = stateRequests(s.descriptor).map(answer);
  for (const id of ["current-oracle", "current-aggregator"]) assert.throws(() => decodeState(s.descriptor,
    results.map(r => r.id === id ? result(id, word(executor)) : r)), /revalidation/);
  assert.throws(() => decodeState(s.descriptor, [...results, results[0]]), /unexpected/);
  assert.throws(() => decodeState(s.descriptor, results.map((r, i) => i ? r : { ...r, source: { ...source, number: source.number - 1 } })), /mixed source/);
  assert.throws(() => plugin.routes.projectGraph({ descriptor: s.descriptor, route: { ...s.routes[0], tokenOut: ADDR.WETH } }), /route/);
});
test("raw derives locally; exact uses the requested amount; raw native value encoding", () => {
  const x = exact(BigInt(sample.amountIn)), d = x.descriptor, r = x.routes[0];
  const mids = plugin.pricing.current.deriveMids({ descriptor: { instance: d }, routes: x.routes, snapshot: x.state });
  assert.equal(mids.size, 2); assert.equal(mids.get(r.routeKey)!.kind, "external-swap");
  assert.equal(JSON.stringify(staticBinding(d)), JSON.stringify(plugin.instance.staticBindingProjection(d)));
  const fragment = plugin.execution.buildFragment({ ...x.input, quotedAmountOut: x.q.amountOut, minAmountOut: x.q.amountOut, exactEvidence: x.q.evidence });
  assert.equal(fragment.requirements.length, 0);
  assert.deepEqual(fragment.nodes.map(n => n.adapterId), ["ella-buy-token"]);
  const bytes = plugin.actionAdapters[0].encode(fragment.nodes[0], executor, new Uint8Array());
  assert(ethers.hexlify(bytes).endsWith(POOL.getFunction("swapBase1")!.selector.slice(2)));
  assert.throws(() => plugin.execution.buildFragment({ ...x.input, quotedAmountOut: x.q.amountOut, minAmountOut: x.q.amountOut,
    exactEvidence: { ...x.q.evidence, executor: pool } }), /incompatible/);
});

test("both native directions emit raw protocol calls; only the common boundary wraps", () => {
  const s = setup();
  for (const direction of [0, 1]) {
    const original = direction === 0 ? BigInt(sample.amountIn) : s.state.nativeBalance * UNIT / s.state.price / 100n;
    for (const amount of [original / 10n, original]) {
      const x = exact(amount, direction), route = x.input.route, buy = direction === 0;
      assert(x.q.amountOut > 0n && !x.q.evidence.unavailableReason);
      assert.deepEqual(route.executionAssets, { input: buy ? "native" : "erc20", output: buy ? "erc20" : "native" });
      const fragment = plugin.execution.buildFragment({ ...x.input, quotedAmountOut: x.q.amountOut,
        minAmountOut: x.q.amountOut, exactEvidence: x.q.evidence });
      assert.equal(fragment.nodes.length, 1);
      const node = fragment.nodes[0];
      assert.equal(node.tokenIn, route.tokenIn); assert.equal(node.tokenOut, route.tokenOut);
      const action = plugin.actionAdapters.find(a => a.id === node.adapterId)!;
      const data = ethers.getBytes(POOL.encodeFunctionData(buy ? "swapBase1" : "swap1", buy ? [] : [amount]));
      assert.deepEqual(action.encode(node, executor, new Uint8Array()), buy
        ? encodeCallValue(x.descriptor.pool, amount, data) : encodeCall(x.descriptor.pool, data));
      const quoted = applyQuotedAssetBoundary({ route, executor, amountIn: amount, minimum: x.q.amountOut, fragment });
      assert.deepEqual(quoted.requirements, []);
      assert.equal(quoted.nodes[0].adapterId, "execution-asset-boundary");
      assert.equal(quoted.nodes[0].params.minAmountOut, x.q.amountOut);
      assert.deepEqual(quoted.nodes[0].children.map(n => n.adapterId), buy
        ? ["ella-buy-token"] : ["erc20-approve", "ella-sell-token"]);
      assert.deepEqual(quoted.nodes[0].children.at(-1), node);

      // The runtime emitter receives no usable quote or fixed-amount input.
      const raw = plugin.execution.buildRuntimeLeg!({ descriptor: x.descriptor, route, executor, runtimeEvidence: [],
        get amountIn() { throw new Error("runtime must use r0"); },
        get exactEvidence() { throw new Error("runtime must not quote"); },
      } as Parameters<NonNullable<typeof plugin.execution.buildRuntimeLeg>>[0]);
      assert(raw);
      const expected = new RuntimeAmountProgram();
      if (buy) expected.call(x.descriptor.pool, POOL.encodeFunctionData("swapBase1"), { valueReg: 0 });
      else expected.allowance(route.tokenIn, x.descriptor.pool, 0, MAX_UINT)
        .call(x.descriptor.pool, POOL.encodeFunctionData("swap1", [0n]), { patches: [{ offset: 4, reg: 0 }] });
      assert.equal(raw.program, ethers.hexlify(expected.bytes()), "no Family WETH or fixed output operation");
      const wrapped = applyRuntimeAssetBoundary({ route, executor, leg: raw });
      assert.notEqual(wrapped.program, raw.program); assert.equal(wrapped.actionAdapterId, raw.actionAdapterId);
    }
  }
});

test("native execution rejects removed/forged declarations, wrong route, minimum and evidence", () => {
  for (const direction of [0, 1]) {
    const s = setup(), amount = direction === 0 ? BigInt(sample.amountIn) : s.state.nativeBalance * UNIT / s.state.price / 100n;
    const x = exact(amount, direction);
    const input = { ...x.input, quotedAmountOut: x.q.amountOut, minAmountOut: x.q.amountOut, exactEvidence: x.q.evidence };
    for (const invalidRoute of [
      { ...x.input.route, executionAssets: undefined },
      { ...x.input.route, executionAssets: { input: "erc20" as const, output: "erc20" as const } },
      { ...x.input.route, executionAssets: { input: "native" as const, output: "native" as const } },
      { ...x.input.route, tokenIn: x.input.route.tokenOut },
    ]) {
      // Deliberately cross the typed projection boundary to test rejection.
      const route = invalidRoute as unknown as typeof x.input.route;
      assert.throws(() => plugin.execution.buildFragment({ ...input, route }), /route/);
      assert.throws(() => plugin.execution.buildRuntimeLeg!({ ...x.input, route }), /route/);
      assert.throws(() => plugin.routes.projectGraph({ descriptor: x.descriptor, route }), /route/);
    }
    for (const minAmountOut of [-1n, x.q.amountOut + 1n])
      assert.throws(() => plugin.execution.buildFragment({ ...input, minAmountOut }), /incompatible/);
    for (const amountIn of [0n, MAX_UINT + 1n])
      assert.throws(() => plugin.execution.buildFragment({ ...input, amountIn }), /incompatible/);
    assert.throws(() => plugin.execution.buildFragment({ ...input, exactEvidence: { ...x.q.evidence, amountOut: x.q.amountOut + 1n } }), /incompatible/);
    assert.throws(() => plugin.execution.buildRuntimeLeg!({ ...x.input, executor: x.descriptor.pool }), /executor/);
  }
});

test("oracle-only updates use the same refreshed state in raw and amount quotes", () => {
  const x = exact(BigInt(sample.amountIn) / 100n);
  const updatedResults = stateRequests(x.descriptor).map(r => r.id === "price"
    ? result(r.id, word(x.state.price * 2n)) : answer(r));
  const updated = plugin.pricing.current.decodeSnapshot({
    descriptor: { instance: x.descriptor }, initialResults: updatedResults, dependentEvidence: [],
  });
  const updatedQuote = x.method.program.decode({ programInput: x.input,
    initialResults: updatedResults, dependentEvidence: [] });
  assert.equal(updatedQuote.amountOut, quoteAmount(updated, "buy-token", x.input.amountIn).amountOut);
  assert(updatedQuote.amountOut < x.q.amountOut);
  const before = plugin.pricing.current.deriveMids({ descriptor: { instance: x.descriptor },
    routes: x.routes, snapshot: x.state });
  const after = plugin.pricing.current.deriveMids({ descriptor: { instance: x.descriptor },
    routes: x.routes, snapshot: updated });
  assert(after.get(x.routes[0].routeKey)!.mid < before.get(x.routes[0].routeKey)!.mid);
  assert(after.get(x.routes[1].routeKey)!.mid > before.get(x.routes[1].routeKey)!.mid);
});

test("mutation maps chain-derived dependencies without requiring a pool trade", () => {
  const { descriptor: d, routes } = setup(), descriptor = { instance: d };
  const declared = plugin.pricing.dependencies({ descriptor, routes });
  assert.deepEqual(declared, [d.pool, d.token, d.factory, d.oracle, d.aggregator]);
  for (const address of declared) {
    for (const observation of [
      { kind: "call" as const, source, target: address, data: "0x12345678" },
      { kind: "log" as const, source, address, topics: [], data: "0x" },
    ]) assert.deepEqual(plugin.pricing.mutation!.affectedStateKeys({ descriptor, routes, observation }), [d.instanceKey]);
  }
  assert.deepEqual(plugin.pricing.mutation!.affectedStateKeys({ descriptor, routes,
    observation: { kind: "call", source, target: executor, data: "0x" } }), []);
});
