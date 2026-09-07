/** Offline same-input scanner equivalence and CPU measurements. No RPC. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  scanBlockStateFromResolvedMids as scan,
  type ResolvedBlockScanMid,
} from "../detector/blockscan-scanner-core.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import { createRouteImmutableBinding } from "../venues/route-immutable-binding.js";

const baselinePath = process.argv[process.argv.indexOf("--baseline-core") + 1];
const baseline: typeof scan | null = process.argv.includes("--baseline-core")
  ? (await import(pathToFileURL(baselinePath).href)).scanBlockStateFromResolvedMids
  : null;
const WETH = ADDR.WETH.toLowerCase();
const USDC = ADDR.USDC.toLowerCase();
const address = (id: number) => `0x${id.toString(16).padStart(40, "0")}`;
const UNIT = 10n ** 18n;
type Input = Parameters<typeof scan>[0];

function edge(from: string, to: string, id: number, protocol = false): TokenEdge {
  return {
    adapterId: protocol ? "erc4626-redeem" : "univ2-swap",
    target: address(1_000_000 + id), tokenIn: from, tokenOut: to,
    slotKind: protocol ? "protocol" : "swap",
    protocolAction: protocol ? "redeem" : undefined,
    ...deriveEdgeTaxonomy(protocol ? "protocol" : "swap", protocol ? "redeem" : undefined),
    score: id % 7,
  };
}

function inputFor(edges: TokenEdge[], seed = 1): Input {
  const mids = new Map<string, ResolvedBlockScanMid>();
  for (const [index, value] of edges.entries()) {
    const mid = 1 + (((index * 17 + seed * 7) % 19) - 8) / 100;
    mids.set(blockScanEdgeKey(value), {
      kind: "test", pool: value.target, edges: [value], mid,
      feeBps: index % 4, reserveA: 10_000n * UNIT,
      reserveB: BigInt(Math.round(mid * 10_000)) * UNIT, depthProxy: 10_000,
    });
  }
  return {
    edges, sourceBlock: 100, swapTouched: null, mids,
    cfg: { maxHops: 6, minSpreadBps: 10, maxCandidates: 512,
      budgetMs: 120_000, pricedTokens: new Map([
        [WETH, { maxBorrow: 100n * UNIT }], [USDC, { maxBorrow: 100n * UNIT }],
      ]) },
  };
}

function mutableCopy(input: Input): Input {
  const edges = input.edges.map(value => ({ ...value }));
  const { edgeEligible, routeEligible } = input;
  if (edgeEligible === undefined && routeEligible === undefined) return { ...input, edges };
  // Copying the topology must not change identity-based callback decisions.
  const originals = new Map(edges.map((copy, index) => [copy, input.edges[index]]));
  const original = (copy: TokenEdge): TokenEdge => {
    const value = originals.get(copy);
    assert(value, "fallback callback received an edge outside the copied topology");
    return value;
  };
  return {
    ...input, edges,
    ...(edgeEligible === undefined ? {} : {
      edgeEligible: (value: TokenEdge) => edgeEligible(original(value)),
    }),
    ...(routeEligible === undefined ? {} : {
      routeEligible: (path: readonly TokenEdge[]) => routeEligible(path.map(original)),
    }),
  };
}

// The callbacks see original identities, preserving route order and repeats.
{
  const first = Object.freeze(edge(WETH, USDC, 900));
  const second = Object.freeze(edge(USDC, WETH, 901));
  const seenEdges: TokenEdge[] = [];
  const routes: TokenEdge[][] = [];
  const copied = mutableCopy({
    ...inputFor([first, second]),
    edgeEligible: value => { seenEdges.push(value); return value !== first; },
    routeEligible: path => { routes.push([...path]); return path[0] === first; },
  });
  assert.notStrictEqual(copied.edges[0], first);
  assert.deepEqual(copied.edges.map(value => copied.edgeEligible!(value)), [false, true]);
  assert.strictEqual(seenEdges[0], first);
  assert.strictEqual(seenEdges[1], second);
  assert.equal(copied.routeEligible!([copied.edges[0], copied.edges[1], copied.edges[0]]), true);
  assert.equal(copied.routeEligible!([copied.edges[1], copied.edges[0]]), false);
  for (const [index, expected] of [first, second, first].entries()) {
    assert.strictEqual(routes[0][index], expected);
  }
  assert.strictEqual(routes[1][0], second);
  assert.strictEqual(routes[1][1], first);
}

let comparisons = 0;
function check(input: Input): ReturnType<typeof scan> {
  const expected = baseline ? baseline(input) : scan(mutableCopy(input));
  assert.equal(expected.outcome, "ran", "equivalence input must complete without censoring");
  const cold = scan(input);
  const warm = scan({ ...input, edges: [...input.edges] });
  assert.deepEqual(cold, expected);
  assert.deepEqual(warm, expected, "same edge objects in a fresh array must be equivalent");
  comparisons++;
  return warm;
}

// Repeated-token/protocol controls, multiple anchors, case normalization,
// stable ties, mutable caller input, changing eligibility, and current mids.
for (let seed = 0; seed < 12; seed++) {
  const tokens = [WETH, USDC, ...Array.from({ length: 4 }, (_, i) => address(i + 1))];
  const edges: TokenEdge[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = 0; j < tokens.length; j++) {
      if (i === j || (i * 3 + j + seed) % 3 === 0) continue;
      edges.push(Object.freeze(edge(tokens[i], tokens[j], edges.length + seed * 100,
        (i + j + seed) % 4 === 0)));
    }
  }
  const input = inputFor(edges, seed);
  check(input);
  check({ ...input, swapTouched: new Set([edges[seed % edges.length].target]) });
  check({ ...input, edgeEligible: value => value !== edges[seed % edges.length] });
  check({ ...input, routeEligible: path => path.length !== 3 });
  check({ ...input, routeEligible: path => !path.includes(edges[seed % edges.length]) });
  const mids = new Map(input.mids);
  const key = blockScanEdgeKey(edges[0]);
  mids.set(key, { ...mids.get(key)!, mid: 1.5, feeBps: 37 });
  check({ ...input, sourceBlock: 101, mids });
  mids.delete(key);
  check({ ...input, sourceBlock: 102, mids });
  check({ ...input, edges: [...edges].reverse() });
}

const a = address(41), b = address(42), c = address(43);
const repeat = [edge(WETH, a, 401), edge(a, b, 402, true),
  edge(b, a, 403), edge(a, WETH, 404)];
const repeatInput = inputFor(repeat.map(value => Object.freeze(value)));
repeatInput.mids = new Map([...repeatInput.mids].map(([key, value]) =>
  [key, { ...value, mid: 1.02 }]));
assert(check(repeatInput).opportunities.some(route => route.seedEdges.length === 4),
  "a non-funded repeated token enclosing a protocol leg remains admissible");
const swapOnly = inputFor(repeat.map(value => ({ ...value, slotKind: "swap",
  protocolAction: undefined, edgeKind: "swap" })));
assert(!check(swapOnly).opportunities.some(route => route.seedEdges.length === 4));
const thirdVisit = inputFor([...repeat.slice(0, 3), edge(a, c, 405, true),
  edge(c, a, 406), repeat[3]]);
assert(!check(thirdVisit).opportunities.some(route => route.seedEdges.length === 6));

const mutable = inputFor([edge(WETH, a, 501), edge(a, WETH, 502)]);
check(mutable);
mutable.edges[0].score = 777;
check(mutable);
mutable.edges.reverse();
check(mutable);

// A shallow-frozen edge is not sufficient: nested caller-owned binding/key
// objects remain mutable and must never qualify for persistent index reuse.
const binding = { ...createRouteImmutableBinding("test:v1", "0x1234") };
const bound = inputFor([Object.freeze({ ...edge(WETH, a, 601), routeBinding: binding }),
  Object.freeze(edge(a, WETH, 602))]);
check(bound);
binding.payload = "0x5678";
assert.throws(() => scan(bound), /binding hash mismatch/);

const v4PoolKey = { currency0: WETH, currency1: a, fee: 3000, tickSpacing: 60,
  hooks: address(0) };
const nested = inputFor([Object.freeze({ ...edge(WETH, a, 701), v4PoolKey }),
  Object.freeze(edge(a, WETH, 702))]);
check(nested);
v4PoolKey.fee = 500;
check(nested);

// Many non-funded touched anchors must not multiply a dense whole-graph
// matrix without bound. Count all typed-array allocations, including slices.
const sparseEdges = Array.from({ length: 20_128 }, (_, i) => Object.freeze(
  edge(address(200_000 + i), address(300_000 + i), 300_000 + i),
));
const sparse = { ...inputFor(sparseEdges),
  swapTouched: new Set(sparseEdges.slice(0, 128).map(value => value.target)) };
const expectedSparse = baseline ? baseline(sparse) : scan(mutableCopy(sparse));
assert.equal(expectedSparse.outcome, "ran");
const OriginalFloat64Array = globalThis.Float64Array;
let denseAllocatedBytes = 0;
const denseAllocationPerScan: number[] = [];
globalThis.Float64Array = class extends OriginalFloat64Array {
  constructor(length: number) {
    super(length);
    denseAllocatedBytes += this.byteLength;
  }
} as Float64ArrayConstructor;
try {
  for (const input of [sparse, { ...sparse, edges: [...sparse.edges] }]) {
    const before = denseAllocatedBytes;
    assert.deepEqual(scan(input), expectedSparse);
    const allocated = denseAllocatedBytes - before;
    denseAllocationPerScan.push(allocated);
    assert(allocated > 0);
    assert(allocated <= 8 * 1024 * 1024,
      `each scan must allocate at most 8 MiB dense, got ${allocated}`);
  }
  comparisons++;
} finally {
  globalThis.Float64Array = OriginalFloat64Array;
}

// Large fixed graph: dead-end exits plus two/six-hop positive and negative
// controls. Alternate A/B order; every timed scan must finish and match fully.
const large: TokenEdge[] = Array.from({ length: 55_000 }, (_, i) =>
  Object.freeze(edge(WETH, address(i + 10_000), i + 10_000)));
for (let i = 0; i < 96; i++) {
  const tokens = [WETH, ...Array.from({ length: i % 2 === 0 ? 1 : 5 },
    (_, j) => address(100_000 + i * 5 + j)), WETH];
  for (let j = 0; j < tokens.length - 1; j++) {
    large.push(Object.freeze(edge(tokens[j], tokens[j + 1], 100_000 + i * 6 + j,
      j === 2)));
  }
}
const largeInput = inputFor(large);
const expectedLarge = check(largeInput);
const timings = { baseline: [] as number[], candidate: [] as number[] };
const memoryBefore = process.memoryUsage();
for (let round = 0; round < 12; round++) {
  for (const name of (round % 2 === 0
    ? ["baseline", "candidate"] : ["candidate", "baseline"]) as (keyof typeof timings)[]) {
    const implementation = name === "baseline" ? baseline : scan;
    if (implementation === null) continue;
    const start = performance.now();
    const actual = implementation({ ...largeInput, edges: [...largeInput.edges] });
    timings[name].push(performance.now() - start);
    assert.deepEqual(actual, expectedLarge);
  }
}
const summary = (values: number[]) => {
  const sorted = [...values].sort((x, y) => x - y);
  return { n: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1] ?? null,
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] ?? null };
};
console.log(JSON.stringify({ test: "scanner-index", status: "PASS", comparisons,
  externalBaseline: baselinePath && baseline !== null ? baselinePath : null,
  largeEdges: large.length, largeSelection: expectedLarge.selection,
  outputSha256: createHash("sha256").update(JSON.stringify(expectedLarge,
    (_, value) => typeof value === "bigint" ? value.toString() : value)).digest("hex"),
  timings: { baseline: summary(timings.baseline), candidate: summary(timings.candidate) },
  denseTouchedAllocationBytes: denseAllocatedBytes,
  denseAllocationPerScan,
  memoryDeltaBytes: Object.fromEntries(Object.entries(process.memoryUsage()).map(
    ([key, value]) => [key, value - memoryBefore[key as keyof typeof memoryBefore]],
  )),
  caveat: "synthetic same-input CPU comparison; not a live/full-pipeline latency verdict",
}));
