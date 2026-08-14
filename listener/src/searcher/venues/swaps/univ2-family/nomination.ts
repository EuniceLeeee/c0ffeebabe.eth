import { ethers } from "ethers";
import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import {
  UNIV2_FACTORY_INTERFACE,
  UNIV2_PAIR_CREATED_TOPIC,
  UNIV2_PAIR_INTERFACE,
} from "../../swaps/univ2-abi.js";
import { canonicalAddress, lowerAddress } from "./codec.js";

/**
 * Plugin-owned nomination: graph pool entries are opaque nominations. This
 * capability reads the pair's real token0/token1/factory at the source block
 * and re-materializes the real PairCreated log with an exact topic query on
 * the factory (Bloom-indexed; no full log scan). The framework admits the
 * returned observation through catalog.matches + decodeCandidate, and the
 * identity stage re-verifies getPair(token0, token1) == pool.
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
    const pair = UNIV2_PAIR_INTERFACE;
    try {
      const [factoryWord, token0Word, token1Word] = await Promise.all([
        readAddress(pair, "factory", nomination.address, input),
        readAddress(pair, "token0", nomination.address, input),
        readAddress(pair, "token1", nomination.address, input),
      ]);
      if (factoryWord === null || token0Word === null || token1Word === null) {
        continue;
      }
      const topics = [
        UNIV2_PAIR_CREATED_TOPIC.toLowerCase(),
        ethers.zeroPadValue(token0Word, 32).toLowerCase(),
        ethers.zeroPadValue(token1Word, 32).toLowerCase(),
      ];
      const logs = await input.provider.getLogs({
        address: factoryWord,
        fromBlock: 0,
        toBlock: input.source.number,
        topics,
      });
      const hit = logs.find((log) => {
        try {
          const decoded = UNIV2_FACTORY_INTERFACE.decodeEventLog(
            "PairCreated",
            log.data,
            log.topics,
          );
          return lowerAddress(String(decoded.pair)) === pool;
        } catch {
          return false;
        }
      });
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
      // One unreadable nomination must not block the next one. The framework
      // only admits observations that survive matches + decodeCandidate.
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

async function readAddress(
  pair: ethers.Interface,
  functionName: string,
  address: string,
  input: {
    readonly source: CanonicalSource;
    readonly provider: CaptureNominationProvider;
  },
): Promise<string | null> {
  const data = pair.encodeFunctionData(functionName);
  const raw = await input.provider.call(
    { to: address, data },
    input.source.number,
  );
  if (!ethers.isHexString(raw) || ethers.dataLength(raw) !== 32) return null;
  const decoded = pair.decodeFunctionResult(functionName, raw);
  return canonicalAddress(String(decoded[0])).toLowerCase();
}
