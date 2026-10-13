import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult } from "../../../adapter-request-program.js";
import { curveUnderlyingStrictFamilyPlugin as family } from "../../curve-underlying-family-plugin.js";
import { CURVE_METAREGISTRY, CURVE_UNDERLYING_POOL_INTERFACE } from "../codec.js";
import { CURVE_LEGACY_FACTORY, CURVE_LEGACY_FACTORY_INTERFACE as factoryAbi,
  CURVE_LEGACY_FACTORY_LOOKUP, decodeLegacyFactoryCoins } from "../legacy-factory.js";
import { CURVE_UNDERLYING_FACTORY_LINEAGE_ID, CURVE_UNDERLYING_FAMILY_ID } from "../manifest.js";
import { reverseBindCurveUnderlying } from "../reverse-binding.js";
import type { CurveUnderlyingCandidate, CurveUnderlyingIdentity } from "../types.js";
import { ARCHIVED_EDGES, context, swapLog } from "./receipt-fixture.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/legacy-factory-fei.json", import.meta.url), "utf8"));
const modelFixture = JSON.parse(readFileSync(new URL("./fixtures/classic-meta-binding.json", import.meta.url), "utf8"));
const codes = JSON.parse(gunzipSync(Buffer.from(modelFixture.runtimeBytecodesGzipBase64, "base64")).toString());
const source = fixture.source, pool = fixture.pool;
const basePool = fixture.decoded[pool].get_base_pool[0];
const coins = fixture.decoded[pool].get_underlying_coins[0].filter((x: string) => x !== ethers.ZeroAddress);
const candidate: CurveUnderlyingCandidate = { candidateKind: "curve-underlying-pool", pool,
  sourceKind: "underlying-swap-log", hintedI: 0, hintedJ: 2 };
const variant = family.identity.variants.find(v => v.id === "legacy-factory-member")!;
assert(variant);
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const result = (id: string, data: string): AdapterRequestResult => ({ id, data, ok: true,
  completion: "returned", source, provenance: { kind: "offline-regression", fingerprint: "historical-factory" } });
const baseData = (value = basePool) => factoryAbi.encodeFunctionResult("get_base_pool", [value]);
const coinData = (values: readonly string[] = coins) => factoryAbi.encodeFunctionResult("get_underlying_coins",
  [[...values, ...Array(8 - values.length).fill(ethers.ZeroAddress)]]);
const availability = (code = fixture.metaregistryCode) => variant.decode({
  step: { candidate, step: 0 }, results: [result("historical-metaregistry-code", code)] });
function surface(values = [
  result("factory-base-pool", baseData()), result("registry-underlying-coins", coinData()), result("pool-code", fixture.poolCode),
]) {
  return variant.decode({ step: { candidate, step: 1, evidence: availability() }, results: values });
}

// Only the registration responses above are historical evidence. Immutable model
// bytes are reused below with synthetic topology/probe responses to test wiring;
// these unit tests do not claim historical execution or successful admission.
function behaviorAnswer(request: AdapterRequest, positive = true): AdapterRequestResult {
  if (request.id.startsWith("behavior-get-dy:")) {
    return result(request.id, CURVE_UNDERLYING_POOL_INTERFACE.encodeFunctionResult("get_dy_underlying", [positive ? 1n : 0n]));
  }
  if (request.id === "model-meta-coin") return result(request.id, ethers.zeroPadValue(coins[0], 32));
  if (request.kind === "get-code") {
    const code = Object.values(codes).find((c: any) => equal(c.address, request.address)) as any;
    assert(code); return result(request.id, code.code);
  }
  if (request.kind === "get-storage") {
    const address = equal(request.address, pool) ? codes.meta.address : request.address;
    const row = modelFixture.storage.find((r: any) => equal(r.address, address) && BigInt(r.slot) === BigInt(request.slot));
    assert(row); return result(request.id, row.result);
  }
  assert.equal(request.kind, "eth-call");
  if (request.kind !== "eth-call") throw new Error("unexpected request");
  const to = equal(request.to, pool) ? codes.meta.address : request.to;
  const row = modelFixture.calls.find((r: any) => equal(r.to, to) && equal(r.data, request.data));
  assert(row, request.id); return result(request.id, row.result);
}
function attest(evidence = surface(), positive = true): CurveUnderlyingIdentity {
  const step = { candidate, step: 2, evidence };
  const proof = variant.decode({ step, results: variant.buildRequests(step).map(r => behaviorAnswer(r, positive)) });
  const decision = variant.decide({ candidate, evidence: proof, step: 3 });
  assert.equal(decision.status, "verified");
  if (decision.status !== "verified") throw new Error("expected verified fixture");
  return decision.identity;
}

