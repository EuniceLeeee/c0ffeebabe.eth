import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/ekubo.production.js";
import { definedFamilyPluginContractSummary } from "../../../adapter-family-plugin.js";
import type { AdapterRequestResult } from "../../../adapter-request-program.js";
import { hashCanonical } from "../../../canonical-value.js";
import { familyId } from "../../../adapter-family-identifiers.js";
import { EKUBO_CORE, EKUBO_ROUTER, EKUBO_MAX_EXACT_INPUT, ekuboRouterIface, encodeEkuboQuote } from "../../ekubo/abi.js";
import { candidate, decodeQuote, decodeInitialized, decimals, MAX_UINT, NO_RECEIVER, NO_RECEIVER_SELECTOR, probeAmount, vanillaKey } from "../codec.js";
import { CALL_ID, CALL_NO_RECEIVER_ID, INIT_ID } from "../discovery.js";
import { EKUBO_ACTION_ID } from "../manifest.js";
import { descriptor, EXECUTOR, fixture, ID, identity, initialized, KEY, quoteData, result, SOURCE, swapCall, word } from "./fixtures.js";

test("production definition, real anchor key hash and arbitrary vanilla keys", () => {
  assert(definedFamilyPluginContractSummary(plugin));
  assert.equal(candidate(KEY).poolId, ID);
  const arbitrary = candidate({ token0: "0x1000000000000000000000000000000000000001",
    token1: "0x2000000000000000000000000000000000000002", config: word(3000n) });
  const d = descriptor(identity(arbitrary));
  assert.equal(d.poolId, arbitrary.poolId);
  const routes = plugin.routes.project({ descriptor: d });
  assert.equal(routes.length, 2);
  for (const route of routes) assert.equal(plugin.routes.projectGraph({ descriptor: d, route }).executionTarget, EKUBO_ROUTER);
  assert.equal(plugin.swap.victimSupport, "detect-only");
  assert.deepEqual(plugin.manifest.ownedActionAdapterIds, [EKUBO_ACTION_ID]);
});
test("actual exact-input selector and Initialize decode agree on full identity", () => {
  const call = swapCall();
  assert.equal(call.data.slice(0, 10), "0xf196187f");
  const fromCall = plugin.discovery.decodeCandidate({ observation: call, matchedPatternId: CALL_ID });
  const fromLog = plugin.discovery.decodeCandidate({ observation: initialized(), matchedPatternId: INIT_ID });
  assert.deepEqual(fromCall, fromLog);
  assert.equal(fromCall?.poolId, ID);
  assert.equal(plugin.discovery.candidateKey(candidate(KEY)), ID);
});
test("earlier no-receiver swap is nomination only; emitted execution stays explicit-receiver", () => {
  assert.equal(NO_RECEIVER_SELECTOR, "0x1d8a7962");
  const observation = { ...swapCall(), data: NO_RECEIVER.encodeFunctionData("swap", [KEY, false, 225877n, 0n, 0n, 169144106n]) };
  assert.equal(plugin.discovery.decodeCandidate({ observation, matchedPatternId: CALL_NO_RECEIVER_ID })?.poolId, ID);
  assert.equal(plugin.discovery.decodeCandidate({ observation, matchedPatternId: CALL_ID }), null);
  assert.equal(plugin.actionAdapters[0].matchTrace(EKUBO_ROUTER, NO_RECEIVER_SELECTOR), false);
  assert.equal(plugin.discovery.decodeCandidate({ observation: { ...observation, data: `${observation.data}00` }, matchedPatternId: CALL_NO_RECEIVER_ID }), null);
});
test("foreign targets, patterns, selectors and noncanonical calldata fail closed", () => {
  const call = swapCall();
  for (const observation of [ { ...call, target: EXECUTOR }, { ...call, data: `${call.data}00` },
    { ...call, data: `0xdeadbeef${call.data.slice(10)}` }, { ...call, data: encodeEkuboQuote(KEY, false, 10n) } ]) {
    assert.equal(plugin.discovery.decodeCandidate({ observation, matchedPatternId: CALL_ID }), null);
  }
  assert.equal(plugin.discovery.decodeCandidate({ observation: call, matchedPatternId: INIT_ID }), null);
  for (const args of [ [KEY, false, -1n, 0n, 0n, 0n, EXECUTOR], [KEY, false, 0n, 0n, 0n, 0n, EXECUTOR],
    [KEY, false, 1n, 1n, 0n, 0n, EXECUTOR], [KEY, false, 1n, 0n, 1n, 0n, EXECUTOR] ]) {
    assert.equal(plugin.discovery.decodeCandidate({ observation: { ...call, data: ekuboRouterIface.encodeFunctionData("swap", args) }, matchedPatternId: CALL_ID }), null);
  }
  assert.equal(plugin.discovery.decodeCandidate({ observation: { ...call,
    data: ekuboRouterIface.encodeFunctionData("swapAllowPartialFill", [KEY, false, 1n, 0n, 0n, EXECUTOR]) }, matchedPatternId: CALL_ID }), null);
});
test("Initialize requires real Core, exact topic/data/hash and nonzero initial state", () => {
  const log = initialized();
  for (const mutation of [ { ...log, address: EXECUTOR }, { ...log, topics: [] }, { ...log, topics: [ethers.ZeroHash] },
    { ...log, topics: [...log.topics, ID] }, { ...log, data: `${word(1n)}${log.data.slice(66)}` },
    { ...log, data: `${log.data}00` }, { ...log, data: `${log.data.slice(0, -64)}${"0".repeat(64)}` } ]) assert.equal(decodeInitialized(mutation), null);
});
test("native, unordered/duplicate tokens and every nonzero extension are unsupported", () => {
  for (const key of [ { ...KEY, token0: ethers.ZeroAddress }, { ...KEY, token0: KEY.token1 },
    { ...KEY, token0: KEY.token1, token1: KEY.token0 }, { ...KEY, config: `0x${EXECUTOR.slice(2)}${KEY.config.slice(42)}` },
    { ...KEY, config: `0x5555ff9ff2757500bf4ee020dcfd0210cffa41be${KEY.config.slice(42)}` } ]) {
    assert.throws(() => vanillaKey(key));
    assert.equal(plugin.identity.variants[0].applies({ ...candidate(KEY), poolKey: key }), false);
  }
  const wrong = { ...candidate(KEY), poolId: ethers.ZeroHash };
  assert.equal(plugin.identity.variants[0].decide({ candidate: wrong, step: 0 }).status, "invalid-program");
});
test("identity requests only pinned code, decimals and two full amount quotes in both directions", () => {
  const d = descriptor();
  assert.deepEqual(d.decimals, [8, 6]);
  assert.notEqual(d.coreCodeHash, ethers.ZeroHash);
  const projection = plugin.instance.staticBindingProjection(d);
  assert(!JSON.stringify(projection).includes("25988745"));
  const next = descriptor(identity(candidate(KEY), fixture(KEY, { ...SOURCE, number: SOURCE.number + 1, generation: SOURCE.generation + 1, hash: word(2n) }).answer));
  assert.equal(hashCanonical(projection), hashCanonical(plugin.instance.staticBindingProjection(next)));
  assert.notEqual(d.provenance[0].evidenceHash, next.provenance[0].evidenceHash);
});
test("identity source, missing, duplicate and unavailable responses fail closed", () => {
  const variant = plugin.identity.variants[0], step = { candidate: candidate(KEY), step: 0 };
  const results = variant.buildRequests(step).map(fixture().answer);
  for (const altered of [results.slice(1), [...results, results[0]],
    results.map((r, i) => i === 0 ? { ...r, source: { ...SOURCE, generation: SOURCE.generation + 1 } } : r),
    results.map((r, i): AdapterRequestResult => i === 0 ? { id: r.id, source: SOURCE, ok: false, failure: "deadline" } : r)]) {
    assert.throws(() => variant.decode({ step, results: altered }));
  }
  const evidence = variant.decode({ step, results });
  const next = { ...step, step: 1, evidence };
  const quotes = variant.buildRequests(next).map(fixture().answer);
  assert.throws(() => variant.decode({ step: next, results: quotes.map(r => ({ ...r, source: { ...SOURCE, hash: word(1n) } })) }), /source/);
  const reverted = variant.decode({ step: next, results: quotes.map(r => result(r.id, "0x")).map(r => ({ ...r, completion: "reverted-as-declared" as const })) });
  assert.equal(variant.decide({ ...next, evidence: reverted }).status, "continue");
  const retry = { ...next, step: 2, evidence: reverted };
  const unresolved = variant.decode({ step: retry, results: variant.buildRequests(retry).map(r =>
    ({ ...result(r.id, "0x"), completion: "reverted-as-declared" as const })) });
  assert.equal(variant.decide({ ...retry, evidence: unresolved }).status, "retryable");
  const empty = variant.decode({ step, results: results.map(r => r.id === "core-code" ? result(r.id, "0x") : r) });
  assert.equal(variant.decide({ ...next, evidence: empty }).status, "chain-proven-rejected");
});
test("partial sizing evidence only triggers smaller fresh full-fill identity proofs", () => {
  const base = fixture();
  const verified = identity(candidate(KEY), request => {
    if (request.kind !== "eth-call" || !request.data.startsWith("0x3bc52842")) return base.answer(request);
    const args = ekuboRouterIface.decodeFunctionData("quote", request.data);
    const requested = BigInt(args[2]), isToken1 = Boolean(args[1]);
    const filled = !isToken1 && requested > 71384685n ? 71384685n : requested;
    return result(request.id, quoteData(isToken1, filled, base.dy(isToken1, filled)));
  });
  assert.equal(verified.facts.poolId, ID);
  // The partial return observed at the real parent is not an Exact authority.
  assert.throws(() => decodeQuote("0x00000000000000000000000004413e6dfffffffffffffffffffffff4fe99b9ee00000000400065a8177fae27fab6326c00000000000000000000000000000000", false, 100000000n), /partial/);
});
test("strict scalar, signed packing, precision, dust and int128 boundaries", () => {
  assert.equal(decimals(word(0n)), 0); assert.equal(decimals(word(36n)), 36);
  for (const data of ["0x", word(37n), `${word(18n)}00`]) assert.throws(() => decimals(data));
  assert.equal(probeAmount(0), 1n); assert.equal(probeAmount(8), 10000n);
  for (const d of [-1, 1.5, 37]) assert.throws(() => probeAmount(d));
  for (const isToken1 of [false, true]) {
    assert.equal(decodeQuote(quoteData(isToken1, EKUBO_MAX_EXACT_INPUT, 1n), isToken1, EKUBO_MAX_EXACT_INPUT).amountOut, 1n);
    for (const data of [quoteData(isToken1, 10n, 0n), quoteData(isToken1, 9n, 1n), quoteData(!isToken1, 10n, 1n),
      quoteData(isToken1, 10n, 1n, ethers.ZeroHash), `${quoteData(isToken1, 10n, 1n)}00`]) assert.throws(() => decodeQuote(data, isToken1, 10n));
  }
  assert.throws(() => encodeEkuboQuote(KEY, false, EKUBO_MAX_EXACT_INPUT + 1n));
});

