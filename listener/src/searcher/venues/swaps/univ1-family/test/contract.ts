import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/uniswap-v1.production.js";
import { definedFamilyPluginContractSummary } from "../../../adapter-family-plugin.js";
import { cloneImplementation, IMPLEMENTATION, MAX_UINT, MAX_VALUE, POOL, poolAddress, WETH } from "../codec.js";
import { quoteAmount } from "../state.js";
import { answer, CANDIDATE, CLONE, descriptor, EXECUTOR, ISSUER, POOL_ADDRESS, quote, result, SOURCE, TOKEN_ADDRESS, word } from "./fixtures.js";

test("production contract; arbitrary exchange registration, two directed swap routes", () => {
  assert(definedFamilyPluginContractSummary(plugin));
  const d = descriptor(), rs = plugin.routes.project({ descriptor: d });
  assert.equal(rs.length, 2);
  assert.deepEqual(rs.map(r => [r.tokenIn, r.tokenOut]), [[WETH, TOKEN_ADDRESS], [TOKEN_ADDRESS, WETH]]);
  for (const r of rs) assert.equal(plugin.routes.projectGraph({ descriptor: d, route: r }).executionTarget, POOL_ADDRESS);
  assert.equal(cloneImplementation(CLONE), IMPLEMENTATION);
  assert.equal(cloneImplementation("0x366000600037611000600036600073575ba30c7b77fa0eebd34cc5416538323c4e56125af41558576110006000f3"), IMPLEMENTATION);
  assert.equal(cloneImplementation(CLONE.replace("5af4155857", "5af4602c57600080fd5b")), null,
    "an unobserved failure stub cannot borrow the historical clone's identity");
  for (const code of ["0x", `${CLONE}00`, CLONE.replace("5af4", "5af1"), CLONE.replace("611000", "610100")]) assert.equal(cloneImplementation(code), null);
  const other = "0x2000000000000000000000000000000000000001";
  assert.equal(descriptor(r => r.id === "exchange" ? result(r.id, word(other)) : answer(r), { ...CANDIDATE, pool: other }).pool, other);
});
test("exact-out observation nominates only; wrong selector, malformed events and tails rejected", () => {
  const observation = { kind: "call" as const, source: SOURCE, target: POOL_ADDRESS, data: POOL.encodeFunctionData("ethToTokenSwapOutput", [1000n, MAX_UINT]) };
  assert.deepEqual(plugin.discovery.decodeCandidate({ observation, matchedPatternId: "univ1-ethToTokenSwapOutput" }), CANDIDATE);
  assert.equal(plugin.discovery.decodeCandidate({ observation, matchedPatternId: "univ1-ethToTokenSwapInput" }), null);
  assert.equal(plugin.discovery.decodeCandidate({ observation: { ...observation, data: `${observation.data}00` }, matchedPatternId: "univ1-ethToTokenSwapOutput" }), null);
  assert.equal(plugin.actionAdapters[0].matchTrace(POOL_ADDRESS, POOL.getFunction("ethToTokenSwapOutput")!.selector), false);
  const event = POOL.encodeEventLog(POOL.getEvent("TokenPurchase")!, [EXECUTOR, 100n, 200n]);
  const log = { kind: "log" as const, source: SOURCE, address: POOL_ADDRESS, ...event };
  assert.deepEqual(plugin.discovery.decodeCandidate({ observation: log, matchedPatternId: "univ1-TokenPurchase" }), CANDIDATE);
  for (const bad of [{ ...log, data: "0x00" }, { ...log, topics: log.topics.slice(0, 3) }])
    assert.equal(plugin.discovery.decodeCandidate({ observation: bad, matchedPatternId: "univ1-TokenPurchase" }), null);
});
test("identity rejects false reverse binding, unsupported implementation, missing code and bad decimals", () => {
  assert.equal(poolAddress(word(TOKEN_ADDRESS) + "ff".repeat(4096 - 32)), TOKEN_ADDRESS);
  assert.throws(() => poolAddress(word(TOKEN_ADDRESS) + "00"));
  assert.throws(() => poolAddress(word(1n << 160n) + "00".repeat(4096 - 32)));
  for (const [id, data] of [["exchange", word(EXECUTOR)], ["reverse-token", word(EXECUTOR)], ["code", "0x6000"],
    ["implementation-code", "0x"], ["factory-code", "0x"], ["token-code", "0x"], ["decimals", word(37n)],
    ["issuer", word(0n)], ["token", word(WETH)]] as const) {
    assert.throws(() => descriptor(r => r.id === id ? result(id, data) : answer(r)), /chain-proven-rejected/);
  }
  const v = plugin.identity.variants[0], step = { candidate: CANDIDATE, step: 0 };
  const results = v.buildRequests(step).map(answer);
  for (const rs of [results.slice(1), [...results, results[0]], results.map((r, i) => i ? r : { ...r, source: { ...SOURCE, hash: ethers.ZeroHash } })])
    assert.throws(() => v.decode({ step, results: rs }));
  assert.throws(() => descriptor(r => r.id === "factory" ? { id: r.id, source: SOURCE, ok: false, failure: "deadline" } : answer(r)), /unresolved/);
});
test("fee rounding and native reserve adjustment match reviewed execution, not public view", () => {
  const s = { source: SOURCE, nativeReserve: 100_000n, tokenReserve: 20_000_000n };
  assert.equal(quoteAmount(s, true, 1n), 0n);
  for (const amount of [2n, 999n, 1000n, 1001n, 10_000n]) {
    const fee = (amount + 999n) / 1000n, sold = amount - fee;
    const buy = sold * 997n * s.tokenReserve / ((s.nativeReserve + fee) * 1000n + sold * 997n);
    assert.equal(quoteAmount(s, true, amount), buy);
    const publicView = amount * 997n * s.tokenReserve / (s.nativeReserve * 1000n + amount * 997n);
    assert(buy < publicView);
    assert.equal(quoteAmount(s, false, amount), sold * 997n * s.nativeReserve / (s.tokenReserve * 1000n + sold * 997n));
  }
  assert.throws(() => quoteAmount(s, true, MAX_VALUE + 1n), /uint96/);
  assert.throws(() => quoteAmount(s, false, MAX_UINT), /overflow/);
  assert.throws(() => quoteAmount({ ...s, nativeReserve: 0n }, false, 100n), /empty/);
  assert.throws(() => quoteAmount(s, false, -1n));
  assert.equal(quoteAmount(s, false, 0n), 0n);
});
test("Exact preserves input and nonlinear slippage, issuer/caller/source/route fences", () => {
  for (const buy of [true, false]) {
    const a = quote(10n ** 16n, buy), b = quote(10n ** 19n, buy);
    assert.equal(a.quoted.evidence.amountIn, 10n ** 16n);
    assert(b.quoted.amountOut < a.quoted.amountOut * 1000n);
    assert.notEqual(a.method.chainAmountQuote, true);
    for (const executor of [ISSUER, POOL_ADDRESS, TOKEN_ADDRESS]) assert.throws(() => a.method.program.buildRequests({ ...a.input, executor }));
    const rs = a.method.program.buildRequests(a.input).map(answer);
    assert.throws(() => a.method.program.decode({ programInput: a.input, initialResults: rs.map(r => ({ ...r, source: { ...SOURCE, generation: 2 } })), dependentEvidence: [] }));
    assert.throws(() => a.method.program.buildRequests({ ...a.input, route: { ...a.input.route, buy: !buy } }));
    assert.equal(quote(0n, buy).quoted.amountOut, 0n);
  }
});
test("execution owns wrapping, binds exact evidence and honors the supplied minimum", () => {
  for (const buy of [true, false]) {
    const { input, quoted } = quote(10n ** 16n, buy);
    const invocation = { ...input, quotedAmountOut: quoted.amountOut, minAmountOut: quoted.amountOut, exactEvidence: quoted.evidence };
    const fragment = plugin.execution.buildFragment(invocation);
    assert.equal(fragment.requirements.length, buy ? 0 : 1);
    assert.equal(fragment.nodes.length, 1);
    const node = fragment.nodes[0];
    const bytes = plugin.actionAdapters[0].encode(node, EXECUTOR, new Uint8Array());
    assert(bytes.length > 100);
    assert.equal(node.params.amountOut, quoted.amountOut);
    const tolerant = plugin.execution.buildFragment({ ...invocation, minAmountOut: quoted.amountOut - 1n });
    assert.equal(tolerant.nodes[0]!.params.amountOut, quoted.amountOut - 1n);
    assert.equal(quoted.evidence.amountOut, quoted.amountOut, "execution allowance must not rewrite quote evidence");
    assert.throws(() => plugin.actionAdapters[0].encode(node, ISSUER, new Uint8Array()), /invalid action/);
    assert.throws(() => plugin.actionAdapters[0].encode(node, EXECUTOR, new Uint8Array([0])));
    for (const change of [{ amountIn: input.amountIn + 1n }, { quotedAmountOut: quoted.amountOut + 1n }, { executor: ISSUER },
      { minAmountOut: 0n }, { minAmountOut: quoted.amountOut + 1n },
      { exactEvidence: { ...quoted.evidence, binding: "forged" } }]) assert.throws(() => plugin.execution.buildFragment({ ...invocation, ...change }));
  }
});
test("shared current state yields both raw directions; donation dependency is wired into compiled index", () => {
  const d = descriptor(), rs = plugin.routes.project({ descriptor: d });
  const pd = plugin.pricing.finalizePricingDescriptor({ draft: plugin.pricing.compileDraft({ descriptor: d, routes: rs, stateKey: d.pool }), sharedBindings: [] });
  const requests = plugin.pricing.current.buildRequests({ descriptor: pd, routes: rs, source: SOURCE });
  const snapshot = plugin.pricing.current.decodeSnapshot({ descriptor: pd, initialResults: requests.map(answer), dependentEvidence: [] });
  const mids = plugin.pricing.current.deriveMids({ descriptor: pd, routes: rs, snapshot });
  assert.equal(mids.size, 2);
  const dependencies = plugin.pricing.dependencies({ descriptor: pd, routes: rs });
  const index = plugin.pricing.mutation!.compile!({ entries: [{ descriptor: pd, routes: rs, stateKey: d.pool, dependencies }] });
  const donation = { kind: "log" as const, source: SOURCE, address: TOKEN_ADDRESS, topics: [], data: "0x" };
  assert.deepEqual(index.affectedStateKeys({ observation: donation }), [d.pool]);
  assert.deepEqual(index.affectedStateKeys({ observation: { ...donation, address: ISSUER } }), []);
  const next = { ...snapshot, tokenReserve: snapshot.tokenReserve * 2n };
  assert.notDeepEqual(plugin.pricing.current.deriveMids({ descriptor: pd, routes: rs, snapshot: next }), mids);
});
