/** Independent complete-walk + two-dimensional reachability oracle. No RPC. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ADDR } from "../../shared/constants/addresses.js";
import { buildBlockScanUsdView } from "../blockscan-usd-view.js";
import { enumerateJointDfs } from "../detector/blockscan-joint-dfs.js";
import { enumeratePairedDfs, type DfsQuote, type DirectedPriceSignal,
  type PairedEnumerationInput } from "../detector/blockscan-paired-dfs.js";
import type { ResolvedBlockScanMid } from "../detector/blockscan-scanner-core.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";

type Case = Omit<PairedEnumerationInput, "deadlineAtMs" | "onCycle">;
type Row = { ids: string[]; spreadBps: number };
type Engine = (input: PairedEnumerationInput) => { deadlineHit: boolean; closed: number };
const quote = (id: string, tokenIn: string, tokenOut: string, num = 110n, den = 100n,
  value = { num, den }, instance = id): DfsQuote => ({ id, tokenIn, tokenOut, num, den, value, instance });
const signal = (token: string, buy: string, sell: string, num = 120n, den = 100n): DirectedPriceSignal =>
  ({ token, buy, sell, num, den });
const scenario = (quotes: readonly DfsQuote[], signals: readonly DirectedPriceSignal[], extra: Partial<Case> = {}): Case =>
  ({ quotes, signals, funding: ["f"], maxHops: 6, minSpreadBps: 0, hopTokensPerStep: 0,
    allowRepeatedPools: true, prefixPruningEnabled: true, maxPrefixDrawdownBps: 0, ...extra });
const key = (path: readonly DfsQuote[]) => JSON.stringify(path.map(q => q.id));
const sorted = (rows: Iterable<Row>) => [...rows].sort((a, b) => JSON.stringify(a.ids).localeCompare(JSON.stringify(b.ids)));
const profitable = (num: bigint, den: bigint, bps: number) => num * 10_000n > den * BigInt(10_000 + bps);

function spread(path: readonly DfsQuote[]): number {
  let num = 1n, den = 1n;
  for (const q of path) { num *= q.num; den *= q.den; }
  const value = (Number(num) / Number(den) - 1) * 10_000;
  return Number.isFinite(value) ? value : Number(num * 1_000_000_000n / den - 1_000_000_000n) / 100_000;
}

/** This does not grow a graph or call a production enumerator. Given one
 * already complete sell...buy ring, DP[a][b] records whether its first a and
 * last b legs can have been collected in some floor-preserving order. */
function reachableSplits(path: readonly DfsQuote[], enabled: boolean, drawdownBps: number): Set<string> {
  const length = path.length, reachable = new Set<string>();
  const prefix = [{ num: 1n, den: 1n }], suffix = [{ num: 1n, den: 1n }];
  for (let i = 0; i < length; i++) {
    const left = path[i]!.value!, right = path[length - 1 - i]!.value!;
    prefix.push({ num: prefix[i]!.num * left.num, den: prefix[i]!.den * left.den });
    suffix.push({ num: suffix[i]!.num * right.num, den: suffix[i]!.den * right.den });
  }
  for (let total = 2; total <= length; total++) for (let a = 1; a < total; a++) {
    const b = total - a, num = prefix[a]!.num * suffix[b]!.num, den = prefix[a]!.den * suffix[b]!.den;
    if (enabled && num * 10_000n < den * BigInt(10_000 - drawdownBps)) continue;
    if (total === 2 || reachable.has(`${a - 1}/${b}`) || reachable.has(`${a}/${b - 1}`)) reachable.add(`${a}/${b}`);
  }
  return reachable;
}

