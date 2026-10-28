import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { ObservedEffects } from "../../../adapter-request-program.js";
import type { Descriptor } from "../types.js";
import { MODULE } from "../codec.js";
const TOKEN = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Read the whole basket on both actors plus its actual vault. The production
 * quote vector supplies expected new receipts, never funded output balances. */
export function assertBasicRecipientEffects(e: ObservedEffects | undefined, d: Descriptor, actor: string, receiver: string,
  selected: string, recipient: string, amount: bigint, outputs: readonly bigint[]) {
  assert(amount > 0n && outputs.length === d.components.length && outputs[d.components.indexOf(selected)] > 0n);
  const owners = [actor, receiver, d.set], tokens = [d.set, ...d.components];
  assert.equal(e?.tokenDeltas?.length, owners.length * tokens.length);
  for (const account of owners) for (const token of tokens) {
    const rows = e!.tokenDeltas!.filter(r => same(r.account, account) && same(r.token, token)); assert.equal(rows.length, 1);
    const index = d.components.findIndex(t => same(t, token));
    const expected = same(token, d.set) ? same(account, actor) ? -amount : 0n : same(account, d.set) ? -outputs[index] :
      same(account, actor) ? same(token, selected) && !same(recipient, actor) ? 0n : outputs[index] : same(token, selected) && same(recipient, receiver) ? outputs[index] : 0n;
    assert.equal(rows[0]!.delta, expected, "whole-basket debit/receipt/side-output ownership mismatch");
  }
  assert.equal(e?.nativeDeltas?.length, 1); assert(same(e!.nativeDeltas![0]!.account, actor)); assert.equal(e!.nativeDeltas![0]!.delta, 0n);
  assert.equal(e?.totalSupplyDeltas?.length, 1); assert(same(e!.totalSupplyDeltas![0]!.token, d.set)); assert.equal(e!.totalSupplyDeltas![0]!.delta, -amount);
  const logs = e?.logs ?? [], events = logs.filter(l => same(l.address, d.module) && same(l.topics[0] ?? "", MODULE.getEvent("SetTokenRedeemed")!.topicHash));
  assert.equal(events.length, 1); const event = MODULE.parseLog(events[0]!)!.args;
  assert(same(event.setToken, d.set) && same(event.redeemer, actor) && same(event.to, actor)); assert.equal(event.quantity, amount);
  const transfers = logs.filter(l => same(l.topics[0] ?? "", TOKEN.getEvent("Transfer")!.topicHash)).map(l => ({ token: l.address, args: TOKEN.parseLog(l)!.args }));
  const requireTransfer = (token: string, from: string, to: string, value: bigint) => {
    const rows = transfers.filter(t => same(t.token, token) && same(t.args.from, from) && same(t.args.to, to));
    assert.equal(rows.length, 1); assert.equal(rows[0]!.args.value, value, "full observed Transfer amount mismatch");
  };
  requireTransfer(d.set, actor, ethers.ZeroAddress, amount);
  d.components.forEach((token, n) => requireTransfer(token, d.set, actor, outputs[n]));
  if (!same(recipient, actor)) requireTransfer(selected, actor, receiver, outputs[d.components.indexOf(selected)]);
  for (const token of d.components.filter(t => same(recipient, actor) || !same(t, selected)))
    assert.equal(transfers.filter(t => same(t.token, token) && same(t.args.from, actor)).length, 0, "unselected output left its original actor");
}
