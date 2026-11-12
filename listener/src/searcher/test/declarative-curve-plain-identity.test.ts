import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AbiCoder, Interface, ZeroAddress, getAddress, id, keccak256, toBeHex } from "ethers";
import { createDeclarativeSwapRuntime } from "../venues/declarative-swap.js";

// Synthetic protocol contracts, not fork/live admission evidence. The clone
// fixture supplies observed runtime bytes; responses and effects below are
// deliberately generated test data. Execute the production JSON compiler and
// its simulation materializer, without substituting identity callbacks.
const rootUrl = new URL("../venues/swaps/curve-plain-family/curve-plain.json", import.meta.url);
const load = (url: URL) => JSON.parse(readFileSync(url, "utf8"));
const root = load(rootUrl);
const children = root.variantFiles.map((file: string) => load(new URL(file, rootUrl)));
const family: any = createDeclarativeSwapRuntime(root, children).definition;
const cloneFixture = load(new URL("../venues/swaps/curve-plain-family/test/fixtures/noteusd-clone.json", import.meta.url));
const registryLineage = "curve-plain:registry-direct-coin-behavior";
const cloneLineage = "curve-plain:registry-independent-clone-direct-coin";
const native = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const wrappedNative = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const registryAddress = "0xf98b45fa17de75fb1ad0e7afd971b0ca00e379fc";
const cloneClass = "0x260a286cc14e91f4a2d4a966e2e5f5030543a7d2f090a623f5fa15ba174a50f3";
const address = (n: number) => getAddress(toBeHex(n, 20));
const actor = address(0x707), pool = address(0x808), handler = address(0x909);
const baseCoins = [address(0x101), address(0x102)];
const source = { number: 200, hash: id("curve-identity-contract-source"), generation: 1 };
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const graphToken = (coin: string) => same(coin, native) ? wrappedNative : coin;
const word = (n: bigint) => AbiCoder.defaultAbiCoder().encode(["uint256"], [n]);
const addressWord = (value: string) => AbiCoder.defaultAbiCoder().encode(["address"], [value]);
const registryAbi = new Interface([
  "function get_registry_handlers_from_pool(address) view returns(address[10])",
  "function get_coins(address) view returns(address[8])",
]);
const poolAbi = new Interface([
  "function coins(uint256) view returns(address)", "function balances(uint256) view returns(uint256)",
  "function coins(int128) view returns(address)", "function balances(int128) view returns(uint256)",
]);
const tokenAbi = new Interface(["function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)"]);
const returned = (request: any, data: string, effects?: any): any => ({ id: request.id, ok: true, source,
  completion: "returned", data, provenance: { kind: "synthetic-unit-test", fingerprint: "not-chain-admission" },
  ...(effects ? { effects } : {}) });
const reverted = (request: any): any => ({ ...returned(request, "0x"), completion: "reverted-as-declared" });
const failed = (request: any): any => ({ id: request.id, ok: false, source, failure: "rpc" });
type Options = { coins?: string[]; getterAbi?: "int128" | "uint256"; executionMode?: string };

