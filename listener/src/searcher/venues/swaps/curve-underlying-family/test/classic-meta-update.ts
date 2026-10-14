import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { ethers } from "ethers";
import type { AdapterRequestResult } from "../../../adapter-request-program.js";
import { curveUnderlyingStrictFamilyPlugin as family } from "../../curve-underlying-family-plugin.js";
import { CURVE_UNDERLYING_REGISTRY_LINEAGE_ID } from "../manifest.js";
import { assertClassicMetaUpdate, classicMetaUpdateRequests } from "../classic-meta-update.js";
import { classicMetaChecksUpdate, classicMetaRateSlot, classicMetaScalar, hasClassicUnderlyingQuoteModel,
  hasLegacyV1UnderlyingQuoteModel, supportsClassicUnderlyingRecipient } from "../quote-model.js";
import type { CurveUnderlyingClassicMetaBinding, CurveUnderlyingDescriptor } from "../types.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/classic-meta-update-binding.json", import.meta.url), "utf8"));
const codes = JSON.parse(gunzipSync(Buffer.from(fixture.codesGzipBase64, "base64")).toString());
const source = fixture.source;
const MAX = (1n << 256n) - 1n;
const word = (v: bigint | number) => ethers.toBeHex(v, 32);
const forward = (...words: bigint[]) => "0x" + words.map(v => word(v).slice(2)).join("").padEnd(8192, "0");
const COINS = ["0x853d955acef822db058eb8505911ed77f175b99e", "0x6b175474e89094c44da98b954eedeac495271d0f",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7"];
const model: CurveUnderlyingClassicMetaBinding = {
  kind: "classic-meta-base-3pool-v1", poolCodeHash: ethers.keccak256(codes.pool),
  metaRateMultiplier: 10n ** 18n, implementation: fixture.implementation,
  implementationCodeHash: ethers.keccak256(codes.implementation), basePool: "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7",
  baseCodeHash: "0x954a1e212c557c85043985931498ffa3e2fcbe7dfe9cd61513f36eb47d6f4dfc",
  baseLPToken: "0x6c3f90f043a72fa612cbac8115ee7e52bde6e490", baseCoins: COINS.slice(1),
  basePrecisions: [1n, 10n ** 12n, 10n ** 12n],
};
const binding = { pool: fixture.pool, quoteModel: model };
const ok = (id: string, data: string): AdapterRequestResult => ({ id, data, ok: true, completion: "returned", source,
  provenance: { kind: "captured-public-read", fingerprint: fixture.evidenceSha256 } });
const initial = classicMetaUpdateRequests(binding).map(request => {
  if (request.kind === "get-code") {
    const name = request.id.replace("classic-update-", "").replace("-code", "");
    assert(codes[name]); return ok(request.id, codes[name]);
  }
  assert(request.kind === "eth-call");
  const saved = fixture.calls.find((row: any) => row.params[0].to.toLowerCase() === request.to.toLowerCase() &&
    row.params[0].data === request.data);
  assert(saved, request.id); return ok(request.id, saved.result);
});
const replace = (changes: Record<string, string>, rows = initial) => rows.map(row =>
  changes[row.id] === undefined ? row : ok(row.id, changes[row.id]));
const check = (changes: Record<string, string> = {}) => assertClassicMetaUpdate(binding, source, replace(changes));

test("historical 5f code selects slot12/scalar shape/receiver without widening V1 factory identity", () => {
  assert.equal(hasClassicUnderlyingQuoteModel(codes.pool), true);
  assert.equal(hasLegacyV1UnderlyingQuoteModel(codes.pool), false);
  assert.equal(classicMetaChecksUpdate(model), true);
  assert.equal(classicMetaRateSlot(model), 12);
  assert.equal(supportsClassicUnderlyingRecipient(model), true);
  assert.equal(hasClassicUnderlyingQuoteModel("0x00" + codes.pool.slice(2)), false);
  assert.equal(classicMetaChecksUpdate({ ...model, implementationCodeHash: ethers.ZeroHash }), false);
  assert.equal(classicMetaScalar(model, forward(7n)), word(7));
  assert.throws(() => classicMetaScalar(model, word(7)), /forwarder/);
  check(); // At captured N, pool last equals the independent block timestamp.
  const clock = initial.find(r => r.id === "classic-update-time")!;
  assert(clock.ok); assert.equal(BigInt(clock.data), BigInt(source.timestamp));
});

test("update checks two uint256 products/sums but skips them at zero elapsed", () => {
  const time = BigInt(source.timestamp), base = { "classic-update-time": word(time + 1n),
    "classic-update-balance:0": forward(1n), "classic-update-balance:1": forward(2n) };
  check({ ...base, "classic-update-cumulative": forward(MAX - 1n, MAX - 2n) });
  for (const index of [0, 1]) {
    assert.throws(() => check({ ...base, "classic-update-time": word(time + 2n),
      ["classic-update-balance:" + index]: forward(MAX) }), /multiplication overflow/);
    assert.throws(() => check({ ...base, "classic-update-cumulative": index === 0
      ? forward(MAX, 0n) : forward(0n, MAX) }), /addition overflow/);
  }
  check({ "classic-update-balance:0": forward(MAX), "classic-update-balance:1": forward(MAX),
    "classic-update-cumulative": forward(MAX, MAX) });
  assert.throws(() => check({ "classic-update-time": word(time - 1n) }), /timestamp underflow/);
});

test("update rejects wrong source/code, missing evidence and noncanonical independent clock", () => {
  for (const id of ["classic-update-pool-code", "classic-update-implementation-code", "classic-update-clock-code"]) {
    assert.throws(() => check({ [id]: "0x" }), /code changed/);
  }
  for (const data of ["0x", "0x01", forward(BigInt(source.timestamp))]) {
    assert.throws(() => check({ "classic-update-time": data }), /malformed/);
  }
  for (const changed of [{ ...source, number: source.number + 1 }, { ...source, hash: ethers.ZeroHash },
    { ...source, generation: source.generation + 1 }]) {
    assert.throws(() => assertClassicMetaUpdate(binding, changed, initial), /source mismatch/);
  }
  assert.throws(() => assertClassicMetaUpdate(binding, source, initial.filter(r => r.id !== "classic-update-time")), /missing/);
  assert.throws(() => check({ "classic-update-time": word(BigInt(source.timestamp) + 1n),
    "classic-update-cumulative": word(1) }), /forwarder/);
});

test("unrelated models retain their original dependencies and requests", () => {
  assert.deepEqual(classicMetaUpdateRequests({ pool: fixture.pool }), []);
  assert.doesNotThrow(() => assertClassicMetaUpdate({ pool: fixture.pool }, source, []));
});

// Synthetic admission facts isolate the production pricing/Exact contracts.
// Historical discovery, dual execution and direct-recipient acceptance are separate.
const identity = { familyId: family.manifest.familyId, lineageId: CURVE_UNDERLYING_REGISTRY_LINEAGE_ID,
  subject: fixture.pool, provenance: [], facts: { ...binding, coins: COINS,
    registryBinding: { registry: "0xb9fc157394af804a3578134a6585c0dc9cc990d4", handlers: [fixture.pool],
      lookupSemantics: "get_base_pool+get_underlying_coins", basePool: model.basePool },
    verifiedDirections: COINS.flatMap((tokenIn, i) => COINS.flatMap((tokenOut, j) => i === j ? [] : [{
      i, j, tokenIn, tokenOut, behaviorProbeAmountIn: 1n, behaviorProbeAmountOut: 1n }])) } } as any;
const descriptor = family.instance.finalizeDescriptor({ identity, draft: family.instance.compileDraft(identity), sharedBindings: [] }) as CurveUnderlyingDescriptor;
const routes = family.routes.project({ descriptor });

test("all twelve Exact/runtime directions include cumulative guards and preserve optional recipient", () => {
  assert.equal(routes.length, 12);
  for (const route of routes) {
    const input = { descriptor, route, source, amountIn: 1n, executor: "0x1000000000000000000000000000000000000002", runtimeEvidence: [] };
    const m = family.exact.methods(input)[1]; assert(m.kind === "request-program");
    assert(m.program.buildRequests(input).some(r => r.id === "classic-update-time"));
    const pd = family.pricing.finalizePricingDescriptor({ sharedBindings: [],
      draft: family.pricing.compileDraft({ descriptor, routes: [route], stateKey: route.routeKey }) });
    assert.equal(family.pricing.refreshPolicyForInstance!({ descriptor: pd, routes: [route] }), "each-block");
    assert(family.pricing.dependencies({ descriptor: pd, routes: [route] }).includes(fixture.clock));
    const recipient = "0x1000000000000000000000000000000000000004";
    const leg = family.execution.buildRuntimeLeg!({ descriptor, route, executor: input.executor, runtimeEvidence: [],
      settlement: { kind: "direct-output", recipient } } as any);
    assert(leg); assert.deepEqual(leg.settlement, { directOutput: true });
    assert.deepEqual(leg.settlementRequest, { kind: "direct-output", recipient });
    assert.equal(family.execution.buildRuntimeLeg!({ ...input, settlement: { kind: "deferred-input" } } as any), null);
  }
});

test("raw pricing rejects a bad update instead of publishing a positive view", () => {
  const route = routes[0];
  const pd = family.pricing.finalizePricingDescriptor({ sharedBindings: [],
    draft: family.pricing.compileDraft({ descriptor, routes: [route], stateKey: route.routeKey }) });
  const current: any = { descriptor: pd, source, routes: [route], runtimeEvidence: [] };
  const state = family.pricing.current;
  const rows = state.buildRequests(current).map(r => {
    const captured = initial.find(x => x.id === r.id); if (captured) return captured;
    if (r.id === "current-token-decimals") return ok(r.id, word(18));
    return { id: r.id, ok: false, failure: "rpc", source } as AdapterRequestResult;
  });
  const next = state.buildDependentProgram!({ current, completedRound: 0, initialResults: rows, priorEvidence: [] }); assert(next);
  const evidence = [next.decode(next.requests.map(r => ok(r.id, forward(1_000_000n))))];
  const decode = (initialResults: readonly AdapterRequestResult[]) => state.decodeSnapshot({ ...current, initialResults, dependentEvidence: evidence });
  assert(decode(rows).amountOut > 0n);
  const broken = replace({ "classic-update-time": word(BigInt(source.timestamp) - 1n) }, rows);
  assert.throws(() => state.buildDependentProgram!({ current, completedRound: 0, initialResults: broken, priorEvidence: [] }), /timestamp underflow/);
  assert.throws(() => decode(broken), /timestamp underflow/);
  assert.equal(decode(rows).amountOut, 1_000_000n, "restored source-bound state restores raw pricing");
});


test("base-to-base Exact decode rejects a bad update even though its math does not use the meta reserves", () => {
  const savedBase = JSON.parse(readFileSync(new URL("./fixtures/classic-meta-binding.json", import.meta.url), "utf8"));
  const baseCodes = JSON.parse(gunzipSync(Buffer.from(savedBase.runtimeBytecodesGzipBase64, "base64")).toString());
  const route = routes.find(r => r.i === 1 && r.j === 2)!; assert(route);
  const input = { descriptor, route, source, amountIn: 10n ** 20n,
    executor: "0x1000000000000000000000000000000000000002", runtimeEvidence: [] };
  const method = family.exact.methods(input)[1]; assert(method.kind === "request-program");
  const values: Record<string, string> = {
    "classic-pool-code": codes.pool, "classic-implementation-code": codes.implementation,
    "classic-base-code": (Object.values(baseCodes) as any[]).find(c => c.address.toLowerCase() === model.basePool).code,
    "classic-meta-rate": word(model.metaRateMultiplier), "classic-meta-coin": forward(BigInt(COINS[0])),
    "classic-meta-lp": forward(BigInt(model.baseLPToken)), "classic-meta-A": forward(74022n),
    "classic-meta-future-A": forward(80000n), "classic-base-A": word(2730), "classic-base-future-A": word(3000),
    "classic-base-fee": word(4000000), "classic-base-supply": word(3n * 10n ** 24n),
    "classic-base-balance:0": word(10n ** 24n), "classic-base-balance:1": word(10n ** 12n),
    "classic-base-balance:2": word(10n ** 12n),
  };
  const rows = method.program.buildRequests(input).map(r => {
    const captured = initial.find(x => x.id === r.id); if (captured) return captured;
    assert(values[r.id], r.id); return ok(r.id, values[r.id]);
  });
  const decode = (initialResults: readonly AdapterRequestResult[]) => method.program.decode({
    programInput: input, initialResults, dependentEvidence: [] });
  assert(decode(rows).amountOut > 0n);
  assert.throws(() => decode(replace({ "classic-update-time": word(BigInt(source.timestamp) - 1n) }, rows)), /timestamp underflow/);
  assert.throws(() => decode(replace({ "classic-update-time": word(BigInt(source.timestamp) + 1n),
    "classic-update-cumulative": forward(MAX, MAX) }, rows)), /addition overflow/);
});
