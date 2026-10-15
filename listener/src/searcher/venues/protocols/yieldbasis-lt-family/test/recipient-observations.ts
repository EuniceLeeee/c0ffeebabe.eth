import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { ObservedEffects } from "../../../adapter-request-program.js";
import { LT_INTERFACE } from "../abi.js";
const token = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const lower = (v: string) => v.toLowerCase();

export function assertRecipientEffects(effects: ObservedEffects | undefined, direction: "deposit" | "withdraw",
  actor: string, recipient: string, asset: string, share: string, stable: string, amountIn: bigint, amountOut: bigint): void {
  assert(amountIn > 0n && amountOut > 0n);
  const accounts = [...new Set([lower(actor), lower(recipient)])], tokens = [asset, share, stable].map(lower);
  const input = lower(direction === "deposit" ? asset : share), output = lower(direction === "deposit" ? share : asset);
  assert.equal(effects?.tokenDeltas?.length, accounts.length * 3);
  for (const t of tokens) for (const a of accounts) {
    const rows = effects!.tokenDeltas!.filter(r => lower(r.token) === t && lower(r.account) === a);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.delta, t === input && a === lower(actor) ? -amountIn : t === output && a === lower(recipient) ? amountOut : 0n);
  }
  assert.equal(effects?.nativeDeltas?.length, 1); assert.equal(lower(effects!.nativeDeltas![0]!.account), lower(actor));
  assert.equal(effects!.nativeDeltas![0]!.delta, 0n);
  const eventName = direction === "deposit" ? "Deposit" : "Withdraw";
  const logs = effects?.logs ?? [], events = logs.filter(l => lower(l.address) === lower(share) &&
    lower(l.topics[0] ?? "") === LT_INTERFACE.getEvent(eventName)!.topicHash.toLowerCase());
  assert.equal(events.length, 1);
  const e = LT_INTERFACE.parseLog(events[0]!)!.args;
  assert.equal(lower(e.sender), lower(actor));
  assert.equal(lower(direction === "deposit" ? e.owner : e.receiver), lower(recipient));
  if (direction === "withdraw") assert.equal(lower(e.owner), lower(actor));
  assert.equal(e.assets, direction === "deposit" ? amountIn : amountOut);
  assert.equal(e.shares, direction === "deposit" ? amountOut : amountIn);
  const transfers = logs.filter(l => l.topics[0]?.toLowerCase() === token.getEvent("Transfer")!.topicHash.toLowerCase());
  const transfer = (t: string, from: string, to: string, amount: bigint) => {
    const rows = transfers.filter(l => lower(l.address) === lower(t)).map(l => token.parseLog(l)!.args)
      .filter(x => lower(x.from) === lower(from) && lower(x.to) === lower(to) && x.value === amount);
    assert.equal(rows.length, 1, "independent input/output Transfer missing or ambiguous");
  };
  if (direction === "deposit") { transfer(asset, actor, share, amountIn); transfer(share, ethers.ZeroAddress, recipient, amountOut); }
  else { transfer(share, actor, ethers.ZeroAddress, amountIn); transfer(asset, share, recipient, amountOut); }
  // LT may rebase the staker during either operation. Total supply change is
  // deliberately not equated to this actor's mint/burn.
}
