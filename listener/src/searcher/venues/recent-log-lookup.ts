import type {
  CaptureNominationProvider,
} from "./adapter-family-plugin.js";
import type { CanonicalSource } from "./adapter-request-program.js";

export interface RecentLogEntry {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly transactionHash?: string;
}

export interface RecentLogQuery {
  readonly provider: CaptureNominationProvider;
  readonly source: CanonicalSource;
  readonly address?: string;
  readonly topics: readonly (string | null)[];
  /** Total lookback window from the source block (default 100_000). */
  readonly lookback?: number;
  /**
   * Chunk the window into slices (default 5_000 blocks) so a high-volume
   * emitter never exceeds the node's eth_getLogs result cap; the newest
   * non-empty slice wins. A slice that still overflows is retried at half
   * the chunk size so the oldest activity stays reachable.
   */
  readonly chunk?: number;
}

/**
 * Framework-level helper (no protocol semantics): returns the most recent
 * log entry matching the query within the retained window, or null. Used by
 * plugin-owned nominations that reverse-lookup a recent real log; the plugin
 * still decides how to interpret the entry.
 */
export async function findRecentLogHit(
  input: RecentLogQuery,
): Promise<RecentLogEntry | null> {
  const { provider, source } = input;
  const lookback = Math.max(1, input.lookback ?? 100_000);
  let chunk = Math.min(Math.max(1, input.chunk ?? 5_000), lookback);
  let to = source.number;
  let from = Math.max(0, to - chunk + 1);
  for (let guard = 0; guard < 64 && from <= source.number; guard++) {
    try {
      const logs = await provider.getLogs({
        ...(input.address === undefined ? {} : { address: input.address }),
        fromBlock: from,
        toBlock: to,
        topics: input.topics,
      });
      if (logs.length > 0) {
        const hit = logs[logs.length - 1];
        return {
          address: hit.address,
          topics: hit.topics,
          data: hit.data,
          ...(hit.transactionHash === undefined
            ? {}
            : { transactionHash: hit.transactionHash }),
        };
      }
      // Empty slice: step further back.
      to = from - 1;
      from = Math.max(0, to - chunk + 1);
      continue;
    } catch {
      // Slice overflowed the node cap: retry the same window at half size.
      if (chunk <= 64) return null;
      chunk = Math.floor(chunk / 2);
      from = Math.max(0, to - chunk + 1);
      continue;
    }
  }
  return null;
}
