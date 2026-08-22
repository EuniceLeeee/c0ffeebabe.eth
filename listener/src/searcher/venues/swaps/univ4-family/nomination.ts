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
import {
  isUniv4OpaqueLabel,
  opaquePoolId,
} from "./reverse-binding.js";
import { DORMANCY_NOMINATION_WINDOW_BLOCKS } from
  "../../../strict-edge-collection-policy.js";

interface RecentUniv4SwapIndex {
  /**
   * Full identity key of the window this index covers. Different cutoff
   * hashes, managers, topics, lookback or chunk never share an index.
   */
  readonly key: string;
  /** Newest Swap transaction hash per poolId within the retained window. */
  readonly poolIdToTxHash: ReadonlyMap<string, string>;
}

const providerIdByProvider = new WeakMap<object, number>();
let nextProviderId = 0;

function providerId(provider: CaptureNominationProvider): number {
  let id = providerIdByProvider.get(provider);
  if (id === undefined) {
    id = nextProviderId++;
    providerIdByProvider.set(provider, id);
  }
  return id;
}

/**
 * Plugin-owned source-keyed cache: retained/startup attestation visits one
 * candidate at a time, and a per-candidate recent-log scan would replay the
 * same manager-wide window thousands of times (each cold pool = ~20 getLogs
 * on the local node). Scanning the window once per source block and indexing
 * poolId -> newest Swap tx keeps the nomination evidence identical (same
 * newest log, same trace) while making cold lookups O(1) in memory.
 *
 * The cache key covers the full window identity (provider + source number +
 * source hash + manager + topic0 + lookback + chunk), so a different
 * cutoff/hash, manager, topic or window shape never reuses an index. Settled
 * and in-flight indexes are kept in separate maps: concurrent cold callers
 * share one build (audit P1), a failed build never poisons the settled
 * cache (the next call retries), and two different keys never interfere.
 */
const settledIndexes = new Map<string, RecentUniv4SwapIndex>();
const inFlightIndexes = new Map<string, Promise<RecentUniv4SwapIndex>>();

function recentSwapIndexKey(input: {
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
  readonly manager: string;
  readonly topic0: string;
  readonly lookback: number;
  readonly chunk: number;
}): string {
  return JSON.stringify(Object.freeze({
    providerId: providerId(input.provider),
    sourceNumber: input.source.number,
    sourceHash: input.source.hash.toLowerCase(),
    manager: input.manager.toLowerCase(),
    topic0: input.topic0.toLowerCase(),
    lookback: input.lookback,
    chunk: input.chunk,
  }));
}

async function recentUniv4SwapTxHashByPoolId(input: {
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
  readonly manager: string;
  readonly topic0: string;
  readonly lookback: number;
  readonly chunk: number;
}): Promise<ReadonlyMap<string, string>> {
  const key = recentSwapIndexKey(input);
  const settled = settledIndexes.get(key);
  if (settled !== undefined) return settled.poolIdToTxHash;
  const running = inFlightIndexes.get(key);
  if (running !== undefined) return (await running).poolIdToTxHash;
  const promise = buildRecentUniv4SwapIndex(input)
    .then((index) => {
      settledIndexes.set(key, index);
      return index;
    })
    .finally(() => {
      // Never clear a newer promise started for the same key.
      if (inFlightIndexes.get(key) === promise) {
        inFlightIndexes.delete(key);
      }
    });
  inFlightIndexes.set(key, promise);
  return (await promise).poolIdToTxHash;
}

