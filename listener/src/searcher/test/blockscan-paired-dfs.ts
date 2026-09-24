import assert from "node:assert/strict";
import { enumeratePairedDfs, enumeratePairedLayered, resolvePairedEnumerationMethod, type DfsQuote, type DirectedPriceSignal } from "../detector/blockscan-paired-dfs.js";

const q = (id: string, tokenIn: string, tokenOut: string, num = 100n, instance = id): DfsQuote =>
  ({ id, tokenIn, tokenOut, instance, num, den: 100n, value: { num, den: 100n } });
const signal = (token: string, buy: string, sell: string, num = 120n): DirectedPriceSignal =>
  ({ token, buy, sell, num, den: 100n });
const key = (path: readonly DfsQuote[]) => path.map(e => e.id).join("|");
interface PrefixOptions { prefixPruningEnabled?: boolean; maxPrefixDrawdownBps?: number }
function run(quotes: DfsQuote[], signals: DirectedPriceSignal[], funding = ["f"], maxHops = 6, bps = 100,
  allowRepeatedPools = true, prefix: PrefixOptions = {}) {
  // This suite pins the legacy half-path policy; new defaults are exercised by joint-DFS tests.
  prefix = { prefixPruningEnabled: false, maxPrefixDrawdownBps: 1000, ...prefix };
  const cycles = new Set<string>();
  const stats = enumeratePairedDfs({ quotes, signals, funding, maxHops, minSpreadBps: bps, allowRepeatedPools,
    ...prefix, deadlineAtMs: Date.now() + 10_000, onCycle: path => { cycles.add(key(path)); } });
  assert.equal(stats.deadlineHit, false);
  const layered = new Set<string>();
  const other = enumeratePairedLayered({ quotes, signals, funding, maxHops, minSpreadBps: bps, allowRepeatedPools,
    ...prefix, deadlineAtMs: Date.now() + 10_000, onCycle: path => {
      assert(!layered.has(key(path)), "duplicate layered route"); layered.add(key(path));
    } });
  assert(!other.deadlineHit);
  assert.equal(stats.closed, cycles.size);
  assert.equal(other.closed, layered.size);
  for (const result of [stats, other]) {
    assert.equal(result.prefixPruningEnabled, prefix.prefixPruningEnabled ?? false);
    assert.equal(result.maxPrefixDrawdownBps, prefix.maxPrefixDrawdownBps ?? 1000);
    assert.equal(result.prefixPrunedTotal, result.prefixPrunedForward + result.prefixPrunedJoin);
    if (!prefix.prefixPruningEnabled) assert.equal(result.prefixPrunedTotal, 0);
  }
  assert.deepEqual(layered, cycles);
  return cycles;
}
// Independent complete-cycle oracle: no half-path storage or production matcher.
function oracle(quotes: DfsQuote[], signals: DirectedPriceSignal[], funding: string[], maxHops: number, bps: number,
  allowRepeatedPools: boolean, prefix: PrefixOptions = {}) {
  const found = new Set<string>();
  for (const start of funding) {
    const visit = (token: string, path: DfsQuote[]) => {
      for (const edge of quotes) {
        if (!edge.value || edge.tokenIn !== token || (!allowRepeatedPools && path.some(e => e.instance === edge.instance))) continue;
        const next = [...path, edge];
        if (edge.tokenOut === start) {
          const num = next.reduce((n, e) => n * e.num, 1n), den = next.reduce((n, e) => n * e.den, 1n);
          if (next.length >= 2 && num * 10_000n > den * BigInt(10_000 + bps)) {
            for (const s of signals) {
              if (s.num * 10_000n <= s.den * BigInt(10_000 + bps)) continue;
              for (let sell = 0; sell < next.length; sell++) {
                if (next[sell]!.id !== s.sell || next[sell]!.tokenIn !== s.token) continue;
                const anchored = [...next.slice(sell), ...next.slice(0, sell)];
                if (anchored.at(-1)!.id !== s.buy) continue;
                if (prefix.prefixPruningEnabled) {
                  let prefixNum = 1n, prefixDen = 1n, admissible = true;
                  for (const step of anchored) {
                    prefixNum *= step.value!.num; prefixDen *= step.value!.den;
                    if (prefixNum * 10_000n < prefixDen * BigInt(10_000 - (prefix.maxPrefixDrawdownBps ?? 1000))) {
                      admissible = false; break;
                    }
                  }
                  if (!admissible) continue;
                }
                for (let split = 1; split < anchored.length; split++) {
                  if (split > Math.ceil(maxHops / 2) || anchored.length - split > Math.ceil(maxHops / 2)) continue;
                  found.add(key(next));
                }
              }
            }
          }
        }
        if (next.length < maxHops) visit(edge.tokenOut, next);
      }
    };
    visit(start, []);
  }
  return found;
}
const ring = [q("0", "f", "a", 101n), q("1", "a", "b", 101n), q("2", "b", "join", 101n),
  q("3", "join", "c", 101n), q("4", "c", "d", 101n), q("5", "d", "f", 120n)];