const d = descriptor(), routes = plugin.routes.project({ descriptor: d });
function exactInput(amountIn = 15809n, route = routes[0]) { return { descriptor: d, route, amountIn, source: SOURCE, executor: EXECUTOR, runtimeEvidence: [] }; }
function exact(amountIn = 15809n, route = routes[0]) {
  const input = exactInput(amountIn, route), method = plugin.exact.methods(input)[1];
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") throw new Error("request program missing");
  return { input, method, quote: method.program.decode({ programInput: input, initialResults: method.program.buildRequests(input).map(fixture().answer), dependentEvidence: [] }) };
}
test("fresh nonlinear exact quotes bind full input, direction, source, executor and key", () => {
  const a = exact(), b = exact(15809n * 1000n);
  assert(b.quote.amountOut < a.quote.amountOut * 1000n);
  assert.equal(a.method.chainAmountQuote, true);
  assert.equal(a.quote.evidence.executor, EXECUTOR);
  assert.equal(a.quote.evidence.binding, routes[0].bindingRef.fingerprint);
  const input = exactInput(1000000n, routes[1]);
  assert.equal(exact(input.amountIn, input.route).quote.amountOut, fixture().dy(true, input.amountIn));
  for (const amount of [-1n, EKUBO_MAX_EXACT_INPUT + 1n]) assert.throws(() => a.method.program.buildRequests(exactInput(amount)));
  const zero = plugin.exact.methods(exactInput(0n))[0];
  assert.equal(zero.kind, "local");
  if (zero.kind === "local") {
    assert.equal(zero.quote(exactInput(0n)).status, "quoted");
    assert.equal(zero.quote(exactInput(1n)).status, "not-applicable");
  }
});
test("exact rejects foreign source, duplicate, partial, malformed, reverted and tampered-route evidence", () => {
  const { input, method } = exact();
  const good = method.program.buildRequests(input).map(fixture().answer);
  for (const results of [[], [...good, good[0]], good.map(r => ({ ...r, source: { ...SOURCE, number: SOURCE.number + 1 } })),
    [result("exact-quote", quoteData(false, input.amountIn - 1n, 100n))],
    [result("exact-quote", "0x")], [{ ...result("exact-quote", "0x"), completion: "reverted-as-declared" as const }]]) {
    assert.throws(() => method.program.decode({ programInput: input, initialResults: results, dependentEvidence: [] }));
  }
  for (const route of [{ ...input.route, tokenOut: EXECUTOR }, { ...input.route, isToken1: true },
    { ...input.route, poolId: ethers.ZeroHash }, { ...input.route, bindingRef: { ...input.route.bindingRef, bindingKey: ethers.ZeroHash } },
    { ...input.route, bindingRef: { ...input.route.bindingRef, fingerprint: ethers.ZeroHash } }]) assert.throws(() => method.program.buildRequests({ ...input, route }));
});
test("execution uses approve + exact selector, strict recipient, threshold and PoolKey", () => {
  const { input, quote } = exact();
  const execution = { ...input, quotedAmountOut: quote.amountOut, minAmountOut: quote.amountOut, exactEvidence: quote.evidence };
  const fragment = plugin.execution.buildFragment(execution);
  assert.deepEqual(fragment.requirements, [{ kind: "approve", token: input.route.tokenIn, spender: EKUBO_ROUTER, amount: MAX_UINT }]);
  assert.equal(fragment.nodes.length, 1);
  const node = fragment.nodes[0], action = plugin.actionAdapters[0], encoded = action.encode(node, EXECUTOR, new Uint8Array());
  assert.equal(encoded[0], 0); assert.equal(ethers.hexlify(encoded.slice(1, 21)), EKUBO_ROUTER);
  const data = ethers.hexlify(encoded.slice(24));
  assert.equal(data.slice(0, 10), "0xf196187f");
  const args = ekuboRouterIface.decodeFunctionData("swap", data);
  assert.equal(args[2], input.amountIn); assert.equal(args[5], quote.amountOut); assert.equal(String(args[6]).toLowerCase(), EXECUTOR);
  assert.equal(args[3], 0n); assert.equal(args[4], 0n);
  assert.equal(action.matchTrace(EKUBO_ROUTER, "0xf196187f"), true);
  assert.equal(action.matchTrace(EXECUTOR, "0xf196187f"), false);
  for (const patch of [{ executor: KEY.token0 }, { minAmountOut: 0n }, { minAmountOut: quote.amountOut + 1n },
    { amountIn: input.amountIn + 1n }, { quotedAmountOut: quote.amountOut + 1n },
    { exactEvidence: { ...quote.evidence, binding: ethers.ZeroHash } }]) assert.throws(() => plugin.execution.buildFragment({ ...execution, ...patch }));
  for (const bad of [{ ...node, target: EXECUTOR }, { ...node, amount: 0n }, { ...node, amount: EKUBO_MAX_EXACT_INPUT + 1n },
    { ...node, children: [node] }, { ...node, params: { ...node.params, receiver: KEY.token0 } },
    { ...node, params: { ...node.params, bindingHash: ethers.ZeroHash } }, { ...node, params: { ...node.params, poolId: ethers.ZeroHash } },
    { ...node, params: { ...node.params, isToken1: true } }, { ...node, params: { ...node.params, amountOutMin: 0n } }]) assert.throws(() => action.encode(bad, EXECUTOR, new Uint8Array()));
  assert.throws(() => action.encode(node, EXECUTOR, new Uint8Array([1])));
  assert.deepEqual(plugin.execution.expectedEffects({ descriptor: d, route: input.route, amountIn: input.amountIn,
    quotedAmountOut: quote.amountOut }).map(e => e.kind === "token-delta" ? e.account : e.kind), ["executor", "executor"]);
});
test("current pricing is fresh, fee-inclusive, source-fenced and quotes its sizing depth", () => {
  for (const route of routes) {
    const draft = plugin.pricing.compileDraft({ descriptor: d, routes: [route], stateKey: route.routeKey });
    const pricing = plugin.pricing.finalizePricingDescriptor({ draft, sharedBindings: [] });
    const current = { descriptor: pricing, routes: [route], source: SOURCE };
    const results = plugin.pricing.current.buildRequests(current).map(fixture().answer);
    const dependent = plugin.pricing.current.buildDependentProgram!({ current, completedRound: 0, initialResults: results, priorEvidence: [] });
    assert(dependent);
    const decoded = dependent.decode(dependent.requests.map(fixture().answer));
    const snapshot = plugin.pricing.current.decodeSnapshot({ descriptor: pricing, initialResults: results, dependentEvidence: [decoded] });
    const mids = plugin.pricing.current.deriveMids({ descriptor: pricing, routes: [route], snapshot });
    const mid = mids.get(route.routeKey)!;
    assert.equal(mid.mid, Number(snapshot.amountOut) / Number(snapshot.amountIn));
    assert.equal(mid.feeBps, 0); assert.equal(mid.reserveA, snapshot.depthIn); assert.equal(mid.reserveB, snapshot.depthOut);
    assert(snapshot.depthIn > snapshot.amountIn);
    assert.throws(() => plugin.pricing.current.decodeSnapshot({ descriptor: pricing, initialResults: results, dependentEvidence: [] }));
    assert.throws(() => plugin.pricing.current.buildDependentProgram!({ current: { ...current, source: { ...SOURCE, generation: SOURCE.generation + 1 } }, completedRound: 0, initialResults: results, priorEvidence: [] }));
    assert.deepEqual(plugin.pricing.dependencies({ descriptor: pricing, routes: [route] }), [EKUBO_CORE, EKUBO_ROUTER, d.poolKey.token0, d.poolKey.token1]);
    assert.deepEqual(plugin.pricing.mutation!.affectedStateKeys({ descriptor: pricing, routes: [route], observation: { ...initialized(), address: EXECUTOR } }), []);
    assert.deepEqual(plugin.pricing.mutation!.affectedStateKeys({ descriptor: pricing, routes: [route], observation: initialized() }), [route.routeKey]);
  }
});
test("partial unit sizing hints never escape as current mids or capacity", () => {
  const route = routes[0];
  const draft = plugin.pricing.compileDraft({ descriptor: d, routes: [route], stateKey: route.routeKey });
  const pricing = plugin.pricing.finalizePricingDescriptor({ draft, sharedBindings: [] });
  const current = { descriptor: pricing, routes: [route], source: SOURCE };
  const base = fixture();
  const initialResults = plugin.pricing.current.buildRequests(current).map(request => request.id === "current-unit-in"
    ? result(request.id, quoteData(false, 71384685n, base.dy(false, 71384685n))) : base.answer(request));
  const dependent = plugin.pricing.current.buildDependentProgram!({ current, completedRound: 0, initialResults, priorEvidence: [] });
  assert(dependent);
  const depthRequest = dependent.requests.find(r => r.id === "current-depth");
  assert(depthRequest?.kind === "eth-call");
  const depthIn = BigInt(ekuboRouterIface.decodeFunctionData("quote", depthRequest.data)[2]);
  assert.equal(depthIn, 71384685n / 4n);
  const currentResults = dependent.requests.map(base.answer);
  const snapshot = plugin.pricing.current.decodeSnapshot({ descriptor: pricing, initialResults,
    dependentEvidence: [dependent.decode(currentResults)] });
  assert.equal(snapshot.depthIn, depthIn);
  assert.equal(snapshot.depthOut, base.dy(false, depthIn));
  assert.throws(() => plugin.pricing.current.decodeSnapshot({ descriptor: pricing, initialResults,
    dependentEvidence: [dependent.decode(currentResults.map(r => r.id === "current-depth"
      ? result(r.id, quoteData(false, depthIn - 1n, base.dy(false, depthIn - 1n))) : r))] }), /partial/);
  assert.throws(() => plugin.pricing.current.decodeSnapshot({ descriptor: pricing, initialResults,
    dependentEvidence: [dependent.decode(currentResults.map(r => ({ ...r, source: { ...SOURCE, hash: word(7n) } })))] }), /source/);
});
test("capture restores a real-shaped observation without importing legacy bindings", () => {
  const observation = swapCall();
  const capture = { familyId: plugin.manifest.familyId, candidateIdentity: ID, source: SOURCE,
    opaqueBinding: { observation: { ...observation, source: { ...SOURCE } }, path: [KEY.token0, KEY.token1],
      amountIn: "15809", minAmountOut: "1", executor: EXECUTOR, runtimeEvidence: [] } };
  const materializer = plugin.capture;
  assert(materializer);
  const vector = materializer.materialize(capture);
  assert.equal(vector.kind, "route");
  if (vector.kind === "route") { assert.equal(vector.amountIn, 15809n); assert.equal(vector.observations[0].kind, "provided-observation"); }
  assert.throws(() => materializer.materialize({ ...capture, familyId: familyId("foreign") }));
});
test("cached parent chain quote bytes: wei parity, NOT a new simulation or identity proof", () => {
  const cached = [
    [15809n, 11938083n, "0x00000000000000000000000000003dc1ffffffffffffffffffffffffff49d6dd80000006dfa2eff76585c9eb0065227a000000000000000000000003cf72f3dc"],
    [375589n, 283473222n, "0x0000000000000000000000000005bb25ffffffffffffffffffffffffef1a8aba80000006de93179f57d125b900651dc2000000000000000000000003cf72f3dc"],
  ] as const;
  for (const [amountIn, amountOut, data] of cached) {
    const input = exactInput(amountIn), method = plugin.exact.methods(input)[1];
    assert.equal(method.kind, "request-program");
    if (method.kind !== "request-program") throw new Error("missing exact");
    const quote = method.program.decode({ programInput: input,
      initialResults: [{ ...result("exact-quote", data), provenance: { kind: "cached-parent-read", fingerprint: "tx-8a0cccb8/prices.json" } }], dependentEvidence: [] });
    assert.equal(quote.amountOut, amountOut);
  }
});
