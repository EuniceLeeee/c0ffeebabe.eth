import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  TokenToWethReferenceCache,
  gasReferenceInput,
  tokenToWethReferences,
  type RawTokenRate,
} from "../blockscan-amount-reference.js";
import type { BlockScanStateSnapshot } from "../blockscan-state-coordinator.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type { StrictPricingPublication } from "../strict-current-runtime-coordinator.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import type { RouteVenueMid } from "../venues/mid-readers.js";

// Standalone, deterministic, no backend: node --import tsx src/searcher/test/blockscan-token-valuation-cache.ts
const W = "weth";
const hash = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;
type Marks = ReadonlyMap<string, RawTokenRate>;
type Row = readonly [TokenEdge, number, number?];
type Delta = Extract<StrictPricingPublication, { kind: "delta" }>;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function edge(from: string, to: string, id: string, instance = id): TokenEdge {
  return Object.freeze({
    tokenIn: from, tokenOut: to, adapterId: "fixture-swap", target: instance,
    instanceKey: instance, executionVariantKey: id,
    canonicalEdgeId: id as TokenEdge["canonicalEdgeId"],
    slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false,
  });
}

function mid([e, value, feeBps = 0]: Row): RouteVenueMid {
  return Object.freeze({
    kind: "external-swap", pool: e.target, edges: [e], mid: value, feeBps, depthProxy: 1,
  });
}

// Full snapshot casts keep fixtures independent of unrelated runtime authority fields.
// The fingerprint contains ONLY static graph semantics, just like the publisher.
function snapshot(
  n: number,
  edges: readonly TokenEdge[],
  mids: ReadonlyMap<string, RouteVenueMid>,
  anchor: { generation?: number; sourceBlockHash?: string } = {},
): BlockScanStateSnapshot {
  const source = { sourceBlock: n, sourceBlockHash: anchor.sourceBlockHash ?? hash(n), generation: anchor.generation ?? n };
  const keys = edges.map(blockScanEdgeKey);
  assert.equal(new Set(keys).size, keys.length, "fixture edge IDs must be unique");
  assert([...mids.keys()].every(key => keys.includes(key)), "fixture mids must belong to static topology");
  const resolved = keys.filter(key => mids.has(key));
  const unavailable = keys.filter(key => !mids.has(key));
  const graph = Object.freeze({
    ...source, edges,
    orderedEdgeHash: digest(keys), metadataHash: digest(edges),
    ownershipHash: digest(edges.map(e => [e.adapterId, e.instanceKey, e.executionVariantKey])),
    scannerEdgeCount: keys.length, scannerEdgeKeyHash: digest([...keys].sort()),
  });
  return Object.freeze({
    ...source, graph, mids,
    coverage: Object.freeze({
      expectedEdgeKeys: keys, resolvedEdgeKeys: resolved,
      unavailableEdgeKeys: unavailable, unresolvedEdgeKeys: [],
      expectedEdgeKeyHash: graph.scannerEdgeKeyHash,
      resolvedEdgeKeyHash: digest(resolved), unavailableEdgeKeyHash: digest(unavailable),
    }),
    coverageByEdgeKey: new Map(keys.map(key => [key,
      mids.has(key) ? { status: "resolved" } : { status: "unavailable", reason: "fixture" },
    ])),
  }) as unknown as BlockScanStateSnapshot;
}

function fixture(n: number, edges: readonly TokenEdge[], rows: readonly Row[], anchor?: Parameters<typeof snapshot>[3]) {
  return snapshot(n, edges, new Map(rows.map(row => [blockScanEdgeKey(row[0]), mid(row)])), anchor);
}

function next(previous: BlockScanStateSnapshot, rows: readonly Row[] = [], removals: readonly TokenEdge[] = []) {
  const mids = rows.length || removals.length ? new Map(previous.mids) : previous.mids;
  if (mids instanceof Map && (rows.length || removals.length)) {
    for (const e of removals) mids.delete(blockScanEdgeKey(e));
    for (const row of rows) mids.set(blockScanEdgeKey(row[0]), mid(row));
  }
  return snapshot(previous.sourceBlock + 1, previous.graph.edges, mids, { generation: previous.generation + 1 });
}