function fixture(kind: "registry" | "clone" = "registry", options: Options = {}) {
  const variant = family.identity.variants.find((entry: any) => entry.lineageId === (kind === "registry" ? registryLineage : cloneLineage));
  assert(variant, `registered ${kind} identity variant`);
  const coins = options.coins ?? (kind === "clone" ? cloneFixture.coins : baseCoins);
  const target = kind === "clone" ? cloneFixture.pool : pool;
  const candidate = { candidateKind: "curve-plain-pool", pool: target, hintedI: null, hintedJ: null };
  const answer = (request: any): any => {
    if (request.id === "probe-executor") {
      assert.equal(request.kind, "effect-delta-simulation");
      assert.equal(request.call.executionMode, "impersonated-call-frame");
      assert(same(request.call.to, wrappedNative));
      assert.deepEqual([...tokenAbi.decodeFunctionData("balanceOf", request.call.data)], [ZeroAddress]);
      assert.deepEqual(request.call.caller, { kind: "executor" });
      return returned(request, word(0n), { tokenDeltas: [{ token: wrappedNative, account: actor, delta: 0n }],
        nativeDeltas: [{ account: actor, delta: 0n }] });
    }
    if (request.kind === "get-code") {
      if (kind === "clone" && same(request.address, cloneFixture.implementation)) return returned(request, cloneFixture.implementationCode);
      return returned(request, kind === "clone" && same(request.address, target) ? cloneFixture.proxyRuntime : "0x6000");
    }
    if (request.kind === "eth-call") {
      assert.equal(request.completion, "return-or-revert-data");
      if (same(request.to, registryAddress)) {
        const call = registryAbi.parseTransaction({ data: request.data }); assert(call);
        assert(same(String(call.args[0]), target));
        const entries = call.name === "get_registry_handlers_from_pool"
          ? [handler, ...Array(9).fill(ZeroAddress)] : [...coins, ...Array(8 - coins.length).fill(ZeroAddress)];
        return returned(request, registryAbi.encodeFunctionResult(call.fragment, [entries]));
      }
      if (same(request.to, target)) {
        const call = poolAbi.parseTransaction({ data: request.data }); assert(call, "identity must use a direct coin/balance getter");
        if (call.fragment.inputs[0].type !== (kind === "clone" ? "uint256" : options.getterAbi ?? "uint256")) return reverted(request);
        const position = Number(call.args[0]);
        assert(Number.isSafeInteger(position) && position >= 0 && position < 8);
        return returned(request, call.name === "coins" ? addressWord(coins[position] ?? ZeroAddress) : word(10n ** 24n));
      }
      assert(coins.some((coin: string) => same(coin, request.to)), "token reads remain in the bound direct-coin set");
      assert.equal(tokenAbi.parseTransaction({ data: request.data })?.name, "decimals");
      return returned(request, word(18n));
    }
    assert.equal(request.kind, "effect-delta-simulation");
    assert.equal(request.call.executionMode, "executor-program");
    assert(same(request.call.to, actor));
    assert.deepEqual(request.call.caller, { kind: "executor" });
    assert.equal(request.overrideIntent.tokenBalances.length, 1);
    const [, left, right, mode] = request.id.split(":");
    const i = Number(left), j = Number(right);
    const isNative = [coins[i], coins[j]].some(coin => same(coin, native));
    if (mode !== (isNative ? "native-exchange" : options.executionMode ?? "exchange")) return reverted(request);
    const tokenIn = graphToken(coins[i]), tokenOut = graphToken(coins[j]);
    const amount = request.overrideIntent.tokenBalances[0].amount;
    assert(same(request.overrideIntent.tokenBalances[0].token, tokenIn));
    assert.deepEqual(new Set(request.observeTokenBalances.map((row: any) => row.token.toLowerCase())),
      new Set(coins.map((coin: string) => graphToken(coin).toLowerCase())));
    return returned(request, "0x", {
      tokenDeltas: request.observeTokenBalances.map((row: any) => ({ token: row.token, account: actor,
        delta: same(row.token, tokenIn) ? -amount : same(row.token, tokenOut) ? amount * 2n : 0n })),
      nativeDeltas: [{ account: actor, delta: 0n }],
    });
  };
  const rounds: { step: any; requests: any[]; results: any[] }[] = [];
  let evidence: any;
  for (let index = 0; index < 3; index++) {
    const step = { candidate, step: index, ...(evidence ? { evidence } : {}) };
    const requests = variant.buildRequests(step), results = requests.map(answer);
    rounds.push({ step, requests, results });
    evidence = variant.decode({ step, results });
  }
  const decision = variant.decide({ candidate, step: 3, evidence });
  return { variant, candidate, coins, evidence, rounds, answer, decision };
}
function changedRound(f: ReturnType<typeof fixture>, index: number) { return structuredClone(f.rounds[index]); }
function decode(f: ReturnType<typeof fixture>, round: ReturnType<typeof changedRound>) {
  return f.variant.decode({ step: round.step, results: round.results });
}
function admittedRoutes(f: ReturnType<typeof fixture>, evidence = f.evidence) {
  const decision = f.variant.decide({ candidate: f.candidate, step: 3, evidence }); assert.equal(decision.status, "verified");
  const draft = family.instance.compileDraft(decision.identity);
  const descriptor = family.instance.finalizeDescriptor({ identity: decision.identity, draft, sharedBindings: [] });
  return family.routes.project({ descriptor });
}

