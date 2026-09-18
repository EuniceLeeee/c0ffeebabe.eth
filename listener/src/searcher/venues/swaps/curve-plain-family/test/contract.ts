import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/curve-plain.production.js";
import { definedFamilyPluginContractSummary } from "../../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import { CURVE_METAREGISTRY, ERC20, EXECUTION, MAX_UINT, META, MODES, POOL, SIGNED_GETTERS, address, addressArray,
  executionData, getterPool, hasReceiver, lower, probeAmount, quotePool, selector, uint, UINT_POOL } from "../codec.js";
import { LOG_ID, SURFACE, SURFACE_ID, SWAP_TOPIC, UINT_LOG_ID, UINT_SWAP_TOPIC, UINT_NG_LOG_ID, UINT_NG_SWAP_TOPIC, decodeSwapLog } from "../discovery.js";
import { PROBE_RECEIVER } from "../identity.js";
import { reverseBindCurvePlain } from "../nomination.js";
import { actionId } from "../routes.js";
import type { CaptureNominationProvider } from "../../../adapter-family-plugin.js";
import type { ReceiptSwapObservationContext } from "../../../swap-observation.js";
import type { CurveIndexAbi, CurvePlainCandidate, CurvePlainDescriptor, CurvePlainIdentity, CurvePlainMode } from "../types.js";