function fingerprint(p: BlockScanStateSnapshot): string {
  const g = p.graph;
  return [g.orderedEdgeHash, g.metadataHash, g.ownershipHash, String(g.scannerEdgeCount), g.scannerEdgeKeyHash].join("\u001f");
}

function baseline(p: BlockScanStateSnapshot): StrictPricingPublication {
  return { kind: "baseline", graphFingerprint: fingerprint(p), snapshot: p };
}

function delta(previous: BlockScanStateSnapshot, current: BlockScanStateSnapshot): Delta {
  // Every availability loss is a removal; every recovery or changed row is an update.
  // No coverage change is hidden behind an empty delta.
  return {
    kind: "delta", graphFingerprint: fingerprint(current), snapshot: current,
    previousGeneration: previous.generation, previousSourceBlock: previous.sourceBlock,
    previousSourceBlockHash: previous.sourceBlockHash,
    updates: [...current.mids].filter(([key, row]) => previous.mids.get(key) !== row),
    removals: [...previous.mids.keys()].filter(key => !current.mids.has(key)),
  };
}

function equalRate(actual: RawTokenRate | undefined, expected: RawTokenRate, label: string): void {
  assert(actual, `${label}: missing mark`);
  assert(actual.num > 0n && actual.den > 0n, `${label}: nonpositive rational`);
  assert.equal(actual.num * expected.den, expected.num * actual.den, `${label}: rational mismatch`);
}

function equalMarks(actual: Marks, expected: Marks, label: string): void {
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), `${label}: token membership`);
  for (const [token, want] of expected) {
    const got = actual.get(token)!;
    equalRate(got, want, `${label}/${token}`);
    for (const [gas, spread] of [[1n, 0.125], [123456789012345n, 37.5], [10n ** 20n, 200]] as const) {
      assert.equal(gasReferenceInput(gas, got, spread), gasReferenceInput(gas, want, spread),
        `${label}/${token}: exact gas input at ${gas}/${spread}`);
    }
  }
}

function parity(cache: TokenToWethReferenceCache, p: BlockScanStateSnapshot, label: string): Marks {
  const actual = cache.get(p);
  equalMarks(actual, tokenToWethReferences(p, W), label);
  return actual;
}

function copyMarks(marks: Marks): Marks {
  return new Map([...marks].map(([key, rate]) => [key, { ...rate }]));
}

function work(cache: TokenToWethReferenceCache) {
  const { fullBuilds, updatedEdges, recomputedPairs, recomputedTokens } = cache.stats;
  return { fullBuilds, updatedEdges, recomputedPairs, recomputedTokens };
}

