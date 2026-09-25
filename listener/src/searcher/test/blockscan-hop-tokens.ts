import assert from "node:assert/strict";
import { test } from "node:test";
import { enumeratePaired } from "../detector/blockscan-paired-enumerator.js";
import type { DfsQuote, DirectedPriceSignal, PairedEnumerationMethod } from "../detector/blockscan-paired-dfs.js";

const q = (id: string, from: string, to: string, value = 110n, amount = value): DfsQuote =>
  ({ id, instance: id, tokenIn: from, tokenOut: to, num: amount, den: 100n, value: { num: value, den: 100n } });
const s = (buy: string, sell: string): DirectedPriceSignal =>
  ({ token: "f", buy, sell, num: 120n, den: 100n });
const methods = ["joint-dfs", "dfs", "layered"] as const;
function run(quotes: DfsQuote[], signals: DirectedPriceSignal[], method: PairedEnumerationMethod,
  hopTokensPerStep: number | undefined, maxHops: number, hopPoolsPerPair: number | "default" = 1) {
  const paths: string[] = [];
  const stats = enumeratePaired({ quotes, signals, funding: ["f"], minSpreadBps: 0,
    maxHops, hopTokensPerStep, hopPoolsPerPair: hopPoolsPerPair === "default" ? undefined : hopPoolsPerPair,
    prefixPruningEnabled: false, allowRepeatedPools: false,
    deadlineAtMs: Date.now() + 10_000, onCycle: path => { paths.push(path.map(q => q.id).join("/")); },
  }, method, "typescript");
  assert.equal(stats.deadlineHit, false);
  return { paths: paths.sort(), stats };
}

test("Token N limits anchor directions after explicit one-pool selection", () => {
  // Token b has vastly more raw units, but a has the higher reference-value ratio.
  const quotes = [q("fa", "f", "a", 140n), q("fa-worse", "f", "a", 120n),
    q("fb", "f", "b", 130n, 10n ** 20n), q("af", "a", "f", 140n), q("bf", "b", "f", 130n)];
  const signals = [s("af", "fa"), s("af", "fa-worse"), s("bf", "fb")];
  for (const method of methods) {
    const one = run(quotes, signals, method, 1, 2);
    assert.deepEqual(one.paths, ["fa/af"]);
    const two = run(quotes, signals, method, 2, 2);
    assert.deepEqual(two.paths, ["fa/af", "fb/bf"]);
    assert.deepEqual(run(quotes, signals, method, undefined, 2).paths, two.paths,
      "default Token N=2 includes both neighbors while the explicit pool cap stays one");
    assert.deepEqual(run(quotes, signals, method, 0, 2).paths, two.paths,
      "zero removes only the Token cap, never restores worse same-pair pools");
    assert.equal(one.stats.hopQuotesSelected, 4);
    assert.equal(one.stats.hopSignalPairsSelected, 1);
  }
});

test("production dispatch honors independent Top N tokens and Top M pools across all enumerators", () => {
  for (const counts of [[4, 4, 4, 4], [3, 1, 1, 4]]) {
    const quotes = ["a", "b", "c", "d"].flatMap((token, n) => [
      ...Array.from({ length: counts[n]! }, (_, p) => q(`f${token}-${p}`, "f", token, BigInt(150 - n * 10 - p))),
      q(`${token}f`, token, "f", BigInt(150 - n * 10)),
    ]);
    const signals = quotes.filter(quote => quote.tokenIn === "f").map(quote => s(`${quote.tokenOut}f`, quote.id));
    for (const method of methods) {
      const selected = run(quotes, signals, method, 3, 2, 3);
      const expected = quotes.filter(quote => quote.tokenIn === "f" && quote.tokenOut !== "d" &&
        Number(quote.id.slice(-1)) < 3).map(quote => `${quote.id}/${quote.tokenOut}f`).sort();
      assert.deepEqual(selected.paths, expected);
      assert.equal(selected.paths.length, counts[1] === 1 ? 5 : 9);
      const two = run(quotes, signals, method, 2, 2, 2);
      const expectedTwo = quotes.filter(quote => quote.tokenIn === "f" && ["a", "b"].includes(quote.tokenOut) &&
        Number(quote.id.slice(-1)) < 2).map(quote => `${quote.id}/${quote.tokenOut}f`).sort();
      assert.deepEqual(two.paths, expectedTwo);
      assert.equal(two.paths.length, counts[1] === 1 ? 3 : 4);
      assert.deepEqual(run(quotes, signals, method, undefined, 2, "default").paths, expectedTwo,
        "default settings are two tokens and two pools; explicit three-by-three remains available");
      assert.equal(run(quotes, signals, method, 1, 2, 3).paths.length, 3);
      assert.equal(run(quotes, signals, method, 3, 2, 1).paths.length, 3);
      if (counts[1] === 4) {
        assert.equal(run(quotes, signals, method, 3, 2, 0).paths.length, 12);
        assert.equal(run(quotes, signals, method, 0, 2, 3).paths.length, 12);
        assert.equal(run(quotes, signals, method, 0, 2, 0).paths.length, 16);
      }
    }
  }
});

test("Token N limits both intermediate frontiers, not only signal seeds", () => {
  const quotes = [q("fa", "f", "a"), q("zf", "z", "f"),
    q("ab", "a", "b", 140n), q("ac", "a", "c", 120n),
    q("bz", "b", "z", 140n), q("cz", "c", "z", 120n)];
  for (const method of methods) {
    assert.deepEqual(run(quotes, [s("zf", "fa")], method, 1, 4).paths, ["fa/ab/bz/zf"]);
    assert.deepEqual(run(quotes, [s("zf", "fa")], method, 2, 4).paths,
      ["fa/ab/bz/zf", "fa/ac/cz/zf"]);
  }
});

test("directional selections are separate; an edge need not win both lists", () => {
  const base = [q("fa", "f", "a"), q("az", "a", "z"), q("zf", "z", "f")];
  for (const method of methods) for (const decoy of [q("ax", "a", "x", 200n), q("xz", "x", "z", 200n)]) {
    const result = run([...base, decoy], [s("zf", "fa")], method, 1, 3);
    assert.deepEqual(result.paths, ["fa/az/zf"], `${method}: one frontier can still traverse az`);
  }
});

test("invalid Token limits fail before traversal", () => {
  for (const method of methods) for (const n of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => run([], [], method, n, 2), /nonnegative safe integer/);
});

test("invalid pool limits fail before traversal", () => {
  for (const method of methods) for (const n of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => run([], [], method, 3, 2, n), /nonnegative safe integer/);
});
