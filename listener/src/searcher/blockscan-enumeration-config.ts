/** Enumeration defaults. Environment overrides are resolved by the live/CLI
 * shared config resolver. 100 bps = 1%; time budgets are milliseconds. */
export const BLOCKSCAN_ENUMERATION_DEFAULTS = {
  backend: "typescript" as "rust" | "typescript", // Rust is opt-in until same-input latency/coverage validation passes.
  rustThreads: 1, // 1 disables parallel search; 2..8 use ordered parallel signal anchors.
  rustScratchMb: 512, // Shared native scratch allowance, not a process RSS limit.
  maxHops: 6,
  refineCandidates: 512, // Returned after coarse enumeration and ranking.
  maxCandidates: 100, // Downstream candidate selection / Planner / Solver.
  budgetMs: 1500,
  method: "dfs" as "dfs" | "layered",
  allowRepeatedPools: true,
  deduplicateRotations: true, // Retain one funded execution start per directed cycle.
  signalPairsPerToken: 20,
  minSpreadBps: 100,
  exactAdmissionSpreadBps: 50,
  // Optional coverage tradeoff: every signal-rooted prefix must retain at
  // least 90% of its starting reference value at the default 1000 bps.
  prefixPruningEnabled: false,
  maxPrefixDrawdownBps: 1000,
  minCapitalFraction: 0.001, // Legacy exact-refinement shadow telemetry.
} as const;
