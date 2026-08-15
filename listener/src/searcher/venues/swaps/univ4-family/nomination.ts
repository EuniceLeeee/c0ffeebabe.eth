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
import { canonicalPoolId, canonicalPoolKey } from "./codec.js";
import { resolveV4PoolKeyViaPositionManager } from
  "../univ4-pool-discovery.js";

interface RecentUniv4SwapIndex {
  readonly providerId: number;
  readonly sourceNumber: number;
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
 */
let recentUniv4SwapIndex: RecentUniv4SwapIndex | null = null;

async function recentUniv4SwapTxHashByPoolId(input: {
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
  readonly lookback: number;
  readonly chunk: number;
}): Promise<ReadonlyMap<string, string>> {
  if (
    recentUniv4SwapIndex !== null &&
    recentUniv4SwapIndex.providerId === providerId(input.provider) &&
    recentUniv4SwapIndex.sourceNumber === input.source.number
  ) {
    return recentUniv4SwapIndex.poolIdToTxHash;
  }
  const poolIdToTxHash = new Map<string, string>();
  const manager = ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase();
  let to = input.source.number;
  let from = Math.max(0, to - input.chunk + 1);
  for (let guard = 0; guard < 128 && from <= input.source.number; guard++) {
    let chunk = input.chunk;
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
        topics: [UNIV4_SWAP_TOPIC.toLowerCase()],
      });
    } catch {
      if (chunk <= 64) break;
      chunk = Math.floor(chunk / 2);
      from = Math.max(0, to - chunk + 1);
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
    if (input.source.number - to >= input.lookback) break;
    from = Math.max(0, to - input.chunk + 1);
  }
  // Audit log: the recent-log reverse-lookup window/chunk are currently
  // plugin-owned constants (see nominateUniv4 call site). Centralization of
  // these policy knobs is tracked in the F6 Pair B slice; this line makes
  // the values used observable in every run log.
  console.log(
    `[univ4-nomination] recent-swap index sourceBlock=${input.source.number} ` +
      `lookback=${input.lookback} chunk=${input.chunk} poolIds=${poolIdToTxHash.size}`,
  );
  recentUniv4SwapIndex = Object.freeze({
    providerId: providerId(input.provider),
    sourceNumber: input.source.number,
    poolIdToTxHash: Object.freeze(poolIdToTxHash),
  });
  return recentUniv4SwapIndex.poolIdToTxHash;
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
    lookback: 10_000,
    chunk: 500,
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
      // Cold-pool fallback: no Swap in the retained window. Recover the
      // real PoolKey through the PositionManager reverse lookup (chain
      // truth, no transaction needed) and carry it in the address-surface
      // opaque payload. Identity still re-verifies the pool key against
      // the manager at the source block.
      const resolved = await resolveV4PoolKeyViaPositionManager(
        // The reverse lookup passes an AbortSignal control as the second
        // call argument; the nomination provider treats that slot as a
        // block tag, so drop it (single-call, no cancellation needed).
        { call: (req: { to: string; data: string }) =>
            input.provider.call(req, input.source.number) } as never,
        ADDR.UNISWAP_V4_POSITION_MANAGER,
        poolId,
      );
      if (resolved === null) continue;
      const poolKey = canonicalPoolKey({
        currency0: resolved.currency0,
        currency1: resolved.currency1,
        fee: resolved.fee,
        tickSpacing: resolved.tickSpacing,
        hooks: resolved.hooks,
      });
      const code = await input.provider.getCode(
        ADDR.UNISWAP_V4_POOL_MANAGER,
        input.source.number,
      );
      if (!ethers.isHexString(code) || code === "0x") continue;
      results.push(Object.freeze({
        kind: "address-surface" as const,
        source: input.source,
        address: manager,
        codeHash: ethers.keccak256(code).toLowerCase(),
        implementationWord: ethers.zeroPadValue("0x", 32).toLowerCase(),
        interfaceFingerprints: Object.freeze(["univ4-pool-surface-v1"]),
        opaque: Object.freeze({
          poolId: canonicalPoolId(poolId).toLowerCase(),
          poolKey,
        } as never),
      } as never));
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
