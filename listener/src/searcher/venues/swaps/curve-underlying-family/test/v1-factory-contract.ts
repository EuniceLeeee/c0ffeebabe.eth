import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult } from "../../../adapter-request-program.js";
import { curveUnderlyingStrictFamilyPlugin as family } from "../../curve-underlying-family-plugin.js";
import { CURVE_UNDERLYING_POOL_INTERFACE, CURVE_METAREGISTRY } from "../codec.js";
import { CURVE_V1_FACTORY, CURVE_V1_FACTORY_INTERFACE as abi, CURVE_V1_FACTORY_LOOKUP,
  decodeV1FactoryRegistration } from "../v1-factory.js";
import { CURVE_UNDERLYING_V1_FACTORY_LINEAGE_ID } from "../manifest.js";
import { classicMetaRateSlot, classicMetaScalar, hasLegacyV1UnderlyingQuoteModel } from "../quote-model.js";
import { reverseBindCurveUnderlying } from "../reverse-binding.js";
import { ARCHIVED_EDGES, context, swapLog } from "./receipt-fixture.js";
import type { CurveUnderlyingCandidate, CurveUnderlyingIdentity, CurveUnderlyingIdentityEvidence } from "../types.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/v1-factory-ustp-bac.json", import.meta.url), "utf8"));
const codes = JSON.parse(gunzipSync(Buffer.from(fixture.runtimeBytecodesGzipBase64, "base64")).toString());
const previous = JSON.parse(readFileSync(new URL("./fixtures/classic-meta-binding.json", import.meta.url), "utf8"));
const oldCodes = JSON.parse(gunzipSync(Buffer.from(previous.runtimeBytecodesGzipBase64, "base64")).toString());
const variant = family.identity.variants.find(v => v.id === "factory-v1-member")!;
assert(variant);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const padded = (value: bigint, tail = false) => {
  const bytes = new Uint8Array(4096);
  bytes.set(ethers.getBytes(ethers.toBeHex(value, 32)));
  if (tail) bytes[35] = 1; // Saved coins(1) response contains this calldata tail.
  return ethers.hexlify(bytes);
};

