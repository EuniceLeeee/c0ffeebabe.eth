import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/balancer-v3.production.js";
import { definedFamilyPluginContractSummary, type IdentityDecision } from "../../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import type { ResolvedPlanNode } from "../../../../../types.js";
import { VAULT, ROUTER, PERMIT2, PERMIT2_ABI, MAX_INPUT, MAX_EXPIRATION, VAULT_ABI, POOL_ABI, TOKEN_ABI, ROUTER_ABI, SWAP_ABI, MAX_UINT,
  addressWord, bool, call, lower, hooksConfig, poolInfo, probeAmounts, queryData, uint } from "../codec.js";
import { CALL_ID, LOG_ID, SURFACE_ID, SURFACE, SWAP_TOPIC, decodeSwapLog } from "../discovery.js";
import { reverseBindBalancerV3, nominateBalancerV3 } from "../nomination.js";
import { balancerV3ReceiptObservation } from "../swap.js";
import type { BalancerV3Candidate, BalancerV3Identity } from "../types.js";

// The sample comes from the existing historical fixture. RPC/state answers in
// this contract are synthetic; historical provenance is checked separately.
const historical = JSON.parse(readFileSync(new URL("../../../../test/fixtures/loops/rocksolid-balancer-v3-7ce631.json", import.meta.url), "utf8"));
const leg = historical.legs.find((item: { kind: string }) => item.kind === "balancer-v3");
const POOL = ethers.getAddress(leg.pool);
const TOKENS = [leg.tokenIn, leg.tokenOut].map(ethers.getAddress);
const EXTRA = ethers.getAddress("0x0000000000000000000000000000000000000033");
const EXECUTOR = ethers.getAddress("0x1000000000000000000000000000000000000002");
const FOREIGN = ethers.getAddress("0x1000000000000000000000000000000000000003");
const SOURCE: CanonicalSource = { number: historical.executionBlock, hash: `0x${"ab".repeat(32)}`, generation: 1 };
const word = (value: bigint) => ethers.toBeHex(value, 32);
const hooks = (index = -1) => VAULT_ABI.encodeFunctionResult("getHooksConfig", [[
  ...Array.from({ length: 10 }, (_, i) => i === index), index < 0 ? ethers.ZeroAddress : FOREIGN,
]]);
const candidate = (pool = POOL): BalancerV3Candidate => ({ candidateKind: "balancer-v3-pool", pool, hintedTokenIn: null, hintedTokenOut: null });
function success(id: string, data: string): Extract<AdapterRequestResult, { ok: true }> {
  return { id, ok: true, completion: "returned", data, source: SOURCE,
    provenance: { kind: "fixture", fingerprint: "balancer-v3-local-contract" } };
}
function fixture(tokens = TOKENS, decimals = tokens.map(() => 18), pool = POOL) {
  const balances = decimals.map(d => 10n ** BigInt(d) * 1000000n);
  const tokenInfo = tokens.map(() => [0, ethers.ZeroAddress, false]);
  const info = () => VAULT_ABI.encodeFunctionResult("getPoolTokenInfo", [tokens, tokenInfo, balances, balances]);
  const quotes: bigint[] = [];
  const answer = (request: AdapterRequest): AdapterRequestResult => {
    if (request.kind === "get-code") return success(request.id, "0x60006000");
    assert.equal(request.kind, "eth-call");
    if (request.kind !== "eth-call") throw new Error("unexpected request");
    if (request.data === POOL_ABI.encodeFunctionData("getVault")) {
      assert.equal(lower(request.to), lower(pool));
      return success(request.id, POOL_ABI.encodeFunctionResult("getVault", [VAULT]));
    }
    if (request.data === TOKEN_ABI.encodeFunctionData("decimals")) {
      return success(request.id, word(BigInt(decimals[tokens.map(lower).indexOf(lower(request.to))])));
    }
    if (lower(request.to) === lower(VAULT)) {
      const parsed = VAULT_ABI.parseTransaction({ data: request.data })!;
      assert.equal(lower(String(parsed.args[0])), lower(pool));
      return success(request.id, parsed.name === "isPoolRegistered" ? word(1n) : parsed.name === "getHooksConfig" ? hooks() : info());
    }
    assert.equal(lower(request.to), lower(ROUTER));
    if (request.id === "router-permit2") return success(request.id, ROUTER_ABI.encodeFunctionResult("getPermit2", [PERMIT2]));
    const args = ROUTER_ABI.decodeFunctionData("querySwapSingleTokenExactIn", request.data);
    assert.equal(lower(String(args[0])), lower(pool)); assert.equal(args[5], "0x");
    const i = tokens.map(lower).indexOf(lower(String(args[1]))), j = tokens.map(lower).indexOf(lower(String(args[2])));
    assert(i >= 0 && j >= 0 && i !== j);
    const amount = BigInt(args[3]); quotes.push(amount);
    const out = amount * balances[j] * 9999n / ((balances[i] + amount) * 10000n);
    return success(request.id, word(out));
  };
  return { answer, balances, info, quotes };
}
function identityDecision(answer = fixture().answer, c = candidate()): IdentityDecision<BalancerV3Identity> {
  const variant = plugin.identity.variants[0];
  let evidence: unknown;
  for (let step = 0; step < 4; step++) {
    const input = { candidate: c, step, ...(evidence === undefined ? {} : { evidence }) };
    const decision = variant.decide(input);
    if (decision.status !== "continue") return decision;
    const requests = variant.buildRequests(input);
    assert(requests.length > 0);
    evidence = variant.decode({ step: input, results: requests.map(answer) });
  }
  throw new Error("identity exceeded four-step contract");
}
function setup(f = fixture(), c = candidate()) {
  const decision = identityDecision(f.answer, c);
  assert.equal(decision.status, "verified");
  if (decision.status !== "verified") throw new Error("not verified");
  const identity = decision.identity;
  const descriptor = plugin.instance.finalizeDescriptor({ identity, draft: plugin.instance.compileDraft(identity), sharedBindings: [] });
  const routes = plugin.routes.project({ descriptor });
  return { identity, descriptor, routes, f };
}
function exact(at = setup(), amountIn = 653072044530122959n) {
  const input = { descriptor: at.descriptor, route: at.routes[0], amountIn, source: SOURCE, executor: EXECUTOR, runtimeEvidence: [] };
  const method = plugin.exact.methods(input)[1];
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") throw new Error("no chain quote");
  const requests = method.program.buildRequests(input);
  const results = requests.map(at.f.answer);
  const quote = method.program.decode({ programInput: input, initialResults: results, dependentEvidence: [] });
  return { input, method, requests, results, quote };
}
function currentPricing(s = setup(), route = s.routes[0]) {
  const draft = plugin.pricing.compileDraft({ descriptor: s.descriptor, routes: [route], stateKey: route.routeKey });
  const descriptor = plugin.pricing.finalizePricingDescriptor({ draft, sharedBindings: [] });
  const current = { descriptor, routes: [route], source: SOURCE };
  const initialResults = plugin.pricing.current.buildRequests(current).map(s.f.answer);
  const program = (completedRound: number, priorEvidence: readonly unknown[]) =>
    plugin.pricing.current.buildDependentProgram!({ current, completedRound, initialResults, priorEvidence });
  const decode = (dependentEvidence: readonly unknown[]) =>
    plugin.pricing.current.decodeSnapshot({ descriptor, initialResults, dependentEvidence });
  const run = (answer = s.f.answer) => {
    const evidence: unknown[] = [], batches: (readonly AdapterRequest[])[] = [];
    for (let round = 0; round <= 2; round++) {
      const next = program(round, evidence);
      if (next === null) return { snapshot: decode(evidence), batches };
      assert(round < 2, "pricing must use at most two dependent rounds");
      batches.push(next.requests);
      evidence.push(next.decode(next.requests.map(answer)));
    }
    throw new Error("pricing exceeded two dependent rounds");
  };
  const amounts = probeAmounts(s.descriptor.binding.decimals[route.i], s.f.balances[route.i]);
  const eagerRequests = amounts.map((amount, i) => ({
    ...call(`current-quote:${i}`, ROUTER, queryData(route.pool, route.tokenIn, route.tokenOut, amount, ethers.ZeroAddress)),
    required: false,
  }));
  return { descriptor, route, program, decode, run, amounts, eagerRequests };
}
function log(pool = POOL) {
  const encoded = SWAP_ABI.encodeEventLog(SWAP_ABI.getEvent("Swap")!, [pool, ...TOKENS,
    BigInt(leg.realized.amountIn), BigInt(leg.realized.amountOut), 100000000000000n, 100n]);
  return { kind: "log" as const, address: VAULT, ...encoded, source: SOURCE, transactionHash: historical.txHash };
}

