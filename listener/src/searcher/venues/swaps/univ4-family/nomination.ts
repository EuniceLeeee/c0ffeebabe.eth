import { ethers } from "ethers";
import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import {
  UNIV4_SWAP_SELECTOR,
  UNIV4_SWAP_TOPIC,
} from "../../swaps/univ4-abi.js";
import { ADDR } from "../../../../shared/constants/addresses.js";
import { canonicalPoolId } from "./codec.js";

/**
 * Plugin-owned nomination: graph pool entries carry the real poolId as an
 * opaque field. This capability finds a real recent Swap log for that poolId
 * in the node's retained window, then traces the log's transaction to recover
 * the real PoolManager.swap calldata frame. The returned manager-swap call
 * observation lets decodeCandidate build the complete PoolKey from real
 * calldata (never guessed from the one-way poolId). Identity still re-verifies
 * the pool key against the manager at the source block.
 */
export async function nominateUniv4(input: {
  readonly nominations: readonly CaptureNominationInput[];
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}): Promise<readonly UnifiedObservation[]> {
  const results: UnifiedObservation[] = [];
  const fromBlock = Math.max(0, input.source.number - NOMINATION_LOG_LOOKBACK);
  const manager = ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase();
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
      if (hit === undefined || hit.transactionHash === undefined) continue;
      if (input.provider.traceTransaction === undefined) continue;
      const trace = await input.provider.traceTransaction(
        hit.transactionHash,
      );
      const frame = findManagerSwapFrame(trace, manager);
      if (frame === null) continue;
      results.push(Object.freeze({
        kind: "call" as const,
        source: input.source,
        target: manager,
        sender: frame.from.toLowerCase(),
        data: frame.input.toLowerCase(),
        transactionHash: hit.transactionHash.toLowerCase(),
      }));
    } catch {
      // One unreadable nomination must not block the next one.
    }
  }
  return Object.freeze(results);
}

function findManagerSwapFrame(
  raw: unknown,
  manager: string,
): { readonly from: string; readonly input: string } | null {
  if (raw === null || typeof raw !== "object") return null;
  const frame = raw as {
    readonly to?: unknown;
    readonly from?: unknown;
    readonly input?: unknown;
    readonly calls?: unknown;
  };
  if (
    typeof frame.to === "string" &&
    frame.to.toLowerCase() === manager &&
    typeof frame.input === "string" &&
    ethers.isHexString(frame.input) &&
    frame.input.length >= 10
  ) {
    // swap((address,address,uint24,int24,address),(bool,int256,uint160),bytes)
    if (frame.input.slice(0, 10).toLowerCase() === UNIV4_SWAP_SELECTOR) {
      if (typeof frame.from !== "string" || !ethers.isAddress(frame.from)) {
        return null;
      }
      return { from: ethers.getAddress(frame.from), input: frame.input };
    }
  }
  if (Array.isArray(frame.calls)) {
    for (const call of frame.calls) {
      const found = findManagerSwapFrame(call, manager);
      if (found !== null) return found;
    }
  }
  return null;
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
