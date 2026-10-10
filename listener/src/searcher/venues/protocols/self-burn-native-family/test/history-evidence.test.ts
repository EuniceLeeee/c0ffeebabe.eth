import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { originalSelfBurnLeg, assertOriginalReceipt, SAMPLE } from "./history-evidence.js";
import { selfBurnNativeDiscovery } from "../discovery.js";
const actor = "0x1000000000000000000000000000000000000002", token = SAMPLE.token;
const descriptor = { token, nativeAnchor: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" };
const abi = new ethers.Interface(["function transfer(address,uint256) returns(bool)",
  "event Unwrap(address indexed from,uint256 amount)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);
function fixture() {
  const amount = SAMPLE.originalAmount;
  const log = (event: string, args: any[], i: number) => ({ address: token,
    ...abi.encodeEventLog(abi.getEvent(event)!, args), logIndex: ethers.toQuantity(i),
    blockHash: SAMPLE.hash, blockNumber: ethers.toQuantity(SAMPLE.block), transactionHash: SAMPLE.tx, removed: false });
  const receipt = { status: "0x1", transactionHash: SAMPLE.tx, blockHash: SAMPLE.hash, blockNumber: ethers.toQuantity(SAMPLE.block),
    logs: [log("Transfer", [actor, token, amount], 1), log("Transfer", [token, ethers.ZeroAddress, amount], 2),
      log("Unwrap", [actor, amount], 3)] };
  const payment = { type: "CALL", from: token, to: actor, input: "0x", value: "0x1234" };
  const burn = { type: "CALL", from: actor, to: token, input: abi.encodeFunctionData("transfer", [token, amount]),
    output: abi.encodeFunctionResult("transfer", [true]), calls: [{ type: "DELEGATECALL", calls: [payment] }] };
  return { receipt, trace: { type: "CALL", calls: [burn] } };
}
test("declared SelfBurn event signature hashes to the actual deployed topic", () => {
  const pattern = selfBurnNativeDiscovery.logPatterns[0];
  assert.equal(ethers.id(pattern.signature), pattern.topic);
  assert.equal(pattern.topic, "0x5dd085b6070b4cae004f84daafd199fd55b0bdfa11c3a802baffe89c2419d8c2");
  assert.equal(abi.getEvent("Unwrap")!.topicHash, pattern.topic);
});
test("SelfBurn observes nested native payment and original debit/burn; no 1:1 assumption", () => {
  const f = fixture(); assertOriginalReceipt(f.receipt);
  const r = originalSelfBurnLeg(token, descriptor, f.receipt, f.trace);
  assert.equal(r.amountOut, 0x1234n); assert.equal(r.amountIn, SAMPLE.originalAmount);
  assert.equal(r.originalOutputAsset, "native-ETH"); assert.match(r.comparison, /NOT original pre-call/);
});
for (const [name, mutate] of [
  ["failed outer ancestor", f => { f.trace.error = "revert"; }],
  ["failed delegate ancestor", f => { f.trace.calls[0].calls[0].error = "revert"; }],
  ["failed payment", f => { f.trace.calls[0].calls[0].calls[0].error = "revert"; }],
  ["wrong recipient", f => { f.trace.calls[0].calls[0].calls[0].to = token; }],
  ["false transfer return", f => { f.trace.calls[0].output = abi.encodeFunctionResult("transfer", [false]); }],
  ["wrong input recipient", f => { f.trace.calls[0].input = abi.encodeFunctionData("transfer", [actor, SAMPLE.originalAmount]); }],
  ["missing supply-burn event", f => { f.receipt.logs.splice(1, 1); }],
  ["duplicate burn call", f => { f.trace.calls.push(f.trace.calls[0]); }],
  ["duplicate native payment", f => { f.trace.calls[0].calls[0].calls.push(f.trace.calls[0].calls[0].calls[0]); }],
  ["wrong unwrap amount", f => { f.receipt.logs[2].data = ethers.toBeHex(1, 32); }],
] as [string, (f: any) => void][]) test(`SelfBurn rejects ${name}`, () => {
  const f = fixture(); mutate(f); assert.throws(() => originalSelfBurnLeg(token, descriptor, f.receipt, f.trace));
});
test("SelfBurn sample receipt is bound to N/hash/TX and nonremoved exact burn", () => {
  for (const mutate of [
    (f: any) => { f.receipt.blockHash = ethers.ZeroHash; },
    (f: any) => { f.receipt.logs[0].removed = true; },
    (f: any) => { f.receipt.logs[2].transactionHash = ethers.ZeroHash; },
    (f: any) => { f.receipt.logs[2].data = ethers.toBeHex(1, 32); },
  ]) { const f = fixture(); mutate(f); assert.throws(() => assertOriginalReceipt(f.receipt)); }
});