// Guard saved arrays AND saved row objects, so retaining a baseline reference cannot
// evade the test. With allowedKeys set, even Map iteration/keys/values is forbidden.
function guarded(p: BlockScanStateSnapshot) {
  const guard: { armed: boolean; allowedKeys: ReadonlySet<string> } = { armed: false, allowedKeys: new Set() };
  const fail = (what: string): never => { throw new Error(`forbidden full-snapshot access: ${what}`); };
  const edges = new Proxy(p.graph.edges, {
    get(target, property, receiver) {
      if (guard.armed) fail(`graph.edges.${String(property)}`);
      return Reflect.get(target, property, receiver);
    },
    ownKeys(target) { if (guard.armed) fail("graph.edges ownKeys"); return Reflect.ownKeys(target); },
  });
  const rows = new Map([...p.mids].map(([key, value]) => [key, new Proxy({ ...value }, {
    get(target, property, receiver) {
      if (guard.armed && !guard.allowedKeys.has(key)) fail(`untouched mid row ${key}.${String(property)}`);
      return Reflect.get(target, property, receiver);
    },
  })]));
  const mids = new Proxy(rows, {
    get(target, property) {
      if (property === "get" || property === "has") return (key: string) => {
        if (guard.armed && !guard.allowedKeys.has(key)) fail(`untouched mids.${String(property)}(${key})`);
        return property === "get" ? target.get(key) : target.has(key);
      };
      if (guard.armed && property !== "size") fail(`mids.${String(property)}`);
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const graph = { ...p.graph };
  Object.defineProperty(graph, "edges", { get() {
    if (guard.armed) fail("graph.edges");
    return edges;
  } });
  return { snapshot: { ...p, graph, mids } as BlockScanStateSnapshot, arm(keys: readonly string[] = []) {
    guard.allowedKeys = new Set(keys);
    guard.armed = true;
  } };
}

function publishGuarded(cache: TokenToWethReferenceCache, previous: BlockScanStateSnapshot, current: BlockScanStateSnapshot) {
  const publication = delta(previous, current);
  const protectedCurrent = guarded(current);
  protectedCurrent.arm(publication.updates.map(([key]) => key));
  cache.observe({ ...publication, snapshot: protectedCurrent.snapshot });
  const marks = cache.get(protectedCurrent.snapshot);
  equalMarks(marks, tokenToWethReferences(current, W), `guarded block ${current.sourceBlock}`);
  return { marks, pricing: protectedCurrent.snapshot };
}

test("baseline matches the oracle: raw units, fees once, case, direction, invalid rows and extreme rationals", () => {
  const cache = new TokenToWethReferenceCache("WETH");
  const rows: Row[] = [
    [edge("USDC", "WETH", "raw"), 5e8], [edge("fee", W, "fee"), 100, 100],
    [edge("fractional", W, "fractional"), 8, 12.5],
    [edge("tiny", W, "tiny"), 1e-300], [edge("tinier", "tiny", "tinier"), 1e-100],
    [edge("huge", W, "huge"), 1e300], [edge("huge2", "huge", "huge2"), 1e100],
    [edge(W, "reverse-only", "reverse"), 10], [edge(W, W, "self"), 200],
    [edge("island", "unpriced", "island"), 2],
    [{ ...edge("standing", W, "standing"), leavesStandingPosition: true }, 10],
  ];
  for (const [i, [value, fee]] of [[0, 0], [-1, 0], [NaN, 0], [Infinity, 0],
    [1, -1], [1, 10000], [1, Infinity], [1, NaN]].entries()) {
    rows.push([edge(`invalid-${i}`, W, `invalid-${i}`), value!, fee!]);
  }
  const unavailable = edge("unavailable", W, "unavailable");
  const p = fixture(1, [...rows.map(([e]) => e), unavailable], rows);
  cache.observe(baseline(p));
  const marks = parity(cache, p, "baseline");
  assert.deepEqual([...marks.keys()].sort(), [W, "usdc", "fee", "fractional", "tiny", "tinier", "huge", "huge2"].sort());
  equalRate(marks.get("fee"), { num: 99n, den: 1n }, "fee once");
  equalRate(marks.get("fractional"), { num: 799n, den: 100n }, "fractional fee");
  equalRate(marks.get("tinier"), { num: 1n, den: 10n ** 400n }, "no underflow");
  equalRate(marks.get("huge2"), { num: 10n ** 400n, den: 1n }, "no overflow");
  assert.equal(gasReferenceInput(100_000_000_000_000n, marks.get("usdc")!, 200), 10_000_001n);
  assert.equal(cache.stats.fullBuilds, 1);
  const empty = fixture(1, [], []);
  const emptyCache = new TokenToWethReferenceCache(W);
  emptyCache.observe(baseline(empty));
  equalMarks(parity(emptyCache, empty, "empty"), new Map([[W, { num: 1n, den: 1n }]]), "WETH always 1");
});

test("one-edge increases, decreases and fees propagate through three hops; retained outputs stay unchanged", () => {
  const a = edge("a", W, "a"), b = edge("b", "a", "b"), c = edge("c", "b", "c"), d = edge("d", "c", "d");
  let p = fixture(10, [a, b, c, d], [[a, 2], [b, 3], [c, 5], [d, 7]]);
  const cache = new TokenToWethReferenceCache(W);
  cache.observe(baseline(p));
  const retained: { actual: Marks; copy: Marks }[] = [];
  for (const row of [[a, 10], [a, 0.25], [a, 0.25, 9000], [a, 7, 12.5], [a, 7, 0]] as Row[]) {
    const old = parity(cache, p, "before update");
    retained.push({ actual: old, copy: copyMarks(old) });
    const current = next(p, [row]);
    cache.observe(delta(p, current));
    const marks = parity(cache, current, `edge/fee ${row[1]}/${row[2] ?? 0}`);
    assert(!marks.has("d"), "four hops must remain unavailable");
    for (const previous of retained) assert.deepEqual(previous.actual, previous.copy, "returned maps and rate objects must not mutate");
    p = current;
  }
  assert.equal(cache.stats.fullBuilds, 1, "valid deltas must stay incremental");
});

test("best execution variant and instance survive incremental updates and removals", () => {
  const lo = edge("a", W, "lo", "same"), hi = edge("a", W, "hi", "same");
  const two = edge("a", W, "two"), three = edge("a", W, "three"), four = edge("a", W, "four");
  const parent = edge("parent", "a", "parent");
  let p = fixture(20, [lo, hi, two, three, four, parent], [[lo, 1], [hi, 100], [two, 4], [three, 9], [four, 20], [parent, 3]]);
  const cache = new TokenToWethReferenceCache(W);
  cache.observe(baseline(p));
  equalRate(parity(cache, p, "four instances").get("a"), { num: 100n, den: 1n }, "best variant across all instances");
  const transitions: [Row[], TokenEdge[], bigint][] = [
    [[[hi, 200]], [], 200n], [[[lo, 8]], [], 200n], [[], [lo], 200n], [[], [hi], 20n],
    [[], [four], 9n], [[[lo, 2]], [], 9n], [[[two, 4, 7500]], [], 9n],
    [[], [three], 2n], [[[two, 12, 7500]], [], 3n],
  ];
  for (const [updates, removals, expected] of transitions) {
    const current = next(p, updates, removals);
    cache.observe(delta(p, current));
    equalRate(parity(cache, current, `variant block ${current.sourceBlock}`).get("a"), { num: expected, den: 1n }, "best net-fee rate");
    p = current;
  }
  assert.equal(cache.stats.fullBuilds, 1);
});

test("unavailable edges recover; shorter paths appear/disappear and change the three-hop boundary", () => {
  const a = edge("a", "b", "a-b"), b = edge("b", W, "b-w");
  const direct = edge("a", W, "direct"), c = edge("c", "a", "c-a"), d = edge("d", "c", "d-c");
  let p = fixture(30, [a, b, direct, c, d], [[a, 3], [b, 2], [c, 5], [d, 7]]);
  const cache = new TokenToWethReferenceCache(W);
  cache.observe(baseline(p));
  let marks = parity(cache, p, "initial longer path");
  equalRate(marks.get("c"), { num: 30n, den: 1n }, "third hop");
  assert(!marks.has("d"));
  const changes: [Row[], TokenEdge[]][] = [
    [[[direct, 0.25]], []], [[], [direct]], [[], [b]], [[[b, 4]], []],
    [[[direct, 1000]], []], [[], [a]], [[], [direct]], [[[a, 2], [direct, 0.5]], []],
  ];
  for (const [updates, removals] of changes) {
    const current = next(p, updates, removals);
    assert.equal(fingerprint(current), fingerprint(p), "availability is not topology");
    marks = publishGuarded(cache, p, current).marks;
    if (current.mids.has("direct")) assert(marks.has("d"), "new shortest path brings d inside three hops");
    else assert(!marks.has("d"), "loss of shorter path removes d");
    p = current;
  }
  assert.equal(cache.stats.fullBuilds, 1);
});

test("equal-hop alternatives use the best rate and cycles cannot amplify a shortest path", () => {
  const aw = edge("a", W, "aw"), bw = edge("b", W, "bw");
  const ca = edge("c", "a", "ca"), cb = edge("c", "b", "cb"), ac = edge("a", "c", "ac");
  const dc = edge("d", "c", "dc");
  let p = fixture(40, [aw, bw, ca, cb, ac, dc], [[aw, 2], [bw, 3], [ca, 5], [cb, 7], [ac, 10000], [dc, 11]]);
  const cache = new TokenToWethReferenceCache(W);
  cache.observe(baseline(p));
  equalRate(parity(cache, p, "diamond").get("c"), { num: 21n, den: 1n }, "best of two equal-hop paths");
  for (const [updates, removals] of [[[[aw, 20]], []], [[], [bw]], [[[bw, 0.1]], []]] as [Row[], TokenEdge[]][]) {
    const current = next(p, updates, removals);
    publishGuarded(cache, p, current);
    p = current;
  }
  assert.equal(cache.stats.fullBuilds, 1);
});

test("zero-change generations reuse the same output and source mid map; changing gas alone does no valuation work", () => {
  const a = edge("usdc", W, "usdc");
  let p = fixture(50, [a], [[a, 5e8]]);
  const cache = new TokenToWethReferenceCache(W);
  cache.observe(baseline(p));
  const output = parity(cache, p, "initial");
  const before = work(cache), hits = cache.stats.hits;
  for (let i = 0; i < 8; i++) {
    const current = next(p);
    assert.strictEqual(current.mids, p.mids, "publisher can retain one mids map across generations");
    const { marks, pricing } = publishGuarded(cache, p, current);
    assert.strictEqual(marks, output, "unchanged source output must be reused");
    for (const gas of [100_000_000_000_000n, 200_000_000_000_000n, 50_000_000_000_000n]) {
      const reused = cache.get(pricing);
      assert.strictEqual(reused, output);
      assert.equal(gasReferenceInput(gas, reused.get("usdc")!, 200), gas / 10_000_000n + 1n);
    }
    p = current;
  }
  assert.deepEqual(work(cache), before, "no-change publications and gas changes perform no graph/rate work");
  assert(cache.stats.hits > hits);
});

test("cold get before first baseline adopts that same raw snapshot without a second build", () => {
  const a = edge("a", W, "cold");
  const raw = fixture(60, [a], [[a, 2]]);
  const protectedRaw = guarded(raw);
  const cache = new TokenToWethReferenceCache(W);
  const output = cache.get(protectedRaw.snapshot);
  equalMarks(output, tokenToWethReferences(raw, W), "cold get");
  const before = work(cache);
  protectedRaw.arm();
  cache.observe(baseline(protectedRaw.snapshot));
  assert.strictEqual(cache.get(protectedRaw.snapshot), output);
  assert.deepEqual(work(cache), before, "baseline adopts existing index and graph fingerprint");
  publishGuarded(cache, raw, next(raw, [[a, 3]]));
  assert.equal(cache.stats.fullBuilds, 1, "adoption must also permit the following delta");
});

test("valid sparse delta never reads graph.edges, untouched mid maps or saved untouched row objects", () => {
  const a = edge("a", W, "hot"), b = edge("b", "a", "parent"), c = edge("c", "b", "grandparent");
  const unrelated = Array.from({ length: 160 }, (_, i) => edge(`unrelated-${i}`, W, `unrelated-${i}`));
  const raw = fixture(70, [a, b, c, ...unrelated], [[a, 2], [b, 3], [c, 5], ...unrelated.map(e => [e, 7] as Row)]);
  const protectedRaw = guarded(raw);
  const savedEdges = protectedRaw.snapshot.graph.edges;
  const savedUntouchedRow = protectedRaw.snapshot.mids.get("unrelated-0")!;
  const cache = new TokenToWethReferenceCache(W);
  cache.observe(baseline(protectedRaw.snapshot));
  const old = cache.get(protectedRaw.snapshot), oldCopy = copyMarks(old);
  const before = work(cache);
  protectedRaw.arm(["hot"]);
  // Negative controls prove guards remain effective on references saved before arming.
  assert.throws(() => [...savedEdges], /forbidden full-snapshot access/);
  assert.throws(() => savedUntouchedRow.mid, /forbidden full-snapshot access/);
  assert.throws(() => protectedRaw.snapshot.mids.get("unrelated-1"), /forbidden full-snapshot access/);
  const current = next(raw, [[a, 0.125, 125]]);
  publishGuarded(cache, raw, current);
  const after = work(cache);
  assert.equal(after.fullBuilds, before.fullBuilds);
  assert.equal(after.updatedEdges - before.updatedEdges, 1, "exactly one delta edge processed");
  assert.equal(after.recomputedPairs - before.recomputedPairs, 1, "only the changed pair best rate recomputed");
  assert(after.recomputedTokens - before.recomputedTokens > 0);
  assert(after.recomputedTokens - before.recomputedTokens <= 12, "work stays in the <=3-hop dependency neighborhood");
  assert.deepEqual(old, oldCopy);
});

test("baseline reset and topology changes rebuild against the current oracle", () => {
  const a = edge("a", W, "a");
  const first = fixture(80, [a], [[a, 2]]);
  const cache = new TokenToWethReferenceCache(W);
  cache.observe(baseline(first));
  const old = parity(cache, first, "first");
  const reset = next(first, [[a, 9]]);
  cache.observe(baseline(reset));
  parity(cache, reset, "baseline reset");
  assert.equal(cache.stats.fullBuilds, 2);
  const added = edge("b", "a", "new");
  const topology = fixture(82, [a, added], [[a, 4], [added, 3]]);
  cache.observe(delta(reset, topology));
  parity(cache, topology, "topology addition");
  assert.equal(cache.stats.fullBuilds, 3);
  const reversed = { ...a, tokenIn: "renamed", tokenOut: W };
  const semantic = fixture(83, [reversed, added], [[reversed, 7], [added, 3]]);
  assert.notEqual(fingerprint(semantic), fingerprint(topology), "same IDs/count do not hide static metadata changes");
  cache.observe(delta(topology, semantic));
  const marks = parity(cache, semantic, "same IDs different direction");
  assert(!marks.has("a") && !marks.has("b"));
  assert.equal(cache.stats.fullBuilds, 4);
  equalRate(old.get("a"), { num: 2n, den: 1n }, "old baseline output retained");
  publishGuarded(cache, semantic, next(semantic, [[reversed, 8]]));
  assert.equal(cache.stats.fullBuilds, 4, "fallback establishes a usable incremental index");
});

test("lineage mismatches in previous block, hash or generation force independent full fallback", () => {
  for (const mismatch of [
    { previousSourceBlock: 999 }, { previousSourceBlockHash: hash(999) }, { previousGeneration: 999 },
  ]) {
    const a = edge("a", W, "a"), b = edge("b", "a", "b");
    const first = fixture(90, [a, b], [[a, 2], [b, 3]]);
    const current = next(first, [[a, 8]]);
    const cache = new TokenToWethReferenceCache(W);
    cache.observe(baseline(first));
    parity(cache, first, "first");
    cache.observe({ ...delta(first, current), ...mismatch });
    parity(cache, current, `lineage ${Object.keys(mismatch)[0]}`);
    assert.equal(cache.stats.fullBuilds, 2);
    publishGuarded(cache, current, next(current, [[a, 0.2]]));
    assert.equal(cache.stats.fullBuilds, 2);
  }
});

test("missing publication and same-height hash replacement cannot reuse stale marks", () => {
  const a = edge("a", W, "a");
  const first = fixture(100, [a], [[a, 2]]);
  const missing = next(first, [[a, 8]]);
  const cache = new TokenToWethReferenceCache(W);
  cache.observe(baseline(first));
  const old = parity(cache, first, "first"), copy = copyMarks(old);
  parity(cache, missing, "get without publication");
  assert.equal(cache.stats.fullBuilds, 2);
  // Connect a new baseline, then replace its block hash at the same height.
  cache.observe(baseline(missing));
  const beforeReorg = cache.stats.fullBuilds;
  const replacement = fixture(missing.sourceBlock, [a], [[a, 0.25]], {
    sourceBlockHash: hash(9999), generation: missing.generation + 1,
  });
  cache.observe(delta(missing, replacement));
  parity(cache, replacement, "same-height replacement");
  assert.equal(cache.stats.fullBuilds, beforeReorg + 1, "reorg is a fallback even with a matching previous anchor");
  assert.deepEqual(old, copy);
  publishGuarded(cache, replacement, next(replacement, [[a, 6]]));
  assert.equal(cache.stats.fullBuilds, beforeReorg + 1);
});

test("a delta after a missed intermediate publication rebuilds the entire current snapshot", () => {
  const a = edge("a", W, "a"), b = edge("b", W, "b");
  const first = fixture(110, [a, b], [[a, 2], [b, 3]]);
  const missed = next(first, [[a, 50]]);
  const current = next(missed, [[b, 9]]);
  const cache = new TokenToWethReferenceCache(W);
  cache.observe(baseline(first));
  parity(cache, first, "first");
  cache.observe(delta(missed, current));
  equalRate(parity(cache, current, "missed delta").get("a"), { num: 50n, den: 1n }, "missed edge cannot stay stale");
  assert.equal(cache.stats.fullBuilds, 2);
});

test("overlapping previous-source get and evicted stale get never corrupt the latest incremental index", () => {
  const a = edge("a", W, "a"), b = edge("b", "a", "b");
  let p = fixture(120, [a, b], [[a, 2], [b, 3]]);
  const oldest = p;
  const cache = new TokenToWethReferenceCache(W);
  cache.observe(baseline(p));
  const retained: { actual: Marks; copy: Marks }[] = [];
  for (let i = 0; i < 12; i++) {
    const previous = parity(cache, p, `overlap before ${i}`);
    retained.push({ actual: previous, copy: copyMarks(previous) });
    const current = next(p, [[a, i + 3]]);
    cache.observe(delta(p, current));
    // Effective quotations can request the previous published raw after observe(N).
    assert.strictEqual(cache.get(p), previous, "previous source retains its own output");
    parity(cache, current, `overlap current ${i}`);
    p = current;
  }
  assert.equal(cache.stats.fullBuilds, 1);
  parity(cache, oldest, "old get after output cache eviction");
  const before = cache.stats.fullBuilds;
  const latest = publishGuarded(cache, p, next(p, [[a, 0.05]]));
  assert.equal(cache.stats.fullBuilds, before, "stale get cannot roll back the current index");
  equalRate(latest.marks.get("a"), { num: 5n, den: 100n }, "latest rate");
  for (const saved of retained) assert.deepEqual(saved.actual, saved.copy);
});

test("historical output-cache churn cannot evict reuse of the unchanged current working view", () => {
  const a = edge("a", W, "a");
  const current = fixture(150, [a], [[a, 7]]);
  const protectedCurrent = guarded(current);
  const cache = new TokenToWethReferenceCache(W);
  cache.observe(baseline(protectedCurrent.snapshot));
  const output = cache.get(protectedCurrent.snapshot);
  protectedCurrent.arm();
  // These uncached old reads may rebuild their own outputs, but the working
  // index still owns the current view independently of the four-entry history.
  for (let n = 140; n < 145; n++) parity(cache, fixture(n, [a], [[a, n]]), `historical ${n}`);
  const before = work(cache);
  assert.strictEqual(cache.get(protectedCurrent.snapshot), output, "reuse current index even after recent-view eviction");
  assert.deepEqual(work(cache), before, "the exact current snapshot has no bootstrap, topology or lineage miss");
});

test("deterministic random multi-block differential includes complete availability deltas and immutable old outputs", () => {
  for (const seed of [0x6d2b79f5, 0x13579bdf, 0xc0ffee]) {
    let state = seed >>> 0;
    const random = (bound: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return Math.floor((state / 0x1_0000_0000) * bound);
    };
    const tokens = [W, ...Array.from({ length: 18 }, (_, i) => `t${i}`)];
    const edges: TokenEdge[] = [];
    for (let i = 0; i < 72; i++) {
      const from = tokens[random(tokens.length)]!, to = tokens[random(tokens.length)]!;
      const e = edge(from, to, `edge-${i}`, `instance-${i}`);
      edges.push(e);
      if (i % 5 === 0) edges.push(edge(from, to, `variant-${i}`, `instance-${i}`));
    }
    // Always include a directed four-hop chain and initially unavailable shortcuts.
    for (let i = 0; i < 4; i++) edges.push(edge(`chain-${i}`, i === 0 ? W : `chain-${i - 1}`, `chain-edge-${i}`));
    edges.push(edge("chain-3", W, "chain-shortcut"));
    const rates = [0.125, 0.5, 1, 2, 3.75, 11, 5e8, 1e-100, 1e100, 0, -1, NaN, Infinity];
    const fees = [0, 1, 12.5, 100, 2500, 9999, 10000, -1, NaN];
    const randomRow = (e: TokenEdge): Row => [e, rates[random(rates.length)]!, fees[random(fees.length)]!];
    let p = fixture(200, edges, edges.filter(e => e.canonicalEdgeId !== "chain-shortcut" && random(4) !== 0).map(randomRow));
    const cache = new TokenToWethReferenceCache(W);
    cache.observe(baseline(p));
    const retained: { marks: Marks; copy: Marks }[] = [];
    let changedBlocks = 0, noChangeBlocks = 0, removalsSeen = 0, recoveriesSeen = 0;
    for (let block = 0; block < 120; block++) {
      const selected = new Map<string, Row>();
      const removed = new Map<string, TokenEdge>();
      const changes = block % 13 === 0 ? 0 : 1 + random(6);
      for (let i = 0; i < changes; i++) {
        const e = edges[random(edges.length)]!, key = blockScanEdgeKey(e);
        if (random(4) === 0) { removed.set(key, e); selected.delete(key); }
        else { selected.set(key, randomRow(e)); removed.delete(key); }
      }
      const current = next(p, [...selected.values()], [...removed.values()]);
      const publication = delta(p, current);
      assert.equal(publication.graphFingerprint, fingerprint(p), "dynamic mids never change graph fingerprint");
      removalsSeen += publication.removals.length;
      recoveriesSeen += publication.updates.filter(([key]) => !p.mids.has(key)).length;
      if (publication.updates.length || publication.removals.length) changedBlocks++;
      else noChangeBlocks++;
      const { marks } = publishGuarded(cache, p, current);
      if (block % 11 === 0) retained.push({ marks, copy: copyMarks(marks) });
      for (const old of retained) assert.deepEqual(old.marks, old.copy, `seed ${seed}, block ${block}: retained output`);
      p = current;
    }
    assert(changedBlocks > 60 && noChangeBlocks >= 9 && removalsSeen > 0 && recoveriesSeen > 0,
      `seed ${seed}: transition coverage ${JSON.stringify({ changedBlocks, noChangeBlocks, removalsSeen, recoveriesSeen })}`);
    assert.equal(cache.stats.fullBuilds, 1, `seed ${seed}: all 120 complete deltas stay incremental`);
  }
});