test("historical transaction anchor is existing public evidence, never an admission list", () => {
  assert.equal(historical.txHash, "0x7ce631b94570e8ebcaea60e93ccfb808327087405e6f0561450d4bb7f69b3c87");
  assert.equal(historical.executionBlock, 25535037); assert.equal(historical.txIndex, 65);
  assert.equal(leg.realized.amountIn, "653072044530122959"); assert.equal(leg.realized.amountOut, "665967421909204163");
  const arbitrary = setup(fixture(TOKENS, [18, 18], FOREIGN), candidate(FOREIGN));
  assert.equal(arbitrary.identity.subject, FOREIGN);
});
test("reverse identity and source proof preserve every multi-token direction", () => {
  for (let n = 2; n <= 8; n++) {
    const tokens = [...TOKENS, ...Array.from({ length: n - 2 }, (_, i) => ethers.toBeHex(i + 30, 20))];
    const s = setup(fixture(tokens, tokens.map((_, i) => i === 2 ? 6 : 18)));
    assert.equal(s.routes.length, n * (n - 1));
    assert.equal(new Set(s.routes.map(r => r.routeKey)).size, n * (n - 1));
    assert.deepEqual(s.identity.facts.proofSource, SOURCE);
    assert.equal(s.identity.provenance[0].subject, VAULT);
    assert(s.routes.every(r => r.bindingRef.fingerprint === s.routes[0].bindingRef.fingerprint));
    for (const route of s.routes) assert.equal(plugin.routes.projectGraph({ descriptor: s.descriptor, route }).executionTarget, POOL);
  }
  const answer = fixture().answer;
  const other = identityDecision(req => ({ ...answer(req), source: { ...SOURCE, hash: `0x${"cd".repeat(32)}` } }));
  assert(other.status === "verified");
  assert.notEqual(other.identity.provenance[0].evidenceHash, setup().identity.provenance[0].evidenceHash);
});
test("Vault indexed discovery rejects foreign emitters, malformed padding/data, selector and token tampering", () => {
  const observation = log();
  const decode = (value = observation) => plugin.discovery.decodeCandidate({ observation: value, matchedPatternId: LOG_ID });
  assert.equal(decode()!.pool, POOL);
  assert.equal(decode({ ...observation, address: FOREIGN }), null);
  assert.equal(decode({ ...observation, topics: [ethers.ZeroHash, ...observation.topics.slice(1)] }), null);
  assert.equal(decode({ ...observation, topics: [...observation.topics, ethers.ZeroHash] }), null);
  assert.equal(decode({ ...observation, topics: [SWAP_TOPIC, `0x01${observation.topics[1].slice(4)}`, ...observation.topics.slice(2)] }), null);
  assert.equal(decode({ ...observation, data: `${observation.data}00` }), null);
  assert.equal(decode({ ...observation, topics: [SWAP_TOPIC, observation.topics[1], observation.topics[2], observation.topics[2]] }), null);
  const data = SWAP_ABI.encodeFunctionData("swap", [[0, POOL, ...TOKENS, 1n, 0n, "0x"]]);
  const call = (payload: string, target = VAULT) => plugin.discovery.decodeCandidate({
    observation: { kind: "call", source: SOURCE, target, data: payload }, matchedPatternId: CALL_ID });
  assert(call(data)); assert.equal(call(data, FOREIGN), null); assert.equal(call(`${data}00`), null);
  assert.equal(call(`0xdeadbeef${data.slice(10)}`), null);
  assert.equal(call(SWAP_ABI.encodeFunctionData("swap", [[2, POOL, ...TOKENS, 1n, 0n, "0x"]])), null);
  assert.equal(plugin.discovery.decodeCandidate({ observation: { kind: "address-surface", source: SOURCE,
    address: POOL, codeHash: ethers.ZeroHash, implementationWord: ethers.ZeroHash }, matchedPatternId: SURFACE_ID }), null);
});
test("no membership and foreign Vault reject; transport, malformed evidence, token hints and mixed source fail closed", () => {
  const answer = fixture().answer;
  for (const [id, data, reason] of [["registered", word(0n), "no-vault-membership"],
    ["pool-vault", POOL_ABI.encodeFunctionResult("getVault", [FOREIGN]), "foreign-vault"],
    ["pool-code", "0x", "no-pool-code"]]) {
    const decision = identityDecision(req => req.id === id ? success(id, data) : answer(req));
    assert.equal(decision.status, "chain-proven-rejected");
    if (decision.status === "chain-proven-rejected") { assert.equal(decision.reasonCode, reason); assert(decision.evidenceRequestIds.includes(id)); }
  }
  assert.throws(() => identityDecision(req => req.id === "registered" ? { id: req.id, ok: false, failure: "rpc", source: SOURCE } : answer(req)), /unresolved/);
  assert.throws(() => identityDecision(req => req.id === "registered" ? success(req.id, word(2n)) : answer(req)), /boolean/);
  assert.throws(() => identityDecision(req => req.id === "tokens" ? { ...answer(req), source: { ...SOURCE, generation: 2 } } : answer(req)), /foreign source/);
  assert.throws(() => identityDecision(answer, { ...candidate(), hintedTokenIn: FOREIGN, hintedTokenOut: TOKENS[1] }), /do not belong/);
  assert.throws(() => identityDecision(req => req.id === "decimals:0" ? success(req.id, word(37n)) : answer(req)), /scale/);
  assert.throws(() => identityDecision(req => req.id === "router-permit2" ? success(req.id, POOL_ABI.encodeFunctionResult("getVault", [FOREIGN])) : answer(req)), /foreign Permit2/);
  assert.throws(() => identityDecision(req => req.id === "permit2-code" ? success(req.id, "0x") : answer(req)), /infrastructure/);
  assert.throws(() => addressWord(`0x01${"00".repeat(31)}`), /noncanonical/);
  assert.throws(() => uint("0x"), /noncanonical/);
  const duplicate = VAULT_ABI.encodeFunctionResult("getPoolTokenInfo", [[TOKENS[0], TOKENS[0]],
    [[0, ethers.ZeroAddress, false], [0, ethers.ZeroAddress, false]], [1, 1], [1, 1]]);
  assert.throws(() => poolInfo(duplicate), /malformed/);
  assert.throws(() => poolInfo(`${fixture().info()}00`), /noncanonical|invalid length/);
});
test("swap hooks remain fail-closed pending query/execution equivalence; non-swap hooks remain supported", () => {
  for (const index of [0, 3, 4, 5]) {
    const decision = identityDecision(req => req.id === "hooks" ? success(req.id, hooks(index)) : fixture().answer(req));
    assert.deepEqual(decision, { status: "retryable", reasonCode: "unsupported-swap-hook-caller-context" });
  }
  const supported = identityDecision(req => req.id === "hooks" ? success(req.id, hooks(7)) : fixture().answer(req));
  assert(supported.status === "verified");
  assert.equal(supported.identity.facts.binding.hooks.codeHash, ethers.keccak256("0x60006000"));
  const s = setup();
  assert.throws(() => plugin.routes.project({ descriptor: { ...s.descriptor, binding: { ...s.descriptor.binding,
    hooks: { ...s.descriptor.binding.hooks, flags: hooksConfig(hooks(3)).flags } } } }), /unsupported-swap-hook/);
  assert(hooksConfig(hooks(7)).flags[7]); assert.throws(() => hooksConfig("0x"));
  assert.throws(() => identityDecision(req => req.id === "hooks" ? success(req.id, hooks(7)) :
    req.id === "hook-code" ? success(req.id, "0x") : fixture().answer(req)), /hook code unavailable/);
  const q = exact();
  assert.throws(() => q.method.program.decode({ programInput: q.input,
    initialResults: [{ ...success("exact-in", ethers.id("HookFailed()").slice(0, 10)), completion: "reverted-as-declared" }], dependentEvidence: [] }), /reverted/);
});
test("actual specified input drives nonlinear exact quotation; zero, overflow, source and route guards", () => {
  const s = setup(), small = exact(s, 1000000000000000000n), large = exact(s, 100000000000000000000000n);
  assert(large.quote.amountOut < small.quote.amountOut * 100000n);
  assert.equal(s.f.quotes.at(-1), large.input.amountIn);
  assert.equal(large.method.chainAmountQuote, true);
  const request = large.requests[0]; assert(request.kind === "eth-call");
  const decoded = ROUTER_ABI.decodeFunctionData("querySwapSingleTokenExactIn", request.data);
  assert.equal(decoded[3], large.input.amountIn); assert.equal(decoded[4], EXECUTOR);
  assert.equal(exact(s, 0n).quote.amountOut, 0n);
  assert.throws(() => exact(s, -1n), /uint160/); assert.throws(() => exact(s, MAX_UINT + 1n), /uint160/);
  const decode = (results: readonly AdapterRequestResult[]) => small.method.program.decode({ programInput: small.input, initialResults: results, dependentEvidence: [] });
  assert.throws(() => decode([{ ...small.results[0], source: { ...SOURCE, hash: ethers.ZeroHash } }]), /foreign source/);
  assert.throws(() => decode([success("exact-in", "0x")]), /noncanonical/);
  assert.throws(() => decode([{ ...success("exact-in", "0x"), completion: "reverted-as-declared" }]), /reverted/);
  assert.throws(() => decode([...small.results, ...small.results]), /count/);
  assert.throws(() => small.method.program.buildRequests({ ...small.input, route: { ...small.input.route, pool: FOREIGN } }), /descriptor/);
  assert.throws(() => small.method.program.buildRequests({ ...small.input, route: { ...small.input.route, tokenOut: EXTRA } }), /descriptor/);
});
test("current pricing sends only the first successful probe with the same snapshot as eager quotes", () => {
  for (const decimals of [6, 18]) {
    const f = fixture(TOKENS, [decimals, decimals]);
    for (let i = 0; i < f.balances.length; i++) f.balances[i] /= 100000n;
    const s = setup(f), p = currentPricing(s);
    assert.equal(p.amounts.length, decimals === 6 ? 6 : 10);
    const { snapshot, batches } = p.run();
    assert.deepEqual(batches.map(batch => batch.map(request => request.id)), [["current-quote:0"]]);
    assert.deepEqual(batches[0], p.eagerRequests.slice(0, 1));
    assert.equal(snapshot.amountIn, p.amounts[0]);
    assert.deepEqual(snapshot, p.decode([{ results: p.eagerRequests.map(s.f.answer) }]));
  }
});
test("current pricing batches remaining probes in original order and chooses the earliest usable output", () => {
  const s = setup(), p = currentPricing(s);
  const firstFailures: AdapterRequestResult[] = [
    { ...success("current-quote:0", "0x"), completion: "reverted-as-declared" },
    { id: "current-quote:0", ok: false, failure: "rpc", source: SOURCE },
    ...[0n, s.f.balances[p.route.j], s.f.balances[p.route.j] + 1n].map(value => success("current-quote:0", word(value))),
  ];
  for (const first of firstFailures) {
    const answer = (request: AdapterRequest): AdapterRequestResult => request.id === first.id ? first :
      success(request.id, word(BigInt(request.id.split(":")[1])));
    const { snapshot, batches } = p.run(answer);
    assert.deepEqual(batches, [p.eagerRequests.slice(0, 1), p.eagerRequests.slice(1)]);
    assert.equal(snapshot.amountIn, p.amounts[1]); assert.equal(snapshot.amountOut, 1n);
    assert.deepEqual(snapshot, p.decode([{ results: p.eagerRequests.map(answer) }]));
  }
});
test("current pricing retries minimum trade amounts without relabelling failed probes unavailable", () => {
  const s = setup(fixture([...TOKENS, EXTRA], [18, 18, 6]));
  const p = currentPricing(s, s.routes.find(r => r.i === 2 && r.j === 0)!);
  const { descriptor, route } = p;
  const minimum = 10000000n;
  const answer = (request: AdapterRequest): AdapterRequestResult => {
    assert(request.kind === "eth-call");
    const amount = BigInt(ROUTER_ABI.decodeFunctionData("querySwapSingleTokenExactIn", request.data)[3]);
    return amount < minimum ? { ...success(request.id, "0x"), completion: "reverted-as-declared" } : s.f.answer(request);
  };
  const { snapshot, batches } = p.run(answer);
  assert.equal(snapshot.amountIn, p.amounts.find(amount => amount >= minimum));
  assert.deepEqual(batches, [p.eagerRequests.slice(0, 1), p.eagerRequests.slice(1)]);
  assert.deepEqual(snapshot, p.decode([{ results: p.eagerRequests.map(answer) }]));
  const mid = plugin.pricing.current.deriveMids({ descriptor, routes: [route], snapshot }).get(route.routeKey)!;
  assert.equal(mid.mid, Number(snapshot.amountOut) / Number(snapshot.amountIn)); assert.equal(mid.feeBps, 0);
  assert.equal(mid.reserveA, s.f.balances[2]); assert.equal(mid.reserveB, s.f.balances[0]);
  for (const completion of ["returned", "reverted-as-declared"] as const) {
    const requested: string[] = [];
    assert.throws(() => p.run(request => {
      requested.push(request.id); return { ...success(request.id, word(0n)), completion };
    }), /unresolved/);
    assert.deepEqual(requested, p.eagerRequests.map(request => request.id));
  }
  assert.throws(() => probeAmounts(37, 1n), /scale/); assert.throws(() => probeAmounts(18, 0n), /liquidity/);
  assert(probeAmounts(18, 1n).includes(1n)); assert(probeAmounts(6, 1000000000n).includes(1000000n));
});
test("current pricing rejects malformed, missing, duplicate and foreign first probes before fallback", () => {
  const p = currentPricing();
  for (const [result, error] of [[success("current-quote:0", "0x"), /noncanonical/],
    [{ ...success("current-quote:0", word(0n)), source: { ...SOURCE, number: SOURCE.number + 1 } }, /foreign source/]] as const) {
    const requested: string[] = [];
    assert.throws(() => p.run(request => { requested.push(request.id); return result; }), error);
    assert.deepEqual(requested, ["current-quote:0"]);
  }
  const first = success("current-quote:0", word(0n));
  assert.throws(() => p.program(1, [{ results: [] }]), /missing\/duplicate/);
  assert.throws(() => p.program(1, [{ results: [first, first] }]), /missing\/duplicate/);
  assert.throws(() => p.run(request => ({ ...success(request.id, word(0n)),
    source: request.id === "current-quote:1" ? { ...SOURCE, hash: ethers.ZeroHash } : SOURCE })), /foreign source/);
});
test("execution encodes exact limited approvals, Router dynamic settlement and cleanup", () => {
  const q = exact();
  const input = { ...q.input, quotedAmountOut: q.quote.amountOut, minAmountOut: q.quote.amountOut - 7n, exactEvidence: q.quote.evidence };
  const fragment = plugin.execution.buildFragment(input); assert.deepEqual(fragment.requirements, []);
  const root = fragment.nodes[0]; assert.equal(root.target, ROUTER); assert.equal(root.children.length, 0);
  const owner = plugin.actionAdapters[0];
  const compile = (node: ResolvedPlanNode) => owner.encode(node, EXECUTOR, new Uint8Array());
  const bytes = compile(root);
  const calls: { target: string; data: string }[] = [];
  for (let offset = 0; offset < bytes.length;) {
    assert.equal(bytes[offset], 0);
    const length = (bytes[offset + 21] << 16) | (bytes[offset + 22] << 8) | bytes[offset + 23];
    calls.push({ target: ethers.hexlify(bytes.slice(offset + 1, offset + 21)), data: ethers.hexlify(bytes.slice(offset + 24, offset + 24 + length)) });
    offset += 24 + length;
  }
  assert.deepEqual(calls.map(c => c.target), [TOKENS[0], TOKENS[0], PERMIT2, ROUTER, PERMIT2, TOKENS[0]].map(lower));
  const erc20 = new ethers.Interface(["function approve(address,uint256)"]);
  for (const [i, amount] of [[0, 0n], [1, q.input.amountIn], [5, 0n]] as const) {
    const approval = erc20.decodeFunctionData("approve", calls[i].data);
    assert.equal(approval[0], PERMIT2); assert.equal(approval[1], amount);
  }
  for (const [i, amount] of [[2, q.input.amountIn], [4, 0n]] as const) {
    const approval = PERMIT2_ABI.decodeFunctionData("approve", calls[i].data);
    assert.equal(approval[0], TOKENS[0]); assert.equal(approval[1], ROUTER); assert.equal(approval[2], amount);
    assert.equal(approval[3], amount === 0n ? 0n : MAX_EXPIRATION);
  }
  const swap = ROUTER_ABI.decodeFunctionData("swapSingleTokenExactIn", calls[3].data);
  assert.deepEqual([...swap], [POOL, ...TOKENS, q.input.amountIn, input.minAmountOut, MAX_UINT, false, "0x"]);
  assert(!calls.some(call => call.data.startsWith("0xae639329")), "there must be no quote-fixed sendTo");
  // Raw output is evidence, not execution calldata: a changed quote with the
  // same input/minimum must compile identically; Router settles the actual output.
  const changed = plugin.execution.buildFragment({ ...input, quotedAmountOut: q.quote.amountOut + 100n,
    exactEvidence: { ...q.quote.evidence, amountOut: q.quote.amountOut + 100n } });
  assert.deepEqual(compile(changed.nodes[0]), bytes);
  for (const patch of [{ amountIn: q.input.amountIn + 1n }, { quotedAmountOut: q.quote.amountOut - 1n },
    { minAmountOut: q.quote.amountOut + 1n }, { executor: FOREIGN }]) assert.throws(() => plugin.execution.buildFragment({ ...input, ...patch }), /incompatible/);
  for (const patch of [{ target: FOREIGN }, { amount: MAX_INPUT + 1n }, { amount: 0n }, { tokenOut: root.tokenIn },
    { params: { ...root.params, minAmountOut: -1n } }, { params: { ...root.params, minAmountOut: MAX_UINT + 1n } },
    { children: [root] }]) assert.throws(() => compile({ ...root, ...patch }), /Router swap/);
  const selector = ROUTER_ABI.getFunction("swapSingleTokenExactIn")!.selector;
  assert(owner.matchTrace(ROUTER, selector)); assert(!owner.matchTrace(FOREIGN, selector)); assert(!owner.matchTrace(VAULT, "0x48c89491"));
  assert.throws(() => exact(setup(), MAX_INPUT + 1n), /uint160/);
});
test("reverse nomination is source-bounded and cannot replace independent identity", async () => {
  const blocks: number[] = [];
  const provider = { getCode: async (_: string, block?: number) => { blocks.push(block!); return "0x6000"; },
    call: async (req: { to: string; data: string }, block?: number) => {
      blocks.push(block!); return lower(req.to) === lower(VAULT) ? word(1n) : POOL_ABI.encodeFunctionResult("getVault", [VAULT]);
    }, getTransactionReceipt: async () => ({ blockNumber: SOURCE.number, logs: [log(FOREIGN), log()] }),
  };
  const nominations = [{ address: POOL, opaque: { adapter: "balancer-v3", txHash: historical.txHash } }];
  const input = { nominations, source: SOURCE, provider: provider as never };
  const outcomes = await reverseBindBalancerV3(input); assert.equal(outcomes[0].status, "verified");
  assert.deepEqual(blocks, [SOURCE.number, SOURCE.number, SOURCE.number]);
  if (outcomes[0].status === "verified") assert(plugin.discovery.decodeCandidate({ observation: outcomes[0].observation, matchedPatternId: SURFACE_ID }));
  const missing = await reverseBindBalancerV3({ ...input, provider: { ...provider, call: async () => word(0n) } as never });
  assert.equal(missing[0].status, "failed");
  const observations = await nominateBalancerV3(input); assert.equal(observations.length, 1);
  assert.equal(observations[0].kind === "log" ? decodeSwapLog(observations[0])!.pool : "", POOL);
  assert.equal((await nominateBalancerV3({ ...input, provider: { ...provider,
    getTransactionReceipt: async () => ({ blockNumber: SOURCE.number + 1, logs: [log()] }) } as never })).length, 0);
});
test("receipt consumes every owned trigger and cannot publish partial foreign or unadmitted swaps", async () => {
  const s = setup(); const route = s.routes[0];
  const trigger = { triggerId: "swap:0", logIndex: 0, emitter: VAULT, topic0: SWAP_TOPIC };
  const ctx = { logs: [log()], matchedOwnedTriggers: [trigger], graph: [{ adapterId: "balancer-v3-router-swap", target: POOL,
    tokenIn: route.tokenIn, tokenOut: route.tokenOut, slotKind: "swap" as const, edgeKind: "swap" as const, leavesStandingPosition: false }],
    edgesByTarget: new Map(), sourceGeneration: { id: "local" } as never, control: { signal: new AbortController().signal, deadlineAtMs: Date.now() + 10000 } };
  const resolved = await balancerV3ReceiptObservation.decodeReceiptImpacts(ctx); assert.equal(resolved.status, "resolved");
  if (resolved.status === "resolved") assert.equal(resolved.impacts[0].impact.amountIn, BigInt(leg.realized.amountIn));
  assert.equal((await balancerV3ReceiptObservation.decodeReceiptImpacts({ ...ctx, graph: [] })).status, "unresolved");
  assert.equal((await balancerV3ReceiptObservation.decodeReceiptImpacts({ ...ctx,
    matchedOwnedTriggers: [trigger, { ...trigger, triggerId: "duplicate" }] })).status, "unresolved");
  assert.equal((await balancerV3ReceiptObservation.decodeReceiptImpacts({ ...ctx, logs: [{ ...log(), address: FOREIGN }] })).status, "unresolved");
});
test("production declaration owns its Router action and declares pure approval infrastructure", () => {
  const summary = definedFamilyPluginContractSummary(plugin);
  assert.equal(summary.domain, "swap"); assert.equal(summary.suppliedActionAdapterIds.length, 1);
  assert.deepEqual(plugin.manifest.requiredInfraActionAdapterIds, ["erc20-approve"]);
  assert.equal(plugin.swap.victimSupport, "detect-only");
  assert.equal(bool(word(1n)), true); assert.equal(bool(word(0n)), false);
  assert.equal(SURFACE, "balancer-v3-vault-registered-v1");
});
