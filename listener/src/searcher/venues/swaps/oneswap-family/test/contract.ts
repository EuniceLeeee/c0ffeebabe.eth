import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/oneswap.production.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { FACTORY_HASH, IMPLEMENTATION_HASH, LIMIT112, POOL, WETH } from "../codec.js";
import { ACTION, ID, LINEAGE } from "../manifest.js";
import { expandPrice, intoPoolTillPrice, quoteAmount } from "../math.js";
import { decodeProxy } from "../proxy.js";
import type { Descriptor, State } from "../types.js";
const pool = "0x1000000000000000000000000000000000000001", stock = "0x1000000000000000000000000000000000000002";
const executor = "0x1000000000000000000000000000000000000003", factory = "0x1000000000000000000000000000000000000004";
const implementation = "0x1000000000000000000000000000000000000005", maker = "0x1000000000000000000000000000000000000006";
const source = { number: 26130638, hash: `0x${"11".repeat(32)}`, generation: 1 };
// Synthetic descriptor/state: unit evidence only, never a chain admission.
const d: Descriptor = { familyId: ID, lineageId: LINEAGE, instanceKey: instanceKey(pool), pool, stock, money: ethers.ZeroAddress,
  ones: stock, factory, implementation, isOnlySwap: false, stockUnit: 10n ** 14n, priceMul: 1n, priceDiv: 1n,
  codeHash: `0x${"22".repeat(32)}`, implementationCodeHash: IMPLEMENTATION_HASH, factoryCodeHash: FACTORY_HASH, provenance: [], runtimeRequirements: [] };
const state = (stock: bigint, money: bigint): State => ({ source, stock, money, bookedStock: 0n, bookedMoney: 0n,
  balanceStock: stock, balanceMoney: money, feeBps: 50n, sells: [], buys: [], sellTail: 0n, buyTail: 0n });
