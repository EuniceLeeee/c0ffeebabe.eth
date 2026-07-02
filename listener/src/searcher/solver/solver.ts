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
import type { V4PoolKey } from "../planner/token-graph.js";
import { geometricGrid, goldenSectionMaximize } from "./amount-bounds.js";
import {
  propagateAmounts,
  propagateAmountsWithRawOutputs,
  type AmountQuoteSource,
} from "./amount-propagation.js";
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
    const rawCenter = await resolveSearchCenter(plan, flashToken, state, {
      cache: opts.cache,
      quoteSource: opts.quoteSource,
    });
    const maxFlashAmount = normalizedMaxFlashAmount(plan);
    if (maxFlashAmount !== null && maxFlashAmount <= 0n) {
      throw new Error(`no profitable plan (flash cap is zero)`);
    }
    const center = clampToMax(rawCenter, maxFlashAmount);

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
      if (maxFlashAmount !== null && flashAmount > maxFlashAmount) return FAIL_SCORE;
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
      const grid = capGrid(geometricGrid(center, gridHalfWidth), maxFlashAmount);
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
        await goldenSectionMaximize(
          bestX > 1n ? bestX / 2n : 1n,
          clampToMax(bestX * 2n, maxFlashAmount),
          (x) => quoteProfit(x, fluidDebtBps),
          {
            maxTries: gssMaxTries,
            shouldStop: pastDeadline,
          },
        );
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
        `maxFlash=${maxFlashAmount ?? "unbounded"} ` +
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
      let rawOutputs: bigint[];
      try {
        const propagated = await propagateAmountsWithRawOutputs(plan.tokenPath, cand.flashAmount, state, {
          fluidDebtBps: cand.fluidDebtBps,
          cache: opts.cache,
          quoteSource: opts.quoteSource,
          safetyBps: quoteSafetyBps,
          shouldStop: pastDeadline,
        });
        amounts = propagated.amounts;
        rawOutputs = propagated.rawOutputs;
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
            rawOutputs,
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
        if (pastDeadline()) {
          lastFailure = `deadline ${deadlineMs}ms reached before sim`;
          break;
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

function normalizedMaxFlashAmount(plan: CandidatePlan): bigint | null {
  return plan.maxFlashAmount === undefined ? null : plan.maxFlashAmount;
}

function clampToMax(amount: bigint, max: bigint | null): bigint {
  if (amount <= 0n) return 1n;
  return max !== null && amount > max ? max : amount;
}

function capGrid(grid: bigint[], max: bigint | null): bigint[] {
  const seen = new Set<string>();
  const out: bigint[] = [];
  for (const raw of grid) {
    const amount = clampToMax(raw, max);
    if (amount <= 0n) continue;
    const key = amount.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(amount);
  }
  return out;
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
  /** v4 poolId — disambiguates pools sharing the singleton PoolManager address. */
  poolId?: string;
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
  if (!impact) return victimAmount;

  const usePathAwareCenter = plan.maxFlashAmount !== undefined;
  const reverseImpactIndex = usePathAwareCenter ? findReverseImpactEdgeIndex(plan, impact) : -1;
  const impactV4PoolKey = findImpactV4PoolKey(plan, impact);
  if (reverseImpactIndex >= 0) {
    const desiredImpactInput = await quoteImpactOutput(
      impact,
      victimAmount,
      state,
      options,
      impactV4PoolKey,
    );
    if (reverseImpactIndex === 0) return desiredImpactInput;
    return approximatePrefixInputForOutput(
      plan,
      reverseImpactIndex,
      desiredImpactInput,
      state,
      options,
    );
  }

  if (sameAddress(impact.tokenIn, flashToken)) return victimAmount;

  if (sameAddress(impact.tokenOut, flashToken)) {
    // Prefer local math (cache/state); fall back to the live quoteSource only
    // when local can't serve it — same local-first dispatch as quoteEdge.
    return quoteImpactOutput(impact, victimAmount, state, options, impactV4PoolKey);
  }

  return victimAmount;
}

function findReverseImpactEdgeIndex(plan: CandidatePlan, impact: OpportunityImpact): number {
  const edges = plan.tokenPath?.edges ?? [];
  return edges.findIndex((edge) =>
    sameAddress(edge.target, impact.pool) &&
    sameV4Pool(edge.poolId, impact.poolId) &&
    sameAddress(edge.tokenIn, impact.tokenOut) &&
    sameAddress(edge.tokenOut, impact.tokenIn),
  );
}

function findImpactV4PoolKey(plan: CandidatePlan, impact: OpportunityImpact): V4PoolKey | undefined {
  if (impact.matchedAdapterId !== "univ4-unlock") return undefined;
  return plan.tokenPath.edges.find((edge) =>
    sameAddress(edge.target, impact.pool) &&
    edge.v4PoolKey !== undefined &&
    sameV4Pool(edge.poolId, impact.poolId) &&
    (
      (sameAddress(edge.tokenIn, impact.tokenIn) && sameAddress(edge.tokenOut, impact.tokenOut)) ||
      (sameAddress(edge.tokenIn, impact.tokenOut) && sameAddress(edge.tokenOut, impact.tokenIn))
    ),
  )?.v4PoolKey;
}

// v4 pools share the singleton PoolManager address; when the impact carries a
// poolId, the edge's poolId must match. Non-v4 (no impact poolId) always passes.
function sameV4Pool(edgePoolId: string | undefined, impactPoolId: string | undefined): boolean {
  if (!impactPoolId) return true;
  return (edgePoolId ?? "").toLowerCase() === impactPoolId.toLowerCase();
}

async function quoteImpactOutput(
  impact: OpportunityImpact,
  victimAmount: bigint,
  state: StateBackend,
  options: { cache?: PoolStateCache; quoteSource?: AmountQuoteSource },
  v4PoolKey?: V4PoolKey,
): Promise<bigint> {
  let quoted: bigint;
  try {
    quoted = await quote(
      impact.matchedAdapterId,
      impact.pool,
      impact.tokenIn,
      impact.tokenOut,
      victimAmount,
      state,
      options.cache,
      v4PoolKey,
    );
  } catch (err) {
    if (!options.quoteSource) throw err;
    quoted = (await options.quoteSource.quote({
      adapterId: impact.matchedAdapterId,
      target: impact.pool,
      tokenIn: impact.tokenIn,
      tokenOut: impact.tokenOut,
      amountIn: victimAmount,
      v4PoolKey,
    })).amountOut;
  }
  return quoted > 0n ? quoted : 1n;
}

async function approximatePrefixInputForOutput(
  plan: CandidatePlan,
  reverseImpactIndex: number,
  desiredOutput: bigint,
  state: StateBackend,
  options: { cache?: PoolStateCache; quoteSource?: AmountQuoteSource },
): Promise<bigint> {
  if (desiredOutput <= 0n) return 1n;
  const prefix = { edges: plan.tokenPath.edges.slice(0, reverseImpactIndex) };
  if (prefix.edges.length === 0) return desiredOutput;

  const maxFlash = normalizedMaxFlashAmount(plan);
  const quotePrefix = async (flashAmount: bigint): Promise<bigint> => {
    const amounts = await propagateAmounts(prefix, flashAmount, state, {
      cache: options.cache,
      quoteSource: options.quoteSource,
    });
    return amounts[amounts.length - 1] ?? 0n;
  };

  let lo = 1n;
  let hi = clampToMax(desiredOutput, maxFlash);
  let hiOut = await quotePrefix(hi);
  for (let i = 0; i < 16 && hiOut < desiredOutput; i++) {
    if (maxFlash !== null && hi >= maxFlash) return hi;
    lo = hi;
    hi = clampToMax(hi * 2n, maxFlash);
    if (hi <= lo) return hi;
    hiOut = await quotePrefix(hi);
  }
  if (hiOut < desiredOutput) return hi;

  for (let i = 0; i < 16 && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n;
    const out = await quotePrefix(mid);
    if (out < desiredOutput) lo = mid;
    else hi = mid;
  }
  return hi;
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
    poolId: typeof maybe.poolId === "string" ? maybe.poolId : undefined,
  };
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
