import assert from "node:assert/strict";
import { classifyLpAction, nonceCheck } from "../cli/live-loss.js";
import { TOPICS } from "../registry/protocols.js";

const BOT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

const matchedTxs = [
  { from: BOT, to: OTHER },
  { from: BOT.toUpperCase(), to: OTHER },
  { from: BOT, to: null },
  { from: OTHER, to: BOT },
];
const matchedFrom = matchedTxs.filter((tx) => tx.from.toLowerCase() === BOT).length;
assert.equal(matchedFrom, 3);

assert.deepEqual(nonceCheck(3, matchedFrom), { ok: true, missing: 0 });
assert.deepEqual(nonceCheck(5, matchedFrom), { ok: false, missing: 2 });

assert.deepEqual(
  classifyLpAction([
    log(TOPICS.univ3Mint),
    log(TOPICS.univ3Burn),
  ]),
  { lp_action: true, jit_lp: true },
);
assert.deepEqual(classifyLpAction([log(TOPICS.univ3Swap)]), { lp_action: false, jit_lp: false });
assert.deepEqual(classifyLpAction([log(TOPICS.univ3Mint)]), { lp_action: true, jit_lp: false });

console.log("nonce_check ok=pass mismatch=pass");
console.log("lp_action jit=pass swap_only=pass mint_only=pass");
console.log("expected_transition: two hand-every-round Fable checks (nonce completeness, JIT-LP artifact flag) become script-native + gated. verdict: fixed.");
console.log("WATCH METHODS: PASS");

function log(topic0: string): any {
  return { topics: [topic0] };
}
