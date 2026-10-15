// Offline source/profile + production issuer + emitted-program regression.
// Runtime bytes come from saved fixtures. Registry, pricing and token effects
// below are synthetic: this is neither historical EVM nor quote-math evidence.
// Run in its own Node process, without the legacy shadow-plugin test imports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { ethers } from "ethers";
import { RuntimeAmountProgram, type RuntimeAmountLeg, type RuntimeSettlementRequest } from "../../adapters/runtime-amount-program.js";
import { buildRuntimeSettlementRoot } from "../simulator/runtime-settlement.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../strict-family-lifecycle-runner.js";
import { buildFamilyRuntimeAmountLeg } from "../venues/adapter-family-runtime.js";
import { isPricedFamily } from "../venues/family-capability-catalog.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../venues/production-family-composition.js";
import { CURVE_METAREGISTRY, CURVE_UNDERLYING_ERC20_INTERFACE as ERC20,
  CURVE_UNDERLYING_META_INTERFACE as REGISTRY, CURVE_UNDERLYING_POOL_INTERFACE as POOL } from "../venues/swaps/curve-underlying-family/codec.js";
import { CURVE_UNDERLYING_FAMILY_ID } from "../venues/swaps/curve-underlying-family/manifest.js";
import { supportsClassicUnderlyingRecipient } from "../venues/swaps/curve-underlying-family/quote-model.js";
import type { CurveUnderlyingDescriptor, CurveUnderlyingRoute } from "../venues/swaps/curve-underlying-family/types.js";
import { inspectRuntime, type RuntimeCall } from "./runtime-program-testkit.js";

const load = (name: string) => JSON.parse(readFileSync(new URL(
  `../venues/swaps/curve-underlying-family/test/fixtures/${name}`, import.meta.url), "utf8"));
const classic = load("classic-meta-binding.json"), v1 = load("v1-factory-ustp-bac.json");
const unpack = (fixture: { runtimeBytecodesGzipBase64: string }) => JSON.parse(
  gunzipSync(Buffer.from(fixture.runtimeBytecodesGzipBase64, "base64")).toString());
const classicCodes = unpack(classic), v1Codes = unpack(v1);
const addr = (n: number) => ethers.getAddress(ethers.toBeHex(n, 20));
const executor = addr(101), recipient = addr(102), origin = addr(103);
const word = (n: bigint) => ethers.toBeHex(n, 32);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const padded = (values: readonly unknown[], size: number, zero: unknown) => [...values, ...Array(size - values.length).fill(zero)];
const amount = 37n, output = 74n, MAX = (1n << 256n) - 1n;
const token = new ethers.Interface(["function balanceOf(address) view returns(uint256)"]);
const coinsABI = new ethers.Interface(["function coins(uint256) view returns(address)"]);
const swapABI = new ethers.Interface([
  "function exchange_underlying(int128,int128,uint256,uint256)",
  "function exchange_underlying(int128,int128,uint256,uint256,address)",
]);
const release = new ethers.Interface(["function fixtureRelease(uint256)"]);
type Profile = "213be" | "2c7796" | "unmodeled";
type Build = (request?: RuntimeSettlementRequest) => RuntimeAmountLeg | null;

