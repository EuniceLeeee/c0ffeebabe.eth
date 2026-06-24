/**
 * Solver — converts a CandidatePlan (token path + unresolved amounts) into
 * a profitable ResolvedPlan in two phases:
 *
 *   Phase 1 (quote-first, cheap): search flashAmount × fluidDebtBps using only
 *     the quoter chain (eth_call get_dy / quoteExactInputSingle / getReserves).
 *     Closed-loop profit = amounts[last] − flashAmount. Victim-anchored
 *     geometric grid + golden-section refine, all on quotes — no Anvil sim.
 *   Phase 2 (validate top-N): rank the profitable quote candidates and run a
 *     full BotVM simulate on only the top-N (default 3) to get real netProfit
 *     and confirm the flash-repay guard holds.
 *
 * This is the key efficiency lever: a full Anvil BotVM simulate (snapshot +
 * send + mine + revert + traceRevert) is ~1-2 orders of magnitude pricier than
 * a quote, so it must NOT be the search workhorse. We quote ~hundreds of points
 * cheaply, then pay for full sim on only a handful. (cf. sui-mev: local
 * DBSimulator + simulator pool — its "dozens of trials" are micro-priced.)
 *
 * Generic over any TokenPath produced by the planner; never route-specific.
 */

import type { ResolvedPlanNode } from "../../shared/types/plan.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { CandidatePlan } from "../planner/planner.js";
import { geometricGrid, goldenSectionMaximize } from "./amount-bounds.js";
import { propagateAmounts, type AmountQuoteSource } from "./amount-propagation.js";
import { buildResolvedPlanFromPath } from "./plan-builder.js";
import type { PoolStateCache } from "./pool-state-cache.js";
import { quote } from "./quoter.js";

export interface ResolvedPlan {
  root: ResolvedPlanNode;
  netProfit: bigint;
  profitToken: string;
  flashAmount: bigint;
  templateName: string;
}

export interface SolverProbe {
  readonly executor: string;
  simulate(plan: ResolvedPlan): Promise<{
    success: boolean;
    netProfit: bigint;
    revertReason?: string;
  }>;
}

export interface SolveOptions {
  /** Hard wall-time cap; once exceeded, remaining trials are abandoned and the
   *  best-so-far is returned. Default Infinity (unbounded) for offline/regression
   *  use; live wires SEARCHER_SOLVER_DEADLINE_MS. (v7 AC-3a.3) */
  deadlineMs?: number;
  /** GSS evaluation hard cap per fluidDebtBps. Default 12. (v7 AC-3a.1) */
  gssMaxTries?: number;
  /** Geometric grid doublings each side of the victim-anchored center. Default 3. */
  gridHalfWidth?: number;
  /** How many top quote-ranked amount candidates get a full BotVM simulate.
   *  Default 3 — the whole point is to NOT full-sim every searched point. */
  finalSimTopN?: number;
  /** Path B: warmed pool-state cache for local-math quotes (no per-trial RPC).
   *  When omitted, quotes fall back to on-chain eth_call. */
  cache?: PoolStateCache;
  /** Live fast backend quote source. When supplied, amount propagation quotes
   *  through the prepared backend state instead of the Anvil StateBackend. */
  quoteSource?: AmountQuoteSource;
  /** Per-hop quote haircut. 10000 = no haircut. */
  quoteSafetyBps?: bigint;
  /** Admit near-miss quote candidates into phase-2 sim.
   *  0 = only positive quote profit. 20 = allow quoteProfit >= -20bps. */
  quoteProfitFloorBps?: bigint;
  /** Build and return the best quote-ranked plan without running phase-2 sim.
   *  Live local-victim-apply uses this to keep revm victim overlay out of the
   *  hot quote/search path; the caller must run final sim before submit. */
  deferPhase2Sim?: boolean;
}

export interface Solver {
  solve(
    plan: CandidatePlan,
    state: StateBackend,
    probe: SolverProbe,
    opts?: SolveOptions,
  ): Promise<ResolvedPlan>;
}

// Any real (positive) profit must outrank a reverted trial in the amount search.
const FAIL_SCORE = -(1n << 200n);

interface QuoteCandidate {
  flashAmount: bigint;
  fluidDebtBps: bigint;
  quoteProfit: bigint;
}

