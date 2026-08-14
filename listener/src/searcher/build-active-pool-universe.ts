import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import type { PoolEntry } from "./planner/token-graph.js";
import { selectArbRelevantPools, type RankablePool } from "./pool-universe-arb-relevance.js";
import {
  DEFAULT_POOL_UNIVERSE_PATH,
  parsePoolUniverseJson,
  poolRegistryKey,
  type PoolUniverseEntry,
  type PoolUniverseFile,
} from "./pool-universe.js";
import type {
  PoolIdentityFailureReason,
  PoolIdentityResult,
} from "./venues/identity.js";
import { attestPoolsStrictFromProvider } from "./strict-identity-attestation.js";
import type { VenueId } from "./venues/capability.js";
import type { VenueIdentitySource } from "./venues/identity.js";
import { PRODUCTION_IDENTITY_ADMISSION } from "./venues/admission.js";
import {
  PRODUCTION_ADAPTER_FAMILIES,
  PRODUCTION_IDENTITY_RESOLVERS,
  productionPoolUniverseSourceFingerprintsStrict,
} from "./venues/production-registry.js";
import {
  discoverLandedPools,
  type LandedPoolActivity,
  type LandedPoolDiscoveryLogFilter,
  type LandedPoolDiscoveryReadBackend,
} from "./venues/landed-pool-discovery.js";
import { retainVerifiedSwapFamilyInstances } from "./venues/swap-family-inventory.js";
import { UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK } from "./venues/swaps/univ4-common.js";
import { resolveCurveUnderlyingMetadata } from "./venues/curve-underlying.js";

const BLOCKS_PER_DAY = 7200;
export const DEFAULT_POOL_UNIVERSE_MIN_SWAPS = 1;
export const POOL_UNIVERSE_BUILD_MANIFEST_PROFILE =
  "pool-universe-build-manifest-v1" as const;
const univ2Iface = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);
const univ3Iface = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
]);

interface DiscoveryQueueEntry {
  addr?: unknown;
  class?: unknown;
  source?: unknown;
}

type ProbedPoolShape =
  | {
      adapter: "univ3";
      token0: string;
      token1: string;
      fee: number;
      tickSpacing: number;
      venueId: PoolUniverseEntry["venueId"];
      factory: string;
      identitySource: PoolUniverseEntry["identitySource"];
    }
  | {
      adapter: "univ2";
      token0: string;
      token1: string;
      venueId: PoolUniverseEntry["venueId"];
      factory: string;
      identitySource: PoolUniverseEntry["identitySource"];
    };

type PoolActivity = LandedPoolActivity;

interface EnrichedRankablePool extends RankablePool {
  pool: PoolUniverseEntry;
}

/**
 * The shared activity/enrichment lane is deliberately limited to the mature
 * V2/V3 fast path. Family-owned materializers publish through
 * `materializedPools`; filtering here keeps a malformed mixed input from
 * sending a non-mature family back through central enrichment.
 */
export function selectMatureDexActivity(
  activity: ReadonlyMap<string, LandedPoolActivity>,
  maturePoolAdapters: ReadonlySet<PoolEntry["adapter"]>,
): Map<string, LandedPoolActivity> {
  const selected = new Map<string, LandedPoolActivity>();
  for (const [key, pool] of activity) {
    const adapterCounts = new Map(
      [...pool.adapterCounts].filter(([adapter]) =>
        maturePoolAdapters.has(adapter)
      ),
    );
    const count = [...adapterCounts.values()].reduce(
      (sum, adapterCount) => sum + adapterCount,
      0,
    );
    if (count === 0) continue;
    selected.set(key, {
      address: pool.address,
      adapterCounts,
      count,
      lastSwapBlock: pool.lastSwapBlock,
    });
  }
  return selected;
}

function loadEnv(): void {
  const envPath = resolve("..", ".env");
  let text = "";
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rest] = trimmed.split("=");
    const key = rawKey.replace(/^export\s+/, "");
    if (!process.env[key]) process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
  }
}