for (const row of fixture.pools) {
  const { pool, source } = row;
  const coins: string[] = row.decoded.get_underlying_coins[0].filter((c: string) => c !== ethers.ZeroAddress);
  const wrapped: string[] = row.decoded.get_coins[0];
  const candidate: CurveUnderlyingCandidate = { candidateKind: "curve-underlying-pool", pool,
    sourceKind: "underlying-swap-log", hintedI: 0, hintedJ: 2 };
  const result = (id: string, data: string): AdapterRequestResult => ({ id, data, ok: true, completion: "returned",
    source, provenance: { kind: "offline-public-registry-and-synthetic-behavior", fingerprint: pool } });
  const registryData = (name: string, address = pool): string => {
    const call = abi.encodeFunctionData(name, [address]);
    const found = row.factoryCalls.find((c: any) => same(c.data, call));
    assert(found); return found.result;
  };
  const surfaceResults = () => [
    result("v1-factory-code", codes.factory), result("v1-factory-wrapped-coins", registryData("get_coins")),
    result("registry-underlying-coins", registryData("get_underlying_coins")), result("pool-code", row.poolCode),
  ];
  const surface = (results = surfaceResults()) => {
    const code = variant.decode({ step: { candidate, step: 0 }, results: [result("pool-code", row.poolCode)] });
    return variant.decode({ step: { candidate, step: 1, evidence: code }, results }) as CurveUnderlyingIdentityEvidence;
  };
  // All behavior and base topology answers below are synthetic unit inputs.
  // Real execution and same-state base reads belong to the historical CLI.
  const answer = (request: AdapterRequest, positive = true): AdapterRequestResult => {
    const id = request.id;
    if (id.startsWith("behavior-get-dy:")) return result(id, padded(positive ? 1n : 0n));
    if (id === "model-implementation-code") return result(id, codes.implementation);
    if (id === "model-base-code") return result(id, oldCodes.base.code);
    if (id === "model-meta-coin") return result(id, padded(BigInt(coins[0])));
    if (id === "model-meta-lp") return result(id, padded(BigInt(wrapped[1]), true));
    if (id === "model-base-lp") return result(id, ethers.zeroPadValue(wrapped[1], 32));
    if (id === "model-meta-rate") {
      assert(request.kind === "get-storage"); assert.equal(BigInt(request.slot), 10n);
      return result(id, ethers.toBeHex(BigInt(row.rateMultiplier), 32));
    }
    if (id.startsWith("model-base-coin:")) return result(id, ethers.zeroPadValue(coins[Number(id.slice(-1)) + 1], 32));
    throw new Error("unexpected unit request " + id);
  };
  const attest = (evidence = surface(), positive = true): CurveUnderlyingIdentity => {
    const step = { candidate, step: 1, evidence };
    const proof = variant.decode({ step, results: variant.buildRequests(step).map(r => answer(r, positive)) });
    const decision = variant.decide({ candidate, step: 2, evidence: proof });
    assert.equal(decision.status, "verified"); if (decision.status !== "verified") throw new Error("fixture failed");
    return decision.identity;
  };
  test(pool + ": reverse factory membership admits a non-MetaRegistry V1 profile with slot10", () => {
    assert.equal(variant.lineageId, CURVE_UNDERLYING_V1_FACTORY_LINEAGE_ID);
    const requests = variant.buildRequests({ candidate, step: 0 });
    assert(requests.every(r => r.kind !== "eth-call" || r.to !== CURVE_METAREGISTRY));
    const identity = attest(), model = identity.facts.quoteModel!;
    assert.equal(model.metaRateMultiplier, BigInt(row.rateMultiplier));
    assert.equal(classicMetaRateSlot(model), 10);
    assert.equal(identity.facts.registryBinding.lookupSemantics, CURVE_V1_FACTORY_LOOKUP);
    const descriptor = family.instance.finalizeDescriptor({ identity, draft: family.instance.compileDraft(identity), sharedBindings: [] });
    assert.equal(family.routes.project({ descriptor }).length, 12);
    assert.equal(family.pricing.refreshPolicyForInstance!({ descriptor }), "each-block");
    assert(!hasLegacyV1UnderlyingQuoteModel(row.poolCode + "00"));
    const corrupted = { ...model, implementationCodeHash: ethers.ZeroHash };
    assert.throws(() => classicMetaRateSlot(corrupted), /unknown classic/);
  });
  test(pool + ": wrong source/code, unsupported proxy, LP mismatch and zero behavior cannot pass", () => {
    for (const id of ["v1-factory-code", "pool-code"]) {
      const evidence = () => surface(surfaceResults().map(r => r.id === id ? result(id, "0x6000") : r));
      if (id === "v1-factory-code") assert.throws(evidence, /bound runtime/);
      else assert.equal(variant.decide({ candidate, step: 1, evidence: evidence() }).status, "chain-proven-rejected");
    }
    assert.throws(() => surface(surfaceResults().map((r, i) => i === 1
      ? { ...r, source: { ...source, hash: ethers.ZeroHash } } : r)), /mixed sources/);
    assert.throws(() => surface([{ id: "v1-factory-code", ok: false, source, failure: "rpc" }]), /unresolved/);
    const badLP = surface(surfaceResults().map(r => r.id === "v1-factory-wrapped-coins"
      ? result(r.id, abi.encodeFunctionResult("get_coins", [[wrapped[0], coins[1]]])) : r));
    assert.throws(() => attest(badLP), /wrapped LP conflicts/);
    const evidence = surface(), step = { candidate, step: 1, evidence };
    const proof = variant.decode({ step, results: variant.buildRequests(step).map(r => answer(r, false)) });
    assert.equal(variant.decide({ candidate, step: 2, evidence: proof }).status, "chain-proven-rejected");
  });
  test(pool + ": scalar normalization is restricted to the bound fixed-return profile", () => {
    const identity = attest(), model = identity.facts.quoteModel!;
    assert.equal(classicMetaScalar(model, padded(42n, true)), ethers.toBeHex(42, 32));
    for (const bad of ["0x", ethers.toBeHex(42, 32), padded(42n) + "00"]) {
      assert.throws(() => classicMetaScalar(model, bad), /forwarder return/);
    }
    assert.equal(classicMetaScalar({ implementationCodeHash: ethers.ZeroHash }, padded(42n)), padded(42n));
    assert.equal(BigInt(CURVE_UNDERLYING_POOL_INTERFACE.decodeFunctionResult("get_dy_underlying", padded(42n, true))[0]), 42n);
    const descriptor = family.instance.finalizeDescriptor({ identity, draft: family.instance.compileDraft(identity), sharedBindings: [] });
    const route = family.routes.project({ descriptor }).find(r => r.i === 0 && r.j === 2)!;
    const input = { descriptor, route, amountIn: 1n, source, executor: "0x1000000000000000000000000000000000000002", runtimeEvidence: [] };
    const method = family.exact.methods(input)[1]; assert(method.kind === "request-program");
    const max = ((1n << 256n) - 1n) / model.metaRateMultiplier;
    assert(method.program.buildRequests({ ...input, amountIn: max }).length > 0);
    assert.throws(() => method.program.buildRequests({ ...input, amountIn: max + 1n }), /uint256/);
    const initial = method.program.buildRequests(input).map(r => {
      let data: string;
      if (r.id === "classic-pool-code") data = row.poolCode;
      else if (r.id === "classic-implementation-code") data = codes.implementation;
      else if (r.id === "classic-base-code") data = oldCodes.base.code;
      else if (r.id === "classic-meta-rate") data = ethers.toBeHex(BigInt(row.rateMultiplier), 32);
      else if (r.id === "classic-meta-coin") data = padded(BigInt(coins[0]));
      else if (r.id === "classic-meta-lp") data = padded(BigInt(wrapped[1]), true);
      else if (r.id === "classic-meta-A" || r.id === "classic-meta-future-A") data = padded(1000n);
      else if (r.id === "classic-meta-quote") data = padded(42n, true);
      else data = ethers.toBeHex(2000, 32);
      return result(r.id, data);
    });
    assert.equal(method.program.decode({ programInput: input, initialResults: initial, dependentEvidence: [] }).amountOut, 42n);
    for (const route of family.routes.project({ descriptor })) {
      assert(family.execution.buildRuntimeLeg!({ descriptor, route, executor: input.executor, runtimeEvidence: [],
        get amountIn() { throw new Error("amount accessed"); }, get exactEvidence() { throw new Error("Exact accessed"); } } as any));
    }
  });
  test(pool + ": V1 non-members keep the existing MetaRegistry nomination path", async () => {
    for (const member of [true, false]) {
      let metaReads = 0;
      const outcomes = await reverseBindCurveUnderlying({ nominations: [{ address: pool, opaque: { adapter: "curve-underlying" } } as any],
        source, provider: {
          getCode: async (address: string) => same(address, pool) ? row.poolCode : codes.factory,
          call: async (request: any) => {
            if (same(request.to, CURVE_METAREGISTRY)) {
              metaReads++; return ethers.zeroPadValue(member ? pool : ethers.ZeroAddress, 32);
            }
            assert.equal(request.to, CURVE_V1_FACTORY);
            return same(request.data, abi.encodeFunctionData("get_coins", [pool]))
              ? abi.encodeFunctionResult("get_coins", [[ethers.ZeroAddress, ethers.ZeroAddress]])
              : abi.encodeFunctionResult("get_underlying_coins", [Array(8).fill(ethers.ZeroAddress)]);
          },
        } as any });
      assert.equal(metaReads, 1);
      assert.equal(outcomes[0].status, member ? "verified" : "failed");
    }
    let metaReads = 0;
    const failed = await reverseBindCurveUnderlying({ nominations: [{ address: pool, opaque: { adapter: "curve-underlying" } } as any],
      source, provider: {
        getCode: async (address: string) => same(address, pool) ? row.poolCode : codes.factory,
        call: async (request: any) => {
          if (same(request.to, CURVE_METAREGISTRY)) metaReads++;
          throw new Error("synthetic transport failure");
        },
      } as any });
    assert.equal(failed[0].status, "failed"); assert.equal(metaReads, 0);
    const missing = surface(surfaceResults().map(r =>
      r.id === "v1-factory-wrapped-coins" ? result(r.id, abi.encodeFunctionResult("get_coins", [[ethers.ZeroAddress, ethers.ZeroAddress]]))
      : r.id === "registry-underlying-coins" ? result(r.id, abi.encodeFunctionResult("get_underlying_coins", [Array(8).fill(ethers.ZeroAddress)]))
      : r));
    assert.equal(variant.decide({ candidate, step: 2, evidence: missing }).status, "chain-proven-rejected");
  });
  test(pool + ": retained nomination and receipt re-read V1 registration at the requested source", async () => {
    const outcomes = await reverseBindCurveUnderlying({ nominations: [{ address: pool, opaque: { adapter: "curve-underlying" } } as any],
      source, provider: {
        getCode: async (address: string, block: number) => { assert.equal(block, source.number); return same(address, pool) ? row.poolCode : codes.factory; },
        call: async (request: any, block: number) => {
          assert.equal(block, source.number); assert.equal(request.to, CURVE_V1_FACTORY);
          return row.factoryCalls.find((c: any) => same(c.data, request.data))!.result;
        },
      } as any });
    assert.equal(outcomes[0].status, "verified");
    const identity = attest(), descriptor = family.instance.finalizeDescriptor({ identity, draft: family.instance.compileDraft(identity), sharedBindings: [] });
    const ctx = context([{ ...swapLog("int128", 0n, 2n), address: pool }]);
    const graph = [{ ...ARCHIVED_EDGES[0], target: pool, instanceKey: pool.toLowerCase(), tokenIn: coins[0], tokenOut: coins[2] }];
    for (const registered of [true, false]) {
      const response = await family.swap.receiptObservation.decodeReceiptImpacts({ ...ctx, graph,
        sourceGeneration: { ...ctx.sourceGeneration, sourceBlock: source.number, sourceBlockHash: source.hash },
        resolveBinding: () => ({ familyId: identity.familyId, descriptor }),
        tokenQuery: { async call(request, control) {
          assert.equal(request.to, CURVE_V1_FACTORY); assert.equal(request.blockTag, source.number); assert.equal(control, ctx.control);
          return !registered && same(request.data, abi.encodeFunctionData("get_coins", [pool]))
            ? abi.encodeFunctionResult("get_coins", [[ethers.ZeroAddress, ethers.ZeroAddress]])
            : row.factoryCalls.find((c: any) => same(c.data, request.data))!.result;
        } } });
      assert.equal(response.status, registered ? "resolved" : "unresolved");
    }
  });
}
test("unregistered, holed, duplicate and trailing factory responses cannot prove membership", () => {
  const row = fixture.pools[0], neg = "0x0000000000000000000000000000000000000001";
  const data = (name: string) => row.factoryCalls.find((c: any) => same(c.data, abi.encodeFunctionData(name, [neg])))!.result;
  const registration = decodeV1FactoryRegistration(data("get_coins"), data("get_underlying_coins"));
  assert.equal(registration.wrappedCoins[0], ethers.ZeroAddress); assert.equal(registration.coins.length, 0);
  const coins = row.decoded.get_underlying_coins[0], wrapped = row.decoded.get_coins[0];
  for (const bad of [
    abi.encodeFunctionResult("get_coins", [[wrapped[0], wrapped[0]]]),
    abi.encodeFunctionResult("get_coins", [[ethers.ZeroAddress, wrapped[1]]]),
    abi.encodeFunctionResult("get_coins", [wrapped]) + "00",
  ]) assert.throws(() => decodeV1FactoryRegistration(bad, abi.encodeFunctionResult("get_underlying_coins", [coins])), /V1/);
});
