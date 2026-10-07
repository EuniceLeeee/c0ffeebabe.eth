import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult } from "../../../adapter-request-program.js";
import { curveUnderlyingStrictFamilyPlugin as family } from "../../curve-underlying-family-plugin.js";
import { CURVE_UNDERLYING_FAMILY_ID, CURVE_UNDERLYING_REGISTRY_LINEAGE_ID } from "../manifest.js";
import { decodeUnderlyingQuoteModel, hasClassicUnderlyingQuoteModel, underlyingQuoteModelBindingRequests } from "../quote-model.js";
import type { CurveUnderlyingIdentity } from "../types.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/classic-meta-binding.json", import.meta.url), "utf8"));
const codes = JSON.parse(gunzipSync(Buffer.from(fixture.runtimeBytecodesGzipBase64, "base64")).toString());
const source = fixture.source;
const pool = codes.meta.address;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const output = (id: string, data: string): AdapterRequestResult => ({
  id, data, ok: true, completion: "returned", source,
  provenance: { kind: "offline-public-chain-fixture", fingerprint: "offline-public-chain-fixture" },
});
function answer(request: AdapterRequest): AdapterRequestResult {
  if (request.kind === "get-code") {
    const code = Object.values(codes).find((c: any) => same(c.address, request.address)) as any;
    assert(code, "uncaptured code request");
    return output(request.id, code.code);
  }
  if (request.kind === "get-storage") {
    const row = fixture.storage.find((s: any) => same(s.address, request.address) && BigInt(s.slot) === BigInt(request.slot));
    assert(row, "uncaptured storage request");
    return output(request.id, row.result);
  }
  assert.equal(request.kind, "eth-call");
  if (request.kind !== "eth-call") throw new Error("unexpected transport");
  const row = fixture.calls.find((c: any) => same(c.to, request.to) && same(c.data, request.data));
  assert(row, "uncaptured eth_call " + request.id + " " + request.data);
  return output(request.id, row.result);
}
const coins = [0, 1, 2, 3].map(index => fixture.samples.find((s: any) => s.i === index).tokenIn);
const bindingRequests = underlyingQuoteModelBindingRequests(codes.meta.code, pool);
const bindingResults = bindingRequests.map(answer);
const quoteModel = decodeUnderlyingQuoteModel(codes.meta.code, pool, coins, bindingResults)!;
assert(quoteModel);
const identity: CurveUnderlyingIdentity = {
  familyId: CURVE_UNDERLYING_FAMILY_ID, lineageId: CURVE_UNDERLYING_REGISTRY_LINEAGE_ID,
  subject: pool, provenance: [], facts: {
    pool, coins, quoteModel,
    registryBinding: { registry: "0xf98b45fa17de75fb1ad0e7afd971b0ca00e379fc", handlers: [pool],
      lookupSemantics: "get_registry_handlers_from_pool+get_underlying_coins" },
    verifiedDirections: fixture.samples.filter((s: any) => s.multiplier === "1").map((s: any) => ({
      i: s.i, j: s.j, tokenIn: s.tokenIn, tokenOut: s.tokenOut,
      behaviorProbeAmountIn: BigInt(s.amountIn), behaviorProbeAmountOut: BigInt(s.actual),
    })),
  },
};
const descriptor = family.instance.finalizeDescriptor({ identity, draft: family.instance.compileDraft(identity), sharedBindings: [] });
const routes = family.routes.project({ descriptor });
function invocation(sample = fixture.samples[0], changedDescriptor = descriptor) {
  const route = routes.find(r => r.i === sample.i && r.j === sample.j)!;
  assert(route);
  return { descriptor: changedDescriptor, route, amountIn: BigInt(sample.amountIn), source,
    executor: "0x1000000000000000000000000000000000000002", runtimeEvidence: [] };
}
function method(input: ReturnType<typeof invocation>) {
  const value = family.exact.methods(input)[1];
  assert.equal(value.kind, "request-program");
  if (value.kind !== "request-program") throw new Error("request program expected");
  return value;
}
function quote(input: ReturnType<typeof invocation>, modify?: (r: AdapterRequestResult[]) => AdapterRequestResult[]) {
  const m = method(input), initial = m.program.buildRequests(input).map(answer);
  const results = modify ? modify(initial) : initial;
  const next = m.program.buildDependentProgram?.({ programInput: input, completedRound: 0, initialResults: results, priorEvidence: [] });
  const dependentEvidence = next ? [next.decode(next.requests.map(answer))] : [];
  assert.equal(m.program.buildDependentProgram?.({ programInput: input, completedRound: 1,
    initialResults: results, priorEvidence: dependentEvidence }), null);
  return m.program.decode({ programInput: input, initialResults: results, dependentEvidence });
}

