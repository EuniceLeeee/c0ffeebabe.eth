import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { xwinTokenValue } from "../xwin-math.js";
import { XWIN_IMPLEMENTATION_HASH } from "../xwin.js";

// Stored eth_call state, not a conversion/swap execution or production replay.
// tool-reconciled: listener:searcher:at-block n/a this tests inner valuation
// arithmetic against saved contract getters; no alternate enumeration pipeline.
test("xWin local holdings valuation matches source-pinned fund getters exactly", () => {
  const directory = process.env.XWIN_LOCAL_STATE_EVIDENCE;
  assert(directory, "XWIN_LOCAL_STATE_EVIDENCE must name the pinned state and compiler proofs");
  const load = (name: string) => JSON.parse(readFileSync(resolve(directory, name), "utf8"));
  const { state: s, records } = load("xwin-pinned-state.json");
  assert.equal(load("allocations-layout-proof.json").runtimeHash, XWIN_IMPLEMENTATION_HASH);
  assert.equal(s.block, 26029584);
  assert.equal(s.hash, "0xad5cae5e3dfee81a2e01e7bbdfc0595dbc3de4a525bb7c6ad9fa3c9749dbc6cc");
  assert(records.length > 0);
  for (const record of records) {
    assert(!record.response.error);
    if (["eth_call", "eth_getCode"].includes(record.request.method)) assert.deepEqual(record.request.params[1], { blockHash: s.hash, requireCanonical: true });
    if (record.request.method === "eth_getStorageAt") assert.deepEqual(record.request.params[2], { blockHash: s.hash, requireCanonical: true });
  }
  const base = s.tokens.find((t: any) => t.token.toLowerCase() === s.baseToken.toLowerCase());
  const baseUnit = 10n ** BigInt(base.decimals);
  let vaultValue = 0n;
  for (const token of s.tokens) {
    assert.equal(token.nestedStrategy, false);
    const price = token === base ? baseUnit : BigInt(token.price);
    vaultValue += xwinTokenValue(BigInt(token.balance), price, 10n ** BigInt(token.decimals));
  }
  const scale = 10n ** (18n - BigInt(base.decimals));
  assert.equal(vaultValue * scale, BigInt(s.getVaultValues));
  const fundSupply = BigInt(s.totalSupply) + BigInt(s.pendingMFee);
  assert.equal(vaultValue * 10n ** 18n / fundSupply * scale, BigInt(s.getUnitPrice));
  assert(BigInt(s.baseTokenAmt) <= BigInt(base.balance));
  console.log(JSON.stringify({ kind: "cached-pinned-xwin-valuation-parity", block: s.block,
    vaultValue18: String(vaultValue * scale), unitPrice18: s.getUnitPrice, delta: "0",
    depositWithdrawParity: "not-run", productionLocalQuote: "not-wired", newRpc: 0 }));
});
