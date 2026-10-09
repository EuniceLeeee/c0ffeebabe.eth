import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { findRecentLogHit } from "../../recent-log-lookup.js";
import { ALGEBRA_SWAP_TOPIC } from "./abi.js";
import { lowerAddress } from "./codec.js";
import { isAlgebraOpaqueLabel } from "./reverse-binding.js";

/**
 * Plugin-owned nomination: opaque graph pool entries are re-materialized into a
 * real recent `Swap` log emitted by the pool itself from the node's retained log
 * window (no historical factory backscan). Identity still re-verifies the pool on
 * chain — `factory.poolByPair(token0, token1)` must return it — before admission.
 */
export async function nominateAlgebraIntegral(input: {
  readonly nominations: readonly CaptureNominationInput[];
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}): Promise<readonly UnifiedObservation[]> {
  const results: UnifiedObservation[] = [];
  for (const nomination of input.nominations) {
    const opaque = nomination.opaque as Readonly<Record<string, unknown>>;
    if (!isAlgebraOpaqueLabel(opaque)) continue;
    const pool = lowerAddress(nomination.address);
    try {
      const hit = await findRecentLogHit({
        provider: input.provider,
        source: input.source,
        address: pool,
        topics: [ALGEBRA_SWAP_TOPIC],
      });
      if (hit === null) continue;
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
