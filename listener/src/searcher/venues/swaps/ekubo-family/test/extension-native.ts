import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/ekubo.production.js";
import type { CaptureNominationProvider, UnifiedObservation } from "../../../adapter-family-plugin.js";
import { EKUBO_CORE, EKUBO_CORE_DEPLOY_BLOCK, EKUBO_ROUTER, EKUBO_ROUTER_MULTIHOP_SELECTOR, ekuboRouterIface } from "../../ekubo/abi.js";
import { ekuboGraphToken, ekuboPoolExtension } from "../../ekubo/pool-key.js";
import { candidate, decodeMultihopCall, decodeQuote, MAX_UINT } from "../codec.js";
import { extensionRegistrationSlot, validateExtensionProof, EKUBO_SUPPORTED_CORE_HASH, EKUBO_SUPPORTED_ROUTER_HASH, EKUBO_SUPPORTED_TWAMM_HASH } from "../extension.js";
import { ekuboNomination } from "../nomination.js";
import { INIT_ID, MULTIHOP_ID } from "../discovery.js";
import { EKUBO_ACTION_ID } from "../manifest.js";
import { descriptor, EXECUTOR, fixture, identity, initialized, KEY, result, SOURCE, word } from "./fixtures.js";

// Calldata semantics independently extracted from TX 03d6a2ef…73c72 at N26029876.
// Synthetic provider/identity responses below are NOT historical strict proof.
export const EXTENSION = "0xd47f1b1edcfeabb08f6ebd8fc337c27e636c75ba";
export const CONFIG = `${EXTENSION}00c49ba5e353f7ce00000000`;
export const ERC_KEY = { token0: "0x04c46e830bb56ce22735d5d8fc9cb90309317d0f", token1: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", config: CONFIG };
export const NATIVE_KEY = { token0: ethers.ZeroAddress, token1: ERC_KEY.token0, config: CONFIG };
const multi = (keys = [ERC_KEY, NATIVE_KEY], amount = 8137414n, token = ERC_KEY.token1, limit = 0n, skip = 0n) =>
  ekuboRouterIface.encodeFunctionData("multihopSwap", [[keys.map(poolKey => [poolKey, limit, skip]), [token, amount]], -(1n << 255n)]);
const observation = (data = multi()): Extract<UnifiedObservation, { kind: "call" }> => ({ kind: "call", source: SOURCE, target: EKUBO_ROUTER, data });
function syntheticDescriptor(key = ERC_KEY) {
  const base = identity();
  const found = candidate(key);
  return descriptor({ ...base, subject: found.poolId, facts: { ...base.facts, ...found,
    coreCodeHash: EKUBO_SUPPORTED_CORE_HASH, routerCodeHash: EKUBO_SUPPORTED_ROUTER_HASH,
    extensionCodeHash: EKUBO_SUPPORTED_TWAMM_HASH, decimals: [18, key.token0 === ethers.ZeroAddress ? 18 : 6] } });
}
test("source multihop selector discovers both actual keys, without inventing intermediate input", () => {
  assert.equal(EKUBO_ROUTER_MULTIHOP_SELECTOR, "0x6d0cb613");
  const decoded = decodeMultihopCall(observation());
  assert.deepEqual(decoded?.map(p => p.poolId), [candidate(ERC_KEY).poolId, candidate(NATIVE_KEY).poolId]);
  assert(decoded?.every(p => !("amountIn" in p)));
  assert.equal(plugin.discovery.decodeCandidate({ observation: observation(), matchedPatternId: MULTIHOP_ID })?.poolId, candidate(ERC_KEY).poolId);
  for (const bad of [multi([], 1n), multi([ERC_KEY], 0n), multi([ERC_KEY], -1n), multi([ERC_KEY], 1n, EXECUTOR),
    multi([ERC_KEY, KEY]), multi([ERC_KEY], 1n, ERC_KEY.token1, 1n), multi([ERC_KEY], 1n, ERC_KEY.token1, 0n, 1n),
    multi(Array(33).fill(ERC_KEY)), `${multi()}00`]) assert.equal(decodeMultihopCall(observation(bad)), null);
  assert.equal(decodeMultihopCall({ ...observation(), target: EXECUTOR }), null);
});
test("multihop nomination returns original reverse initialization logs, not synthetic swap calls", async () => {
  const logs = [initialized(ERC_KEY), initialized(NATIVE_KEY)];
  const source = { ...SOURCE, number: EKUBO_CORE_DEPLOY_BLOCK };
  let logReads = 0;
  const provider: CaptureNominationProvider = {
    call: async () => { throw Error("unused"); }, getCode: async () => { throw Error("unused"); }, getStorage: async () => { throw Error("unused"); },
    getLogs: async () => { logReads++; return logs; }, getTransactionReceipt: async () => ({ blockNumber: source.number, logs: [] }),
    traceTransaction: async () => ({ type: "CALL", to: EKUBO_ROUTER, input: multi() }),
  };
  const input = { nominations: [{ address: EKUBO_ROUTER, opaque: { adapter: EKUBO_ACTION_ID, txHash: word(55n) } }], source, provider };
  const found = await ekuboNomination.nominate(input);
  assert.equal(logReads, 1);
  assert.deepEqual(found.map(o => plugin.discovery.decodeCandidate({ observation: o, matchedPatternId: INIT_ID })?.poolId),
    [candidate(ERC_KEY).poolId, candidate(NATIVE_KEY).poolId]);
  assert.deepEqual(found.map(o => o.kind === "log" ? o.data : "bad"), logs.map(l => l.data));
  // Production first decodes the Router seed's first key, then re-nominates
  // with that instance ID. It must retain every real hop of the same call.
  const repeated = await ekuboNomination.nominate({ ...input, nominations: [{ address: candidate(ERC_KEY).poolId,
    opaque: { adapter: EKUBO_ACTION_ID, poolId: candidate(ERC_KEY).poolId, txHash: word(55n) } }] });
  assert.deepEqual(repeated.map(o => plugin.discovery.decodeCandidate({ observation: o, matchedPatternId: INIT_ID })?.poolId),
    [candidate(ERC_KEY).poolId, candidate(NATIVE_KEY).poolId]);
  const second = await ekuboNomination.nominate({ ...input, nominations: [{ address: candidate(NATIVE_KEY).poolId,
    opaque: { adapter: EKUBO_ACTION_ID, poolId: candidate(NATIVE_KEY).poolId, txHash: word(55n) } }] });
  assert.equal(plugin.discovery.decodeCandidate({ observation: second[0], matchedPatternId: INIT_ID })?.poolId, candidate(NATIVE_KEY).poolId);
  assert.equal((await ekuboNomination.nominate({ ...input, nominations: [{ address: word(99n),
    opaque: { adapter: EKUBO_ACTION_ID, poolId: word(99n), txHash: word(55n) } }] })).length, 0);
  for (const trace of [{ type: "DELEGATECALL", to: EKUBO_ROUTER, input: multi() },
    { error: "reverted", calls: [{ type: "CALL", to: EKUBO_ROUTER, input: multi() }] }]) {
    assert.equal((await ekuboNomination.nominate({ ...input, provider: { ...provider, traceTransaction: async () => trace } })).length, 0);
  }
  assert.equal((await ekuboNomination.nominate({ ...input, provider: { ...provider, getLogs: async () => [] } })).length, 0);
});
test("extension identity nominates arbitrary addresses but requires code and reverse registration", () => {
  const variant = plugin.identity.variants[0];
  for (const extension of [EXTENSION, "0xd400000000000000000000000000000000000001"]) {
    const found = candidate({ ...ERC_KEY, config: `${extension}${CONFIG.slice(42)}` });
    assert(variant.applies(found));
    const step = { candidate: found, step: 0 };
    const requests = variant.buildRequests(step);
    const storage = requests.find(r => r.id === "extension-registration");
    assert.deepEqual(storage, { id: "extension-registration", kind: "get-storage", address: EKUBO_CORE, slot: extensionRegistrationSlot(extension) });
    const evidence = variant.decode({ step, results: requests.map(r => r.kind === "get-storage" ? result(r.id, word(1n)) : fixture(found.poolKey).answer(r)) });
    assert.equal(variant.decide({ ...step, step: 1, evidence }).status, "chain-proven-rejected");
  }
  for (const registration of [word(0n), word(2n), "0x", word(1n)]) {
    assert.throws(() => validateExtensionProof(EKUBO_SUPPORTED_CORE_HASH, EKUBO_SUPPORTED_ROUTER_HASH, "0x6000", registration));
  }
  const nativeRequests = variant.buildRequests({ candidate: candidate(NATIVE_KEY), step: 0 });
  assert(!nativeRequests.some(r => r.id === "decimals:0"));
  assert(!nativeRequests.some(r => r.kind === "eth-call" && r.to === ethers.ZeroAddress));
});
test("TWAMM descriptors bind supported behavior; no unknown extension can project executable routes", () => {
  const d = syntheticDescriptor();
  assert.equal(plugin.routes.project({ descriptor: d }).length, 2);
  for (const patch of [{ extensionCodeHash: undefined }, { extensionCodeHash: word(1n) }, { coreCodeHash: word(2n) }, { routerCodeHash: word(3n) }]) {
    assert.throws(() => plugin.routes.project({ descriptor: { ...d, ...patch } }), /behavior/);
  }
  const another = syntheticDescriptor({ ...ERC_KEY, token0: ethers.toBeHex(4n, 20) });
  assert.notEqual(d.poolId, another.poolId);
  assert.equal(plugin.routes.project({ descriptor: another }).length, 2);
});
test("native input emits exact WETH withdrawal + equal CALL_VALUE, ERC20 output remains dynamic", () => {
  const d = syntheticDescriptor(NATIVE_KEY), routes = plugin.routes.project({ descriptor: d });
  assert.equal(routes.length, 2);
  const route = routes[0], amountIn = 123456789n;
  assert.equal(route.isToken1, false); assert.equal(route.tokenIn, ekuboGraphToken(ethers.ZeroAddress));
  const exactEvidence = { kind: "ekubo-router-exact-input" as const, source: SOURCE, executor: EXECUTOR,
    binding: route.bindingRef.fingerprint, routeKey: route.routeKey, amountIn, amountOut: 456n };
  const input = { descriptor: d, route, amountIn, quotedAmountOut: 456n, minAmountOut: 456n, exactEvidence, executor: EXECUTOR, runtimeEvidence: [] };
  const fragment = plugin.execution.buildFragment(input);
  assert.deepEqual(fragment.requirements, []);
  const encoded = plugin.actionAdapters[0].encode(fragment.nodes[0], EXECUTOR, new Uint8Array());
  assert.equal(encoded[0], 0);
  assert.equal(ethers.hexlify(encoded.slice(1, 21)), route.tokenIn.toLowerCase());
  const weth = new ethers.Interface(["function withdraw(uint256)"]);
  assert.equal(weth.decodeFunctionData("withdraw", encoded.slice(24, 60))[0], amountIn);
  assert.equal(encoded[60], 1);
  assert.equal(BigInt(ethers.hexlify(encoded.slice(81, 93))), amountIn);
  const swap = ekuboRouterIface.decodeFunctionData("swap", encoded.slice(96));
  assert.equal(swap[2], amountIn); assert.equal(swap[5], 456n); assert.equal(String(swap[6]).toLowerCase(), EXECUTOR);
  assert.throws(() => plugin.execution.buildFragment({ ...input, amountIn: 1n << 96n }), /uint96/);
});
function nativeOutputInput(quotedAmountOut = 19920056031913n, minAmountOut = quotedAmountOut, amountIn = 123456789n) {
  const d = syntheticDescriptor(NATIVE_KEY), route = plugin.routes.project({ descriptor: d })[1];
  return { descriptor: d, route, amountIn, quotedAmountOut, minAmountOut, executor: EXECUTOR, runtimeEvidence: [],
    exactEvidence: { kind: "ekubo-router-exact-input" as const, source: SOURCE, executor: EXECUTOR,
      binding: route.bindingRef.fingerprint, routeKey: route.routeKey, amountIn, amountOut: quotedAmountOut } };
}
function assertNativeOutputEncoding(input: ReturnType<typeof nativeOutputInput>) {
  const fragment = plugin.execution.buildFragment(input);
  assert.equal(input.route.isToken1, true);
  assert.equal(input.route.tokenIn.toLowerCase(), NATIVE_KEY.token1.toLowerCase());
  assert.equal(input.route.tokenOut, ekuboGraphToken(ethers.ZeroAddress));
  assert.equal(plugin.routes.projectGraph({ descriptor: input.descriptor, route: input.route }).executionTarget, EKUBO_ROUTER);
  assert.deepEqual(fragment.requirements, [{ kind: "approve", token: input.route.tokenIn, spender: EKUBO_ROUTER, amount: MAX_UINT }]);
  const encoded = plugin.actionAdapters[0].encode(fragment.nodes[0], EXECUTOR, new Uint8Array());
  assert.equal(encoded[0], 0x0b);
  assert.equal(Number(BigInt(ethers.hexlify(encoded.slice(1, 4)))), encoded.length - 4);
  const body = encoded.slice(4);
  // Exactly one no-value Router CALL: no fixed deposit/withdraw or CALL_VALUE.
  assert.equal(body[0], 0x00);
  assert.equal(ethers.hexlify(body.slice(1, 21)), EKUBO_ROUTER);
  assert.equal(Number(BigInt(ethers.hexlify(body.slice(21, 24)))), body.length - 24);
  const expectedData = ekuboRouterIface.encodeFunctionData("swap", [NATIVE_KEY, true, input.amountIn, 0n, 0n, input.minAmountOut, EXECUTOR]);
  assert.equal(ethers.hexlify(body.slice(24)), expectedData);
  return encoded;
}
test("native output encodes only an actual-delta wrapper around the explicit-receiver Router call", () => {
  assertNativeOutputEncoding(nativeOutputInput());
});
test("native output encoding does not fix wrap quantity to a quote one wei below or above receipt", () => {
  // A reference receipt quantity, not a simulated result. These are encoding
  // checks only; ETH/WETH balance restoration belongs to real VM execution.
  const receiptReference = 19920056031913n, minimum = receiptReference - 1n;
  const baseline = assertNativeOutputEncoding(nativeOutputInput(receiptReference, minimum));
  for (const difference of [-1n, 1n]) {
    const input = nativeOutputInput(receiptReference + difference, minimum);
    assert.equal(input.quotedAmountOut - receiptReference, difference);
    // With a fixed permitted minimum, neither quote can change any wrap byte.
    assert.deepEqual(assertNativeOutputEncoding(input), baseline);
    // With a strict minimum, preserve it verbatim. A short receipt must fail
    // the Router's threshold; Family must not silently subtract one wei.
    assertNativeOutputEncoding(nativeOutputInput(input.quotedAmountOut));
  }
  assert.throws(() => plugin.execution.buildFragment(nativeOutputInput(minimum, receiptReference)), /incompatible/);
});
test("native output has int128 input capacity; uint96 CALL_VALUE cap applies only to native input", () => {
  const input = nativeOutputInput(456n, 456n, 1n << 96n);
  assertNativeOutputEncoding(input);
  const exactInput = { descriptor: input.descriptor, route: input.route, amountIn: input.amountIn,
    source: SOURCE, executor: EXECUTOR, runtimeEvidence: [] };
  const method = plugin.exact.methods(exactInput)[1];
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") throw Error("missing Exact request program");
  assert.equal(method.program.buildRequests(exactInput).length, 1);
  const nativeIn = plugin.routes.project({ descriptor: input.descriptor })[0];
  assert.throws(() => method.program.buildRequests({ ...exactInput, route: nativeIn }), /uint96/);
  assert.throws(() => plugin.execution.buildFragment({ ...input, route: nativeIn }), /uint96/);
});
test("native-output wrapper preserves binding, direction and receiver rejection", () => {
  const input = nativeOutputInput(), node = plugin.execution.buildFragment(input).nodes[0];
  for (const params of [{ ...node.params, bindingHash: word(1n) }, { ...node.params, isToken1: false },
    { ...node.params, receiver: EKUBO_ROUTER }]) {
    assert.throws(() => plugin.actionAdapters[0].encode({ ...node, params }, EXECUTOR, new Uint8Array()), /mismatch|receiver/);
  }
  assert.throws(() => plugin.routes.projectGraph({ descriptor: input.descriptor,
    route: { ...input.route, isToken1: false } }), /direction|descriptor/);
});
test("existing Family-level cadence covers vanilla AND TWAMM; extension dependency is declared", () => {
  assert.equal(plugin.pricing.refreshPolicy, "each-block");
  for (const d of [descriptor(), syntheticDescriptor()]) {
    const route = plugin.routes.project({ descriptor: d })[0];
    const pricing = plugin.pricing.finalizePricingDescriptor({ draft: plugin.pricing.compileDraft({ descriptor: d, routes: [route], stateKey: route.routeKey }), sharedBindings: [] });
    const dependencies = plugin.pricing.dependencies({ descriptor: pricing, routes: [route] });
    const extension = ekuboPoolExtension(d.poolKey.config);
    assert(!dependencies.includes(ethers.ZeroAddress));
    if (extension !== ethers.ZeroAddress) {
      assert(dependencies.includes(extension));
      assert.deepEqual(plugin.pricing.mutation!.affectedStateKeys({ descriptor: pricing, routes: [route], observation: { ...observation(), target: extension } }), [route.routeKey]);
    }
  }
});
test("cached N extension quotes decode exact full amounts, not original transaction prestate parity", () => {
  assert.equal(decodeQuote("0x00000000000000000de0b6b3a7640000fffffffffffffffffffffffffff585364000037b28383a7b01c59f50fe54b224000000000000000000372dbf5cc40ba1", false, 10n ** 18n).amountOut, 686794n);
  assert.equal(decodeQuote("0xffffffffffffffffebeac627da3c6fe9000000000000000000000000000f42404000037b46050e16c813f4fefe54b329000000000000000000372dbf5cc40ba1", true, 1000000n).amountOut, 1447126455778775063n);
});