// Contract fixtures use real public identities, but all unlabelled results below
// are synthetic. Optional cached RPC checks are read evidence, never a fork replay.
const ANCHORS = [
  { pool: "0x00836fe54625be242bcfa286207795405ca4fd10", coins: ["0xa3931d71877c0e7a3148cb7eb4463524fec27fbd", "0xdac17f958d2ee523a2206206994597c13d831ec7"], decimals: [18, 6] },
  { pool: "0x8b83c4aa949254895507d09365229bc3a8c7f710", coins: ["0x865377367054516e17014ccded1e7d814edc9ce4", "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd"], decimals: [18, 18] },
  { pool: "0x64273624eb57c5ca961d366cbf3968e760bf0452", coins: ["0x865377367054516e17014ccded1e7d814edc9ce4", "0x1202f5c7b4b9e47a1a484e8b270be34dbbc75055"], decimals: [18, 18] },
];
const EXECUTOR = "0x1000000000000000000000000000000000000002";
const HANDLER = "0xe06eba9cea16cc71d4498cdba7240bb20d475890";
const SOURCE: CanonicalSource = { number: 24710788, hash: "0x363e14a675e6c4faf10e17ba79dabe60fc4e9237a606ffa24bc00d4e608de9a5", generation: 1 };
const word = (n: bigint): string => ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [n]);
const pad = (values: readonly string[], length: number) => [...values, ...Array(length - values.length).fill(ethers.ZeroAddress)];
function success(id: string, data: string): Extract<AdapterRequestResult, { ok: true }> {
  return { id, ok: true, data, source: SOURCE, provenance: { kind: "fixture", fingerprint: "curve-plain-contract-v1" }, completion: "returned" };
}
function revert(id: string): AdapterRequestResult { return { ...success(id, "0x"), completion: "reverted-as-declared" }; }
function candidate(pool: string): CurvePlainCandidate { return { candidateKind: "curve-plain-pool", pool: ethers.getAddress(pool), hintedI: null, hintedJ: null }; }
type Anchor = typeof ANCHORS[number];
interface FixtureOptions {
  readonly coinAbis?: readonly CurveIndexAbi[];
  readonly balanceAbis?: readonly CurveIndexAbi[];
  readonly quoteAbi?: CurveIndexAbi;
  readonly scalarTail?: string;
}
function fixture(anchor: Anchor, allowedModes: readonly CurvePlainMode[] = ["received"], options: FixtureOptions = {}) {
  const balances = anchor.decimals.map(d => 10n ** BigInt(d) * 1_000_000n);
  const dy = (i: number, j: number, dx: bigint) => {
    // Nonlinear quote with fees and integer rounding. Never a cached unit-price multiplier.
    return dx * balances[j] * 9996n / ((balances[i] + dx) * 10000n);
  };
  const rawAnswer = (request: AdapterRequest): AdapterRequestResult => {
    if (request.kind === "get-code") return success(request.id, "0x6000");
    if (request.kind === "effect-delta-simulation") {
      const mode = MODES.find(m => request.call.data.slice(0, 10) === selector(m))!;
      if (!allowedModes.includes(mode)) return revert(request.id);
      assert.equal(request.call.caller.kind, "executor");
      assert.equal(request.call.executionMode, "impersonated-call-frame");
      const args = EXECUTION[mode].decodeFunctionData(mode === "exchange" ? "exchange" : "exchange_received", request.call.data);
      const [i, j, dx, minDy] = [Number(args[0]), Number(args[1]), BigInt(args[2]), BigInt(args[3])];
      const amountOut = dy(i, j, dx);
      assert.equal(minDy, amountOut);
      const setup = request.preCalls![0];
      assert.equal(lower(setup.to), anchor.coins[i]);
      const setupArgs = ERC20.decodeFunctionData(mode === "exchange" ? "approve" : "transfer", setup.data);
      assert.equal(lower(String(setupArgs[0])), anchor.pool);
      assert.equal(setupArgs[1], dx);
      const receiver = hasReceiver(mode) ? String(args[4]) : EXECUTOR;
      return { ...success(request.id, word(amountOut)), effects: { tokenDeltas: [
        { token: anchor.coins[i], account: EXECUTOR, delta: -dx },
        { token: anchor.coins[i], account: anchor.pool, delta: dx },
        { token: anchor.coins[j], account: receiver, delta: amountOut },
        { token: anchor.coins[j], account: anchor.pool, delta: -amountOut },
      ] } };
    }
    if (request.kind !== "eth-call") throw new Error("unexpected fixture transport");
    if (lower(request.to) === lower(CURVE_METAREGISTRY)) {
      const parsed = META.parseTransaction({ data: request.data })!;
      assert.equal(lower(String(parsed.args[0])), anchor.pool);
      return success(request.id, META.encodeFunctionResult(parsed.name,
        [parsed.name === "get_coins" ? pad(anchor.coins, 8) : pad([HANDLER], 10)]));
    }
    if (request.data === ERC20.encodeFunctionData("decimals")) {
      return success(request.id, word(BigInt(anchor.decimals[anchor.coins.indexOf(lower(request.to))])));
    }
    assert.equal(lower(request.to), anchor.pool);
    const parsed = POOL.parseTransaction({ data: request.data }) ?? UINT_POOL.parseTransaction({ data: request.data }) ??
      SIGNED_GETTERS.parseTransaction({ data: request.data })!;
    const abi = parsed.signature.includes("int128") ? "int128" : "uint256";
    if (parsed.name === "coins" && !(options.coinAbis ?? ["uint256"]).includes(abi)) return revert(request.id);
    if (parsed.name === "balances" && !(options.balanceAbis ?? ["uint256"]).includes(abi)) return revert(request.id);
    if (parsed.name === "get_dy" && options.quoteAbi !== undefined && abi !== options.quoteAbi) return revert(request.id);
    switch (parsed.name) {
      case "coins": return success(request.id, ethers.AbiCoder.defaultAbiCoder().encode(["address"], [anchor.coins[Number(parsed.args[0])]]));
      case "balances": return success(request.id, word(balances[Number(parsed.args[0])]));
      case "A": return success(request.id, word(100n));
      case "fee": return success(request.id, word(4_000_000n));
      case "get_dy": return success(request.id, word(dy(Number(parsed.args[0]), Number(parsed.args[1]), BigInt(parsed.args[2]))));
      default: throw new Error("unexpected fixture call");
    }
  };
  const answer = (request: AdapterRequest): AdapterRequestResult => {
    const read = rawAnswer(request);
    return options.scalarTail !== undefined && read.ok && read.completion === "returned" && ethers.isHexString(read.data, 32)
      ? { ...read, data: read.data + options.scalarTail } : read;
  };
  return { answer, dy, balances };
}
function identity(anchor: Anchor, answer = fixture(anchor).answer, abi: CurveIndexAbi = "int128"): CurvePlainIdentity {
  const variant = plugin.identity.variants[abi === "int128" ? 0 : 1];
  let evidence: unknown;
  for (let step = 0; step <= 4; step++) {
    const input = { candidate: candidate(anchor.pool), step, ...(evidence === undefined ? {} : { evidence }) };
    const decision = variant.decide(input);
    if (decision.status === "verified") return decision.identity;
    assert.equal(decision.status, "continue", JSON.stringify(decision));
    assert(step < 4, "identity fits the existing four-step budget");
    const requests = variant.buildRequests(input);
    assert(requests.length > 0);
    evidence = variant.decode({ step: input, results: requests.map(answer) });
  }
  throw new Error("fixture identity did not verify");
}
function descriptor(verified: CurvePlainIdentity): CurvePlainDescriptor {
  return plugin.instance.finalizeDescriptor({ identity: verified, draft: plugin.instance.compileDraft(verified), sharedBindings: [] });
}
let tests = 0;
function check(name: string, run: () => void) { run(); tests++; console.log(`PASS ${name}`); }