test("historical FEI registry response binds the exact four coin indices and source", () => {
  assert.equal(fixture.source.number, 14127510);
  assert.equal(fixture.metaregistryCode, "0x");
  assert.equal(variant.lineageId, CURVE_UNDERLYING_FACTORY_LINEAGE_ID);
  const raw = fixture.calls.find((r: any) => r.data === factoryAbi.encodeFunctionData("get_underlying_coins", [pool]));
  assert.deepEqual(decodeLegacyFactoryCoins(raw.result), coins);
  const evidence = surface() as any;
  assert.deepEqual(evidence.coins, coins);
  assert.equal(evidence.registryBinding.registry, CURVE_LEGACY_FACTORY);
  assert.equal(evidence.registryBinding.basePool, basePool);
  assert.equal(evidence.registryBinding.lookupSemantics, CURVE_LEGACY_FACTORY_LOOKUP);
  assert.deepEqual(variant.decide({ candidate, step: 2, evidence }), { status: "continue" });
  assert(variant.buildRequests({ candidate, step: 2, evidence }).some(r => r.id === "model-implementation-code"));
});

test("existing MetaRegistry support is retained; factory is only used before deployment", () => {
  assert.deepEqual(family.identity.variants.map(v => v.id),
    ["metaregistry-member", "metaregistry-uint-native-alias", "legacy-factory-member"]);
  const evidence = availability("0x6000");
  assert.deepEqual(variant.decide({ candidate, evidence, step: 1 }), { status: "chain-proven-rejected",
    reasonCode: "metaregistry_already_deployed", evidenceRequestIds: ["historical-metaregistry-code"] });
  assert.throws(() => variant.decode({ step: { candidate, step: 1, evidence }, results: [] }), /requires absent/);
  assert.throws(() => variant.decode({ step: { candidate, step: 0 },
    results: [{ id: "historical-metaregistry-code", ok: false, source, failure: "rpc" }] }), /unresolved: rpc/);
});

test("unregistered factory address, empty pool code and invalid domain fail closed", () => {
  const values = [result("factory-base-pool", baseData(ethers.ZeroAddress)),
    { ...result("registry-underlying-coins", "0x"), completion: "reverted-as-declared" as const },
    result("pool-code", "0x6000")];
  assert.equal(variant.decide({ candidate, step: 2, evidence: surface(values) }).status, "chain-proven-rejected");
  for (const values of [
    [result("factory-base-pool", baseData()), result("registry-underlying-coins", coinData()), result("pool-code", "0x")],
    [result("factory-base-pool", baseData()), result("registry-underlying-coins", coinData([coins[0]])), result("pool-code", "0x6000")],
  ]) assert.equal(variant.decide({ candidate, step: 2, evidence: surface(values) }).status, "chain-proven-rejected");
});

test("malformed, duplicate, holed and mixed-source factory evidence cannot be repaired by compaction", () => {
  for (const data of ["0x", coinData() + "00", coinData([coins[0], coins[0]]),
    coinData([coins[0], ethers.ZeroAddress, coins[2]])]) assert.throws(() => decodeLegacyFactoryCoins(data), /factory/);
  assert.throws(() => surface([result("factory-base-pool", baseData()),
    { ...result("registry-underlying-coins", coinData()), source: { ...source, number: source.number + 1 } },
    result("pool-code", fixture.poolCode)]), /mixed sources/);
  assert.throws(() => surface([result("factory-base-pool", "0x"), result("pool-code", fixture.poolCode)]), /base pool/);
});

test("factory model and pricing binding persist through descriptor compilation without changing execution semantics", () => {
  const identity = attest();
  assert.equal(identity.lineageId, CURVE_UNDERLYING_FACTORY_LINEAGE_ID);
  assert.equal(identity.provenance[0].subject, CURVE_LEGACY_FACTORY);
  assert.equal(identity.facts.verifiedDirections.length, 12);
  const descriptor = family.instance.finalizeDescriptor({ identity, draft: family.instance.compileDraft(identity), sharedBindings: [] });
  const routes = family.routes.project({ descriptor });
  assert.equal(routes.length, 12);
  assert(routes.every(r => r.semantics === "exchange_underlying(i,j,dx,minDy)"));
  const draft = family.pricing.compileDraft({ descriptor, routes: [routes[0]] });
  assert.equal(draft.registry, CURVE_LEGACY_FACTORY);
  assert.equal(family.pricing.refreshPolicyForInstance!({ descriptor }), "each-block");
  const wrong = surface([result("factory-base-pool", baseData("0x1000000000000000000000000000000000000099")),
    result("registry-underlying-coins", coinData()), result("pool-code", fixture.poolCode)]);
  assert.throws(() => attest(wrong), /base pool conflicts/);
});

