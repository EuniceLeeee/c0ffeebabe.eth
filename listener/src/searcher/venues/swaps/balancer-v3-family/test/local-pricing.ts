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
import { blockScanEdgeKey, createVerifiedGraphView } from "../../../blockscan-state-capability.js";
import { admitToGraph, localCatalog } from "../../../../test/family-integration/balancer-v3/lifecycle.js";
import { VAULT, ROUTER, PERMIT2, VAULT_ABI, POOL_ABI, ROUTER_ABI, TOKEN_ABI, SWAP_ABI,
  MAX_INPUT, MAX_UINT, lower, probeAmounts } from "../codec.js";
import { LOCAL_VAULT_ABI, LOCAL_POOL_ABI, decodeLocalState, localStateRequests, quoteLocal } from "../local-state.js";
import { classifyBalancerPoolCode, type BalancerLocalModel } from "../local-model.js";
import { BALANCER_MODEL_TEMPLATES } from "../local-math/model-templates.js";
import type { BalancerV3Descriptor, BalancerV3PricingDescriptor, BalancerV3Snapshot } from "../types.js";
import { BALANCER_VAULT_EXTENSION, BALANCER_VAULT_ADMIN } from "../vault-model.js";
import { syntheticBalancerVaultCodes } from "./local-vault-fixture.js";

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

function fixture(model: BalancerLocalModel | null = "weighted-v1", decimals = [18, 18], withRates = false) {
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
    if (lower(tx.to) === lower(POOL)) {
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
      return index >= 0 ? vaultCodes[index] : lower(address) === lower(POOL) ? code : "0x60006000";
    },
    async getStorage() { throw new Error("unexpected storage read"); },
  };
  const result = (request: AdapterRequest, source = SOURCE): AdapterRequestResult => {
    assert.equal(request.kind, "eth-call");
    if (request.kind !== "eth-call") throw new Error("fixture only decodes state calls");
    return { id: request.id, ok: true, completion: "returned", data: answer(request), source,
      provenance: { kind: "fixture", fingerprint: "balancer-local-state-fixture" } };
  };
  return { model, values, calls, code, vaultCodes, answer, provider, result };
}

const catalogPromise = localCatalog();
async function admitted(f: ReturnType<typeof fixture>, source = SOURCE) {
  const catalog = await catalogPromise;
  const observation = { kind: "log" as const, address: VAULT, source,
    ...SWAP_ABI.encodeEventLog(SWAP_ABI.getEvent("Swap")!, [POOL, ...TOKENS, WAD, WAD - 1n, 0, 0]) };
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
    assert.equal(plugin.pricing.refreshPolicy, "each-block");
    for (const route of a.routes) {
      const pricing = a.instance.pricingInstances.find(item => item.routes.some(r => r.routeKey === route.routeKey))!;
      const pricingDescriptor = pricing.pricingDescriptor as BalancerV3PricingDescriptor;
      const pricingRoutes = pricing.routes as readonly Route[];
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

test("production raw/effective and Solver share source-pinned physical state reads; new source refreshes without touches", async () => {
  const f = fixture("stable-v3", [18, 18], true), a = await admitted(f);
  const root = new StrictProductionRuntimeRoot({ catalog: a.catalog, readySource: SOURCE,
    readyGraph: a.graph.edges, readyInstances: a.lifecycle.publication!.instances, readyFundingAssets: [] });
  assert.equal(root.pricingIndex().perBlockRefreshStateKeys.length, 2);
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
    runtime: runtime(request.source), fundingAssets: [], kind: "pricing", touchedPools: request.touchedPools, control: request.control }),
  () => {}, undefined, async (pricing, control, _backend, reuse) => {
    const target = reuse?.quoteGraph ?? pricing;
    const at = { number: target.sourceBlock, hash: target.sourceBlockHash, generation: target.generation };
    let session: StrictProductionRuntimeSession | undefined;
    return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous,
      touchedStateKeys: reuse?.touchedStateKeys, control, weth: TOKENS[0], gasCostWei: null,
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
    const step = async (at: CanonicalSource, parentHash?: string) => {
      const touched = new Set<string>();
      await coordinator.prepareCoarsePricing({ graph: graph(at), deadlineAtMs: Date.now() + 10_000,
        touchedPools: touched, canonicalActivity: { source: at, parentHash, touchedStateKeys: touched, complete: true } });
      assert.equal(touched.size, 0);
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
    assert.equal(failed.mids.size, 0, "failed new-source reads must not carry last source's local raw price");
    assert.equal(failed.effectiveMids!.rows.size, 0);
    assert(physical.every(item => lower(item.to) !== lower(ROUTER)));
  } finally {
    await Promise.all(backends.map(item => item.closeAndDrain()));
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
