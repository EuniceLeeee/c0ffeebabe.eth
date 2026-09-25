import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ethers } from "ethers";
import { executeAdapterWork } from "../../../../adapter-work-intent.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import { mooniswapIdentity } from "../identity.js";
import { mooniswapInstance } from "../instance.js";
import { mooniswapRoutes } from "../routes.js";
import { mooniswapPricing } from "../pricing.js";
import { mooniswapQuoteProgram } from "../exact.js";
import { mooniswapDiscovery, SWAPPED_ID, SWAPPED_TOPIC, decodeSwapped } from "../discovery.js";
import { mooniswapSwap } from "../swap.js";
import { IMMUTABLES, NORMALIZED_RUNTIME_HASH, RUNTIME_LENGTH, verifyPoolRuntime } from "../runtime.js";
import { FEE_DENOMINATOR, MOONISWAP_ID, POOL, GOVERNANCE, TOKEN, lower } from "../codec.js";
import type { MooniswapCandidate, MooniswapDescriptor } from "../types.js";

// Explicit cache input, never RPC. Identity bytecode and landed receipt are
// real saved evidence; all current-state replies below are synthetic contracts.
const cache = process.env.MOONISWAP_EVIDENCE_DIR;
if (!cache) throw new Error("MOONISWAP_EVIDENCE_DIR must name the cached coffee corpus");
const TX = "0x03d2dc13a13e6a71bcf21c1f3134c4167eb29cd20bb96ad7853249d1816a2dd8";
const pool = "0x2c4ea51d9dec7cdabe2d1bde01882f87b5231d21";
const html = readFileSync(join(cache, "contracts", `${pool}.html`), "utf8");
const raw = JSON.parse(readFileSync(join(cache, "raw", `${TX}.json`), "utf8"));
const runtime = html.slice(html.indexOf("Deployed Bytecode")).match(/0x[0-9a-fA-F]{200,}/)![0];
const constructor = html.slice(html.indexOf("Constructor Arguments")).match(/<pre[^>]*>([0-9a-f]+)/)![1];
const args = ethers.AbiCoder.defaultAbiCoder().decode(["address", "address", "string", "string", "address"], `0x${constructor}`);
const token0 = lower(String(args[0])), token1 = lower(String(args[1])), governance = lower(String(args[4]));
const source: CanonicalSource = { number: Number(BigInt(raw.receipt.blockNumber)), hash: raw.receipt.blockHash, generation: 1 };
const executor = `0x${"44".repeat(20)}`, replacement = `0x${"55".repeat(20)}`;
const word = (v: string | bigint) => ethers.toBeHex(BigInt(v), 32);
const answer = (id: string, data: string, at = source): AdapterRequestResult => ({ id, ok: true, source: at,
  completion: "returned", data, provenance: { kind: "synthetic-unit-test", fingerprint: "not-historical-acceptance" } });
function patched(a = token0, b = token1) {
  const bytes = ethers.getBytes(runtime);
  for (const [key, value] of [["token0", a], ["token1", b]] as const) {
    for (const offset of IMMUTABLES[key]) bytes.set(ethers.getBytes(word(value)), offset);
  }
  return ethers.hexlify(bytes);
}
function identify(a = token0, b = token1, target = pool, override?: (r: AdapterRequest) => AdapterRequestResult | undefined) {
  const candidate: MooniswapCandidate = { candidateKind: "mooniswap", pool: target };
  const variant = mooniswapIdentity.variants[0];
  let evidence: unknown;
  for (let step = 0; step < 4; step++) {
    const input = { candidate, step, evidence }, decision = variant.decide(input);
    if (decision.status !== "continue") return decision;
    const results = variant.buildRequests(input).map(r => override?.(r) ?? answer(r.id,
      r.id === "code" ? patched(a, b) : r.id === "token0" ? word(a) : r.id === "token1" ? word(b) :
      r.id.endsWith("-code") ? "0x60006000" : word(18n)));
    evidence = variant.decode({ step: input, results });
  }
  throw new Error("identity did not terminate");
}
function setup() {
  const decision = identify(); assert.equal(decision.status, "verified");
  if (decision.status !== "verified") throw new Error("not verified");
  const identity = decision.identity;
  const descriptor = mooniswapInstance.finalizeDescriptor({ identity, draft: mooniswapInstance.compileDraft(identity), sharedBindings: [] });
  const routes = mooniswapRoutes.project({ descriptor });
  return { descriptor, routes };
}
function pricingState(d: MooniswapDescriptor, at = source, overrides: Record<string, bigint | string> = {}) {
  const values: Record<string, bigint | string> = { token0, token1, governance, balance0: 1000n, balance1: 2000n,
    addition0: 1500n, addition1: 3000n, removal0: 900n, removal1: 1200n, fee: 3n * 10n ** 15n, slippageFee: FEE_DENOMINATOR, ...overrides };
  const routes = mooniswapRoutes.project({ descriptor: d }), current = { descriptor: d, source: at, routes };
  const initialResults = mooniswapPricing.current.buildRequests(current).map(r => answer(r.id, word(values[r.id]), at));
  const round = mooniswapPricing.current.buildDependentProgram({ current, initialResults, completedRound: 0, priorEvidence: [] });
  assert(round); const active = answer("active", word(overrides.active ?? 1n), at);
  const dependentEvidence = [round.decode([active])];
  const snapshot = mooniswapPricing.current.decodeSnapshot({ descriptor: d, initialResults, dependentEvidence });
  return { current, initialResults, dependentEvidence, snapshot, round };
}