for (const options of [{}, { getterAbi: "int128", executionMode: "exchange-uint" }] as Options[]) {
  test(`[family=curve-plain] registry identity independently proves ${options.getterAbi ?? "uint256"} getters and ${options.executionMode ?? "exchange"} execution`, () => {
    const f = fixture("registry", options);
    assert.equal(f.decision.status, "verified");
    assert.deepEqual(f.rounds.map(round => round.requests.length), [3, 13, 10]);
    assert.equal(f.evidence.binding.coinAbi, options.getterAbi ?? "uint256");
    assert.equal(f.evidence.binding.balanceAbi, options.getterAbi ?? "uint256");
    assert(!Object.hasOwn(f.evidence.binding, "quoteAbi"), "an execution receipt does not prove a get_dy ABI");
    assert(f.evidence.directions.every((direction: any) => direction.amountOut === direction.amountIn * 2n));
    const routes = admittedRoutes(f); assert.equal(routes.length, 2);
    assert(routes.every((route: any) => route.executionMode === (options.executionMode ?? "exchange")));
  });
}

test("[family=curve-plain] native identity uses the central boundary and keeps WETH graph assets", () => {
  const f = fixture("registry", { coins: [native, baseCoins[1]] });
  assert.equal(f.decision.status, "verified");
  assert.deepEqual(f.rounds.map(round => round.requests.length), [3, 11, 4]);
  assert(f.rounds[2].requests.every(request => request.executionAssetBoundary));
  const routes = admittedRoutes(f); assert.equal(routes.length, 2);
  assert(routes.every((route: any) => same(route.tokenIn, wrappedNative) || same(route.tokenOut, wrappedNative)));
  assert.deepEqual(routes.map((route: any) => route.executionAssets), [
    { input: "native", output: "erc20" }, { input: "erc20", output: "native" },
  ]);
});

test("[family=curve-plain] the observed 51-byte clone class reaches real program receipt validation", () => {
  assert.equal((cloneFixture.proxyRuntime.length - 2) / 2, 51);
  assert.equal(keccak256(cloneFixture.proxyRuntime), cloneFixture.proxyCodeHash);
  assert.equal(keccak256(cloneFixture.implementationCode), cloneClass);
  const f = fixture("clone");
  assert.equal(f.decision.status, "verified", f.decision.reasonCode);
  assert.deepEqual(f.rounds.map(round => round.requests.length), [6, 6, 2]);
  assert(same(f.evidence.binding.registry, cloneFixture.implementation));
  assert.equal(f.evidence.binding.implementationCodeHash, cloneClass);
  assert.equal(f.decision.identity.lineageId, cloneLineage);
  assert.equal(admittedRoutes(f).length, 2);
});

test("[family=curve-plain] eight direct coins remain within three bounded identity rounds", () => {
  const coins = Array.from({ length: 8 }, (_, index) => address(0x200 + index));
  const f = fixture("registry", { coins });
  assert.equal(f.decision.status, "verified");
  assert.deepEqual(f.rounds.map(round => round.requests.length), [3, 49, 280]);
  assert.equal(new Set(f.rounds[2].requests.map(request => request.id)).size, 280);
  assert.equal(f.evidence.directions.length, 56);
  assert.equal(admittedRoutes(f).length, 56);
});

