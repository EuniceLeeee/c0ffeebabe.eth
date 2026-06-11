// ─── Victim-anchored amount search (Stage 3a) ──────────────────
// Adapted, NOT copied. sui-mev uses an absolute 1e6×10^inc grid + GSS with
// tries<1000 because its simulator is local (microseconds). Our trial is a
// heavy Anvil send+mine, so we (a) anchor the grid to the victim size (narrow,
// few points) and (b) HARD-CAP GSS evaluations. See docs/v7 AC-3a.1.

/**
 * Victim-anchored geometric grid: center/2^h … center*2^h (×2 steps).
 * `halfWidth` = doublings each side (3 → 7 points spanning [v/8, v*8]).
 */
export function geometricGrid(center: bigint, halfWidth = 3): bigint[] {
  if (center <= 0n) return [];
  const out: bigint[] = [];
  for (let i = -halfWidth; i <= halfWidth; i++) {
    const amt = i < 0 ? center >> BigInt(-i) : center << BigInt(i);
    if (amt > 0n) out.push(amt);
  }
  return out;
}

/**
 * Golden-section search maximizing `evaluate` over integer [lo, hi].
 * Reuses one probe per iteration (2 evals to start, +1 per step). Terminates
 * when the bracket is within `tolerance` OR `maxTries` evaluations are spent —
 * the hard cap is essential: each evaluate() is a real (expensive) simulate.
 * Returns the best (x, value) actually evaluated, plus the eval count.
 */
export async function goldenSectionMaximize(
  lo: bigint,
  hi: bigint,
  evaluate: (x: bigint) => Promise<bigint>,
  opts: { maxTries?: number; tolerance?: bigint; shouldStop?: () => boolean } = {},
): Promise<{ x: bigint; value: bigint; evals: number }> {
  const maxTries = opts.maxTries ?? 12;
  const tolerance = opts.tolerance ?? 1n;
  const shouldStop = opts.shouldStop;
  if (hi < lo) [lo, hi] = [hi, lo];

  // golden-ratio reciprocal ≈ 0.618 as an integer fraction
  const F = 618n, D = 1000n;
  const probe = (a: bigint, b: bigint, nearA: boolean): bigint =>
    nearA ? b - ((b - a) * F) / D : a + ((b - a) * F) / D;

  let a = lo, b = hi;
  let c = probe(a, b, true); // closer to a
  let d = probe(a, b, false); // closer to b
  let fc = await evaluate(c);
  let fd = await evaluate(d);
  let evals = 2;
  let best = fc >= fd ? { x: c, value: fc } : { x: d, value: fd };

  while (b - a > tolerance && evals < maxTries && !(shouldStop?.() ?? false)) {
    if (fc < fd) {
      a = c;
      c = d; fc = fd;
      d = probe(a, b, false);
      fd = await evaluate(d); evals++;
      if (fd > best.value) best = { x: d, value: fd };
    } else {
      b = d;
      d = c; fd = fc;
      c = probe(a, b, true);
      fc = await evaluate(c); evals++;
      if (fc > best.value) best = { x: c, value: fc };
    }
  }

  return { ...best, evals };
}

/**
 * Bid = profit * bps / 10000 (sui-mev bids profit*9/10; we make it configurable
 * and never bid >= profit). Returns 0 for non-positive profit.
 */
export function bidAmount(profit: bigint, bps: bigint = 9000n): bigint {
  if (profit <= 0n) return 0n;
  const bid = (profit * bps) / 10000n;
  return bid < profit ? bid : profit - 1n;
}
