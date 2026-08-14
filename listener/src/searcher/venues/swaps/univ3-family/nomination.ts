import { ethers } from "ethers";
import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import {
  UNIV3_FACTORY_INTERFACE,
  UNIV3_POOL_CREATED_TOPIC,
  UNIV3_POOL_INTERFACE,
} from "../../swaps/univ3-abi.js";
import { canonicalAddress, lowerAddress } from "../univ2-family/codec.js";

/**
 * Plugin-owned nomination: reads the pool's real token0/token1/fee/tickSpacing
 * at the source block and re-materializes the real PoolCreated log with an
 * exact topic query on the pool's factory (Bloom-indexed; no full log scan).
 * The identity stage re-verifies getPool(token0, token1, fee) == pool.
 */
export async function nominateUniv3(input: {
  readonly nominations: readonly CaptureNominationInput[];
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}): Promise<readonly UnifiedObservation[]> {
  const results: UnifiedObservation[] = [];
  for (const nomination of input.nominations) {
    const opaque = nomination.opaque as Readonly<Record<string, unknown>>;
    if (!isUniv3OpaqueLabel(opaque)) continue;
    const pool = lowerAddress(nomination.address);
    const poolIface = UNIV3_POOL_INTERFACE;
    try {
      const [factoryWord, token0Word, token1Word, feeWord, tickSpacingWord] =
        await Promise.all([
          readValue(poolIface, "factory", nomination.address, input),
          readValue(poolIface, "token0", nomination.address, input),
          readValue(poolIface, "token1", nomination.address, input),
          readValue(poolIface, "fee", nomination.address, input),
          readValue(poolIface, "tickSpacing", nomination.address, input),
        ]);
      if (
        factoryWord === null || token0Word === null || token1Word === null ||
        feeWord === null || tickSpacingWord === null
      ) {
        continue;
      }
      const fee = BigInt(feeWord);
      if (fee <= 0n || fee > 0xffffffn) continue;
      const topics = [
        UNIV3_POOL_CREATED_TOPIC.toLowerCase(),
        ethers.zeroPadValue(token0Word, 32).toLowerCase(),
        ethers.zeroPadValue(token1Word, 32).toLowerCase(),
        ethers.zeroPadValue(feeWord, 32).toLowerCase(),
      ];
      const logs = await input.provider.getLogs({
        address: factoryWord,
        fromBlock: 0,
        toBlock: input.source.number,
        topics,
      });
      const hit = logs.find((log) => {
        try {
          const decoded = UNIV3_FACTORY_INTERFACE.decodeEventLog(
            "PoolCreated",
            log.data,
            log.topics,
          );
          return lowerAddress(String(decoded.pool)) === pool;
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
      // One unreadable nomination must not block the next one.
    }
  }
  return Object.freeze(results);
}

function isUniv3OpaqueLabel(
  opaque: Readonly<Record<string, unknown>>,
): boolean {
  const label = opaque.adapter ?? opaque.venueId ?? opaque.adapterId;
  return typeof label === "string" &&
    (label === "univ3" || label === "univ3-standard");
}

async function readValue(
  iface: ethers.Interface,
  functionName: string,
  address: string,
  input: {
    readonly source: CanonicalSource;
    readonly provider: CaptureNominationProvider;
  },
): Promise<string | null> {
  const data = iface.encodeFunctionData(functionName);
  const raw = await input.provider.call(
    { to: address, data },
    input.source.number,
  );
  if (!ethers.isHexString(raw) || ethers.dataLength(raw) !== 32) return null;
  return raw.toLowerCase();
}