function oracle(input: Case): Row[] {
  const enabled = input.prefixPruningEnabled ?? true, drawdown = input.maxPrefixDrawdownBps ?? 0;
  const signals = input.signals.filter(s => profitable(s.num, s.den, input.minSpreadBps));
  const outgoing = new Map<string, DfsQuote[]>();
  for (const q of input.quotes) if (q.value) {
    const rows = outgoing.get(q.tokenIn) ?? []; rows.push(q); outgoing.set(q.tokenIn, rows);
  }
  const result = new Map<string, Row>();
  const admits = (path: readonly DfsQuote[]) => {
    let num = 1n, den = 1n;
    for (const q of path) { num *= q.num; den *= q.den; }
    if (!profitable(num, den, input.minSpreadBps)) return false;
    for (const s of signals) for (let i = 0; i < path.length; i++) {
      if (path[i]!.id !== s.sell || path[(i + path.length - 1) % path.length]!.id !== s.buy ||
          path[i]!.tokenIn !== s.token) continue;
      const rotated = [...path.slice(i), ...path.slice(0, i)];
      const states = reachableSplits(rotated, enabled, drawdown);
      for (let a = 1; a < path.length; a++) if (states.has(`${a}/${path.length - a}`)) return true;
    }
    return false;
  };
  for (const funding of new Set(input.funding)) {
    const path: DfsQuote[] = [];
    const walk = (token: string) => {
      if (path.length >= input.maxHops) return;
      for (const q of outgoing.get(token) ?? []) {
        if (input.allowRepeatedPools === false && path.some(old => old.instance === q.instance)) continue;
        path.push(q);
        if (q.tokenOut === funding && path.length >= 2 && admits(path)) {
          result.set(key(path), { ids: path.map(edge => edge.id), spreadBps: spread(path) });
        }
        // Returning to the funding token is not a stop condition: bounded
        // walks may visit it or any other token again before the final close.
        walk(q.tokenOut);
        path.pop();
      }
    };
    walk(funding);
  }
  return sorted(result.values());
}

function collect(input: Case, engine: Engine = enumerateJointDfs): Row[] {
  const byId = new Map(input.quotes.map(q => [q.id, q])), rows: Row[] = [];
  const stats = engine({ ...input, deadlineAtMs: Date.now() + 30_000, onCycle(path, spreadBps) {
    for (const q of path) assert.equal(q, byId.get(q.id), "callbacks must retain the caller's original quote objects");
    rows.push({ ids: path.map(q => q.id), spreadBps });
  } });
  assert.equal(stats.deadlineHit, false, "correctness cases must finish without sampling by deadline");
  assert.equal(stats.closed, rows.length);
  assert.equal(new Set(rows.map(row => JSON.stringify(row.ids))).size, rows.length, "duplicate funded directed path");
  return sorted(rows);
}

function check(input: Case, label: string, compareOld = false) {
  const before = structuredClone(input), actual = collect(input);
  assert.deepEqual(actual, oracle(input), `${label}: independent complete-walk / DP oracle`);
  if (compareOld) assert.deepEqual(actual, collect(input, enumeratePairedDfs), `${label}: unpruned legacy cycle set`);
  assert.deepEqual(input, before, `${label}: caller-owned input mutated`);
  return actual;
}

function ring(values: readonly (readonly [bigint, bigint])[]): DfsQuote[] {
  const tokens = ["f", ...values.slice(1).map((_, i) => `t${i + 1}`), "f"];
  return values.map(([num, den], i) => quote(i === 0 ? "sell" : i === values.length - 1 ? "buy" : `q${i}`,
    tokens[i]!, tokens[i + 1]!, 110n, 100n, { num, den }));
}

test("joint DFS seeds one bound sell/buy pair and permits either first extension", () => {
  const merged = [quote("sell", "f", "a", 130n), quote("buy", "a", "f", 90n)];
  assert.equal(check(scenario(merged, [signal("f", "buy", "sell")], { maxHops: 2 }), "1.3 × 0.9 seed").length, 1);
  for (const middle of [[[1n, 2n], [2n, 1n]], [[2n, 1n], [1n, 2n]]] as const) {
    const quotes = ring([[13n, 10n], ...middle, [1n, 1n]]);
    const states = reachableSplits(quotes, true, 0);
    assert.equal(states.has("2/1"), middle[0][0] === 2n);
    assert.equal(states.has("1/2"), middle[0][0] !== 2n);
    assert.equal(check(scenario(quotes, [signal("f", "buy", "sell")]), `forced first extension ${middle}`).length, 1);
  }
  const trapped = ring([[1n, 1n], [1n, 2n], [4n, 1n], [1n, 2n], [1n, 1n]]);
  assert.equal(check(scenario(trapped, [signal("f", "buy", "sell")]), "profitable complete ring but both fronts initially below floor").length, 0);
  assert.equal(check(scenario(trapped, [signal("f", "buy", "sell")], { prefixPruningEnabled: false }),
    "disabled pruning allows the trapped ring", true).length, 1);
});