const originalSignal = signal("f", "5", "0");
assert.deepEqual([...run(ring, [originalSignal])], [key(ring)], "join need not equal signal token");
assert.equal(run(ring, [originalSignal], ["f"], 5).size, 0);
assert.equal(run(ring, [originalSignal], []).size, 0);
assert.throws(() => run(ring.map((e, i) => i === 5 ? { ...e, instance: ring[0]!.instance } : e), [originalSignal], ["f"], 6, 100, false), /invalid directed/);
// Signal pair, forward half, reverse half and cross-half collision independently obey the switch.
for (const [first, second] of [[0,5],[0,1],[3,4],[1,3]]) {
  const repeated=ring.map((e,i)=>i===second?{...e,instance:ring[first]!.instance}:e);
  assert.equal(run(repeated,[originalSignal]).size,1);
  if(second!==5) assert.equal(run(repeated,[originalSignal],["f"],6,100,false).size,0);
}
const roundTrip=[q("buy","f","a",100n,"same"),q("sell","a","f",110n,"same")];
assert.equal(run(roundTrip,[signal("a","buy","sell")],["f"],2).size,1);
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
assert.deepEqual(run(changed, [originalSignal]), oracle(changed,[originalSignal],["f"],6,100,true),
  "retain repeated-token walks as well as the simple shortcut");
assert(run(changed,[originalSignal]).has(key(changed)));
assert.deepEqual(run(roundTrip,[signal("a","buy","sell")],["f"],6),
  new Set(["buy|sell","buy|sell|buy|sell","buy|sell|buy|sell|buy|sell"]),
  "even a two-token graph may revisit tokens up to the configured hop bound");
let callbacks = 0;
const revisitSignalQuotes=[q("s","f","a",110n),q("b","a","f",110n),
  q("fd","f","d",110n),q("df","d","f",110n),q("ca","c","a",110n)];
const revisitSignals=[signal("f","b","s"),signal("a","ca","b")];
const revisitCycles=run(revisitSignalQuotes,revisitSignals,["f"],4,0);
assert(revisitCycles.has("s|b"));
assert(!revisitCycles.has("fd|df|s|b"),"a reversed pair cannot match different visits to the signal token");
assert.deepEqual(revisitCycles,oracle(revisitSignalQuotes,revisitSignals,["f"],4,0,true));
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
const prune: PrefixOptions = { prefixPruningEnabled: true };
const middleDip = [q("sell", "f", "a"), q("dip", "a", "b", 80n),
  q("recover", "b", "c", 150n), q("buy", "c", "f")];
