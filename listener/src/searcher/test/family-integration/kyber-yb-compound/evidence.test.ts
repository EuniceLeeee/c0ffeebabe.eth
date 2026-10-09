// OFFLINE input/observation regressions. These fixtures are NOT EVM receipts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { KYSWAP_POOL_INTERFACE as KYBER } from "../../../venues/swaps/kyberswap-elastic-family/abi.js";
import { ALGEBRA_POOL_INTERFACE as ALGEBRA } from "../../../venues/swaps/algebra-integral-family/abi.js";
import { LT_INTERFACE as LT } from "../../../venues/protocols/yieldbasis-lt-family/abi.js";
import { CTOKEN_INTERFACE as CT } from "../../../venues/protocols/compound-ctoken-family/abi.js";
import { options, SAMPLES, ERC20, assertHeader, assertPriceInput, productionAmount, splicedProductionAmount, originalLeg,
  assertReceipt, observeBalance, assertDeltas, constructionGuard, word, assertOriginAccountCode, matchesBalanceSlotProbe, isLocalBalanceProbeRevert, assertNativeInventory } from "./evidence.js";
import { blockScanEdgeKey } from "../../../venues/blockscan-state-capability.js";

const actor = "0x1000000000000000000000000000000000000001";
const asset = "0x1000000000000000000000000000000000000002";
const token0 = "0x1000000000000000000000000000000000000003";
const hash = "0x" + "11".repeat(32), other = "0x" + "22".repeat(32);
const header = { number: "0x18be02f", hash, parentHash: other, stateRoot: hash, timestamp: "0x1234",
  baseFeePerGas: "0x1", gasLimit: "0x2000000", miner: actor, mixHash: other };
const source = { number: Number(BigInt(header.number)), hash, generation: 7 };
const event = (abi: ethers.Interface, name: string, args: unknown[], address: string) =>
  ({ address, ...abi.encodeEventLog(abi.getEvent(name)!, args), logIndex: "0x1" });
const transfer = (instance: string, value: bigint) => event(ERC20, "Transfer", [instance, actor, value], asset);

test("native observation detects one-unit residual, old-inventory debit and deleted actor", () => {
  const state = (n: bigint) => ({ pre: { [actor]: { balance: "0x11" } }, post: { [actor]: { balance: ethers.toQuantity(n) } } });
  assert.deepEqual(assertNativeInventory(state(17n), actor, 17n), { before: 17n, after: 17n, delta: 0n });
  assertNativeInventory({ pre: {}, post: {} }, actor, 17n);
  for (const n of [0n, 16n, 18n, 10n ** 18n]) assert.throws(() => assertNativeInventory(state(n), actor, 17n));
  assert.throws(() => assertNativeInventory({ pre: { [actor]: { balance: "0x11" } }, post: {} }, actor, 17n));
  assert.throws(() => assertNativeInventory(state(17n), actor, 16n));
});

test("origin guard accepts EIP-7702 exactly, without accepting arbitrary contract code", () => {
  assertOriginAccountCode("0x");
  const delegated = "0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b";
  assertOriginAccountCode(delegated);
  assertOriginAccountCode(delegated.toUpperCase());
  for (const code of ["0x00", "0x60006000f3", "0xef0100", delegated.slice(0, -2),
    delegated + "00", delegated.replace("ef0100", "ef0101"), delegated.replace(/b$/, "z")]) {
    assert.throws(() => assertOriginAccountCode(code));
  }
});

test("only an exact ABI word with the injected balance proves a candidate storage slot", () => {
  assert(matchesBalanceSlotProbe(word(717171717171n), 717171717171n));
  for (const raw of ["0x", "0x00", "0x01", word(1n), "garbage", word(717171717171n) + "00"]) {
    assert.equal(matchesBalanceSlotProbe(raw, 717171717171n), false);
  }
});

test("probe failure classification never swallows transport, unknown, upstream or malformed errors", () => {
  const revert = (fields = {}) => Object.assign(new Error("execution reverted"),
    { localCall: true, rpcCode: 3, returnData: "0x", ...fields });
  assert(isLocalBalanceProbeRevert(revert()));
  assert(isLocalBalanceProbeRevert(revert({ returnData: "0x1234" })));
  for (const error of [new Error("HTTP 429"), revert({ rpcCode: -32000 }), revert({ rpcCode: 429 }),
    revert({ localCall: false }), revert({ returnData: undefined }), revert({ returnData: "not-hex" }),
    revert({ returnData: "0x1" }), revert({ returnData: "0xabc" }),
    { localCall: true, rpcCode: 3, returnData: "0x" }, null]) assert.equal(isLocalBalanceProbeRevert(error), false);
});

