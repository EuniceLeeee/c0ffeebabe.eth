import assert from "node:assert/strict";
import test from "node:test";
import { referenceAmount } from "./reference-amount.js";

const tokenIn = "0x0000000000000000000000000000000000000011";
const row = { edgeId: "donor", tokenIn, tokenOut: "0x0000000000000000000000000000000000000012",
  amountIn: 5141854n, amountOut: 42n, status: "quoted", quotedAt: { number: 100, hash: "0x" + "a".repeat(64) } };
const prices = (entries = [["donor", row]] as [string, any][]) =>
  ({ runtime: { sourceBlock: 200, pricing: { effectiveMids: { rows: new Map(entries) } } } });

test("input-only splice preserves the real (possibly carried) source; no output is substituted", () => {
  const result = referenceAmount(prices(), ["donor"], tokenIn);
  assert.equal(result.kind, "spliced-recorded-input");
  assert.equal(result.amountIn, 5141854n);
  assert.equal(result.donorRow.quotedAt.number, 100);
  assert(!("amountOut" in result));
  assert.equal(row.amountOut, 42n);
});
test("missing, failed, nonpositive, wrong-token and ambiguous rows fail closed", () => {
  assert.throws(() => referenceAmount(prices(), ["missing"], tokenIn));
  for (const patch of [{ status: "missing-valuation" }, { amountIn: 0n }, { amountIn: -1n },
    { amountIn: 1 }, { amountOut: 0n }, { edgeId: "wrong" }, { quotedAt: { number: 100, hash: "0x00" } }])
    assert.throws(() => referenceAmount(prices([["donor", { ...row, ...patch }]]), ["donor"], tokenIn));
  assert.throws(() => referenceAmount(prices(), ["donor"], row.tokenOut));
  assert.throws(() => referenceAmount(prices(), ["donor", "donor"], tokenIn));
  assert.throws(() => referenceAmount(prices([["donor", row], ["second", { ...row, edgeId: "second" }]]),
    ["donor", "second"], tokenIn));
});
