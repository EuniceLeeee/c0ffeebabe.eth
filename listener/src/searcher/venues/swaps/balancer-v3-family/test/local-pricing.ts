import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/balancer-v3.production.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import { buildFamilyExecutionFragment, executeFamilyExactQuote } from "../../../adapter-family-runtime.js";
import { buildEffectiveMids } from "../../../../blockscan-effective-mid.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { StrictCurrentRuntimeCoordinator } from "../../../../strict-current-runtime-coordinator.js";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../../../../strict-production-runtime-session.js";
import { PinnedRethQuoteBackend } from "../../../../pinned-reth-quote-backend.js";
import { applyExactTrialState, emptyExactTrialState } from "../../../../exact-trial-state.js";
import { storageState, tokenBalanceState } from "../../../local-state-models/resources.js";
import { blockScanEdgeKey, createVerifiedGraphView } from "../../../blockscan-state-capability.js";
import { admitToGraph, localCatalog } from "../../../../test/family-integration/balancer-v3/lifecycle.js";
import { VAULT, ROUTER, PERMIT2, VAULT_ABI, POOL_ABI, ROUTER_ABI, TOKEN_ABI, SWAP_ABI,
  MAX_INPUT, MAX_UINT, lower, probeAmounts } from "../codec.js";
import { LOCAL_VAULT_ABI, LOCAL_POOL_ABI, decodeLocalState, localStateRequests, quoteLocal, quoteLocalTransition } from "../local-state.js";
import { classifyBalancerPoolCode, type BalancerLocalModel } from "../local-model.js";
import { BALANCER_MODEL_TEMPLATES } from "../local-math/model-templates.js";
import type { BalancerV3Descriptor, BalancerV3PricingDescriptor, BalancerV3Snapshot } from "../types.js";
import { BALANCER_VAULT_EXTENSION, BALANCER_VAULT_ADMIN } from "../vault-model.js";
import { syntheticBalancerVaultCodes } from "./local-vault-fixture.js";
import { hasStateOnlyWeightedPrice } from "../refresh-scope.js";

