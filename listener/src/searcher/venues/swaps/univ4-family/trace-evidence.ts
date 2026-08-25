import { ethers } from "ethers";
import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { UNIV4_POOL_MANAGER_INTERFACE } from "../univ4-abi.js";
import { v4PoolId } from "../univ4-common.js";
import {
  canonicalAddress,
  canonicalPoolId,
  canonicalPoolKey,
} from "./codec.js";

export function nominationTransactionHash(
  nomination: CaptureNominationInput,
): string | null {
  const value = nomination.evidence?.transactionHash;
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)
    ? value.toLowerCase()
    : null;
}

/**
 * Recover one exact PoolManager.swap observation from the transaction that
 * nominated a poolId. Multi-swap transactions are searched recursively and
 * the calldata-derived PoolKey must hash to the requested poolId; the first
 * unrelated V4 frame can never be borrowed as another pool's identity.
 */
export async function univ4SwapObservationFromTransaction(input: {
  readonly transactionHash: string;
  readonly poolId: string;
  readonly manager: string;
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}): Promise<UnifiedObservation | null> {
  if (input.provider.traceTransaction === undefined) return null;
  const transactionHash = input.transactionHash.toLowerCase();
  const manager = canonicalAddress(input.manager).toLowerCase();
  const poolId = canonicalPoolId(input.poolId).toLowerCase();
  const trace = await input.provider.traceTransaction(transactionHash);
  const frame = findManagerSwapFrame(trace, manager, poolId);
  if (frame === null) return null;
  return Object.freeze({
    kind: "call" as const,
    source: input.source,
    target: manager,
    sender: frame.from.toLowerCase(),
    data: frame.input.toLowerCase(),
    transactionHash,
  });
}

function findManagerSwapFrame(
  raw: unknown,
  manager: string,
  expectedPoolId: string,
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
    typeof frame.from === "string" &&
    ethers.isAddress(frame.from) &&
    typeof frame.input === "string" &&
    ethers.isHexString(frame.input)
  ) {
    try {
      const decoded = UNIV4_POOL_MANAGER_INTERFACE.decodeFunctionData(
        "swap",
        frame.input,
      );
      const key = decoded.key;
      const poolKey = canonicalPoolKey({
        currency0: String(key.currency0),
        currency1: String(key.currency1),
        fee: Number(key.fee),
        tickSpacing: Number(key.tickSpacing),
        hooks: String(key.hooks),
      });
      if (v4PoolId(poolKey).toLowerCase() === expectedPoolId) {
        return Object.freeze({ from: frame.from, input: frame.input });
      }
    } catch {
      // This frame is not a decodable PoolManager.swap; recurse into children.
    }
  }
  if (!Array.isArray(frame.calls)) return null;
  for (const child of frame.calls) {
    const found = findManagerSwapFrame(child, manager, expectedPoolId);
    if (found !== null) return found;
  }
  return null;
}
