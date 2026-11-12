export type BlockScanActivityMode = "trace" | "logs-shadow";

export interface BlockScanActivitySettings {
  readonly mode: BlockScanActivityMode;
  readonly shadowTimeoutMs: number;
  readonly shadowMaxConcurrent: number;
}

/** Select only the touched reader. Pricing, reorg recovery, continuation and
 * execution keep their existing production contracts in either mode. */
export function resolveBlockScanActivitySettings(env: NodeJS.ProcessEnv): BlockScanActivitySettings {
  const mode = env.SEARCHER_BLOCKSCAN_ACTIVITY_MODE ?? "logs-shadow";
  if (mode !== "trace" && mode !== "logs-shadow") {
    throw new Error("SEARCHER_BLOCKSCAN_ACTIVITY_MODE must be trace or logs-shadow");
  }
  if (mode === "trace") return Object.freeze({ mode, shadowTimeoutMs: 20_000, shadowMaxConcurrent: 1 });
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