test("standalone family owns native-normalized routes and runtime execution", () => {
  assert.equal(plugin.manifest.familyId, ID);
  const routes = plugin.routes.project({ descriptor: d });
  assert.deepEqual(routes.map(r => [r.tokenIn, r.tokenOut]), [[WETH, stock], [stock, WETH]]);
  for (const route of routes) {
    assert.equal(plugin.routes.projectGraph!({ descriptor: d, route }).routeActionAdapterId, ACTION);
    const leg = plugin.execution.buildRuntimeLeg!({ descriptor: d, route, executor, runtimeEvidence: [] });
    assert(leg && leg.program.includes(POOL.getFunction("addMarketOrder")!.selector.slice(2)));
    assert.throws(() => plugin.execution.buildRuntimeLeg!({ descriptor: d, route: { ...route, tokenIn: factory }, executor, runtimeEvidence: [] }), /incompatible route/);
  }
});
test("original two inputs reproduce raw outputs; closed-loop input excludes inventory unit", () => {
  const a = state(1366718530389431891570n, 38730936171661594n), b = state(7662091338932891436437n, 408272913944795390n);
  assert.equal(quoteAmount(d, a, true, 12122890967166406n).amountOut, 324178882015670094144n);
  assert.equal(quoteAmount(d, b, false, 324178882015670094145n).amountOut, 16489761286872983n);
  assert.equal(quoteAmount(d, b, false, 324178882015670094144n).amountOut, 16489761286872983n);
});
test("output fee rounds up, donation changes only input reserve, uint112 is bounded", () => {
  const s = state(10000n, 10000n);
  assert.equal(quoteAmount(d, s, true, 2n).amountOut, 0n);
  assert.equal(quoteAmount(d, s, true, 100n).amountOut, 98n);
  assert(quoteAmount(d, { ...s, balanceMoney: 20000n }, true, 100n).amountOut < 98n);
  assert.equal(quoteAmount(d, { ...s, balanceStock: 20000n }, true, 100n).amountOut, 98n);
  assert.throws(() => quoteAmount(d, s, true, LIMIT112), /overflow/);
});
test("orderbook fill, one aggregate fee and incomplete prefix rejection", () => {
  const spec = { ...d, stockUnit: 1n };
  // Price 1: identical to reserve ratio, so AMM capacity before maker is zero.
  const price = (16n << 27n) | 10_000_000n;
  assert.deepEqual(expandPrice(price, spec), { numerator: 10_000_000n, denominator: 10_000_000n });
  const order = { id: 1n, next: 0n, maker, price, amount: 20n };
  const s = { ...state(1000n, 1000n), sells: [order], bookedStock: 20n, balanceStock: 1020n };
  const q = quoteAmount(spec, s, true, 100n);
  assert.equal(q.bookOutput, 20n); assert.equal(q.amountIntoPool, 80n); assert.equal(q.amountOut, 93n); assert.equal(q.fee, 1n);
  assert.equal(quoteAmount(spec, s, true, 10n).amountOut, 9n);
  assert.throws(() => quoteAmount(spec, { ...s, sells: [{ ...order, next: 2n }], sellTail: 2n }, true, 100n), /coverage exhausted/);
  assert.equal(quoteAmount(spec, { ...s, sells: [{ ...order, next: 2n }], sellTail: 2n }, true, 10n).amountOut, 9n);
  const b = { ...state(1000n, 1000n), buys: [order], bookedMoney: 20n, balanceMoney: 1020n };
  assert.equal(quoteAmount(spec, b, false, 100n).amountOut, 93n);
});
test("Taylor boundary and stock-unit rounding match source control values", () => {
  assert.equal(intoPoolTillPrice(true, 1000n, 1000n, 121n, 100n, 7n), 100n);
  assert.equal(intoPoolTillPrice(false, 1000n, 1210n, 1n, 1n, 7n), 98n);
  assert.equal(intoPoolTillPrice(true, 1000n, 1000n, 4n, 1n, 7n), 1000n);
});
test("discovery parses canonical market call and rejects unrelated/malformed evidence", () => {
  const data = POOL.encodeFunctionData("addMarketOrder", [ethers.ZeroAddress, executor, 123n]);
  const observation = { kind: "call" as const, target: pool, data, source };
  assert.equal(plugin.discovery.decodeCandidate({ observation, matchedPatternId: "oneswap-market-order" })?.pool, pool);
  assert.equal(plugin.discovery.decodeCandidate({ observation: { ...observation, data: data + "00" }, matchedPatternId: "oneswap-market-order" }), null);
  assert.equal(decodeProxy("0x60006000f3"), null);
});
test("identity declares only the transports issued by each strict round", () => {
  const variant = plugin.identity.variants[0], candidate = { candidateKind: "oneswap" as const, pool };
  for (const evidence of [undefined, { phase: "proxy", facts: d }, { phase: "factory", facts: d }]) {
    const input = { candidate, evidence, step: 0 };
    const used = [...new Set(variant.buildRequests(input).map(r => r.kind))].sort();
    assert.deepEqual([...variant.requirements(input).transports].sort(), used);
  }
  const input = { candidate, step: 0 };
  const evidence = variant.decode({ step: input, results: [{ id: "proxy", source, ok: true,
    completion: "returned", data: "0x60006000f3", provenance: { kind: "unit-fixture", fingerprint: "synthetic-not-an-attestation" } }] });
  assert.equal(variant.decide({ ...input, evidence }).status, "chain-proven-rejected");
  assert.throws(() => variant.decode({ step: input, results: [{ id: "proxy", source, ok: false, failure: "rpc" }] }));
});
test("factory changes invalidate pricing and action minimum is preserved", () => {
  const route = plugin.routes.project({ descriptor: d })[0];
  const affected = plugin.pricing.mutation!.affectedStateKeys!({ descriptor: d, routes: [route], observation: { kind: "call", target: factory, data: "0x", source } });
  assert.deepEqual(affected, [d.instanceKey]);
  const amounts = quoteAmount(d, state(10000n, 10000n), true, 100n);
  const i = { descriptor: d, route, executor, runtimeEvidence: [], amountIn: 100n, quotedAmountOut: amounts.amountOut, minAmountOut: amounts.amountOut,
    exactEvidence: { ...amounts, kind: "oneswap-orderbook-math" as const, source, executor, routeKey: route.routeKey, binding: route.bindingRef.fingerprint, amountIn: 100n } };
  const f = plugin.execution.buildFragment(i);
  assert.equal(f.requirements.length, 0); assert.equal(f.nodes[0].params.minimum, amounts.amountOut);
  assert.equal(plugin.actionAdapters[0].encode(f.nodes[0], executor, new Uint8Array())[0], 0x0e);
  assert.throws(() => plugin.execution.buildFragment({ ...i, amountIn: 101n }), /incompatible execution evidence/);
  assert.throws(() => plugin.actionAdapters[0].encode({ ...f.nodes[0], tokenOut: factory }, executor, new Uint8Array()), /invalid action/);
});
test("settlement capability follows actual market-order interface; native conversion belongs to issuer", () => {
  const routes = plugin.routes.project({ descriptor: d });
  assert.deepEqual(routes.map(r => r.executionAssets), [
    { input: "native", output: "erc20" }, { input: "erc20", output: "native" },
  ]);
  for (const route of routes) {
    const i = { descriptor: d, route, executor, runtimeEvidence: [] };
    const ordinary = plugin.execution.buildRuntimeLeg!(i)!;
    assert.deepEqual(ordinary.settlement, { directOutput: true });
    assert.equal(plugin.execution.buildRuntimeLeg!({ ...i, settlement: { kind: "quote-output" } }), null);
    assert.equal(plugin.execution.buildRuntimeLeg!({ ...i, settlement: { kind: "deferred-input", paymentAmount: 1n, paymentProgram: "0x" } }), null);
    const request = { kind: "direct-output" as const, recipient: route.buy ? maker : executor };
    const direct = plugin.execution.buildRuntimeLeg!({ ...i, settlement: request });
    assert(direct); assert.deepEqual(direct.settlementRequest, request);
    assert.throws(() => plugin.execution.buildRuntimeLeg!({ ...i, settlement: { kind: "direct-output", recipient: pool } }));
    assert.throws(() => plugin.execution.buildRuntimeLeg!({ ...i, route: { ...route, executionAssets: undefined } }), /execution asset binding/);
  }
  // Native output must first reach the issuer's executor boundary. It wraps the
  // independently measured ETH and forwards WETH to an external graph recipient.
  assert.throws(() => plugin.execution.buildRuntimeLeg!({ descriptor: d, route: routes[1], executor, runtimeEvidence: [],
    settlement: { kind: "direct-output", recipient: maker } }), /execution binding/);
});
test("ERC20 market order supports direct delivery without introducing callback or native declaration", () => {
  const descriptor = { ...d, money: "0x1000000000000000000000000000000000000007" };
  for (const route of plugin.routes.project({ descriptor })) {
    assert.equal(route.executionAssets, undefined);
    const leg = plugin.execution.buildRuntimeLeg!({ descriptor, route, executor, runtimeEvidence: [],
      settlement: { kind: "direct-output", recipient: maker } });
    assert(leg && leg.settlement?.directOutput && !("deferredInput" in leg.settlement));
  }
});