test("paired fixed-family CLI rejects arbitrary samples, repeats, missing/unsafe ports", () => {
  const args = ["--family", "yb", "--ready", "ready.json", "--prices", "prices.json", "--port", "18593", "--out", "new.json"];
  assert.equal(options(args).family, "yb");
  assert.throws(() => options([...args, "--family", "yb"]));
  assert.throws(() => options(args.slice(0, -1)));
  assert.throws(() => options(args.map(v => v === "yb" ? "arbitrary" : v)));
  for (const p of ["0", "1", "65536", "18593junk", "NaN"]) assert.throws(() => options(args.map(v => v === "18593" ? p : v)));
  const optional = ["--reference-prices", "donor.json", "--reference-edges", '["edge"]'];
  assert.deepEqual(options([...args, ...optional]).referenceEdges, ["edge"]);
  assert.throws(() => options([...args, ...optional.slice(0, 2)]));
  assert.throws(() => options([...args, ...optional.slice(2)]));
  for (const v of ['[]', '["edge","edge"]', '[1]', '{}', 'invalid']) {
    assert.throws(() => options([...args, ...optional.slice(0, 3), v]));
  }
});

test("N header checks timestamp/hash/stateRoot and refuses missing fields", () => {
  assertHeader(header, header);
  for (const key of ["number", "hash", "timestamp", "stateRoot", "mixHash"]) {
    assert.throws(() => assertHeader({ ...header, [key]: "0x0" }, header));
    assert.throws(() => assertHeader({}, {}));
  }
});

function anchored() {
  const ready = { cutoff: source, universeRange: { fromBlock: source.number, toBlock: source.number } };
  const saved = { readySha256: "ready", runtime: { sourceBlock: source.number, sourceBlockHash: hash,
    pricing: { sourceBlock: source.number, sourceBlockHash: hash } } };
  const provenance = { readySha256: "ready", executionMode: "source-block", through: "prices", broadcast: false,
    chainId: "1", implementation: { sourceTreeSha256: "source" }, sourceHeader: header, stateSource: source, topologySource: source };
  return { ready, saved, provenance, input: { readySha256: "ready", sourceTreeSha256: "source", number: source.number } };
}
test("source/Ready fingerprints, N environment and single-block natural scope are mandatory", () => {
  const a = anchored(); assertPriceInput(a.saved, a.provenance, a.ready, a.input);
  for (const mutate of [
    (a: ReturnType<typeof anchored>) => { a.saved.readySha256 = "stale"; },
    (a: ReturnType<typeof anchored>) => { a.provenance.implementation.sourceTreeSha256 = "stale"; },
    (a: ReturnType<typeof anchored>) => { a.provenance.executionMode = "next-block"; },
    (a: ReturnType<typeof anchored>) => { a.saved.runtime.sourceBlock++; },
    (a: ReturnType<typeof anchored>) => { a.ready.universeRange.fromBlock--; },
  ]) { const b = anchored(); mutate(b); assert.throws(() => assertPriceInput(b.saved, b.provenance, b.ready, b.input)); }
});

test("missing valuation never creates a production reference amount; stale/wrong-direction rows reject", () => {
  const edge = { instanceKey: actor, tokenIn: token0, tokenOut: asset };
  const row = { ...edge, amountIn: 17n, amountOut: 19n, status: "quoted", quotedAt: source };
  assert.equal(productionAmount(row, { mid: 1 }, edge, source, 7).status, "met");
  assert.deepEqual(productionAmount(undefined, undefined, edge, source, 7), { status: "unmet", reason: "missing-effective-row" });
  assert.equal(productionAmount({ status: "unreachable" }, { mid: 1 }, edge, source, 7).status, "unmet");
  assert.throws(() => productionAmount({ ...row, tokenIn: asset }, { mid: 1 }, edge, source, 7));
  assert.throws(() => productionAmount(row, { mid: 0 }, edge, source, 7));
  assert.throws(() => productionAmount(row, { mid: 1 }, edge, source, 8));
  assert.throws(() => productionAmount({ ...row, quotedAt: { ...source, hash: other } }, { mid: 1 }, edge, source, 7));
});