export class AnvilSolver implements Solver {
  async solve(
    plan: CandidatePlan,
    state: StateBackend,
    probe: SolverProbe,
    opts: SolveOptions = {},
  ): Promise<ResolvedPlan> {
    const deadlineMs = opts.deadlineMs ?? Infinity;
    const gssMaxTries = opts.gssMaxTries ?? 12;
    const gridHalfWidth = opts.gridHalfWidth ?? 3;
    const finalSimTopN = opts.finalSimTopN ?? 3;
    const quoteSafetyBps = opts.quoteSafetyBps ??
      BigInt(process.env.SEARCHER_QUOTE_SAFETY_BPS ?? "9999");
    const quoteProfitFloorBps = opts.quoteProfitFloorBps ??
      BigInt(process.env.SEARCHER_QUOTE_PROFIT_FLOOR_BPS ?? (process.env.SEARCHER_DRY_RUN === "1" ? "20" : "0"));
    const deferPhase2Sim = opts.deferPhase2Sim ?? false;
    const debugQuotes = process.env.SEARCHER_SOLVER_DEBUG_QUOTES === "1";
    const startedAt = Date.now();
    const pastDeadline = (): boolean => Date.now() - startedAt >= deadlineMs;

    const flashToken = plan.opportunity.startToken;
    const executor = probe.executor;
    const targetNetProfit = plan.opportunity.targetNetProfit ?? 1n;
    // Anchor the amount search on the victim swap size, expressed in the flash
    // token. The detector stores victimAmountIn in the victim tokenIn units;
    // live opportunities often flash tokenOut (for example WETH), so using the
    // raw 6-decimal stable amount as wei would collapse the grid to dust.
    const center = await resolveSearchCenter(plan, flashToken, state, {
      cache: opts.cache,
      quoteSource: opts.quoteSource,
    });

    // ── Phase 1: quote-only amount search (no Anvil sim) ──────────
    // Closed-loop arb: profitToken == startToken == flashToken, so the quote
    // profit is just (final amount back in flashToken) − flashAmount. Each
    // evaluation is a handful of eth_call quotes, cheap enough to search widely.
    const scored: QuoteCandidate[] = [];
    let quoteCount = 0;
    let lastFailure = "quotes completed but no profitable amount";
    let bestObserved: { flashAmount: bigint; fluidDebtBps: bigint; profit: bigint; amounts: bigint[] } | null = null;

    const quoteProfit = async (flashAmount: bigint, fluidDebtBps: bigint): Promise<bigint> => {
      if (flashAmount <= 0n) return FAIL_SCORE;
      quoteCount++;
      let amounts: bigint[];
      try {
        amounts = await propagateAmounts(plan.tokenPath, flashAmount, state, {
          fluidDebtBps,
          cache: opts.cache,
          quoteSource: opts.quoteSource,
          safetyBps: quoteSafetyBps,
          shouldStop: pastDeadline,
        });
      } catch (err) {
        lastFailure = `quote failed: ${err instanceof Error ? err.message : String(err)}`;
        return FAIL_SCORE;
      }
      const profit = amounts[amounts.length - 1] - flashAmount;
      if (!bestObserved || profit > bestObserved.profit) {
        bestObserved = { flashAmount, fluidDebtBps, profit, amounts };
      }
      if (shouldAdmitQuoteCandidate(profit, flashAmount, quoteProfitFloorBps)) {
        scored.push({ flashAmount, fluidDebtBps, quoteProfit: profit });
      }
      return profit;
    };

    for (const fluidDebtBps of fluidDebtBpsCandidates(plan)) {
      if (pastDeadline()) {
        lastFailure = `deadline ${deadlineMs}ms reached during quote search`;
        break;
      }
      // Coarse pass: victim-anchored geometric grid.
      const grid = geometricGrid(center, gridHalfWidth);
      let bestX = grid[0] ?? center;
      let bestVal = FAIL_SCORE;
      for (const x of grid) {
        if (pastDeadline()) {
          lastFailure = `deadline ${deadlineMs}ms reached during quote search`;
          break;
        }
        const v = await quoteProfit(x, fluidDebtBps);
        if (v > bestVal) {
          bestVal = v;
          bestX = x;
        }
      }
      // Refine pass: only around a profitable grid point. The near-miss floor
      // below is only a phase-2 admission policy; letting negative grid points
      // trigger GSS can burn the live TTL on quotes before sim gets a chance.
      if (bestVal > 0n && !pastDeadline()) {
        await goldenSectionMaximize(bestX / 2n, bestX * 2n, (x) => quoteProfit(x, fluidDebtBps), {
          maxTries: gssMaxTries,
          shouldStop: pastDeadline,
        });
      }
    }

    if (scored.length === 0) {
      if (debugQuotes && bestObserved) {
        logBestObservedQuote(plan, bestObserved, center, quoteSafetyBps);
      }
      throw new Error(
        `no profitable plan (quote search ${quoteCount} pts, center=${center}): ${lastFailure}`,
      );
    }

    // ── Phase 2: full BotVM simulate on the top-N quote candidates ─
    // Rank by quote profit, but diversify across fluidDebtBps first. Quote
    // profit grows monotonically with how much we borrow (higher bps → more
    // downstream swap → "more profit"), so a naive top-N is N copies of the
    // single highest bps — which over-borrows past Fluid's collateral limit and
    // reverts in operate(). Taking the best amount PER bps makes top-N span
    // 11200/10800/10400/… so sim reaches a bps that actually executes. Non-fluid
    // paths have a single bps (0), so this degrades to amount diversity.
    const byQuoteDesc = (a: QuoteCandidate, b: QuoteCandidate): number =>
      b.quoteProfit > a.quoteProfit ? 1 : b.quoteProfit < a.quoteProfit ? -1 : 0;
    const bestPerBps = new Map<string, QuoteCandidate>();
    for (const c of scored) {
      const k = c.fluidDebtBps.toString();
      const cur = bestPerBps.get(k);
      if (!cur || c.quoteProfit > cur.quoteProfit) bestPerBps.set(k, c);
    }
    const ranked = [...bestPerBps.values()].sort(byQuoteDesc);
    const seen = new Set(ranked.map((c) => `${c.flashAmount}-${c.fluidDebtBps}`));
    for (const c of [...scored].sort(byQuoteDesc)) {
      if (ranked.length >= finalSimTopN) break;
      const key = `${c.flashAmount}-${c.fluidDebtBps}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ranked.push(c);
    }
    // Keep enough to cover every bps (fluid) or finalSimTopN amounts (non-fluid).
    ranked.splice(Math.max(finalSimTopN, bestPerBps.size));
    const adapters = flashAdapterIds(plan);
    const positiveQuotes = scored.filter((c) => c.quoteProfit > 0n).length;
    const floorQuotes = scored.length - positiveQuotes;

    console.log(
      `[searcher/ac3] solver: quote search ${quoteCount} pts → ` +
        `${positiveQuotes} positive${floorQuotes > 0 ? ` + ${floorQuotes} floor-admitted` : ""}, ` +
        `sim top-${ranked.length} amounts x ${adapters.length} flash ` +
        `safetyBps=${quoteSafetyBps} quoteFloorBps=${quoteProfitFloorBps} ` +
        `path=${pathSummary(plan.tokenPath)}`,
    );

    let best: ResolvedPlan | null = null;
    let bestProfit = FAIL_SCORE;
    for (const cand of ranked) {
      if (pastDeadline()) {
        lastFailure = `deadline ${deadlineMs}ms reached before sim`;
        break;
      }
      let amounts: bigint[];
      try {
        amounts = await propagateAmounts(plan.tokenPath, cand.flashAmount, state, {
          fluidDebtBps: cand.fluidDebtBps,
          cache: opts.cache,
          quoteSource: opts.quoteSource,
          safetyBps: quoteSafetyBps,
          shouldStop: pastDeadline,
        });
      } catch (err) {
        lastFailure = `propagation failed: ${err instanceof Error ? err.message : String(err)}`;
        console.log(`[searcher/ac3] solver:   propagation ${lastFailure.slice(0, 200)}`);
        continue;
      }

      for (const flashAdapterId of adapters) {
        if (pastDeadline()) {
          lastFailure = `deadline ${deadlineMs}ms reached before sim`;
          break;
        }
        console.log(
          `[searcher/ac3] solver: sim flashAmount=${cand.flashAmount} ` +
            `fluidDebtBps=${cand.fluidDebtBps} flashAdapter=${flashAdapterId} ` +
            `quoteProfit=${cand.quoteProfit}`,
        );

        let resolvedNode: ResolvedPlanNode;
        try {
          resolvedNode = await buildResolvedPlanFromPath(
            plan.tokenPath,
            flashToken,
            cand.flashAmount,
            amounts,
            executor,
            state,
            targetNetProfit,
            flashAdapterId,
          );
        } catch (err) {
          lastFailure = `build failed: ${err instanceof Error ? err.message : String(err)}`;
          console.log(`[searcher/ac3] solver:   build ${lastFailure.slice(0, 200)}`);
          continue;
        }

        const candidate: ResolvedPlan = {
          root: resolvedNode,
          netProfit: deferPhase2Sim ? cand.quoteProfit : 0n,
          profitToken: plan.opportunity.profitToken,
          flashAmount: cand.flashAmount,
          templateName: plan.templateName,
        };
        if (deferPhase2Sim) {
          console.log(
            `[searcher/ac3] solver:   deferred sim, quoteProfit=${cand.quoteProfit}`,
          );
          return candidate;
        }
        const sim = await probe.simulate(candidate);
        if (!sim.success) {
          lastFailure = sim.revertReason ?? "simulation failed";
          console.log(`[searcher/ac3] solver:   sim rejected: ${lastFailure.slice(0, 200)}`);
          continue;
        }

        console.log(`[searcher/ac3] solver:   accepted, netProfit=${sim.netProfit}`);
        if (sim.netProfit > bestProfit) {
          best = { ...candidate, netProfit: sim.netProfit };
          bestProfit = sim.netProfit;
        }
        if (best && bestProfit >= targetNetProfit) return best;
      }
    }

    if (!best) {
      throw new Error(
        `no profitable plan (sim'd top-${ranked.length} amounts x ${adapters.length} flash): ${lastFailure}`,
      );
    }
    return best;
  }
}

