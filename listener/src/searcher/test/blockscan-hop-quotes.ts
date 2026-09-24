import assert from "node:assert/strict";
import { test } from "node:test";
import type { DfsQuote } from "../detector/blockscan-paired-dfs.js";
import { selectTopHopQuotes } from "../detector/blockscan-hop-quotes.js";

const q = (id: string, num: bigint, den = 1n, overrides: Partial<DfsQuote> = {}): DfsQuote =>
  ({ id, instance: id, tokenIn: "a", tokenOut: "b", num, den, value: { num: 1n, den: 1n }, ...overrides });
const ids = (quotes: readonly DfsQuote[]) => quotes.map(quote => quote.id);

test("1/2/0 modes select top instances and preserve input traversal order", () => {
  const quotes = [q("second", 2n), q("third", 1n), q("first", 3n)];
  assert.deepEqual(ids(selectTopHopQuotes(quotes, 1)), ["first"]);
  assert.deepEqual(ids(selectTopHopQuotes(quotes, 2)), ["second", "first"]);
  assert.strictEqual(selectTopHopQuotes(quotes, 0), quotes);
  assert.deepEqual(ids(selectTopHopQuotes(quotes, Number.MAX_SAFE_INTEGER)), ids(quotes));
});

test("each ordered pair, including reverse directions, has an independent limit", () => {
  const quotes = [
    q("ab-low", 1n), q("ab-best", 3n, 1n, { instance: "shared" }),
    q("ba-best", 4n, 1n, { instance: "shared", tokenIn: "b", tokenOut: "a" }),
    q("ba-low", 2n, 1n, { tokenIn: "b", tokenOut: "a" }),
    q("ac-low", 1n, 1n, { tokenOut: "c" }),
    q("ac-best", 5n, 1n, { instance: "shared", tokenOut: "c" }),
    q("cb-best", 6n, 1n, { instance: "shared", tokenIn: "c" }),
    q("cb-low", 1n, 1n, { tokenIn: "c" }),
  ];
  assert.deepEqual(ids(selectTopHopQuotes(quotes, 1)), ["ab-best", "ba-best", "ac-best", "cb-best"]);
  assert.deepEqual(ids(selectTopHopQuotes(quotes, 2)), ids(quotes));
});

test("ranking uses exact num/den, not absolute output or reference value", () => {
  const quotes = [
    q("large-output", 1000n, 1000n, { value: { num: 999n, den: 1n } }),
    q("best-rate", 5n, 2n, { value: { num: 1n, den: 999n } }),
    q("second-rate", 7n, 3n),
  ];
  assert.deepEqual(ids(selectTopHopQuotes(quotes, 1)), ["best-rate"]);
  assert.deepEqual(ids(selectTopHopQuotes(quotes, 2)), ["best-rate", "second-rate"]);
});

test("enormous BigInts retain sub-unit precision across differing denominators", () => {
  const huge = 10n ** 400n;
  const quotes = [q("a-lower", huge + 1n, huge), q("z-higher", huge, huge - 1n)];
  // The cross-products differ by exactly one, beyond floating-point precision.
  assert.deepEqual(ids(selectTopHopQuotes(quotes, 1)), ["z-higher"]);
});

test("equal-rate ties use ordinary lexical IDs and select the same IDs after reordering", () => {
  const quotes = [q("a", 1n), q("Z", 2n, 2n), q("A", 3n, 3n), q("z", 4n, 4n)];
  for (const input of [quotes, [...quotes].reverse(), [quotes[2]!, quotes[0]!, quotes[3]!, quotes[1]!]]) {
    assert.deepEqual(ids(selectTopHopQuotes(input, 1)), ["A"]);
    const selected = selectTopHopQuotes(input, 2);
    assert.deepEqual(ids(selected).sort(), ["A", "Z"]);
    assert.deepEqual(ids(selected), ids(input.filter(quote => quote.id === "A" || quote.id === "Z")));
  }
});

test("only the best variant of each instance consumes a slot", () => {
  const quotes = [
    q("pool-a-low", 8n, 1n, { instance: "pool-a" }),
    q("pool-b", 7n),
    q("pool-a-best", 9n, 1n, { instance: "pool-a" }),
    q("pool-c", 6n),
  ];
  for (const input of [quotes, [...quotes].reverse()]) {
    assert.deepEqual(ids(selectTopHopQuotes(input, 1)), ["pool-a-best"]);
    assert.deepEqual(ids(selectTopHopQuotes(input, 2)).sort(), ["pool-a-best", "pool-b"]);
    assert.equal(selectTopHopQuotes(input, Number.MAX_SAFE_INTEGER).length, 3);
  }
  assert.strictEqual(selectTopHopQuotes(quotes, 0), quotes);
});

