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
  /**
   * Optional acceptance check applied newest-first. A recent log whose
   * transaction does not carry the plugin's declared call frame (e.g. a
   * plain manager swap for a hook-backed pool) is skipped and the next
   * newer log is tried. Plugin-owned semantics; the framework only walks.
   */
  readonly accept?: (entry: RecentLogEntry) => Promise<boolean>;
  /** Upper bound on accept() calls (default 32). */
  readonly maxAccept?: number;
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
  // Local reth getLogs cost scales superlinearly with range size: a 5000-block
  // slice takes ~1s while 500 blocks takes ~50ms. The framework helper is
  // protocol-agnostic and slices into small chunks so plugin nominations
  // (univ2/univ3 recent-log reverse lookup) stay fast on the node.
  let chunk = Math.min(Math.max(1, input.chunk ?? 500), lookback);
  let to = source.number;
  let from = Math.max(0, to - chunk + 1);
  let accepts = 0;
  const maxAccept = Math.max(1, input.maxAccept ?? 32);
  for (let guard = 0; guard < 64 && from <= source.number; guard++) {
    try {
      const logs = await provider.getLogs({
        ...(input.address === undefined ? {} : { address: input.address }),
        fromBlock: from,
        toBlock: to,
        topics: input.topics,
      });
      for (let index = logs.length - 1; index >= 0; index--) {
        const raw = logs[index];
        const entry: RecentLogEntry = {
          address: raw.address,
          topics: raw.topics,
          data: raw.data,
          ...(raw.transactionHash === undefined
            ? {}
            : { transactionHash: raw.transactionHash }),
        };
        if (input.accept === undefined) return entry;
        accepts += 1;
        if (accepts > maxAccept) return null;
        if (await input.accept(entry)) return entry;
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
