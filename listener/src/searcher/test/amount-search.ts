/**
 * Deterministic unit tests for the Stage-3a amount search (AC-3a.1 / AC-3a.2).
 * Pure in-memory — no RPC, no anvil. Sub-second.
 *
 *   AC-3a.1  grid victim-anchored geometric + GSS converges in ≤ maxTries evals.
 *   AC-3a.2  bid = profit * bps / 10000, capped below profit, 0 when profit<=0.
 */

import { geometricGrid, goldenSectionMaximize, bidAmount } from "../solver/amount-bounds.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

// ── AC-3a.1a: victim-anchored geometric grid ─────────────────────
function testGrid(): void {
  const grid = geometricGrid(1000n, 3);
  assert(grid.length === 7, `grid: expected 7 points, got ${grid.length}`);
  assert(grid[0] === 125n, `grid: low end should be v/8=125, got ${grid[0]}`);
  assert(grid.includes(1000n), `grid: must include the center, got ${grid.join(",")}`);
  assert(grid[grid.length - 1] === 8000n, `grid: high end should be v*8=8000, got ${grid[grid.length - 1]}`);
  // NOT an absolute fixed sweep — scales with the center.
  assert(geometricGrid(2000n, 3)[0] === 250n, "grid: must scale with center (victim-anchored)");
  console.log("[amtsearch] AC-3a.1a geometric grid (victim-anchored): PASS");
}

// ── AC-3a.1b: GSS converges to the peak within the eval cap ───────
async function testGss(): Promise<void> {
  // Unimodal concave profit: peak at K, linear falloff. Integer domain.
  const K = 5000n;
  const PEAK = 1_000_000n;
  let calls = 0;
  const evaluate = async (x: bigint): Promise<bigint> => {
    calls++;
    const v = PEAK - abs(x - K);
    return v > 0n ? v : 0n;
  };

  const maxTries = 12;
  const res = await goldenSectionMaximize(125n, 16000n, evaluate, { maxTries });
  assert(res.evals <= maxTries, `gss: evals ${res.evals} exceeded hard cap ${maxTries}`);
  assert(calls === res.evals, `gss: eval count mismatch (${calls} vs ${res.evals})`);
  assert(abs(res.x - K) < 200n, `gss: converged to ${res.x}, expected near ${K}`);
  console.log(`[amtsearch] AC-3a.1b GSS converge: PASS (x=${res.x}, evals=${res.evals})`);
}

// ── AC-3a.1c: grid → GSS integration (mirrors solver usage) ──────
async function testGridThenGss(): Promise<void> {
  const K = 5000n;
  const PEAK = 1_000_000n;
  const evaluate = async (x: bigint): Promise<bigint> => {
    const v = PEAK - abs(x - K);
    return v > 0n ? v : 0n;
  };

  // Stage 1: coarse grid anchored on victim size (≈2000).
  const grid = geometricGrid(2000n, 3); // [250..16000]
  let best = { x: grid[0], value: await evaluate(grid[0]) };
  for (const x of grid.slice(1)) {
    const v = await evaluate(x);
    if (v > best.value) best = { x, value: v };
  }
  // Stage 2: GSS refine around the best grid point.
  const refined = await goldenSectionMaximize(best.x / 2n, best.x * 2n, evaluate, { maxTries: 12 });
  const finalBest = refined.value > best.value ? refined : best;
  assert(abs(finalBest.x - K) < 200n, `grid+gss: converged to ${finalBest.x}, expected near ${K}`);
  console.log(`[amtsearch] AC-3a.1c grid→GSS integration: PASS (x=${finalBest.x})`);
}

// ── AC-3a.3 (unit): GSS honors an external stop signal (deadline) ─
async function testGssShouldStop(): Promise<void> {
  const K = 5000n;
  const PEAK = 1_000_000n;
  let calls = 0;
  // Stop after the 2 upfront evals + 1 loop step: proves the deadline can cut
  // the search short well before maxTries, returning the best seen so far.
  const evaluate = async (x: bigint): Promise<bigint> => {
    calls++;
    const v = PEAK - abs(x - K);
    return v > 0n ? v : 0n;
  };
  const res = await goldenSectionMaximize(125n, 16000n, evaluate, {
    maxTries: 12,
    shouldStop: () => calls >= 3,
  });
  assert(res.evals <= 4, `gss/stop: expected early stop (<=4 evals), got ${res.evals}`);
  assert(calls === res.evals, `gss/stop: eval count mismatch (${calls} vs ${res.evals})`);
  console.log(`[amtsearch] AC-3a.3 GSS shouldStop (deadline): PASS (evals=${res.evals})`);
}

// ── AC-3a.2: bid math ────────────────────────────────────────────
function testBid(): void {
  assert(bidAmount(1000n, 9000n) === 900n, `bid: 1000*0.9 should be 900, got ${bidAmount(1000n, 9000n)}`);
  assert(bidAmount(0n) === 0n, "bid: profit<=0 must bid 0");
  assert(bidAmount(-5n) === 0n, "bid: negative profit must bid 0");
  assert(bidAmount(1000n, 9000n) < 1000n, "bid: must be strictly below profit");
  assert(bidAmount(1000n, 10000n) === 999n, "bid: 100% must be capped to profit-1");
  console.log("[amtsearch] AC-3a.2 bid math: PASS");
}

async function main(): Promise<void> {
  testGrid();
  await testGss();
  await testGridThenGss();
  await testGssShouldStop();
  testBid();
  console.log("amount-search PASS (5/5)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