test("equal-rate variants of an instance also use lexical IDs", () => {
  const quotes = [q("z", 2n, 2n, { instance: "shared" }), q("A", 1n, 1n, { instance: "shared" })];
  for (const input of [quotes, [...quotes].reverse()]) {
    assert.deepEqual(ids(selectTopHopQuotes(input, 1)), ["A"]);
    assert.deepEqual(ids(selectTopHopQuotes(input, 2)), ["A"]);
  }
});

test("null-value quotes cannot consume slots or displace eligible variants", () => {
  const quotes = [
    q("unpriced-only", 100n, 1n, { value: null }),
    q("unpriced-variant", 90n, 1n, { instance: "shared", value: null }),
    q("eligible-variant", 2n, 1n, { instance: "shared" }),
    q("other", 1n),
  ];
  assert.deepEqual(ids(selectTopHopQuotes(quotes, 1)), ["eligible-variant"]);
  assert.deepEqual(ids(selectTopHopQuotes(quotes, 2)), ["eligible-variant", "other"]);
  assert.strictEqual(selectTopHopQuotes(quotes, 0), quotes);
  assert.deepEqual(selectTopHopQuotes(quotes.slice(0, 2), 2), []);
});

test("empty input is valid for all limit modes", () => {
  const quotes: readonly DfsQuote[] = Object.freeze([]);
  for (const limit of [0, 1, 2, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(selectTopHopQuotes(quotes, limit), []);
  }
  assert.strictEqual(selectTopHopQuotes(quotes, 0), quotes);
});

test("preserves quote identity without mutating frozen input or nested values", () => {
  const quotes = Object.freeze([
    Object.freeze(q("second", 2n, 1n, { value: Object.freeze({ num: 1n, den: 1n }) })),
    Object.freeze(q("last", 1n, 1n, { value: Object.freeze({ num: 1n, den: 1n }) })),
    Object.freeze(q("first", 3n, 1n, { value: Object.freeze({ num: 1n, den: 1n }) })),
  ]);
  const before = structuredClone(quotes);
  const selected = selectTopHopQuotes(quotes, 2);
  assert.strictEqual(selected[0], quotes[0]);
  assert.strictEqual(selected[1], quotes[2]);
  assert.strictEqual(selectTopHopQuotes(quotes, 1)[0], quotes[2]);
  assert.strictEqual(selectTopHopQuotes(quotes, 0), quotes);
  assert.deepEqual(quotes, before);
});

for (const field of ["num", "den"] as const) {
  for (const invalid of [0n, -1n]) {
    test(`rejects ${field}=${invalid} amounts even in pruned or null-value variants`, () => {
      for (const limit of [0, 1, 2]) {
        for (const value of [null, { num: 1n, den: 1n }]) {
          const bad = q("bad", 1n, 100n, { instance: "shared", [field]: invalid, value });
          const quotes = [q("winner", 100n, 1n, { instance: "shared" }), bad];
          assert.throws(() => selectTopHopQuotes(quotes, limit), /invalid directed quote amount/);
        }
      }
    });
    test(`rejects value.${field}=${invalid} even in a variant that would be pruned`, () => {
      const bad = q("bad", 1n, 100n, { instance: "shared", value: { num: 1n, den: 1n, [field]: invalid } });
      for (const limit of [0, 1, 2]) {
        assert.throws(() => selectTopHopQuotes([q("winner", 100n, 1n, { instance: "shared" }), bad], limit),
          /invalid quote value/);
      }
    });
  }
}

test("rejects duplicate IDs globally, including ineligible or otherwise pruned quotes", () => {
  const original = q("duplicate", 100n);
  const duplicates = [
    original,
    q("duplicate", 1n, 100n),
    q("duplicate", 1n, 1n, { value: null }),
    q("duplicate", 1n, 1n, { tokenIn: "b", tokenOut: "a", instance: "other" }),
  ];
  for (const duplicate of duplicates) {
    for (const limit of [0, 1, 2]) {
      assert.throws(() => selectTopHopQuotes([original, duplicate], limit), /duplicate directed quote id/);
    }
  }
});

test("rejects invalid limits even with empty input", () => {
  for (const limit of [-1, -0.5, 0.5, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => selectTopHopQuotes([], limit), /nonnegative safe integer/);
  }
});