test("cached receipt and source pin the real ERC20 swapFor leg and block", () => {
  assert.equal(raw.tx.hash, TX); assert.equal(raw.receipt.transactionHash, TX); assert.equal(raw.receipt.status, "0x1");
  assert.equal(Number(BigInt(raw.tx.chainId)), 1); assert.equal(source.number, 26030091);
  assert.equal(source.hash, "0x589ef7d0d24a9dc2cbccd0c24fe6857794ead5e47e79aad0b8dd875e8e861f53");
  assert.equal(raw.tx.blockHash, source.hash);
  assert.equal(token0, "0x111111111117dc0aa78b770fa6a738034120c302");
  assert.equal(token1, "0xaaaaaa20d9e0e2461697782ef11675f668207961");
  const swaps = raw.receipt.logs.filter((l: { address: string }) => l.address === pool).map(decodeSwapped).filter(Boolean);
  assert.equal(swaps.length, 1); const swap = swaps[0]!;
  assert.equal(swap.tokenIn, token1); assert.equal(swap.tokenOut, token0);
  assert.equal(swap.amountIn, 947347012323163156825n); assert.equal(swap.amountOut, 458914096390731810847n);
  const legs: { input: string; from: string; error?: string }[] = [];
  const walk = (c: { to: string; input: string; from: string; calls?: any[] }) => { if (c.to === pool) legs.push(c); c.calls?.forEach(walk); };
  walk(raw.trace); assert.equal(legs.length, 1); assert(!legs[0].error);
  const call = POOL.decodeFunctionData("swapFor", legs[0].input);
  assert.equal(BigInt(call.amount), swap.amountIn); assert.equal(lower(String(call.receiver)), swap.receiver);
  assert.equal(legs[0].from, swap.sender);
});
test("all and only constructor immutable words are normalized", () => {
  const creation = ethers.getBytes(`0x${html.match(/id='verifiedbytecode2'>([0-9a-f]+)/)![1]}`);
  assert.equal(creation[1586], 0x39); assert.equal(creation[1674], 0xf3);
  const stores: number[] = [];
  for (let pc = 1587; pc < 1669; pc++) {
    if (creation[pc] === 0x80 && creation[pc + 1] === 0x61 && creation[pc + 4] === 0x52) stores.push(creation[pc + 2] * 256 + creation[pc + 3]);
  }
  assert.deepEqual(stores.slice(0, 8), IMMUTABLES.token1);
  assert.deepEqual(stores.slice(8), IMMUTABLES.token0);
  const deployed = ethers.getBytes(runtime); assert.equal(deployed.length, RUNTIME_LENGTH);
  for (const offset of stores) deployed.fill(0, offset, offset + 32);
  assert.equal(ethers.keccak256(deployed), NORMALIZED_RUNTIME_HASH);
  assert.deepEqual(creation.slice(1676, 1676 + RUNTIME_LENGTH), deployed);
  assert(verifyPoolRuntime(runtime, token0, token1));
});
test("runtime identity is instance/token-agnostic and refuses spoofed code/getters/native pairs", () => {
  assert.equal(identify(executor, replacement, governance).status, "verified");
  for (const code of ["0x", "0x60006000", `${runtime.slice(0, -2)}00`]) {
    assert.equal(identify(token0, token1, pool, r => r.id === "code" ? answer(r.id, code) : undefined).status, "chain-proven-rejected");
  }
  const tampered = ethers.getBytes(runtime); tampered[IMMUTABLES.token0[2] + 31] ^= 1;
  assert(!verifyPoolRuntime(ethers.hexlify(tampered), token0, token1));
  assert.equal(identify(ethers.ZeroAddress, token1).status, "chain-proven-rejected");
  assert.equal(identify(token1, token0).status, "chain-proven-rejected");
  assert.equal(identify(token0, token1, pool, r => r.id === "token0-code" ? answer(r.id, "0x") : undefined).status, "chain-proven-rejected");
  assert.equal(identify(token0, token1, pool, r => r.id === "decimals1" ? answer(r.id, word(78n)) : undefined).status, "chain-proven-rejected");
  assert.throws(() => identify(token0, token1, pool, r => r.id === "token1-code" ? answer(r.id, "0x6000", { ...source, generation: 2 }) : undefined), /foreign/);
});
test("natural call/log discovery is structural nomination only", () => {
  const log = raw.receipt.logs.find((l: { address: string; topics: string[] }) => l.address === pool && l.topics[0] === SWAPPED_TOPIC);
  assert(log);
  const observation = { ...log, kind: "log" as const, source };
  assert.equal(mooniswapDiscovery.decodeCandidate({ observation, matchedPatternId: SWAPPED_ID })!.pool, pool);
  assert.equal(mooniswapDiscovery.decodeCandidate({ observation: { ...observation, data: log.data + "00" }, matchedPatternId: SWAPPED_ID }), null);
  assert.equal(decodeSwapped({ ...log, topics: [log.topics[0], `0x01${log.topics[1].slice(4)}`, ...log.topics.slice(2)] }), null);
  for (const method of ["swapFor", "swap"]) {
    const data = POOL.encodeFunctionData(method, [token0, token1, 100n, 0n, ethers.ZeroAddress, ...(method === "swapFor" ? [executor] : [])]);
    const call = { kind: "call" as const, target: replacement, data, source };
    assert.equal(mooniswapDiscovery.decodeCandidate({ observation: call, matchedPatternId: `mooniswap-${method}` })!.pool, replacement);
    assert.equal(mooniswapDiscovery.decodeCandidate({ observation: { ...call, data: data + "00" }, matchedPatternId: `mooniswap-${method}` }), null);
  }
  assert.equal(mooniswapSwap.victimSupport, "detect-only");
  assert(!("localApply" in mooniswapSwap)); assert(!("overlay" in mooniswapSwap));
});
test("identity publishes both bound directions but never freezes mutable governance", () => {
  const { descriptor, routes } = setup();
  assert.equal(routes.length, 2); assert(!("governance" in descriptor));
  assert.deepEqual(routes.map(r => [r.tokenIn, r.tokenOut]), [[token0, token1], [token1, token0]]);
  for (const route of routes) assert.equal(mooniswapRoutes.projectGraph({ descriptor, route }).executionTarget, pool);
  assert.throws(() => mooniswapRoutes.projectGraph({ descriptor, route: { ...routes[0], tokenOut: token0 } }), /binding/);
});
test("raw uses current virtual reserves and fee, with mandatory each-block policy", () => {
  const { descriptor, routes } = setup(), { snapshot } = pricingState(descriptor);
  assert.equal(mooniswapPricing.refreshPolicy, "each-block");
  const mids = mooniswapPricing.current.deriveMids({ descriptor, routes, snapshot });
  assert.equal(mids.get(routes[0].routeKey)!.mid, 0.7976);
  assert.equal(mids.get(routes[1].routeKey)!.mid, 0.2991);
  assert.notEqual(mids.get(routes[0].routeKey)!.mid, Number(snapshot.balance1) / Number(snapshot.balance0) * 0.997);
  const next = { ...source, number: source.number + 1, hash: `0x${"bb".repeat(32)}`, generation: 2 };
  const fresh = pricingState(descriptor, next, { addition0: 1100n, removal1: 1800n });
  const updated = mooniswapPricing.current.deriveMids({ descriptor, routes, snapshot: fresh.snapshot });
  assert.notEqual(updated.get(routes[0].routeKey)!.mid, mids.get(routes[0].routeKey)!.mid);
  assert.equal(snapshot.balance0, fresh.snapshot.balance0); assert.equal(snapshot.balance1, fresh.snapshot.balance1);
  assert.deepEqual(fresh.snapshot.source, next);
});
test("governance replacement, shutdown, depletion and bad state fail closed and recover", () => {
  const { descriptor, routes } = setup();
  const moved = pricingState(descriptor, source, { governance: replacement });
  assert.equal(moved.snapshot.governance, replacement);
  assert.equal(moved.round.requests[0].kind, "eth-call");
  if (moved.round.requests[0].kind === "eth-call") {
    assert.equal(moved.round.requests[0].to, replacement);
    assert.equal(moved.round.requests[0].data, GOVERNANCE.encodeFunctionData("isActive"));
  }
  const unavailableCases: Record<string, bigint>[] = [{ active: 0n }, { balance0: 0n, removal0: 0n }, { removal0: 0n, removal1: 0n }];
  for (const change of unavailableCases) {
    const { snapshot } = pricingState(descriptor, source, change);
    assert.equal(mooniswapPricing.current.deriveMids({ descriptor, snapshot, routes }).size, 0);
    assert.equal(mooniswapPricing.current.classifyUnavailable({ descriptor, snapshot, routes }).size, 2);
  }
  assert.equal(mooniswapPricing.current.deriveMids({ descriptor, snapshot: moved.snapshot, routes }).size, 2);
  const invalidCases: Record<string, bigint>[] = [{ active: 2n }, { addition0: 999n }, { removal1: 2001n }, { fee: FEE_DENOMINATOR }, { slippageFee: FEE_DENOMINATOR + 1n }];
  for (const bad of invalidCases) {
    assert.throws(() => pricingState(descriptor, source, bad));
  }
});
test("raw requests source-bound getters; exact forwards finite amount with full slippage quote", () => {
  const { descriptor, routes } = setup(), i = { descriptor, route: routes[0], source, executor, runtimeEvidence: [], amountIn: 100n };
  const raw = pricingState(descriptor);
  assert.equal(raw.initialResults.length, 11);
  const requests = mooniswapQuoteProgram.buildRequests(i);
  assert.equal(requests[0].kind, "eth-call");
  if (requests[0].kind === "eth-call") assert.equal(BigInt(POOL.decodeFunctionData("getReturn", requests[0].data).amount), 100n);
  // Source formula at x=1000,y=2000, fee=.003 and slippageFee=1:
  // taxed=100-floor(.3)=100; ret=floor(200000/1100)=181;
  // output=floor(181*1000/1100)=164, not mid*100 nor naive V2 181.
  const values: Record<string, string> = { quote: word(164n), "input-balance": word(1000n), "output-balance": word(2000n), governance: word(governance), token0: word(token0), token1: word(token1) };
  const initialResults = requests.map(r => answer(r.id, values[r.id]));
  const round = mooniswapQuoteProgram.buildDependentProgram!({ programInput: i, initialResults, completedRound: 0, priorEvidence: [] });
  assert(round);
  const q = mooniswapQuoteProgram.decode({ programInput: i, initialResults, dependentEvidence: [round.decode([answer("active", word(1n))])] });
  assert.equal(q.amountOut, 164n); assert.notEqual(q.amountOut, 181n);
});