test("joint DFS bounds total hops, not either side to three, and counts both seed legs", () => {
  const middle = [[1n, 10n], [10n, 1n], [1n, 1n], [1n, 1n]] as const;
  for (const reversed of [false, true]) {
    const quotes = ring([[1n, 1n], ...(reversed ? [...middle].reverse() : middle), [1n, 1n]]);
    const states = reachableSplits(quotes, true, 0);
    assert(states.has(reversed ? "5/1" : "1/5"));
    assert(!states.has("3/3"), "the regression must require a side beyond the old three-hop limit");
    assert.equal(check(scenario(quotes, [signal("f", "buy", "sell")], { maxHops: 6 }), `six hops, reverse=${reversed}`).length, 1);
    assert.equal(check(scenario(quotes, [signal("f", "buy", "sell")], { maxHops: 5 }), `six hops do not fit five, reverse=${reversed}`).length, 0);
  }
  const seven = ring(Array.from({ length: 7 }, () => [1n, 1n] as [bigint, bigint]));
  assert.equal(check(scenario(seven, [signal("f", "buy", "sell")], { maxHops: 6 }), "seven hops excluded at cap six").length, 0);
  assert.equal(check(scenario(seven, [signal("f", "buy", "sell")], { maxHops: 7 }), "seven hops included only at cap seven").length, 1);
});

test("joint reference-value floors are inclusive and exact at zero/ten percent drawdown", () => {
  for (const bits of [300n, 1500n]) for (const drawdown of [0, 1000]) for (const delta of [-1n, 0n, 1n]) {
    const scale = 1n << bits, ratio: [bigint, bigint] = [BigInt(10_000 - drawdown) * scale + delta, 10_000n * scale];
    for (const atSeed of [false, true]) {
      const quotes = ring(atSeed ? [ratio, [1n, 1n]] : [[1n, 1n], ratio, [1n, 1n]]);
      const result = check(scenario(quotes, [signal("f", "buy", "sell")], { maxPrefixDrawdownBps: drawdown, maxHops: quotes.length }),
        `exact floor bits=${bits}, drawdown=${drawdown}, delta=${delta}, seed=${atSeed}`);
      assert.equal(result.length, delta < 0n ? 0 : 1);
    }
  }
});

test("joint cycle and directed-signal raw profit thresholds remain strict", () => {
  const scale = 1n << 350n;
  for (const delta of [-1n, 0n, 1n]) for (const signalBoundary of [false, true]) {
    const num = 10_050n * scale + delta, den = 10_000n * scale;
    const quotes = [quote("sell", "f", "a", 1n, 1n, { num: 1n, den: 1n }),
      quote("buy", "a", "f", signalBoundary ? 2n : num, signalBoundary ? 1n : den, { num: 2n, den: 1n })];
    const result = check(scenario(quotes, [signal("f", "buy", "sell", signalBoundary ? num : 2n, signalBoundary ? den : 1n)],
      { maxHops: 2, minSpreadBps: 50 }), `raw threshold delta=${delta}, signal=${signalBoundary}`);
    assert.equal(result.length, delta > 0n ? 1 : 0);
  }
  const huge = 1n << 1500n;
  const hugeQuotes = [quote("sell", "f", "a", huge * 2n, huge), quote("buy", "a", "f", huge * 3n, huge * 4n)];
  assert.equal(check(scenario(hugeQuotes, [signal("f", "buy", "sell")], { maxHops: 2 }), "finite spread fallback on enormous raw integers").length, 1);
});

