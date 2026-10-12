// OFFLINE input/observation regressions. These fixtures are NOT EVM receipts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ethers } from "ethers";
import { KYSWAP_POOL_INTERFACE as KYBER } from "../../../venues/swaps/kyberswap-elastic-family/abi.js";
import { ALGEBRA_POOL_INTERFACE as ALGEBRA } from "../../../venues/swaps/algebra-integral-family/abi.js";
import { LT_INTERFACE as LT } from "../../../venues/protocols/yieldbasis-lt-family/abi.js";
import { CTOKEN_INTERFACE as CT } from "../../../venues/protocols/compound-ctoken-family/abi.js";
import { ERC4626_INTERFACE as VAULT } from "../../../venues/protocols/erc4626-family/abi.js";
import { options, SAMPLES, ERC20, assertHeader, assertPriceInput, productionAmount, splicedProductionAmount, originalLeg, originalLegs, originalDirections, historicalAmountTrials,
  assertReceipt, observeBalance, assertDeltas, constructionGuard, word, assertOriginAccountCode, matchesBalanceSlotProbe, isLocalBalanceProbeRevert, assertNativeInventory, assertExecutorCode } from "./evidence.js";
import { blockScanEdgeKey } from "../../../venues/blockscan-state-capability.js";

const actor = "0x1000000000000000000000000000000000000001";
const asset = "0x1000000000000000000000000000000000000002";
const token0 = "0x1000000000000000000000000000000000000003";
const hash = "0x" + "11".repeat(32), other = "0x" + "22".repeat(32);
const header = { number: "0x18be02f", hash, parentHash: other, stateRoot: hash, timestamp: "0x1234",
  baseFeePerGas: "0x1", gasLimit: "0x2000000", miner: actor, mixHash: other };
const source = { number: Number(BigInt(header.number)), hash, generation: 7 };

test("historical consumer does not relabel every non-original trial as a production reference", () => {
  const consumer = readFileSync(new URL("./historical-dual.ts", import.meta.url), "utf8");
  assert.match(consumer, /verdict: "non-original amount trial; no original TX leg comparison"/);
  assert.doesNotMatch(consumer, /verdict: "production reference amount; no original TX leg comparison"/);
});

test("executor upgrade is explicit, old-code-pinned, source-trusted and not the default", () => {
  const old = "0x6000", current = "0x6001", h = ethers.keccak256(old);
  assertExecutorCode("0x", current); assertExecutorCode(current, current);
  assert.throws(() => assertExecutorCode(old, current));
  assert.throws(() => assertExecutorCode(old, current, other));
  assert.throws(() => assertExecutorCode(old, current, "0x"));
  assert.throws(() => assertExecutorCode("0x", current, ethers.keccak256("0x")));
  assert.throws(() => assertExecutorCode(current, current, ethers.keccak256(current)));
  assert.throws(() => assertExecutorCode(old, "0x", h));
  const result = assertExecutorCode(old, current, h);
  assert.equal(result.historicalHash, h); assert.equal(result.runtimeHash, ethers.keccak256(current));
  assert.equal(result.replacement, true); assert.equal(result.historicalRuntimeExecuted, false);
});
const event = (abi: ethers.Interface, name: string, args: unknown[], address: string) =>
  ({ address, ...abi.encodeEventLog(abi.getEvent(name)!, args), logIndex: "0x1" });
const transfer = (instance: string, value: bigint) => event(ERC20, "Transfer", [instance, actor, value], asset);
const TRANSFER = new ethers.Interface(["function transfer(address,uint256) returns(bool)"]);
const swapPayment = (instance: string, token: string) => ({ type: "CALL", from: instance, to: token,
  input: TRANSFER.encodeFunctionData("transfer", [actor, 19n]), output: word(1n) });

function assertSwapPaymentAttribution(key: Parameters<typeof originalLeg>[0], instance: string,
  descriptor: any, receipt: any, trace: any, token: string) {
  const payment = trace.calls[0];
  const foreign = event(ERC20, "Transfer", [token0, actor, 19n], token);
  // Same-value flashloan funding is independent of the pool's output receipt.
  assert.equal(originalLeg(key, instance, descriptor, { logs: [foreign, ...receipt.logs] }, trace).amountOut, 19n);
  assert.throws(() => originalLeg(key, instance, descriptor, { logs: [receipt.logs[0], foreign] }, trace));
  assert.throws(() => originalLeg(key, instance, descriptor, { logs: [...receipt.logs, receipt.logs[1]] }, trace));
  assert.throws(() => originalLeg(key, instance, descriptor, receipt, { ...trace, calls: [] }));
  assert.throws(() => originalLeg(key, instance, descriptor, receipt,
    { calls: [{ ...trace, calls: [] }, payment] })); // sibling is not this swap's payment
  assert.throws(() => originalLeg(key, instance, descriptor, receipt,
    { ...trace, calls: [payment, payment] }));
  for (const calls of [
    [{ ...payment, from: actor }], [{ ...payment, error: "reverted" }],
    [{ error: "reverted", calls: [payment] }], [{ revertReason: "reverted", calls: [payment] }],
    [{ ...payment, input: TRANSFER.encodeFunctionData("transfer", [actor, 18n]) }],
    [{ ...payment, input: TRANSFER.encodeFunctionData("transfer", [token0, 19n]) }],
    [{ ...payment, to: instance }], [{ ...payment, type: "STATICCALL" }],
  ]) assert.throws(() => originalLeg(key, instance, descriptor, receipt, { ...trace, calls }));
  for (const output of [word(0n), word(2n), "0x01", "malformed", word(1n) + "00"])
    assert.throws(() => originalLeg(key, instance, descriptor, receipt,
      { ...trace, calls: [{ ...payment, output }] }));
  // USDT can return no bytes on a successful transfer; receipt remains mandatory.
  for (const output of ["0x", undefined]) assert.equal(originalLeg(key, instance, descriptor, receipt,
    { ...trace, calls: [{ ...payment, output }] }).amountOut, 19n);
}

test("no-hook native sample is distinct from Sat1 and uses the bound V4 observer", () => {
  const sample = SAMPLES["v4-native-nohook"];
  assert.equal(sample.family, "univ4");
  assert.equal(sample.number, 26029537);
  assert.notEqual(sample.tx, SAMPLES["v4-sat1"].tx);
  const [manager, poolId] = sample.instances[0].split("\u001f");
  assert(ethers.isAddress(manager) && ethers.isHexString(poolId, 32));
  assert.equal(options(["--family", "v4-native-nohook", "--ready", "ready.json", "--prices", "prices.json",
    "--port", "18593", "--out", "new.json"]).family, "v4-native-nohook");
  // A bare pool id must not be accepted as this manager's canonical instance.
  assert.throws(() => originalLeg("v4-native-nohook", poolId!,
    { poolId, managerBinding: { manager }, poolKey: {} }, { status: "0x1" }, {}),
    /V4 instance is manager plus poolId/);
});

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