check("all three anchored identities, both direct directions, and all execution modes", () => {
  for (const anchor of ANCHORS) for (const mode of MODES) {
    const abi = mode === "received-uint" ? "uint256" : "int128";
    const verified = identity(anchor, fixture(anchor, [mode]).answer, abi);
    const routes = plugin.routes.project({ descriptor: descriptor(verified) });
    assert.equal(routes.length, 2);
    assert(routes.every(route => route.executionMode === mode));
    assert(routes.every(route => route.quoteAbi === abi));
  }
  const arbitrary = { ...ANCHORS[0], pool: "0x1111111111111111111111111111111111111111" };
  assert.equal(identity(arbitrary).facts.directions.length, 2, "no hardcoded instance admission list");
});
check("signed/unsigned coin, balance and quote ABIs bind independently through padded identity, pricing and Exact", () => {
  const anchor = ANCHORS[0];
  for (const coinAbi of ["int128", "uint256"] as const) for (const balanceAbi of ["int128", "uint256"] as const)
    for (const quoteAbi of ["int128", "uint256"] as const) {
      const f = fixture(anchor, [quoteAbi === "int128" ? "exchange" : "received-uint"],
        { coinAbis: [coinAbi], balanceAbis: [balanceAbi], quoteAbi, scalarTail: "01" });
      const d = descriptor(identity(anchor, f.answer, quoteAbi));
      assert.equal(d.binding.coinAbi, coinAbi);
      assert.equal(d.binding.balanceAbi, balanceAbi);
      assert.equal(d.binding.quoteAbi, quoteAbi);
      const route = plugin.routes.project({ descriptor: d })[0];
      const draft = plugin.pricing.compileDraft({ descriptor: d, routes: [route], stateKey: plugin.pricing.stateKey(route) });
      const pd = plugin.pricing.finalizePricingDescriptor({ draft, sharedBindings: [] });
      const current = { descriptor: pd, routes: [route], source: SOURCE };
      const initial = plugin.pricing.current.buildRequests(current);
      for (const req of initial.filter(r => r.id.startsWith("current-balance-"))) {
        assert(req.kind === "eth-call");
        assert.equal(req.data.slice(0, 10), getterPool(balanceAbi).getFunction("balances")!.selector);
      }
      const initialResults = initial.map(f.answer);
      const dependent = plugin.pricing.current.buildDependentProgram!({ current, completedRound: 0, initialResults, priorEvidence: [] })!;
      const snapshot = plugin.pricing.current.decodeSnapshot({ descriptor: pd, initialResults,
        dependentEvidence: [dependent.decode(dependent.requests.map(f.answer))] });
      assert.equal(snapshot.balanceIn, f.balances[route.i]);
      assert.equal(snapshot.amountOut, f.dy(route.i, route.j, snapshot.amountIn));
      const input = { descriptor: d, route, amountIn: 10n ** BigInt(anchor.decimals[route.i]), source: SOURCE, executor: EXECUTOR, runtimeEvidence: [] };
      const method = plugin.exact.methods(input)[1];
      assert(method.kind === "request-program");
      const exactRequests = method.program.buildRequests(input);
      assert(exactRequests[0].kind === "eth-call");
      assert.equal(exactRequests[0].data.slice(0, 10), quotePool(quoteAbi).getFunction("get_dy")!.selector);
      const exact = method.program.decode({ programInput: input, initialResults: exactRequests.map(f.answer), dependentEvidence: [] });
      assert.equal(exact.amountOut, f.dy(route.i, route.j, input.amountIn));
      for (const key of ["coinAbi", "balanceAbi"] as const) {
        const changed = { ...d, binding: { ...d.binding, [key]: d.binding[key] === "int128" ? "uint256" as const : "int128" as const } };
        const changedRoute = plugin.routes.project({ descriptor: changed })[0];
        assert.notEqual(changedRoute.bindingRef.fingerprint, route.bindingRef.fingerprint);
        assert.throws(() => method.program.buildRequests({ ...input, descriptor: changed }), /descriptor/);
      }
    }
});
check("getter selection rejects conflicts, malformed/uncertain answers and incomplete interfaces", () => {
  const anchor = ANCHORS[0];
  const both = fixture(anchor, ["received"], { coinAbis: ["uint256", "int128"], balanceAbis: ["uint256", "int128"] });
  const verified = identity(anchor, both.answer);
  assert.equal(verified.facts.binding.coinAbi, "uint256", "equivalent ABIs have a deterministic preference");
  assert.equal(verified.facts.binding.balanceAbi, "uint256");
  for (const index of [0, 1]) {
    assert.throws(() => identity(anchor, req => req.id === `coin-int128:${index}`
      ? success(req.id, ethers.AbiCoder.defaultAbiCoder().encode(["address"], [EXECUTOR])) : both.answer(req)), /ambiguous coin/);
    assert.throws(() => identity(anchor, req => req.id === `balance-int128:${index}`
      ? success(req.id, word(both.balances[index] + 1n)) : both.answer(req)), /ambiguous balance/);
  }
  const signed = fixture(anchor, ["received"], { coinAbis: ["int128"], balanceAbis: ["int128"] });
  assert.equal(identity(anchor, req => /^coin:|^balance:/.test(req.id) ? success(req.id, "0x") : signed.answer(req))
    .facts.binding.balanceAbi, "int128", "empty unsupported selectors may use the proved signed interface");
  for (const id of ["coin-int128:0", "balance-int128:1"]) {
    assert.throws(() => identity(anchor, req => req.id === id ? success(id, "0x12") : both.answer(req)), /noncanonical/);
    assert.throws(() => identity(anchor, req => req.id === id ? { id, ok: false, source: SOURCE, failure: "deadline" } : both.answer(req)), /unresolved/);
    assert.throws(() => identity(anchor, req => req.id === id ? { ...both.answer(req), source: { ...SOURCE, generation: 2 } } : both.answer(req)), /foreign source/);
  }
  assert.throws(() => identity(anchor, fixture(anchor, ["received"], { coinAbis: [] }).answer), /unsupported-direct-state-surface/);
  assert.throws(() => identity(anchor, fixture(anchor, ["received"], { balanceAbis: [] }).answer), /unsupported-direct-state-surface/);
  assert.throws(() => identity(anchor, req => req.id === "coin:0" || req.id === "coin-int128:1" ? revert(req.id) : both.answer(req)), /unsupported-direct-state-surface/);
});
check("padded scalar decoding uses the first canonical word and never relaxes execution effects", () => {
  const addrWord = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [EXECUTOR]);
  for (const tail of ["01", "00".repeat(4064), "ff".repeat(64)]) {
    assert.equal(uint(word(123n) + tail), 123n);
    assert.equal(address(addrWord + tail), ethers.getAddress(EXECUTOR));
    assert.equal(uint(word(0n) + tail), 0n);
  }
  for (const malformed of ["0x", `0x${"00".repeat(31)}`, word(1n) + "0", word(1n) + "gg"]) {
    assert.throws(() => uint(malformed), /noncanonical/);
    assert.throws(() => address(malformed), /noncanonical/);
  }
  assert.throws(() => address(`0x01${addrWord.slice(4)}00`), /noncanonical/);
  assert.throws(() => addressArray(META.encodeFunctionResult("get_coins", [pad(ANCHORS[0].coins, 8)]) + "00", 8), /noncanonical/);
  const anchor = ANCHORS[0], f = fixture(anchor, ["exchange"], { scalarTail: "00".repeat(4064) });
  assert.equal(identity(anchor, f.answer).facts.directions.length, 2);
  const empty = (req: AdapterRequest): AdapterRequestResult => {
    const read = f.answer(req);
    return req.kind === "effect-delta-simulation" && read.ok && read.completion === "returned" ? { ...read, data: "0x" } : read;
  };
  assert.equal(identity(anchor, empty).facts.directions.length, 2);
  assert.throws(() => identity(anchor, req => {
    const read = empty(req);
    if (req.kind !== "effect-delta-simulation" || !read.ok || !read.effects?.tokenDeltas) return read;
    return { ...read, effects: { tokenDeltas: read.effects.tokenDeltas.map((delta, i) => i === 2 ? { ...delta, delta: 0n } : delta) } };
  }), /no-execution-proven-direction/);
});
check("int128 and uint256 swap logs require canonical bounded indices", () => {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const log = { kind: "log" as const, source: SOURCE, address: ANCHORS[0].pool,
    topics: [UINT_SWAP_TOPIC, ethers.zeroPadValue(EXECUTOR, 32)], data: "0x" };
  for (const [topic, pattern, abi] of [[SWAP_TOPIC, LOG_ID, "int128"], [UINT_SWAP_TOPIC, UINT_LOG_ID, "uint256"]]) {
    const valid = { ...log, topics: [topic, log.topics[1]], data: coder.encode([abi, "uint256", abi, "uint256"], [1, 1000, 0, 999]) };
    assert.deepEqual(decodeSwapLog(valid), { pool: ethers.getAddress(ANCHORS[0].pool), i: 1, j: 0, amountIn: 1000n, amountOut: 999n });
    assert(plugin.discovery.decodeCandidate({ observation: valid, matchedPatternId: pattern }));
    for (const [i, j] of [[8n, 0n], [1n << 128n, 1n], [(1n << 128n) + 1n, 0n], [1n, (1n << 128n)], [MAX_UINT, 1n]]) {
      const bad = { ...valid, data: coder.encode(["uint256", "uint256", "uint256", "uint256"], [i, 1000n, j, 999n]) };
      assert.equal(decodeSwapLog(bad), null);
      assert.equal(plugin.discovery.decodeCandidate({ observation: bad, matchedPatternId: pattern }), null);
    }
    assert.equal(decodeSwapLog({ ...valid, data: `${valid.data}00` }), null);
  }
  assert.equal(decodeSwapLog({ ...log, topics: [SWAP_TOPIC, log.topics[1]],
    data: coder.encode(["int128", "uint256", "int128", "uint256"], [-1n, 1000n, 0n, 999n]) }), null);
});
check("Tricrypto NG six-word events nominate direct swaps without granting execution support", () => {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const types = Array(6).fill("uint256");
  const values = [2n, 1000n, 0n, 999n, 3n, MAX_UINT];
  const observation = { kind: "log" as const, source: SOURCE, address: ANCHORS[0].pool,
    topics: [UINT_NG_SWAP_TOPIC, ethers.zeroPadValue(EXECUTOR, 32)], data: coder.encode(types, values) };
  assert(plugin.discovery.logPatterns?.some(pattern => pattern.id === UINT_NG_LOG_ID && pattern.topic === UINT_NG_SWAP_TOPIC));
  const candidate = plugin.discovery.decodeCandidate({ observation, matchedPatternId: UINT_NG_LOG_ID });
  assert(candidate);
  assert.equal(candidate.hintedI, 2);
  assert.equal(candidate.hintedJ, 0);
  assert.deepEqual(decodeSwapLog(observation), { pool: ethers.getAddress(ANCHORS[0].pool),
    i: 2, j: 0, amountIn: 1000n, amountOut: 999n });
  assert(plugin.swap.landedEvents.patternIds.includes(UINT_NG_LOG_ID));
  assert(plugin.swap.observation.patternIds.includes(UINT_NG_LOG_ID));
  assert(plugin.swap.poolMaterialization?.patternIds.includes(UINT_NG_LOG_ID));
  assert(plugin.swap.receiptObservation!.topics.includes(UINT_NG_SWAP_TOPIC.toLowerCase()));
  assert.equal(plugin.swap.victimSupport, "detect-only");
  for (const bad of [
    { ...observation, data: observation.data.slice(0, -64) },
    { ...observation, data: `${observation.data}${"00".repeat(32)}` },
    { ...observation, topics: [UINT_SWAP_TOPIC, observation.topics[1]] },
    { ...observation, data: coder.encode(types, [(1n << 128n) + 2n, ...values.slice(1)]) },
    { ...observation, data: coder.encode(types, [values[0], values[1], (1n << 128n), ...values.slice(3)]) },
    { ...observation, data: coder.encode(types, [values[0], 0n, ...values.slice(2)]) },
  ]) {
    assert.equal(decodeSwapLog(bad), null);
    assert.equal(plugin.discovery.decodeCandidate({ observation: bad, matchedPatternId: UINT_NG_LOG_ID }), null);
  }
  assert.throws(() => identity(ANCHORS[0], fixture(ANCHORS[0], [], { quoteAbi: "uint256" }).answer, "uint256"), /no-execution-proven-direction/);
});
check("discovery rejects wrong selectors, trailing calldata, invalid indices and underlying events", () => {
  for (const mode of MODES) {
    const observation = { kind: "call" as const, source: SOURCE, target: ANCHORS[0].pool,
      data: executionData(mode, 1, 0, 1000000n, 0n, EXECUTOR) };
    const decode = (data: string) => plugin.discovery.decodeCandidate({ observation: { ...observation, data }, matchedPatternId: `curve-plain-${mode}` });
    assert(decode(observation.data));
    assert.equal(decode(`${observation.data}00`), null);
    assert.equal(decode(`0xdeadbeef${observation.data.slice(10)}`), null);
    assert.equal(decode(executionData(mode, 8, 0, 1n, 0n, EXECUTOR)), null);
    assert.equal(decode(executionData(mode, 0, 0, 1n, 0n, EXECUTOR)), null);
  }
  const log = { kind: "log" as const, source: SOURCE, address: ANCHORS[0].pool,
    topics: [SWAP_TOPIC, ethers.zeroPadValue(EXECUTOR, 32)], data: ethers.AbiCoder.defaultAbiCoder().encode(
      ["int128", "uint256", "int128", "uint256"], [1, 1000000n, 0, 999n]) };
  assert(plugin.discovery.decodeCandidate({ observation: log, matchedPatternId: LOG_ID }));
  assert.equal(plugin.discovery.decodeCandidate({ observation: { ...log, topics: [ethers.id("TokenExchangeUnderlying(address,int128,uint256,int128,uint256)"), log.topics[1]] }, matchedPatternId: LOG_ID }), null);
  assert.equal(plugin.discovery.decodeCandidate({ observation: { kind: "address-surface", source: SOURCE,
    address: ANCHORS[0].pool, codeHash: ethers.ZeroHash, implementationWord: ethers.ZeroHash, interfaceFingerprints: [], opaque: {} },
    matchedPatternId: SURFACE_ID }), null);
});
check("reverse binding, direct coin mismatch, malformed arrays, and RPC/source failures fail closed", () => {
  const anchor = ANCHORS[0], variant = plugin.identity.variants[0], base = { candidate: candidate(anchor.pool), step: 0 };
  const results = variant.buildRequests(base).map(fixture(anchor).answer);
  const missing = results.map(r => r.id === "registry-handlers" ? success(r.id, META.encodeFunctionResult("get_registry_handlers_from_pool", [pad([], 10)])) : r);
  const evidence = variant.decode({ step: base, results: missing });
  assert.equal(variant.decide({ ...base, evidence, step: 1 }).status, "chain-proven-rejected");
  assert.throws(() => identity(anchor, req => req.id === "coin:0" ? success(req.id, ethers.AbiCoder.defaultAbiCoder().encode(["address"], [EXECUTOR])) : fixture(anchor).answer(req)), /registry-direct-coin-mismatch/);
  assert.throws(() => addressArray(META.encodeFunctionResult("get_coins", [pad([anchor.coins[0], anchor.coins[0]], 8)]), 8), /duplicate/);
  assert.throws(() => addressArray(META.encodeFunctionResult("get_coins", [[anchor.coins[0], ethers.ZeroAddress, anchor.coins[1], ...Array(5).fill(ethers.ZeroAddress)]]), 8), /noncontiguous/);
  assert.throws(() => variant.decode({ step: base, results: [{ id: "pool-code", ok: false, source: SOURCE, failure: "rpc" }, ...results.slice(1)] }), /unresolved/);
  assert.throws(() => variant.decode({ step: base, results: results.map((r, i) => i ? r : { ...r, source: { ...SOURCE, generation: 2 } }) }), /foreign source/);
});
check("execution proof cannot be forged with a return value or a transfer to a foreign receiver", () => {
  const anchor = ANCHORS[0], answer = fixture(anchor).answer;
  assert.throws(() => identity(anchor, req => {
    const r = answer(req);
    if (req.kind !== "effect-delta-simulation" || !r.ok || !r.effects) return r;
    return { ...r, effects: { tokenDeltas: r.effects.tokenDeltas!.map(d =>
      lower(d.account) === lower(PROBE_RECEIVER) ? { ...d, account: EXECUTOR } : d) } };
  }), /no-execution-proven-direction/);
  assert.throws(() => identity(anchor, req => req.kind === "effect-delta-simulation" ? success(req.id, word(1n)) : answer(req)), /no-execution-proven-direction/);
  assert.throws(() => identity(anchor, req => req.kind === "effect-delta-simulation" ? { id: req.id, ok: false, source: SOURCE, failure: "deadline" } : answer(req)), /unresolved/);
});
check("amount-sensitive exact quotes, source fencing, tampered routes, zero, negative and overflow", () => {
  const anchor = ANCHORS[0], f = fixture(anchor), d = descriptor(identity(anchor)), route = plugin.routes.project({ descriptor: d })[1];
  const input = { descriptor: d, route, amountIn: 1000000n, source: SOURCE, executor: EXECUTOR, runtimeEvidence: [] };
  const method = plugin.exact.methods(input)[1];
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") throw new Error("missing get_dy program");
  const quote = (dx: bigint) => { const at = { ...input, amountIn: dx };
    return method.program.decode({ programInput: at, initialResults: method.program.buildRequests(at).map(f.answer), dependentEvidence: [] }); };
  const small = quote(1000000n), large = quote(100000000000n);
  assert(large.amountOut < small.amountOut * 100000n, "nonlinear impact survives the exact boundary");
  assert.equal(quote(0n).amountOut, 0n);
  assert.throws(() => quote(-1n), /uint256/);
  assert.throws(() => quote(MAX_UINT + 1n), /uint256/);
  assert.throws(() => method.program.buildRequests({ ...input, route: { ...route, j: route.i } }), /descriptor/);
  assert.throws(() => method.program.buildRequests({ ...input, route: { ...route, executionMode: "exchange" } }), /descriptor/);
  assert.throws(() => method.program.decode({ programInput: input, initialResults: [{ ...success("exact-get-dy", word(1n)), source: { ...SOURCE, hash: ethers.ZeroHash } }], dependentEvidence: [] }), /foreign source/);
  assert.throws(() => method.program.decode({ programInput: input, initialResults: [revert("exact-get-dy")], dependentEvidence: [] }), /reverted/);
  assert.throws(() => uint("0x"), /noncanonical/);
});
check("current pricing uses required read-only state and fee-inclusive get_dy", () => {
  const anchor = ANCHORS[0], f = fixture(anchor), d = descriptor(identity(anchor)), route = plugin.routes.project({ descriptor: d })[1];
  const draft = plugin.pricing.compileDraft({ descriptor: d, routes: [route], stateKey: plugin.pricing.stateKey(route) });
  const pd = plugin.pricing.finalizePricingDescriptor({ draft, sharedBindings: [] });
  const current = { descriptor: pd, routes: [route], source: SOURCE };
  const initial = plugin.pricing.current.buildRequests(current);
  assert(initial.every(r => r.kind === "eth-call" && r.required !== false));
  const initialResults = initial.map(f.answer);
  const program = plugin.pricing.current.buildDependentProgram!({ current, completedRound: 0, initialResults, priorEvidence: [] })!;
  const dependentEvidence = [program.decode(program.requests.map(f.answer))];
  const snapshot = plugin.pricing.current.decodeSnapshot({ descriptor: pd, initialResults, dependentEvidence });
  const mid = plugin.pricing.current.deriveMids({ descriptor: pd, snapshot, routes: [route] }).get(route.routeKey)!;
  assert.equal(mid.mid, Number(snapshot.amountOut) / Number(snapshot.amountIn));
  assert.equal(mid.feeBps, 0);
  assert.equal(mid.reserveA, f.balances[route.i]);
  assert.equal(mid.reserveB, f.balances[route.j]);
  assert.throws(() => plugin.pricing.current.decodeSnapshot({ descriptor: pd, initialResults: initialResults.map(r =>
    r.id === "current-balance-out" ? success(r.id, word(0n)) : r), dependentEvidence }), /liquidity/);
  assert.throws(() => probeAmount(37, 100n), /scale/);
  assert.equal(probeAmount(6, 1n), 1n);
});
check("received transfer requirement and encoded selector/receiver/minDy are exact", () => {
  const anchor = ANCHORS[0];
  for (const mode of MODES) {
    const f = fixture(anchor, [mode]), d = descriptor(identity(anchor, f.answer, mode === "received-uint" ? "uint256" : "int128")), route = plugin.routes.project({ descriptor: d })[1];
    const input = { descriptor: d, route, amountIn: 1000000n, source: SOURCE, executor: EXECUTOR, runtimeEvidence: [] };
    const method = plugin.exact.methods(input)[1];
    if (method.kind !== "request-program") throw new Error("missing get_dy program");
    const exact = method.program.decode({ programInput: input, initialResults: method.program.buildRequests(input).map(f.answer), dependentEvidence: [] });
    const buildInput = { ...input, quotedAmountOut: exact.amountOut, minAmountOut: exact.amountOut - 1n, exactEvidence: exact.evidence };
    const fragment = plugin.execution.buildFragment(buildInput);
    assert.equal(fragment.requirements[0].kind, mode === "exchange" ? "approve" : "transfer-to-pool");
    const node = fragment.nodes[0];
    assert.equal(node.adapterId, actionId(mode));
    const action = plugin.actionAdapters.find(a => a.id === node.adapterId)!;
    const encoded = action.encode(node, EXECUTOR, new Uint8Array());
    assert.equal(encoded[0], 0);
    assert.equal(ethers.hexlify(encoded.slice(1, 21)), anchor.pool);
    const data = ethers.hexlify(encoded.slice(24));
    assert.equal(data, executionData(mode, route.i, route.j, input.amountIn, buildInput.minAmountOut, EXECUTOR));
    assert.equal(action.matchTrace(anchor.pool, selector(mode)), true);
    assert.throws(() => plugin.execution.buildFragment({ ...buildInput, amountIn: input.amountIn + 1n }), /incompatible/);
    assert.throws(() => plugin.execution.buildFragment({ ...buildInput, minAmountOut: exact.amountOut + 1n }), /incompatible/);
    if (hasReceiver(mode)) assert.throws(() => action.encode({ ...node, params: { ...node.params, receiver: PROBE_RECEIVER } }, EXECUTOR, new Uint8Array()), /foreign receiver/);
  }
  assert.equal(selector("received"), "0xafb43012");
  assert.equal(selector("received-no-receiver"), "0x7e3db030");
});
check("manifest owns only declared plain actions and no credit or underlying action", () => {
  const summary = definedFamilyPluginContractSummary(plugin);
  assert.equal(summary.domain, "swap");
  assert.deepEqual([...summary.suppliedActionAdapterIds].sort(), ["curve-exchange", "curve-exchange-nr", "curve-exchange-plain", "curve-exchange-received-uint"]);
  assert.deepEqual([...plugin.manifest.requiredInfraActionAdapterIds].sort(), ["erc20-approve", "erc20-transfer"]);
});

