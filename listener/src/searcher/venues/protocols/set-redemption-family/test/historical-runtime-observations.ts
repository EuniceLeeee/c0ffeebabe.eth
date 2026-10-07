// Observation-only helpers. No quote math, admission, Graph or execution model.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ethers } from "ethers";
import { MODULE } from "../codec.js";

export const SAMPLE = Object.freeze({
  tx: "0xfd33fc62a9dc08834cce2d17204ca9c619eaa5a52c855a477a9f3590ea866f9e",
  number: 26130046, hash: "0xebe62a2654fcaff75910a7d71dc65d34cff1c721d372cd8bf51c807c532932a8", index: 100,
  set: "0xdece030c4538ae391aa8660c8e8209aa0e3225a3", module: "0xba1030459e75f6041f938c5470f4e0f6468d5253",
  controller: "0xe0cf093ce6649ef94fe46726745346afc25214d8", amountIn: 66538227599871553n,
  outputs: [1080580816221914020n, 25754286374806283304n, 34599878351933207n, 1129819104645818969n],
});
export const ERC20 = new ethers.Interface(["function balanceOf(address) view returns(uint256)",
  "event Transfer(address indexed from,address indexed to,uint256 value)"]);
export const lower = (s: string) => s.toLowerCase();
export const same = (a: string, b: string) => lower(a) === lower(b);
export const json = (v: unknown) => JSON.stringify(v, (_k, x) => typeof x === "bigint" ? x.toString() : x, 2);
export const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
export const word = (v: string | bigint) => ethers.toBeHex(BigInt(v), 32).toLowerCase();

function storage(diff: any, side: "pre" | "post", token: string): Record<string, string> {
  const a = Object.entries(diff[side]).find(([k]) => same(k, token))?.[1] as any;
  return Object.fromEntries(Object.entries(a?.storage ?? {}).map(([k, v]) => [word(k), word(String(v))]));
}
export function observeBalance(diff: any, token: string, slot: string, initial: bigint) {
  assert(diff?.pre && diff?.post, "independent prestate diff unavailable");
  const pre = storage(diff, "pre", token), post = storage(diff, "post", token), k = word(slot);
  // Unchanged slots are absent on BOTH sides; absent on just one side means zero.
  const before = k in pre ? BigInt(pre[k]) : k in post ? 0n : initial;
  const after = k in post ? BigInt(post[k]) : k in pre ? 0n : initial;
  assert.equal(before, initial, "trace prestate disagrees with independently read balance");
  return { before, after, delta: after - before };
}
export function assertBasket(input: ReturnType<typeof observeBalance>, outputs: ReturnType<typeof observeBalance>[],
  amountIn: bigint, expected: readonly bigint[], inventory: readonly bigint[]) {
  assert.equal(outputs.length, 4, "whole four-component sample required");
  assert.equal(expected.length, outputs.length); assert.equal(inventory.length, outputs.length);
  assert.equal(input.delta, -amountIn, "Set debit differs from requested input");
  assert.equal(input.after, input.before - amountIn, "old Set inventory consumed");
  outputs.forEach((o, n) => {
    assert.equal(o.before, inventory[n]); assert.equal(o.delta, expected[n], "component " + n + " quote/receipt mismatch");
    assert.equal(o.after, inventory[n] + expected[n], "component " + n + " old inventory consumed");
  });
}

// Bound the redemption interval, not whole-transaction net balance or next-leg
// input (the original LCX next leg used one wei of standing inventory).
export function historicalReceipt(receipt: any, components: readonly string[]) {
  assert(receipt, "historical receipt unavailable");
  assert(same(receipt.transactionHash, SAMPLE.tx)); assert(same(receipt.blockHash, SAMPLE.hash));
  assert.equal(Number(BigInt(receipt.blockNumber)), SAMPLE.number);
  assert.equal(Number(BigInt(receipt.transactionIndex)), SAMPLE.index); assert.equal(BigInt(receipt.status), 1n);
  assert.equal(components.length, 4); assert.equal(new Set(components.map(lower)).size, 4);
  const logs = receipt.logs as any[]; assert(Array.isArray(logs));
  for (const l of logs) {
    assert(!l.removed && same(l.blockHash, SAMPLE.hash) && same(l.transactionHash, SAMPLE.tx), "receipt log anchor mismatch");
    assert.equal(Number(BigInt(l.blockNumber)), SAMPLE.number);
    assert.equal(Number(BigInt(l.transactionIndex)), SAMPLE.index);
  }
  const topic = (l: any, t: string) => typeof l.topics?.[0] === "string" && same(l.topics[0], t);
  const redemptions = logs.filter(l => same(l.address, SAMPLE.module) && topic(l, MODULE.getEvent("SetTokenRedeemed")!.topicHash))
    .map(l => ({ log: l, event: MODULE.parseLog(l)! })).filter(x => same(x.event.args.setToken, SAMPLE.set));
  assert.equal(redemptions.length, 1, "one unambiguous sample redemption required");
  const { log, event } = redemptions[0]; assert.equal(event.args.quantity, SAMPLE.amountIn);
  const transfers = logs.filter(l => topic(l, ERC20.getEvent("Transfer")!.topicHash)).map(l => ({ log: l, event: ERC20.parseLog(l)! }));
  const burns = transfers.filter(t => same(t.log.address, SAMPLE.set) && same(t.event.args.from, event.args.redeemer) &&
    same(t.event.args.to, ethers.ZeroAddress) && t.event.args.value === SAMPLE.amountIn && BigInt(t.log.logIndex) < BigInt(log.logIndex));
  assert.equal(burns.length, 1, "one actual Set burn required");
  const outputs = components.map((token, n) => {
    const matches = transfers.filter(t => same(t.log.address, token) && same(t.event.args.from, SAMPLE.set) &&
      same(t.event.args.to, event.args.to) && BigInt(t.log.logIndex) > BigInt(burns[0].log.logIndex) &&
      BigInt(t.log.logIndex) < BigInt(log.logIndex));
    assert.equal(matches.length, 1, "one component receipt in the redemption interval required");
    assert.equal(matches[0].event.args.value, SAMPLE.outputs[n], "historical component " + n + " amount mismatch");
    return { token, amountOut: matches[0].event.args.value as bigint, logIndex: matches[0].log.logIndex };
  });
  return { tx: SAMPLE.tx, blockNumber: SAMPLE.number, blockHash: SAMPLE.hash, transactionIndex: SAMPLE.index,
    status: 1, amountIn: SAMPLE.amountIn, redeemer: lower(event.args.redeemer), recipient: lower(event.args.to),
    burnLogIndex: burns[0].log.logIndex, redemptionLogIndex: log.logIndex, outputs, receiptSha256: sha(json(receipt)),
    originalPreCallReplay: "unverified; N end-state comparisons are a separate claim" };
}