const middleSignal = [signal("f", "buy", "sell")];
for (const maxHops of [4, 6]) {
  assert.equal(run(middleDip, middleSignal, ["f"], maxHops, 0).size, 1,
    "disabled keeps a profitable cycle with an 80% middle prefix");
  assert.equal(run(middleDip, middleSignal, ["f"], maxHops, 0, true, prune).size, 0,
    "enabled checks every anchored prefix, including a dip inside the reverse suffix");
  for (const enumerate of [enumeratePairedDfs, enumeratePairedLayered]) {
    const stats = enumerate({ quotes: middleDip, signals: middleSignal, funding: ["f"], maxHops,
      minSpreadBps: 0, ...prune, deadlineAtMs: Date.now() + 10_000, onCycle: () => assert.fail("middle dip") });
    assert(stats.prefixPrunedForward > 0);
    if (maxHops === 6) assert(stats.prefixPrunedJoin > 0, "suffix is tested at join in execution order");
    assert.equal(stats.prefixPrunedTotal, stats.prefixPrunedForward + stats.prefixPrunedJoin);
  }
}
const coveredSuffix = [q("sell", "f", "a", 200n), q("dip", "a", "b", 50n), q("buy", "b", "f", 110n)];
assert.equal(run(coveredSuffix, middleSignal, ["f"], 3, 0, true, prune).size, 1,
  "forward gain covers a losing suffix; the suffix baseline is not reset to one or to a peak");
assert.deepEqual(run(coveredSuffix, middleSignal, ["a"], 3, 0, true, prune),
  new Set([key([...coveredSuffix.slice(1), coveredSuffix[0]!])]),
  "funding rotation does not change the signal-anchor pruning origin");
assert.equal(run(coveredSuffix, [signal("a", "sell", "dip")], ["f"], 3, 0, true, prune).size, 0,
  "changing the actual signal anchor does change the prefix origin");
const anchoredPartners = [q("gain", "f", "a", 200n), q("loss", "a", "f", 55n),
  q("other-buy", "b", "f", 120n), q("other-sell", "f", "c", 120n)];
const anchoredSignals = [signal("f", "other-buy", "gain"), signal("f", "loss", "other-sell"),
  signal("a", "gain", "loss")];
assert.equal(run(anchoredPartners, anchoredSignals, ["f"], 2, 0).size, 1);
assert.equal(run(anchoredPartners, anchoredSignals, ["f"], 2, 0, true, prune).size, 0,
  "a reversed partner of another signal cannot authorize a different pruning anchor");
for (const enabled of [false, true]) {
  assert.equal(run(loss, [originalSignal], ["f"], 6, 0, true, { prefixPruningEnabled: enabled }).size, 0);
  assert.equal(run(ring.map(e => q(e.id, e.tokenIn, e.tokenOut)), [originalSignal], ["f"], 6, 0, true,
    { prefixPruningEnabled: enabled }).size, 0, "prefix admission never replaces whole-cycle profitability");
}
// The bound is inclusive and exact even one integer unit below floating-point
// precision, both on a forward edge and inside the reverse execution suffix.
const boundaryScale = 10n ** 30n;
for (const dipAt of [0, 1]) for (const delta of [-1n, 0n, 1n]) {
  const boundary = [q("sell", "f", "a"), q("middle", "a", "b"), q("buy", "b", "f", 120n)];
  boundary[dipAt] = { ...boundary[dipAt]!, num: 9n * boundaryScale + delta, den: 10n * boundaryScale,
    value: { num: 9n * boundaryScale + delta, den: 10n * boundaryScale } };
  assert.equal(run(boundary, middleSignal, ["f"], 3, 0, true, prune).size, delta < 0n ? 0 : 1,
    `exact 90% prefix, edge ${dipAt}, delta ${delta}`);
}
// Prefixes use reference value, not the raw token exchange ratio. The closed
// cycle still uses raw profitability and reference factors cancel around it.
const markedDip = [q("sell", "f", "a", 100n), q("buy", "a", "f", 120n)].map((edge, i) =>
  ({ ...edge, value: i === 0 ? { num: 80n, den: 100n } : { num: 150n, den: 100n } }));
assert.equal(run(markedDip, middleSignal, ["f"], 2, 0).size, 1);
assert.equal(run(markedDip, middleSignal, ["f"], 2, 0, true, prune).size, 0);
assert.equal(run(markedDip, middleSignal, ["f"], 2, 0, true,
  { prefixPruningEnabled: true, maxPrefixDrawdownBps: 10_000 }).size, 1, "100% permits every positive prefix");