test("factory membership never replaces positive direction behavior proof", () => {
  const evidence = surface(), step = { candidate, evidence, step: 2 };
  const proof = variant.decode({ step, results: variant.buildRequests(step).map(r => behaviorAnswer(r, false)) });
  assert.equal(variant.decide({ candidate, evidence: proof, step: 3 }).status, "chain-proven-rejected");
});

test("retain nominations use historical factory reverse registration and preserve modern behavior", async () => {
  for (const modern of [false, true]) {
    const reads: string[] = [];
    const outcomes = await reverseBindCurveUnderlying({ nominations: [{ address: pool, opaque: { adapter: "curve-underlying" } } as any],
      source, provider: {
        getCode: async (address: string, block: number) => { assert.equal(block, source.number); return equal(address, pool) ? fixture.poolCode : "0x"; },
        call: async (request: any, block: number) => {
          assert.equal(block, source.number); reads.push(request.to);
          if (equal(request.to, CURVE_METAREGISTRY)) return modern ? ethers.zeroPadValue(pool, 32) : "0x";
          assert.equal(request.to, CURVE_LEGACY_FACTORY);
          return request.data === factoryAbi.encodeFunctionData("get_base_pool", [pool.toLowerCase()]) ? baseData() : coinData();
        },
      } as any });
    assert.equal(outcomes[0].status, "verified");
    assert.equal(reads.length, modern ? 1 : 3);
  }
});

test("retain RPC failure or deployed-but-empty MetaRegistry never falls back to factory", async () => {
  for (const rpcFailure of [false, true]) {
    let factoryReads = 0;
    const outcomes = await reverseBindCurveUnderlying({ nominations: [{ address: pool, opaque: { adapter: "curve-underlying" } } as any],
      source, provider: {
        getCode: async () => "0x6000",
        call: async (request: any) => {
          if (equal(request.to, CURVE_LEGACY_FACTORY)) factoryReads++;
          if (rpcFailure) throw new Error("synthetic RPC failure");
          return "0x";
        },
      } as any });
    assert.equal(outcomes[0].status, "failed"); assert.equal(factoryReads, 0);
  }
});

test("receipt uses the admitted factory binding and fresh source-bound coin indices", async () => {
  const identity = attest(), descriptor = family.instance.finalizeDescriptor({ identity,
    draft: family.instance.compileDraft(identity), sharedBindings: [] });
  const ctx = context([{ ...swapLog("int128", 0n, 2n), address: pool }]);
  const graph = [{ ...ARCHIVED_EDGES[0], target: pool, instanceKey: pool.toLowerCase(), tokenIn: coins[0], tokenOut: coins[2] }];
  for (const currentBase of [basePool, ethers.ZeroAddress, coins[0]]) {
    const reads: string[] = [];
    const response = await family.swap.receiptObservation.decodeReceiptImpacts({ ...ctx, graph,
      sourceGeneration: { ...ctx.sourceGeneration, sourceBlock: source.number, sourceBlockHash: source.hash },
      resolveBinding: () => ({ familyId: CURVE_UNDERLYING_FAMILY_ID, descriptor: { ...descriptor, coins: [...coins].reverse() } }),
      tokenQuery: { async call(request, control) {
        assert.equal(request.to, CURVE_LEGACY_FACTORY); assert.equal(request.blockTag, source.number); assert.equal(control, ctx.control);
        reads.push(request.data);
        return request.data === factoryAbi.encodeFunctionData("get_base_pool", [pool]) ? baseData(currentBase) : coinData();
      } } });
    assert.equal(response.status, currentBase === basePool ? "resolved" : "unresolved");
    assert.equal(reads.length, currentBase === basePool ? 2 : 1);
    if (response.status === "resolved") {
      assert.equal(response.impacts[0].impact.tokenIn, coins[0]); assert.equal(response.impacts[0].impact.tokenOut, coins[2]);
    } else assert(!("impacts" in response));
  }
});