async function prepare(profile: Profile) {
  const legacy = profile === "2c7796", row = v1.pools[0];
  const pool: string = legacy ? row.pool : classicCodes.meta.address;
  const coins: string[] = legacy ? row.decoded.get_underlying_coins[0].slice(0, 4)
    : [0, 1, 2, 3].map(i => classic.samples.find((s: { i: number }) => s.i === i).tokenIn);
  const decimals = [legacy ? 8 : 18, 18, 6, 6];
  const lp = "0x6c3f90f043a72fa612cbac8115ee7e52bde6e490";
  const source: CanonicalSource = { number: (legacy ? row : classic).source.number,
    hash: (legacy ? row : classic).source.hash, generation: 1 };
  let reads = 0;
  const scalar = (n: bigint) => legacy ? word(n) + "00".repeat(4096 - 32) : word(n);
  const runtime = createStrictCentralAdapterRuntime({ executor, transactionOrigin: origin,
    generationFence: { assertCurrent(generation, at) { assert.equal(generation, source.generation); assert.deepEqual(at, source); } },
    provider: {
      async call(tx, block) {
        reads++; assert.equal(block, source.number);
        if (same(tx.to, CURVE_METAREGISTRY)) {
          // Same-source synthetic reverse registration for each exact code
          // profile. This does not re-prove the historical V1 factory fixture.
          const parsed = REGISTRY.parseTransaction({ data: tx.data }); assert(parsed);
          const values: Record<string, unknown[]> = {
            get_registry_handlers_from_pool: [padded([pool], 10, ethers.ZeroAddress)],
            get_underlying_coins: [padded(coins, 8, ethers.ZeroAddress)],
            get_underlying_decimals: [padded(decimals, 8, 0)],
            get_underlying_balances: [padded(decimals.map(d => 10n ** BigInt(d + 6)), 8, 0n)],
          };
          assert(values[parsed.name]); return REGISTRY.encodeFunctionResult(parsed.name, values[parsed.name]);
        }
        if (tx.data === ERC20.encodeFunctionData("decimals")) {
          const i = coins.findIndex(c => same(c, tx.to)); assert(i >= 0); return word(BigInt(decimals[i]));
        }
        if (same(tx.to, pool) && tx.data.startsWith(POOL.getFunction("get_dy_underlying")!.selector)) {
          const [i, j, dx] = POOL.decodeFunctionData("get_dy_underlying", tx.data);
          return scalar(BigInt(dx) * 10n ** BigInt(decimals[Number(j)]) / 10n ** BigInt(decimals[Number(i)]));
        }
        if (tx.data.startsWith(coinsABI.getFunction("coins")!.selector)) {
          const [index] = coinsABI.decodeFunctionData("coins", tx.data);
          if (same(tx.to, pool)) return scalar(BigInt([coins[0], lp][Number(index)]));
          assert(same(tx.to, classicCodes.base.address)); return word(BigInt(coins[Number(index) + 1]));
        }
        const saved = classic.calls.find((r: { to: string; data: string }) =>
          same(r.to, same(tx.to, pool) ? classicCodes.meta.address : tx.to) && same(r.data, tx.data));
        assert(saved, `unexpected fixture call ${tx.to} ${tx.data}`);
        return same(tx.to, pool) && legacy ? scalar(BigInt(saved.result)) : saved.result;
      },
      async getCode(address, block) {
        reads++; assert.equal(block, source.number);
        if (same(address, pool)) return profile === "unmodeled" ? "0x6000" : legacy ? row.poolCode : classicCodes.meta.code;
        if (legacy && same(address, "0x2c7796c0590cc100d70af473993890d457cb2ac9")) return v1Codes.implementation;
        const saved = Object.values(classicCodes).find((r: any) => same(r.address, address)) as { code: string } | undefined;
        assert(saved, `unexpected fixture code ${address}`); return saved.code;
      },
      async getStorage(address, slot, block) {
        reads++; assert.equal(block, source.number);
        if (same(address, pool)) {
          assert.equal(BigInt(slot), legacy ? 10n : 16n); return word(legacy ? BigInt(row.rateMultiplier) : 10n ** 18n);
        }
        assert(same(address, classicCodes.base.address)); assert.equal(BigInt(slot), 5n); return word(BigInt(lp));
      },
    },
  });
  const publication = await runStrictFamilyLifecycle({ catalog, familyId: CURVE_UNDERLYING_FAMILY_ID,
    source, runtime, observations: [{ kind: "call", source, target: pool, sender: origin,
      data: POOL.encodeFunctionData("exchange_underlying", [0, 1, 10n ** BigInt(decimals[0]), 0n]) }] });
  assert.equal(publication.instances.length, 1);
  const instance = publication.instances[0], family = catalog.forFamily(CURVE_UNDERLYING_FAMILY_ID);
  assert(isPricedFamily(family));
  const descriptor = instance.descriptor as CurveUnderlyingDescriptor;
  assert.equal(instance.routes.length, 12);
  assert.equal(supportsClassicUnderlyingRecipient(descriptor.quoteModel), profile !== "unmodeled");
  function build(index: number, request?: RuntimeSettlementRequest, actor = executor) {
    const before = reads;
    // The real issuer validates the sealed route/source, current caller,
    // action ownership and echoed request. No hand-forged handle or issuer stub.
    const leg = buildFamilyRuntimeAmountLeg({ family, route: instance.routeHandles[index], source, runtime,
      executor: actor, runtimeEvidence: [], actionOwnership: catalog, ...(request ? { settlement: request } : {}) });
    assert.equal(reads, before, "runtime construction must not read the provider"); return leg;
  }
  return { descriptor, routes: instance.routes as readonly CurveUnderlyingRoute[], build };
}