test("complete proxy shape and independently matched runtimes bind model, not pool address", () => {
  for (const c of Object.values(codes) as any[]) assert.equal(ethers.keccak256(c.code), c.keccak);
  assert.equal(fixture.compilerMatches.meta.exactRuntimeMatch, true);
  assert.equal(fixture.compilerMatches.base.exactRuntimeMatch, true);
  assert.equal(quoteModel.metaRateMultiplier, 10n ** 18n);
  assert.equal(quoteModel.baseLPToken.toLowerCase(), "0x6c3f90f043a72fa612cbac8115ee7e52bde6e490");
  assert.equal(hasClassicUnderlyingQuoteModel("0x00" + codes.meta.code.slice(2)), false);
  assert.equal(decodeUnderlyingQuoteModel("0x6000", pool, coins, []), undefined);
  assert(decodeUnderlyingQuoteModel(codes.meta.code, "0x1000000000000000000000000000000000000099", coins, bindingResults),
    "instance address is not an allowlist criterion");
});

for (const sample of fixture.samples) {
  test("saved N-state execution parity: " + sample.i + "->" + sample.j + " " + sample.multiplier + "P", () => {
    const input = invocation(sample), result = quote(input);
    assert.equal(result.amountOut, BigInt(sample.actual));
    assert.equal(result.evidence.amountIn, BigInt(sample.amountIn));
    assert.equal(result.evidence.kind, "curve-underlying-classic-meta");
    assert.equal(method(input).chainAmountQuote, sample.i === 0 ? true : undefined,
      "local amount math must not be labeled chain-produced");
    const fragment = family.execution.buildFragment({ ...input, exactEvidence: result.evidence,
      quotedAmountOut: result.amountOut, minAmountOut: result.amountOut });
    assert.equal(fragment.nodes[0].params.minDy, result.amountOut, "no lowered minimum/tolerance");
  });
}

test("nine prior mismatches remain visible instead of rewriting baseline output", () => {
  assert.equal(fixture.samples.filter((s: any) => s.priorQuote !== s.actual).length, 9);
});
test("known runtime/hash, LP, source or coin mismatch fails instead of view fallback", () => {
  const corrupt = (id: string, data: string) => bindingResults.map(r => r.id === id ? output(id, data) : r);
  for (const id of ["model-implementation-code", "model-base-code"]) {
    assert.throws(() => decodeUnderlyingQuoteModel(codes.meta.code, pool, coins, corrupt(id, "0x6000")), /bound runtime/);
  }
  for (const id of ["model-meta-lp", "model-base-lp", "model-base-coin:1"]) {
    assert.throws(() => decodeUnderlyingQuoteModel(codes.meta.code, pool, coins, corrupt(id, ethers.toBeHex(99, 32))), /topology/);
  }
  assert.throws(() => decodeUnderlyingQuoteModel(codes.meta.code, pool, coins,
    bindingResults.slice(1)), /missing/);
  assert.throws(() => decodeUnderlyingQuoteModel(codes.meta.code, pool, coins,
    bindingResults.map((r, i) => i === 0 ? { ...r, source: { ...source, generation: source.generation + 1 } } : r)), /mixed sources/);
});

test("per-source implementation/rate/topology changes cannot publish a quote", () => {
  const input = invocation(fixture.samples.find((s: any) => s.i === 1 && s.j === 2));
  for (const id of ["classic-pool-code", "classic-implementation-code", "classic-base-code",
    "classic-meta-rate", "classic-meta-coin", "classic-meta-lp"]) {
    assert.throws(() => quote(input, results => results.map(r => r.id === id
      ? output(id, id.endsWith("-code") ? "0x6000" : ethers.toBeHex(99, 32)) : r)), /changed/);
  }
  assert.throws(() => quote(input, results => results.map((r, i) => i === 0
    ? { ...r, source: { ...source, number: source.number + 1 } } : r)), /source mismatch/);
  assert.throws(() => quote(input, results => results.filter(r => r.id !== "classic-base-fee")), /missing/);
});

test("USDT fee/pause/deprecation guard is same-source and fail-closed", () => {
  const input = invocation(fixture.samples.find((s: any) => s.i === 1 && s.j === 3));
  for (const id of ["classic-usdt-paused", "classic-usdt-deprecated"]) {
    assert.throws(() => quote(input, results => results.map(r => r.id === id ? output(id, ethers.toBeHex(1, 32)) : r)), /transfer mode/);
  }
  assert.throws(() => quote(input, results => results.map(r =>
    r.id === "classic-usdt-basisPointsRate" || r.id === "classic-usdt-maximumFee"
      ? output(r.id, ethers.toBeHex(1, 32)) : r)), /transfer mode/);
});

