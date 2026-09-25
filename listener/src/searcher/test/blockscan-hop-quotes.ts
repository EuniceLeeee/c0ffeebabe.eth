import assert from "node:assert/strict";
import { test } from "node:test";
import type { DfsQuote } from "../detector/blockscan-paired-dfs.js";
import { selectTopHopQuotes, selectTopHopTokens } from "../detector/blockscan-hop-quotes.js";

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

const tokenQuote = (id: string, tokenIn: string, tokenOut: string, num = 1n, den = 1n,
  overrides: Partial<DfsQuote> = {}): DfsQuote =>
  ({ id, instance: id, tokenIn, tokenOut, num: 1n, den: 1n, value: { num, den }, ...overrides });
const selectedIds = (selected: Set<string>) => [...selected].sort();

test("N=1/N=2/0 cap forward neighbors independently for every root", () => {
  const quotes = [tokenQuote("ab", "a", "b", 3n), tokenQuote("ac", "a", "c", 5n), tokenQuote("ad", "a", "d", 1n),
    tokenQuote("ef", "e", "f", 2n), tokenQuote("eg", "e", "g", 4n), tokenQuote("eh", "e", "h", 1n)];
  assert.deepEqual(selectedIds(selectTopHopTokens(quotes, 1).forward), ["ac", "eg"]);
  assert.deepEqual(selectedIds(selectTopHopTokens(quotes, 2).forward), ["ab", "ac", "ef", "eg"]);
  for (const limit of [0, Number.MAX_SAFE_INTEGER]) {
    const selected = selectTopHopTokens(quotes, limit);
    assert.deepEqual(selectedIds(selected.forward), quotes.map(quote => quote.id));
    assert.deepEqual(selectedIds(selected.reverse), quotes.map(quote => quote.id));
  }
});

test("reverse ranks higher execution value first for N=1/N=2/0", () => {
  const quotes = [tokenQuote("ar", "a", "r", 4n, 3n), tokenQuote("br", "b", "r", 3n, 2n), tokenQuote("cr", "c", "r")];
  assert.deepEqual(selectedIds(selectTopHopTokens(quotes, 1).reverse), ["br"]);
  assert.deepEqual(selectedIds(selectTopHopTokens(quotes, 2).reverse), ["ar", "br"]);
  assert.deepEqual(selectedIds(selectTopHopTokens(quotes, 0).reverse), ["ar", "br", "cr"]);
  assert.deepEqual(selectedIds(selectTopHopTokens(quotes, 1).forward), ["ar", "br", "cr"]);
});

test("forward and reverse sets are not statically intersected, including seed quotes", () => {
  const quotes = [tokenQuote("ab-seed", "a", "b", 4n), tokenQuote("ac-seed", "a", "c", 3n),
    tokenQuote("db", "d", "b", 5n), tokenQuote("de", "d", "e", 2n)];
  const selected = selectTopHopTokens(quotes, 1);
  assert.deepEqual(selectedIds(selected.forward), ["ab-seed", "db"]);
  assert.deepEqual(selectedIds(selected.reverse), ["ac-seed", "db", "de"]);
});

test("different raw token units and raw exchange rates never rank neighbors", () => {
  for (const reverse of [false, true]) {
    const quotes = [
      tokenQuote("large-raw", reverse ? "a" : "root", reverse ? "root" : "a", 1n, 2n,
        { num: 10n ** 30n, den: 1n }),
      tokenQuote("best-value", reverse ? "b" : "root", reverse ? "root" : "b", 3n, 2n,
        { num: 1n, den: 10n ** 30n }),
    ];
    assert.deepEqual(selectedIds(selectTopHopTokens(quotes, 1)[reverse ? "reverse" : "forward"]), ["best-value"]);
  }
});

test("exact value ratios distinguish enormous BigInts in both directions", () => {
  const huge = 10n ** 400n;
  for (const reverse of [false, true]) {
    const quotes = [tokenQuote("lower", reverse ? "a" : "root", reverse ? "root" : "a", huge + 1n, huge),
      tokenQuote("higher", reverse ? "z" : "root", reverse ? "root" : "z", huge, huge - 1n)];
    assert.deepEqual(selectedIds(selectTopHopTokens(quotes, 1)[reverse ? "reverse" : "forward"]), ["higher"]);
  }
});

