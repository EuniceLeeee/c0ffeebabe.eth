import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult } from "../../../adapter-request-program.js";
import { curveUnderlyingStrictFamilyPlugin as family } from "../../curve-underlying-family-plugin.js";
import { LEGACY_PLAIN_ABI as abi, LEGACY_PLAIN_CODE_HASH, decodeLegacyPlainBinding,
  decodeLegacyPlainState, hasLegacyPlainModel, legacyPlainBindingRequests,
  legacyPlainQuoteRequests, quoteLegacyPlain, LEGACY_PLAIN_KILLED_SLOT } from "../legacy-plain.js";
import { CURVE_BEHAVIOR_PROBE_AMOUNTS, CURVE_METAREGISTRY, CURVE_UNDERLYING_META_INTERFACE,
  CURVE_UNDERLYING_POOL_INTERFACE } from "../codec.js";
import type { CurveUnderlyingCandidate, CurveUnderlyingIdentityEvidence } from "../types.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/legacy-plain-susd.json", import.meta.url), "utf8"));
const code = gunzipSync(Buffer.from(fixture.runtimeGzipBase64, "base64")).toString();
const state = { balances: fixture.balances.map(BigInt), amplification: BigInt(fixture.amplification), fee: BigInt(fixture.fee), adminFee: BigInt(fixture.adminFee), killed: fixture.killed };
const binding = { kind: "legacy-plain-four-no-lending" as const, poolCodeHash: LEGACY_PLAIN_CODE_HASH };
const source = fixture.source;
const result = (id: string, data: string): AdapterRequestResult => ({ id, data, ok: true, completion: "returned",
  source, provenance: { kind: "public-state-with-synthetic-unit-transport", fingerprint: "legacy-plain-susd" } });
const returned = (request: AdapterRequest): AdapterRequestResult => {
  if (request.kind === "get-code") return result(request.id, code);
  if (request.kind === "get-storage") {
    assert.equal(request.slot, LEGACY_PLAIN_KILLED_SLOT);
    return result(request.id, ethers.toBeHex(state.killed ? 1 : 0, 32));
  }
  assert.equal(request.kind, "eth-call");
  if (request.kind !== "eth-call") throw new Error("unexpected unit transport");
  const parsed = abi.parseTransaction({ data: request.data }); assert(parsed);
  const i = Number(parsed.args.length ? parsed.args[0] : 0);
  const value = parsed.name === "A" ? state.amplification : parsed.name === "fee" ? state.fee
    : parsed.name === "admin_fee" ? state.adminFee : parsed.name === "balances" ? state.balances[i] : fixture.coins[i];
  return result(request.id, abi.encodeFunctionResult(parsed.name, [value]));
};
test("legacy plain binds implementation semantics and reverse on-chain coin topology", () => {
  assert(hasLegacyPlainModel(code)); assert(!hasLegacyPlainModel(code + "00"));
  const requests = legacyPlainBindingRequests(code, fixture.pool);
  assert.equal(requests.length, 8);
  assert.deepEqual(decodeLegacyPlainBinding(code, fixture.coins, requests.map(returned)), binding);
  assert.throws(() => decodeLegacyPlainBinding(code, [...fixture.coins].reverse(), requests.map(returned)), /topology/);
  assert.equal(decodeLegacyPlainBinding("0x6000", fixture.coins, []), undefined);
  const reads = requests.map(returned);
  reads[0] = { ...reads[0], source: { ...source, number: source.number - 1 } };
  assert.throws(() => decodeLegacyPlainBinding(code, fixture.coins, reads), /source/i);
});
for (const [index, row] of fixture.actualExecutionAnchors.entries()) {
  test(`legacy plain actual N-end execution anchor ${index}: full input and exact normalized fee`, () => {
    const i = fixture.coins.findIndex((t: string) => t.toLowerCase() === row.tokenIn);
    const j = fixture.coins.findIndex((t: string) => t.toLowerCase() === row.tokenOut);
    const expected = BigInt(row.independentBalances.output.delta);
    assert.equal(quoteLegacyPlain(state, i, j, BigInt(row.amountIn)), expected);
    assert.equal(BigInt(row.independentBalances.input.delta), -BigInt(row.amountIn));
    assert.equal(BigInt(row.oldQuoteAmountOut) - expected, index === 2 ? 1n : 0n);
  });
}
test("legacy plain rejects foreign state, replaced code, overflow and invalid direction", () => {
  const reads = legacyPlainQuoteRequests(fixture.pool).map(returned);
  assert.deepEqual(decodeLegacyPlainState(binding, source, reads), state);
  assert.throws(() => decodeLegacyPlainState(binding, { ...source, hash: ethers.ZeroHash }, reads), /foreign source/);
  assert.throws(() => decodeLegacyPlainState({ ...binding, poolCodeHash: ethers.ZeroHash }, source, reads), /unknown/);
  assert.throws(() => decodeLegacyPlainState(binding, source, [result("legacy-plain-code", "0x6000"), ...reads.slice(1)]), /runtime changed/);
  assert.equal(quoteLegacyPlain(state, 0, 1, 0n), 0n);
  assert.throws(() => quoteLegacyPlain(state, 0, 0, 1n), /direction/);
  assert.throws(() => quoteLegacyPlain(state, 0, 1, -1n), /overflow/);
  assert.throws(() => quoteLegacyPlain(state, 0, 1, (1n << 256n) - 1n), /overflow/);
  // The input conversion fits, but the later balance write x*ONE does not.
  const limit = ((1n << 256n) - 1n) / 10n ** 18n;
  assert(quoteLegacyPlain(state, 0, 1, limit - state.balances[0]) > 0n);
  assert.throws(() => quoteLegacyPlain(state, 0, 1, limit - state.balances[0] + 1n), /overflow/);
  assert.throws(() => quoteLegacyPlain(state, 0, 1, limit), /overflow/);
  assert.throws(() => quoteLegacyPlain({ ...state, killed: true }, 0, 1, 1n), /killed/);
  assert.throws(() => quoteLegacyPlain({ ...state, adminFee: 10n ** 10n }, 0, 1, 1n), /admin fee/);
  assert.throws(() => decodeLegacyPlainState(binding, source, reads.map(r =>
    r.id === "legacy-plain-killed" ? result(r.id, ethers.toBeHex(2n, 32)) : r)), /killed state/);
});
const variant = family.identity.variants[0];
const candidate: CurveUnderlyingCandidate = { candidateKind: "curve-underlying-pool", pool: fixture.pool,
  sourceKind: "underlying-swap-log", hintedI: 2, hintedJ: 0 };