assert.equal(run(coveredSuffix, middleSignal, ["f"], 3, 0, true,
  { prefixPruningEnabled: true, maxPrefixDrawdownBps: 0 }).size, 1, "0% includes exactly the anchor value");
// Binary search excludes a negative and an exactly-zero pair before joins.
const joinQuotes=[q("sell","f","a",200n),...[49n,50n,51n,60n].map(n=>q(String(n),"a","f",n))];
const joinSignals=joinQuotes.slice(1).map(e=>signal("f",e.id,"sell"));
const indexed=enumeratePairedDfs({quotes:joinQuotes,signals:joinSignals,funding:["f"],maxHops:2,
  minSpreadBps:0,deadlineAtMs:Date.now()+10000,onCycle:()=>{}});
assert.equal(indexed.joinSkippedBeforeConflicts,2);
assert.equal(indexed.joins,2);
assert.equal(run(joinQuotes,joinSignals,["f"],2,0).size,2);
// Exact callback order, both funded rotations and duplicate anchors stay
// unchanged even when public quote IDs contain dedup-key delimiters.
const sequenceQuotes = [q('sell,["', "f", "a", 200n),
  ...[49n, 50n, 51n, 60n].map(n => q(`buy,${n}`, "a", "f", n))];
const sequenceSignals = sequenceQuotes.slice(1).map(e => signal("f", e.id, sequenceQuotes[0]!.id));
sequenceSignals.push(sequenceSignals[0]!, signal("a", sequenceQuotes[0]!.id, "buy,51"));
const expectedSequence = [
  ['sell,["', "buy,51"], ["buy,51", 'sell,["'],
  ['sell,["', "buy,60"], ["buy,60", 'sell,["'],
];
for (const enumerate of [enumeratePairedDfs, enumeratePairedLayered]) {
  for (const quotes of [sequenceQuotes, [...sequenceQuotes].reverse()]) {
    for (const allowRepeatedPools of [false, true]) {
      for (const prefix of [{ prefixPruningEnabled: false }, ...[0, 1000, 10_000].map(maxPrefixDrawdownBps =>
        ({ prefixPruningEnabled: false, maxPrefixDrawdownBps }))]) {
        const sequence: string[][] = [];
        const stats = enumerate({ quotes, signals: sequenceSignals, funding: ["f", "a"], maxHops: 2,
          minSpreadBps: 0, allowRepeatedPools, ...prefix, deadlineAtMs: Date.now() + 10_000,
          onCycle: path => { sequence.push(path.map(e => e.id)); } });
        assert(!stats.deadlineHit);
        assert.equal(stats.closed, expectedSequence.length);
        assert.deepEqual(sequence, expectedSequence, "funded rotation order and exact identity");
        assert.equal(stats.prefixPruningEnabled, false);
        assert.equal(stats.prefixPrunedTotal, 0);
      }
    }
  }
}
for (const enumerate of [enumeratePairedDfs, enumeratePairedLayered]) {
  let valueReads = 0;
  const quotes = ring.map(edge => ({ ...edge, value: {
    get num() { valueReads++; return edge.value!.num; },
    get den() { valueReads++; return edge.value!.den; },
  } }));
  enumerate({ quotes, signals: [originalSignal], funding: ["f"], maxHops: 6, minSpreadBps: 0,
    prefixPruningEnabled: false, deadlineAtMs: Date.now() + 10_000, onCycle: () => {} });
  assert.equal(valueReads, quotes.length * 2, "disabled only validates values; no prefix products are computed");
}