test("[family=curve-plain] zero-delta actor authority rejects changed balances and foreign accounts", () => {
  const f = fixture();
  for (const mutate of [
    (row: any) => { row.effects.tokenDeltas[0].delta = 1n; },
    (row: any) => { row.effects.nativeDeltas[0].delta = -1n; },
    (row: any) => { row.effects.nativeDeltas[0].account = baseCoins[0]; },
    (row: any) => { row.effects.tokenDeltas[0].account = row.effects.nativeDeltas[0].account = ZeroAddress; },
    (row: any) => { row.effects.tokenDeltas[0].account = row.effects.nativeDeltas[0].account = pool; },
  ]) {
    const round = changedRound(f, 1); mutate(round.results.find(row => row.id === "probe-executor"));
    assert.throws(() => decode(f, round), /executor authority/);
  }
});

test("[family=curve-plain] every identity round binds number, hash, generation and result coverage", () => {
  const f = fixture();
  for (const index of [0, 1, 2]) for (const replacement of [
    { ...source, number: source.number + 1 }, { ...source, hash: id("foreign-source") }, { ...source, generation: 2 },
  ]) {
    const round = changedRound(f, index); round.results[0].source = replacement;
    assert.throws(() => decode(f, round), /source/);
  }
  for (const mutate of [
    (round: any) => { round.results.pop(); },
    (round: any) => { round.results[1] = round.results[0]; },
    (round: any) => { round.results[0].id = "foreign-read"; },
  ]) {
    const round = changedRound(f, 1); mutate(round);
    assert.throws(() => decode(f, round), /result|duplicate|coverage/);
  }
});

test("[family=curve-plain] unknown alternatives never become deterministic unsupported directions", () => {
  const f = fixture();
  const surface = changedRound(f, 1); surface.results[0] = failed(surface.requests[0]);
  assert.throws(() => decode(f, surface), /required adapter request/);
  const unresolved = changedRound(f, 2); unresolved.results = unresolved.requests.map(reverted);
  const index = unresolved.requests.findIndex(request => request.id === "execution:0:1:exchange");
  unresolved.results[index] = failed(unresolved.requests[index]);
  assert.throws(() => decode(f, unresolved), /required adapter request/);
  const alternative = changedRound(f, 2);
  const optionalIndex = alternative.requests.findIndex(request => request.id === "execution:0:1:received");
  alternative.results[optionalIndex] = failed(alternative.requests[optionalIndex]);
  assert.equal(decode(f, alternative).directions.length, 2, "a complete proved mode can cover an unavailable alternative");
  const allReverted = changedRound(f, 2); allReverted.results = allReverted.requests.map(reverted);
  const evidence = decode(f, allReverted);
  assert.equal(f.variant.decide({ candidate: f.candidate, step: 3, evidence }).status, "retryable");
});

test("[family=curve-plain] successful receipt data cannot conceal a wrong debit, recipient or extra inventory change", () => {
  const f = fixture("registry", { coins: [...baseCoins, address(0x103)] });
  for (const mutate of [
    (row: any) => { row.effects.tokenDeltas.find((delta: any) => delta.delta < 0n).delta += 1n; },
    (row: any) => { row.effects.tokenDeltas.find((delta: any) => delta.delta > 0n).account = pool; },
    (row: any) => { row.effects.tokenDeltas.find((delta: any) => delta.delta === 0n).delta = -1n; },
    (row: any) => { row.effects.nativeDeltas[0].delta = -1n; },
    (row: any) => { row.data = word(123n); },
  ]) {
    const round = changedRound(f, 2); mutate(round.results.find(row => row.id === "execution:0:1:exchange"));
    assert.throws(() => decode(f, round));
  }
});

