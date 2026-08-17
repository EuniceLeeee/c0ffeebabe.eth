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
import {
  withStateCallControl,
  type StateBackend,
} from "../../shared/state/state-backend.js";
import type { Opportunity } from "../detector/detector.js";
import {
  BlockScanFamilyAttributedError,
  blockScanAttributedFailureFamilyId,
} from "../detector/blockscan-family-budget.js";
import type { CandidatePlan } from "../planner/planner.js";
import type { V4PoolKey } from "../planner/token-graph.js";
import type { StrictProductionRuntimeSession } from
  "../strict-production-runtime-session.js";
import type { RuntimeEvidence } from
  "../venues/adapter-family-plugin.js";
import type { AdapterWorkControl } from "../adapter-work-intent.js";
import { geometricGrid, goldenSectionMaximize } from "./amount-bounds.js";
import {
  propagateAmounts,
  propagateAmountsWithRawOutputs,
} from "./amount-propagation.js";
import { buildResolvedPlanFromPath } from "./plan-builder.js";
import type { PoolStateCache } from "./pool-state-cache.js";
import type { V4QuotePathStats } from "./quoter.js";

export interface ResolvedPlan {
  root: ResolvedPlanNode;
  netProfit: bigint;
  profitToken: string;
  flashAmount: bigint;
  templateName: string;
}