function flashAdapterIds(plan: CandidatePlan): string[] {
  return plan.flashAdapterIds?.length ? plan.flashAdapterIds : [plan.flashAdapterId];
}

function shouldAdmitQuoteCandidate(
  quoteProfit: bigint,
  flashAmount: bigint,
  floorBps: bigint,
): boolean {
  if (quoteProfit > 0n) return true;
  if (floorBps <= 0n || flashAmount <= 0n) return false;
  return quoteProfit >= -quoteProfitFloorAmount(flashAmount, floorBps);
}

function quoteProfitFloorAmount(flashAmount: bigint, floorBps: bigint): bigint {
  return (flashAmount * floorBps) / 10000n;
}

function fluidDebtBpsCandidates(
  plan: { tokenPath: { edges: { adapterId: string }[] } },
): bigint[] {
  if (!plan.tokenPath.edges.some((edge) => edge.adapterId === "fluid-vault")) return [0n];
  return [8500n, 9500n, 10000n, 10400n, 10800n, 11200n];
}

function pathSummary(path: { edges: { adapterId: string; tokenIn: string; tokenOut: string }[] }): string {
  return path.edges.map((e) => `${shortToken(e.tokenIn)}->${shortToken(e.tokenOut)}@${e.adapterId}`).join(" → ");
}