function donorFixture() {
  const edge = { canonicalEdgeId: "fixture-edge", adapterId: "univ2-standard", target: actor, instanceKey: actor,
    tokenIn: token0, tokenOut: asset, slotKind: "swap" };
  const edgeId = blockScanEdgeKey(edge as any);
  const row = { ...edge, edgeId, amountIn: 17n, amountOut: 900n, status: "quoted",
    quotedAt: { number: source.number - 1, hash: other, generation: source.generation - 1 } };
  const cfg = { minCapitalFraction: 0.001 };
  const readyPath = "/fixture/ready.json", readySha256 = "33".repeat(32);
  const saved = { cfg, readyPath, readySha256, header: { ...source, parentHash: other }, runtime: { sourceBlock: source.number, sourceBlockHash: source.hash,
    generation: source.generation, graph: { edges: [edge] }, pricing: { generation: source.generation, sourceBlock: source.number,
      sourceBlockHash: source.hash, effectiveMids: { source: { ...source }, rows: new Map([[edgeId, row]]) } } } };
  const declaration = { benchmark: "effective-update", liveStarted: false, broadcast: false, signing: false,
    head: "44".repeat(20), bindings: ["/fixture/listener/benchmarks/effective-update.ts", "/fixture/listener/src/searcher/blockscan-runtime-loop.ts",
      "/fixture/listener/src/searcher/main.ts", readyPath].map(path => ({ path, sha256: readySha256 })),
    graphEdges: 1, cfg, notifications: [source] };
  return { saved, declaration, edgeId, row };
}

test("explicit donor takes only recorded input; carried provenance cannot become target valuation/output", () => {
  const d = donorFixture();
  const result = splicedProductionAmount(d.saved, d.declaration, [d.edgeId], token0);
  assert.equal(result.amountIn, 17n); assert.equal(result.freshness, "carried");
  assert.equal(result.donorRow.amountOut, 900n); // provenance only, not a target expected output
  assert(!Object.hasOwn(result, "amountOut")); assert.match(result.naturalTargetValuation, /unmet/);
  assert.equal(productionAmount({ status: "missing-valuation" }, undefined, {}, source, 7).status, "unmet");
  d.row.quotedAt = { ...source };
  assert.equal(splicedProductionAmount(d.saved, d.declaration, [d.edgeId], token0).freshness, "fresh");
});

test("donor bridge rejects mismatched tokens, source/graph/config, future rows and invalid amounts", () => {
  const d = donorFixture();
  assert.throws(() => splicedProductionAmount(d.saved, d.declaration, [d.edgeId], actor));
  assert.throws(() => splicedProductionAmount(d.saved, d.declaration, [d.edgeId, d.edgeId], token0));
  assert.throws(() => splicedProductionAmount(d.saved, d.declaration, ["absent"], token0));
  for (const mutate of [
    (d: ReturnType<typeof donorFixture>) => { d.row.tokenIn = actor; },
    (d: ReturnType<typeof donorFixture>) => { d.row.status = "failed"; },
    (d: ReturnType<typeof donorFixture>) => { d.row.amountIn = 0n; },
    (d: ReturnType<typeof donorFixture>) => { d.row.amountIn = ethers.MaxUint256 + 1n; },
    (d: ReturnType<typeof donorFixture>) => { d.row.quotedAt.number = source.number + 1; },
    (d: ReturnType<typeof donorFixture>) => { d.row.quotedAt.hash = "malformed"; },
    (d: ReturnType<typeof donorFixture>) => { d.row.quotedAt = { ...source, hash: other }; },
    (d: ReturnType<typeof donorFixture>) => { d.saved.runtime.graph.edges = []; },
    (d: ReturnType<typeof donorFixture>) => { d.saved.cfg = { minCapitalFraction: 0.1 }; },
    (d: ReturnType<typeof donorFixture>) => { d.declaration.notifications = []; },
    (d: ReturnType<typeof donorFixture>) => { d.declaration.liveStarted = true; },
    (d: ReturnType<typeof donorFixture>) => { d.saved.readySha256 = "55".repeat(32); },
    (d: ReturnType<typeof donorFixture>) => { d.declaration.bindings = []; },
    (d: ReturnType<typeof donorFixture>) => { d.declaration.bindings = d.declaration.bindings.slice(1); },
    (d: ReturnType<typeof donorFixture>) => { d.declaration.head = "missing"; },
    (d: ReturnType<typeof donorFixture>) => { d.saved.header.parentHash = hash; },
    (d: ReturnType<typeof donorFixture>) => { d.declaration.notifications.push({ ...d.row.quotedAt, hash }); },
    (d: ReturnType<typeof donorFixture>) => { d.saved.runtime.pricing.effectiveMids.source.generation++; },
    (d: ReturnType<typeof donorFixture>) => { d.saved.runtime.pricing.generation++; },
    (d: ReturnType<typeof donorFixture>) => { d.saved.runtime.pricing.sourceBlockHash = other; },
  ]) { const broken = donorFixture(); mutate(broken);
    assert.throws(() => splicedProductionAmount(broken.saved, broken.declaration, [broken.edgeId], token0)); }
});

