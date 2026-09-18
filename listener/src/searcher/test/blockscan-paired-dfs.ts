import assert from "node:assert/strict";
import { enumeratePairedDfs, enumeratePairedLayered, resolvePairedEnumerationMethod, type DfsQuote, type DirectedPriceSignal } from "../detector/blockscan-paired-dfs.js";

const q = (id: string, tokenIn: string, tokenOut: string, num = 100n, instance = id): DfsQuote =>
  ({ id, tokenIn, tokenOut, instance, num, den: 100n, value: { num, den: 100n } });
const signal = (token: string, buy: string, sell: string, num = 120n): DirectedPriceSignal =>
  ({ token, buy, sell, num, den: 100n });
const key = (path: readonly DfsQuote[]) => path.map(e => e.id).join("|");
function run(quotes: DfsQuote[], signals: DirectedPriceSignal[], funding = ["f"], maxHops = 6, bps = 100) {
  const cycles = new Set<string>();
  const stats = enumeratePairedDfs({ quotes, signals, funding, maxHops, minSpreadBps: bps,
    deadlineAtMs: Date.now() + 10_000, onCycle: path => { cycles.add(key(path)); } });
  assert.equal(stats.deadlineHit, false);
  const layered = new Set<string>();
  const other = enumeratePairedLayered({ quotes, signals, funding, maxHops, minSpreadBps: bps,
    deadlineAtMs: Date.now() + 10_000, onCycle: path => {
      assert(!layered.has(key(path)), "duplicate layered route"); layered.add(key(path));
    } });
  assert(!other.deadlineHit);
  assert.equal(stats.closed, cycles.size);
  assert.equal(other.closed, layered.size);
  assert.deepEqual(layered, cycles);
  return cycles;
}
// Independent unpruned oracle: no reverse-distance, bitset or production matcher.
function oracle(quotes: DfsQuote[], signals: DirectedPriceSignal[], funding: string[], maxHops: number, bps: number) {
  const found = new Set<string>();
  const halfOK = (path: DfsQuote[]): boolean => {
    let n = 1n, d = 1n;
    for (const edge of path) {
      if (!edge.value) return false;
      const nextN = n * edge.value.num, nextD = d * edge.value.den;
      if ((nextN * d - n * nextD) * 10000n < -10n * d * nextD) return false;
      n = nextN; d = nextD;
    }
    return true;
  };
  for (const start of funding) {
    const visit = (token: string, path: DfsQuote[], visited: string[]) => {
      for (const edge of quotes) {
        if (edge.tokenIn !== token || path.some(e => e.instance === edge.instance)) continue;
        const next = [...path, edge];
        if (edge.tokenOut === start) {
          const num = next.reduce((n, e) => n * e.num, 1n), den = next.reduce((n, e) => n * e.den, 1n);
          if (next.length < 2 || num * 10_000n <= den * BigInt(10_000 + bps)) continue;
          for (let split = 1; split < next.length; split++) {
            if (split > 3 || next.length - split > 3) continue;
            if (!halfOK(next.slice(0, split)) || !halfOK(next.slice(split).reverse())) continue;
            for (const s of signals) {
              const buy = next.findIndex(e => e.id === s.buy), sell = next.findIndex(e => e.id === s.sell);
              if (buy >= 0 && sell >= 0 && (buy < split) !== (sell < split) &&
                  s.num * 10_000n > s.den * BigInt(10_000 + bps)) found.add(key(next));
            }
          }
        } else if (next.length < maxHops && !visited.includes(edge.tokenOut)) visit(edge.tokenOut, next, [...visited, edge.tokenOut]);
      }
    };
    visit(start, [], [start]);
  }
  return found;
}
const ring = [q("0", "f", "a"), q("1", "a", "b"), q("2", "b", "join"),
  q("3", "join", "c"), q("4", "c", "d"), q("5", "d", "f", 120n)];
