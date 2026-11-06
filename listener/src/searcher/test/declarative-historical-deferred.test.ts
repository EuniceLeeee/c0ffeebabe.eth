import assert from "node:assert/strict";
import test from "node:test";
import fixture from "./fixtures/adapter-families/univ3-deferred-n26222895.json";
import { checkDeferredReceiptGroup } from "./deferred-receipt-facts.js";

test("fixed and debt-based continuations conserve balances in both historical pool directions", () => {
  checkDeferredReceiptGroup(fixture);
});
test("a missing balance or a reported revert with a committed transfer cannot pass", () => {
  const missing = structuredClone(fixture);
  missing.directions[0].trials[0].receipt.tokenDeltas.pop();
  assert.throws(() => checkDeferredReceiptGroup(missing));
  const forged = structuredClone(fixture);
  forged.directions[0].trials[2].receipt.tokenDeltas = forged.directions[0].trials[0].receipt.tokenDeltas;
  assert.throws(() => checkDeferredReceiptGroup(forged));
});
