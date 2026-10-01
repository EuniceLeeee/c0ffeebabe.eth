import type { Solver, SolveOptions, ResolvedPlan } from "../solver/solver.js";
import { searchSimAmounts, type AmountSimulation } from "./sim-amount-search.js";

type Plan = Parameters<Solver["solve"]>[0];
type State = Parameters<Solver["solve"]>[1];
type Probe = Parameters<Solver["solve"]>[2];
export type TrialControl = { signal: AbortSignal; deadlineAtMs: number };

export class SimAmountNoOpportunityError extends Error {
  constructor(readonly status: "complete" | "p-nonpositive" | "deadline") {
    super("sim selector found no positive executable amount");
    this.name = "SimAmountNoOpportunityError";
  }
}

/** The runtime supplies authenticated quote/build/sim. This object only selects
 * amounts; the production caller still owns independent final simulation/EV. */
export function createSimAmountSelector(input: {
  evaluate(plan: Plan, amount: bigint, state: State, probe: Probe,
    opts: SolveOptions, control: TrialControl): Promise<AmountSimulation<ResolvedPlan>>;
  record?(event: Record<string, unknown>): void;
}): Solver {
  let sequence = 0;
  return {
    async solve(plan, state, probe, opts = {}) {
      const searchId = ++sequence;
      const record = (event: Record<string, unknown>) => input.record?.({ ...event, searchId });
      const settings = opts as SolveOptions & { blockScanAmountGrid?: string };
      if (plan.opportunity.kind !== "block-scan-arb" || !opts.deferPhase2Sim ||
          !opts.strictSession || settings.blockScanAmountGrid === "geometric") {
        throw new Error("sim selector requires blockscan multiples and deferred final verification");
      }
      const p = plan.opportunity.searchSeed.searchCenter;
      if (plan.maxFlashAmount === undefined) throw new Error("sim selector requires verified funding cap");
      const deadlineAtMs = Math.min(opts.deadlineAtMs ?? Infinity,
        Date.now() + (opts.deadlineMs ?? Infinity));
      if (!Number.isSafeInteger(deadlineAtMs)) throw new Error("sim selector requires finite deadline");
      if (opts.timing) Object.assign(opts.timing, {
        quoteMs: 0, planBuildMs: 0, simMs: 0, amountPoints: 0, gssPoints: 0, hopExactCalls: 0,
      });
      const start = performance.now();
      const search = await searchSimAmounts({ p, maxInput: plan.maxFlashAmount,
        deadlineAtMs, signal: opts.signal, gssMaxTries: opts.gssMaxTries ?? 8, concurrency: 3,
        evaluate: async (amount, control) => {
          if (opts.timing) opts.timing.amountPoints++;
          return input.evaluate(plan, amount, state, probe, opts, control);
        },
        onTrial: trial => {
          if (opts.timing && trial.phase === "refine") opts.timing.gssPoints++;
          record({ type: "amount_trial", amount: trial.amount, phase: trial.phase,
            wallMs: trial.wallMs, success: trial.result.success,
            profit: trial.result.success ? trial.result.profit : undefined });
        },
      });
      // External cancellation never publishes partial results. An own deadline
      // can return drained best-so-far, just as the ordinary amount selector.
      opts.signal?.throwIfAborted();
      const candidates = search.candidates.slice(0, opts.finalSimTopN ?? 3).map(trial => {
        if (!trial.result.success) throw new Error("invalid profitable trial");
        return trial.result.value;
      });
      record({ type: "amount_search", status: search.status,
        wallMs: performance.now() - start, trials: search.trials.length,
        selected: candidates.map(x => ({ amount: x.flashAmount, profit: x.netProfit })) });
      if (!candidates.length) throw new SimAmountNoOpportunityError(search.status);
      opts.onDeferredCandidates?.(candidates);
      return candidates[0]!;
    },
  };
}

/** Shared by all amount-search workers, including queue cancellation. A slot
 * stays owned until its request settles; expiry cannot overbook the provider. */
export function createTrialLimiter(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("invalid trial concurrency");
  let active = 0;
  const queue: Array<() => void> = [];
  return async function run<T>(control: TrialControl, work: () => Promise<T>): Promise<T> {
    const check = () => {
      control.signal.throwIfAborted();
      if (Date.now() >= control.deadlineAtMs) throw new Error("trial slot deadline");
    };
    check();
    if (active >= limit) await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const i = queue.indexOf(grant);
        if (i !== -1) queue.splice(i, 1);
        reject(control.signal.reason);
      };
      const grant = () => {
        control.signal.removeEventListener("abort", abort);
        active++;
        resolve();
      };
      queue.push(grant);
      control.signal.addEventListener("abort", abort, { once: true });
      if (control.signal.aborted) abort();
    });
    else active++;
    try { check(); return await work(); }
    finally { active--; queue.shift()?.(); }
  };
}
