export type BlockScanActivityMode = "trace" | "logs-shadow";

export interface BlockScanActivitySettings {
  readonly mode: BlockScanActivityMode;
  readonly shadowTimeoutMs: number;
  readonly shadowMaxConcurrent: number;
}

/** Ordinary live and dry-run use logs for refresh and trace for observation.
 * Log absence is not a complete call-coverage proof for durable price journals.
 * Execution simulation and submission gates remain owned by the live pipeline. */
export function resolveBlockScanActivitySettings(
  env: NodeJS.ProcessEnv,
  context: {
    readonly dryRun: boolean;
    readonly blockScanSubmit: boolean;
    readonly enabled: boolean;
    readonly nMinusOne: boolean;
    readonly blindProductionAudit: boolean;
    readonly subsetPriceMode?: "fresh" | "resume";
  },
): BlockScanActivitySettings {
  const mode = env.SEARCHER_BLOCKSCAN_ACTIVITY_MODE ??
    (context.enabled && !context.nMinusOne && !context.blindProductionAudit ? "logs-shadow" : "trace");
  if (mode !== "trace" && mode !== "logs-shadow") {
    throw new Error("SEARCHER_BLOCKSCAN_ACTIVITY_MODE must be trace or logs-shadow");
  }
  if (mode === "trace") return Object.freeze({ mode, shadowTimeoutMs: 20_000, shadowMaxConcurrent: 1 });
  if (!context.enabled) {
    throw new Error("logs-shadow requires SEARCHER_ENABLE_BLOCK_SCAN=1");
  }
  if (context.nMinusOne || context.blindProductionAudit || context.subsetPriceMode !== undefined) {
    throw new Error("logs-shadow supports ordinary source-N live or dry-run only; replay, N-minus-one and Ready price subsets are unsupported");
  }
  if ((env.SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_ENABLED !== undefined &&
      env.SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_ENABLED !== "0") ||
      env.SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_DIR ||
      env.SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_COMPATIBILITY ||
      env.SEARCHER_BLOCKSCAN_LIVE_SUBSET_PARENT_DIR ||
      env.SEARCHER_BLOCKSCAN_LIVE_SUBSET_PARENT_COMPATIBILITY) {
    throw new Error("logs-shadow cannot import or export price continuation; disable continuation and unset its directory/compatibility/parent settings");
  }
  const boundedInteger = (key: string, fallback: number, maximum: number): number => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${key} must be a positive integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > maximum) throw new Error(`${key} must be at most ${maximum}`);
    return value;
  };
  return Object.freeze({ mode,
    shadowTimeoutMs: boundedInteger("SEARCHER_BLOCKSCAN_TRACE_SHADOW_TIMEOUT_MS", 20_000, 120_000),
    shadowMaxConcurrent: boundedInteger("SEARCHER_BLOCKSCAN_TRACE_SHADOW_MAX_CONCURRENT", 1, 4),
  });
}