// Offline transport contracts, not a substitute for catalog/coordinator or EVM
// acceptance. Execute real Family requests via the production central issuer;
// only the provider replies are synthetic. No sockets or RPC clients are used.
test("central transport binds raw and dependent governance reads to executor and source", async () => {
  const { descriptor, routes } = setup();
  for (const at of [source, { ...source, number: source.number + 1, generation: 2, hash: `0x${"bc".repeat(32)}` }]) {
    const current = { descriptor, routes, source: at };
    const currentGov = at === source ? governance : replacement;
    const values: Record<string, bigint | string> = { token0, token1, mooniswapFactoryGovernance: currentGov,
      fee: at === source ? 3n * 10n ** 15n : 6n * 10n ** 15n, slippageFee: FEE_DENOMINATOR };
    const seen: string[] = [];
    const runtime = createStrictCentralAdapterRuntime({ executor,
      generationFence: { assertCurrent(generation, requested) { assert.equal(generation, at.generation); assert.deepEqual(requested, at); } },
      provider: {
        async getCode() { throw new Error("unexpected code read"); },
        async getStorage() { throw new Error("unexpected storage read"); },
        async call(request, block) {
          assert.equal(block, at.number); assert.equal(request.from, executor);
          seen.push(request.to.toLowerCase());
          if (request.to.toLowerCase() === currentGov) {
            assert.equal(request.data, GOVERNANCE.encodeFunctionData("isActive")); return word(1n);
          }
          if ([token0, token1].includes(request.to.toLowerCase())) {
            assert.equal(lower(String(TOKEN.decodeFunctionData("balanceOf", request.data)[0])), pool);
            return word(request.to.toLowerCase() === token0 ? 1000n : 2000n);
          }
          assert.equal(request.to.toLowerCase(), pool);
          const parsed = POOL.parseTransaction({ data: request.data }); assert(parsed);
          if (parsed.name === "getBalanceForAddition") return word(lower(String(parsed.args[0])) === token0 ? 1500n : 3000n);
          if (parsed.name === "getBalanceForRemoval") return word(lower(String(parsed.args[0])) === token0 ? 900n : 1200n);
          assert(parsed.name in values, parsed.name); return word(values[parsed.name]);
        },
      },
    });
    const initial = await executeAdapterWork({ runtime, intent: {
      stage: "pricing-current", familyId: MOONISWAP_ID, instanceKey: descriptor.instanceKey,
      source: at, generation: at.generation, programInput: current,
      program: { requirements: mooniswapPricing.current.requirements,
        buildRequests: mooniswapPricing.current.buildRequests, decode: ({ results }) => results },
    } });
    assert.equal(initial.status, "resolved"); if (initial.status !== "resolved") throw new Error(JSON.stringify(initial));
    const initialResults = initial.executed.evidence;
    const round = mooniswapPricing.current.buildDependentProgram({ current, initialResults, completedRound: 0, priorEvidence: [] }); assert(round);
    const dependent = await executeAdapterWork({ runtime, intent: {
      stage: "pricing-current", familyId: MOONISWAP_ID, instanceKey: descriptor.instanceKey,
      source: at, generation: at.generation, programInput: current,
      program: { requirements: () => round.requirements, buildRequests: () => round.requests,
        decode: ({ results }) => round.decode(results) },
    } });
    assert.equal(dependent.status, "resolved"); if (dependent.status !== "resolved") throw new Error(JSON.stringify(dependent));
    const snapshot = mooniswapPricing.current.decodeSnapshot({ descriptor, initialResults, dependentEvidence: [dependent.executed.evidence] });
    assert.equal(seen.length, 12); assert.equal(seen.at(-1), currentGov);
    assert.equal(snapshot.governance, currentGov); assert.deepEqual(snapshot.source, at);
    assert.equal(mooniswapPricing.current.deriveMids({ descriptor, routes, snapshot }).get(routes[0].routeKey)!.mid,
      at === source ? 0.7976 : 0.7952);
  }
});

