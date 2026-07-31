import { ethers } from "ethers";
import type { PoolEntry } from "../../../planner/token-graph.js";
import type { PoolUniverseEntry } from "../../../pool-universe.js";
import type {
  LandedPoolDiscoveryLog,
  LandedPoolMaterializationCapability,
  LandedPoolMaterializationContext,
  LandedPoolMaterializationResult,
} from "../../landed-pool-discovery.js";
import { observedLandedPoolIdentity } from "../../landed-event-registry.js";
import {
  EKUBO_CORE,
  EKUBO_CORE_DEPLOY_BLOCK,
  EKUBO_POOL_INITIALIZED_TOPIC,
  EKUBO_ROUTER,
} from "./abi.js";
import {
  EKUBO_IDENTITY_SOURCE,
  EKUBO_POOL_ADAPTER_ID,
  EKUBO_SWAP_EVENT_ID,
  EKUBO_VENUE_ID,
} from "./ids.js";
import {
  createEkuboPoolKeyBinding,
  decodeEkuboPoolKeyBinding,
  ekuboGraphToken,
  ekuboPoolId,
  normalizeEkuboPoolKey,
  type EkuboPoolKey,
} from "./pool-key.js";

const abi = ethers.AbiCoder.defaultAbiCoder();

export interface ParsedEkuboPoolInitialized {
  readonly poolId: string;
  readonly poolKey: EkuboPoolKey;
  readonly blockNumber: number;
}

interface EkuboPoolActivity {
  readonly poolId: string;
  readonly count: number;
  readonly lastSwapBlock: number;
}

export const ekuboPoolDiscovery = Object.freeze({
  version: "ekubo-poolkey-materializer-v2",
  eventIds: Object.freeze([EKUBO_SWAP_EVENT_ID]),
  consumesOpaqueRetries: true,
  async materialize(
    context: LandedPoolMaterializationContext,
  ): Promise<LandedPoolMaterializationResult> {
    const activity = collectEkuboActivity(context);
    const qualifying = [...activity.values()].filter(
      (item) => item.count >= context.minSwaps,
    );
    if (qualifying.length === 0) {
      return Object.freeze({
        pools: Object.freeze([]),
        complete: true,
      });
    }

    const retained = retainedPoolKeys(context.retainedPools);
    const currentInitialize = await context.scanLogs({
      address: EKUBO_CORE,
      topics: [EKUBO_POOL_INITIALIZED_TOPIC],
      fromBlock: context.fromBlock,
      toBlock: context.toBlock,
    });
    const initialized = parseInitializeLogs(currentInitialize.logs);
    for (const [poolId, parsed] of retained) initialized.set(poolId, parsed);

    let historicalComplete = true;
    const issues = [...currentInitialize.issues];
    const unresolved = qualifying.filter((item) => !initialized.has(item.poolId));
    if (unresolved.length > 0) {
      // PoolInitialized is the authority for the complete PoolKey. A bounded
      // lookback would silently strand any active old pool whose binding is not
      // already retained, so unresolved identities resolve from Core genesis.
      const historical = await context.scanLogs({
        address: EKUBO_CORE,
        topics: [EKUBO_POOL_INITIALIZED_TOPIC],
        fromBlock: EKUBO_CORE_DEPLOY_BLOCK,
        toBlock: context.toBlock,
      });
      historicalComplete = historical.complete;
      issues.push(...historical.issues);
      for (const [poolId, parsed] of parseInitializeLogs(historical.logs)) {
        initialized.set(poolId, parsed);
      }
    }

    const pools: PoolUniverseEntry[] = [];
    const deferred: PoolUniverseEntry[] = [];
    for (const item of qualifying) {
      const parsed = initialized.get(item.poolId);
      if (!parsed) {
        deferred.push(ekuboRetryPool(item));
        issues.push(`unresolved Ekubo PoolKey ${item.poolId}`);
        continue;
      }
      pools.push(ekuboPoolEntry(parsed, item));
    }
    pools.sort((left, right) =>
      (right.score ?? 0) - (left.score ?? 0) ||
      (right.lastSwapBlock ?? 0) - (left.lastSwapBlock ?? 0)
    );
    return Object.freeze({
      pools: Object.freeze(pools),
      complete:
        currentInitialize.complete &&
        historicalComplete &&
        deferred.length === 0,
      ...(issues.length === 0 ? {} : { issues: Object.freeze(issues) }),
      ...(deferred.length === 0
        ? {}
        : { retryablePools: Object.freeze(deferred) }),
    });
  },
} satisfies LandedPoolMaterializationCapability);

export function parseEkuboPoolInitializedLog(
  log: LandedPoolDiscoveryLog,
): ParsedEkuboPoolInitialized {
  if (
    ethers.getAddress(log.address).toLowerCase() !== EKUBO_CORE.toLowerCase() ||
    log.topics.length !== 1 ||
    log.topics[0]?.toLowerCase() !== EKUBO_POOL_INITIALIZED_TOPIC
  ) {
    throw new Error("not a canonical Ekubo PoolInitialized log");
  }
  const decoded = abi.decode(
    [
      "bytes32",
      "tuple(address token0,address token1,bytes32 config)",
      "int32",
      "uint96",
    ],
    log.data,
  );
  const poolId = normalizeBytes32(String(decoded[0]), "Ekubo poolId");
  const rawKey = decoded[1] as {
    readonly token0: string;
    readonly token1: string;
    readonly config: string;
  };
  const poolKey = normalizeEkuboPoolKey({
    token0: rawKey.token0,
    token1: rawKey.token1,
    config: rawKey.config,
  });
  if (ekuboPoolId(poolKey) !== poolId) {
    throw new Error(`Ekubo PoolInitialized PoolKey hash mismatch ${poolId}`);
  }
  return Object.freeze({
    poolId,
    poolKey,
    blockNumber: parseBlockNumber(log.blockNumber),
  });
}

