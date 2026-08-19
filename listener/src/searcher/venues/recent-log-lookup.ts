import type {
  CaptureNominationProvider,
} from "./adapter-family-plugin.js";
import type { CanonicalSource } from "./adapter-request-program.js";
import { strictEdgeCollectionFromBlock } from
  "../strict-edge-collection-policy.js";

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
  let accepts = 0;
  const maxAccept = Math.max(1, input.maxAccept ?? 32);
  try {
    const logs = await provider.getLogs({
      ...(input.address === undefined ? {} : { address: input.address }),
      fromBlock: strictEdgeCollectionFromBlock(source.number),
      toBlock: source.number,
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
  } catch {
    return null;
  }
  return null;
}
