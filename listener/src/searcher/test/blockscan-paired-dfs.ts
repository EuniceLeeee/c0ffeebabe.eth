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
  for (const start of funding) {
    const visit = (token: string, path: DfsQuote[], visited: string[]) => {
      for (const edge of quotes) {
        if (!edge.value || edge.tokenIn !== token || path.some(e => e.instance === edge.instance)) continue;
        const next = [...path, edge];
        if (edge.tokenOut === start) {
          const num = next.reduce((n, e) => n * e.num, 1n), den = next.reduce((n, e) => n * e.den, 1n);
          if (next.length < 2 || num * 10_000n <= den * BigInt(10_000 + bps)) continue;
          for (const s of signals) {
            if (s.num * 10_000n <= s.den * BigInt(10_000 + bps)) continue;
            const sell = next.findIndex(e => e.id === s.sell && e.tokenIn === s.token);
            if (sell < 0) continue;
            const anchored = [...next.slice(sell), ...next.slice(0, sell)];
            if (anchored.at(-1)!.id !== s.buy) continue;
            for (let split = 1; split < anchored.length; split++) {
              if (split > Math.ceil(maxHops / 2) || anchored.length - split > Math.ceil(maxHops / 2)) continue;
              found.add(key(next));
            }
          }
        } else if (next.length < maxHops && !visited.includes(edge.tokenOut)) visit(edge.tokenOut, next, [...visited, edge.tokenOut]);
      }
    };
    visit(start, [], [start]);
  }
  return found;
}
const ring = [q("0", "f", "a", 101n), q("1", "a", "b", 101n), q("2", "b", "join", 101n),
  q("3", "join", "c", 101n), q("4", "c", "d", 101n), q("5", "d", "f", 120n)];
const originalSignal = signal("f", "5", "0");
assert.deepEqual([...run(ring, [originalSignal])], [key(ring)], "join need not equal signal token");
assert.equal(run(ring, [originalSignal], ["f"], 5).size, 0);
assert.equal(run(ring, [originalSignal], []).size, 0);
assert.throws(() => run(ring.map((e, i) => i === 5 ? { ...e, instance: ring[0]!.instance } : e), [originalSignal]), /invalid directed/);
assert.equal(run(ring.map((e, i) => i === 3 ? { ...e, instance: ring[1]!.instance } : e), [originalSignal]).size, 0);
assert.equal(run(ring, [], ["f"]).size, 0);
assert.equal(run(ring, [{ ...originalSignal, num: 101n }]).size, 0, "strict signal threshold");
assert.equal(run(ring.map((e, i) => ({ ...e, num: i === 5 ? 101n : 100n })), [originalSignal]).size, 0, "strict cycle threshold");
assert.equal(run(ring, [signal("a", "0", "1")]).size, 1, "signal anchor need not be the funded start");
assert.equal(run(ring, [originalSignal, signal("a", "0", "1"), originalSignal]).size, 1,
  "multiple qualifying anchors and duplicate signals emit each funded route once");
assert.equal(run(ring, [originalSignal], ["join"]).size, 1, "buy then sell orientation also qualifies");
const alternative = { ...ring[5]!, id: "alternative", instance: "alternative-pool" };
assert(![...run([...ring, alternative], [originalSignal])].some(k => k.includes("alternative")), "different pool cannot impersonate signal");
const changed = [...ring]; changed[4] = q("4", "c", "a"); changed[5] = q("5", "a", "f", 120n);
assert.deepEqual(run(changed, [originalSignal]), new Set(["0|5"]),
  "reject repeated-token long walk while retaining the genuine simple 2-hop shortcut");
let callbacks = 0;
// A losing half is allowed when the completed cycle is profitable.
const recovery = [q("0", "f", "a", 120n), q("1", "a", "b", 90n), q("2", "b", "join", 99n),
  q("3", "join", "c", 99n), q("4", "c", "d", 90n), q("5", "d", "f", 120n)];
assert.equal(run(recovery, [originalSignal], ["f"], 6, 0).size, 1);
assert.deepEqual(run(recovery, [originalSignal], ["a"], 6, 0),
  new Set([key([...recovery.slice(1), recovery[0]!])]),
  "funded execution can start on a losing edge; do not re-gate after rotation");
for (const second of [1, 4]) {
  const losingHalf = recovery.map((e, i) => i === second ? q(e.id, e.tokenIn, e.tokenOut, 80n) : e);
  assert.equal(run(losingHalf, [originalSignal], ["f"], 6, 0).size, 1,
    "a sub-1 half must survive when the other half covers its loss");
}
const loss = ring.map(e => q(e.id, e.tokenIn, e.tokenOut, 99n));
assert.equal(run(loss, [originalSignal], ["f"], 6, 0).size, 0, "reject whole-cycle loss");
assert.equal(run(ring.map(e => q(e.id,e.tokenIn,e.tokenOut)), [originalSignal], ["f"], 6, 0).size, 0,
  "reject exact break-even");
const marks = new Map(ring.map((e,i) => [e.tokenIn,10n ** BigInt(i)]));
const changedReferences = ring.map(e => ({...e,value:{
  num:e.num * marks.get(e.tokenOut)!,den:e.den * marks.get(e.tokenIn)!}}));
assert.deepEqual(run(changedReferences,[originalSignal]),run(ring,[originalSignal]),
  "consistent reference changes may alter half profits but not the closed-loop result");
// Binary search excludes a negative and an exactly-zero pair before joins.
const joinQuotes=[q("sell","f","a",200n),...[49n,50n,51n,60n].map(n=>q(String(n),"a","f",n))];
const joinSignals=joinQuotes.slice(1).map(e=>signal("f",e.id,"sell"));
const indexed=enumeratePairedDfs({quotes:joinQuotes,signals:joinSignals,funding:["f"],maxHops:2,
  minSpreadBps:0,deadlineAtMs:Date.now()+10000,onCycle:()=>{}});
assert.equal(indexed.joinSkippedBeforeConflicts,2);
assert.equal(indexed.joins,2);
assert.equal(run(joinQuotes,joinSignals,["f"],2,0).size,2);
const huge=10n**30n;
const exactQuotes=[{...q("s","f","a"),num:huge,den:huge},
  {...q("b","a","f"),num:huge+1n,den:huge}];
assert.equal(run(exactQuotes,[signal("f","b","s")],["f"],2,0).size,1,
  "strict join comparison must retain profit below floating-point precision");
for (const hops of [2, 3, 4, 5, 7, 8, 10]) {
  const cycle = Array.from({length: hops}, (_, i) => q(String(i), String(i), String((i + 1) % hops), 110n));
  const signals = [signal("0", String(hops - 1), "0")];
  assert.equal(run(cycle, signals, ["1"], hops, 0).size, 1, "storage and traversal follow configured hop limit");
  if (hops > 2) assert.equal(run(cycle, signals, ["1"], hops - 1, 0).size, 0, "combined length stays within total limit");
}
for (const maxHops of [0, 1, 2.5, NaN, Infinity]) assert.throws(() => run(ring, [originalSignal], ["f"], maxHops), /maxHops/);
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
console.log("paired DFS: PASS (160 oracle graphs, shuffled controls, signal anchors, funding rotations, configurable hops, sorted profitable joins)");