for (const key of ["kyber", "kyber2", "kyber3", "kyber4", "kyber5", "kyber6", "kyber7", "kyber8", "kyber9"] as const) {
  test(`${key}: its own ABI binds signed amounts, both directions and settled receipts`, () => {
    const instance = SAMPLES[key].instances[0], descriptor = { token0, token1: asset };
    assert.equal(options(["--family", key, "--ready", "ready.json", "--prices", "prices.json",
      "--port", "18593", "--out", "new.json"]).family, key);
    for (const zeroIn of [true, false]) {
      const amount0 = zeroIn ? 17n : -19n, amount1 = zeroIn ? -19n : 17n;
      const outputToken = zeroIn ? asset : token0;
      const log = event(KYBER, "Swap", [actor, actor, amount0, amount1, 2n ** 96n, 100n, 0], instance);
      const receipt = { logs: [log, event(ERC20, "Transfer", [instance, actor, 19n], outputToken)] };
      const trace = { type: "CALL", from: actor, to: instance,
        input: KYBER.encodeFunctionData("swap", [actor, 17n, zeroIn, 1n, "0x"]),
        output: KYBER.encodeFunctionResult("swap", [amount0, amount1]), calls: [swapPayment(instance, outputToken)] };
      const leg = originalLeg(key, instance, descriptor, receipt, trace);
      assert.equal(leg.amountIn, 17n); assert.equal(leg.amountOut, 19n);
      assert.equal(leg.tokenIn, zeroIn ? token0 : asset); assert.equal(leg.tokenOut, outputToken);
      for (const input of [
        KYBER.encodeFunctionData("swap", [actor, -19n, !zeroIn, 1n, "0x"]),
        KYBER.encodeFunctionData("swap", [actor, 18n, zeroIn, 1n, "0x"]),
        KYBER.encodeFunctionData("swap", [actor, 17n, !zeroIn, 1n, "0x"]),
      ]) assert.throws(() => originalLeg(key, instance, descriptor, receipt, { ...trace, input }));
      assert.throws(() => originalLeg(key, instance, descriptor, receipt, { error: "reverted", calls: [trace] }));
      assert.throws(() => originalLeg(key, instance, descriptor, receipt, { calls: [{ error: "reverted", calls: [trace] }] }));
      assert.throws(() => originalLeg(key, instance, descriptor, { logs: [log] }, trace));
      assert.throws(() => originalLeg(key, instance, descriptor, { logs: [...receipt.logs, log] }, trace));
      assertSwapPaymentAttribution(key, instance, descriptor, receipt, trace, outputToken);
    }
  });
}

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
        output: ALGEBRA.encodeFunctionResult("swap", [amount0, amount1]), calls: [swapPayment(instance, outputToken)] };
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
      assertSwapPaymentAttribution(key, instance, descriptor, receipt, trace, outputToken);
    }
  });
}

for (const deposit of [true, false]) test(`standard ERC4626 ${deposit ? "deposit" : "redeem"} binds call, event and independent receipt`, () => {
  const instance = SAMPLES["erc4626-fluid"].instances[deposit ? 0 : 1];
  const descriptor = { vault: instance, share: instance, asset };
  const method = deposit ? "deposit" : "redeem";
  const log = event(VAULT, deposit ? "Deposit" : "Withdraw",
    deposit ? [actor, actor, 17n, 19n] : [actor, actor, actor, 19n, 17n], instance);
  const receipt = { logs: [log, event(ERC20, "Transfer",
    [deposit ? ethers.ZeroAddress : instance, actor, 19n], deposit ? instance : asset)] };
  const input = (amount: bigint) => VAULT.encodeFunctionData(method,
    deposit ? [amount, actor] : [amount, actor, actor]);
  const trace = { type: "CALL", from: actor, to: instance, input: input(17n),
    output: VAULT.encodeFunctionResult(method, [19n]), logs: receipt.logs };
  const leg = originalLeg("erc4626-fluid", instance, descriptor, receipt, trace);
  assert.equal(leg.amountIn, 17n); assert.equal(leg.amountOut, 19n);
  assert.equal(leg.tokenIn, deposit ? asset : instance);
  assert.equal(leg.tokenOut, deposit ? instance : asset);
  assert.equal(leg.originalInterface, method);
  assert.throws(() => originalLeg("erc4626-fluid", instance, descriptor, receipt, { ...trace, input: input(18n) }));
  assert.throws(() => originalLeg("erc4626-fluid", instance, descriptor, receipt,
    { ...trace, output: VAULT.encodeFunctionResult(method, [18n]) }));
  assert.throws(() => originalLeg("erc4626-fluid", instance, descriptor, { logs: [log] }, trace));
  assert.throws(() => originalLeg("erc4626-fluid", instance, descriptor, { logs: [...receipt.logs, log] }, trace));
  assert.throws(() => originalLeg("erc4626-fluid", instance, descriptor, receipt, { error: "revert", calls: [trace] }));
  assert.throws(() => originalLeg("erc4626-fluid", instance, descriptor, receipt,
    { calls: [{ error: "revert", calls: [trace] }] }));
  assert.throws(() => originalLeg("erc4626-fluid", instance, { ...descriptor, custodian: {} }, receipt, trace));
  const wrongReceipt = { logs: [log, event(ERC20, "Transfer",
    [deposit ? ethers.ZeroAddress : instance, token0, 19n], deposit ? instance : asset)] };
  assert.throws(() => originalLeg("erc4626-fluid", instance, descriptor, wrongReceipt, trace));
  // Receipt-wide uniqueness is insufficient: bind both event and payment to
  // this successful subtree, including a non-vault liquidity payer.
  const payment = receipt.logs[1]!;
  for (const [inside, sibling] of [[[log], [payment]], [[payment], [log]]]) {
    assert.throws(() => originalLeg("erc4626-fluid", instance, descriptor, receipt,
      { calls: [{ ...trace, logs: inside }, { logs: sibling }] }), /selected successful vault subtree/);
  }
  assert.throws(() => originalLeg("erc4626-fluid", instance, descriptor, receipt,
    { ...trace, logs: [log], calls: [{ error: "revert", logs: [payment] }] }), /selected successful vault subtree/);
  assert.throws(() => originalLeg("erc4626-fluid", instance, descriptor, receipt,
    { ...trace, calls: [{ logs: [payment] }] }), /selected successful vault subtree/);
});

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

// Synthetic OFFLINE cUNI observations; these amounts are not a saved production
// reference or historical execution evidence. Only the registry pins the real TX.
const cuniUnderlying = "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984";
function cuniFixture(burnedShares = 17n, underlyingOutput = 19n) {
  const instance = SAMPLES.cuni.instances[0], descriptor = { share: instance, underlying: cuniUnderlying };
  const receipt: any = { logs: [
    event(CT, "Redeem", [actor, underlyingOutput, burnedShares], instance),
    event(ERC20, "Transfer", [instance, actor, underlyingOutput], cuniUnderlying),
  ] };
  const trace: any = { type: "CALL", from: actor, to: instance,
    input: CT.encodeFunctionData("redeemUnderlying", [underlyingOutput]),
    output: CT.encodeFunctionResult("redeemUnderlying", [0n]) };
  return { instance, descriptor, receipt, trace, burnedShares, underlyingOutput };
}
const observeCuni = (f: ReturnType<typeof cuniFixture>) =>
  originalLegs("cuni", f.instance, f.descriptor, f.receipt, f.trace);

test("cUNI is a separate pinned sample and preserves the cUSDC/cDAI record", () => {
  assert.deepEqual(SAMPLES.cuni, { family: "protocol:compound-ctoken", number: 26037262,
    tx: "0x50f2112fea14632548cfb10268c6f091f0733e5a50fc97e375c54209381d656a",
    instances: ["0x35a18000230da775cac24873d00ff85bccded550"] });
  assert.deepEqual(SAMPLES.compound, { family: "protocol:compound-ctoken", number: 25944463,
    tx: "0x032b820506f44423a7f62918464e8e735619ff463bb6ecce1b3d0d6299ba99df",
    instances: ["0x39aa39c021dfbae8fac545936693ac917d5e7563", "0x5d3a536e4d6dbd6114cc1ead35777bab948e3643"] });
  assert.equal(options(["--family", "cuni", "--ready", "ready.json", "--prices", "prices.json",
    "--port", "18593", "--out", "new.json"]).family, "cuni");
});

test("cUNI redeemUnderlying observes event shares, not its underlying-output argument or zero return code", () => {
  for (const [shares, underlying] of [[17n, 19n], [123456789n, 5n * 10n ** 18n]]) {
    const f = cuniFixture(shares, underlying);
    const direct = originalLeg("cuni", f.instance, f.descriptor, f.receipt, f.trace);
    // Delegation is implementation dispatch, not a second redemption.
    f.trace = { calls: [{ ...f.trace, calls: [{ ...f.trace, type: "DELEGATECALL" }] }] };
    const legs = observeCuni(f);
    assert.deepEqual(legs, [direct]);
    const leg = legs[0]!;
    assert.equal(leg.amountIn, shares); assert.equal(leg.amountOut, underlying);
    assert.notEqual(leg.amountIn, CT.decodeFunctionData("redeemUnderlying", f.trace.calls[0].input)[0]);
    assert.equal(leg.tokenIn, f.instance); assert.equal(leg.tokenOut, cuniUnderlying);
    assert.equal(leg.caller, actor); assert.equal(leg.recipient, actor);
    assert.equal(leg.originalInterface, "redeemUnderlying");
    assert.equal(leg.comparison,
      "redeemUnderlying observed; burned shares mapped to redeem at N-end, NOT original interface/pre-call parity");
  }
});

