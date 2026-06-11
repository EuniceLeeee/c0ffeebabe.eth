/**
 * Deterministic unit tests for the Stage-2 path-pruning invariants (LR-6).
 * Pure in-memory — no RPC, no anvil, no fork. Sub-second.
 *
 *   AC-2.3  top-N effective : a token with M>N scored edges expands only top-N by score.
 *   AC-2.2  pin invariant   : a score=0 victim-pool edge (and score===undefined backbone)
 *                             survive truncation even when higher-score edges exist.
 *   AC-2.4  perf bound      : a ~3000-edge graph stays bounded (path count + wall).
 */

import { performance } from "node:perf_hooks";
import { buildTokenPaths, type TokenEdge } from "../planner/token-graph.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function edge(tokenIn: string, tokenOut: string, pool: string, score?: number): TokenEdge {
  return { adapterId: "univ2-swap", target: pool, tokenIn, tokenOut, slotKind: "swap", score };
}

/** Build A→X (6 scored out-edges) + each X→A back-edge, so closed loops are A→X→A. */
function fanGraph(): TokenEdge[] {
  const outs: Array<[string, string, number]> = [
    ["B", "pB", 6], ["C", "pC", 5], ["D", "pD", 4],
    ["E", "pE", 3], ["F", "pF", 2], ["G", "pG", 1],
  ];
  const edges: TokenEdge[] = [];
  for (const [tok, pool, score] of outs) {
    edges.push(edge("A", tok, pool, score));
    edges.push(edge(tok, "A", pool, 100)); // back-edge, single out-edge per X (no truncation there)
  }
  return edges;
}

function midTokens(paths: { edges: TokenEdge[] }[]): Set<string> {
  return new Set(paths.map((p) => p.edges[0].tokenOut));
}

// ── AC-2.3: top-N effective ──────────────────────────────────────
function testTopN(): void {
  const paths = buildTokenPaths(fanGraph(), "A", "A", { maxHops: 2, maxPoolsPerToken: 3 });
  const mids = midTokens(paths);
  assert(paths.length === 3, `top-N: expected 3 paths, got ${paths.length}`);
  assert(
    mids.has("B") && mids.has("C") && mids.has("D"),
    `top-N: expected top-3 by score {B,C,D}, got {${[...mids].join(",")}}`,
  );
  assert(
    !mids.has("E") && !mids.has("F") && !mids.has("G"),
    `top-N: low-score edges should be pruned, got {${[...mids].join(",")}}`,
  );
  console.log("[pruning] AC-2.3 top-N effective: PASS");
}

// ── AC-2.2: pin invariant (pinnedPools) ──────────────────────────
function testPinByPool(): void {
  // Pin pG (score 1, the lowest). It must survive; remaining 2 slots = top-2 {B,C}.
  const paths = buildTokenPaths(fanGraph(), "A", "A", {
    maxHops: 2,
    maxPoolsPerToken: 3,
    pinnedPools: new Set(["pg"]), // lowercased
  });
  const mids = midTokens(paths);
  assert(mids.has("G"), `pin: pinned victim pool (G, score=1) must survive, got {${[...mids].join(",")}}`);
  assert(mids.has("B") && mids.has("C"), `pin: remaining slots = top-2 {B,C}, got {${[...mids].join(",")}}`);
  assert(paths.length === 3, `pin: expected 3 paths, got ${paths.length}`);
  console.log("[pruning] AC-2.2a pin victim pool (score=0/low): PASS");
}

// ── AC-2.2: pin invariant (score===undefined backbone) ───────────
function testPinBackbone(): void {
  const edges = fanGraph();
  edges.push(edge("A", "W", "pW", undefined)); // curated backbone, no score
  edges.push(edge("W", "A", "pW", 100));
  // A now has 7 out-edges; W is pinned (undefined). top-2 of scored = {B,C}.
  const paths = buildTokenPaths(edges, "A", "A", { maxHops: 2, maxPoolsPerToken: 3 });
  const mids = midTokens(paths);
  assert(mids.has("W"), `pin: backbone edge (score===undefined) must survive, got {${[...mids].join(",")}}`);
  assert(paths.length === 3, `pin: expected 3 paths, got ${paths.length}`);
  console.log("[pruning] AC-2.2b pin backbone (score===undefined): PASS");
}

// ── AC-2.4: perf bound on a ~3000-edge graph ─────────────────────
function testPerfBound(): void {
  const K = 200; // tokens t0..t199
  const FANOUT = 15; // 200 * 15 * (both dirs) ≈ 3000 edges (directed)
  const edges: TokenEdge[] = [];
  for (let i = 0; i < K; i++) {
    for (let f = 0; f < FANOUT; f++) {
      const j = (i * 7 + f * 13 + 1) % K;
      if (j === i) continue;
      edges.push(edge(`t${i}`, `t${j}`, `p${i}_${j}`, (f * 31 + i) % 1000));
    }
  }
  assert(edges.length >= 2500, `perf: expected ~3000 edges, built ${edges.length}`);

  const t0 = performance.now();
  const paths = buildTokenPaths(edges, "t0", "t0", { maxHops: 3, maxPoolsPerToken: 8 });
  const wall = performance.now() - t0;

  assert(wall < 1000, `perf: DFS wall ${wall.toFixed(1)}ms exceeded 1000ms budget`);
  assert(paths.length <= 20000, `perf: path count ${paths.length} exceeded maxPaths guard`);
  console.log(
    `[pruning] AC-2.4 perf bound: PASS (${edges.length} edges → ${paths.length} paths in ${wall.toFixed(1)}ms)`,
  );
}

function main(): void {
  testTopN();
  testPinByPool();
  testPinBackbone();
  testPerfBound();
  console.log("path-pruning PASS (4/4)");
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
