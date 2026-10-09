// OFFLINE input/observation regressions. These fixtures are NOT EVM receipts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { KYSWAP_POOL_INTERFACE as KYBER } from "../../../venues/swaps/kyberswap-elastic-family/abi.js";
import { LT_INTERFACE as LT } from "../../../venues/protocols/yieldbasis-lt-family/abi.js";
import { CTOKEN_INTERFACE as CT } from "../../../venues/protocols/compound-ctoken-family/abi.js";
import { options, SAMPLES, ERC20, assertHeader, assertPriceInput, productionAmount, originalLeg,
  assertReceipt, observeBalance, assertDeltas, constructionGuard, word } from "./evidence.js";

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

test("paired fixed-family CLI rejects arbitrary samples, repeats, missing/unsafe ports", () => {
  const args = ["--family", "yb", "--ready", "ready.json", "--prices", "prices.json", "--port", "18593", "--out", "new.json"];
  assert.equal(options(args).family, "yb");
  assert.throws(() => options([...args, "--family", "yb"]));
  assert.throws(() => options(args.slice(0, -1)));
  assert.throws(() => options(args.map(v => v === "yb" ? "arbitrary" : v)));
  for (const p of ["0", "1", "65536", "18593junk", "NaN"]) assert.throws(() => options(args.map(v => v === "18593" ? p : v)));
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
