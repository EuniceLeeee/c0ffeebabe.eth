/** Offline differential contract for the native engine; the current TS engine is the oracle. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ADDR } from "../../shared/constants/addresses.js";
import { BLOCKSCAN_ENUMERATION_DEFAULTS } from "../blockscan-enumeration-config.js";
import { buildBlockScanUsdView } from "../blockscan-usd-view.js";
import {
  enumeratePairedDfs, enumeratePairedLayered, resolvePairedEnumerationOptions,
  type DfsQuote, type DirectedPriceSignal, type PairedEnumerationMethod,
} from "../detector/blockscan-paired-dfs.js";
import { enumerateRustPaired } from "../detector/blockscan-paired-rust.js";
import { scanBlockStateFromResolvedMids, type BlockScanCoreConfig,
  type ResolvedBlockScanMid } from "../detector/blockscan-scanner-core.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";

type Input = Parameters<typeof enumeratePairedDfs>[0];
type Case = Omit<Input, "deadlineAtMs" | "onCycle">;
type Engine = (input: Input) => ReturnType<typeof enumeratePairedDfs>;
const methods = ["dfs", "layered"] as const;
const threadCounts = [1, 2, 4] as const;
const reference = (method: PairedEnumerationMethod): Engine =>
  method === "dfs" ? enumeratePairedDfs : enumeratePairedLayered;
const native = (method: PairedEnumerationMethod, rustThreads?: number): Engine => input =>
  enumerateRustPaired(rustThreads === undefined ? input : { ...input, rustThreads }, method);
const quote = (id: string, tokenIn: string, tokenOut: string, num = 100n, den = 100n,
  instance = id): DfsQuote => Object.freeze({ id, tokenIn, tokenOut, num, den, instance,
  value: Object.freeze({ num, den }) });
const signal = (token: string, buy: string, sell: string, num = 120n, den = 100n): DirectedPriceSignal =>
  Object.freeze({ token, buy, sell, num, den });
const scenario = (quotes: readonly DfsQuote[], signals: readonly DirectedPriceSignal[], extra: Partial<Case> = {}): Case =>
  Object.freeze({ quotes: Object.freeze([...quotes]), signals: Object.freeze([...signals]),
    funding: Object.freeze(["f"]), maxHops: 6, minSpreadBps: 0, allowRepeatedPools: true,
    prefixPruningEnabled: false, maxPrefixDrawdownBps: 1000, hopTokensPerStep: 0, ...extra });
const ring = [quote("sell", "f", "a", 101n), quote("ab", "a", "b", 101n),
  quote("bj", "b", "join", 101n), quote("jc", "join", "c", 101n),
  quote("cd", "c", "d", 101n), quote("buy", "d", "f", 120n)];
const ringSignal = signal("f", "buy", "sell");

// Standalone native diagnostics have no Token cap or its TS-only telemetry.
function legacyStats(stats: ReturnType<typeof enumeratePairedDfs>) {
  const { hopTokensPerStep, hopTokenForwardQuotes, hopTokenReverseQuotes, hopSignalPairsSelected, ...legacy } = stats;
  return legacy;
}

function collect(engine: Engine, input: Case) {
  assert.equal(input.hopTokensPerStep, 0, "native parity controls must disable the TS-only Token cap");
  const calls: { path: readonly DfsQuote[]; spreadBps: number }[] = [];
  const byId = new Map(input.quotes.map(q => [q.id, q]));
  const stats = engine({ ...input, deadlineAtMs: Date.now() + 60_000, onCycle(path, spreadBps) {
    for (const q of path) assert.equal(q, byId.get(q.id), "callbacks must retain the caller's quote objects");
    calls.push({ path: [...path], spreadBps });
  } });
  assert.equal(stats.deadlineHit, false, "differential cases must finish, not compare truncated samples");
  assert.equal(stats.closed, calls.length);
  return { calls, stats: legacyStats(stats) };
}

function compare(input: Case, label: string, threads: readonly number[] = threadCounts) {
  const unchanged = structuredClone(input);
  const results = methods.map(method => {
    const expected = collect(reference(method), input);
    for (const count of threads) {
      const actual = collect(native(method, count), input);
      assert.deepEqual(actual.calls, expected.calls, `${label}: ${method}/${count} threads ordered callbacks/spreads`);
      assert.deepEqual(actual.stats, expected.stats, `${label}: ${method}/${count} threads legacy statistics`);
    }
    return expected;
  });
  assert.deepEqual(input, unchanged, `${label}: neither backend may mutate caller-owned input`);
  return results[0]!;
}

// Synchronous native deadlocks cannot be interrupted by node:test's event-loop
// timeout. Run cancellation/throw cases in one owned, time-bounded child process.
if (process.argv.includes("--parallel-cancellation-child")) {
  await cancellationChecks();
  console.log("parallel cancellation checks: PASS");
  process.exit(0);
}

test("Rust preserves empty, missing-reference and exact funded callback order", () => {
  compare(scenario([], []), "empty graph");
  compare(scenario(ring, []), "no signals");
  compare(scenario(ring, [ringSignal], { funding: [] }), "no funding");
  compare(scenario(ring, [signal("f", "missing", "sell")]), "unknown signal edge");
  compare(scenario(ring.map((q, i) => i === 3 ? { ...q, value: null } : q), [ringSignal]), "null reference");
  for (const maxHops of [2, 3, 4, 5, 6, 7, 8]) {
    const result = compare(scenario(ring, [ringSignal], { maxHops, funding: ["join", "f", "a", "f"] }), `hop cap ${maxHops}`);
    assert.equal(result.calls.length, maxHops < 6 ? 0 : 3);
  }
  const anchored = compare(scenario(ring, [signal("a", "sell", "ab")], { funding: ["join"] }), "unfunded anchor");
  assert.equal(anchored.calls[0]!.path[0]!.tokenIn, "join");
});

test("Rust keeps strict whole-cycle/signal profit but inclusive prefix boundaries", () => {
  const scale = 1n << 350n;
  for (const delta of [-1n, 0n, 1n]) {
    const quotes = [quote("sell", "f", "a", 1n, 1n), quote("buy", "a", "f", 10_050n * scale + delta, 10_000n * scale)];
    const result = compare(scenario(quotes, [signal("f", "buy", "sell")], { minSpreadBps: 50, maxHops: 2 }), `cycle threshold ${delta}`);
    assert.equal(result.calls.length, delta > 0n ? 1 : 0);
    const signalResult = compare(scenario([quote("sell", "f", "a"), quote("buy", "a", "f", 120n)],
      [signal("f", "buy", "sell", 10_050n * scale + delta, 10_000n * scale)], { minSpreadBps: 50, maxHops: 2 }), `signal threshold ${delta}`);
    assert.equal(signalResult.calls.length, delta > 0n ? 1 : 0);
  }
  for (const maxPrefixDrawdownBps of [0, 1000, 10_000]) for (const dipAt of [0, 1]) {
    for (const delta of [-1n, 0n, 1n]) {
      const value = BigInt(10_000 - maxPrefixDrawdownBps) * scale + delta;
      if (value <= 0n) continue;
      const quotes = [quote("sell", "f", "a"), quote("middle", "a", "b"), quote("buy", "b", "f", 120n)]
        .map((q, i) => i === dipAt ? { ...q, value: { num: value, den: 10_000n * scale } } : q);
      const result = compare(scenario(quotes, [signal("f", "buy", "sell")], {
        maxHops: 3, prefixPruningEnabled: true, maxPrefixDrawdownBps,
      }), `prefix ${maxPrefixDrawdownBps}, edge ${dipAt}, delta ${delta}`);
      assert.equal(result.calls.length, delta < 0n ? 0 : 1);
    }
  }
});

test("Rust applies prefix floors from the signal anchor across the reverse suffix", () => {
  const quotes = [quote("sell", "f", "a", 200n), quote("dip", "a", "b", 50n), quote("buy", "b", "f", 110n)];
  for (const funding of [["f"], ["a"], ["b"], ["a", "b", "f"]]) {
    const result = compare(scenario(quotes, [signal("f", "buy", "sell")], {
      maxHops: 3, funding, prefixPruningEnabled: true, maxPrefixDrawdownBps: 0,
    }), `gain covers suffix, funding ${funding}`);
    assert.equal(result.calls.length, funding.length, "2 -> 1 -> 1.1 stays at/above the signal-start value");
  }
  assert.equal(compare(scenario(quotes, [signal("a", "sell", "dip")], {
    prefixPruningEnabled: true, maxPrefixDrawdownBps: 0,
  }), "different signal anchor").calls.length, 0);
  const dip = [quote("sell", "f", "a"), quote("dip", "a", "b", 80n),
    quote("recover", "b", "c", 150n), quote("buy", "c", "f")];
  for (const maxHops of [4, 6]) for (const enabled of [false, true]) {
    const result = compare(scenario(dip, [signal("f", "buy", "sell")], {
      maxHops, prefixPruningEnabled: enabled, maxPrefixDrawdownBps: 1000,
    }), `interior suffix dip, hops ${maxHops}, pruning ${enabled}`);
    assert.equal(result.calls.length, enabled ? 0 : 1);
  }
  const partnerQuotes = [quote("gain", "f", "a", 200n), quote("loss", "a", "f", 55n),
    quote("other-buy", "b", "f", 120n), quote("other-sell", "f", "c", 120n)];
  const partnerSignals = [signal("f", "other-buy", "gain"), signal("f", "loss", "other-sell"), signal("a", "gain", "loss")];
  assert.equal(compare(scenario(partnerQuotes, partnerSignals, { maxHops: 2, prefixPruningEnabled: true }),
    "another signal's reverse partner cannot authorize the anchor").calls.length, 0);
});

test("Rust preserves pool conflicts while admitting repeated tokens and instances", () => {
  for (const [first, second] of [[0, 1], [3, 4], [1, 3]]) for (const allowRepeatedPools of [false, true]) {
    const quotes = ring.map((q, i) => i === second ? { ...q, instance: ring[first!]!.instance } : q);
    const result = compare(scenario(quotes, [ringSignal], { allowRepeatedPools }), `pool collision ${first}/${second}, ${allowRepeatedPools}`);
    assert.equal(result.calls.length, allowRepeatedPools ? 1 : 0);
  }
  const repeated = ring.map((q, i) => i === 4 ? { ...q, tokenOut: "a" } : i === 5 ? { ...q, tokenIn: "a" } : q);
  const result = compare(scenario(repeated, [ringSignal]), "repeated token with legal two-hop shortcut");
  assert(result.calls.some(x => x.path.map(q => q.id).join("|") === repeated.map(q=>q.id).join("|")));
  assert(result.calls.some(x => x.path.map(q => q.id).join("|") === "sell|buy"));
  assert(result.calls.every(x=>x.path.length<=6));
  compare(scenario([...ring, quote("self", "b", "b", 1000n)], [ringSignal]), "bounded self-loop parity");
  const roundTrip = [quote("sell", "f", "a", 100n, 100n, "shared"), quote("buy", "a", "f", 110n, 100n, "shared")];
  assert.deepEqual(compare(scenario(roundTrip, [signal("f", "buy", "sell")]), "same instance round trip").calls.map(x=>x.path.length), [2,4,6]);
});

test("Rust preserves equal-rate sorting, overlapping anchors and unreduced huge BigInts", () => {
  const tied = [quote("sell", "f", "a", 200n), quote("buy-z", "a", "f", 55n),
    quote("buy-a", "a", "f", 110n, 200n), quote("buy-m", "a", "f", 165n, 300n)];
  const signals = tied.slice(1).flatMap(q => [signal("f", q.id, "sell"), signal("a", "sell", q.id)]);
  for (const prefixPruningEnabled of [false, true]) for (const quotes of [tied, [...tied].reverse()]) {
    const result = compare(scenario(quotes, [...signals, ...signals], {
      funding: ["f", "a"], maxHops: 2, prefixPruningEnabled, maxPrefixDrawdownBps: 10_000,
    }), `equal rates/overlap, pruning ${prefixPruningEnabled}, reversed ${quotes !== tied}`);
    assert.equal(result.calls.length, 6);
    assert.equal(new Set(result.calls.map(x => x.path.map(q => q.id).join("|"))).size, 6);
  }
  for (const bits of [257n, 600n, 1500n]) {
    const huge = 1n << bits;
    const quotes = [quote("sell", "f", "a", 200n * huge + 1n, 100n * huge),
      quote("buy", "a", "f", 55n * huge + 1n, 100n * huge)];
    for (const prefixPruningEnabled of [false, true]) {
      const result = compare(scenario(quotes, [signal("f", "buy", "sell", 120n * huge, 100n * huge)], {
        maxHops: 2, prefixPruningEnabled, maxPrefixDrawdownBps: 0,
      }), `BigInt ${bits} bits, including Number overflow, pruning ${prefixPruningEnabled}`);
      assert.equal(result.calls.length, 1);
      assert(Number.isFinite(result.calls[0]!.spreadBps));
    }
  }
});

test("Rust matches all ordered callbacks and statistics on 120 deterministic random graphs", () => {
  let seed = 0x7c416636;
  const random = (bound: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % bound; };
  for (let sample = 0; sample < 120; sample++) {
    const tokens = ["f", "g", "a", "b", "c"].slice(0, 3 + random(3));
    const marks = new Map(tokens.map(token => [token, BigInt(50 + random(150))]));
    const quotes: DfsQuote[] = [];
    for (let index = 0, count = 5 + random(12); index < count; index++) {
      const from = random(tokens.length), to = (from + 1 + random(tokens.length - 1)) % tokens.length;
      const q = quote(`q${index}`, tokens[from]!, tokens[to]!, BigInt(75 + random(61)), 100n, `pool${random(8)}`);
      quotes.push({ ...q, value: random(11) === 0 ? null : {
        num: q.num * marks.get(q.tokenOut)!, den: q.den * marks.get(q.tokenIn)!,
      } });
    }
    for (const allowRepeatedPools of [false, true]) {
      const signals: DirectedPriceSignal[] = [];
      for (const token of tokens) {
        const buys = quotes.filter(q => q.tokenOut === token), sells = quotes.filter(q => q.tokenIn === token);
        for (const buy of buys) for (const sell of sells) if (allowRepeatedPools || buy.instance !== sell.instance) {
          if (random(3) === 0) signals.push(signal(token, buy.id, sell.id, BigInt(99 + random(8))));
        }
      }
      if (signals.length) signals.push(signals[0]!);
      for (const prefix of [{ prefixPruningEnabled: false, maxPrefixDrawdownBps: 1000 },
        ...[0, 1000, 10_000].map(maxPrefixDrawdownBps => ({ prefixPruningEnabled: true, maxPrefixDrawdownBps }))]) {
        for (const inputQuotes of [quotes, [...quotes].reverse()]) compare(scenario(inputQuotes, signals, {
          funding: ["g", "f"], allowRepeatedPools, ...prefix, maxHops: 2 + sample % 6, minSpreadBps: sample % 3 * 50,
        }), `random ${sample}, reuse ${allowRepeatedPools}, prefix ${JSON.stringify(prefix)}, reverse ${inputQuotes !== quotes}`,
        sample < 40 ? threadCounts : [2]);
      }
    }
  }
});

test("Rust validates malformed inputs like TS and ignores them only after an expired deadline", () => {
  const valid = scenario([quote("sell", "f", "a"), quote("buy", "a", "f", 120n)], [signal("f", "buy", "sell")]);
  const invalid: Case[] = [
    { ...valid, quotes: [...valid.quotes, valid.quotes[0]!] },
    { ...valid, quotes: [{ ...valid.quotes[0]!, num: 0n }, valid.quotes[1]!] },
    { ...valid, quotes: [{ ...valid.quotes[0]!, den: -1n }, valid.quotes[1]!] },
    { ...valid, quotes: [{ ...valid.quotes[0]!, value: { num: 0n, den: 1n } }, valid.quotes[1]!] },
    { ...valid, signals: [signal("wrong", "buy", "sell")] },
    { ...valid, signals: [signal("f", "buy", "sell", 1n, 0n)] },
    { ...valid, quotes: valid.quotes.map(q => ({ ...q, instance: "shared" })), allowRepeatedPools: false },
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(minSpreadBps => ({ ...valid, minSpreadBps })),
    ...[0, 1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(maxHops => ({ ...valid, maxHops })),
    ...[-1, 10_001, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(maxPrefixDrawdownBps => ({ ...valid, maxPrefixDrawdownBps })),
    { ...valid, prefixPruningEnabled: "1" as unknown as boolean },
  ];
  for (const method of methods) for (const [index, input] of invalid.entries()) {
    const invoke = (engine: Engine) => engine({ ...input, deadlineAtMs: Date.now() + 60_000, onCycle: () => assert.fail("invalid callback") });
    let expected: unknown;
    try { invoke(reference(method)); } catch (error) { expected = error; }
    assert(expected instanceof Error, `TS must reject invalid case ${index}`);
    const expectedMessage = expected.message;
    assert.throws(() => invoke(native(method)), (error: unknown) =>
      error instanceof Error && error.message === expectedMessage, `invalid case ${index}, ${method}`);
  }
  for (const method of methods) for (const count of threadCounts) {
    const input = { ...valid, quotes: [valid.quotes[0]!, valid.quotes[0]!], deadlineAtMs: Date.now() - 1,
      onCycle: () => assert.fail("expired invocation must never emit") };
    const expected = reference(method)(input), actual = native(method, count)(input);
    assert.equal(actual.deadlineHit, true);
    assert.deepEqual(legacyStats(actual), legacyStats(expected));
  }
});

test("Rust worker/scratch defaults and limits are validated even by the TS backend", () => {
  const valid = scenario([quote("sell", "f", "a"), quote("buy", "a", "f", 120n)],
    [signal("f", "buy", "sell"), signal("a", "sell", "buy")], { funding: ["f", "a"], maxHops: 2 });
  const options = resolvePairedEnumerationOptions({ ...valid, deadlineAtMs: Date.now() + 60_000, onCycle() {} });
  assert.equal(options.rustThreads, 1);
  assert.equal(options.rustScratchMb, 512);
  for (const method of methods) {
    const expected = collect(reference(method), valid);
    assert.deepEqual(collect(native(method), valid), expected, `${method}: omitted worker count`);
    for (const rustThreads of [1, 8]) {
      assert.deepEqual(collect(native(method), { ...valid, rustThreads, rustScratchMb: 2048 }), expected,
        `${method}: valid boundary ${rustThreads} workers / 2048 MiB`);
    }
    for (const [key, upper, message] of [
      ["rustThreads", 8, "rustThreads must be an integer from 1 to 8"],
      ["rustScratchMb", 2048, "rustScratchMb must be an integer from 1 to 2048"],
    ] as const) {
      for (const value of [0, -1, upper + 1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2"]) {
        for (const engine of [reference(method), native(method)]) for (const expired of [false, true]) {
          assert.throws(() => engine({ ...valid, [key]: value, deadlineAtMs: Date.now() + (expired ? -1 : 60_000),
            onCycle: () => assert.fail("invalid resource configuration emitted a callback") }),
          error => error instanceof Error && error.message === message,
          `${method}: ${key}=${value}, including expired=${expired}`);
        }
      }
    }
  }
  for (const enumerationBackend of ["typescript", "rust"] as const) {
    for (const [key, upper, message] of [
      ["rustEnumerationThreads", 8, "rustThreads must be an integer from 1 to 8"],
      ["rustEnumerationScratchMb", 2048, "rustScratchMb must be an integer from 1 to 2048"],
    ] as const) for (const value of [0, -1, upper + 1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2"]) {
      assert.throws(() => scanBlockStateFromResolvedMids({ edges: [], mids: new Map(), sourceBlock: 1,
        swapTouched: null, cfg: { enumerationBackend, enumerationMethod: "dfs", [key]: value, maxHops: 2, minSpreadBps: 0,
          maxCandidates: 10, budgetMs: 60_000, pricedTokens: new Map() } }),
      error => error instanceof Error && (enumerationBackend === "rust" && !BLOCKSCAN_ENUMERATION_DEFAULTS.rustEnabled
        ? /Rust enumeration is disabled/.test(error.message) : error.message === message),
      `${enumerationBackend} scanner: ${key}=${value}`);
    }
  }
});

async function cancellationChecks() {
  const input = scenario(ring, [ringSignal], { funding: ["f", "a", "b", "join", "c", "d"] });
  // Several overlapping anchors ensure there is real worker work to cancel,
  // not only a one-anchor input which a parallel engine could execute serially.
  const multiAnchor = { ...input, signals: [ringSignal, signal("a", "sell", "ab"),
    signal("b", "ab", "bj"), signal("join", "bj", "jc"), signal("c", "jc", "cd"), signal("d", "cd", "buy")] };
  // Four parallel choices per hop produce 4096 cycles per anchor. Workers
  // cannot buffer all of these in their bounded result queues while JS blocks
  // or throws in its first callback, so cancellation must wake real producers.
  const busyQuotes = ring.flatMap(q => Array.from({ length: 4 }, (_, i) => ({
    ...q, id: `${q.id}:${i}`, instance: `${q.instance}:${i}`,
  })));
  const busyAnchor = { ...multiAnchor, quotes: busyQuotes, signals: ring.flatMap(edge =>
    busyQuotes.filter(q => q.tokenOut === edge.tokenIn).flatMap(buy =>
      busyQuotes.filter(q => q.tokenIn === edge.tokenIn).map(sell => signal(edge.tokenIn, buy.id, sell.id)))) };
  // Two CHUNK=65536 one-hop half buffers already consume 1 MiB, before
  // their heads/metadata. This tiny graph deterministically hits the native
  // scratch bound without large input, expensive traversal or a deadline race.
  const pressure = scenario([quote("sell", "f", "a"), quote("buy", "a", "f", 120n)],
    [signal("f", "buy", "sell"), signal("a", "sell", "buy")], { maxHops: 2, funding: ["f", "a"], rustScratchMb: 1 });
  const yieldToCallbacks = () => new Promise<void>(resolve => setTimeout(resolve, 5));
  for (const method of methods) {
    for (const count of threadCounts) {
      let pressureCalls = 0, pressureReturned = false;
      assert.throws(() => native(method, count)({ ...pressure, deadlineAtMs: Date.now() + 60_000, onCycle() {
        assert(!pressureReturned, "callback after scratch-limit error returned"); pressureCalls++;
      } }), /blockscan Rust enumeration scratch memory limit exceeded/,
      "scratch exhaustion must throw, never return complete or deadline-limited results");
      pressureReturned = true;
      assert.equal(pressureCalls, 0, "the initial half-buffer allocation must fail before joining");
      await yieldToCallbacks();
      assert.equal(pressureCalls, 0, "scratch failure must drain workers before returning");
      compare(multiAnchor, `fresh enumeration after scratch pressure ${method}/${count}`, [count]);
      const sentinel = new Error(`callback sentinel ${method}, threads ${count}`);
      let callbacks = 0, returned = false;
      assert.throws(() => native(method, count)({ ...busyAnchor, deadlineAtMs: Date.now() + 60_000,
        onCycle: () => { assert(!returned, "callback after synchronous throw returned"); callbacks++; throw sentinel; } }),
      error => error === sentinel);
      returned = true;
      assert.equal(callbacks, 1, "callback exception must stop further delivery immediately");
      await yieldToCallbacks();
      assert.equal(callbacks, 1, "no queued callbacks may escape after an exception");
      compare(multiAnchor, `fresh enumeration after throwing ${method}/${count}`, [count]);
    }
    for (const engine of [reference(method), ...threadCounts.map(count => native(method, count))]) {
      let calls = 0;
      let returned = false;
      const deadlineAtMs = Date.now() + 100;
      const result = engine({ ...busyAnchor, deadlineAtMs, onCycle() {
        assert(!returned, "callback after deadline result returned");
        calls++;
        // Deliberately charge real wall time; mocking Date.now would not test a native deadline.
        if (calls === 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, deadlineAtMs - Date.now()) + 5);
      } });
      assert(calls > 0, "the tiny warm fixture must reach its callback before the deadline");
      assert.equal(result.deadlineHit, true, "callback cost is part of the caller's budget");
      assert.equal(result.closed, calls);
      returned = true;
      const settledCalls = calls;
      await yieldToCallbacks();
      assert.equal(calls, settledCalls, "no worker callback may escape after timeout returns");
    }
    compare(multiAnchor, `healthy after all deadline cancellations ${method}`);
  }
}

test("Rust parallel deadline/throw/scratch cancellation drains workers and subsequent calls stay healthy", () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--parallel-cancellation-child"], {
    env: { ...process.env, SEARCHER_TEST_DISABLE_DOTENV: "1" }, encoding: "utf8", timeout: 20_000,
    killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(child.error, undefined, `cancellation child exceeded its bound: ${child.error?.message}`);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /parallel cancellation checks: PASS/);
});

function frozenEffectiveInput() {
  const saved = JSON.parse(readFileSync(new URL("./fixtures/blockscan-effective-26029875.json", import.meta.url), "utf8")) as {
    sourceBlock: number; rows: { edge: TokenEdge; quote: { amountIn: string; amountOut: string; mid: number } | null }[];
  };
  assert.equal(saved.sourceBlock, 26029875);
  const edges = saved.rows.map(row => row.edge), mids = new Map<string, ResolvedBlockScanMid>();
  for (const { edge, quote: effective } of saved.rows) if (effective) mids.set(blockScanEdgeKey(edge), {
    kind: "historical-effective", pool: edge.target, edges: [edge], mid: effective.mid, feeBps: 0, depthProxy: 0,
    quoteAmountIn: BigInt(effective.amountIn), quoteAmountOut: BigInt(effective.amountOut),
  });
  const unit = 10n ** 18n;
  const pricedTokens = new Map([[ADDR.WETH.toLowerCase(), { maxBorrow: 2000n * unit }],
    [ADDR.USDC.toLowerCase(), { maxBorrow: 5_000_000n * 10n ** 6n }],
    [ADDR.USDT.toLowerCase(), { maxBorrow: 5_000_000n * 10n ** 6n }],
    [ADDR.DAI.toLowerCase(), { maxBorrow: 5_000_000n * unit }]]);
  return { edges, mids, sourceBlock: saved.sourceBlock, pricedTokens };
}

test("Rust matches the real frozen effective table, not raw mids or reconstructed prices", () => {
  const { edges, mids, sourceBlock } = frozenEffectiveInput();
  for (const allowRepeatedPools of [false, true]) {
    const view = buildBlockScanUsdView(edges, mids, 50, allowRepeatedPools);
    assert(view.quotes.length > 0 && view.signals.length > 0);
    for (const prefix of [{ prefixPruningEnabled: false, maxPrefixDrawdownBps: 1000 },
      ...[0, 1000].map(maxPrefixDrawdownBps => ({ prefixPruningEnabled: true, maxPrefixDrawdownBps }))]) {
      compare(scenario(view.quotes, view.signals, { ...prefix, allowRepeatedPools,
        funding: [ADDR.WETH, ADDR.USDC, ADDR.USDT, ADDR.DAI].map(token => token.toLowerCase()), minSpreadBps: 50,
      }), `frozen effective ${sourceBlock}, reuse ${allowRepeatedPools}, ${JSON.stringify(prefix)}`);
    }
  }
});

function compareScanner(input: Parameters<typeof scanBlockStateFromResolvedMids>[0], label: string) {
  const run = (enumerationBackend: "typescript" | "rust", rustEnumerationThreads?: number) => {
    const result = scanBlockStateFromResolvedMids({ ...input, captureCoarseEnumeration: true,
      cfg: { ...input.cfg, hopTokensPerStep: 0, enumerationBackend, rustEnumerationThreads, budgetMs: 60_000 } });
    assert.equal(result.outcome, "ran", `${label}: scanner must complete`);
    assert(result.enumeration);
    const { backend, ...enumeration } = result.enumeration;
    assert.equal(backend, enumerationBackend);
    assert.equal(result.selection.forcedSelectionCount, 0);
    return { ...result, enumeration };
  };
  const expected = run("typescript");
  // Only the declared engine tag is excluded. Ordered pre-cap rows, final ranks,
  // P/maxBorrow, rotation choice, selection counters and all other stats must match.
  for (const count of threadCounts) {
    if (BLOCKSCAN_ENUMERATION_DEFAULTS.rustEnabled)
      assert.deepEqual(run("rust", count), expected, `${label}: ${count} threads`);
    else assert.throws(() => run("rust", count), /Rust enumeration is disabled/,
      `${label}: production switch blocks ${count} native threads`);
  }
  return expected;
}

test("Rust scanner respects the production disable switch, or preserves ranking when enabled", () => {
  const { edges, mids, sourceBlock, pricedTokens } = frozenEffectiveInput();
  for (const enumerationMethod of methods) for (const allowRepeatedPools of [false, true]) {
    for (const deduplicateRotations of [false, true]) for (const maxPrefixDrawdownBps of [undefined, 0, 1000]) {
      const cfg: BlockScanCoreConfig = { enumerationMethod, allowRepeatedPools, deduplicateRotations,
        prefixPruningEnabled: maxPrefixDrawdownBps !== undefined, maxPrefixDrawdownBps,
        maxHops: 6, minSpreadBps: 50, exactAdmissionSpreadBps: 50,
        usdSignalPairsPerToken: 50, pricedTokens, maxCandidates: 100, budgetMs: 60_000 };
      const result = compareScanner({ edges, mids, sourceBlock, swapTouched: null, cfg },
        `frozen scanner ${enumerationMethod}, reuse ${allowRepeatedPools}, dedup ${deduplicateRotations}, prefix ${maxPrefixDrawdownBps}`);
      if (allowRepeatedPools && maxPrefixDrawdownBps === undefined) {
        assert.equal(result.opportunities.length, Math.min(cfg.maxCandidates,result.selection.enumeratedCount));
        assert(result.opportunities.some(o=>new Set(o.seedEdges.map(e=>e.tokenIn.toLowerCase())).size<o.seedEdges.length),
          "bounded repeated-token walks participate in the same capped ranking");
      }
    }
  }
  for (const enumerationMethod of methods) for (const maxHops of [2, 4, 8]) {
    compareScanner({ edges, mids, sourceBlock, swapTouched: new Set(), cfg: {
      enumerationMethod, maxHops, allowRepeatedPools: false, deduplicateRotations: true,
      minSpreadBps: 0, exactAdmissionSpreadBps: 200, maxCandidates: 3,
      usdSignalPairsPerToken: 1, pricedTokens, budgetMs: 60_000,
    } }, `non-default scanner cap/hops/signals/admission, ${enumerationMethod}/${maxHops}`);
  }
});

test("Rust scanner retains deterministic ordering and cap on exactly equal spread/rank", () => {
  const weth = ADDR.WETH.toLowerCase(), unit = 10n ** 18n;
  const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
  const edges: TokenEdge[] = [3, 1, 2].flatMap(n => [[weth, address(n)], [address(n), weth]].map(([tokenIn, tokenOut], i) => ({
    tokenIn: tokenIn!, tokenOut: tokenOut!, target: address(n * 10 + i), adapterId: "test-swap", slotKind: "swap" as const,
    ...deriveEdgeTaxonomy("swap"),
  })));
  const mids = new Map<string, ResolvedBlockScanMid>(edges.map((edge, i) => [blockScanEdgeKey(edge), {
    kind: "test", pool: edge.target, edges: [edge], mid: i % 2 ? 1.1 : 1, feeBps: 0, depthProxy: 0,
    quoteAmountIn: unit, quoteAmountOut: i % 2 ? 11n * unit / 10n : unit,
  }]));
  for (const enumerationMethod of methods) for (const maxCandidates of [1, 2, 100]) {
    const result = compareScanner({ edges, mids, sourceBlock: 1, swapTouched: null, cfg: {
      enumerationMethod, maxCandidates, maxHops: 2, minSpreadBps: 0, budgetMs: 60_000,
      allowRepeatedPools: false, deduplicateRotations: true,
      pricedTokens: new Map([[weth, { maxBorrow: 100n * unit }]]),
    } }, `equal scanner ranking, ${enumerationMethod}, cap ${maxCandidates}`);
    assert.equal(result.selection.enumeratedCount, 3);
    assert.equal(result.opportunities.length, Math.min(3, maxCandidates));
    assert.equal(new Set(result.coarseEnumeration!.map(row => row.coarseSpreadBps)).size, 1);
  }
});
