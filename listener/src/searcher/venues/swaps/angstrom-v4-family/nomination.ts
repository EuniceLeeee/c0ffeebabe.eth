import { ethers } from "ethers";
import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import {
  UNIV4_SWAP_TOPIC,
} from "../univ4-abi.js";
import { ADDR } from "../../../../shared/constants/addresses.js";
import { ANGSTROM_ADAPTER_SWAP_SELECTOR } from "../angstrom-attestation.js";
import { canonicalPoolId } from "../univ4-family/codec.js";
import { findRecentLogHit } from "../../recent-log-lookup.js";

/**
 * Plugin-owned nomination: graph pool entries carry the real poolId as an
 * opaque field. This capability finds a real recent [Swap, poolId] log in
 * the node's retained window, then traces the log's transaction to recover
 * the real swap calldata frame (Angstrom hook adapter). The returned call
 * observation lets decodeCandidate build the complete PoolKey from real
 * calldata (never guessed from the one-way poolId).
 */
export async function nominateAngstromV4(input: {
  readonly nominations: readonly CaptureNominationInput[];
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}): Promise<readonly UnifiedObservation[]> {
  const results: UnifiedObservation[] = [];
  const manager = ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase();
  for (const nomination of input.nominations) {
    const opaque = nomination.opaque as Readonly<Record<string, unknown>>;
    if (!isAngstromOpaqueLabel(opaque)) continue;
    const poolId = opaquePoolId(opaque);
    if (poolId === null) continue;
    try {
      const hit = await findRecentLogHit({
        provider: input.provider,
        source: input.source,
        address: ADDR.UNISWAP_V4_POOL_MANAGER,
        topics: [
          UNIV4_SWAP_TOPIC.toLowerCase(),
          poolId.toLowerCase(),
        ],
      });
      if (hit === null || hit.transactionHash === undefined) continue;
      if (input.provider.traceTransaction === undefined) continue;
      const trace = await input.provider.traceTransaction(
        hit.transactionHash,
      );
      const frame = findSwapFrame(trace);
      if (frame === null) continue;
      results.push(Object.freeze({
        kind: "call" as const,
        source: input.source,
        target: ethers.getAddress(frame.to).toLowerCase(),
        sender: ethers.getAddress(frame.from).toLowerCase(),
        data: frame.input.toLowerCase(),
        transactionHash: hit.transactionHash.toLowerCase(),
      }));
    } catch {
      // One unreadable nomination must not block the next one.
    }
  }
  return Object.freeze(results);
}

function findSwapFrame(
  raw: unknown,
): { readonly to: string; readonly from: string; readonly input: string } | null {
  if (raw === null || typeof raw !== "object") return null;
  const frame = raw as {
    readonly to?: unknown;
    readonly from?: unknown;
    readonly input?: unknown;
    readonly calls?: unknown;
  };
  if (
    typeof frame.to === "string" &&
    typeof frame.input === "string" &&
    ethers.isHexString(frame.input) &&
    frame.input.length >= 10 &&
    frame.input.slice(0, 10).toLowerCase() ===
      ANGSTROM_ADAPTER_SWAP_SELECTOR.toLowerCase()
  ) {
    if (typeof frame.from !== "string" || !ethers.isAddress(frame.from)) {
      return null;
    }
    return { to: frame.to, from: frame.from, input: frame.input };
  }
  if (Array.isArray(frame.calls)) {
    for (const call of frame.calls) {
      const found = findSwapFrame(call);
      if (found !== null) return found;
    }
  }
  return null;
}

function isAngstromOpaqueLabel(
  opaque: Readonly<Record<string, unknown>>,
): boolean {
  const label = opaque.adapter ?? opaque.venueId ?? opaque.adapterId;
  return typeof label === "string" &&
    (label === "angstrom-v4" || label === "custom-swap:angstrom-v4");
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
