import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { ObservedEffects } from "../../../adapter-request-program.js";
import { DODO_V2_EVENT_INTERFACE } from "../../dodo-v2-abi.js";
const token = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** GSP may include pre-existing surplus/fee-ledger offsets in fromAmount.
 * The independent actor debit and ERC20 transfer bind the full supplied A. */
export function assertRecipientEffects(e: ObservedEffects | undefined, pool: string, actor: string, recipient: string,
  input: string, output: string, amount: bigint, received: bigint) {
  assert(amount > 0n && received > 0n); const owners = same(actor, recipient) ? [actor] : [actor, recipient];
  assert.equal(e?.tokenDeltas?.length, owners.length * 2);
  for (const owner of owners) for (const asset of [input, output]) {
    const rows = e!.tokenDeltas!.filter(r => same(r.account, owner) && same(r.token, asset)); assert.equal(rows.length, 1);
    const expected = same(asset, input) && same(owner, actor) ? -amount : same(asset, output) && same(owner, recipient) ? received : 0n;
    assert.equal(rows[0]!.delta, expected, "actual debit/receipt/old inventory mismatch");
  }
  assert.equal(e?.nativeDeltas?.length, 1); assert(same(e!.nativeDeltas![0]!.account, actor)); assert.equal(e!.nativeDeltas![0]!.delta, 0n);
  const logs = e?.logs ?? [];
  const swaps = logs.filter(l => same(l.address, pool) && same(l.topics[0] ?? "", DODO_V2_EVENT_INTERFACE.getEvent("DODOSwap")!.topicHash));
  assert.equal(swaps.length, 1); const s = DODO_V2_EVENT_INTERFACE.parseLog(swaps[0]!)!.args;
  assert(same(s.fromToken, input) && same(s.toToken, output) && same(s.trader, actor) && same(s.receiver, recipient));
  assert(s.fromAmount > 0n); assert.equal(s.toAmount, received);
  for (const [asset, from, to, value] of [[input, actor, pool, amount], [output, pool, recipient, received]] as const) {
    const transfers = logs.filter(l => same(l.address, asset) && same(l.topics[0] ?? "", token.getEvent("Transfer")!.topicHash))
      .map(l => token.parseLog(l)!.args).filter(t => same(t.from, from) && same(t.to, to) && t.value === value);
    assert.equal(transfers.length, 1, "missing/ambiguous independent token Transfer");
  }
}