export interface SolverTiming {
  /** Phase-1 quote-search work: center resolution plus grid/GSS quote evaluation. */
  quoteMs: number;
  /** Phase-2 validation work: top-N propagation, plan build, and final simulate. */
  simMs: number;
  otherMs?: number;
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
  /** Optional caller-owned absolute wall-clock deadline. When both deadline
   *  forms are present, the earlier boundary wins. */
  deadlineAtMs?: number;
  /** Caller cancellation. The solver links it to the same signal used by every
   *  nested state read and returns even when a family ignores cancellation. */
  signal?: AbortSignal;
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
  /** Per-hop quote haircut. 10000 = no haircut. */
  quoteSafetyBps?: bigint;
  /** Admit near-miss quote candidates into phase-2 sim.
   *  0 = only positive quote profit. 20 = allow quoteProfit >= -20bps. */
  quoteProfitFloorBps?: bigint;
  /** Build and return the best quote-ranked plan without running phase-2 sim.
   *  Live local-victim-apply uses this to keep revm victim overlay out of the
   *  hot quote/search path; the caller must run final sim before submit. */
  deferPhase2Sim?: boolean;
  /**
   * Optional phase boundary for callers that must preserve the full top-N
   * fallback set while running final simulation later. Without this callback,
   * deferred mode retains its historical first-candidate return behavior.
   */
  onDeferredCandidates?: (candidates: readonly ResolvedPlan[]) => void;
  /** Optional per-call timing sink. Reset at solve entry and updated before
   *  returns or throws, so callers can account for rejected solver attempts. */
  timing?: SolverTiming;
  /** Required single authority for current-source exact and execution. */
  strictSession?: StrictProductionRuntimeSession;
  /** Plugin-issued evidence carried by this exact source/session. */
  runtimeEvidence?: readonly RuntimeEvidence[];
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

interface FailureAttribution {
  familyId: string | undefined;
  ambiguous: boolean;
  count: number;
}

function newFailureAttribution(): FailureAttribution {
  return { familyId: undefined, ambiguous: false, count: 0 };
}

function recordFailureAttribution(
  attribution: FailureAttribution,
  error: unknown,
): void {
  attribution.count++;
  const familyId = blockScanAttributedFailureFamilyId(error);
  if (!familyId) {
    attribution.ambiguous = true;
    return;
  }
  if (attribution.familyId === undefined) {
    attribution.familyId = familyId;
  } else if (attribution.familyId !== familyId) {
    attribution.ambiguous = true;
  }
}

function terminalSolveError(
  error: Error,
  attribution: FailureAttribution,
): Error {
  return (
      attribution.count > 0 &&
      !attribution.ambiguous &&
      attribution.familyId !== undefined
    )
    ? new BlockScanFamilyAttributedError(
        attribution.familyId,
        "solver",
        error,
      )
    : error;
}

function newV4QuotePathStats(): V4QuotePathStats {
  return { local: 0, fallback: 0, localFailures: 0, hookSkipped: 0 };
}

function v4QuoteStatsTotal(stats: V4QuotePathStats): number {
  return stats.local + stats.fallback;
}

function formatV4QuotePathStats(stats: V4QuotePathStats): string {
  const total = v4QuoteStatsTotal(stats);
  const localPct = total === 0 ? "n/a" : `${((stats.local * 100) / total).toFixed(1)}%`;
  return (
    `local=${stats.local} fallback=${stats.fallback} localPct=${localPct} ` +
    `localFailures=${stats.localFailures} hookSkipped=${stats.hookSkipped}`
  );
}

export class AnvilSolver implements Solver {
  async solve(
    plan: CandidatePlan,
    state: StateBackend,
    probe: SolverProbe,
    opts: SolveOptions = {},
  ): Promise<ResolvedPlan> {
    const startedAt = Date.now();
    const solverControl = createSolverControl(startedAt, opts);
    return solverControl.run(async () => {
    const deadlineMs = solverControl.deadlineAtMs === Number.POSITIVE_INFINITY
      ? Infinity
      : Math.max(0, solverControl.deadlineAtMs - startedAt);
    const gssMaxTries = opts.gssMaxTries ?? 12;
    const gridHalfWidth = opts.gridHalfWidth ?? 3;
    const finalSimTopN = opts.finalSimTopN ?? 3;
    const quoteSafetyBps = opts.quoteSafetyBps ??
      BigInt(process.env.SEARCHER_QUOTE_SAFETY_BPS ?? "9999");
    const quoteProfitFloorBps = opts.quoteProfitFloorBps ??
      BigInt(process.env.SEARCHER_QUOTE_PROFIT_FLOOR_BPS ?? (process.env.SEARCHER_DRY_RUN === "1" ? "20" : "0"));
    const deferPhase2Sim = opts.deferPhase2Sim ?? false;
    const debugQuotes = process.env.SEARCHER_SOLVER_DEBUG_QUOTES === "1";
    if (opts.strictSession === undefined) {
      throw new Error("solver requires a strict current-source session");
    }
    const strictSession = opts.strictSession;
    const controlledState = solverControl.active
      ? withStateCallControl(state, {
          deadlineAtMs: Number.isFinite(solverControl.deadlineAtMs)
            ? solverControl.deadlineAtMs
            : undefined,
          signal: solverControl.signal,
        })
      : state;
    const adapterWorkControl: AdapterWorkControl = Object.freeze({
      ...(Number.isFinite(solverControl.deadlineAtMs)
        ? { deadlineAtMs: solverControl.deadlineAtMs }
        : {}),
      signal: solverControl.signal,
    });
    const pastDeadline = (): boolean =>
      solverControl.signal.aborted ||
      Date.now() >= solverControl.deadlineAtMs;
    const timing = opts.timing;
    if (timing) {
      timing.quoteMs = 0;
      timing.simMs = 0;
      if (timing.otherMs !== undefined) timing.otherMs = 0;
    }
    const timed = async <T>(
      bucket: "quoteMs" | "simMs",
      label: string,
      fn: () => Promise<T>,
    ): Promise<T> => {
      const timingStarted = Date.now();
      try {
        return await runSolverOperation(solverControl, label, fn);
      } finally {
        if (timing) timing[bucket] += Date.now() - timingStarted;
      }
    };
    const v4QuoteStats = debugQuotes ? newV4QuotePathStats() : undefined;
    let v4QuoteStatsLogged = false;
    const logV4QuoteStatsOnce = (outcome: string): void => {
      if (!debugQuotes || !v4QuoteStats || v4QuoteStatsLogged || v4QuoteStatsTotal(v4QuoteStats) === 0) return;
      v4QuoteStatsLogged = true;
      console.log(
        `[searcher/ac3] solver: v4 quote path ${formatV4QuotePathStats(v4QuoteStats)} ` +
          `outcome=${outcome} path=${pathSummary(plan.tokenPath)}`,
      );
    };

    const flashToken = plan.opportunity.startToken;
    const executor = probe.executor;
    const targetNetProfit = plan.opportunity.targetNetProfit ?? 1n;
    // Anchor the amount search on the victim swap size, expressed in the flash
    // token. The detector stores victimAmountIn in the victim tokenIn units;
    // live opportunities often flash tokenOut (for example WETH), so using the
    // raw 6-decimal stable amount as wei would collapse the grid to dust.
    const rawCenter = await timed("quoteMs", "search-center quote", () =>
      resolveSearchCenter(plan, flashToken, controlledState, {
        executor,
        cache: opts.cache,
        v4QuoteStats,
        strictSession,
        runtimeEvidence: opts.runtimeEvidence,
        adapterWorkControl,
        shouldStop: pastDeadline,
      }),
    );
    const maxFlashAmount = normalizedMaxFlashAmount(plan);
    if (maxFlashAmount !== null && maxFlashAmount <= 0n) {
      throw new Error(`no profitable plan (flash cap is zero)`);
    }
    const isOracleVictim = plan.opportunity.kind === "backrun-arb" &&
      plan.opportunity.victimEffect.kind === "oracle";
    if (isOracleVictim && maxFlashAmount === null) {
      throw new Error("no profitable plan (oracle victim requires a live flash cap)");
    }
    const center = clampToMax(rawCenter, maxFlashAmount);

    // ── Phase 1: quote-only amount search (no Anvil sim) ──────────
    // Closed-loop arb: profitToken == startToken == flashToken, so the quote
    // profit is just (final amount back in flashToken) − flashAmount. Each
    // evaluation is a handful of eth_call quotes, cheap enough to search widely.
    const scored: QuoteCandidate[] = [];
    const quoteFailures = newFailureAttribution();
    let completedQuote = false;
    let quoteCount = 0;
    let lastFailure = "quotes completed but no profitable amount";
    let bestObserved: { flashAmount: bigint; fluidDebtBps: bigint; profit: bigint; amounts: bigint[] } | null = null;

    const quoteProfit = async (flashAmount: bigint, fluidDebtBps: bigint): Promise<bigint> => {
      if (flashAmount <= 0n) return FAIL_SCORE;
      if (maxFlashAmount !== null && flashAmount > maxFlashAmount) return FAIL_SCORE;
      quoteCount++;
      let amounts: bigint[];
      try {
        amounts = await timed("quoteMs", "amount quote propagation", () =>
          propagateAmounts(plan.tokenPath, flashAmount, controlledState, {
            executor,
            fluidDebtBps,
            cache: opts.cache,
            v4QuoteStats,
            strictSession,
            runtimeEvidence: opts.runtimeEvidence,
            adapterWorkControl,
            safetyBps: quoteSafetyBps,
            shouldStop: pastDeadline,
          }),
        );
      } catch (err) {
        recordFailureAttribution(quoteFailures, err);
        lastFailure = `quote failed: ${err instanceof Error ? err.message : String(err)}`;
        return FAIL_SCORE;
      }
      completedQuote = true;
      const profit = amounts[amounts.length - 1] - flashAmount;
      if (!bestObserved || profit > bestObserved.profit) {
        bestObserved = { flashAmount, fluidDebtBps, profit, amounts };
      }
      if (shouldAdmitQuoteCandidate(profit, flashAmount, quoteProfitFloorBps)) {
        scored.push({ flashAmount, fluidDebtBps, quoteProfit: profit });
      }
      return profit;
    };

    for (const fluidDebtBps of strictSession.creditDebtBpsCandidates(
      plan.tokenPath,
    )) {
      if (pastDeadline()) {
        lastFailure = `deadline ${deadlineMs}ms reached during quote search`;
        break;
      }
      // Coarse pass: swap victims use a victim-anchored grid; oracle victims
      // search down from the live flash-liquidity cap.
      const grid = isOracleVictim
        ? oracleSearchGrid(maxFlashAmount!)
        : capGrid(geometricGrid(center, gridHalfWidth), maxFlashAmount);
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
      logV4QuoteStatsOnce("no-profitable");
      const error = new Error(
        `no profitable plan (quote search ${quoteCount} pts, center=${center}): ${lastFailure}`,
      );
      throw completedQuote ? error : terminalSolveError(error, quoteFailures);
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
    const fundingActions = strictSession.fundingActionIds(flashToken);
    if (fundingActions.length === 0) {
      throw new Error(`no strict Funding offer for ${flashToken}`);
    }
    const positiveQuotes = scored.filter((c) => c.quoteProfit > 0n).length;
    const floorQuotes = scored.length - positiveQuotes;

    console.log(
      `[searcher/ac3] solver: quote search ${quoteCount} pts → ` +
        `${positiveQuotes} positive${floorQuotes > 0 ? ` + ${floorQuotes} floor-admitted` : ""}, ` +
        `sim top-${ranked.length} amounts x ${fundingActions.length} flash ` +
        `safetyBps=${quoteSafetyBps} quoteFloorBps=${quoteProfitFloorBps} ` +
        `maxFlash=${maxFlashAmount ?? "unbounded"} ` +
        `path=${pathSummary(plan.tokenPath)}`,
    );
    logV4QuoteStatsOnce("quote-search");

    let best: ResolvedPlan | null = null;
    let bestProfit = FAIL_SCORE;
    const deferredCandidates: ResolvedPlan[] = [];
    const phase2Failures = newFailureAttribution();
    for (const cand of ranked) {
      if (pastDeadline()) {
        lastFailure = `deadline ${deadlineMs}ms reached before sim`;
        break;
      }
      let amounts: bigint[];
      let rawOutputs: bigint[];
      let exactHandles: Awaited<ReturnType<
        typeof propagateAmountsWithRawOutputs
      >>["exactHandles"];
      try {
        const propagated = await timed("simMs", "final amount propagation", () =>
          propagateAmountsWithRawOutputs(plan.tokenPath, cand.flashAmount, controlledState, {
            executor,
            fluidDebtBps: cand.fluidDebtBps,
            cache: opts.cache,
            strictSession,
            runtimeEvidence: opts.runtimeEvidence,
            adapterWorkControl,
            safetyBps: quoteSafetyBps,
            shouldStop: pastDeadline,
          }),
        );
        amounts = propagated.amounts;
        rawOutputs = propagated.rawOutputs;
        exactHandles = propagated.exactHandles;
      } catch (err) {
        recordFailureAttribution(phase2Failures, err);
        lastFailure = `propagation failed: ${err instanceof Error ? err.message : String(err)}`;
        console.log(`[searcher/ac3] solver:   propagation ${lastFailure.slice(0, 200)}`);
        continue;
      }

      const adapters = strictSession.fundingActionIds(
        flashToken,
        cand.flashAmount,
      );
      if (adapters.length === 0) {
        lastFailure =
          `no strict Funding offer for ${flashToken} amount=${cand.flashAmount}`;
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
          resolvedNode = await timed("simMs", "family plan build", () =>
            buildResolvedPlanFromPath(
              plan.tokenPath,
              flashToken,
              cand.flashAmount,
              amounts,
              executor,
              controlledState,
              targetNetProfit,
              flashAdapterId,
              rawOutputs,
              strictSession,
              exactHandles,
            ),
          );
        } catch (err) {
          recordFailureAttribution(phase2Failures, err);
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
          if (!opts.onDeferredCandidates) return candidate;
          deferredCandidates.push(candidate);
          continue;
        }
        if (pastDeadline()) {
          lastFailure = `deadline ${deadlineMs}ms reached before sim`;
          break;
        }
        const sim = await timed(
          "simMs",
          "final simulation",
          () => probe.simulate(candidate),
        );
        if (!sim.success) {
          recordFailureAttribution(
            phase2Failures,
            new Error(sim.revertReason ?? "simulation failed"),
          );
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

    if (deferPhase2Sim && deferredCandidates.length > 0) {
      const frozen = Object.freeze([...deferredCandidates]);
      opts.onDeferredCandidates?.(frozen);
      return frozen[0];
    }
    if (!best) {
      throw terminalSolveError(new Error(
        `no profitable plan (sim'd top-${ranked.length} strict-funded amounts): ${lastFailure}`,
      ), phase2Failures);
    }
    return best;
    });
  }
}

interface SolverControl {
  readonly active: boolean;
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
  run<T>(work: () => Promise<T>): Promise<T>;
}

function createSolverControl(
  startedAtMs: number,
  opts: Pick<SolveOptions, "deadlineMs" | "deadlineAtMs" | "signal">,
): SolverControl {
  const relativeDeadlineAtMs = opts.deadlineMs === undefined ||
      !Number.isFinite(opts.deadlineMs)
    ? Number.POSITIVE_INFINITY
    : startedAtMs + Math.max(0, opts.deadlineMs);
  const requestedAbsoluteDeadline = opts.deadlineAtMs ?? Number.POSITIVE_INFINITY;
  const deadlineAtMs = Math.min(relativeDeadlineAtMs, requestedAbsoluteDeadline);
  const active = Number.isFinite(deadlineAtMs) || opts.signal !== undefined;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abortFromCaller = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new SolverControlError("solver aborted by caller", {
        cause: opts.signal?.reason,
      }));
    }
  };
  opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (opts.signal?.aborted) abortFromCaller();