test("[family=curve-plain] registry membership, canonical arrays and independent getter answers remain required", () => {
  const f = fixture();
  const noHandler = changedRound(f, 0);
  noHandler.results.find(row => row.id === "registry-handlers").data = registryAbi.encodeFunctionResult("get_registry_handlers_from_pool", [Array(10).fill(ZeroAddress)]);
  const evidence = decode(f, noHandler);
  assert.equal(f.variant.decide({ candidate: f.candidate, step: 1, evidence }).status, "chain-proven-rejected");
  const padded = changedRound(f, 0);
  padded.results.find(row => row.id === "registry-coins").data = registryAbi.encodeFunctionResult("get_coins", [[baseCoins[0], ZeroAddress, baseCoins[1], ...Array(5).fill(ZeroAddress)]]);
  assert.throws(() => decode(f, padded), /noncontiguous/);
  const conflict = changedRound(f, 1);
  const position = conflict.requests.findIndex(request => request.id === "coin:int128:0");
  conflict.results[position] = returned(conflict.requests[position], addressWord(baseCoins[1]));
  assert.throws(() => decode(f, conflict), /getter aliases disagree/);
  const scale = changedRound(f, 1); scale.results.find(row => row.id === "decimals:0").data = word(37n);
  assert.throws(() => decode(f, scale), /decimal scale/);
});

test("[family=curve-plain] clone class and exactly two direct ERC20 coins cannot be supplied by a candidate", () => {
  const f = fixture("clone");
  const implementation = changedRound(f, 1); implementation.results.find(row => row.id === "implementation-code").data += "00";
  const evidence = decode(f, implementation);
  assert.equal(f.variant.decide({ candidate: f.candidate, step: 2, evidence }).status, "chain-proven-rejected");
  const runtime = changedRound(f, 0); runtime.results.find(row => row.id === "pool-code").data += "00";
  const runtimeEvidence = decode(f, runtime);
  assert.equal(f.variant.decide({ candidate: f.candidate, step: 1, evidence: runtimeEvidence }).status, "chain-proven-rejected");
  const thirdCoin = changedRound(f, 0); thirdCoin.results.find(row => row.id === "clone-coin:2").data = addressWord(baseCoins[0]);
  assert.throws(() => decode(f, thirdCoin), /third coin/);
});

test("[family=curve-plain] only proved directions project routes and an unproved observed direction remains retryable", () => {
  const f = fixture();
  const round = changedRound(f, 2);
  round.results = round.results.map((row, index) => row.id.startsWith("execution:1:0:") ? reverted(round.requests[index]) : row);
  const evidence = decode(f, round);
  assert.equal(evidence.directions.length, 1);
  const routes = admittedRoutes(f, evidence); assert.equal(routes.length, 1);
  assert.equal(routes[0].i, 0); assert.equal(routes[0].j, 1);
  assert.equal(f.variant.decide({ candidate: { ...f.candidate, hintedI: 1, hintedJ: 0 }, step: 3, evidence }).status, "retryable");
});

test("[family=curve-plain] canonical bounded swap logs nominate candidates without granting identity", () => {
  const abi = new Interface(["event TokenExchange(address indexed buyer,int128 soldId,uint256 tokensSold,int128 boughtId,uint256 tokensBought)"]);
  const encode = (i: number, j: number, input = 11n, output = 22n) => ({ kind: "log", source, address: pool,
    ...abi.encodeEventLog(abi.fragments[0], [actor, i, input, j, output]) });
  const observation = encode(0, 1);
  const candidate = family.discovery.decodeCandidate({ observation, matchedPatternId: "curve-plain-int128-swap" });
  assert.deepEqual(candidate, { candidateKind: "curve-plain-pool", pool, hintedI: 0, hintedJ: 1 });
  for (const malformed of [encode(-1, 1), encode(0, 8), encode(0, 0), encode(0, 1, 0n),
    { ...observation, data: observation.data + "00" }])
    assert.equal(family.discovery.decodeCandidate({ observation: malformed, matchedPatternId: "curve-plain-int128-swap" }), null);
  const variant = family.identity.variants.find((entry: any) => entry.lineageId === registryLineage);
  assert.equal(variant.decide({ candidate, step: 0 }).status, "continue");
  assert(variant.buildRequests({ candidate, step: 0 }).length > 0);
});
