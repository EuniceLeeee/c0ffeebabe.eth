// Test-only receipt/trace observations; no admission, pricing or execution math.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { SELF_BURN_NATIVE_TOKEN_INTERFACE as TOKEN } from "../shared.js";

export const SAMPLE = {
  tx: "0xb51c9e139384978731d58c526d337bf78ac223647c5c0b570a574855bda723a7",
  block: 25619948,
  hash: "0x8a2813204e354d1024b359d61ad4cbcb6af2e1f3d6c7aa3034faeb5abc58eb31",
  token: "0x292a477e521230fe230c13c93374adde8ddec1c1",
  originalAmount: 12306616935116519n,
} as const;
const EVENTS = new ethers.Interface([
  "event Unwrap(address indexed from,uint256 amount)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function assertOriginalReceipt(receipt: any): void {
  assert(receipt && same(receipt.transactionHash, SAMPLE.tx) && BigInt(receipt.status) === 1n);
  assert.equal(Number(BigInt(receipt.blockNumber)), SAMPLE.block); assert(same(receipt.blockHash, SAMPLE.hash));
  for (const log of receipt.logs) {
    assert.equal(log.removed, false); assert(same(log.transactionHash, SAMPLE.tx) && same(log.blockHash, SAMPLE.hash));
    assert.equal(Number(BigInt(log.blockNumber)), SAMPLE.block);
  }
  const burns = receipt.logs.filter((l: any) => same(l.address, SAMPLE.token) &&
    l.topics?.[0] === EVENTS.getEvent("Unwrap")!.topicHash);
  assert.equal(burns.length, 1); assert.equal(burns[0].topics.length, 2);
  assert.equal(EVENTS.parseLog(burns[0])!.args.amount, SAMPLE.originalAmount);
}

export function originalSelfBurnLeg(instance: string, descriptor: { token: string; nativeAnchor: string }, receipt: any, trace: any) {
  assert(same(instance, descriptor.token) && same(descriptor.nativeAnchor, ADDR.WETH));
  assert(!trace.error && !trace.revertReason && BigInt(receipt.status) === 1n);
  const calls: any[] = [];
  const walk = (frame: any, visit: (f: any) => void) => {
    if (!frame || frame.error || frame.revertReason) return;
    visit(frame); for (const child of frame.calls ?? []) walk(child, visit);
  };
  walk(trace, frame => {
    if (frame.type !== "CALL" || !same(frame.to ?? "", instance) ||
      frame.input?.slice(0, 10) !== TOKEN.getFunction("transfer")!.selector) return;
    const data = TOKEN.decodeFunctionData("transfer", frame.input);
    if (same(String(data[0]), instance) && BigInt(data[1]) > 0n) calls.push(frame);
  });
  assert.equal(calls.length, 1, "one successful transfer-to-self required");
  const call = calls[0], amountIn = BigInt(TOKEN.decodeFunctionData("transfer", call.input)[1]);
  assert(ethers.isAddress(call.from) && !same(call.from, instance));
  assert.equal(BigInt(call.value ?? "0x0"), 0n);
  assert.equal(TOKEN.decodeFunctionResult("transfer", call.output)[0], true, "transfer returned false");
  // Proxy DELEGATECALL preserves the token's address for its native CALL.
  // Count payments inside this successful burn only, not whole-TX profit.
  const payments: any[] = [];
  for (const child of call.calls ?? []) walk(child, frame => {
    if (frame.type === "CALL" && same(frame.from ?? "", instance) && same(frame.to ?? "", call.from) &&
      frame.input === "0x" && BigInt(frame.value ?? "0x0") > 0n) payments.push(frame);
  });
  assert.equal(payments.length, 1, "one native payment to the actual burn caller required");
  const amountOut = BigInt(payments[0].value); assert(amountOut > 0n);
  const logs = receipt.logs.filter((l: any) => same(l.address, instance));
  const burns = logs.filter((l: any) => l.topics?.[0] === EVENTS.getEvent("Unwrap")!.topicHash);
  assert.equal(burns.length, 1); assert.equal(burns[0].topics.length, 2);
  const burn = EVENTS.parseLog(burns[0])!.args;
  assert(same(burn.from, call.from)); assert.equal(burn.amount, amountIn);
  const transfers = logs.filter((l: any) => l.topics?.[0] === EVENTS.getEvent("Transfer")!.topicHash)
    .map((l: any) => EVENTS.parseLog(l)!.args);
  for (const [from, to] of [[call.from, instance], [instance, ethers.ZeroAddress]])
    assert.equal(transfers.filter((t: any) => same(t.from, from) && same(t.to, to) && t.value === amountIn).length, 1,
      "original burn lacks its exact debit/burn transfer");
  return { tokenIn: instance.toLowerCase(), tokenOut: descriptor.nativeAnchor.toLowerCase(), amountIn, amountOut,
    caller: call.from.toLowerCase(), recipient: call.from.toLowerCase(), originalInterface: "transfer(self,uint256)",
    comparison: "original native ETH payout mapped to graph WETH; N-end execution is NOT original pre-call replay",
    originalOutputAsset: "native-ETH", logIndex: burns[0].logIndex };
}