// Synthetic state/transport fixtures exercise real production issuers and
// consumers. These are NOT historical on-chain, fork-execution or latency proofs.
const WAD = 10n ** 18n;
const POOL = "0x0000000000000000000000000000000000000033";
const TOKENS = ["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "0x0000000000000000000000000000000000000022"];
const RATE = "0x0000000000000000000000000000000000000044";
const EXECUTOR = "0x1000000000000000000000000000000000000002";
const OTHER = "0x1000000000000000000000000000000000000003";
const SOURCE: CanonicalSource = { number: 900, hash: ethers.toBeHex(900, 32), generation: 1 };
const word = (value: bigint) => ethers.toBeHex(value, 32);
const ceilDiv = (a: bigint, b: bigint) => a === 0n ? 0n : (a - 1n) / b + 1n;
type Route = Parameters<typeof plugin.exact.methods>[0]["route"];

function modelCode(model: BalancerLocalModel, tokenCount = 2): string {
  const template = BALANCER_MODEL_TEMPLATES.find(item => item.model === model)!;
  const bytes = Buffer.from(template.runtimeTemplate.slice(2), "hex");
  for (const immutable of template.immutableReferences) {
    const weight = /^_normalizedWeight(\d)$/.exec(immutable.name);
    const minimum = /^_minBalance(\d)$/.exec(immutable.name);
    const weightIndex = weight ? Number(weight[1]) : -1;
    const value = immutable.name === "_vault" ? BigInt(VAULT) : immutable.name === "_totalTokens" ? BigInt(tokenCount)
      : weight ? weightIndex < tokenCount ? WAD / BigInt(tokenCount) + (weightIndex === 0 ? WAD % BigInt(tokenCount) : 0n) : 0n
      : minimum ? Number(minimum[1]) < tokenCount ? 1n : 0n : 1n;
    for (const offset of immutable.offsets) Buffer.from(word(value).slice(2), "hex").copy(bytes, offset);
  }
  const code = "0x" + bytes.toString("hex");
  assert.equal(classifyBalancerPoolCode(code), model);
  return code;
}

function fixture(model: BalancerLocalModel | null = "weighted-v1", decimals = [18, 18], withRates = false,
  pool = POOL) {
  const tokens = decimals.map((_, index) => TOKENS[index] ?? ethers.toBeHex(0x22 + index, 20));
  const values = {
    decimals,
    balancesRaw: decimals.map(d => 1000n * 10n ** BigInt(d)),
    storedBalancesRaw: undefined as bigint[] | undefined,
    rates: decimals.map(() => WAD),
    scalingFactors: decimals.map(d => 10n ** BigInt(18 - d)),
    fee: 10n ** 15n,
    aggregateSwapFee: 0n,
    amp: 100_000n,
    minimumTrade: 1_000_000n,
    paused: false,
    vaultPaused: false,
    queryDisabled: false,
    configLowBits: 3n,
    hooks: Array<boolean>(10).fill(false),
    hookAddress: ethers.ZeroAddress,
    weights: decimals.map((_, index) => WAD / BigInt(decimals.length) + (index === 0 ? WAD % BigInt(decimals.length) : 0n)),
    minTokenBalances: decimals.map(() => 1n),
    tokenInfo: tokens.map(() => [withRates ? 1 : 0, withRates ? RATE : ethers.ZeroAddress, false]),
    tokens,
    failLocalData: false,
    allowRouter: model === null,
  };
  const calls: { to: string; data: string }[] = [];
  const hooksData = () => VAULT_ABI.encodeFunctionResult("getHooksConfig", [[...values.hooks, values.hookAddress]]);
  const liveBalances = () => values.balancesRaw.map((balance, i) => balance * values.scalingFactors[i] * values.rates[i] / WAD);
  const code = model === null ? "0x60006000" : modelCode(model, tokens.length);
  const vaultCodes = syntheticBalancerVaultCodes();
  function answer(tx: { to: string; data: string }): string {
    calls.push(tx);
    const selector = tx.data.slice(0, 10);
    const is = (abi: ethers.Interface, name: string) => selector === abi.getFunction(name)!.selector;
    if (is(POOL_ABI, "getVault")) return POOL_ABI.encodeFunctionResult("getVault", [VAULT]);
    if (is(TOKEN_ABI, "decimals")) return word(BigInt(values.decimals[values.tokens.map(lower).indexOf(lower(tx.to))]));
    if (lower(tx.to) === lower(VAULT)) {
      if (is(VAULT_ABI, "isPoolRegistered")) return word(1n);
      if (is(VAULT_ABI, "getHooksConfig")) return hooksData();
      if (is(VAULT_ABI, "getPoolTokenInfo")) return VAULT_ABI.encodeFunctionResult("getPoolTokenInfo",
        [values.tokens, values.tokenInfo, values.storedBalancesRaw ?? values.balancesRaw, liveBalances()]);
      if (is(LOCAL_VAULT_ABI, "getPoolData")) {
        if (values.failLocalData) throw new Error("fixture local state unavailable");
        const config = values.configLowBits | (values.fee / 100_000_000_000n << 18n) |
          (values.aggregateSwapFee / 100_000_000_000n << 42n);
        return LOCAL_VAULT_ABI.encodeFunctionResult("getPoolData", [[word(config), values.tokens, values.tokenInfo,
          values.balancesRaw, liveBalances(), values.rates, values.scalingFactors]]);
      }
      if (is(LOCAL_VAULT_ABI, "isPoolPaused")) return word(values.paused ? 1n : 0n);
      if (is(LOCAL_VAULT_ABI, "isVaultPaused")) return word(values.vaultPaused ? 1n : 0n);
      if (is(LOCAL_VAULT_ABI, "isQueryDisabled")) return word(values.queryDisabled ? 1n : 0n);
      if (is(LOCAL_VAULT_ABI, "getMinimumTradeAmount")) return word(values.minimumTrade);
    }
    if (lower(tx.to) === lower(pool)) {
      if (is(LOCAL_POOL_ABI, "getNormalizedWeights")) return LOCAL_POOL_ABI.encodeFunctionResult("getNormalizedWeights", [values.weights]);
      if (is(LOCAL_POOL_ABI, "getMinTokenBalances")) return LOCAL_POOL_ABI.encodeFunctionResult("getMinTokenBalances", [values.minTokenBalances]);
      if (is(LOCAL_POOL_ABI, "getAmplificationParameter")) return LOCAL_POOL_ABI.encodeFunctionResult("getAmplificationParameter", [values.amp, true, 1000n]);
    }
    if (lower(tx.to) === lower(ROUTER)) {
      if (is(ROUTER_ABI, "getPermit2")) return ROUTER_ABI.encodeFunctionResult("getPermit2", [PERMIT2]);
      assert(values.allowRouter, "proven local model must never query Router");
      const args = ROUTER_ABI.decodeFunctionData("querySwapSingleTokenExactIn", tx.data);
      return word(BigInt(args[3]) * 999n / 1000n);
    }
    throw new Error(`unexpected synthetic call ${tx.to}:${selector}`);
  }
  const provider = {
    async call(tx: { to: string; data: string }, _block?: number) { return answer(tx); },
    async getCode(address: string) {
      const index = [VAULT, BALANCER_VAULT_EXTENSION, BALANCER_VAULT_ADMIN].map(lower).indexOf(lower(address));
      return index >= 0 ? vaultCodes[index] : lower(address) === lower(pool) ? code : "0x60006000";
    },
    async getStorage() { throw new Error("unexpected storage read"); },
  };
  const result = (request: AdapterRequest, source = SOURCE): AdapterRequestResult => {
    assert.equal(request.kind, "eth-call");
    if (request.kind !== "eth-call") throw new Error("fixture only decodes state calls");
    return { id: request.id, ok: true, completion: "returned", data: answer(request), source,
      provenance: { kind: "fixture", fingerprint: "balancer-local-state-fixture" } };
  };
  return { model, pool, values, calls, code, vaultCodes, answer, provider, result };
}

const catalogPromise = localCatalog();
async function admitted(f: ReturnType<typeof fixture>, source = SOURCE) {
  const catalog = await catalogPromise;
  const observation = { kind: "log" as const, address: VAULT, source,
    ...SWAP_ABI.encodeEventLog(SWAP_ABI.getEvent("Swap")!, [f.pool, ...TOKENS, WAD, WAD - 1n, 0, 0]) };
  const result = await admitToGraph({ catalog, source, executor: EXECUTOR, provider: f.provider, observations: [observation] });
  assert(result.lifecycle.publication, JSON.stringify(result.lifecycle.outcomes));
  const instance = result.lifecycle.publication.instances[0];
  return { ...result, catalog, instance, descriptor: instance.descriptor as BalancerV3Descriptor,
    routes: instance.routes as readonly Route[] };
}

function exactInput(descriptor: BalancerV3Descriptor, route: Route, amountIn: bigint, source = SOURCE) {
  return { descriptor, route, amountIn, source, executor: EXECUTOR, runtimeEvidence: [] };
}
function localQuote(f: ReturnType<typeof fixture>, descriptor: BalancerV3Descriptor, route: Route,
  amountIn: bigint, source = SOURCE) {
  const input = exactInput(descriptor, route, amountIn, source);
  const method = plugin.exact.methods(input)[1];
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") throw new Error("missing local method");
  const requests = method.program.buildRequests(input);
  return { input, method, requests, result: method.program.decode({ programInput: input,
    initialResults: requests.map(request => f.result(request, source)), dependentEvidence: [] }) };
}

for (const model of BALANCER_MODEL_TEMPLATES.map(item => item.model)) {
  test(`${model}: issued raw and amount-sensitive Exact use identical local state reads`, async () => {
    const f = fixture(model), a = await admitted(f);
    assert.equal(a.descriptor.binding.localModel, model);
    assert.equal(a.instance.routes.length, 2);
    assert.equal(a.graph.edges.length, 2);
    for (const route of a.routes) {
      const pricing = a.instance.pricingInstances.find(item => item.routes.some(r => r.routeKey === route.routeKey))!;
      const pricingDescriptor = pricing.pricingDescriptor as BalancerV3PricingDescriptor;
      const pricingRoutes = pricing.routes as readonly Route[];
      assert.equal(plugin.pricing.refreshPolicyForInstance!({ descriptor: pricingDescriptor, routes: pricingRoutes }),
        model.startsWith("weighted-") ? "on-touch" : "each-block");
      const snapshot = pricing.snapshot as BalancerV3Snapshot;
      const small = localQuote(f, a.descriptor, route, snapshot.amountIn);
      const large = localQuote(f, a.descriptor, route, 100n * WAD);
      assert.equal(small.result.amountOut, snapshot.amountOut);
      assert.equal(small.result.evidence.kind, "balancer-v3-local-exact-in");
      assert.equal(Object.hasOwn(small.method, "chainAmountQuote"), false);
      assert.equal(Object.hasOwn(small.method, "stateOnlyReads"), false, "time-sensitive state cannot promise cross-source reuse");
      assert.deepEqual(small.requests, large.requests, "amount change recalculates; it does not change reads");
      assert.deepEqual(small.requests, plugin.pricing.current.buildRequests({ descriptor: pricingDescriptor,
        routes: pricingRoutes, source: SOURCE }));
      assert(large.result.amountOut < small.result.amountOut * (large.input.amountIn / small.input.amountIn));
      assert.equal(large.result.evidence.amountIn, 100n * WAD);
      assert.equal(localQuote(f, a.descriptor, route, 0n).result.amountOut, 0n);
      assert.equal(plugin.pricing.current.buildDependentProgram!({ current: { descriptor: pricingDescriptor,
        routes: pricingRoutes, source: SOURCE }, completedRound: 0,
        initialResults: small.requests.map(request => f.result(request)), priorEvidence: [] }), null);
    }
    assert.equal(f.calls.filter(tx => lower(tx.to) === lower(ROUTER) &&
      tx.data !== ROUTER_ABI.encodeFunctionData("getPermit2")).length, 0);
    const input = { family: a.family, route: a.instance.routeHandles[0], amountIn: WAD, source: SOURCE,
      generation: SOURCE.generation, executor: EXECUTOR, runtimeEvidence: [], runtime: a.runtime };
    const issued = await executeFamilyExactQuote(input);
    assert.equal(issued.status, "resolved");
    const chainOnly = await executeFamilyExactQuote({ ...input, requireChainAmountQuote: true });
    assert.notEqual(chainOnly.status, "resolved", "local math must not masquerade as chain-produced output");
    if (issued.status !== "resolved") throw new Error("local Exact was not issued");
    assert.equal(buildFamilyExecutionFragment({ family: a.family, actionOwnership: a.catalog,
      route: input.route, exact: issued, minAmountOut: issued.amountOut, executor: EXECUTOR, runtimeEvidence: [] }).status, "resolved");
    assert.notEqual((await executeFamilyExactQuote({ ...input, route: { ...input.route } })).status, "resolved");
    assert.notEqual((await executeFamilyExactQuote({ ...input, source: { ...SOURCE, hash: ethers.ZeroHash } })).status, "resolved");
  });
}

test("Weighted scaling uses raw units, rounded-up fee and rounded-up output rate", async () => {
  const f = fixture("weighted-v1", [6, 18], true);
  f.values.rates = [12n * WAD / 10n, 11n * WAD / 10n + 7n];
  const a = await admitted(f), amountIn = 12_345_679n;
  const q = localQuote(f, a.descriptor, a.routes[0], amountIn);
  const inputScaled = amountIn * 10n ** 12n * f.values.rates[0] / WAD;
  const net = inputScaled - ceilDiv(inputScaled * f.values.fee, WAD);
  const balances = f.values.balancesRaw.map((b, i) => b * f.values.scalingFactors[i] * f.values.rates[i] / WAD);
  // Equal weights have exponent 1, allowing an independent closed-form check.
  const power = ceilDiv(balances[0] * WAD, balances[0] + net);
  const outScaled = balances[1] * (WAD - power) / WAD;
  assert.equal(q.result.amountOut, outScaled * WAD / (f.values.rates[1] + 1n));
  assert.equal(q.result.evidence.amountIn, amountIn);
  const state = decodeLocalState(a.descriptor, localStateRequests(a.descriptor).map(request => f.result(request)));
  assert.throws(() => quoteLocal(a.descriptor, a.routes[0],
    { ...state, minimumTradeAmount: 2n * 10n ** 12n }, 1n, SOURCE), /too small/);
  assert.throws(() => quoteLocal(a.descriptor, a.routes[0], state, MAX_INPUT + 1n, SOURCE), /binding\/amount/);
  assert.throws(() => quoteLocal(a.descriptor, a.routes[0], state, -1n, SOURCE), /binding\/amount/);
  assert.throws(() => quoteLocal(a.descriptor, a.routes[0], state, MAX_INPUT, SOURCE), /MaxInRatio|overflow/);
  assert.throws(() => quoteLocal(a.descriptor, a.routes[0], state, amountIn, { ...SOURCE, generation: 2 }), /foreign source/);
});

for (const model of BALANCER_MODEL_TEMPLATES.map(item => item.model)) {
  test(`${model}: local transition preserves Vault raw/live rounding and isolates repeated trials`, async () => {
    const f = fixture(model, [6, 8, 18], true);
    f.values.rates = [12n * WAD / 10n + 3n, 11n * WAD / 10n + 7n, WAD];
    f.values.aggregateSwapFee = WAD / 2n;
    const a = await admitted(f), route = a.routes.find(route => route.i === 0 && route.j === 1)!;
    const reverse = a.routes.find(candidate => candidate.i === route.j && candidate.j === route.i)!;
    const state = decodeLocalState(a.descriptor, localStateRequests(a.descriptor).map(request => f.result(request)));
    const originalRaw = [...state.balancesRaw], originalLive = [...state.balances];
    const amountIn = 12_345_679n;
    const transition = quoteLocalTransition(a.descriptor, route, state, amountIn, SOURCE);
    assert.equal(transition.amountOut, quoteLocal(a.descriptor, route, state, amountIn, SOURCE));

    // Mirror the independently saved Vault._swap accounting rules, not the
    // pool-math scaled amount: fees first go raw, then aggregate fees floor.
    const scaled = amountIn * state.scalingFactors[route.i] * state.rates[route.i] / WAD;
    const feeScaled = ceilDiv(scaled * state.swapFee, WAD);
    const feeRaw = feeScaled * WAD / (state.scalingFactors[route.i] * state.rates[route.i]);
    const aggregateFeeRaw = feeRaw * state.aggregateSwapFee / WAD;
    const expectedRaw = [...originalRaw];
    expectedRaw[route.i] += amountIn - aggregateFeeRaw;
    expectedRaw[route.j] -= transition.amountOut;
    const expectedLive = expectedRaw.map((raw, i) => raw * state.scalingFactors[i] * state.rates[i] / WAD);
    assert(aggregateFeeRaw > 0n);
    assert.deepEqual(transition.nextState.balancesRaw, expectedRaw);
    assert.deepEqual(transition.nextState.balances, expectedLive);
    assert.equal(transition.nextState.balancesRaw[2], originalRaw[2], "untraded token is unchanged");
    assert.equal(transition.nextState.source, state.source);
    assert.equal(transition.nextState.rates, state.rates, "same-source rate snapshot is retained");
    assert(Object.isFrozen(transition));
    assert(Object.isFrozen(transition.nextState));
    assert(Object.isFrozen(transition.nextState.balancesRaw));
    assert(Object.isFrozen(transition.nextState.balances));
    assert.notEqual(transition.nextState.balancesRaw, state.balancesRaw);

    // A fresh state read with the exact post-swap raw balances yields the
    // same reverse quote; the original state's reverse quote must differ.
    f.values.balancesRaw = [...expectedRaw];
    const readAfter = decodeLocalState(a.descriptor, localStateRequests(a.descriptor).map(request => f.result(request)));
    assert.deepEqual(transition.nextState, readAfter);
    const second = quoteLocalTransition(a.descriptor, reverse, transition.nextState, transition.amountOut, SOURCE);
    assert.equal(second.amountOut, quoteLocal(a.descriptor, reverse, readAfter, transition.amountOut, SOURCE));
    assert.notEqual(second.amountOut, quoteLocal(a.descriptor, reverse, state, transition.amountOut, SOURCE));
    assert.deepEqual(state.balancesRaw, originalRaw, "another amount/route starts from the untouched snapshot");
    assert.deepEqual(state.balances, originalLive);
    assert.deepEqual(quoteLocalTransition(a.descriptor, route, state, amountIn, SOURCE), transition);
    assert.deepEqual(transition.nextState.balancesRaw, expectedRaw, "second swap cannot mutate first result");
    const zero = quoteLocalTransition(a.descriptor, route, state, 0n, SOURCE);
    assert.equal(zero.amountOut, 0n);
    assert.equal(zero.nextState, state);
  });
}

test("local transition charges no aggregate fees in recovery mode and preserves rejection guards", async () => {
  const f = fixture("weighted-v1"), a = await admitted(f), route = a.routes[0];
  f.values.aggregateSwapFee = WAD / 2n;
  f.values.configLowBits |= 8n;
  const state = decodeLocalState(a.descriptor, localStateRequests(a.descriptor).map(request => f.result(request)));
  const amountIn = WAD, result = quoteLocalTransition(a.descriptor, route, state, amountIn, SOURCE);
  assert.equal(state.aggregateSwapFee, 0n);
  assert.equal(result.nextState.balancesRaw[route.i], state.balancesRaw[route.i] + amountIn);
  assert.throws(() => quoteLocalTransition(a.descriptor, route, state, amountIn, { ...SOURCE, generation: 2 }), /foreign source/);
  assert.throws(() => quoteLocalTransition(a.descriptor, route, { ...state, model: "stable-v1" }, amountIn, SOURCE), /binding\/amount/);
  assert.throws(() => quoteLocalTransition(a.descriptor, route, state, MAX_INPUT, SOURCE), /MaxInRatio|overflow/);
  assert.throws(() => quoteLocalTransition(a.descriptor, route, state, -1n, SOURCE), /binding\/amount/);
});

test("standard-token Exact carries post-state through the shared trial view without another read", async () => {
  const f = fixture("weighted-v1", [6, 18]), a = await admitted(f), baseline = emptyExactTrialState();
  const input = { ...exactInput(a.descriptor, a.routes[0], 12_345_679n), trialState: baseline.view };
  const method = plugin.exact.methods(input)[1];
  assert(method.kind === "request-program" && method.trialState);
  const quoteTrial = method.trialState.quote;
  assert(typeof quoteTrial === "function", "expected supported Balancer trial model");
  assert.equal(Object.hasOwn(method, "stateOnlyReads"), false, "time-dependent state is not cross-block cache permission");
  assert.equal(quoteTrial(input).status, "not-applicable");
  const initialResults = method.program.buildRequests(input).map(request => f.result(request));
  const first = method.program.decode({ programInput: input, initialResults, dependentEvidence: [] });
  assert(first.stateChanges && first.stateEffects);
  assert.equal(first.stateChanges[0].ref.key, `pool:${lower(POOL)}`);
  assert(first.stateEffects.includes(tokenBalanceState(input.route.tokenOut, VAULT)));
  assert(first.stateEffects.includes(tokenBalanceState(input.route.tokenIn, EXECUTOR)));
  assert(!first.stateEffects.includes(storageState(VAULT)), "one pool swap must not dirty every Vault pool");
  const after = applyExactTrialState(baseline, first.stateChanges, first.stateEffects);
  const reverse = { ...input, route: a.routes[1], amountIn: first.amountOut, trialState: after.view };
  const readsBefore = f.calls.length, second = quoteTrial(reverse);
  assert.equal(f.calls.length, readsBefore, "loaded shared state path performs no read");
  assert.equal(second.status, "quoted");
  if (second.status !== "quoted") throw new Error("missing reverse trial quote");
  const expectedState = first.stateChanges[0].value as Parameters<typeof quoteLocal>[2];
  assert.equal(second.result.amountOut, quoteLocal(a.descriptor, reverse.route, expectedState, reverse.amountIn, SOURCE));
  assert.equal(baseline.view.get(first.stateChanges[0].ref), undefined, "other amount trials retain untouched baseline");
  assert.deepEqual(quoteTrial(reverse), second);
  const readFallback = method.program.decode({ programInput: reverse, initialResults, dependentEvidence: [] });
  assert.equal(readFallback.amountOut, second.result.amountOut, "source read cannot overwrite earlier trial mutation");
});

test("shared trial dependencies reject changed pool or Vault config but not an unrelated Vault pool", async () => {
  const f = fixture(), a = await admitted(f), baseline = emptyExactTrialState();
  const input = { ...exactInput(a.descriptor, a.routes[0], WAD), trialState: baseline.view };
  const method = plugin.exact.methods(input)[1];
  assert(method.kind === "request-program" && method.trialState);
  const quoteTrial = method.trialState.quote;
  assert(typeof quoteTrial === "function", "expected supported Balancer trial model");
  const initialResults = method.program.buildRequests(input).map(request => f.result(request));
  const first = method.program.decode({ programInput: input, initialResults, dependentEvidence: [] });
  assert(first.stateChanges);
  const after = applyExactTrialState(baseline, first.stateChanges, first.stateEffects);
  for (const dependency of [storageState(POOL), storageState(VAULT), `vault-pool:${lower(VAULT)}:${lower(POOL)}`]) {
    const conflicting = { ...input, trialState: applyExactTrialState(after, [], [dependency]).view };
    assert.throws(() => quoteTrial(conflicting), /invalidated dependency/);
    assert.throws(() => method.program.decode({ programInput: conflicting, initialResults, dependentEvidence: [] }), /invalidated dependency/);
    assert.throws(() => quoteTrial({ ...input,
      trialState: applyExactTrialState(baseline, [], [dependency]).view }), /invalidated dependency/,
    "missing state cannot reread baseline after an earlier conflicting effect");
  }
  const independent = applyExactTrialState(after, [], [`vault-pool:${lower(VAULT)}:${lower(OTHER)}`,
    tokenBalanceState(input.route.tokenIn, VAULT), tokenBalanceState(input.route.tokenOut, VAULT)]);
  assert.equal(quoteTrial({ ...input, trialState: independent.view }).status, "quoted",
    "pool math has no shared-Vault-inventory read; unrelated pool accounting stays independent");
});

test("rate-provider pools keep local single-hop quotes without claiming a complete trial dependency closure", async () => {
  const f = fixture("stable-v3", [18, 18], true), a = await admitted(f);
  const input = { ...exactInput(a.descriptor, a.routes[0], WAD), trialState: emptyExactTrialState().view };
  const method = plugin.exact.methods(input)[1];
  assert(method.kind === "request-program");
  assert.deepEqual(method.trialState,
    { unsupportedReason: "balancer-v3 hook, rate-provider or yield-fee transition dependencies are unproven" });
  assert.equal(Object.hasOwn(method, "chainAmountQuote"), false);
  const result = method.program.decode({ programInput: input,
    initialResults: method.program.buildRequests(input).map(request => f.result(request)), dependentEvidence: [] });
  assert(result.amountOut > 0n);
  assert.equal(result.stateChanges, undefined);
});

test("local raw probes use post-yield balances, not the legacy pre-yield stored-balance notional", async () => {
  const f = fixture("weighted-v1", [6, 18], true);
  f.values.balancesRaw = [50_000_000n, 50n * WAD];
  f.values.storedBalancesRaw = [150_000_000n, 150n * WAD];
  const a = await admitted(f);
  const snapshot = a.instance.pricingInstances.find(item => item.routes[0].routeKey === a.routes[0].routeKey)!.snapshot as BalancerV3Snapshot;
  assert.equal(probeAmounts(6, f.values.storedBalancesRaw[0])[0], 1_000_000n);
  assert.equal(snapshot.amountIn, 500_000n);
  assert.equal(snapshot.balanceIn, f.values.balancesRaw[0]);
  const exact = localQuote(f, a.descriptor, a.routes[0], snapshot.amountIn);
  assert.equal(snapshot.amountOut, exact.result.amountOut);
  assert.notEqual(snapshot.amountOut, localQuote(f, a.descriptor, a.routes[0], 1_000_000n).result.amountOut);
});

test("all three Vault runtimes must prove local semantics; a missing or changed component preserves Router admission", async () => {
  for (const index of [0, 1, 2]) {
    const f = fixture("weighted-v1");
    f.vaultCodes[index] = "0x60006000";
    f.values.allowRouter = true;
    const a = await admitted(f);
    assert.equal(a.descriptor.binding.localModel, null);
    const q = localQuote(f, a.descriptor, a.routes[0], WAD);
    assert.equal(q.result.evidence.kind, "balancer-v3-router-exact-in");
    assert.equal(a.graph.edges.length, 2, "model fallback must not become an instance admission list");
  }
  for (const index of [1, 2]) {
    const f = fixture("stable-v3");
    f.vaultCodes[index] = "0x";
    f.values.allowRouter = true;
    assert.equal((await admitted(f)).descriptor.binding.localModel, null);
  }
});

test("local decode rejects changed bindings, unresolved reads, pause/config, invalid rates/scales and model parameters", async () => {
  const f = fixture("weighted-v1", [18, 18], true), a = await admitted(f);
  const reads = () => localStateRequests(a.descriptor).map(request => f.result(request));
  const valid = reads();
  assert.throws(() => decodeLocalState(a.descriptor, [...valid, valid[0]]), /result set/);
  assert.throws(() => decodeLocalState(a.descriptor, [valid[0], ...valid.slice(2), valid[0]]), /missing\/duplicate/);
  assert.throws(() => decodeLocalState(a.descriptor, valid.map((read, i) => i ? read :
    { id: read.id, ok: false, failure: "rpc", source: SOURCE })), /unresolved/);
  assert.throws(() => decodeLocalState(a.descriptor, valid.map((read, i) => i ? read :
    { ...read, source: { ...SOURCE, hash: ethers.ZeroHash } })), /foreign source/);
  for (const key of ["paused", "vaultPaused", "queryDisabled"] as const) {
    f.values[key] = true; assert.throws(() => decodeLocalState(a.descriptor, reads()), /paused|disabled/); f.values[key] = false;
  }
  f.values.configLowBits = 1n; assert.throws(() => decodeLocalState(a.descriptor, reads()), /config/); f.values.configLowBits = 3n;
  f.values.fee = WAD; assert.throws(() => decodeLocalState(a.descriptor, reads()), /config/); f.values.fee = 10n ** 15n;
  f.values.rates[0] = 0n; assert.throws(() => decodeLocalState(a.descriptor, reads()), /scaling\/rate/); f.values.rates[0] = WAD;
  f.values.scalingFactors[0] = 10n; assert.throws(() => decodeLocalState(a.descriptor, reads()), /scaling\/rate/); f.values.scalingFactors[0] = 1n;
  f.values.weights = [WAD, WAD]; assert.throws(() => decodeLocalState(a.descriptor, reads()), /weights/); f.values.weights = [WAD / 2n, WAD / 2n];
  f.values.minimumTrade = 0n; assert.throws(() => decodeLocalState(a.descriptor, reads()), /minimum trade/); f.values.minimumTrade = 1_000_000n;
  f.values.tokens.reverse(); assert.throws(() => decodeLocalState(a.descriptor, reads()), /token binding/); f.values.tokens.reverse();
  f.values.tokenInfo[0][1] = OTHER; assert.throws(() => decodeLocalState(a.descriptor, reads()), /token binding/); f.values.tokenInfo[0][1] = RATE;
  f.values.hooks[7] = true; f.values.hookAddress = OTHER;
  assert.throws(() => decodeLocalState(a.descriptor, reads()), /hook binding/);
  const stable = fixture("stable-v3"), s = await admitted(stable);
  stable.values.amp = 999n;
  assert.throws(() => decodeLocalState(s.descriptor, localStateRequests(s.descriptor).map(request => stable.result(request))), /amplification/);
  stable.values.amp = 100_000n;
  stable.values.balancesRaw[0] = MAX_UINT;
  assert.throws(() => decodeLocalState(s.descriptor, localStateRequests(s.descriptor).map(request => stable.result(request))), /scaling\/rate\/balance/);
});

test("uint128 storage bounds cover every token's initial raw/live balances, including a non-trading rate token", async () => {
  const maximum = (1n << 128n) - 1n;
  const f = fixture("stable-v3", [18, 18, 18], true), a = await admitted(f);
  const reads = () => localStateRequests(a.descriptor).map(request => f.result(request));
  assert.equal(a.graph.edges.length, 6);
  assert.equal(a.routes[0].i, 0); assert.equal(a.routes[0].j, 1);
  // The overflowing token is not either side of the first quote direction.
  f.values.balancesRaw[2] = maximum / 2n + 1n;
  f.values.rates[2] = 2n * WAD;
  assert(f.values.balancesRaw[2] <= maximum);
  assert.equal(f.values.balancesRaw[2] * f.values.rates[2] / WAD, maximum + 1n);
  assert.throws(() => decodeLocalState(a.descriptor, reads()), /scaling\/rate\/balance/);
  // Isolate the raw cap: this raw balance overflows while its live balance fits.
  f.values.balancesRaw[2] = maximum + 1n;
  f.values.rates[2] = WAD / 2n;
  assert(f.values.balancesRaw[2] * f.values.rates[2] / WAD <= maximum);
  assert.throws(() => decodeLocalState(a.descriptor, reads()), /scaling\/rate\/balance/);
});

test("uint128 input post-balance checks use aggregate fee deduction and recovery-mode semantics", async () => {
  const maximum = (1n << 128n) - 1n, amountIn = 10n ** 26n;
  const f = fixture("weighted-v1", [18, 18], true), a = await admitted(f);
  const reads = () => localStateRequests(a.descriptor).map(request => f.result(request));
  const decode = () => decodeLocalState(a.descriptor, reads());
  const quote = () => quoteLocal(a.descriptor, a.routes[0], decode(), amountIn, SOURCE);
  f.values.fee = WAD / 10n;
  f.values.balancesRaw = [maximum - amountIn + 1n, maximum / 2n];
  assert.equal(decode().balancesRaw[0] + amountIn, maximum + 1n);
  assert.throws(quote, /local balance overflow/, "pool math alone must not allow overflowing input raw balance");

  f.values.rates[0] = 2n * WAD;
  f.values.balancesRaw[0] = maximum / 2n - amountIn + 1n;
  const liveState = decode();
  assert(liveState.balancesRaw[0] + amountIn <= maximum);
  assert.equal((liveState.balancesRaw[0] + amountIn) * 2n, maximum + 1n);
  assert.throws(quote, /local balance overflow/, "raw headroom does not establish scaled live headroom");

  f.values.rates[0] = WAD;
  f.values.aggregateSwapFee = WAD / 2n;
  const aggregateFeeRaw = amountIn / 10n / 2n;
  f.values.balancesRaw[0] = maximum - amountIn + aggregateFeeRaw;
  const legal = decode();
  assert.equal(legal.aggregateSwapFee, WAD / 2n);
  assert.equal(legal.balancesRaw[0] + amountIn - aggregateFeeRaw, maximum);
  assert(quote() > 0n, "deducting actual aggregate fees may make exact uint128 boundary legal");
  f.values.configLowBits |= 8n;
  assert.equal(decode().aggregateSwapFee, 0n, "recovery mode disables aggregate fee collection");
  assert.throws(quote, /local balance overflow/, "recovery mode cannot retain the aggregation capacity benefit");
  f.values.configLowBits = 3n;
  f.values.aggregateSwapFee = WAD + 100_000_000_000n;
  assert.throws(decode, /invalid local pool config/);
  // These state tests do not certify fee-ledger accumulation capacity. The
  // mandatory execution/final-simulation gate still owns that remaining check.
});

test("local execution evidence binds route, executor and exact amounts; unknown models retain Router", async () => {
  const f = fixture(), a = await admitted(f), q = localQuote(f, a.descriptor, a.routes[0], WAD);
  const input = { descriptor: a.descriptor, route: a.routes[0], amountIn: WAD, quotedAmountOut: q.result.amountOut,
    minAmountOut: q.result.amountOut, exactEvidence: q.result.evidence, executor: EXECUTOR, runtimeEvidence: [] };
  assert.equal(plugin.execution.buildFragment(input).nodes[0].target, ROUTER);
  for (const altered of [{ binding: "wrong" }, { routeKey: a.routes[1].routeKey }, { executor: OTHER },
    { amountIn: WAD + 1n }, { amountOut: q.result.amountOut + 1n }]) {
    assert.throws(() => plugin.execution.buildFragment({ ...input, exactEvidence: { ...input.exactEvidence, ...altered } }), /evidence/);
  }
  const unknown = fixture(null), b = await admitted(unknown);
  assert.equal(b.descriptor.binding.localModel, null);
  const fallback = localQuote(unknown, b.descriptor, b.routes[0], WAD);
  assert.equal(fallback.result.evidence.kind, "balancer-v3-router-exact-in");
  assert.equal("chainAmountQuote" in fallback.method && fallback.method.chainAmountQuote, true);
  assert.equal(fallback.requests.length, 1);
  assert.equal(fallback.requests[0].kind === "eth-call" && fallback.requests[0].to, ROUTER);
  assert.throws(() => plugin.execution.buildFragment({ ...input, descriptor: b.descriptor, route: b.routes[0] }), /evidence|descriptor/);
});

test("state-only refresh proof excludes every clock/rate/hook/unknown variant; compiled mutations preserve Vault changes", async () => {
  const a = await admitted(fixture()), descriptor = a.descriptor, binding = descriptor.binding;
  assert(hasStateOnlyWeightedPrice(descriptor));
  for (const alteration of [
    { localModel: null }, { localModel: "stable-v3" as const },
    { tokenInfo: binding.tokenInfo.map(info => ({ ...info, tokenType: 1 })) },
    { tokenInfo: binding.tokenInfo.map(info => ({ ...info, rateProvider: RATE })) },
    { tokenInfo: binding.tokenInfo.map(info => ({ ...info, paysYieldFees: true })) },
    { hooks: { ...binding.hooks, address: OTHER } },
    { hooks: { ...binding.hooks, flags: binding.hooks.flags.map((flag, i) => flag || i === 0) } },
  ]) assert.equal(hasStateOnlyWeightedPrice({ ...descriptor, binding: { ...binding, ...alteration } }), false);
  const root = new StrictProductionRuntimeRoot({ catalog: a.catalog, readySource: SOURCE,
    readyGraph: a.graph.edges, readyInstances: a.lifecycle.publication!.instances, readyFundingAssets: [] });
  const keys = a.routes.map(route => route.routeKey).sort();
  const log = (address: string) => ({ kind: "log" as const, address, topics: [], data: "0x", source: SOURCE });
  const swap = (pool: string) => ({ ...log(VAULT), ...SWAP_ABI.encodeEventLog(SWAP_ABI.getEvent("Swap")!,
    [pool, ...TOKENS, WAD, WAD / 2n, 10n ** 15n, 10n ** 15n]) });
  const cases = [
    { observation: log(TOKENS[0]), expected: [] },
    { observation: { kind: "call" as const, target: TOKENS[0], data: "0x", source: SOURCE }, expected: [] },
    { observation: log(POOL), expected: keys },
    { observation: log(VAULT), expected: keys },
    { observation: { kind: "call" as const, target: VAULT, data: "0x", source: SOURCE }, expected: keys },
    { observation: swap(POOL), expected: keys },
    { observation: swap(OTHER), expected: [] },
  ];
  for (const { observation, expected } of cases) {
    assert.deepEqual([...root.resolveBlockTouchedStateKeys(observation, SOURCE)].sort(), expected);
    const individual = new Set(a.instance.pricingInstances.flatMap(pricing => plugin.pricing.mutation!.affectedStateKeys({
      descriptor: pricing.pricingDescriptor as BalancerV3PricingDescriptor,
      routes: pricing.routes as readonly Route[], observation,
    })));
    assert.deepEqual([...individual].sort(), expected, "compiled/individual dependency semantics agree");
  }
});

for (const clockSensitive of [true, false]) {
test(`production shared reads: ${clockSensitive ? "clock/rate refresh" : "state-only weighted carry and Vault invalidation"}`, async () => {
  const f = clockSensitive ? fixture("stable-v3", [18, 18], true) : fixture("weighted-v1");
  const a = await admitted(f);
  const root = new StrictProductionRuntimeRoot({ catalog: a.catalog, readySource: SOURCE,
    readyGraph: a.graph.edges, readyInstances: a.lifecycle.publication!.instances, readyFundingAssets: [] });
  assert.equal(root.pricingIndex().perBlockRefreshStateKeys.length, clockSensitive ? 2 : 0);
  const physical: { hash: string; to: string; data: string; from?: string }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const run = (item: { id: number; method: string; params: [{ to: string; data: string; from?: string }, { blockHash: string; requireCanonical: boolean }] }) => {
        try {
          assert.equal(item.method, "eth_call"); assert.equal(item.params[1].requireCanonical, true);
          physical.push({ hash: item.params[1].blockHash, ...item.params[0] });
          return { id: item.id, jsonrpc: "2.0", result: f.answer(item.params[0]) };
        } catch { return { id: item.id, jsonrpc: "2.0", error: { code: -32000, message: "synthetic state unavailable" } }; }
      };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(Array.isArray(body) ? body.map(run) : run(body)));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const backends: PinnedRethQuoteBackend[] = [];
  const backendByHash = new Map<string, PinnedRethQuoteBackend>();
  const backend = (at: CanonicalSource) => {
    let value = backendByHash.get(at.hash);
    if (!value) {
      value = new PinnedRethQuoteBackend(`http://127.0.0.1:${address.port}`, at.hash,
        { allowSingleCallFallback: false, maxBatchSize: 32, maxConcurrentBatches: 2 });
      backends.push(value); backendByHash.set(at.hash, value);
    }
    return value;
  };
  const runtime = (at: CanonicalSource, solver = false) => createStrictCentralAdapterRuntime({
    provider: f.provider, executor: EXECUTOR,
    generationFence: { assertCurrent(generation, current) { assert.equal(generation, at.generation); assert.deepEqual(current, at); } },
    ...(solver ? { producerCallCache: backend(at), exactCallBackend: { async call() {
      throw new Error("Solver must reuse producer state bytes");
    } } } : { producerCallBackend: backend(at), exactCallBackend: backend(at) }),
  });
  const graph = (at: CanonicalSource) => createVerifiedGraphView({ id: `balancer-local-fixture-${at.number}`,
    edges: a.graph.edges, sourceBlock: at.number, sourceBlockHash: at.hash, generation: at.generation,
    completenessWatermark: at.number, familyIdForEdge: () => plugin.manifest.familyId,
    perSourceCoverage: [{ familyId: plugin.manifest.familyId, sourceId: "fixture", sourceFingerprint: "local-pricing",
      completeThroughBlock: at.number, completeThroughHash: at.hash }] });
  const coordinator = new StrictCurrentRuntimeCoordinator(request => root.createSession({ source: request.source,
    runtime: runtime(request.source), fundingAssets: [],
    kind: request.purpose === "exact-execution" ? "exact" : "pricing",
    touchedPools: request.touchedPools, requiredEdgeIds: request.requiredEdgeIds, control: request.control }),
  () => {}, undefined, async (pricing, control, _backend, reuse) => {
    const target = reuse?.quoteGraph ?? pricing;
    const at = { number: target.sourceBlock, hash: target.sourceBlockHash, generation: target.generation };
    let session: StrictProductionRuntimeSession | undefined;
    return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous,
      touchedStateKeys: reuse?.touchedStateKeys, control, weth: TOKENS[0], gasCostWei: null,
      disabledEdgeIds: reuse?.disabledEdgeIds,
      enumerationSpreadBps: 50, concurrency: 2,
      prepareQuote: async requiredEdgeIds => { session = await root.createSession({ source: at, runtime: runtime(at),
        fundingAssets: [], kind: "exact", requiredEdgeIds, control }); },
      quote: async request => {
        assert(session); assert.equal(Object.hasOwn(request, "requireChainAmountQuote"), false);
        const exact = await session.issueExact({ ...request, executor: EXECUTOR, runtimeEvidence: [] });
        assert("amountIn" in exact); return exact;
      } });
  });
  try {
    const step = async (at: CanonicalSource, parentHash?: string, observed: readonly string[] = []) => {
      const touched = new Set(observed);
      await coordinator.prepareCoarsePricing({ graph: graph(at), deadlineAtMs: Date.now() + 10_000,
        touchedPools: touched, canonicalActivity: { source: at, parentHash, touchedStateKeys: touched, complete: true } });
      assert.deepEqual([...touched], observed, "the producer must not mutate observed activity");
      return coordinator.latestPricingSnapshot()!;
    };
    const before = await step(SOURCE);
    assert.equal(before.mids.size, 2); assert.equal(before.effectiveMids!.rows.size, 2);
    assert([...before.effectiveMids!.rows.values()].every(row => row.status === "quoted"));
    const expectedReads = localStateRequests(a.descriptor).length;
    assert.equal(physical.length, expectedReads, "both directions/raw/effective issue only unique state reads");
    assert.equal(new Set(physical.map(item => `${item.hash}:${lower(item.to)}:${item.data}:${item.from ?? ""}`)).size, expectedReads);
    const solver = await root.createSession({ source: SOURCE, runtime: runtime(SOURCE, true), fundingAssets: [], kind: "exact",
      requiredEdgeIds: new Set(a.graph.edges.map(edge => edge.canonicalEdgeId!)) });
    for (const edge of a.graph.edges) for (const amountIn of [WAD, 10n * WAD, 100n * WAD]) {
      const quote = await solver.issueExact({ edge, amountIn, executor: EXECUTOR, runtimeEvidence: [] });
      assert(quote.amountOut > 0n);
    }
    assert.equal(physical.length, expectedReads, "new source-bound Solver handles still reuse successful producer bytes");
    const next = { number: 901, hash: ethers.toBeHex(901, 32), generation: 2 };
    if (!clockSensitive) {
      const quiet = await step(next, SOURCE.hash);
      assert.equal(physical.length, expectedReads, "quiet static model needs no new physical state reads");
      for (const [key, row] of before.effectiveMids!.rows) {
        assert.strictEqual(quiet.effectiveMids!.rows.get(key), row);
        assert.equal(quiet.pricingProvenanceByEdgeKey!.get(key), "carried");
      }
      const changedSource = { number: 902, hash: ethers.toBeHex(902, 32), generation: 3 };
      const touched = root.resolveBlockTouchedStateKeys({ kind: "call", target: VAULT, data: "0x" }, changedSource);
      assert.equal(touched.length, 2, "a Vault call without a decoded event still invalidates both directions");
      f.values.balancesRaw[1] *= 2n;
      const changed = await step(changedSource, next.hash, touched);
      assert.equal(physical.length, expectedReads * 2);
      for (const [key, row] of changed.effectiveMids!.rows) {
        assert.equal(row.status, "quoted");
        assert.deepEqual(row.quotedAt, changedSource);
        const edge = a.graph.edges.find(item => blockScanEdgeKey(item) === key)!;
        const route = a.routes.find(item => lower(item.tokenIn) === lower(edge.tokenIn))!;
        assert.equal(row.amountOut, localQuote(f, a.descriptor, route, row.amountIn!, changedSource).result.amountOut);
      }
      f.values.paused = true;
      const failedSource = { number: 903, hash: ethers.toBeHex(903, 32), generation: 4 };
      const failed = await step(failedSource, changedSource.hash, touched);
      for (const row of failed.effectiveMids!.rows.values()) {
        assert.equal(row.status, row.tokenIn === lower(TOKENS[0]) ? "quote-failed" : "missing-valuation");
        assert.equal(row.amountOut, null);
        assert.equal(row.quotedAt, undefined, "pause invalidation must not carry executable stale prices");
      }
      // Only the WETH direction was attempted; missing valuation is not a
      // second failed quote and therefore does not retire this instance.
      f.values.paused = false;
      const expirySource = { number: 904, hash: ethers.toBeHex(904, 32), generation: 5 };
      const readsBeforeExpiry = physical.length;
      const expired = await step(expirySource, failedSource.hash);
      assert.equal(physical.length, readsBeforeExpiry, "quiet pause expiry does not introduce automatic retries");
      for (const [key, row] of failed.effectiveMids!.rows) {
        assert.strictEqual(expired.effectiveMids!.rows.get(key), row);
        assert.equal(row.amountOut, null);
        assert.equal(row.effectiveMid, null);
        assert(!expired.coverage.resolvedEdgeKeys.includes(key));
      }
      const resumed = await step({ number: 905, hash: ethers.toBeHex(905, 32), generation: 6 }, expirySource.hash, touched);
      assert([...resumed.effectiveMids!.rows.values()].every(row => row.status === "quoted"));
      return;
    }
    f.values.rates[1] += WAD / 10n; f.values.amp += 1000n;
    const after = await step(next, SOURCE.hash);
    assert.equal(physical.length, expectedReads * 2, "quiet new source must not reuse stale rates/A");
    for (const [key, row] of before.effectiveMids!.rows) {
      const updated = after.effectiveMids!.rows.get(key)!;
      assert.equal(updated.status, "quoted"); assert.notEqual(updated.amountOut, row.amountOut);
      assert.deepEqual(updated.quotedAt, next); assert.equal(after.pricingProvenanceByEdgeKey!.get(key), "refreshed");
    }
    assert(a.graph.edges.every(edge => after.mids.has(blockScanEdgeKey(edge))));
    f.values.failLocalData = true;
    const failed = await step({ number: 902, hash: ethers.toBeHex(902, 32), generation: 3 }, next.hash);
    assert.deepEqual(failed.mids, before.mids,
      "raw mids remain the frozen startup amount-reference table, not current executable prices");
    assert.equal(failed.effectiveMids!.rows.size, 2);
    for (const row of failed.effectiveMids!.rows.values()) {
      assert.equal(row.status, row.tokenIn === lower(TOKENS[0]) ? "quote-failed" : "missing-valuation");
      assert.equal(row.amountOut, null);
      assert.equal(row.effectiveMid, null);
      assert.equal(row.quotedAt, undefined, "failed rows must not retain executable prices from an earlier source");
    }
    assert(physical.every(item => lower(item.to) !== lower(ROUTER)));
  } finally {
    await Promise.all(backends.map(item => item.closeAndDrain()));
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
}

type PublishedPricing = NonNullable<ReturnType<StrictCurrentRuntimeCoordinator["latestPricingSnapshot"]>>;

// A second genuinely admitted pool supplies token valuation even when the
// subject's WETH direction fails, so both subject directions can be attempted.
async function coordinatorFixture(primary = fixture(),
  support = fixture("weighted-v1", [18, 18], false, OTHER), startupSource = SOURCE) {
  const fixtures = [primary, support];
  const admittedPools = await Promise.all(fixtures.map(f => admitted(f, startupSource)));
  const edges = admittedPools.flatMap(a => a.graph.edges);
  const primaryEdges = admittedPools[0].graph.edges;
  const primaryKeys = primaryEdges.map(blockScanEdgeKey);
  const root = new StrictProductionRuntimeRoot({ catalog: admittedPools[0].catalog, readySource: startupSource,
    readyGraph: edges, readyInstances: admittedPools.flatMap(a => a.lifecycle.publication!.instances), readyFundingAssets: [] });
  assert.deepEqual(root.pricingIndex().perBlockRefreshStateKeys, []);
  const attempts: { source: CanonicalSource; edgeId: string }[] = [];
  const source = (offset: number): CanonicalSource => ({
    number: startupSource.number + offset, hash: ethers.toBeHex(startupSource.number + offset, 32),
    generation: startupSource.generation + offset,
  });
  const runtime = (at: CanonicalSource) => createStrictCentralAdapterRuntime({
    executor: EXECUTOR,
    generationFence: { assertCurrent(generation, current) {
      assert.equal(generation, at.generation); assert.deepEqual(current, at);
    } },
    provider: {
      async getCode() { throw new Error("unexpected current-state code read"); },
      async getStorage() { throw new Error("unexpected current-state storage read"); },
      async call(tx, block) {
        assert.equal(block, at.number);
        if (lower(tx.to) === lower(VAULT)) {
          const decoded = VAULT_ABI.parseTransaction({ data: tx.data }) ??
            LOCAL_VAULT_ABI.parseTransaction({ data: tx.data });
          assert(decoded, "only declared Vault reads are supported");
          if (decoded.args.length === 0) return primary.answer(tx);
          const owner = fixtures.find(f => lower(f.pool) === lower(String(decoded.args[0])));
          assert(owner, "Vault read must bind an admitted fixture pool");
          return owner.answer(tx);
        }
        const owner = fixtures.find(f => lower(f.pool) === lower(tx.to));
        assert(owner, "only admitted pool parameter reads are supported");
        return owner.answer(tx);
      },
    },
  });
  const coordinator = new StrictCurrentRuntimeCoordinator(request => root.createSession({
    source: request.source, runtime: runtime(request.source), fundingAssets: [],
    kind: request.purpose === "exact-execution" ? "exact" : "pricing",
    touchedPools: request.touchedPools, requiredEdgeIds: request.requiredEdgeIds, control: request.control,
  }), () => {}, undefined, async (pricing, control, _backend, reuse) => {
    const target = reuse?.quoteGraph ?? pricing;
    const at = { number: target.sourceBlock, hash: target.sourceBlockHash, generation: target.generation };
    let session: StrictProductionRuntimeSession | undefined;
    return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous,
      touchedStateKeys: reuse?.touchedStateKeys, disabledEdgeIds: reuse?.disabledEdgeIds,
      control, weth: TOKENS[0], gasCostWei: null, enumerationSpreadBps: 50, concurrency: 1,
      prepareQuote: async requiredEdgeIds => {
        session = await root.createSession({ source: at, runtime: runtime(at),
          fundingAssets: [], kind: "exact", requiredEdgeIds, control });
      },
      quote: async request => {
        assert(session);
        attempts.push({ source: at, edgeId: blockScanEdgeKey(request.edge) });
        const exact = await session.issueExact({ ...request, executor: EXECUTOR, runtimeEvidence: [] });
        assert("amountIn" in exact); return exact;
      },
    });
  });
  const step = async (offset: number, vaultTouch = false) => {
    const at = source(offset);
    const observed = vaultTouch ? root.resolveBlockTouchedStateKeys({ kind: "call", target: VAULT, data: "0x" }, at) : [];
    if (vaultTouch) assert.equal(observed.length, edges.length);
    const touched = new Set(observed);
    const graph = createVerifiedGraphView({ id: "balancer-failure-fixture-" + at.number, edges,
      sourceBlock: at.number, sourceBlockHash: at.hash, generation: at.generation,
      completenessWatermark: at.number, familyIdForEdge: () => plugin.manifest.familyId,
      perSourceCoverage: [{ familyId: plugin.manifest.familyId, sourceId: "fixture", sourceFingerprint: "local-pricing-failures",
        completeThroughBlock: at.number, completeThroughHash: at.hash }] });
    await coordinator.prepareCoarsePricing({ graph, deadlineAtMs: Date.now() + 10_000, touchedPools: touched,
      canonicalActivity: { source: at, parentHash: ethers.toBeHex(at.number - 1, 32), touchedStateKeys: touched, complete: true } });
    assert.deepEqual([...touched], observed);
    const snapshot = coordinator.latestPricingSnapshot();
    assert(snapshot?.effectiveMids?.complete);
    return snapshot;
  };
  const rows = (snapshot: PublishedPricing) => primaryKeys.map(key => snapshot.effectiveMids!.rows.get(key)!);
  const attemptedPrimaryKeys = () => attempts.filter(attempt => primaryKeys.includes(attempt.edgeId)).map(attempt => attempt.edgeId).sort();
  const poolData = LOCAL_VAULT_ABI.encodeFunctionData("getPoolData", [primary.pool]);
  const primaryStateReadCount = () => primary.calls.filter(call => call.data === poolData).length;
  return { primary, support, source, step, rows, primaryKeys, attempts, attemptedPrimaryKeys, primaryStateReadCount };
}