const nominated = await reverseBindCurvePlain({ nominations: [{ address: ANCHORS[0].pool, opaque: { adapter: "curve" } }], source: SOURCE,
  provider: { getCode: async () => "0x6000", call: async () => META.encodeFunctionResult("get_registry_handlers_from_pool", [pad([HANDLER], 10)]) } as never });
assert.equal(nominated[0].status, "verified");
if (nominated[0].status === "verified") assert.deepEqual(nominated[0].observation.kind === "address-surface" ? nominated[0].observation.interfaceFingerprints : [], [SURFACE]);
const unregistered = await reverseBindCurvePlain({ nominations: [{ address: ANCHORS[0].pool, opaque: { adapter: "curve" } }], source: SOURCE,
  provider: { getCode: async () => "0x6000", call: async () => META.encodeFunctionResult("get_registry_handlers_from_pool", [pad([], 10)]) } as never });
assert.equal(unregistered[0].status, "failed");
console.log("PASS reverse nomination membership and rejection"); tests++;

{
  const anchor = ANCHORS[0], coder = ethers.AbiCoder.defaultAbiCoder();
  const log = { address: anchor.pool, topics: [SWAP_TOPIC, ethers.zeroPadValue(EXECUTOR, 32)],
    data: coder.encode(["int128", "uint256", "int128", "uint256"], [0, 1000n, 1, 999n]) };
  const txHash = `0x${"11".repeat(32)}`;
  let blockNumber: number | undefined = SOURCE.number, traceCalls = 0;
  const provider: CaptureNominationProvider = { call: async () => "0x", getCode: async () => "0x", getStorage: async () => "0x",
    getLogs: async () => [], getTransactionReceipt: async () => ({ blockNumber, logs: [log] }),
    traceTransaction: async () => { traceCalls++; return {}; } };
  const nominate = () => plugin.discovery.nominate!.nominate({ source: SOURCE, provider,
    nominations: [{ address: anchor.pool, opaque: { adapter: "curve", txHash } }] });
  assert.equal((await nominate()).length, 1);
  blockNumber = SOURCE.number - 1; assert.equal((await nominate()).length, 1);
  for (const bad of [SOURCE.number + 1, undefined, NaN, -1, SOURCE.number + 0.5]) {
    blockNumber = bad; assert.equal((await nominate()).length, 0);
  }
  assert.equal(traceCalls, 0, "future or unanchored receipts cannot fall through to trace");
  console.log("PASS historical nominations reject future and unanchored receipts before trace"); tests++;

  let reads = 0;
  const ctx: ReceiptSwapObservationContext = { logs: [log], graph: [{ adapterId: "curve-exchange-plain",
    target: anchor.pool, tokenIn: anchor.coins[0], tokenOut: anchor.coins[1], slotKind: "swap",
    edgeKind: "swap", leavesStandingPosition: false }], edgesByTarget: new Map(),
    sourceGeneration: { id: "fixture", sourceBlock: SOURCE.number, sourceBlockHash: SOURCE.hash,
      receiptId: txHash, receiptBlockNumber: SOURCE.number + 1, receiptBlockHash: null,
      receiptParentBlockHash: SOURCE.hash, receiptTransactionHash: txHash, logsCompleteness: "complete-receipt" },
    control: { deadlineAtMs: Date.now() + 10000, signal: new AbortController().signal },
    matchedOwnedTriggers: [{ triggerId: "swap:0", logIndex: 0, emitter: anchor.pool, topic0: SWAP_TOPIC }],
    tokenQuery: { async call(req) {
      reads++; assert.equal(req.blockTag, SOURCE.number); assert.equal(req.to, CURVE_METAREGISTRY);
      assert.equal(req.data, META.encodeFunctionData("get_coins", [anchor.pool]));
      return META.encodeFunctionResult("get_coins", [pad(anchor.coins, 8)]);
    } },
  };
  for (const topic of [SWAP_TOPIC, UINT_SWAP_TOPIC, UINT_NG_SWAP_TOPIC]) {
    const ng = topic === UINT_NG_SWAP_TOPIC;
    const result = await plugin.swap.receiptObservation!.decodeReceiptImpacts({ ...ctx,
      logs: [{ ...log, topics: [topic, log.topics[1]], data: coder.encode(
        ["uint256", "uint256", "uint256", "uint256", ...(ng ? ["uint256", "uint256"] : [])],
        [0, 1000n, 1, 999n, ...(ng ? [10n, 20n] : [])]) }],
      matchedOwnedTriggers: [{ ...ctx.matchedOwnedTriggers[0], topic0: topic }],
    });
    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") throw new Error("receipt unexpectedly unresolved");
    assert.equal(result.impacts.length, 1); assert.equal(result.impacts[0].impact.amountIn, 1000n);
    assert.equal(result.impacts[0].impact.amountOut, 999n);
    assert.equal(lower(result.impacts[0].impact.tokenIn), anchor.coins[0]);
    assert.equal(lower(result.impacts[0].impact.tokenOut), anchor.coins[1]);
  }
  assert.equal(reads, 3);
  for (const bad of [
    { ...ctx, tokenQuery: null }, { ...ctx, graph: [] },
    { ...ctx, graph: [{ ...ctx.graph[0], tokenOut: EXECUTOR }] },
    { ...ctx, sourceGeneration: { ...ctx.sourceGeneration, sourceBlockHash: null } },
    { ...ctx, matchedOwnedTriggers: [ctx.matchedOwnedTriggers[0], ctx.matchedOwnedTriggers[0]] },
    { ...ctx, matchedOwnedTriggers: [{ ...ctx.matchedOwnedTriggers[0], emitter: EXECUTOR }] },
    { ...ctx, tokenQuery: { call: async () => "0x" } },
    { ...ctx, control: { ...ctx.control, deadlineAtMs: 0 } },
  ]) assert.equal((await plugin.swap.receiptObservation!.decodeReceiptImpacts(bad)).status, "unresolved");
  const empty = await plugin.swap.receiptObservation!.decodeReceiptImpacts({ ...ctx, matchedOwnedTriggers: [] });
  assert.equal(empty.status, "no-match");
  console.log("PASS strict receipt coin binding without legacy indices; canonical logs and fail-closed negatives"); tests++;
}