test("exact ties use neighbor lexical order, not quote IDs or input order", () => {
  for (const reverse of [false, true]) {
    const quotes = [tokenQuote("first-id", reverse ? "a" : "root", reverse ? "root" : "a", 1n),
      tokenQuote("middle-id", reverse ? "Z" : "root", reverse ? "root" : "Z", 2n, 2n),
      tokenQuote("last-id", reverse ? "A" : "root", reverse ? "root" : "A", 3n, 3n)];
    for (const input of [quotes, [...quotes].reverse()]) {
      const direction = reverse ? "reverse" : "forward";
      assert.deepEqual(selectedIds(selectTopHopTokens(input, 1)[direction]), ["last-id"]);
      assert.deepEqual(selectedIds(selectTopHopTokens(input, 2)[direction]), ["last-id", "middle-id"]);
    }
  }
});

test("best variant ranks the neighbor while all its eligible pools and variants survive", () => {
  for (const reverse of [false, true]) {
    const quotes = [
      tokenQuote("weak-variant", reverse ? "a" : "root", reverse ? "root" : "a", 1n, 1n, { instance: "same-pool" }),
      tokenQuote("other-neighbor", reverse ? "b" : "root", reverse ? "root" : "b", 4n),
      tokenQuote("best-variant", reverse ? "a" : "root", reverse ? "root" : "a", 5n, 1n, { instance: "same-pool" }),
      tokenQuote("other-pool", reverse ? "a" : "root", reverse ? "root" : "a", 2n),
    ];
    for (const input of [quotes, [...quotes].reverse()]) {
      assert.deepEqual(selectedIds(selectTopHopTokens(input, 1)[reverse ? "reverse" : "forward"]),
        ["best-variant", "other-pool", "weak-variant"]);
    }
  }
});

test("zero token cap preserves the independently configured pool cap", () => {
  const quotes = [tokenQuote("ab-best", "a", "b", 3n, 1n, { num: 3n }),
    tokenQuote("ab-lower", "a", "b", 2n, 1n, { num: 2n }),
    tokenQuote("ac-best", "a", "c", 4n, 1n, { num: 4n }),
    tokenQuote("ac-lower", "a", "c", 1n)];
  const bestPools = selectTopHopQuotes(quotes, 1);
  const unlimited = selectTopHopTokens(bestPools, 0);
  assert.deepEqual(selectedIds(unlimited.forward), ["ab-best", "ac-best"]);
  assert.deepEqual(selectedIds(unlimited.reverse), ["ab-best", "ac-best"]);
  assert.deepEqual(selectedIds(selectTopHopTokens(bestPools, 1).forward), ["ac-best"]);
});

test("Top 3 tokens each retain Top 3 pools, yielding nine or fewer edges in either direction", () => {
  for (const reverse of [false, true]) for (const counts of [[4, 4, 4, 4], [3, 1, 1, 4]]) {
    const quotes = ["b", "c", "d", "e"].flatMap((neighbor, n) =>
      Array.from({ length: counts[n]! }, (_, p) => tokenQuote(`${neighbor}-${p}`,
        reverse ? neighbor : "a", reverse ? "a" : neighbor,
        BigInt(100 - n * 10 - p), 1n, { num: BigInt(100 - n * 10 - p) })));
    const before = structuredClone(quotes);
    for (const input of [quotes, [...quotes].reverse()]) {
      const pools = selectTopHopQuotes(input, 3);
      const selected = selectTopHopTokens(pools, 3)[reverse ? "reverse" : "forward"];
      const expected = quotes.filter(quote => quote.id[0] !== "e" && Number(quote.id.slice(2)) < 3);
      assert.deepEqual(selectedIds(selected), expected.map(quote => quote.id).sort());
      assert.equal(selected.size, counts[1] === 1 ? 5 : 9);
      assert.deepEqual([...new Set(expected.map(quote => reverse ? quote.tokenIn : quote.tokenOut))], ["b", "c", "d"]);
      assert.deepEqual(selectedIds(selected).filter(id => id.startsWith("b-")), ["b-0", "b-1", "b-2"],
        "one token's three best pools must all survive without consuming other token slots");
    }
    assert.deepEqual(quotes, before);
  }
});

test("Token and pool caps independently disable, and increasing either does not redistribute the other slots", () => {
  const quotes = ["b", "c", "d", "e"].flatMap((neighbor, n) =>
    Array.from({ length: 4 }, (_, p) => tokenQuote(`${neighbor}-${p}`, "a", neighbor,
      BigInt(100 - n * 10 - p), 1n, { num: BigInt(100 - n * 10 - p) })));
  const select = (tokens: number, pools: number) =>
    selectTopHopTokens(selectTopHopQuotes(quotes, pools), tokens).forward;
  assert.equal(select(3, 3).size, 9);
  assert.equal(select(3, 0).size, 12, "pool zero retains four pools for each of three tokens");
  assert.equal(select(0, 3).size, 12, "token zero retains three pools for each of four tokens");
  assert.equal(select(0, 0).size, 16);
  assert.deepEqual(selectedIds(select(1, 3)), ["b-0", "b-1", "b-2"]);
  assert.deepEqual(selectedIds(select(3, 1)), ["b-0", "c-0", "d-0"]);
  for (const token of ["b", "c", "d"])
    assert.deepEqual(selectedIds(select(3, 3)).filter(id => id.startsWith(token)),
      selectedIds(select(0, 3)).filter(id => id.startsWith(token)));
  assert.deepEqual([...new Set(selectedIds(select(3, 1)).map(id => id[0]))],
    [...new Set(selectedIds(select(3, 3)).map(id => id[0]))]);
});