  if (Number.isFinite(deadlineAtMs) && !controller.signal.aborted) {
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      controller.abort(new SolverControlError("solver absolute deadline reached"));
    } else {
      timer = setTimeout(
        () => controller.abort(
          new SolverControlError("solver absolute deadline reached"),
        ),
        remainingMs,
      );
    }
  }

  return {
    active,
    deadlineAtMs,
    signal: controller.signal,
    async run<T>(work: () => Promise<T>): Promise<T> {
      try {
        if (this.signal.aborted) {
          throw solverControlError(this.signal, "solve");
        }
        // Every asynchronous quote/build/sim boundary below is raced against
        // this control. Await the orchestration itself so it fully unwinds
        // before solve() returns; ignored late family results cannot mutate a
        // caller that has already reused the worker.
        return await work();
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abortFromCaller);
      }
    },
  };
}

function runSolverOperation<T>(
  control: SolverControl,
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!control.active) return work();
  if (control.signal.aborted) {
    return Promise.reject(solverControlError(control.signal, label));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      control.signal.removeEventListener("abort", abort);
      settle();
    };
    const abort = (): void =>
      finish(() => reject(solverControlError(control.signal, label)));
    control.signal.addEventListener("abort", abort, { once: true });
    if (control.signal.aborted) {
      abort();
      return;
    }
    Promise.resolve()
      .then(work)
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
  });
}