// Dense bounded walks revisit tokens; only the independent pool-reuse policy
// rejects collisions. The complete-walk oracle owns admission.
const denseTokens = ["f", "a", "b", "c", "d", "g"], denseQuotes: DfsQuote[] = [];
for (let from = 0; from < denseTokens.length; from++) {
  for (let to = 0; to < denseTokens.length; to++) {
    if (from !== to) denseQuotes.push(q(`dense-${from}-${to}`, denseTokens[from]!, denseTokens[to]!,
      110n, `shared-${(from + to) % 7}`));
  }
}
const denseSignals = denseQuotes.filter(e => e.tokenOut === "f").flatMap(buy =>
  denseQuotes.filter(sell => sell.tokenIn === "f" && sell.instance !== buy.instance)
    .map(sell => signal("f", buy.id, sell.id)));
for (const allowRepeatedPools of [false, true]) {
  const expected = oracle(denseQuotes, denseSignals, ["f"], 6, 0, allowRepeatedPools);
  assert(expected.size > 0);
  for (const enumerate of [enumeratePairedDfs, enumeratePairedLayered]) {
    const actual = new Set<string>();
    const stats = enumerate({ quotes: denseQuotes, signals: denseSignals, funding: ["f"], maxHops: 6,
      minSpreadBps: 0, allowRepeatedPools, deadlineAtMs: Date.now() + 10_000,
      onCycle: path => { assert(!actual.has(key(path))); actual.add(key(path)); } });
    assert(!stats.deadlineHit);
    if (!allowRepeatedPools) assert(stats.signalMatched > stats.closed, "fixture exercises pool collision rejection");
    assert.equal(stats.closed, actual.size);
    assert.deepEqual(actual, expected, `dense cross-half conflicts, reuse ${allowRepeatedPools}`);
  }
}
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
for (const maxPrefixDrawdownBps of [-1, 10_001, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  for (const prefixPruningEnabled of [false, true]) assert.throws(() =>
    run(ring, [originalSignal], ["f"], 6, 0, true, { prefixPruningEnabled, maxPrefixDrawdownBps }), /maxPrefixDrawdownBps/);
}
assert.throws(() => run(ring, [originalSignal], ["f"], 6, 0, true,
  { prefixPruningEnabled: "1" as unknown as boolean }), /prefixPruningEnabled/);
assert.equal(resolvePairedEnumerationMethod(), "joint-dfs");
assert.equal(resolvePairedEnumerationMethod("joint-dfs"), "joint-dfs");
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
  for (const allowRepeatedPools of [false,true]) {
    assert.deepEqual(run(edges, signals, funding, maxHops, bps, allowRepeatedPools), oracle(edges, signals, funding, maxHops, bps, allowRepeatedPools), `oracle case ${test}, reuse ${allowRepeatedPools}`);
    assert.deepEqual(run([...edges].reverse(), signals, funding, maxHops, bps, allowRepeatedPools), oracle(edges, signals, funding, maxHops, bps, allowRepeatedPools), `shuffled case ${test}, reuse ${allowRepeatedPools}`);
    const marks = new Map(tokens.map((token, i) => [token, BigInt(80 + i * 10)]));
    const marked = edges.map(edge => ({ ...edge, value: {
      num: edge.num * marks.get(edge.tokenOut)!, den: edge.den * marks.get(edge.tokenIn)!,
    } }));
    for (const maxPrefixDrawdownBps of [0, 1000, 10_000]) {
      const prefix = { prefixPruningEnabled: true, maxPrefixDrawdownBps };
      const expected = oracle(marked, signals, funding, maxHops, bps, allowRepeatedPools, prefix);
      assert.deepEqual(run(marked, signals, funding, maxHops, bps, allowRepeatedPools, prefix), expected,
        `anchored-prefix oracle case ${test}, bound ${maxPrefixDrawdownBps}, reuse ${allowRepeatedPools}`);
      assert.deepEqual(run([...marked].reverse(), signals, funding, maxHops, bps, allowRepeatedPools, prefix), expected,
        `shuffled anchored-prefix case ${test}, bound ${maxPrefixDrawdownBps}, reuse ${allowRepeatedPools}`);
    }
  }
}
console.log("paired DFS: PASS (160 oracle graphs, shuffled controls, anchored-prefix bounds, exact BigInt boundaries, funding rotations, configurable hops, sorted profitable joins)");