function collectEkuboActivity(
  context: LandedPoolMaterializationContext,
): Map<string, EkuboPoolActivity> {
  const activity = new Map<string, EkuboPoolActivity>();
  for (const pool of context.retryablePools) {
    if (pool.adapter !== EKUBO_POOL_ADAPTER_ID || !pool.poolId) continue;
    const row = pool as PoolUniverseEntry;
    const poolId = normalizeBytes32(pool.poolId, "retry Ekubo poolId");
    activity.set(poolId, Object.freeze({
      poolId,
      count: Math.max(1, Math.floor(row.swapCount30d ?? pool.score ?? 1)),
      lastSwapBlock: Number.isSafeInteger(row.lastSwapBlock)
        ? Math.max(0, row.lastSwapBlock ?? 0)
        : 0,
    }));
  }
  for (const log of context.logs) {
    const identity = observedLandedPoolIdentity(context.event, log);
    if (!identity) {
      throw new Error("Ekubo anonymous swap log has no pool identity");
    }
    const poolId = normalizeBytes32(identity, "Ekubo swap poolId");
    const previous = activity.get(poolId);
    activity.set(poolId, Object.freeze({
      poolId,
      count: (previous?.count ?? 0) + 1,
      lastSwapBlock: Math.max(
        previous?.lastSwapBlock ?? 0,
        parseBlockNumber(log.blockNumber),
      ),
    }));
  }
  return activity;
}

function retainedPoolKeys(
  pools: readonly PoolEntry[],
): ReadonlyMap<string, ParsedEkuboPoolInitialized> {
  const out = new Map<string, ParsedEkuboPoolInitialized>();
  for (const pool of pools) {
    if (
      pool.adapter !== EKUBO_POOL_ADAPTER_ID ||
      !pool.poolId ||
      !pool.routeBinding ||
      ethers.getAddress(pool.address).toLowerCase() !== EKUBO_ROUTER.toLowerCase()
    ) {
      continue;
    }
    try {
      const poolKey = decodeEkuboPoolKeyBinding(pool.routeBinding);
      const poolId = normalizeBytes32(pool.poolId, "retained Ekubo poolId");
      if (ekuboPoolId(poolKey) !== poolId) continue;
      out.set(poolId, Object.freeze({
        poolId,
        poolKey,
        blockNumber: 0,
      }));
    } catch {
      continue;
    }
  }
  return out;
}

function parseInitializeLogs(
  logs: readonly LandedPoolDiscoveryLog[],
): Map<string, ParsedEkuboPoolInitialized> {
  const out = new Map<string, ParsedEkuboPoolInitialized>();
  for (const log of logs) {
    const parsed = parseEkuboPoolInitializedLog(log);
    out.set(parsed.poolId, parsed);
  }
  return out;
}

function ekuboPoolEntry(
  parsed: ParsedEkuboPoolInitialized,
  activity: EkuboPoolActivity,
): PoolUniverseEntry {
  return Object.freeze({
    address: ethers.getAddress(EKUBO_ROUTER),
    receiptEmitters: [ethers.getAddress(EKUBO_CORE)],
    adapter: EKUBO_POOL_ADAPTER_ID,
    venueId: EKUBO_VENUE_ID,
    identitySource: EKUBO_IDENTITY_SOURCE,
    token0: ekuboGraphToken(parsed.poolKey.token0),
    token1: ekuboGraphToken(parsed.poolKey.token1),
    poolId: parsed.poolId,
    routeBinding: createEkuboPoolKeyBinding(parsed.poolKey),
    score: activity.count,
    swapCount30d: activity.count,
    lastSwapBlock: activity.lastSwapBlock,
    source: `landed-event:${EKUBO_SWAP_EVENT_ID}`,
  });
}

function ekuboRetryPool(activity: EkuboPoolActivity): PoolUniverseEntry {
  return Object.freeze({
    address: ethers.getAddress(EKUBO_ROUTER),
    receiptEmitters: [ethers.getAddress(EKUBO_CORE)],
    adapter: EKUBO_POOL_ADAPTER_ID,
    poolId: activity.poolId,
    score: activity.count,
    swapCount30d: activity.count,
    lastSwapBlock: activity.lastSwapBlock,
    source: `landed-event-retry:${EKUBO_SWAP_EVENT_ID}`,
  });
}

function normalizeBytes32(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be bytes32`);
  }
  return value.toLowerCase();
}

function parseBlockNumber(value: string | number): number {
  const parsed = typeof value === "number"
    ? value
    : value.startsWith("0x")
      ? parseInt(value, 16)
      : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`invalid Ekubo log block number ${value}`);
  }
  return parsed;
}