class SolverControlError extends Error {
  readonly code = "SOLVER_CONTROL_ABORTED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SolverControlError";
  }
}

function solverControlError(
  signal: AbortSignal,
  label: string,
): SolverControlError {
  return new SolverControlError(
    `${signal.reason instanceof Error ? signal.reason.message : "solver aborted"} during ${label}`,
    { cause: signal.reason },
  );
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
  poolToken0?: string;
  poolToken1?: string;
  /** v4 poolId — disambiguates pools sharing the singleton PoolManager address. */
  poolId?: string;
}

export async function resolveSearchCenter(
  plan: CandidatePlan,
  flashToken: string,
  state: StateBackend,
  options: {
    executor?: string;
    cache?: PoolStateCache;
    v4QuoteStats?: V4QuotePathStats;
    strictSession?: StrictProductionRuntimeSession;
    runtimeEvidence?: readonly RuntimeEvidence[];
    adapterWorkControl?: AdapterWorkControl;
    shouldStop?: () => boolean;
  },
): Promise<bigint> {
  // Block-scan (no source swap): the scanner already sized the loop; use its
  // searchCenter directly (in flashToken units) and skip the victim-amount /
  // impact path entirely. Backrun opportunities fall through unchanged.
  if (plan.opportunity.kind === "block-scan-arb") {
    return plan.opportunity.searchSeed.searchCenter;
  }
  if (plan.opportunity.victimEffect.kind === "oracle") {
    return plan.maxFlashAmount ?? 1n;
  }
  const victimAmount = plan.opportunity.victimAmountIn;
  if (victimAmount <= 0n) return 1n;

  const impact = impactFromOpportunity(plan.opportunity);
  if (!impact) return victimAmount;
  if (options.strictSession === undefined) {
    throw new Error("search-center quote requires a strict current-source session");
  }

  const reverseImpactIndex = findReverseImpactEdgeIndex(plan, impact);
  const impactV4PoolKey = findImpactV4PoolKey(plan, impact);
  if (
    reverseImpactIndex >= 0 &&
    prefixCanBeInverted(plan, reverseImpactIndex, options.strictSession)
  ) {
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
    // The current-source strict session owns this exact quote as well as the
    // later route propagation and execution handle.
    return quoteImpactOutput(impact, victimAmount, state, options, impactV4PoolKey);
  }

  return victimAmount;
}

