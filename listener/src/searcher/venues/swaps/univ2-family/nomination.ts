import { ethers } from "ethers";
import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import {
  UNIV2_SWAP_TOPIC,
} from "../../swaps/univ2-abi.js";
import { lowerAddress } from "./codec.js";
import { findRecentLogHit } from "../../recent-log-lookup.js";

/**
 * Plugin-owned nomination: graph pool entries are opaque nominations. The
 * capability re-materializes a real recent Swap log emitted by the pool
 * itself (topics + txHash from the node's retained log window; no historical
 * PairCreated backscan). Identity still re-verifies the pair on chain
 * (factory/getPair) before admission.
 */
export async function nominateUniv2(input: {
  readonly nominations: readonly CaptureNominationInput[];
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}): Promise<readonly UnifiedObservation[]> {
  const results: UnifiedObservation[] = [];
  for (const nomination of input.nominations) {
    const opaque = nomination.opaque as Readonly<Record<string, unknown>>;
    if (!isUniv2OpaqueLabel(opaque)) continue;
    const pool = lowerAddress(nomination.address);
    try {
      const hit = await findRecentLogHit({
        provider: input.provider,
        source: input.source,
        address: pool,
        topics: [UNIV2_SWAP_TOPIC.toLowerCase()],
      });
      if (hit !== null) {
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
        continue;
      }
      // Cold-pool fallback: no Swap in the retained window. Re-materialize
      // the pair surface directly (deployed code + interface fingerprint);
      // identity still re-verifies on chain (factory/token0/token1 +
      // getPair reverse binding) before admission. No transaction needed.
      const code = await input.provider.getCode(pool, input.source.number);
      if (ethers.isHexString(code) && code !== "0x") {
        results.push(Object.freeze({
          kind: "address-surface" as const,
          source: input.source,
          address: pool,
          codeHash: ethers.keccak256(code).toLowerCase(),
          implementationWord: ethers.zeroPadValue("0x", 32).toLowerCase(),
          interfaceFingerprints: Object.freeze(["univ2-pair-surface-v1"]),
        } as never));
      }
    } catch {
      // One unreadable nomination must not block the next one.
    }
  }
  return Object.freeze(results);
}

function isUniv2OpaqueLabel(
  opaque: Readonly<Record<string, unknown>>,
): boolean {
  const label = opaque.adapter ?? opaque.venueId ?? opaque.adapterId;
  return typeof label === "string" &&
    (label === "univ2" || label === "univ2-standard");
}