const originalSignal = signal("f", "5", "0");
assert.deepEqual([...run(ring, [originalSignal])], [key(ring)], "join need not equal signal token");
assert.equal(run(ring, [originalSignal], ["f"], 5).size, 0);
assert.equal(run(ring, [originalSignal], []).size, 0);
assert.throws(() => run(ring.map((e, i) => i === 5 ? { ...e, instance: ring[0]!.instance } : e), [originalSignal]), /invalid directed/);
assert.equal(run(ring.map((e, i) => i === 3 ? { ...e, instance: ring[1]!.instance } : e), [originalSignal]).size, 0);
assert.equal(run(ring, [], ["f"]).size, 0);
assert.equal(run(ring, [{ ...originalSignal, num: 101n }]).size, 0, "strict signal threshold");
assert.equal(run(ring.map((e, i) => i === 5 ? { ...e, num: 101n } : e), [originalSignal]).size, 0, "strict cycle threshold");
assert.equal(run(ring, [signal("a", "0", "1")]).size, 0, "same-half pair cannot qualify a 6-hop ring");
assert.equal(run(ring, [originalSignal], ["join"]).size, 1, "buy then sell orientation also qualifies");
const alternative = { ...ring[5]!, id: "alternative", instance: "alternative-pool" };
assert(![...run([...ring, alternative], [originalSignal])].some(k => k.includes("alternative")), "different pool cannot impersonate signal");
const changed = [...ring]; changed[4] = q("4", "c", "a"); changed[5] = q("5", "a", "f", 120n);
assert.deepEqual(run(changed, [originalSignal]), new Set(["0|5"]),
  "reject repeated-token long walk while retaining the genuine simple 2-hop shortcut");
let callbacks = 0;
assert.equal(resolvePairedEnumerationMethod(), "dfs");
assert.equal(resolvePairedEnumerationMethod("dfs"), "dfs");
assert.equal(resolvePairedEnumerationMethod("layered"), "layered");
assert.throws(() => resolvePairedEnumerationMethod("unknown"), /must be/);
const zero = enumeratePairedDfs({ quotes: ring, signals: [originalSignal], funding: ["f"], maxHops: 6,
  minSpreadBps: 100, deadlineAtMs: Date.now() - 1, onCycle: () => callbacks++ });
assert(zero.deadlineHit && callbacks === 0);
assert.throws(() => run(ring, [signal("wrong", "5", "0")]), /invalid directed/);

let seed = 81723;
const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
for (let test = 0; test < 160; test++) {
  const tokens = ["f", "a", "b", "c", "d", "g"], edges: DfsQuote[] = [];
  for (const a of tokens) for (const b of tokens) if (a !== b && random(3) !== 0) {
    edges.push(q(String(edges.length), a, b, BigInt(80 + random(50)), `pool-${random(24)}`));
  }
  const signals: DirectedPriceSignal[] = [];
  for (const token of tokens) {
    const buys = edges.filter(e => e.tokenOut === token), sells = edges.filter(e => e.tokenIn === token);
    for (let i = 0; i < Math.min(3, buys.length, sells.length); i++) {
      const buy = buys[random(buys.length)]!, sell = sells[random(sells.length)]!;
      if (buy.instance !== sell.instance) signals.push(signal(token, buy.id, sell.id, BigInt(99 + random(8))));
    }
  }
  const funding = ["f", "g"], maxHops = 2 + test % 5, bps = test % 3 * 100;
  assert.deepEqual(run(edges, signals, funding, maxHops, bps), oracle(edges, signals, funding, maxHops, bps), `oracle case ${test}`);
  assert.deepEqual(run([...edges].reverse(), signals, funding, maxHops, bps), oracle(edges, signals, funding, maxHops, bps), `shuffled case ${test}`);
}
console.log("paired DFS: PASS (160 oracle graphs, shuffled controls, directed signals, 3+3, thresholds, budgets)");