test("receipt anchors reject another transaction, block, failed receipt or removed log", () => {
  const r = { transactionHash: hash, blockHash: hash, blockNumber: header.number, status: "0x1", logs: [] };
  assertReceipt(r, hash, header);
  assert.throws(() => assertReceipt(r, other, header));
  assert.throws(() => assertReceipt({ ...r, blockHash: other }, hash, header));
  assert.throws(() => assertReceipt({ ...r, status: "0x0" }, hash, header));
  assert.throws(() => assertReceipt({ ...r, logs: [{ removed: true }] }, hash, header));
});

test("Kyber observed signed amounts select only the real full exact-input direction", () => {
  const instance = SAMPLES.kyber.instances[0], descriptor = { token0, token1: asset };
  const log = event(KYBER, "Swap", [actor, actor, 17n, -19n, 2n ** 96n, 100n, 0], instance);
  const receipt = { logs: [log, transfer(instance, 19n)] };
  const trace = { type: "CALL", from: actor, to: instance,
    input: KYBER.encodeFunctionData("swap", [actor, 17n, true, 1n, "0x"]), output: KYBER.encodeFunctionResult("swap", [17n, -19n]) };
  const leg = originalLeg("kyber", instance, descriptor, receipt, trace);
  assert.equal(leg.amountIn, 17n); assert.equal(leg.tokenIn, token0);
  assert.throws(() => originalLeg("kyber", instance, descriptor, receipt, { ...trace, input: KYBER.encodeFunctionData("swap", [actor, -19n, false, 1n, "0x"]) }));
  assert.throws(() => originalLeg("kyber", instance, descriptor, receipt, { error: "reverted", calls: [trace] }));
});