test("joint DFS cannot mix different directed pairs at one anchor", () => {
  const quotes = [quote("s1", "f", "a"), quote("b1", "x", "f"), quote("s2", "f", "y"), quote("b2", "a", "f")];
  const signals = [signal("f", "b1", "s1"), signal("f", "b2", "s2")];
  assert.equal(check(scenario(quotes, signals), "individually compatible sell/buy sets cannot create a new pair").length, 0);
  assert(check(scenario(quotes, [...signals, signal("f", "b2", "s1")]), "actual signal pair authorizes the route").length > 0);
  const filtered = scenario(quotes, [signal("f", "b2", "s1", 100n)], { minSpreadBps: 0 });
  assert.equal(check(filtered, "zero signal spread does not authorize a profitable raw cycle").length, 0);
});

test("joint DFS keeps bounded token/pool revisits, self-loops and every funded rotation", () => {
  const quotes = [quote("sell", "f", "a"), quote("ab", "a", "b"), quote("ba", "b", "a"),
    quote("self", "a", "a"), quote("buy", "a", "f")];
  for (const allowRepeatedPools of [false, true]) for (const prefixPruningEnabled of [false, true]) {
    const result = check(scenario(quotes, [signal("f", "buy", "sell"), signal("a", "sell", "buy")], {
      funding: ["f", "a", "a", "b"], maxHops: 6, allowRepeatedPools, prefixPruningEnabled,
    }), `walk/reuse=${allowRepeatedPools}/prune=${prefixPruningEnabled}`, !prefixPruningEnabled);
    const has = (ids: string[]) => result.some(row => JSON.stringify(row.ids) === JSON.stringify(ids));
    assert(has(["sell", "ab", "ba", "buy"]), "a repeated token is legal even without pool reuse");
    assert(has(["sell", "self", "buy"]), "self-loop is not a token-uniqueness rejection");
    assert.equal(has(["sell", "self", "self", "buy"]), allowRepeatedPools);
    assert.equal(has(["sell", "buy", "sell", "buy"]), allowRepeatedPools,
      "the search must continue expanding after an earlier close");
    assert(has(["ab", "ba", "buy", "sell"]), "each occurrence of a funded token gets its directed rotation");
  }
  for (const extra of [{ funding: [] }, { signals: [] }, { quotes: [] }]) {
    assert.equal(check({ ...scenario(quotes, [signal("f", "buy", "sell")]), ...extra }, "empty prerequisite").length, 0);
  }
  const missing = quotes.map(q => q.id === "buy" ? { ...q, value: null } : q);
  assert.equal(check(scenario(missing, [signal("f", "buy", "sell")]), "null-valued seed is ineligible").length, 0);
});

test("joint DFS matches an independent oracle on 72 random bounded-walk graphs", () => {
  let seed = 0x91c74d03;
  let nonemptyCases = 0;
  const random = (bound: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 16) % bound; };
  for (let sample = 0; sample < 72; sample++) {
    const tokens = ["f", "a", "b", "c"].slice(0, 3 + random(2)), quotes: DfsQuote[] = [];
    for (let i = 0, count = 4 + random(4); i < count; i++) {
      const q = quote(`q${i}`, tokens[random(tokens.length)]!, tokens[random(tokens.length)]!,
        BigInt(85 + random(56)), 100n, { num: BigInt([70, 90, 100, 110, 140][random(5)]!), den: 100n }, `pool${random(5)}`);
      quotes.push(random(13) === 0 ? { ...q, value: null } : q);
    }
    for (const allowRepeatedPools of [false, true]) {
      const signals: DirectedPriceSignal[] = [];
      for (const token of tokens) for (const buy of quotes.filter(q => q.tokenOut === token)) {
        for (const sell of quotes.filter(q => q.tokenIn === token)) if ((allowRepeatedPools || buy.instance !== sell.instance) && random(3) > 0) {
          signals.push(signal(token, buy.id, sell.id, BigInt(99 + random(5))));
        }
      }
      if (signals.length) signals.push(signals[0]!);
      for (const prefix of [{ prefixPruningEnabled: false, maxPrefixDrawdownBps: 0 },
        { prefixPruningEnabled: true, maxPrefixDrawdownBps: 0 }, { prefixPruningEnabled: true, maxPrefixDrawdownBps: 1000 }]) {
        const result = check(scenario(sample % 2 ? [...quotes].reverse() : quotes, signals, { allowRepeatedPools, ...prefix,
          funding: ["f", "a"], maxHops: 2 + sample % 4, minSpreadBps: sample % 3 * 50,
        }), `random ${sample}, reuse=${allowRepeatedPools}, policy=${JSON.stringify(prefix)}`, !prefix.prefixPruningEnabled);
        if (result.length) nonemptyCases++;
      }
    }
  }
  assert(nonemptyCases >= 30, "the random suite must exercise emitted cycles, not only empty graphs");
});