const evidenceArg = process.argv.indexOf("--chain-evidence");
if (evidenceArg >= 0) {
  const cache = JSON.parse(readFileSync(process.argv[evidenceArg + 1], "utf8"));
  assert.equal(cache.block, SOURCE.number);
  for (const anchor of ANCHORS) {
    const stored = cache.pools.find((p: { pool: string }) => lower(p.pool) === anchor.pool);
    assert(stored);
    assert.deepEqual(stored.coins.map(lower), anchor.coins);
    for (const name of ["get_registry_handlers_from_pool", "get_coins"]) {
      const data = META.encodeFunctionData(name, [anchor.pool]);
      const row = cache.requests.find((r: any) => r.request.method === "eth_call" && lower(r.request.params[0].to) === lower(CURVE_METAREGISTRY) && r.request.params[0].data.toLowerCase() === data.toLowerCase());
      assert(row && typeof row.result === "string");
      const decoded = addressArray(row.result, name === "get_coins" ? 8 : 10);
      assert(decoded.length > 0);
      if (name === "get_coins") assert.deepEqual(decoded.map(lower), anchor.coins);
    }
    for (const q of stored.quotes) {
      if (q.sig.includes("uint256,uint256")) { assert.equal(q.amountOut, null); continue; }
      const d = descriptor(identity(anchor)), route = plugin.routes.project({ descriptor: d }).find(r => r.i === q.i && r.j === q.j)!;
      const input = { descriptor: d, route, amountIn: BigInt(q.amountIn), source: SOURCE, executor: EXECUTOR, runtimeEvidence: [] };
      const method = plugin.exact.methods(input)[1];
      if (method.kind !== "request-program") throw new Error("missing method");
      const req = method.program.buildRequests(input)[0];
      assert(req.kind === "eth-call");
      const row = cache.requests.find((r: any) => r.request.method === "eth_call" && lower(r.request.params[0].to) === anchor.pool && r.request.params[0].data.toLowerCase() === req.data.toLowerCase());
      assert(row && typeof row.result === "string");
      const exact = method.program.decode({ programInput: input, initialResults: [success(req.id, row.result)], dependentEvidence: [] });
      assert.equal(exact.amountOut, BigInt(q.amountOut));
    }
  }
  console.log("PASS cached real registry/direct-coin and six exact get_dy responses (read evidence only)"); tests++;
}
console.log(`curve-plain plugin-local contract: ${tests} groups passed; fixture simulation is not on-chain execution evidence`);
