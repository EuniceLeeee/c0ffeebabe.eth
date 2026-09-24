import { runOrderedBlockScanPipeline } from "./blockscan-ordered-pipeline.js";
import type { CandidatePlan } from "./planner/planner.js";
import type { StateBackend } from "../shared/state/state-backend.js";
import type { ResolvedPlan, Solver, SolveOptions } from "./solver/solver.js";

export type BackrunQuoteResult =
  | { readonly ok: true; readonly finalists: readonly ResolvedPlan[]; readonly elapsedMs: number }
  | { readonly ok: false; readonly error: unknown; readonly elapsedMs: number };

/** Same ordered producer/consumer scheduler as blockscan. Only quote/build work
 * may fan out; the consumer owns mandatory simulation, EV and submission. */
export async function runBackrunCandidatePipeline(input: {
  readonly plans: readonly CandidatePlan[];
  readonly maxCandidates: number;
  readonly concurrency: number;
  readonly solver: Solver;
  readonly state: StateBackend;
  readonly executor: string;
  readonly options: Omit<SolveOptions, "signal" | "deadlineMs" | "deadlineAtMs" |
    "deferPhase2Sim" | "onDeferredCandidates">;
  readonly solverDeadlineMs: number;
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
  readonly onQuoteStart: (index: number) => void;
  readonly consume: (candidate: CandidatePlan, result: BackrunQuoteResult,
    index: number, signal: AbortSignal) => Promise<boolean | void>;
}): Promise<boolean> {
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1 ||
      !Number.isSafeInteger(input.maxCandidates) || input.maxCandidates < 0) {
    throw new Error("invalid backrun candidate scheduling limits");
  }
  const plans = input.maxCandidates === 0 ? input.plans : input.plans.slice(0, input.maxCandidates);
  const quoteOnlyProbe = {
    executor: input.executor,
    async simulate(): Promise<never> { throw new Error("backrun quote worker cannot simulate"); },
  };
  return runOrderedBlockScanPipeline({
    count: plans.length,
    workers: Array.from({ length: Math.min(input.concurrency, plans.length) }, () => input.solver),
    signal: input.signal,
    deadlineAtMs: input.deadlineAtMs,
    produce: async (index, solver, signal): Promise<BackrunQuoteResult> => {
      const started = performance.now();
      input.onQuoteStart(index);
      try {
        let finalists: readonly ResolvedPlan[] = [];
        const solved = await solver.solve(plans[index]!, input.state, quoteOnlyProbe, {
          ...input.options,
          signal,
          deadlineMs: input.solverDeadlineMs,
          deadlineAtMs: input.deadlineAtMs,
          deferPhase2Sim: true,
          onDeferredCandidates: (values) => { finalists = values; },
        });
        return { ok: true, finalists: finalists.length > 0 ? finalists : [solved],
          elapsedMs: performance.now() - started };
      } catch (error) {
        // Route failures do not cancel other candidates; source/deadline aborts
        // are enforced by the shared scheduler before consuming any result.
        return { ok: false, error, elapsedMs: performance.now() - started };
      }
    },
    consume: (index, result, signal) => input.consume(plans[index]!, result, index, signal),
  });
}