function begin(allPositive = false): CurveUnderlyingIdentityEvidence {
  const zero = ethers.ZeroAddress;
  const surface = variant.decode({ step: { candidate, step: 0 }, results: [
    result("registry-handlers", CURVE_UNDERLYING_META_INTERFACE.encodeFunctionResult("get_registry_handlers_from_pool",
      [[fixture.pool, ...Array(9).fill(zero)]])),
    result("registry-underlying-coins", CURVE_UNDERLYING_META_INTERFACE.encodeFunctionResult("get_underlying_coins",
      [[...fixture.coins, ...Array(4).fill(zero)]])), result("pool-code", code),
  ] });
  const step = { candidate, step: 1, evidence: surface };
  return variant.decode({ step, results: variant.buildRequests(step).map(request => {
    if (!request.id.startsWith("behavior-get-dy:")) return returned(request);
    const [, i, j] = request.id.split(":").map(Number);
    return result(request.id, CURVE_UNDERLYING_POOL_INTERFACE.encodeFunctionResult("get_dy_underlying",
      [!allPositive && i === 3 && (j === 1 || j === 2) ? 0n : 1n]));
  }) }) as CurveUnderlyingIdentityEvidence;
}
function balances(proof: CurveUnderlyingIdentityEvidence) {
  return variant.decode({ step: { candidate, step: 2, evidence: proof }, results: [
    result("behavior-scale-underlying-balances", CURVE_UNDERLYING_META_INTERFACE.encodeFunctionResult("get_underlying_balances",
      [[...state.balances, 0n, 0n, 0n, 0n]])),
  ] }) as CurveUnderlyingIdentityEvidence;
}
test("legacy plain scales only the two all-zero directions, using reverse registry balance and a finite bound", () => {
  const proof = begin(); assert.equal(variant.decide({ candidate, step: 2, evidence: proof }).status, "continue");
  const requests = variant.buildRequests({ candidate, step: 2, evidence: proof });
  assert.equal(requests.length, 1); assert.equal(requests[0].kind, "eth-call");
  if (requests[0].kind === "eth-call") assert.equal(requests[0].to, CURVE_METAREGISTRY);
  const scaled = balances(proof);
  const quotes = variant.buildRequests({ candidate, step: 3, evidence: scaled });
  assert.equal(quotes.length, 10);
  for (const q of quotes) {
    assert.equal(q.kind, "eth-call"); if (q.kind !== "eth-call") continue;
    const parsed = CURVE_UNDERLYING_POOL_INTERFACE.parseTransaction({ data: q.data }); assert(parsed);
    assert.equal(parsed.args[0], 3n); assert([1n, 2n].includes(parsed.args[1]));
    assert(parsed.args[2] > 0n && parsed.args[2] <= state.balances[3] / 100n);
    assert(!CURVE_BEHAVIOR_PROBE_AMOUNTS.includes(parsed.args[2]));
  }
  const results = quotes.map(q => result(q.id, ethers.toBeHex(100n, 32)));
  const done = variant.decode({ step: { candidate, step: 3, evidence: scaled }, results });
  const decision = variant.decide({ candidate, step: 4, evidence: done });
  assert.equal(decision.status, "verified"); if (decision.status !== "verified") throw new Error("unit identity");
  assert.equal(decision.identity.facts.verifiedDirections.length, 12);
  assert.deepEqual(decision.identity.facts.legacyPlain, binding);
  const descriptor = family.instance.compileDraft(decision.identity);
  assert.deepEqual(descriptor.legacyPlain, binding);
  assert.throws(() => variant.decode({ step: { candidate, step: 3, evidence: scaled },
    results: [...results.slice(0, -1), { id: results.at(-1)!.id, ok: false, source, failure: "rpc" }] }), /unresolved/);
  assert.throws(() => variant.decode({ step: { candidate, step: 3, evidence: scaled },
    results: results.map((r, i) => i ? r : { ...r, source: { ...source, hash: ethers.ZeroHash } }) }), /foreign source/);
});
test("legacy plain does not add probe cost to complete witnesses or manufacture positive directions", () => {
  const full = begin(true);
  assert.equal(variant.decide({ candidate, step: 2, evidence: full }).status, "verified");
  assert.deepEqual(variant.buildRequests({ candidate, step: 2, evidence: full }), []);
  const scaled = balances(begin());
  const results = variant.buildRequests({ candidate, step: 3, evidence: scaled }).map(q => result(q.id, ethers.toBeHex(0n, 32)));
  const done = variant.decode({ step: { candidate, step: 3, evidence: scaled }, results });
  const decision = variant.decide({ candidate, step: 4, evidence: done });
  assert.equal(decision.status, "verified");
  if (decision.status === "verified") assert.equal(decision.identity.facts.verifiedDirections.length, 10);
});
