/** Enumeration defaults. Environment overrides are resolved by the live/CLI
 * shared config resolver. 100 bps = 1%; time budgets are milliseconds. */
export const BLOCKSCAN_ENUMERATION_DEFAULTS = {
  rustEnabled: false, // Production dispatch disabled; standalone native diagnostics remain available.
  backend: "typescript" as "rust" | "typescript", // Native dispatch additionally requires rustEnabled.
  rustThreads: 1, // 1 disables parallel search; 2..8 use ordered parallel signal anchors.
  rustScratchMb: 512, // Shared native scratch allowance, not a process RSS limit.
  maxHops: 6,
  refineCandidates: 512, // Returned after coarse enumeration and ranking.
  maxCandidates: 100, // Downstream candidate selection / Planner / Solver.
  budgetMs: 15000,
  method: "joint-dfs" as "joint-dfs" | "dfs" | "layered", // Legacy half-path methods remain explicit rollback choices.
  allowRepeatedPools: true,
  deduplicateRotations: true, // Retain one funded execution start per directed cycle.
  signalPairsPerToken: 20,
  hopTokensPerStep: 2, // Top N distinct next tokens by reference value; 0 keeps all tokens.
  hopPoolsPerPair: 2, // Top M distinct pools per directed pair; 0 keeps all pools/variants.
  minSpreadBps: 100,
  exactAdmissionSpreadBps: 50,
  // Joint DFS shares one reference-value floor across the buy and sell sides.
  // 0 bps keeps equality at 1; negative joint prefixes are pruned. This is a
  // coverage tradeoff, not a proof that a pruned path cannot recover later.
  prefixPruningEnabled: true,
  maxPrefixDrawdownBps: 0,
  minCapitalFraction: 0.001, // Legacy exact-refinement shadow telemetry.
} as const;

export function resolveHopTokensPerStep(raw?: string): number {
  const value = raw === undefined ? BLOCKSCAN_ENUMERATION_DEFAULTS.hopTokensPerStep : Number(raw);
  if ((raw !== undefined && !/^\d+$/.test(raw)) || !Number.isSafeInteger(value) || value < 0)
    throw new Error("SEARCHER_BLOCKSCAN_HOP_TOKENS_PER_STEP must be a nonnegative safe integer (0 disables the token limit)");
  return value;
}

export function resolveHopPoolsPerPair(raw?: string): number {
  const value = raw === undefined ? BLOCKSCAN_ENUMERATION_DEFAULTS.hopPoolsPerPair : Number(raw);
  if ((raw !== undefined && !/^\d+$/.test(raw)) || !Number.isSafeInteger(value) || value < 0)
    throw new Error("SEARCHER_BLOCKSCAN_HOP_POOLS_PER_PAIR must be a nonnegative safe integer (0 disables the pool limit)");
  return value;
}