test("cUNI observation rejects mismatched, ambiguous, failed and incomplete redemption evidence", () => {
  const rejected: [string, (f: ReturnType<typeof cuniFixture>) => void][] = [
    ["underlying calldata replaced with share quantity", f => {
      f.trace.input = CT.encodeFunctionData("redeemUnderlying", [f.burnedShares]);
    }],
    ["wrong caller", f => { f.trace.from = token0; }],
    ["wrong market", f => { f.trace.to = SAMPLES.compound.instances[0]; }],
    ["nonzero Compound error code", f => { f.trace.output = CT.encodeFunctionResult("redeemUnderlying", [1n]); }],
    ["missing return data", f => { delete f.trace.output; }],
    ["malformed return data", f => { f.trace.output = "0x01"; }],
    ["delegatecall without external redemption", f => { f.trace.type = "DELEGATECALL"; }],
    ["staticcall is not redemption", f => { f.trace.type = "STATICCALL"; }],
    ["reverted root", f => { f.trace = { error: "reverted", calls: [f.trace] }; }],
    ["reverted ancestor", f => { f.trace = { calls: [{ revertReason: "reverted", calls: [f.trace] }] }; }],
    ["multiple successful calls", f => { f.trace = { calls: [f.trace, structuredClone(f.trace)] }; }],
    ["missing Redeem event", f => { f.receipt.logs.shift(); }],
    ["duplicate Redeem event", f => { f.receipt.logs.push(structuredClone(f.receipt.logs[0])); }],
    ["wrong event redeemer", f => { f.receipt.logs[0] = event(CT, "Redeem", [token0, 19n, 17n], f.instance); }],
    ["zero burned shares", f => { f.receipt.logs[0] = event(CT, "Redeem", [actor, 19n, 0n], f.instance); }],
    ["missing output Transfer", f => { f.receipt.logs.pop(); }],
    ["duplicate output Transfer", f => { f.receipt.logs.push(structuredClone(f.receipt.logs[1])); }],
    ["wrong output token", f => { f.receipt.logs[1].address = asset; }],
    ["wrong output recipient", f => {
      f.receipt.logs[1] = event(ERC20, "Transfer", [f.instance, token0, 19n], cuniUnderlying);
    }],
    ["wrong output amount", f => {
      f.receipt.logs[1] = event(ERC20, "Transfer", [f.instance, actor, 18n], cuniUnderlying);
    }],
  ];
  for (const [reason, mutate] of rejected) {
    const f = cuniFixture(); mutate(f);
    assert.throws(() => observeCuni(f), reason);
  }
});

test("cUNI direction grouping keeps only observed share-to-UNI redemption", () => {
  const f = cuniFixture(), originals = observeCuni(f);
  // Compound is not in the consumer's bidirectional-family set.
  const directions = originalDirections(originals, false);
  assert.deepEqual(directions, [{ tokenIn: f.instance, tokenOut: cuniUnderlying, originals }]);
  assert.equal(directions[0]!.originals[0], originals[0]);
  assert(!directions.some(d => d.tokenIn === cuniUnderlying));
});

test("cUNI amount trials retain burned-share history independently of fixture reference inputs", () => {
  for (const shares of [17n, 123456789n]) {
    const originals = observeCuni(cuniFixture(shares, 5n * 10n ** 18n)), original = originals[0]!;
    const historical = { label: "historical-input-at-N", amountIn: shares, original };
    assert.deepEqual(historicalAmountTrials(originals, null), [historical]);
    for (const label of ["production-effective", "spliced-production-input-at-N"]) {
      // Synthetic reference values test trial ownership only, including equal inputs.
      for (const amountIn of [shares, shares + 1n]) {
        const reference = { label, amountIn };
        const trials = historicalAmountTrials(originals, reference);
        assert.deepEqual(trials, [{ ...reference, original: null }, historical]);
        assert.equal(trials[1]!.original, original);
        assert.equal(trials[1]!.original!.amountOut, 5n * 10n ** 18n);
      }
    }
  }
});

test("cUNI missing production reference stays unmet and cannot borrow another token's donor", () => {
  const f = cuniFixture(), originals = observeCuni(f);
  const edge = { instanceKey: f.instance, tokenIn: f.instance, tokenOut: cuniUnderlying };
  assert.deepEqual(productionAmount(undefined, undefined, edge, source, 7),
    { status: "unmet", reason: "missing-effective-row" });
  assert.deepEqual(productionAmount({ ...edge, status: "missing-valuation", amountIn: 17n }, { mid: 1 }, edge, source, 7),
    { status: "unmet", reason: "missing-valuation" });
  const donor = donorFixture();
  assert.throws(() => splicedProductionAmount(donor.saved, donor.declaration, [donor.edgeId], f.instance),
    /select exactly one reference row per target input token/);
  const trials = historicalAmountTrials(originals, null);
  assert.equal(trials.length, 1); assert.equal(trials[0]!.label, "historical-input-at-N");
  assert.equal(trials[0]!.original, originals[0]);
});