function prefixCanBeInverted(
  plan: CandidatePlan,
  reverseImpactIndex: number,
  strictSession: StrictProductionRuntimeSession,
): boolean {
  const prefix = plan.tokenPath.edges.slice(0, reverseImpactIndex);
  return !prefix.some((edge) => strictSession.blocksPrefixInversion(edge));
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
  if (!impact.poolId) return undefined;
  return plan.tokenPath?.edges.find((edge) =>
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
  options: {
    executor?: string;
    cache?: PoolStateCache;
    v4QuoteStats?: V4QuotePathStats;
    strictSession?: StrictProductionRuntimeSession;
    runtimeEvidence?: readonly RuntimeEvidence[];
    adapterWorkControl?: AdapterWorkControl;
    shouldStop?: () => boolean;
  },
  v4PoolKey?: V4PoolKey,
): Promise<bigint> {
  if (options.shouldStop?.()) throw new Error("reverse-impact center aborted: deadline reached");
  if (options.strictSession === undefined) {
    throw new Error("victim-impact quote requires a strict current-source session");
  }
  void state;
  void v4PoolKey;
  const edge = options.strictSession.edges.find((candidate) =>
    candidate.adapterId === impact.matchedAdapterId &&
    sameAddress(candidate.target, impact.pool) &&
    sameAddress(candidate.tokenIn, impact.tokenIn) &&
    sameAddress(candidate.tokenOut, impact.tokenOut) &&
    sameV4Pool(candidate.poolId, impact.poolId)
  );
  if (edge === undefined || options.executor === undefined) {
    throw new Error("strict session has no victim-impact quote edge");
  }
  const exact = await options.strictSession.issueExact({
    edge,
    amountIn: victimAmount,
    executor: options.executor,
    runtimeEvidence: options.runtimeEvidence ?? Object.freeze([]),
    ...(options.adapterWorkControl === undefined
      ? {}
      : { control: options.adapterWorkControl }),
  });
  const quoted = exact.amountOut;
  return quoted > 0n ? quoted : 1n;
}

async function approximatePrefixInputForOutput(
  plan: CandidatePlan,
  reverseImpactIndex: number,
  desiredOutput: bigint,
  state: StateBackend,
  options: {
    executor?: string;
    cache?: PoolStateCache;
    v4QuoteStats?: V4QuotePathStats;
    strictSession?: StrictProductionRuntimeSession;
    runtimeEvidence?: readonly RuntimeEvidence[];
    adapterWorkControl?: AdapterWorkControl;
    shouldStop?: () => boolean;
  },
): Promise<bigint> {
  if (desiredOutput <= 0n) return 1n;
  if (options.strictSession === undefined) {
    throw new Error("prefix quote requires a strict current-source session");
  }
  const prefix = { edges: plan.tokenPath.edges.slice(0, reverseImpactIndex) };
  if (prefix.edges.length === 0) return desiredOutput;

  const maxFlash = normalizedMaxFlashAmount(plan);
  const searchCap = maxFlash ?? ((1n << 256n) - 1n);
  const quotePrefix = async (flashAmount: bigint): Promise<bigint> => {
    if (options.shouldStop?.()) throw new Error("reverse-impact center aborted: deadline reached");
    try {
      const amounts = await propagateAmounts(prefix, flashAmount, state, {
        executor: options.executor,
        cache: options.cache,
        v4QuoteStats: options.v4QuoteStats,
        strictSession: options.strictSession,
        runtimeEvidence: options.runtimeEvidence,
        adapterWorkControl: options.adapterWorkControl,
        shouldStop: options.shouldStop,
      });
      return amounts[amounts.length - 1] ?? 0n;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("propagation produced zero at edge ")) {
        return 0n;
      }
      throw error;
    }
  };

  let lo = 0n;
  let hi = clampToMax(desiredOutput, maxFlash);
  let hiOut = await quotePrefix(hi);
  for (let i = 0; i < 64 && hiOut < desiredOutput; i++) {
    if (hi >= searchCap) {
      if (maxFlash !== null) return hi;
      throw new Error(`unable to bracket reverse-impact prefix output ${desiredOutput}`);
    }
    lo = hi;
    hi = hi > searchCap / 16n ? searchCap : hi * 16n;
    if (hi <= lo) throw new Error(`unable to grow reverse-impact prefix input above ${lo}`);
    hiOut = await quotePrefix(hi);
  }
  if (hiOut < desiredOutput) {
    if (maxFlash !== null && hi === maxFlash) return hi;
    throw new Error(`unable to bracket reverse-impact prefix output ${desiredOutput}`);
  }
  // The prefix quote is monotone for the admitted edge families. Find the
  // target within a one-percent input bracket so the geometric grid remains
  // anchored even across large decimal differences.
  for (let i = 0; i < 256 && hi - lo > 1n && (lo === 0n || hi * 100n > lo * 101n); i++) {
    let probe = hiOut > desiredOutput
      ? (hi * desiredOutput) / hiOut
      : (lo + hi) / 2n;
    if (probe <= lo || probe >= hi) probe = (lo + hi) / 2n;
    const out = await quotePrefix(probe);
    if (out < desiredOutput) lo = probe;
    else {
      hi = probe;
      hiOut = out;
    }
  }
  if (hi - lo > 1n && (lo === 0n || hi * 100n > lo * 101n)) {
    throw new Error(`unable to refine reverse-impact prefix input for ${desiredOutput}`);
  }
  return hi;
}

function impactFromOpportunity(opportunity: Opportunity): OpportunityImpact | null {
  if (opportunity.victimEffect.kind !== "swap") return null;
  const impact = opportunity.victimEffect.impact;
  return {
    pool: impact.pool,
    tokenIn: impact.tokenIn,
    tokenOut: impact.tokenOut,
    matchedAdapterId: impact.matchedAdapterId,
    poolToken0: impact.poolToken0,
    poolToken1: impact.poolToken1,
    poolId: impact.poolId,
  };
}

function oracleSearchGrid(maxFlashAmount: bigint): bigint[] {
  const grid: bigint[] = [];
  let amount = maxFlashAmount;
  for (let i = 0; i <= 20 && amount > 0n; i++) {
    grid.push(amount);
    amount /= 2n;
  }
  return capGrid(grid, maxFlashAmount);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