test("joint DFS unpruned real effective fixture preserves the old complete cycle set", () => {
  const saved = JSON.parse(readFileSync(new URL("./fixtures/blockscan-effective-26029875.json", import.meta.url), "utf8")) as {
    sourceBlock: number; rows: { edge: TokenEdge; quote: { amountIn: string; amountOut: string; mid: number } | null }[];
  };
  assert.equal(saved.sourceBlock, 26029875);
  const edges = saved.rows.map(row => row.edge), mids = new Map<string, ResolvedBlockScanMid>();
  for (const { edge, quote: effective } of saved.rows) if (effective) mids.set(blockScanEdgeKey(edge), {
    kind: "historical-effective", pool: edge.target, edges: [edge], mid: effective.mid, feeBps: 0, depthProxy: 0,
    quoteAmountIn: BigInt(effective.amountIn), quoteAmountOut: BigInt(effective.amountOut),
  });
  for (const allowRepeatedPools of [false, true]) {
    const view = buildBlockScanUsdView(edges, mids, 50, allowRepeatedPools);
    const result = check(scenario(view.quotes, view.signals, { allowRepeatedPools, minSpreadBps: 50,
      prefixPruningEnabled: false, maxHops: 6,
      funding: [ADDR.WETH, ADDR.USDC, ADDR.USDT, ADDR.DAI].map(token => token.toLowerCase()),
    }), `frozen effective ${saved.sourceBlock}, reuse=${allowRepeatedPools}`, true);
    assert(result.length > 0);
  }
});

test("joint DFS counts callback time, propagates the original throw and recovers cleanly", async () => {
  const input = scenario([quote("sell", "f", "a"), quote("buy", "a", "f")], [signal("f", "buy", "sell")],
    { maxHops: 6, funding: ["f", "a"] });
  const sentinel = new Error("joint callback sentinel");
  let throwCalls = 0;
  assert.throws(() => enumerateJointDfs({ ...input, deadlineAtMs: Date.now() + 30_000, onCycle() {
    throwCalls++; throw sentinel;
  } }), error => error === sentinel);
  assert.equal(throwCalls, 1);
  check(input, "healthy after callback error");
  let calls = 0, returned = false;
  const deadlineAtMs = Date.now() + 100;
  const stats = enumerateJointDfs({ ...input, deadlineAtMs, onCycle() {
    assert(!returned); calls++;
    if (calls === 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, deadlineAtMs - Date.now()) + 5);
  } });
  returned = true;
  assert(calls > 0);
  assert.equal(stats.deadlineHit, true);
  assert.equal(stats.closed, calls);
  const settled = calls;
  await new Promise<void>(resolve => setTimeout(resolve, 5));
  assert.equal(calls, settled, "no callback after synchronous return");
  check(input, "healthy after callback deadline");
  const expired = enumerateJointDfs({ ...input, deadlineAtMs: Date.now() - 1,
    onCycle: () => assert.fail("expired call emitted") });
  assert.equal(expired.deadlineHit, true);
  assert.equal(expired.closed, 0);
});