test("production coordinator retires fully attempted all-failed pools until a new live startup", async () => {
  const h = await coordinatorFixture();
  const before = await h.step(0);
  assert(h.rows(before).every(row => row.status === "quoted"));
  h.attempts.length = 0;
  h.primary.values.failLocalData = true;
  const failed = await h.step(1, true);
  assert.deepEqual(h.attemptedPrimaryKeys(), [...h.primaryKeys].sort(), "both directions actually attempted Exact");
  for (const row of h.rows(failed)) {
    assert.equal(row.status, "quote-failed");
    assert(row.amountIn !== null && row.amountIn > 0n, "missing valuation cannot stand in for a failed attempt");
    assert.equal(row.amountOut, null);
    assert.equal(row.effectiveMid, null);
    assert.equal(row.quotedAt, undefined);
  }
  assert([...failed.effectiveMids!.rows.values()].filter(row => !h.primaryKeys.includes(row.edgeId))
    .every(row => row.status === "quoted"), "independent valuation remains available");

  h.primary.values.failLocalData = false;
  h.attempts.length = 0;
  const readsAfterFailure = h.primaryStateReadCount();
  for (const [offset, touch] of [[2, false], [3, true], [4, false]] as const) {
    const retired = await h.step(offset, touch);
    for (const row of h.rows(retired)) {
      assert.equal(row.status, "disabled-for-run");
      assert.equal(row.amountOut, null);
      assert.equal(row.effectiveMid, null);
      assert.equal(row.quotedAt, undefined);
      assert(retired.coverage.unavailableEdgeKeys.includes(row.edgeId));
      assert(!retired.coverage.resolvedEdgeKeys.includes(row.edgeId));
    }
    assert.deepEqual(h.attemptedPrimaryKeys(), [], "restored reads and Vault touches must not retry a retired pool");
    assert.equal(h.primaryStateReadCount(), readsAfterFailure);
  }
  const restarted = await coordinatorFixture(h.primary, h.support, h.source(5));
  const recovered = await restarted.step(0);
  assert.deepEqual(restarted.attemptedPrimaryKeys(), [...restarted.primaryKeys].sort());
  for (const row of restarted.rows(recovered)) {
    assert.equal(row.status, "quoted");
    assert(row.amountOut !== null && row.amountOut > 0n);
    assert.deepEqual(row.quotedAt, h.source(5));
  }
});