test("central transport preserves exact requested amount and fails unresolved reads closed", async () => {
  const { descriptor, routes } = setup();
  const input = { descriptor, route: routes[1], source, executor, runtimeEvidence: [], amountIn: 947347012323163156825n };
  for (const mode of ["ok", "revert", "rpc"] as const) {
    let quoteCalls = 0;
    const runtime = createStrictCentralAdapterRuntime({ executor,
      generationFence: { assertCurrent(generation, at) { assert.equal(generation, source.generation); assert.deepEqual(at, source); } },
      provider: {
        async getCode() { throw new Error("unexpected code read"); },
        async getStorage() { throw new Error("unexpected storage read"); },
        async call(request, block) {
          assert.equal(request.from, executor); assert.equal(block, source.number);
          if (request.data.slice(0, 10) === POOL.getFunction("getReturn")!.selector) {
            quoteCalls++;
            const args = POOL.decodeFunctionData("getReturn", request.data);
            assert.equal(args.amount, input.amountIn); assert.equal(lower(String(args.src)), token1); assert.equal(lower(String(args.dst)), token0);
            if (mode === "rpc") throw new Error("synthetic offline provider unavailable");
            if (mode === "revert") throw Object.assign(new Error("synthetic revert"), { code: "CALL_EXCEPTION", data: "0x" });
            return word(458914096390731810847n);
          }
          if (request.data.slice(0, 10) === TOKEN.getFunction("balanceOf")!.selector) return word(10n ** 24n);
          const parsed = POOL.parseTransaction({ data: request.data }); assert(parsed);
          return word(({ token0, token1, mooniswapFactoryGovernance: governance } as Record<string, string>)[parsed.name]);
        },
      },
    });
    const result = await executeAdapterWork({ runtime, intent: {
      stage: "exact-refine", familyId: MOONISWAP_ID, instanceKey: descriptor.instanceKey,
      routeKey: input.route.routeKey, source, generation: source.generation, programInput: input,
      program: { requirements: mooniswapQuoteProgram.requirements,
        buildRequests: mooniswapQuoteProgram.buildRequests, decode: ({ results }) => results },
    } });
    assert.equal(quoteCalls, mode === "rpc" ? 2 : 1, "central bounded retry only for transport failure");
    if (mode === "rpc") { assert.equal(result.status, "unresolved"); continue; }
    assert.equal(result.status, "resolved"); if (result.status !== "resolved") throw new Error(JSON.stringify(result));
    const initialResults = result.executed.evidence;
    const decode = () => mooniswapQuoteProgram.decode({ programInput: input, initialResults,
      dependentEvidence: [{ results: [answer("active", word(1n))] }] });
    if (mode === "revert") assert.throws(decode, /reverted/);
    else assert.equal(decode().amountOut, 458914096390731810847n);
  }
});