async function buildRecentUniv4SwapIndex(input: {
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
  readonly manager: string;
  readonly topic0: string;
  readonly lookback: number;
  readonly chunk: number;
}): Promise<RecentUniv4SwapIndex> {
  const poolIdToTxHash = new Map<string, string>();
  const manager = input.manager.toLowerCase();
  const windowFrom = Math.max(
    0,
    input.source.number - input.lookback + 1,
  );
  let to = input.source.number;
  let chunk = Math.min(input.chunk, input.lookback);
  let from = Math.max(windowFrom, to - chunk + 1);
  let scanFailed = false;
  // chunk persists across iterations so a failing slice really halves; a
  // per-iteration reset would retry the same full slice 128 times and then
  // cache a partial/empty index as settled.
  for (let guard = 0; guard < 128 && from <= input.source.number; guard++) {
    let logs: readonly {
      readonly address: string;
      readonly topics: readonly string[];
      readonly data: string;
      readonly transactionHash?: string;
    }[] = [];
    try {
      logs = await input.provider.getLogs({
        address: manager,
        fromBlock: from,
        toBlock: to,
        topics: [input.topic0.toLowerCase()],
      });
    } catch {
      if (chunk <= 64) {
        // A hard scan failure must not settle a partial/empty index: the
        // contract is fail-retryable, never poisoned-cache.
        scanFailed = true;
        break;
      }
      chunk = Math.floor(chunk / 2);
      from = Math.max(windowFrom, to - chunk + 1);
      continue;
    }
    // Newest slice first; keep the first (newest) tx hash per poolId.
    for (let index = logs.length - 1; index >= 0; index--) {
      const log = logs[index];
      const poolId = log.topics[1]?.toLowerCase();
      if (poolId === undefined || poolId.length !== 66) continue;
      if (poolIdToTxHash.has(poolId)) continue;
      if (log.transactionHash === undefined) continue;
      poolIdToTxHash.set(poolId, log.transactionHash.toLowerCase());
    }
    to = from - 1;
    if (to < windowFrom) break;
    chunk = Math.min(input.chunk, to - windowFrom + 1);
    from = Math.max(windowFrom, to - chunk + 1);
  }
  // Keep the shared production window visible in runtime evidence.
  console.log(
    `[univ4-nomination] recent-swap index sourceBlock=${input.source.number} ` +
      `lookback=${input.lookback} chunk=${input.chunk} poolIds=${poolIdToTxHash.size}`,
  );
  if (scanFailed) {
    throw new Error(
      "univ4 recent-swap index scan failed (retryable, cache untouched)",
    );
  }
  const key = recentSwapIndexKey(input);
  return Object.freeze({
    key,
    poolIdToTxHash: Object.freeze(poolIdToTxHash),
  });
}

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
  // Fast path: a non-univ4 opaque nomination (e.g. a univ2/univ3 activity
  // pool during universe enrich) must not pay for the manager-wide swap
  // index. The plugin declares which opaque labels it owns; the framework
  // feeds every family every nomination.
  if (
    !input.nominations.some((nomination) =>
      isUniv4OpaqueLabel(
        nomination.opaque as Readonly<Record<string, unknown>>,
      )
    )
  ) {
    return Object.freeze(results);
  }
  const manager = ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase();
  const poolIdToTxHash = await recentUniv4SwapTxHashByPoolId({
    source: input.source,
    provider: input.provider,
    manager,
    topic0: UNIV4_SWAP_TOPIC,
    lookback: DORMANCY_NOMINATION_WINDOW_BLOCKS,
    chunk: DORMANCY_NOMINATION_WINDOW_BLOCKS,
  });
  for (const nomination of input.nominations) {
    const opaque = nomination.opaque as Readonly<Record<string, unknown>>;
    if (!isUniv4OpaqueLabel(opaque)) continue;
    const poolId = opaquePoolId(opaque);
    if (poolId === null) continue;
    try {
      const transactionHash = poolIdToTxHash.get(poolId.toLowerCase());
      if (transactionHash !== undefined &&
        input.provider.traceTransaction !== undefined
      ) {
        const trace = await input.provider.traceTransaction(
          transactionHash,
        );
        const frame = findManagerSwapFrame(trace, manager);
        if (frame !== null) {
          results.push(Object.freeze({
            kind: "call" as const,
            source: input.source,
            target: manager,
            sender: frame.from.toLowerCase(),
            data: frame.input.toLowerCase(),
            transactionHash,
          }));
          continue;
        }
      }
      // Cold-pool fallback no longer lives here: the retain channel
      // (PositionManager reverse binding, no recent activity needed) is a
      // plugin-owned reverseBinding capability and the central retained
      // attestation decides when it runs before this fresh channel. The
      // fresh channel only carries real recent-observation evidence.
      continue;
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