function shortToken(addr: string): string {
  return addr.slice(0, 6);
}

function logBestObservedQuote(
  plan: CandidatePlan,
  best: { flashAmount: bigint; fluidDebtBps: bigint; profit: bigint; amounts: bigint[] },
  center: bigint,
  safetyBps: bigint,
): void {
  console.log(
    `[searcher/ac3] solver: best non-positive quote center=${center} ` +
      `safetyBps=${safetyBps} flashAmount=${best.flashAmount} ` +
      `fluidDebtBps=${best.fluidDebtBps} quoteProfit=${best.profit} ` +
      `path=${pathSummary(plan.tokenPath)}`,
  );
  for (let i = 0; i < plan.tokenPath.edges.length; i++) {
    const edge = plan.tokenPath.edges[i];
    console.log(
      `[searcher/ac3] solver:   hop${i} ${edge.adapterId} ` +
        `${shortToken(edge.tokenIn)}->${shortToken(edge.tokenOut)} ` +
        `pool=${edge.target.slice(0, 10)} in=${best.amounts[i]} out=${best.amounts[i + 1]}`,
    );
  }
}

interface OpportunityImpact {
  pool: string;
  tokenIn: string;
  tokenOut: string;
  matchedAdapterId: string;
}

export async function resolveSearchCenter(
  plan: CandidatePlan,
  flashToken: string,
  state: StateBackend,
  options: { cache?: PoolStateCache; quoteSource?: AmountQuoteSource },
): Promise<bigint> {
  const victimAmount = plan.opportunity.victimAmountIn;
  if (victimAmount <= 0n) return 1n;

  const impact = impactFromOpportunity(plan.opportunity.hints.impact);
  if (!impact || sameAddress(impact.tokenIn, flashToken)) return victimAmount;

  if (sameAddress(impact.tokenOut, flashToken)) {
    // Prefer local math (cache/state); fall back to the live quoteSource only
    // when local can't serve it — same local-first dispatch as quoteEdge.
    let quoted: bigint;
    try {
      quoted = await quote(
        impact.matchedAdapterId,
        impact.pool,
        impact.tokenIn,
        flashToken,
        victimAmount,
        state,
        options.cache,
      );
    } catch (err) {
      if (!options.quoteSource) throw err;
      quoted = (await options.quoteSource.quote({
        adapterId: impact.matchedAdapterId,
        target: impact.pool,
        tokenIn: impact.tokenIn,
        tokenOut: flashToken,
        amountIn: victimAmount,
      })).amountOut;
    }
    return quoted > 0n ? quoted : 1n;
  }

  return victimAmount;
}

function impactFromOpportunity(impact: unknown): OpportunityImpact | null {
  if (!impact || typeof impact !== "object") return null;
  const maybe = impact as Partial<OpportunityImpact>;
  if (
    typeof maybe.pool !== "string" ||
    typeof maybe.tokenIn !== "string" ||
    typeof maybe.tokenOut !== "string" ||
    typeof maybe.matchedAdapterId !== "string"
  ) {
    return null;
  }
  return {
    pool: maybe.pool,
    tokenIn: maybe.tokenIn,
    tokenOut: maybe.tokenOut,
    matchedAdapterId: maybe.matchedAdapterId,
  };
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