test("combined caps resolve token and pool ties independently without mutating frozen input", () => {
  const quotes = Object.freeze(["c", "a", "b", "d"].flatMap(neighbor =>
    ["z", "A", "Z", "a"].map(pool => Object.freeze(tokenQuote(`${neighbor}-${pool}`, "root", neighbor,
      2n, 2n, { num: 2n, den: 2n, value: Object.freeze({ num: 2n, den: 2n }) })))));
  const before = structuredClone(quotes);
  const expected = ["a-A", "a-Z", "a-a", "b-A", "b-Z", "b-a", "c-A", "c-Z", "c-a"];
  for (const input of [quotes, [...quotes].reverse()]) {
    const pools = selectTopHopQuotes(input, 3);
    assert.deepEqual(selectedIds(selectTopHopTokens(pools, 3).forward), expected);
    for (const quote of pools) assert.strictEqual(quote, quotes.find(original => original.id === quote.id));
  }
  assert.deepEqual(quotes, before);
});

test("null values never compete, including zero limit and selected neighbor variants", () => {
  const quotes = [tokenQuote("null-only", "a", "b", 100n, 1n, { value: null }),
    tokenQuote("eligible", "a", "c"), tokenQuote("null-variant", "a", "c", 100n, 1n, { value: null })];
  for (const limit of [0, 1, 2]) {
    const selected = selectTopHopTokens(quotes, limit);
    assert.deepEqual(selectedIds(selected.forward), ["eligible"]);
    assert.deepEqual(selectedIds(selected.reverse), ["eligible"]);
    assert.deepEqual(selectTopHopTokens([quotes[0]!], limit), { forward: new Set(), reverse: new Set() });
  }
});

test("does not mutate frozen quotes and returns independent direction sets", () => {
  const quotes = Object.freeze([Object.freeze(tokenQuote("ab", "a", "b", 2n, 1n,
    { value: Object.freeze({ num: 2n, den: 1n }) })), Object.freeze(tokenQuote("ac", "a", "c", 1n, 1n,
    { value: Object.freeze({ num: 1n, den: 1n }) }))]);
  const before = structuredClone(quotes);
  for (const limit of [0, 1, 2]) {
    const selected = selectTopHopTokens(quotes, limit);
    assert.notStrictEqual(selected.forward, selected.reverse);
    selected.forward.clear();
    assert.equal(selected.reverse.size, 2);
    assert.deepEqual(quotes, before);
  }
});

test("empty inputs and invalid limits", () => {
  for (const limit of [0, 1, 2, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(selectTopHopTokens([], limit), { forward: new Set(), reverse: new Set() });
  }
  for (const limit of [-1, -0.5, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => selectTopHopTokens([], limit), /nonnegative safe integer/);
  }
});

test("rejects duplicate IDs before pruning, even across directions and in null quotes", () => {
  const winner = tokenQuote("same-id", "a", "b", 100n);
  for (const limit of [0, 1, 2]) {
    for (const bad of [winner, tokenQuote("same-id", "a", "c"), tokenQuote("same-id", "b", "a", 1n, 1n, { value: null })]) {
      assert.throws(() => selectTopHopTokens([winner, bad], limit), /duplicate directed quote id/);
    }
  }
});

for (const field of ["num", "den"] as const) for (const invalid of [0n, -1n]) {
  test(`rejects ${field}=${invalid} amounts and values before any pruning`, () => {
    const winner = tokenQuote("winner", "a", "b", 100n);
    for (const limit of [0, 1, 2]) {
      for (const value of [null, { num: 1n, den: 100n }]) {
        const bad = tokenQuote("bad", "a", "c", 1n, 100n, { [field]: invalid, value });
        assert.throws(() => selectTopHopTokens([winner, bad], limit), /invalid directed quote amount/);
      }
      const badValue = tokenQuote("bad-value", "a", "c", 1n, 100n, { value: { num: 1n, den: 100n, [field]: invalid } });
      assert.throws(() => selectTopHopTokens([winner, badValue], limit), /invalid quote value/);
    }
  });
}