test("unknown implementation preserves explicit chain amount interface", () => {
  const input = invocation(fixture.samples[0], { ...descriptor, quoteModel: undefined });
  const m = method(input);
  assert.equal(m.chainAmountQuote, true);
  assert.equal(m.program.buildRequests(input).length, 1);
});
test("quote-free runtime leg still constructs without amount or Exact access", () => {
  for (const route of routes) {
    const leg = family.execution.buildRuntimeLeg!({ descriptor, route, executor: invocation().executor, runtimeEvidence: [],
      get amountIn() { throw new Error("amount access"); },
      get exactEvidence() { throw new Error("Exact access"); },
    } as any);
    assert(leg);
  }
});
test("base pool and LP changes refresh through both Family mutation entrypoints", () => {
  const route = routes[0];
  const pd = family.pricing.finalizePricingDescriptor({ sharedBindings: [],
    draft: family.pricing.compileDraft({ descriptor, routes: [route], stateKey: route.routeKey }) });
  const dependencies = family.pricing.dependencies({ descriptor: pd, routes: [route] });
  assert.equal(dependencies.length, new Set(dependencies.map(address => address.toLowerCase())).size,
    "production pricing materialization rejects duplicate coin/control dependencies");
  for (const address of [quoteModel.basePool, quoteModel.baseLPToken]) {
    assert(dependencies.some(x => same(x, address)));
    const observation = { kind: "log" as const, address, source, topics: [], data: "0x" };
    assert.deepEqual(family.pricing.mutation!.affectedStateKeys({ descriptor: pd, routes: [route], observation }), [route.routeKey]);
    const compiled = family.pricing.mutation!.compile!({ entries: [{ descriptor: pd, routes: [route], dependencies, stateKey: route.routeKey }] });
    assert.deepEqual(compiled.affectedStateKeys({ observation }), [route.routeKey.toLowerCase()]);
  }
  assert.deepEqual(family.pricing.mutation!.affectedStateKeys({ descriptor: pd, routes: [route],
    observation: { kind: "log", address: coins[1], source, topics: [], data: "0x" } }), [],
    "unrelated token logs do not expand refresh scope");
});
test("fractional meta multiplier composes direct LP quote then base withdrawal", () => {
  const input = invocation(fixture.samples[0], { ...descriptor, quoteModel: { ...quoteModel, metaRateMultiplier: 5n * 10n ** 17n } });
  const m = method(input), iface = new ethers.Interface(["function get_dy(int128,int128,uint256) view returns (uint256)",
    "function calc_withdraw_one_coin(uint256,int128) view returns (uint256)"]);
  const requests = m.program.buildRequests(input);
  const direct = requests.find(r => r.id === "classic-meta-quote")!;
  assert(direct.kind === "eth-call");
  assert.equal(direct.data, iface.encodeFunctionData("get_dy", [0, 1, input.amountIn]));
  const results = requests.map(r => r.id === "classic-meta-quote" ? output(r.id, ethers.toBeHex(123, 32))
    : r.id === "classic-meta-rate" ? output(r.id, ethers.toBeHex(input.descriptor.quoteModel!.metaRateMultiplier, 32)) : answer(r));
  const next = m.program.buildDependentProgram!({ programInput: input, completedRound: 0, initialResults: results, priorEvidence: [] });
  assert(next);
  const withdrawal = next.requests[0];
  assert(withdrawal.kind === "eth-call");
  assert.equal(withdrawal.to, quoteModel.basePool);
  assert.equal(withdrawal.data, iface.encodeFunctionData("calc_withdraw_one_coin", [123, input.route.j - 1]));
  const result = m.program.decode({ programInput: input, initialResults: results,
    dependentEvidence: [next.decode([output(withdrawal.id, ethers.toBeHex(99, 32))])] });
  assert.equal(result.amountOut, 99n, "synthetic contract case, not historical amount evidence");
});

test("USDT control changes refresh while ordinary transfers remain excluded", () => {
  const route = routes[0];
  const pd = family.pricing.finalizePricingDescriptor({ sharedBindings: [],
    draft: family.pricing.compileDraft({ descriptor, routes: [route], stateKey: route.routeKey }) });
  const dependencies = family.pricing.dependencies({ descriptor: pd, routes: [route] });
  const compiled = family.pricing.mutation!.compile!({ entries: [{ descriptor: pd, routes: [route],
    dependencies, stateKey: route.routeKey }] });
  for (const signature of ["Params(uint256,uint256)", "Pause()", "Unpause()", "Deprecate(address)", "Transfer(address,address,uint256)", "Approval(address,address,uint256)"]) {
    const observation = { kind: "log" as const, address: quoteModel.baseCoins[2], source,
      topics: [ethers.id(signature)], data: "0x" };
    const expected = signature.startsWith("Transfer") || signature.startsWith("Approval") ? [] : [route.routeKey.toLowerCase()];
    assert.deepEqual(compiled.affectedStateKeys({ observation }), expected);
    assert.deepEqual(family.pricing.mutation!.affectedStateKeys({ descriptor: pd, routes: [route], observation }), expected);
  }
});
test("active base/meta ramps cannot be carried by on-touch pricing", () => {
  const input = invocation(fixture.samples[0]);
  for (const id of ["classic-base-future-A", "classic-meta-future-A"]) {
    assert.throws(() => quote(input, results => results.map(r => r.id === id ? output(id, ethers.toBeHex(123, 32)) : r)), /active A ramp/);
  }
});