type Fault = "none" | "wrong-recipient" | "short-output" | "old-output-only" | "under-debit" | "over-debit" | "native";
function model(build: Build, route: CurveUnderlyingRoute, fault: Fault) {
  const balanceKey = (t: string, a: string) => `${t.toLowerCase()}:${a.toLowerCase()}`;
  const balances = new Map<string, bigint>();
  const get = (t: string, a: string) => balances.get(balanceKey(t, a)) ?? 0n;
  const add = (t: string, a: string, delta: bigint) => {
    const next = get(t, a) + delta; assert(next >= 0n, "fixture balance underflow"); balances.set(balanceKey(t, a), next);
  };
  add(route.tokenIn, executor, 101n); add(route.tokenOut, executor, 103n);
  add(route.tokenOut, recipient, 107n); add(route.tokenIn, route.pool, 1000n); add(route.tokenOut, route.pool, 1000n);
  let native = 17n, swapCalls = 0, grantSeen = false;
  const base = build(); assert(base?.settlement?.directOutput);
  const requested = build({ kind: "direct-output", recipient }); assert(requested);
  assert.deepEqual(requested.settlementRequest, { kind: "direct-output", recipient });
  const quote = new RuntimeAmountProgram().constant(0, output);
  // Only quote/deferred counterpart are fixtures; the Curve leg and its
  // direct-output reconstruction below both come from the production issuer.
  const legs: Array<RuntimeAmountLeg & { tokenIn: string; tokenOut: string }> = [
    { ...base, tokenIn: route.tokenIn, tokenOut: route.tokenOut, settlement: { directOutput: true, quoteOutput: true } },
    { actionAdapterId: "fixture-deferred", program: ethers.hexlify(new RuntimeAmountProgram().constant(1, 0n).bytes()),
      tokenIn: route.tokenOut, tokenOut: route.tokenIn, settlement: { deferredInput: recipient } },
  ];
  const root = buildRuntimeSettlementRoot({ legs, amount, minimumProfit: 1n, executor, build(index, request) {
    if (index === 0) return request.kind === "quote-output"
      ? { actionAdapterId: "fixture-quote", program: ethers.hexlify(quote.bytes()) } : build(request);
    if (request.kind !== "deferred-input") return null;
    const p = new RuntimeAmountProgram().call(recipient, release.encodeFunctionData("fixtureRelease", [amount + 1n]))
      .constant(1, request.paymentAmount).run(request.paymentProgram, 1, 2).constant(3, output).equal(2, 3);
    return { actionAdapterId: "fixture-deferred", program: ethers.hexlify(p.bytes()) };
  } });
  assert(root);
  const call = (c: RuntimeCall): string => {
    if (c.static && c.data.startsWith(token.getFunction("balanceOf")!.selector)) {
      const [owner] = token.decodeFunctionData("balanceOf", c.data); return word(get(c.target, owner));
    }
    assert.equal(c.value, 0n); assert.equal(c.incoming, 0); assert.equal(c.outgoing, 0);
    if (same(c.target, recipient)) {
      assert.equal(release.decodeFunctionData("fixtureRelease", c.data)[0], amount + 1n);
      add(route.tokenIn, executor, amount + 1n); return "0x";
    }
    assert(same(c.target, route.pool)); assert(grantSeen); swapCalls++;
    const parsed = swapABI.parseTransaction({ data: c.data }); assert(parsed);
    assert.equal(parsed.signature, "exchange_underlying(int128,int128,uint256,uint256,address)");
    assert.deepEqual([...parsed.args].slice(0, 4), [BigInt(route.i), BigInt(route.j), amount, 1n]);
    assert(same(parsed.args[4], recipient));
    // msg.sender/payer is still executor. The fifth argument is only tokenOut
    // recipient; the model never debits recipient or uses it as approval owner.
    const debit = amount + (fault === "under-debit" ? -1n : fault === "over-debit" ? 1n : 0n);
    add(route.tokenIn, executor, -debit); add(route.tokenIn, route.pool, debit);
    const received = fault === "old-output-only" ? 0n : output - (fault === "short-output" ? 1n : 0n);
    add(route.tokenOut, route.pool, -received); add(route.tokenOut, fault === "wrong-recipient" ? executor : recipient, received);
    if (fault === "native") native--;
    return word(999999n); // Poisoned return cannot replace actual recipient delta.
  };
  inspectRuntime(root.params.settlementProgram as string, amount, { call, nativeBalance: () => native,
    allowance(grant) {
      assert(same(grant.token, route.tokenIn)); assert(same(grant.spender, route.pool));
      assert.equal(grant.minimum, amount); assert.equal(grant.grant, MAX); grantSeen = true;
    } });
  assert.equal(swapCalls, 1); assert.equal(get(route.tokenIn, executor), 102n);
  assert.equal(get(route.tokenOut, executor), 103n); assert.equal(get(route.tokenOut, recipient), 107n + output);
  assert.equal(get(route.tokenIn, recipient), 0n); assert.equal(get(route.tokenIn, route.pool), 1000n + amount);
  assert.equal(get(route.tokenOut, route.pool), 1000n - output); assert.equal(native, 17n);
}