async function main(): Promise<void> {
  loadEnv();
  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("MAINNET_RPC_URL required");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const logRpcUrl = process.env.POOL_UNIVERSE_LOG_RPC_URL;
  const logProvider = logRpcUrl
    ? new ethers.JsonRpcProvider(logRpcUrl)
    : provider;
  const historicalLogRpcUrl =
    process.env.POOL_UNIVERSE_HISTORY_LOG_RPC_URL;
  const historicalLogProvider = historicalLogRpcUrl
    ? new ethers.JsonRpcProvider(
        historicalLogRpcUrl,
        undefined,
        { batchMaxCount: 1 },
      )
    : logProvider;

  const ownedProviders = new Set([
    provider,
    logProvider,
    historicalLogProvider,
  ]);
  try {
  const latest = Number(process.env.POOL_UNIVERSE_TO_BLOCK ?? await provider.getBlockNumber());
  const [
    initialStateHeader,
    initialLogHeader,
    initialHistoricalLogHeader,
  ] = await Promise.all([
    provider.getBlock(latest),
    logProvider.getBlock(latest),
    historicalLogProvider.getBlock(latest),
  ]);
  if (
    !initialStateHeader?.hash ||
    !initialStateHeader.stateRoot ||
    !initialLogHeader?.hash ||
    !initialHistoricalLogHeader?.hash ||
    initialStateHeader.hash.toLowerCase() !==
      initialLogHeader.hash.toLowerCase() ||
    initialStateHeader.hash.toLowerCase() !==
      initialHistoricalLogHeader.hash.toLowerCase()
  ) {
    throw new Error(
      "pool-universe state/activity/history RPCs disagree at the frozen toBlock",
    );
  }
  const frozenBlockHash = initialStateHeader.hash;
  const frozenStateRoot = initialStateHeader.stateRoot;
  const stateProvider = pinProviderCallsToBlock(
    provider,
    latest,
    frozenBlockHash,
  );
  const lookbackBlocks = Number(
    process.env.POOL_UNIVERSE_LOOKBACK_BLOCKS ??
      String(Number(process.env.POOL_UNIVERSE_LOOKBACK_DAYS ?? "30") * BLOCKS_PER_DAY),
  );
  const fromBlock = Math.max(0, Number(process.env.POOL_UNIVERSE_FROM_BLOCK ?? latest - lookbackBlocks));
  // No index cap by default (0/unset = Infinity): the arb-relevance ranker only *orders* pools
  // (loop-completers first), so a hard cap silently drops real venues whose tokens look low-degree
  // in isolation but DO close loops on-chain (e.g. coffee's low-volume pools). Set the env to re-cap.
  const maxPools = Number(process.env.POOL_UNIVERSE_MAX_POOLS ?? "0") || Infinity;
  const minSwaps = Number(
    process.env.POOL_UNIVERSE_MIN_SWAPS ?? String(DEFAULT_POOL_UNIVERSE_MIN_SWAPS),
  );
  const logBatch = Number(process.env.POOL_UNIVERSE_LOG_BATCH ?? "1000");
  const topicScanMode =
    process.env.POOL_UNIVERSE_TOPIC_SCAN_MODE === "per-event"
      ? "per-event"
      : "union";
  const metadataConcurrency = Number(process.env.POOL_UNIVERSE_METADATA_CONCURRENCY ?? "24");
  const arbRelevance = process.env.POOL_UNIVERSE_ARB_RELEVANCE !== "0";
  const relevanceOversampleRaw = Number(process.env.POOL_UNIVERSE_RELEVANCE_OVERSAMPLE ?? "2");
  const relevanceOversample = Number.isFinite(relevanceOversampleRaw)
    ? Math.max(1, Math.floor(relevanceOversampleRaw))
    : 1;
  const v4BackfillLookbackBlocksRaw = Number(
    process.env.POOL_UNIVERSE_V4_BACKFILL_LOOKBACK_BLOCKS ??
      String(Math.max(0, fromBlock - UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK + 1)),
  );
  if (
    !Number.isSafeInteger(v4BackfillLookbackBlocksRaw) ||
    v4BackfillLookbackBlocksRaw < 0
  ) {
    throw new Error("POOL_UNIVERSE_V4_BACKFILL_LOOKBACK_BLOCKS must be a non-negative integer");
  }
  const v4BackfillLookbackBlocks = v4BackfillLookbackBlocksRaw;
  const outPath = process.env.POOL_UNIVERSE_OUT ?? DEFAULT_POOL_UNIVERSE_PATH;
  const manifestPath = process.env.POOL_UNIVERSE_MANIFEST_OUT ??
    `${outPath}.manifest.json`;
  const retainedUniversePath =
    process.env.POOL_UNIVERSE_RETAIN_PATH ??
    (existsSync(outPath) ? outPath : "");
  const retainedUniverseExists =
    retainedUniversePath.length > 0 && existsSync(retainedUniversePath);
  const retainedUniverseSnapshot = retainedUniverseExists
    ? readFileSync(retainedUniversePath, "utf8")
    : "";
  const retainedUniverseSha256 = createHash("sha256")
    .update(retainedUniverseExists ? retainedUniverseSnapshot : "null")
    .digest("hex");
  const priorUniversePools = retainedUniverseExists
    ? parsePoolUniverseJson(
        retainedUniverseSnapshot,
        retainedUniversePath,
        { minScore: 0, dropUnsupportedAdapters: true },
      )
    : [];

  console.log(
    `[pool-universe] scanning active pools from ${fromBlock} to ${latest} ` +
      `(blocks=${latest - fromBlock}, batch=${logBatch})`,
  );

  const landed = await discoverLandedPools({
    registry: PRODUCTION_ADAPTER_FAMILIES.landedPoolDiscovery(),
    backend: createSplitHorizonPoolDiscoveryBackend(
      stateProvider,
      logProvider,
      historicalLogProvider,
      fromBlock,
    ),
    fromBlock,
    toBlock: latest,
    batchSize: logBatch,
    minSwaps,
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    retainedPools: priorUniversePools,
    topicScanMode,
    strict: true,
  });
  // TRANSITIONAL BRIDGE (F6 Pair C/D delete-scope, expires with the
  // catalog-driven universe generator): curve-underlying is re-admitted to
  // the generic activity lane until its strict nomination path is the
  // default. This is a deliberately dated exception, not a new per-family
  // branch: it reuses the strict identity + plugin metadata path below.
  const maturePoolAdapters = new Set<PoolEntry["adapter"]>(
    PRODUCTION_ADAPTER_FAMILIES.swaps()
      .filter((family) => family.matureDexUniverseDiscovery === true)
      .flatMap((family) => family.poolAdapters),
  );
  maturePoolAdapters.add("curve-underlying");
  const activity: Map<string, PoolActivity> = selectMatureDexActivity(
    landed.activity,
    maturePoolAdapters,
  );
  for (const descriptor of PRODUCTION_ADAPTER_FAMILIES.landedPoolDiscovery().list()) {
    console.log(
      `[pool-universe] ${descriptor.event.discovery.label}: ` +
        `${landed.logCountsByEventId.get(descriptor.event.id) ?? 0} swap logs`,
    );
  }
  console.log(
    `[pool-universe] family-materialized=${landed.materializedPools.length}`,
  );
  const retainedFamilyInventory = await retainVerifiedSwapFamilyInstances({
    families: PRODUCTION_ADAPTER_FAMILIES.swaps(),
    identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    backend: stateProvider,
    priorPools: priorUniversePools,
    freshPools: landed.materializedPools,
    // F6 Pair B: retained inventory re-attests through the generated
    // catalog + plugin lifecycle at the frozen source block. The legacy
    // per-adapter resolver registry is no longer the admission authority.
    strictAttestation: {
      provider: stateProvider as never,
      blockNumber: latest,
    },
  });
  console.log(
    `[pool-universe] family-inventory: prior=${priorUniversePools.length} ` +
      `candidates=${retainedFamilyInventory.candidates} ` +
      `retained=${retainedFamilyInventory.pools.length} ` +
      `removed=${retainedFamilyInventory.rejected.length}`,
  );
  for (const rejected of retainedFamilyInventory.rejected) {
    console.log(
      `[pool-universe] family-inventory removed ${rejected.adapter}:` +
        `${rejected.address} reason=${rejected.reason}`,
    );
  }

  const countRanked = [...activity.values()]
    .filter((pool) => pool.count >= minSwaps)
    .sort((a, b) => b.count - a.count || b.lastSwapBlock - a.lastSwapBlock);
  console.log(
    `[pool-universe] active pools=${activity.size}, ` +
      `after minSwaps=${countRanked.length}, maxPools=${maxPools}`,
  );

  const oversampleN = arbRelevance
    ? Math.min(countRanked.length, maxPools * relevanceOversample)
    : maxPools;
  const poolsToEnrich = countRanked.slice(0, oversampleN);
  const enriched = await mapLimit(poolsToEnrich, metadataConcurrency, async (pool, idx) => {
    if ((idx + 1) % 250 === 0) {
      console.log(`[pool-universe] metadata ${idx + 1}/${poolsToEnrich.length}`);
    }
    return enrichPool(stateProvider, pool, latest);
  });
  const enrichedCandidates: EnrichedRankablePool[] = [];
  for (let i = 0; i < enriched.length; i++) {
    const pool = enriched[i];
    if (pool === null) continue;
    const activityPool = poolsToEnrich[i];
    enrichedCandidates.push({
      key: activityPool.address.toLowerCase(),
      token0: pool.token0,
      token1: pool.token1,
      tokens: pool.underlyingCoins,
      count: activityPool.count,
      lastSwapBlock: activityPool.lastSwapBlock,
      pool,
    });
  }
  const materializedTokenPools = [
    ...landed.materializedPools,
    ...retainedFamilyInventory.pools,
  ].map(materializedTokenPool);
  const ranked = arbRelevance
    ? selectArbRelevantPools(enrichedCandidates, materializedTokenPools, {
        enabled: true,
        maxPools,
      })
    : enrichedCandidates.slice(0, maxPools);
  const loopCompleters = countLoopCompleters(
    ranked,
    enrichedCandidates,
    materializedTokenPools,
  );
  console.log(
    `[pool-universe] arb-relevance: enabled=${arbRelevance} oversample=${relevanceOversample} ` +
      `loopCompleters=${loopCompleters}/${ranked.length}`,
  );
  const validPools = ranked.map((item) => item.pool);
  const tokenSet = new Set<string>();
  for (const pool of validPools) {
    if (pool.token0) tokenSet.add(pool.token0.toLowerCase());
    if (pool.token1) tokenSet.add(pool.token1.toLowerCase());
    for (const token of pool.underlyingCoins ?? []) tokenSet.add(token.toLowerCase());
  }
  for (const pool of landed.materializedPools) {
    if (pool.token0) tokenSet.add(pool.token0.toLowerCase());
    if (pool.token1) tokenSet.add(pool.token1.toLowerCase());
  }
  for (const pool of retainedFamilyInventory.pools) {
    if (pool.token0) tokenSet.add(pool.token0.toLowerCase());
    if (pool.token1) tokenSet.add(pool.token1.toLowerCase());
    for (const token of pool.underlyingCoins ?? []) {
      tokenSet.add(token.toLowerCase());
    }
  }
  const discoveryQueuePath =
    process.env.POOL_UNIVERSE_DISCOVERY_QUEUE_PATH ??
    resolve("searcher", "pools", "discovery-queue.json");
  const discoveryQueueExists = existsSync(discoveryQueuePath);
  const discoveryQueueSnapshot = discoveryQueueExists
    ? readFileSync(discoveryQueuePath, "utf8")
    : "";
  const discoveryQueueSha256 = createHash("sha256")
    .update(discoveryQueueExists ? discoveryQueueSnapshot : "null")
    .digest("hex");
  const discoveryQueueEntries = discoveryQueueEntryCount(discoveryQueueSnapshot);
  const { included, blocked } = await consumeDiscoveryQueue(
    stateProvider,
    discoveryQueuePath,
    tokenSet,
    discoveryQueueSnapshot,
  );
  const poolByKey = new Map<string, PoolUniverseEntry>();
  for (const pool of validPools) {
    poolByKey.set(poolRegistryKey(pool), pool);
  }
  for (const pool of retainedFamilyInventory.pools) {
    poolByKey.set(poolRegistryKey(pool), pool);
  }
  for (const pool of landed.materializedPools) {
    poolByKey.set(poolRegistryKey(pool), pool);
  }
  for (const pool of included) {
    const key = poolRegistryKey(pool);
    if (!poolByKey.has(key)) poolByKey.set(key, pool);
  }
  if (existsSync(discoveryQueuePath)) {
    console.log(`[pool-universe] discovery-queue: +${included.length} included, ${blocked.length} blocked`);
    for (const item of blocked) {
      console.log(`[pool-universe] discovery-queue blocked ${item.addr}: ${item.reason}`);
    }
  }
  const registrySourceFingerprints =
    productionPoolUniverseSourceFingerprintsStrict();
  const file: PoolUniverseFile = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    fromBlock,
    toBlock: latest,
    registry: {
      sourceFingerprints: [...registrySourceFingerprints],
    },
    pools: [...poolByKey.values()],
  };

  const [
    finalStateHeader,
    finalLogHeader,
    finalHistoricalLogHeader,
  ] = await Promise.all([
    provider.getBlock(latest),
    logProvider.getBlock(latest),
    historicalLogProvider.getBlock(latest),
  ]);
  if (
    !finalStateHeader?.hash ||
    !finalStateHeader.stateRoot ||
    !finalLogHeader?.hash ||
    !finalHistoricalLogHeader?.hash ||
    finalStateHeader.hash.toLowerCase() !== frozenBlockHash.toLowerCase() ||
    finalLogHeader.hash.toLowerCase() !== frozenBlockHash.toLowerCase() ||
    finalHistoricalLogHeader.hash.toLowerCase() !==
      frozenBlockHash.toLowerCase() ||
    finalStateHeader.stateRoot.toLowerCase() !== frozenStateRoot.toLowerCase()
  ) {
    throw new Error(
      "pool-universe frozen source changed before artifact publication",
    );
  }
  const finalDiscoveryQueueExists = existsSync(discoveryQueuePath);
  const finalDiscoveryQueueSnapshot = finalDiscoveryQueueExists
    ? readFileSync(discoveryQueuePath, "utf8")
    : "";
  if (
    finalDiscoveryQueueExists !== discoveryQueueExists ||
    createHash("sha256")
      .update(finalDiscoveryQueueExists ? finalDiscoveryQueueSnapshot : "null")
      .digest("hex") !== discoveryQueueSha256
  ) {
    throw new Error(
      "pool-universe discovery queue changed before artifact publication",
    );
  }
  const finalRetainedUniverseExists =
    retainedUniversePath.length > 0 && existsSync(retainedUniversePath);
  const finalRetainedUniverseSnapshot = finalRetainedUniverseExists
    ? readFileSync(retainedUniversePath, "utf8")
    : "";
  if (
    finalRetainedUniverseExists !== retainedUniverseExists ||
    createHash("sha256")
      .update(
        finalRetainedUniverseExists
          ? finalRetainedUniverseSnapshot
          : "null",
      )
      .digest("hex") !== retainedUniverseSha256
  ) {
    throw new Error(
      "pool-universe retained family inventory changed before artifact publication",
    );
  }
  const output = `${JSON.stringify(file, null, 2)}\n`;
  const outputSha256 = createHash("sha256").update(output).digest("hex");
  const manifest = {
    schemaVersion: 1,
    profile: POOL_UNIVERSE_BUILD_MANIFEST_PROFILE,
    chainId: 1,
    source: {
      number: latest,
      hash: frozenBlockHash.toLowerCase(),
      stateRoot: frozenStateRoot.toLowerCase(),
    },
    inputs: {
      fromBlock,
      toBlock: latest,
      lookbackBlocks,
      minSwaps,
      maxPools: Number.isFinite(maxPools) ? maxPools : null,
      logBatch,
      topicScanMode,
      arbRelevance,
      relevanceOversample,
      v4BackfillLookbackBlocks,
      retainedUniverse: {
        profile: "verified-swap-family-inventory-v1",
        exists: retainedUniverseExists,
        contentSha256: retainedUniverseSha256,
        entries: priorUniversePools.length,
        candidates: retainedFamilyInventory.candidates,
        retained: retainedFamilyInventory.pools.length,
        removed: retainedFamilyInventory.rejected.length,
      },
      discoveryQueue: {
        profile: "frozen-discovery-queue-v1",
        exists: discoveryQueueExists,
        contentSha256: discoveryQueueSha256,
        entries: discoveryQueueEntries,
      },
    },
    registry: {
      sourceFingerprints: registrySourceFingerprints,
    },
    output: {
      contentSha256: outputSha256,
      pools: file.pools.length,
    },
  };
  mkdirSync(dirname(outPath), { recursive: true });
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(outPath, output);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[pool-universe] wrote ${file.pools.length} pools to ${outPath}`);
  console.log(
    `[pool-universe] manifest ${outputSha256} -> ${manifestPath}`,
  );
  } finally {
    const cleanup = await Promise.allSettled(
      [...ownedProviders].map(async (ownedProvider) => {
        ownedProvider.destroy();
      }),
    );
    const failures = cleanup.filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    if (failures.length > 0) {
      console.warn(
        `[pool-universe] provider cleanup failures=${failures.length}`,
      );
    }
  }
}

/**
 * Keep metadata attestation on the same state block as the frozen log window.
 * JsonRpcProvider.call() and the one raw eth_call path are both covered; all
 * other methods stay bound to the original provider so its private fields are
 * never invoked with the Proxy as `this`.
 */
export function pinProviderCallsToBlock(
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
  blockHash: string,
): ethers.JsonRpcProvider {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error("pool-universe metadata block must be a non-negative safe integer");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(blockHash)) {
    throw new Error("pool-universe metadata block hash must be bytes32");
  }
  const blockTag = Object.freeze({
    blockHash: blockHash.toLowerCase(),
    requireCanonical: true,
  });
  return new Proxy(provider, {
    get(target, property) {
      if (property === "call") {
        return (request: ethers.TransactionRequest) =>
          target.send("eth_call", [
            pinnedRpcTransaction(request),
            blockTag,
          ]);
      }
      if (property === "getCode") {
        return (address: string) =>
          target.send("eth_getCode", [address, blockTag]);
      }
      if (property === "send") {
        return (method: string, params: unknown[]) => {
          if (method === "eth_call") {
            const pinned = [...params];
            pinned[1] = blockTag;
            return target.send(method, pinned);
          }
          return target.send(method, params);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function pinnedRpcTransaction(
  request: ethers.TransactionRequest,
): Record<string, string> {
  const transaction: Record<string, string> = {};
  if (request.to !== undefined && request.to !== null) {
    transaction.to = String(request.to);
  }
  if (request.from !== undefined && request.from !== null) {
    transaction.from = String(request.from);
  }
  if (request.data !== undefined && request.data !== null) {
    transaction.data = ethers.hexlify(request.data);
  }
  if (request.value !== undefined && request.value !== null) {
    transaction.value = ethers.toQuantity(request.value);
  }
  if (request.gasLimit !== undefined && request.gasLimit !== null) {
    transaction.gas = ethers.toQuantity(request.gasLimit);
  }
  if (request.gasPrice !== undefined && request.gasPrice !== null) {
    transaction.gasPrice = ethers.toQuantity(request.gasPrice);
  }
  return transaction;
}

export function createSplitHorizonPoolDiscoveryBackend(
  stateProvider: Pick<ethers.JsonRpcProvider, "call" | "getCode" | "send">,
  logProvider: Pick<ethers.JsonRpcProvider, "send"> = stateProvider,
  historicalLogProvider: Pick<ethers.JsonRpcProvider, "send"> = logProvider,
  historicalBeforeBlock = 0,
): LandedPoolDiscoveryReadBackend {
  return {
    getLogs(filter: LandedPoolDiscoveryLogFilter) {
      const selectedLogProvider =
        filter.fromBlock < historicalBeforeBlock
          ? historicalLogProvider
          : logProvider;
      return selectedLogProvider.send("eth_getLogs", [{
        ...(filter.address === undefined ? {} : { address: filter.address }),
        topics: [...filter.topics],
        fromBlock: ethers.toQuantity(filter.fromBlock),
        toBlock: ethers.toQuantity(filter.toBlock),
      }]);
    },
    call(req) {
      return stateProvider.call(req);
    },
    getCode(address) {
      return stateProvider.getCode(address);
    },
  };
}

function materializedTokenPool(
  pool: PoolEntry,
): { token0?: string; token1?: string; tokens?: string[] } {
  return {
    token0: pool.token0 ?? pool.currency0,
    token1: pool.token1 ?? pool.currency1,
    tokens: pool.underlyingCoins,
  };
}

function countLoopCompleters(
  selected: EnrichedRankablePool[],
  candidates: EnrichedRankablePool[],
  externalTokenPools: Array<{ token0?: string; token1?: string; tokens?: string[] }>,
): number {
  const tokenDegree = new Map<string, number>();
  const seenCandidates = new Set<string>();
  for (const pool of candidates) {
    const key = pool.key.toLowerCase();
    if (seenCandidates.has(key)) continue;
    seenCandidates.add(key);
    addTokenDegree(tokenDegree, pool);
  }
  for (const pool of externalTokenPools) {
    addTokenDegree(tokenDegree, pool);
  }

  return selected.filter((pool) => {
    const tokens = poolTokens(pool);
    return tokens.filter((token) => (tokenDegree.get(token) ?? 0) >= 2).length >= 2;
  }).length;
}

function addTokenDegree(
  tokenDegree: Map<string, number>,
  pool: { token0?: string; token1?: string; tokens?: string[] },
): void {
  for (const token of poolTokens(pool)) {
    tokenDegree.set(token, (tokenDegree.get(token) ?? 0) + 1);
  }
}

function poolTokens(pool: { token0?: string; token1?: string; tokens?: string[] }): string[] {
  const tokens = new Set<string>();
  if (pool.token0) tokens.add(pool.token0.toLowerCase());
  if (pool.token1) tokens.add(pool.token1.toLowerCase());
  for (const token of pool.tokens ?? []) tokens.add(token.toLowerCase());
  return [...tokens];
}

async function enrichPool(
  provider: ethers.JsonRpcProvider,
  pool: PoolActivity,
  strictBlockNumber?: number,
): Promise<PoolUniverseEntry | null> {
  const adapterHint = bestAdapter(pool.adapterCounts);
  // The generic activity lane is the retained mature V2/V3 fast path.
  // TRANSITIONAL BRIDGE (F6 Pair C/D delete-scope, expires with the
  // catalog-driven universe generator): curve-underlying is re-admitted here
  // via the strict identity path until its strict nomination is the default.
  // Every other registered swap family must provide its own typed
  // materializer and therefore arrives through landed.materializedPools.
  if (
    adapterHint !== "univ2" &&
    adapterHint !== "univ3" &&
    adapterHint !== "curve-underlying"
  ) {
    throw new Error(
      `non-mature pool adapter ${adapterHint} escaped family materialization`,
    );
  }
  const identity = await resolvePoolIdentityStrict(
    provider,
    pool.address,
    strictBlockNumber ?? 0,
    adapterHint,
  );
  if (!identity.ok) {
    console.log(
      `[pool-universe] enrich identity failed ${pool.address} ` +
        `${adapterHint} reason=${identity.reason ?? "unknown"}`,
    );
    return null;
  }
  const adapter = identity.adapter;
  const base: PoolUniverseEntry = {
    address: pool.address,
    adapter,
    venueId: identity.venueId,
    factory: identity.factory,
    identitySource: identity.identitySource,
    score: pool.count,
    swapCount30d: pool.count,
    lastSwapBlock: pool.lastSwapBlock,
    source: "alchemy-swap-logs",
  };

  try {
    // TRANSITIONAL BRIDGE (F6 delete-scope): curve-underlying pools are
    // enriched through the plugin-owned metadata resolver until the strict
    // nomination path is the default. The identity above is strict; only the
    // token-domain metadata comes from the shared curve resolver.
    if (adapterHint === "curve-underlying" ||
        adapter === "curve-exchange-underlying") {
      const metadata = await resolveCurveUnderlyingMetadata(
        { call: (req) => provider.call({ ...req, blockTag: strictBlockNumber ?? 0 }) },
        pool.address,
        { allowDirectPoolFallback: true },
      );
      return { ...base, adapter: "curve-underlying", underlyingCoins: metadata.coins };
    }
    if (adapter === "univ3") {
      const [token0, token1, fee, tickSpacing] = await Promise.all([
        callAddress(provider, pool.address, univ3Iface.encodeFunctionData("token0")),
        callAddress(provider, pool.address, univ3Iface.encodeFunctionData("token1")),
        callNumber(provider, pool.address, univ3Iface.encodeFunctionData("fee"), "fee"),
        callNumber(provider, pool.address, univ3Iface.encodeFunctionData("tickSpacing"), "tickSpacing"),
      ]);
      return { ...base, token0, token1, fee, tickSpacing };
    }
    if (adapter === "univ2") {
      const [token0, token1] = await Promise.all([
        callAddress(provider, pool.address, univ2Iface.encodeFunctionData("token0")),
        callAddress(provider, pool.address, univ2Iface.encodeFunctionData("token1")),
      ]);
      return { ...base, token0, token1 };
    }
    return base;
  } catch (error) {
    console.log(
      `[pool-universe] enrich metadata failed ${pool.address} ` +
        `adapter=${adapter} reason=${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export function isClosablePair(token0: string, token1: string, tokenSet: Set<string>): boolean {
  return tokenSet.has(token0.toLowerCase()) && tokenSet.has(token1.toLowerCase());
}

async function probePoolShape(
  provider: ethers.JsonRpcProvider,
  addr: string,
  strictBlockNumber?: number,
): Promise<ProbedPoolShape | null> {
  const address = ethers.getAddress(addr);
  const identity = await resolvePoolIdentityStrict(
    provider,
    address,
    strictBlockNumber ?? await provider.getBlockNumber(),
  );
  if (!identity.ok) return null;
  if (identity.adapter === "univ3") try {
    const [token0, token1, fee, tickSpacing] = await Promise.all([
      callAddress(provider, address, univ3Iface.encodeFunctionData("token0")),
      callAddress(provider, address, univ3Iface.encodeFunctionData("token1")),
      callNumber(provider, address, univ3Iface.encodeFunctionData("fee"), "fee"),
      callNumber(provider, address, univ3Iface.encodeFunctionData("tickSpacing"), "tickSpacing"),
    ]);
    return {
      adapter: "univ3",
      token0,
      token1,
      fee,
      tickSpacing,
      venueId: identity.venueId,
      factory: identity.factory!,
      identitySource: identity.identitySource,
    };
  } catch { /* an identity match still needs the expected pool ABI */ }

  if (identity.adapter === "univ2") try {
    const [token0, token1, reserves] = await Promise.all([
      callAddress(provider, address, univ2Iface.encodeFunctionData("token0")),
      callAddress(provider, address, univ2Iface.encodeFunctionData("token1")),
      provider.call({ to: address, data: univ2Iface.encodeFunctionData("getReserves") }),
    ]);
    univ2Iface.decodeFunctionResult("getReserves", reserves);
    return {
      adapter: "univ2",
      token0,
      token1,
      venueId: identity.venueId,
      factory: identity.factory!,
      identitySource: identity.identitySource,
    };
  } catch { /* fall through */ }
  return null;
}

export async function consumeDiscoveryQueue(
  provider: ethers.JsonRpcProvider,
  queuePath: string,
  tokenSet: Set<string>,
  frozenContent?: string,
): Promise<{
  included: PoolUniverseEntry[];
  blocked: Array<{ addr: string; reason: string }>;
}> {
  if (frozenContent === undefined && !existsSync(queuePath)) {
    return { included: [], blocked: [] };
  }

  const content = frozenContent ?? readFileSync(queuePath, "utf8");
  if (content.trim().length === 0) return { included: [], blocked: [] };
  const parsed = JSON.parse(content) as unknown;
  const included: PoolUniverseEntry[] = [];
  const blocked: Array<{ addr: string; reason: string }> = [];
  const queue = isRecord(parsed) && Array.isArray(parsed.queue) ? parsed.queue : [];

  for (const rawEntry of queue) {
    if (!isRecord(rawEntry)) {
      blocked.push({ addr: String(rawEntry), reason: "invalid_entry" });
      continue;
    }
    const entry = rawEntry as DiscoveryQueueEntry;
    if (entry.class !== "closable") continue;
    const addr = typeof entry.addr === "string" ? entry.addr : "";
    if (!addr) {
      blocked.push({ addr: String(entry.addr), reason: "invalid_entry" });
      continue;
    }

    try {
      const shape = await probePoolShape(provider, addr);
      if (shape === null) {
        blocked.push({ addr, reason: "blocked_on_adapter" });
        continue;
      }
      if (!isClosablePair(shape.token0, shape.token1, tokenSet)) {
        blocked.push({ addr, reason: "not_closable_in_current_graph" });
        continue;
      }
      included.push({
        address: ethers.getAddress(addr),
        adapter: shape.adapter,
        venueId: shape.venueId,
        factory: shape.factory,
        identitySource: shape.identitySource,
        token0: shape.token0,
        token1: shape.token1,
        fee: shape.adapter === "univ3" ? shape.fee : undefined,
        tickSpacing: shape.adapter === "univ3" ? shape.tickSpacing : undefined,
        source: typeof entry.source === "string" ? entry.source : undefined,
        score: undefined,
      });
    } catch {
      blocked.push({ addr, reason: "blocked_on_adapter" });
    }
  }

  return { included, blocked };
}

function discoveryQueueEntryCount(content: string): number {
  if (content.trim().length === 0) return 0;
  const parsed = JSON.parse(content) as unknown;
  return isRecord(parsed) && Array.isArray(parsed.queue)
    ? parsed.queue.length
    : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bestAdapter(adapterCounts: Map<PoolEntry["adapter"], number>): PoolEntry["adapter"] {
  return [...adapterCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

async function callAddress(
  provider: ethers.JsonRpcProvider,
  to: string,
  data: string,
): Promise<string> {
  const result = await provider.call({ to, data });
  return ethers.getAddress("0x" + result.slice(-40));
}

async function callNumber(
  provider: ethers.JsonRpcProvider,
  to: string,
  data: string,
  method: "fee" | "tickSpacing",
): Promise<number> {
  const result = await provider.call({ to, data });
  const decoded = univ3Iface.decodeFunctionResult(method, result);
  return Number(decoded[0]);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limit) }, () => worker()));
  return results;
}

// Only run the full scan when executed directly as a script (npm run searcher:pool-universe),
// not when this module is imported (e.g. to reuse consumeDiscoveryQueue / isClosablePair in a test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[pool-universe] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}


/**
 * F6 Pair B: strict single-pool identity resolution through the generated
 * catalog + plugin lifecycle. Returns the legacy PoolIdentityResult shape so
 * the mature metadata probes keep working; the legacy per-adapter resolver
 * registry never supplies a credential here.
 */
async function resolvePoolIdentityStrict(
  provider: ethers.JsonRpcProvider,
  address: string,
  blockNumber: number,
  adapterHint?: string,
): Promise<PoolIdentityResult> {
  const result = await attestPoolsStrictFromProvider({
    provider: provider as never,
    blockNumber,
    // The activity adapter label is a catalog-match hint (provenance),
    // never an admission gate: identity still re-verifies on chain.
    pools: [{ address, adapter: adapterHint ?? "" }],
  });
  const entry = result.accepted[0];
  if (entry === undefined) {
    const rejectedReason = result.rejected[0]?.reason;
    return {
      ok: false,
      reason: (rejectedReason === undefined
        ? "unsupported_venue"
        : `rejected:${rejectedReason}`) as PoolIdentityFailureReason,
    };
  }
  return {
    ok: true,
    adapter: entry.adapter as PoolEntry["adapter"],
    venueId: entry.venueId as VenueId,
    identitySource: entry.identitySource as VenueIdentitySource,
  };
}
