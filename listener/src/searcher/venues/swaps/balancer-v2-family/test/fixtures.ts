import assert from "node:assert/strict";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/balancer-v2.production.js";
import type { IdentityDecision } from "../../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import { VAULT, VAULT_ABI, POOL_ABI, TOKEN_ABI, lower, poolIdentity } from "../codec.js";
import type { BalancerV2Candidate, BalancerV2Identity } from "../types.js";

// Synthetic responses exercise the production interfaces. They are not
// historical state, admission evidence, or a second pricing implementation.
export const POOL = ethers.getAddress("0xff083f57a556bfb3bbe46ea1b4fa154b2b1fbe88");
export const TOKENS = ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  "0xde30da39c46104798bb5aa3fe8b9e0e1f348163f"].map(ethers.getAddress);
export const EXTRA = ethers.getAddress("0x0000000000000000000000000000000000000033");
export const FOREIGN = ethers.getAddress("0x1000000000000000000000000000000000000003");
export const EXECUTOR = ethers.getAddress("0x1000000000000000000000000000000000000002");
export const SOURCE: CanonicalSource = { number: 26138724, hash: "0x" + "ab".repeat(32), generation: 1 };
export const word = (value: bigint) => ethers.toBeHex(value, 32);
export const idFor = (pool = POOL, specialization = 2) =>
  lower(pool) + specialization.toString(16).padStart(4, "0") + "00000000000000000030";
export function success(id: string, data: string): Extract<AdapterRequestResult, { ok: true }> {
  return { id, ok: true, completion: "returned", data, source: SOURCE,
    provenance: { kind: "fixture", fingerprint: "balancer-v2-local-contract" } };
}
export const candidate = (poolId = idFor()): BalancerV2Candidate => ({
  candidateKind: "balancer-v2-pool", pool: poolIdentity(poolId).pool, poolId,
  hintedTokenIn: null, hintedTokenOut: null,
});
export function fixture(tokens = TOKENS, decimals = tokens.map(() => 18), poolId = idFor(POOL, tokens.length === 2 ? 2 : 1)) {
  const id = poolIdentity(poolId), balances = decimals.map(d => 10n ** BigInt(d) * 1000000n), quotes: bigint[] = [];
  const info = () => VAULT_ABI.encodeFunctionResult("getPoolTokens", [tokens, balances, SOURCE.number - 1]);
  const answer = (request: AdapterRequest): AdapterRequestResult => {
    if (request.kind === "get-code") return success(request.id, "0x60006000");
    assert(request.kind === "eth-call");
    if (request.data === POOL_ABI.encodeFunctionData("getVault")) {
      assert.equal(lower(request.to), lower(id.pool));
      return success(request.id, POOL_ABI.encodeFunctionResult("getVault", [VAULT]));
    }
    if (request.data === POOL_ABI.encodeFunctionData("getPoolId"))
      return success(request.id, POOL_ABI.encodeFunctionResult("getPoolId", [id.poolId]));
    if (request.data === TOKEN_ABI.encodeFunctionData("decimals"))
      return success(request.id, word(BigInt(decimals[tokens.map(lower).indexOf(lower(request.to))])));
    assert.equal(lower(request.to), lower(VAULT));
    const parsed = VAULT_ABI.parseTransaction({ data: request.data })!;
    if (parsed.name === "getPool") {
      assert.equal(parsed.args[0], id.poolId);
      return success(request.id, VAULT_ABI.encodeFunctionResult("getPool", [id.pool, id.specialization]));
    }
    if (parsed.name === "getPoolTokens") {
      assert.equal(parsed.args[0], id.poolId); return success(request.id, info());
    }
    assert.equal(parsed.name, "queryBatchSwap");
    assert.equal(parsed.args[0], 0n);
    const [step] = parsed.args[1], assets = parsed.args[2];
    assert.equal(step.poolId, id.poolId); assert.equal(step.userData, "0x");
    assert.equal(step.assetInIndex, 0n); assert.equal(step.assetOutIndex, 1n);
    assert.equal(assets.length, 2);
    const i = tokens.map(lower).indexOf(lower(assets[0])), j = tokens.map(lower).indexOf(lower(assets[1]));
    assert(i >= 0 && j >= 0 && i !== j);
    const amount = BigInt(step.amount); quotes.push(amount);
    const out = amount * balances[j] * 9999n / ((balances[i] + amount) * 10000n);
    return success(request.id, VAULT_ABI.encodeFunctionResult("queryBatchSwap", [[amount, -out]]));
  };
  return { ...id, tokens, decimals, balances, quotes, info, answer };
}
export function identityDecision(answer = fixture().answer, c = candidate()): IdentityDecision<BalancerV2Identity> {
  const v = plugin.identity.variants[0];
  let evidence: unknown;
  for (let step = 0; step < 4; step++) {
    const input = { candidate: c, step, ...(evidence === undefined ? {} : { evidence }) };
    const decision = v.decide(input);
    if (decision.status !== "continue") return decision;
    const requests = v.buildRequests(input); assert(requests.length > 0);
    evidence = v.decode({ step: input, results: requests.map(answer) });
  }
  throw new Error("identity exceeded four-step contract");
}
export function setup(f = fixture(), c = candidate(f.poolId)) {
  const decision = identityDecision(f.answer, c);
  assert(decision.status === "verified");
  const identity = decision.identity;
  const descriptor = plugin.instance.finalizeDescriptor({ identity, draft: plugin.instance.compileDraft(identity), sharedBindings: [] });
  return { identity, descriptor, routes: plugin.routes.project({ descriptor }), f };
}
export function exact(at = setup(), amountIn = 6917984563928420n, route = at.routes[0], executor = EXECUTOR) {
  const input = { descriptor: at.descriptor, route, amountIn, source: SOURCE, executor, runtimeEvidence: [] };
  const method = plugin.exact.methods(input)[1]; assert(method.kind === "request-program");
  const requests = method.program.buildRequests(input), results = requests.map(at.f.answer);
  const quote = method.program.decode({ programInput: input, initialResults: results, dependentEvidence: [] });
  return { input, method, requests, results, quote };
}
export function currentPricing(s = setup(), route = s.routes[0]) {
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
      if (!next) return { snapshot: decode(evidence), batches };
      assert(round < 2); batches.push(next.requests);
      evidence.push(next.decode(next.requests.map(answer)));
    }
    throw new Error("pricing exceeded two dependent rounds");
  };
  return { descriptor, route, initialResults, current, program, decode, run };
}