for (const key of ["algebra", "algebra2", "algebra3", "algebra4", "algebra5", "algebra6"] as const) {
  test(`${key}: observed swap binds its own ABI, direction, full input and settled output`, () => {
    const instance = SAMPLES[key].instances[0], descriptor = { token0, token1: asset };
    const args = ["--family", key, "--ready", "ready.json", "--prices", "prices.json", "--port", "18593", "--out", "new.json"];
    assert.equal(options(args).family, key);
    for (const zeroToOne of [true, false]) {
      const amount0 = zeroToOne ? 17n : -19n, amount1 = zeroToOne ? -19n : 17n;
      const outputToken = zeroToOne ? asset : token0;
      const log = event(ALGEBRA, "Swap", [actor, actor, amount0, amount1, 2n ** 96n, 100n, 0, 37, 5], instance);
      const receipt = { logs: [log, event(ERC20, "Transfer", [instance, actor, 19n], outputToken)] };
      const trace = { type: "CALL", from: actor, to: instance,
        input: ALGEBRA.encodeFunctionData("swap", [actor, zeroToOne, 17n, 1n, "0x"]),
        output: ALGEBRA.encodeFunctionResult("swap", [amount0, amount1]) };
      const original = originalLeg(key, instance, descriptor, receipt, trace);
      assert.equal(original.amountIn, 17n); assert.equal(original.amountOut, 19n);
      assert.equal(original.tokenIn, zeroToOne ? token0 : asset); assert.equal(original.tokenOut, outputToken);
      for (const input of [
        ALGEBRA.encodeFunctionData("swap", [actor, zeroToOne, -19n, 1n, "0x"]),
        ALGEBRA.encodeFunctionData("swap", [actor, zeroToOne, 18n, 1n, "0x"]),
        ALGEBRA.encodeFunctionData("swap", [actor, !zeroToOne, 17n, 1n, "0x"]),
      ]) assert.throws(() => originalLeg(key, instance, descriptor, receipt, { ...trace, input }));
      assert.throws(() => originalLeg(key, instance, descriptor, receipt, { calls: [{ error: "reverted", calls: [trace] }] }));
      const univ3Log = { ...log, topics: [ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)"), ...log.topics.slice(1)] };
      assert.throws(() => originalLeg(key, instance, descriptor, { logs: [univ3Log, receipt.logs[1]] }, trace));
      assert.throws(() => originalLeg(key, instance, descriptor, { logs: [log] }, trace));
    }
  });
}

test("YB accepts ordinary withdraw; same Withdraw event with emergency call is insufficient", () => {
  const instance = SAMPLES.yb.instances[0], descriptor = { share: instance, asset };
  const receipt = { logs: [event(LT, "Withdraw", [actor, actor, actor, 19n, 17n], instance), transfer(instance, 19n)] };
  const trace = { type: "CALL", from: actor, to: instance,
    input: LT.encodeFunctionData("withdraw(uint256,uint256)", [17n, 0n]), output: LT.encodeFunctionResult("withdraw(uint256,uint256)", [19n]) };
  assert.equal(originalLeg("yb", instance, descriptor, receipt, trace).amountOut, 19n);
  assert.throws(() => originalLeg("yb", instance, descriptor, receipt, { ...trace, input: LT.encodeFunctionData("emergency_withdraw(uint256)", [17n]) }));
  assert.throws(() => originalLeg("yb", instance, descriptor, receipt, { ...trace, output: LT.encodeFunctionResult("withdraw(uint256,uint256)", [18n]) }));
});

test("Compound redeemUnderlying maps real burned shares, never declares original share-input parity", () => {
  const instance = SAMPLES.compound.instances[0], descriptor = { share: instance, underlying: asset };
  const receipt = { logs: [event(CT, "Redeem", [actor, 19n, 17n], instance), transfer(instance, 19n)] };
  const trace = { type: "CALL", from: actor, to: instance, input: CT.encodeFunctionData("redeemUnderlying", [19n]), output: CT.encodeFunctionResult("redeemUnderlying", [0n]) };
  const leg = originalLeg("compound", instance, descriptor, receipt, trace);
  assert.equal(leg.amountIn, 17n); assert.equal(leg.originalInterface, "redeemUnderlying"); assert.match(leg.comparison, /NOT original/);
  assert.throws(() => originalLeg("compound", instance, descriptor, receipt, { ...trace, output: CT.encodeFunctionResult("redeemUnderlying", [1n]) }));
  assert.throws(() => originalLeg("compound", instance, descriptor, receipt, { type: "CALL", error: "reverted", calls: [trace] }));
  assert.throws(() => originalLeg("compound", instance, descriptor, { logs: [...receipt.logs, receipt.logs[0]] }, trace));
});

test("runtime construction guard traps Exact, quoted fallback and service access before executing them", () => {
  const g = constructionGuard(); let executed = false;
  assert.throws(() => g.build(() => g.exact(() => { executed = true; })));
  assert.throws(() => g.build(() => g.quoted(() => { executed = true; })));
  const runtime = g.runtime({ callerAuthority: 1, generationFence: 2, requests: 3 });
  assert.equal(g.build(() => runtime.callerAuthority), 1);
  assert.throws(() => g.build(() => runtime.requests));
  assert.equal(executed, false); assert.equal(g.counts.exact, 0); assert.equal(g.counts.quoted, 0);
});

test("observation rejects missing credit even when initial output inventory exceeds quote", () => {
  const slot = word(5n), initial = 1000n;
  const absent = observeBalance({ pre: {}, post: {} }, asset, slot, initial);
  assert.equal(absent.delta, 0n);
  const input = { before: 27n, after: 10n, delta: -17n };
  assert.throws(() => assertDeltas(input, absent, 17n, 19n));
  const diff = { pre: { [asset]: { storage: { [slot]: word(initial) } } }, post: { [asset]: { storage: { [slot]: word(initial + 19n) } } } };
  assertDeltas(input, observeBalance(diff, asset, slot, initial), 17n, 19n);
  assert.throws(() => observeBalance(diff, asset, slot, 0n));
  assert.throws(() => assertDeltas({ before: 27n, after: 0n, delta: -27n }, observeBalance(diff, asset, slot, initial), 17n, 19n));
  assert.throws(() => observeBalance({}, asset, slot, initial));
});