for (const profile of ["213be", "2c7796"] as const) test(`Curve underlying ${profile}: issuer selects receiver and preserves default/payer`, async () => {
  const h = await prepare(profile);
  for (const [index, route] of h.routes.entries()) {
    const build: Build = request => h.build(index, request);
    const leg = build(); assert(leg?.settlement?.directOutput);
    // Byte equality protects the pre-existing four-argument/standing-grant path.
    const old = new RuntimeAmountProgram().allowance(route.tokenIn, route.pool, 0, MAX)
      .call(route.pool, swapABI.encodeFunctionData("exchange_underlying(int128,int128,uint256,uint256)",
        [route.i, route.j, 0n, 1n]), { patches: [{ offset: 68, reg: 0 }] });
    assert.equal(leg.program, ethers.hexlify(old.bytes()));
    assert.equal(build({ kind: "quote-output" }), null);
    assert.equal(build({ kind: "deferred-input", paymentAmount: amount, paymentProgram: "0x" }), null);
    assert.throws(() => h.build(index, { kind: "direct-output", recipient }, recipient), /caller mismatch/);
    for (const forbidden of [ethers.ZeroAddress, route.pool, route.tokenIn, route.tokenOut]) {
      assert.throws(() => build({ kind: "direct-output", recipient: forbidden }), /invalid executor/);
    }
    model(build, route, "none");
    // Meta->base, base->meta, base->base each receive the same adverse checks.
    if ((route.i === 0 && route.j === 1) || (route.i === 1 && route.j === 0) || (route.i === 1 && route.j === 2)) {
      for (const fault of ["wrong-recipient", "short-output", "old-output-only", "under-debit", "over-debit", "native"] as const) {
        assert.throws(() => model(build, route, fault), /runtime amount mismatch|checked uint256 math/);
      }
    }
  }
  const bound = h.descriptor.quoteModel!;
  for (const key of ["implementation", "implementationCodeHash", "poolCodeHash"] as const) {
    assert.equal(supportsClassicUnderlyingRecipient({ ...bound, [key]: key === "implementation" ? recipient : ethers.ZeroHash }), false);
  }
});

test("Curve underlying unmodeled entry stays default-only through production issuer", async () => {
  const h = await prepare("unmodeled");
  for (const [i] of h.routes.entries()) {
    assert(h.build(i)); assert.equal(h.build(i)?.settlement?.directOutput, undefined);
    assert.equal(h.build(i, { kind: "direct-output", recipient }), null);
  }
});

import { assertClassicRecipientWrapping } from "../venues/swaps/curve-underlying-family/test/classic-recipient-observation.js";
test("ordinary ERC20 asset declarations require no executor wrapping, even with internal pool wrapping", () => {
  const actor = "0x1000000000000000000000000000000000000002", pool = "0x1000000000000000000000000000000000000003";
  const weth = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const route = { tokenIn: "0x1000000000000000000000000000000000000004", tokenOut: weth,
    executionAssets: { input: "erc20" as const, output: "erc20" as const } };
  const internal = { from: pool, to: weth, input: "0xd0e30db0", value: "0x89" };
  assert.deepEqual(assertClassicRecipientWrapping([internal], actor, route, 100n, 137n, 0n), { withdrawals: 0, deposits: 0 });
  assert.throws(() => assertClassicRecipientWrapping([{ ...internal, from: actor }], actor, route, 100n, 137n, 0n));
  const nativeRoute = { ...route, executionAssets: { input: "erc20" as const, output: "native" as const } };
  assert.deepEqual(assertClassicRecipientWrapping([{ ...internal, from: actor }], actor, nativeRoute, 100n, 137n, 0n), { withdrawals: 0, deposits: 1 });
  assert.throws(() => assertClassicRecipientWrapping([{ ...internal, from: actor, value: "0x88" }], actor, nativeRoute, 100n, 137n, 0n));
});

import { CURVE_UNDERLYING_I128_RECEIVER_INTERFACE, CURVE_UNDERLYING_UINT_RECEIVER_INTERFACE } from "../venues/swaps/curve-underlying-family/codec.js";
test("actual classic receiver calldata is int128 and retains full amount and recipient", () => {
  // Cropped successful real call from c270 N26138094; no original output borrowed.
  const data = "0x44ee1986000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000004894282955f41f2c00000000000000000000000000000000000000000000000000000000000000010000000000000000000000001000000000000000000000000000000000000002";
  assert(data.startsWith(CURVE_UNDERLYING_I128_RECEIVER_INTERFACE.getFunction("exchange_underlying")!.selector));
  assert(!data.startsWith(CURVE_UNDERLYING_UINT_RECEIVER_INTERFACE.getFunction("exchange_underlying")!.selector));
  const args = CURVE_UNDERLYING_I128_RECEIVER_INTERFACE.decodeFunctionData("exchange_underlying", data);
  assert.deepEqual([...args], [0n, 1n, 5229849225284820780n, 1n, "0x1000000000000000000000000000000000000002"]);
  assert.equal(CURVE_UNDERLYING_I128_RECEIVER_INTERFACE.encodeFunctionData("exchange_underlying", args), data);
});