test("cUNI second historical amount is diagnostic, never a production reference or original TX comparison", () => {
  const f = cuniFixture(), originals = observeCuni(f);
  const edge = { instanceKey: f.instance, tokenIn: f.instance, tokenOut: cuniUnderlying };
  const row = { ...edge, status: "missing-valuation", amountIn: null };
  const gate = productionAmount(row, { mid: 1 }, edge, source, 7);
  const trials = historicalAmountTrials(originals, null, true);
  assert.deepEqual(trials, [
    { label: "historical-input-at-N", amountIn: f.burnedShares, original: originals[0] },
    { label: "twice-historical-input-at-N-not-production-reference", amountIn: 2n * f.burnedShares, original: null },
  ]);
  assert.deepEqual(gate, { status: "unmet", reason: "missing-valuation" });
  assert.deepEqual(productionAmount(row, { mid: 1 }, edge, source, 7), gate);
  assert.equal(row.amountIn, null);
  const reference = { label: "production-effective", amountIn: f.burnedShares + 1n };
  assert.deepEqual(historicalAmountTrials(originals, reference, true), [
    { ...reference, original: null }, trials[0],
  ]);
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

for (const native of [true, false]) test(`standard vault original ${native ? "depositNative" : "withdraw"} is mapped, not same-interface parity`, () => {
  const instance = SAMPLES["erc4626-fluid"].instances[native ? 0 : 1];
  const wrapped = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const descriptor = { vault: instance, share: instance, asset: native ? wrapped : asset };
  const abi = new ethers.Interface(["function depositNative(address) payable returns(uint256)",
    "function withdraw(uint256,address,address) returns(uint256)"]);
  const method = native ? "depositNative" : "withdraw";
  const log = event(VAULT, native ? "Deposit" : "Withdraw",
    native ? [actor, actor, 17n, 19n] : [actor, actor, actor, 19n, 17n], instance);
  const receipt = { logs: [log, event(ERC20, "Transfer",
    [native ? ethers.ZeroAddress : token0, actor, 19n], native ? instance : asset)] };
  const trace = { type: "CALL", from: actor, to: instance,
    input: abi.encodeFunctionData(method, native ? [actor] : [19n, actor, actor]),
    output: abi.encodeFunctionResult(method, [native ? 19n : 17n]), value: native ? "0x11" : "0x0",
    logs: [log], calls: [{ logs: [receipt.logs[1]!] }] };
  const leg = originalLeg("erc4626-fluid", instance, descriptor, receipt, trace);
  assert.equal(leg.amountIn, 17n); assert.equal(leg.amountOut, 19n);
  assert.equal(leg.tokenIn, native ? wrapped : instance);
  assert.equal(leg.originalInterface, method); assert.match(leg.comparison, /NOT original interface/);
  assert.throws(() => originalLeg("erc4626-fluid", instance, descriptor, receipt,
    { ...trace, value: native ? "0x12" : "0x1" }));
  assert.throws(() => originalLeg("erc4626-fluid", instance, descriptor, receipt,
    { ...trace, output: abi.encodeFunctionResult(method, [native ? 18n : 16n]) }));
  assert.throws(() => originalLeg("erc4626-fluid", instance, descriptor, receipt,
    { calls: [{ error: "revert", calls: [trace] }] }));
  if (native) assert.throws(() => originalLeg("erc4626-fluid", instance, { ...descriptor, asset }, receipt, trace));
  else assert.throws(() => originalLeg("erc4626-fluid", instance, descriptor, receipt,
    { ...trace, input: abi.encodeFunctionData(method, [20n, actor, actor]) }));
});

// Synthetic OFFLINE evidence shaped after the adjudicated Kyber3 receipt/trace.
// These are observer regressions, not EVM execution or N-end quote/output parity.
// No trace-local logs are supplied: indistinguishable tuples cannot be order-paired.
const kyber3Trader = "0xe08d97e151473a848c3d9ca3f323cb720472d015";
const kyber3Origin = "0xc0ffeebabe5d496b2dde509f9fa189c25cf29671";
const kyber3Usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const kyber3Usdt = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const kyber3OtherPool = "0x2bdc500badd7207c0e6b74eac8671360fc117183";
const kyber3BlockHash = "0xf4caf43faa7a0c6fe62b6e72b9c4a7e606f15574f5227617dfff6836b7678c3c";
const kyber3ProxyImplementation = "0x43506849d7c04f9138d1a2050bbf3a0c054402dd";
const KYBER3_CALLBACK = new ethers.Interface(["function swapCallback(int256,int256,bytes)"]);
const KYBER3_BALANCE = new ethers.Interface(["function balanceOf(address) view returns(uint256)"]);
type Kyber3Visit = { amountIn: bigint; amountOut: bigint; zeroIn: boolean };
const kyber3Visits: Kyber3Visit[] = [
  { amountIn: 1461765n, amountOut: 1462206n, zeroIn: true },
  { amountIn: 38n, amountOut: 38n, zeroIn: true },
];

function kyber3Frame(from: string, to: string, input: string, output?: string, calls: any[] = []): any {
  return { type: "CALL", from, to, input, ...(output === undefined ? {} : { output }), value: "0x0", calls };
}

function kyber3Fixture(specs: Kyber3Visit[] = kyber3Visits) {
  const sample = SAMPLES.kyber3, instance = sample.instances[0];
  const descriptor = { token0: kyber3Usdc, token1: kyber3Usdt };
  const metadata = { transactionHash: sample.tx, transactionIndex: "0x2", blockHash: kyber3BlockHash,
    blockNumber: ethers.toQuantity(sample.number), blockTimestamp: "0x6aad764f", removed: false };
  const log = (abi: ethers.Interface, name: string, args: unknown[], address: string, index: number): any =>
    ({ ...event(abi, name, args, address), ...metadata, logIndex: ethers.toQuantity(index) });
  const balance = (from: string, token: string, owner: string) => ({
    ...kyber3Frame(from, token, KYBER3_BALANCE.encodeFunctionData("balanceOf", [owner]), word(10000000n)),
    type: "STATICCALL",
  });
  const payment = (from: string, token: string, to: string, amount: bigint) =>
    kyber3Frame(from, token, TRANSFER.encodeFunctionData("transfer", [to, amount]), token === kyber3Usdt ? undefined : word(1n));
  const receipt: any = { ...metadata, from: kyber3Origin, to: kyber3Trader, status: "0x1", type: "0x2",
    contractAddress: null, cumulativeGasUsed: "0x66ce52", gasUsed: "0x14d1b5", effectiveGasPrice: "0x16f80018", logs: [] };
  const trace = kyber3Frame(kyber3Origin, kyber3Trader, "0x1d23a9c4", undefined,
    Array.from({ length: 3 }, () => balance(kyber3Trader, kyber3Usdc, kyber3Trader)));
  const visits = specs.map((spec, i) => {
    const tokenIn = spec.zeroIn ? descriptor.token0 : descriptor.token1;
    const tokenOut = spec.zeroIn ? descriptor.token1 : descriptor.token0;
    const amount0 = spec.zeroIn ? spec.amountIn : -spec.amountOut;
    const amount1 = spec.zeroIn ? -spec.amountOut : spec.amountIn;
    const [outputId, inputId, swapId] = i === 0 ? [0x116, 0x117, 0x118]
      : i === 1 ? [0x11a, 0x120, 0x121] : [0x130 + i * 4, 0x131 + i * 4, 0x132 + i * 4];
    const outputLog = log(ERC20, "Transfer", [instance, kyber3Trader, spec.amountOut], tokenOut, outputId!);
    const inputLog = log(ERC20, "Transfer", [kyber3Trader, instance, spec.amountIn], tokenIn, inputId!);
    const swapLog = log(KYBER, "Swap", [kyber3Trader, kyber3Trader, amount0, amount1, 2n ** 96n, 100n, 0], instance, swapId!);
    const outputCall = payment(instance, tokenOut, kyber3Trader, spec.amountOut);
    const inputCall = payment(kyber3Trader, tokenIn, instance, spec.amountIn);
    if (tokenIn === kyber3Usdc) inputCall.calls.push({
      ...kyber3Frame(tokenIn, kyber3ProxyImplementation, inputCall.input, word(1n)), type: "DELEGATECALL",
    });
    const callback = kyber3Frame(instance, kyber3Trader,
      KYBER3_CALLBACK.encodeFunctionData("swapCallback", [amount0, amount1, "0x"]), undefined, [inputCall]);
    const foreignCall = payment(kyber3Trader, tokenOut, kyber3OtherPool, spec.amountOut);
    const foreignLog = log(ERC20, "Transfer", [kyber3Trader, kyber3OtherPool, spec.amountOut], tokenOut,
      i === 1 ? 0x11c : 0x200 + i);
    if (i === 1) callback.calls = [balance(kyber3Trader, tokenOut, kyber3Trader),
      kyber3Frame(kyber3Trader, kyber3OtherPool, "0x022c0d9f", undefined, [
        balance(kyber3OtherPool, tokenOut, kyber3OtherPool),
        kyber3Frame(kyber3OtherPool, kyber3Trader, "0x806693a3", undefined, [foreignCall]),
      ]), inputCall];
    const children = [outputCall, balance(instance, tokenIn, instance), callback, balance(instance, tokenIn, instance)];
    // Retain the reviewed paths: calls[3].calls[1] and calls[5].calls[0].
    if (i === 0) children.unshift(kyber3Frame(instance, actor, "0xff11275e", word(1n)));
    const call = kyber3Frame(kyber3Trader, instance,
      KYBER.encodeFunctionData("swap", [kyber3Trader, spec.amountIn, spec.zeroIn,
        spec.zeroIn ? 4295128740n : 1461446703485210103287273052203988822378723970341n, "0x"]),
      KYBER.encodeFunctionResult("swap", [amount0, amount1]), children);
    receipt.logs.push(outputLog, ...(i === 1 ? [foreignLog] : []), inputLog, swapLog);
    trace.calls.push(call, balance(kyber3Trader, tokenOut, kyber3Trader));
    return { spec, tokenIn, tokenOut, call, outputCall, inputCall, callback, swapLog, outputLog, inputLog, foreignCall, foreignLog };
  });
  return { instance, descriptor, receipt, trace, visits };
}
type Kyber3Fixture = ReturnType<typeof kyber3Fixture>;
type ObservedKyber3Leg = ReturnType<typeof originalLegs>[number];
const observeKyber3 = (f: Kyber3Fixture) => originalLegs("kyber3", f.instance, f.descriptor, f.receipt, f.trace);
function kyber3LegAt(legs: ObservedKyber3Leg[], index: string) {
  const matches = legs.filter(leg => BigInt(leg.logIndex) === BigInt(index));
  assert.equal(matches.length, 1, "each Swap log retains exactly one observation");
  return matches[0]!;
}
function kyber3Identity(value: unknown): string {
  assert(typeof value === "string" && value.length > 0, "observation/call/log identity is required");
  return value;
}
function assertKyber3Observations(f: Kyber3Fixture, legs = observeKyber3(f)) {
  assert.equal(legs.length, f.visits.length, "no largest/first visit selection or amount aggregation");
  for (const visit of f.visits) {
    const leg = kyber3LegAt(legs, visit.swapLog.logIndex);
    assert.equal(leg.tokenIn, visit.tokenIn); assert.equal(leg.tokenOut, visit.tokenOut);
    assert.equal(leg.amountIn, visit.spec.amountIn); assert.equal(leg.amountOut, visit.spec.amountOut);
    assert.equal(leg.caller, kyber3Trader); assert.equal(leg.recipient, kyber3Trader);
    assert.equal(leg.originalInterface, "swap/exact-input"); assert.equal(typeof leg.comparison, "string");
    assert.equal(BigInt(kyber3Identity(leg.outputLogIndex)), BigInt(visit.outputLog.logIndex));
    assert.notEqual(kyber3Identity(leg.swapCallPath), kyber3Identity(leg.outputCallPath));
  }
  for (const field of ["observationId", "swapCallPath", "outputCallPath", "outputLogIndex"] as const)
    assert.equal(new Set(legs.map(leg => kyber3Identity(leg[field]))).size, legs.length, `${field} must not be reused`);
  return legs;
}
function rewriteKyber3Swap(visit: Kyber3Fixture["visits"][number], amount0: bigint, amount1: bigint,
  sender = kyber3Trader, recipient = kyber3Trader) {
  Object.assign(visit.swapLog, KYBER.encodeEventLog(KYBER.getEvent("Swap")!,
    [sender, recipient, amount0, amount1, 2n ** 96n, 100n, 0]));
}
function rewriteKyber3Transfer(log: any, from: string, to: string, value: bigint) {
  Object.assign(log, ERC20.encodeEventLog(ERC20.getEvent("Transfer")!, [from, to, value]));
}

test("Kyber3 multi-visit: both reviewed amounts retain independent call/event/payment identities", () => {
  const f = kyber3Fixture(), legs = assertKyber3Observations(f);
  assert.deepEqual(legs.map(leg => [leg.amountIn, leg.amountOut]).sort((a, b) => a[0]! < b[0]! ? -1 : 1),
    [[38n, 38n], [1461765n, 1462206n]]);
  assert(!Object.hasOwn(f.visits[0]!.outputCall, "output"));
  assert(!Object.hasOwn(f.visits[1]!.outputCall, "output"));
  assert.equal(kyber3LegAt(legs, "0x121").outputLogIndex, "0x11a", "callback forwarding at 0x11c is not pool output");
  assert.throws(() => originalLeg("kyber3", f.instance, f.descriptor, f.receipt, f.trace), "singleton stays fail-closed");
});

test("Kyber3 multi-visit: receipt permutations preserve bindings and IDs independently of call order", () => {
  const baseline = assertKyber3Observations(kyber3Fixture());
  for (const reverseLogs of [false, true]) for (const rotateLogs of [false, true]) for (const reverseCalls of [false, true]) {
    const f = kyber3Fixture();
    if (reverseLogs) f.receipt.logs.reverse();
    if (rotateLogs) f.receipt.logs.push(...f.receipt.logs.splice(0, 3));
    if (reverseCalls) [f.trace.calls[3], f.trace.calls[5]] = [f.trace.calls[5], f.trace.calls[3]];
    const legs = assertKyber3Observations(f);
    for (const [i, visit] of f.visits.entries()) {
      const leg = kyber3LegAt(legs, visit.swapLog.logIndex);
      const expectedSlot = f.visits[reverseCalls ? 1 - i : i]!.swapLog.logIndex;
      assert.equal(leg.swapCallPath, kyber3LegAt(baseline, expectedSlot).swapCallPath,
        "call path follows the matched frame, not the event's array position");
      if (!reverseCalls) assert.deepEqual(leg, kyber3LegAt(baseline, visit.swapLog.logIndex));
    }
  }
});

test("Kyber3 multi-visit: relocating each payment changes its call identity but not its receipt binding", () => {
  const f = kyber3Fixture(), before = observeKyber3(f);
  for (const visit of f.visits) {
    visit.call.calls = visit.call.calls.filter((c: any) => c !== visit.outputCall);
    visit.call.calls.push(visit.outputCall);
  }
  const after = assertKyber3Observations(f);
  for (const leg of after) {
    const prior = kyber3LegAt(before, leg.logIndex);
    assert.equal(leg.swapCallPath, prior.swapCallPath);
    assert.notEqual(leg.outputCallPath, prior.outputCallPath);
    assert.equal(leg.outputLogIndex, prior.outputLogIndex);
  }
});

test("Kyber3 multi-visit: singleton root/nested calls and opposite observed input retain the old leg fields", () => {
  for (const zeroIn of [true, false]) for (const root of [true, false]) {
    const f = kyber3Fixture([{ amountIn: 17n, amountOut: 19n, zeroIn }]);
    if (root) f.trace = f.visits[0]!.call;
    const [leg] = assertKyber3Observations(f);
    const singleton = originalLeg("kyber3", f.instance, f.descriptor, f.receipt, f.trace);
    for (const field of ["tokenIn", "tokenOut", "amountIn", "amountOut", "caller", "recipient",
      "originalInterface", "comparison", "logIndex"] as const) assert.equal(leg![field], singleton[field]);
  }
  const empty = kyber3Fixture([]);
  assert.throws(() => observeKyber3(empty));
  assert.throws(() => originalLeg("kyber3", empty.instance, empty.descriptor, empty.receipt, empty.trace));
});

type Kyber3Mutation = (f: Kyber3Fixture, visit: Kyber3Fixture["visits"][number]) => void;
const kyber3RejectedEvidence: [string, Kyber3Mutation][] = [
  ["missing Swap event", (f, v) => { f.receipt.logs = f.receipt.logs.filter((l: any) => l !== v.swapLog); }],
  ["duplicate Swap event with independent log identity", (f, v) => { f.receipt.logs.push({ ...v.swapLog, logIndex: "0x400" }); }],
  ["missing successful swap call", (f, v) => { f.trace.calls = f.trace.calls.filter((c: any) => c !== v.call); }],
  ["duplicate successful swap call", (f, v) => { f.trace.calls.push(structuredClone(v.call)); }],
  ["wrong swap pool", (_f, v) => { v.call.to = kyber3OtherPool; }],
  ["wrong Swap emitter", (_f, v) => { v.swapLog.address = kyber3OtherPool; }],
  ["foreign Swap ABI", (f, v) => {
    const encoded = ALGEBRA.encodeEventLog(ALGEBRA.getEvent("Swap")!,
      [kyber3Trader, kyber3Trader, v.spec.amountIn, -v.spec.amountOut, 2n ** 96n, 100n, 0, 37, 5]);
    Object.assign(v.swapLog, encoded); assert.equal(v.swapLog.address, f.instance);
  }],
  ["wrong Swap topic", (_f, v) => { v.swapLog.topics[0] = ethers.id("Unrelated(address,uint256)"); }],
  ["malformed Swap data", (_f, v) => { v.swapLog.data = "0x01"; }],
  ["wrong swap selector", (_f, v) => { v.call.input = TRANSFER.encodeFunctionData("transfer", [kyber3Trader, v.spec.amountIn]); }],
  ["truncated swap calldata", (_f, v) => { v.call.input = KYBER.getFunction("swap")!.selector; }],
  ["wrong swap caller", (_f, v) => { v.call.from = actor; }],
  ["wrong event sender", (_f, v) => { rewriteKyber3Swap(v, v.spec.amountIn, -v.spec.amountOut, actor); }],
  ["wrong calldata recipient", (_f, v) => {
    v.call.input = KYBER.encodeFunctionData("swap", [actor, v.spec.amountIn, true, 4295128740n, "0x"]);
  }],
  ["wrong event recipient", (_f, v) => { rewriteKyber3Swap(v, v.spec.amountIn, -v.spec.amountOut, kyber3Trader, actor); }],
  ["wrong signed return input", (_f, v) => { v.call.output = KYBER.encodeFunctionResult("swap", [v.spec.amountIn + 1n, -v.spec.amountOut]); }],
  ["wrong signed return output", (_f, v) => { v.call.output = KYBER.encodeFunctionResult("swap", [v.spec.amountIn, -v.spec.amountOut - 1n]); }],
  ["opposite signed return direction", (_f, v) => { v.call.output = KYBER.encodeFunctionResult("swap", [-v.spec.amountOut, v.spec.amountIn]); }],
  ["missing swap return", (_f, v) => { delete v.call.output; }],
  ["malformed swap return", (_f, v) => { v.call.output = "0x01"; }],
  ["wrong input direction", (_f, v) => {
    v.call.input = KYBER.encodeFunctionData("swap", [kyber3Trader, v.spec.amountIn, false, 4295128740n, "0x"]);
  }],
  ["exact-output substitution", (_f, v) => {
    v.call.input = KYBER.encodeFunctionData("swap", [kyber3Trader, -v.spec.amountOut, true, 4295128740n, "0x"]);
  }],
  ["only partial specified input settled", (_f, v) => {
    v.call.input = KYBER.encodeFunctionData("swap", [kyber3Trader, v.spec.amountIn + 1n, true, 4295128740n, "0x"]);
  }],
  ["settled input exceeds specified input", (_f, v) => {
    v.call.input = KYBER.encodeFunctionData("swap", [kyber3Trader, v.spec.amountIn - 1n, true, 4295128740n, "0x"]);
  }],
  ["missing pool output call", (_f, v) => { v.call.calls = v.call.calls.filter((c: any) => c !== v.outputCall); }],
  ["duplicate pool output call", (_f, v) => { v.call.calls.push(structuredClone(v.outputCall)); }],
  ["missing pool output receipt", (f, v) => { f.receipt.logs = f.receipt.logs.filter((l: any) => l !== v.outputLog); }],
  ["trace-local payment log cannot replace receipt", (f, v) => {
    v.outputCall.logs = [v.outputLog]; f.receipt.logs = f.receipt.logs.filter((l: any) => l !== v.outputLog);
  }],
  ["duplicate pool output receipt with independent identity", (f, v) => { f.receipt.logs.push({ ...v.outputLog, logIndex: "0x401" }); }],
  ["wrong payment-call token", (_f, v) => { v.outputCall.to = kyber3Usdc; }],
  ["wrong payment-call payer", (_f, v) => { v.outputCall.from = kyber3OtherPool; }],
  ["wrong payment-call recipient", (_f, v) => { v.outputCall.input = TRANSFER.encodeFunctionData("transfer", [actor, v.spec.amountOut]); }],
  ["wrong payment-call value", (_f, v) => { v.outputCall.input = TRANSFER.encodeFunctionData("transfer", [kyber3Trader, v.spec.amountOut + 1n]); }],
  ["malformed payment calldata", (_f, v) => { v.outputCall.input = TRANSFER.getFunction("transfer")!.selector; }],
  ["wrong payment-log token", (_f, v) => { v.outputLog.address = kyber3Usdc; }],
  ["wrong payment-log payer", (_f, v) => { rewriteKyber3Transfer(v.outputLog, kyber3OtherPool, kyber3Trader, v.spec.amountOut); }],
  ["wrong payment-log recipient", (f, v) => { rewriteKyber3Transfer(v.outputLog, f.instance, actor, v.spec.amountOut); }],
  ["wrong payment-log value", (f, v) => { rewriteKyber3Transfer(v.outputLog, f.instance, kyber3Trader, v.spec.amountOut + 1n); }],
  ["wrong payment-log topic", (_f, v) => { v.outputLog.topics[0] = ethers.id("Approval(address,address,uint256)"); }],
  ["malformed payment-log data", (_f, v) => { v.outputLog.data = "0x01"; }],
  ["payment moved to root sibling", (f, v) => {
    v.call.calls = v.call.calls.filter((c: any) => c !== v.outputCall); f.trace.calls.push(v.outputCall);
  }],
  ["payment moved to sibling subtree", (f, v) => {
    v.call.calls = v.call.calls.filter((c: any) => c !== v.outputCall);
    f.trace.calls.push(kyber3Frame(kyber3Trader, actor, "0x", undefined, [v.outputCall]));
  }],
  ["payment moved into another observed leg", (f, v) => {
    v.call.calls = v.call.calls.filter((c: any) => c !== v.outputCall);
    f.visits.find(otherVisit => otherVisit !== v)!.call.calls.push(v.outputCall);
  }],
];
for (const type of ["STATICCALL", "DELEGATECALL"]) {
  kyber3RejectedEvidence.push([`${type} cannot supply a swap CALL`, (_f, v) => { v.call.type = type; }]);
  kyber3RejectedEvidence.push([`${type} cannot supply a payment CALL`, (_f, v) => { v.outputCall.type = type; }]);
}
for (const [name, mutate] of kyber3RejectedEvidence) test(`Kyber3 multi-visit rejects ${name}`, () => {
  // Damage either the large or dust leg: returning a surviving subset is a failure.
  for (const i of [0, 1]) {
    const f = kyber3Fixture(); mutate(f, f.visits[i]!);
    assert.throws(() => observeKyber3(f), `${name}, visit ${i}`);
  }
});

test("Kyber3 multi-visit: signed zero/two-input/two-output events cannot become settled swap observations", () => {
  for (const [amount0, amount1] of [[0n, -19n], [17n, 0n], [17n, 19n], [-17n, -19n], [0n, 0n]]) {
    const f = kyber3Fixture(), v = f.visits[0]!;
    rewriteKyber3Swap(v, amount0!, amount1!);
    v.call.output = KYBER.encodeFunctionResult("swap", [amount0, amount1]);
    assert.throws(() => observeKyber3(f));
  }
  const f = kyber3Fixture(); f.descriptor.token1 = f.descriptor.token0;
  assert.throws(() => observeKyber3(f));
});

test("Kyber3 multi-visit: cardinality alone cannot authorize reusing a call for two events", () => {
  const f = kyber3Fixture(), first = f.visits[0]!, second = f.visits[1]!;
  // Two events and two successful calls remain, but both events match only call 0.
  second.swapLog.data = first.swapLog.data; second.swapLog.topics = [...first.swapLog.topics];
  assert.throws(() => observeKyber3(f));
  const extra = kyber3Fixture(), unmatched = structuredClone(extra.visits[0]!.call);
  unmatched.input = KYBER.encodeFunctionData("swap", [kyber3Trader, 99n, true, 4295128740n, "0x"]);
  unmatched.output = KYBER.encodeFunctionResult("swap", [99n, -100n]);
  extra.trace.calls.push(unmatched);
  assert.throws(() => observeKyber3(extra), "all successful target calls require a matching event");
});

test("Kyber3 multi-visit: identical tuples stay ambiguous under independent event/call permutations", () => {
  for (const reverseLogs of [false, true]) for (const reverseCalls of [false, true]) {
    const f = kyber3Fixture([kyber3Visits[0]!, { ...kyber3Visits[0]! }]);
    if (reverseLogs) f.receipt.logs.reverse();
    if (reverseCalls) [f.trace.calls[3], f.trace.calls[5]] = [f.trace.calls[5], f.trace.calls[3]];
    assert.throws(() => observeKyber3(f), "distinct log indices/paths cannot disambiguate identical tuples by order");
  }
});

test("Kyber3 multi-visit: distinct swaps cannot share or arbitrarily choose indistinguishable output logs", () => {
  for (const removeSecondPaymentLog of [false, true]) {
    const f = kyber3Fixture([{ amountIn: 39n, amountOut: 38n, zeroIn: true }, kyber3Visits[1]!]);
    if (removeSecondPaymentLog) f.receipt.logs = f.receipt.logs.filter((l: any) => l !== f.visits[1]!.outputLog);
    assert.throws(() => observeKyber3(f), removeSecondPaymentLog ? "one payment log cannot satisfy two legs" : "two matching payment logs are ambiguous");
  }
  const f = kyber3Fixture([{ amountIn: 39n, amountOut: 38n, zeroIn: true }, kyber3Visits[1]!]);
  const first = f.visits[0]!, second = f.visits[1]!;
  first.call.calls = first.call.calls.filter((c: any) => c !== first.outputCall);
  f.receipt.logs = f.receipt.logs.filter((l: any) => l !== first.outputLog);
  f.trace.calls = f.trace.calls.filter((c: any) => c !== second.call);
  first.callback.calls.push(second.call);
  assert.throws(() => observeKyber3(f), "a nested leg's payment call/log cannot satisfy both swaps");
});

for (const field of ["error", "revertReason"] as const) {
  test(`Kyber3 multi-visit: ${field} on root, swap, payment or any ancestor invalidates evidence`, () => {
    const root = kyber3Fixture(); root.trace[field] = "execution reverted";
    assert.throws(() => observeKyber3(root));
    for (const i of [0, 1]) for (const location of ["swap", "swap ancestor", "payment", "payment ancestor"]) {
      const f = kyber3Fixture(), v = f.visits[i]!;
      if (location === "swap") v.call[field] = "execution reverted";
      else if (location === "payment") v.outputCall[field] = "execution reverted";
      else if (location === "swap ancestor") f.trace.calls = f.trace.calls.map((c: any) => c === v.call
        ? { ...kyber3Frame(kyber3Trader, actor, "0x", undefined, [c]), [field]: "execution reverted" } : c);
      else v.call.calls = v.call.calls.map((c: any) => c === v.outputCall
        ? { ...kyber3Frame(f.instance, actor, "0x", undefined, [c]), [field]: "execution reverted" } : c);
      assert.throws(() => observeKyber3(f), `${field}: ${location}, visit ${i}`);
    }
  });
  test(`Kyber3 multi-visit: additional ${field} decoys do not create visits or duplicate payments`, () => {
    const f = kyber3Fixture(), baseline = observeKyber3(f);
    for (const v of f.visits) {
      f.trace.calls.push({ ...structuredClone(v.call), [field]: "execution reverted" });
      f.trace.calls.push({ ...kyber3Frame(kyber3Trader, actor, "0x", undefined, [structuredClone(v.call)]), [field]: "execution reverted" });
      v.call.calls.push({ ...structuredClone(v.outputCall), [field]: "execution reverted" });
      v.call.calls.push({ ...kyber3Frame(f.instance, actor, "0x", undefined, [structuredClone(v.outputCall)]), [field]: "execution reverted" });
    }
    assert.deepEqual(assertKyber3Observations(f), baseline);
  });
}

test("Kyber3 multi-visit: STATICCALL/DELEGATECALL and unrelated-pool decoys do not count as swaps/payments", () => {
  const f = kyber3Fixture(), baseline = observeKyber3(f);
  for (const v of f.visits) {
    for (const type of ["STATICCALL", "DELEGATECALL"]) {
      f.trace.calls.push({ ...structuredClone(v.call), type });
      v.call.calls.push({ ...structuredClone(v.outputCall), type });
    }
    const foreign = structuredClone(v.call); foreign.to = kyber3OtherPool;
    f.trace.calls.push(foreign);
    // A proxy implementation frame is not a second ERC20 settlement CALL.
    v.outputCall.calls.push({ ...kyber3Frame(v.tokenOut, kyber3ProxyImplementation, v.outputCall.input, word(1n)), type: "DELEGATECALL" });
  }
  assert.deepEqual(assertKyber3Observations(f), baseline);
});

test("Kyber3 multi-visit: foreign funding and callback forwarding cannot replace true pool output", () => {
  for (const i of [0, 1]) for (const remove of ["neither", "call", "log", "both"]) {
    const f = kyber3Fixture(), v = f.visits[i]!;
    const foreignCall = kyber3Frame(kyber3OtherPool, v.tokenOut,
      TRANSFER.encodeFunctionData("transfer", [kyber3Trader, v.spec.amountOut]));
    const foreignLog = { ...v.outputLog, topics: [...v.outputLog.topics], logIndex: "0x402" };
    rewriteKyber3Transfer(foreignLog, kyber3OtherPool, kyber3Trader, v.spec.amountOut);
    f.trace.calls.push(foreignCall); f.receipt.logs.push(foreignLog);
    if (remove === "call" || remove === "both") v.call.calls = v.call.calls.filter((c: any) => c !== v.outputCall);
    if (remove === "log" || remove === "both") f.receipt.logs = f.receipt.logs.filter((l: any) => l !== v.outputLog);
    if (remove === "neither") assertKyber3Observations(f);
    else assert.throws(() => observeKyber3(f), `${remove}: same-value foreign funding/0x11c forwarding is not output`);
  }
});

test("Kyber3 multi-visit: ERC20 success accepts omitted/empty/ABI true, never false or malformed returns", () => {
  for (const i of [0, 1]) {
    for (const output of [undefined, "0x", word(1n)]) {
      const f = kyber3Fixture(), v = f.visits[i]!; v.outputCall.output = output;
      assertKyber3Observations(f);
      f.receipt.logs = f.receipt.logs.filter((l: any) => l !== v.outputLog);
      assert.throws(() => observeKyber3(f), "even an empty/true return needs its independent receipt");
    }
    for (const output of [word(0n), word(2n), "0x00", "0x01", "0x1", "0xabc", "malformed", "",
      word(1n) + "00", word(1n) + word(0n).slice(2)]) {
      const f = kyber3Fixture(); f.visits[i]!.outputCall.output = output;
      assert.throws(() => observeKyber3(f), `malformed ERC20 return: ${output}`);
    }
  }
});

test("Kyber3 multi-visit: receipt/sample TX and block anchors must agree before observing any leg", () => {
  const mutations: [string, (f: Kyber3Fixture) => void][] = [
    ["wrong receipt transaction", f => { f.receipt.transactionHash = other; }],
    ["wrong receipt block number", f => { f.receipt.blockNumber = ethers.toQuantity(SAMPLES.kyber3.number + 1); }],
    ["wrong receipt block hash", f => { f.receipt.blockHash = other; }],
    ["failed receipt", f => { f.receipt.status = "0x0"; }],
    ["invalid success status", f => { f.receipt.status = "0x2"; }],
    ["self-consistent but wrong sample TX", f => {
      f.receipt.transactionHash = other; for (const log of f.receipt.logs) log.transactionHash = other;
    }],
    ["self-consistent but wrong sample block", f => {
      f.receipt.blockNumber = ethers.toQuantity(SAMPLES.kyber3.number + 1);
      for (const log of f.receipt.logs) log.blockNumber = f.receipt.blockNumber;
    }],
    ["malformed but internally equal block hash", f => {
      f.receipt.blockHash = "0x1234"; for (const log of f.receipt.logs) log.blockHash = f.receipt.blockHash;
    }],
    ["missing logs", f => { delete f.receipt.logs; }],
  ];
  for (const field of ["transactionHash", "blockHash", "blockNumber", "status"])
    mutations.push([`missing receipt ${field}`, f => { delete f.receipt[field]; }]);
  for (const [name, mutate] of mutations) {
    const f = kyber3Fixture(); mutate(f); assert.throws(() => observeKyber3(f), name);
  }
  // This API has no independently authenticated header argument. Canonicality of
  // a consistently rewritten, well-formed block hash remains the caller's gate.
});

test("Kyber3 multi-visit: every receipt log is anchored, including unrelated callback/input logs", () => {
  const length = kyber3Fixture().receipt.logs.length;
  for (let i = 0; i < length; i++) {
    for (const [field, value] of [["transactionHash", other], ["blockHash", other],
      ["blockNumber", ethers.toQuantity(SAMPLES.kyber3.number + 1)], ["removed", true]] as const) {
      const f = kyber3Fixture(); f.receipt.logs[i][field] = value;
      assert.throws(() => observeKyber3(f), `log ${i}: ${field}`);
    }
    for (const field of ["transactionHash", "blockHash", "blockNumber"]) {
      const f = kyber3Fixture(); delete f.receipt.logs[i][field];
      assert.throws(() => observeKyber3(f), `log ${i}: missing ${field}`);
    }
  }
});

test("Kyber3 multi-visit: log identities are global and numeric, not array positions or raw strings", () => {
  for (const alias of ["0x11a", "0x011a", "0x11A", "0X011A"]) {
    const f = kyber3Fixture(); f.visits[1]!.foreignLog.logIndex = alias;
    assert.throws(() => observeKyber3(f), `unrelated callback log reuses output identity ${alias}`);
  }
  for (const selected of ["swapLog", "outputLog", "inputLog", "foreignLog"] as const) {
    const f = kyber3Fixture(), log = f.visits[1]![selected];
    // The duplicate need not share the target emitter, token, topic or value.
    f.receipt.logs.push({ ...log, address: actor, topics: [ethers.id("Noise(uint256)")], data: word(99n) });
    assert.throws(() => observeKyber3(f), `global duplicate ${selected}`);
  }
  for (const logIndex of [undefined, "", "0x", "not-a-number", "-1", "0x-1", "1.5"]) {
    for (const selected of ["swapLog", "outputLog", "foreignLog"] as const) {
      const f = kyber3Fixture(); f.visits[1]![selected].logIndex = logIndex;
      assert.throws(() => observeKyber3(f), `invalid ${selected} identity ${logIndex}`);
    }
  }
  const f = kyber3Fixture(), baseline = observeKyber3(f);
  f.receipt.logs.unshift({ ...f.visits[1]!.foreignLog, logIndex: "0x40f", topics: [...f.visits[1]!.foreignLog.topics] });
  assert.deepEqual(assertKyber3Observations(f), baseline, "unrelated distinct identities must not change bindings");
});

test("Kyber3 multi-visit: grouping keeps both originals and creates exactly one unobserved reverse", () => {
  const originals = assertKyber3Observations(kyber3Fixture());
  for (const ordered of [originals, [...originals].reverse()]) for (const includeReverse of [false, true]) {
    const directions = originalDirections(ordered, includeReverse);
    assert.equal(directions.length, includeReverse ? 2 : 1);
    const forward = directions.find(d => d.tokenIn === kyber3Usdc && d.tokenOut === kyber3Usdt)!;
    assert(forward); assert.equal(forward.originals.length, 2);
    for (const leg of originals) assert(forward.originals.includes(leg), "route retains each original reference");
    const reverse = directions.filter(d => d.tokenIn === kyber3Usdt && d.tokenOut === kyber3Usdc);
    assert.equal(reverse.length, includeReverse ? 1 : 0);
    if (includeReverse) assert.deepEqual(reverse[0]!.originals, []);
  }
  assert.deepEqual(originalDirections([], false), []);
  assert.deepEqual(originalDirections([], true), []);
});

function assertKyber3HistoricalTrials(originals: ObservedKyber3Leg[], trials: ReturnType<typeof historicalAmountTrials>) {
  const historical = trials.filter(t => t.label === "historical-input-at-N");
  assert.equal(historical.length, originals.length, "one independent historical trial per observation");
  for (const original of originals) {
    const ownTrials = historical.filter(t => t.original === original);
    assert.equal(ownTrials.length, 1, "trial owns its original object, not the first/max/last observation");
    const trial = ownTrials[0]!;
    assert.equal(trial.amountIn, original.amountIn);
    assert.equal(trial.original!.observationId, original.observationId);
    assert.equal(trial.original!.amountOut, original.amountOut);
  }
}

test("Kyber3 multi-visit: production/spliced reference runs once, separate from every historical input", () => {
  const originals = assertKyber3Observations(kyber3Fixture());
  for (const ordered of [originals, [...originals].reverse()]) {
    const historicalOnly = historicalAmountTrials(ordered, null);
    assert.equal(historicalOnly.length, 2); assertKyber3HistoricalTrials(originals, historicalOnly);
    for (const label of ["production-effective", "spliced-production-input-at-N"]) {
      for (const amountIn of [1461765n, 38n, 100n]) for (const doubleFallback of [false, true]) {
        const reference = { label, amountIn }, trials = historicalAmountTrials(ordered, reference, doubleFallback);
        assert.equal(trials.length, 3, "reference plus two independent historical trials, even for equal amounts");
        assertKyber3HistoricalTrials(originals, trials);
        assert.deepEqual(trials.filter(t => t.label === label), [{ ...reference, original: null }]);
        assert.equal(trials.filter(t => t.original === null).length, 1, "no doubled reference on an observed direction");
      }
    }
  }
});

test("Kyber3 multi-visit: equal inputs with distinct output evidence retain both histories and ownership", () => {
  const f = kyber3Fixture([{ amountIn: 38n, amountOut: 39n, zeroIn: true }, { amountIn: 38n, amountOut: 40n, zeroIn: true }]);
  const originals = assertKyber3Observations(f), directions = originalDirections(originals, true);
  const forward = directions.find(d => d.tokenIn === kyber3Usdc)!;
  assert.equal(directions.length, 2); assert.equal(forward.originals.length, 2);
  const trials = historicalAmountTrials(forward.originals, { label: "production-effective", amountIn: 38n });
  assert.deepEqual(trials.map(t => t.amountIn), [38n, 38n, 38n]);
  assertKyber3HistoricalTrials(originals, trials);
  assert.deepEqual(trials.filter(t => t.original !== null).map(t => t.original!.amountOut).sort((a, b) => a < b ? -1 : 1), [39n, 40n]);
  assert.notEqual(originals[0]!.observationId, originals[1]!.observationId);
});

test("Kyber3 multi-visit: an observed opposite direction is grouped once and owns its comparison", () => {
  const f = kyber3Fixture([...kyber3Visits, { amountIn: 11n, amountOut: 9n, zeroIn: false }]);
  const originals = assertKyber3Observations(f);
  for (const ordered of [originals, [...originals].reverse()]) for (const includeReverse of [false, true]) {
    const directions = originalDirections(ordered, includeReverse);
    assert.equal(directions.length, 2, "an observed reverse must not also be appended as production-only");
    for (const d of directions) {
      const expected = originals.filter(o => o.tokenIn === d.tokenIn && o.tokenOut === d.tokenOut);
      assert.equal(d.originals.length, expected.length); assert(expected.length > 0);
      for (const original of expected) assert(d.originals.includes(original));
      const trials = historicalAmountTrials(d.originals, { label: "production-effective", amountIn: 100n });
      assert.equal(trials.length, expected.length + 1, "no twice-reference trial for either observed direction");
      assertKyber3HistoricalTrials(expected, trials);
      assert.equal(trials.filter(t => t.original === null).length, 1);
    }
  }
});

test("Kyber3 multi-visit: only an unobserved reverse gets a twice-reference trial, with no original comparison", () => {
  const originals = assertKyber3Observations(kyber3Fixture());
  const reverse = originalDirections(originals, true).find(d => d.tokenIn === kyber3Usdt)!;
  assert.deepEqual(reverse.originals, []);
  for (const label of ["production-effective", "spliced-production-input-at-N"]) for (const doubleFallback of [false, true]) {
    const trials = historicalAmountTrials(reverse.originals, { label, amountIn: 23n }, doubleFallback);
    assert.equal(trials.length, 2);
    assert.deepEqual(trials.filter(t => t.label === label), [{ label, amountIn: 23n, original: null }]);
    const doubled = trials.filter(t => t.label !== label);
    assert.equal(doubled.length, 1); assert.equal(doubled[0]!.amountIn, 46n);
    assert.notEqual(doubled[0]!.label, "historical-input-at-N"); assert.equal(doubled[0]!.original, null);
  }
  assert.deepEqual(historicalAmountTrials(reverse.originals, null), []);
  assert.deepEqual(historicalAmountTrials(reverse.originals, null, true), []);
});

test("Kyber3 multi-visit: opt-in doubled historical fallback is explicitly not an original-input comparison", () => {
  const originals = assertKyber3Observations(kyber3Fixture());
  const trials = historicalAmountTrials(originals, null, true);
  assert.equal(trials.length, 4); assertKyber3HistoricalTrials(originals, trials);
  const doubled = trials.filter(t => t.label !== "historical-input-at-N");
  assert.deepEqual(doubled.map(t => t.amountIn).sort((a, b) => a < b ? -1 : 1), [76n, 2923530n]);
  for (const trial of doubled) {
    assert.equal(trial.label, "twice-historical-input-at-N-not-production-reference");
    assert.equal(trial.original, null, "doubled input cannot inherit an observed original output comparison");
  }
  assert.equal(historicalAmountTrials(originals, null, false).length, 2);
});