test("native-output issuer maps protocol receiver before applying raw Family receiver restrictions", async () => {
  const { mapRuntimeAssetSettlementRequest } = await import("../../../../execution-asset-boundary.js");
  for (const route of plugin.routes.project({ descriptor: d })) {
    for (const recipient of [pool, factory]) {
      const request = { kind: "direct-output" as const, recipient };
      const mapped = mapRuntimeAssetSettlementRequest({ route, executor, request }); assert(mapped);
      if (route.buy) {
        assert.deepEqual(mapped, request);
        assert.throws(() => plugin.execution.buildRuntimeLeg!({ descriptor: d, route, executor, runtimeEvidence: [], settlement: mapped }));
      } else {
        assert.equal(mapped.kind, "direct-output");
        if (mapped.kind !== "direct-output") throw new Error("unexpected native settlement mapping");
        assert.equal(mapped.recipient, executor);
        assert(plugin.execution.buildRuntimeLeg!({ descriptor: d, route, executor, runtimeEvidence: [], settlement: mapped }));
      }
    }
    for (const recipient of [ethers.ZeroAddress, route.tokenIn, route.tokenOut]) {
      assert.throws(() => mapRuntimeAssetSettlementRequest({ route, executor, request: { kind: "direct-output", recipient } }));
    }
  }
});
