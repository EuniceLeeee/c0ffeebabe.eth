import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import {
  UNIV4_SWAP_TOPIC,
} from "../../swaps/univ4-abi.js";
import { ADDR } from "../../../../shared/constants/addresses.js";
import { canonicalPoolId } from "./codec.js";

/**
 * Plugin-owned nomination: graph pool entries carry the real poolId as an
 * opaque field. This capability queries the PoolManager singleton with the
 * exact topics [Swap, poolId] in the node's retained log window and returns
 * the real recent Swap log (no historical Initialize backscan). Identity
 * still re-verifies the pool key against the manager before admission.
 */
export async function nominateUniv4(input: {
  readonly nominations: readonly CaptureNominationInput[];
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}): Promise<readonly UnifiedObservation[]> {
  const results: UnifiedObservation[] = [];
  const fromBlock = Math.max(0, input.source.number - NOMINATION_LOG_LOOKBACK);
  for (const nomination of input.nominations) {
    const opaque = nomination.opaque as Readonly<Record<string, unknown>>;
    if (!isUniv4OpaqueLabel(opaque)) continue;
    const poolId = opaquePoolId(opaque);
    if (poolId === null) continue;
    try {
      const logs = await input.provider.getLogs({
        address: ADDR.UNISWAP_V4_POOL_MANAGER,
        fromBlock,
        toBlock: input.source.number,
        topics: [
          UNIV4_SWAP_TOPIC.toLowerCase(),
          poolId.toLowerCase(),
        ],
      });
      const hit = logs.at(-1);
      if (hit === undefined) continue;
      results.push(Object.freeze({
        kind: "log" as const,
        source: input.source,
        address: ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(),
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

function isUniv4OpaqueLabel(
  opaque: Readonly<Record<string, unknown>>,
): boolean {
  const label = opaque.adapter ?? opaque.venueId ?? opaque.adapterId;
  return typeof label === "string" &&
    (label === "univ4" || label === "univ4-standard");
}

function opaquePoolId(
  opaque: Readonly<Record<string, unknown>>,
): string | null {
  const raw = opaque.poolId ?? opaque.id;
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    return null;
  }
  try {
    return canonicalPoolId(String(raw)).toLowerCase();
  } catch {
    return null;
  }
}
