import { TemplatePlanner } from "./planner/planner.js";

export const DEFAULT_BACKRUN_MAX_HOPS = 6;

/** Single live policy reader. Historical callers may change environment, not
 * maintain a parallel set of search/solver defaults in a replay script. */
export function resolveLiveBackrunSettings(env: NodeJS.ProcessEnv = process.env) {
  const solverQuoteConcurrency = Number(env.SEARCHER_BACKRUN_SOLVER_QUOTE_CONCURRENCY ?? "16");
  if (!Number.isSafeInteger(solverQuoteConcurrency) || solverQuoteConcurrency < 1 || solverQuoteConcurrency > 64) {
    throw new Error("SEARCHER_BACKRUN_SOLVER_QUOTE_CONCURRENCY must be an integer in [1, 64]");
  }
  const tolerance = env.SEARCHER_BACKRUN_QUOTE_TOLERANCE_ENABLED ?? "1";
  if (!["0", "1", "false", "true"].includes(tolerance)) {
    throw new Error("SEARCHER_BACKRUN_QUOTE_TOLERANCE_ENABLED must be 0, 1, false or true");
  }
  return {
    planner: {
      maxHops: Number(env.SEARCHER_MAX_HOPS ?? DEFAULT_BACKRUN_MAX_HOPS),
      maxCandidates: Number(env.SEARCHER_MAX_CANDIDATES ?? "20"),
      maxPoolsPerToken: Number(env.SEARCHER_MAX_POOLS_PER_TOKEN ?? "8"),
      maxRotationsPerPath: Number(env.SEARCHER_MAX_ROTATIONS_PER_PATH ?? "3"),
    },
    execution: {
      minProfit: BigInt(env.SEARCHER_MIN_PROFIT_RAW ?? "1"),
      forkRefreshBlocks: Number(env.SEARCHER_FORK_REFRESH_BLOCKS ?? "5"),
      solverDeadlineMs: Number(env.SEARCHER_SOLVER_DEADLINE_MS ?? "8000"),
      solverQuoteConcurrency,
      oppTtlMs: Number(env.SEARCHER_OPP_TTL_MS ?? "5000"),
      planBudgetMs: Number(env.SEARCHER_PLAN_BUDGET_MS ?? "300"),
      oppMinSliceMs: Number(env.SEARCHER_OPP_MIN_SLICE_MS ?? "500"),
      gssMaxTries: Number(env.SEARCHER_GSS_MAX_TRIES ?? "12"),
      finalSimTopN: Number(env.SEARCHER_FINAL_SIM_TOP_N ?? "3"),
      maxCandidatesPerOpp: Number(env.SEARCHER_MAX_CANDIDATES_PER_OPP ?? "6"),
      // Never pre-discount a hop's output. Disabling tolerance means exact
      // amounts, not falling back to the legacy percentage haircut.
      quoteSafetyBps: 10000n,
      quoteToleranceRawUnits: tolerance === "1" || tolerance === "true" ? 1n : 0n,
      quoteProfitFloorBps: BigInt(env.SEARCHER_QUOTE_PROFIT_FLOOR_BPS ??
        (env.SEARCHER_DRY_RUN === "1" ? "20" : "0")),
      revmPrewarmRouteHops: Number(env.SEARCHER_REVM_PREWARM_ROUTE_HOPS ?? "0"),
      allowHashOnlySubmit: env.SEARCHER_ALLOW_HASHONLY_SUBMIT === "1",
      allowHashOnlyMevShareSubmit: env.SEARCHER_SUBMIT_HASHONLY_MEVSHARE === "1",
    },
  };
}

export function createLiveBackrunPlanner(env: NodeJS.ProcessEnv = process.env): TemplatePlanner {
  const settings = resolveLiveBackrunSettings(env).planner;
  const planner = new TemplatePlanner();
  planner.setMaxHops(settings.maxHops);
  planner.setMaxCandidates(settings.maxCandidates);
  planner.setMaxPoolsPerToken(settings.maxPoolsPerToken);
  planner.setMaxRotationsPerPath(settings.maxRotationsPerPath);
  return planner;
}
