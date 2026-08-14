import { ethers } from "ethers";
import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import {
  UNIV4_INITIALIZE_TOPIC,
  UNIV4_POOL_MANAGER_INTERFACE,
} from "../../swaps/univ4-abi.js";
import {
  UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK,
  v4PoolId,
} from "../../swaps/univ4-common.js";
import { ADDR } from "../../../../shared/constants/addresses.js";
import { canonicalPoolId } from "./codec.js";

/**
 * Plugin-owned nomination: graph pool entries for V4 already carry the real
 * poolId as an opaque field. This capability queries the PoolManager singleton
 * with the exact topics [Initialize, poolId] (Bloom-indexed; no full scan) and
 * returns the real Initialize log. The identity stage re-verifies the pool key
 * from the log against the manager.
 */
export async function nominateUniv4(input: {
  readonly nominations: readonly CaptureNominationInput[];
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}): Promise<readonly UnifiedObservation[]> {
  const results: UnifiedObservation[] = [];
  for (const nomination of input.nominations) {
    const opaque = nomination.opaque as Readonly<Record<string, unknown>>;
    if (!isUniv4OpaqueLabel(opaque)) continue;
    const poolId = opaquePoolId(opaque);
    if (poolId === null) continue;
    try {
      const logs = await input.provider.getLogs({
        address: ADDR.UNISWAP_V4_POOL_MANAGER,
        fromBlock: UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK,
        toBlock: input.source.number,
        topics: [
          UNIV4_INITIALIZE_TOPIC.toLowerCase(),
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