test("production coordinator carries partial failed rows safely and refreshes eligible directions on touch", async () => {
  const h = await coordinatorFixture();
  const before = await h.step(0);
  const originalBalance = h.primary.values.balancesRaw[0];
  // A real local MaxInRatio failure in WETH->token; the independent pool
  // values token input, so token->WETH can still quote successfully.
  h.primary.values.balancesRaw[0] = before.effectiveMids!.referenceWethInput;
  h.attempts.length = 0;
  const partial = await h.step(1, true);
  assert.deepEqual(h.attemptedPrimaryKeys(), [...h.primaryKeys].sort());
  const failed = h.rows(partial).find(row => row.tokenIn === lower(TOKENS[0]))!;
  const successful = h.rows(partial).find(row => row.tokenIn === lower(TOKENS[1]))!;
  assert.equal(failed.status, "quote-failed");
  assert(failed.amountIn !== null && failed.amountIn > 0n);
  assert.equal(successful.status, "quoted");
  assert(successful.amountOut !== null && successful.amountOut > 0n);
  h.attempts.length = 0;
  const readsAfterPartial = h.primaryStateReadCount();
  const quiet = await h.step(2);
  assert.strictEqual(quiet.effectiveMids!.rows.get(failed.edgeId), failed);
  assert.equal(failed.amountOut, null);
  assert.equal(failed.effectiveMid, null);
  assert.equal(failed.quotedAt, undefined);
  assert(quiet.coverage.unresolvedEdgeKeys.includes(failed.edgeId));
  assert(!quiet.coverage.resolvedEdgeKeys.includes(failed.edgeId));
  assert.strictEqual(quiet.effectiveMids!.rows.get(successful.edgeId), successful);
  assert.equal(quiet.pricingProvenanceByEdgeKey!.get(successful.edgeId), "carried");
  assert(quiet.coverage.resolvedEdgeKeys.includes(successful.edgeId));
  assert.deepEqual(h.attemptedPrimaryKeys(), [], "partial failure does not introduce quiet retries");
  assert.equal(h.primaryStateReadCount(), readsAfterPartial);

  h.primary.values.balancesRaw[0] = originalBalance;
  const refreshed = await h.step(3, true);
  assert.deepEqual(h.attemptedPrimaryKeys(), [...h.primaryKeys].sort(), "a successful direction kept the instance eligible");
  for (const row of h.rows(refreshed)) {
    assert.equal(row.status, "quoted");
    assert(row.amountOut !== null && row.amountOut > 0n);
    assert.deepEqual(row.quotedAt, h.source(3));
    assert.equal(refreshed.pricingProvenanceByEdgeKey!.get(row.edgeId), "refreshed");
    assert.notStrictEqual(row, quiet.effectiveMids!.rows.get(row.edgeId));
  }
});
