import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import {
  UNIV3_SWAP_TOPIC,
} from "../../swaps/univ3-abi.js";
import { lowerAddress } from "../univ2-family/codec.js";

/**
 * Plugin-owned nomination: graph pool entries are opaque nominations. The
 * capability re-materializes a real recent Swap log emitted by the pool
 * itself from the node's retained log window (no historical PoolCreated
 * backscan). Identity still re-verifies the pool on chain
 * (getPool(token0, token1, fee)) before admission.
 */
export async function nominateUniv3(input: {
  readonly nominations: readonly CaptureNominationInput[];
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}): Promise<readonly UnifiedObservation[]> {
  const results: UnifiedObservation[] = [];
  const fromBlock = Math.max(0, input.source.number - NOMINATION_LOG_LOOKBACK);
  for (const nomination of input.nominations) {
    const opaque = nomination.opaque as Readonly<Record<string, unknown>>;
    if (!isUniv3OpaqueLabel(opaque)) continue;
    const pool = lowerAddress(nomination.address);
    try {
      const logs = await input.provider.getLogs({
        address: pool,
        fromBlock,
        toBlock: input.source.number,
        topics: [UNIV3_SWAP_TOPIC.toLowerCase()],
      });
      const hit = logs.at(-1);
      if (hit === undefined) continue;
      results.push(Object.freeze({
        kind: "log" as const,
        source: input.source,
        address: lowerAddress(hit.address),
        topics: Object.freeze(hit.topics.map((topic) => topic.toLowerCase())),
        data: hit.data.toLowerCase(),
        ...(hit.transactionHash === undefined
          ? {}
          : { transactionHash: hit.transactionHash.toLowerCase() }),
      }));
    } catch {
      // One unreadable nomination must not block the next one.
    }
  }
  return Object.freeze(results);
}

const NOMINATION_LOG_LOOKBACK = 100_000;

function isUniv3OpaqueLabel(
  opaque: Readonly<Record<string, unknown>>,
): boolean {
  const label = opaque.adapter ?? opaque.venueId ?? opaque.adapterId;
  return typeof label === "string" &&
    (label === "univ3" || label === "univ3-standard");
}
