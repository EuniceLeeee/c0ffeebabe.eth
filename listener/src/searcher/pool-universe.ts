import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import type { PoolEntry } from "./planner/token-graph.js";
import { findVenueCapability, type VenueId } from "./venues/capability.js";
import type { VenueIdentitySource } from "./venues/identity.js";

export const DEFAULT_POOL_UNIVERSE_PATH = resolve("searcher", "pools", "active-pools.json");

export interface PoolUniverseEntry extends PoolEntry {
  token0?: string;
  token1?: string;
  fee?: number;
  tickSpacing?: number;
  hooks?: string;
  swapCount30d?: number;
  lastSwapBlock?: number;
  source?: string;
}

export interface PoolUniverseFile {
  schemaVersion?: number;
  generatedAt?: string;
  fromBlock?: number;
  toBlock?: number;
  pools: PoolUniverseEntry[];
}

export interface PoolUniverseLoadOptions {
  missingOk?: boolean;
  maxPools?: number;
  minScore?: number;
  forceInclude?: string[];
  highSpreadPairQuota?: number;
  highSpreadMinFee?: number;
}

const ADAPTERS = new Set<PoolEntry["adapter"]>([
  "curve",
  "curve-nr",
  "univ3",
  "univ2",
  "univ4",
  "psm",
  "fluid-vault",
  "fluid-dex",
]);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

export function loadPoolUniverse(
  path = DEFAULT_POOL_UNIVERSE_PATH,
  opts: PoolUniverseLoadOptions = {},
): PoolUniverseEntry[] {
  const missingOk = opts.missingOk ?? true;
  if (!existsSync(path)) {
    if (missingOk) return [];
    throw new Error(`pool universe file not found: ${path}`);
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const rawPools = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.pools)
      ? parsed.pools
      : null;
  if (!rawPools) {
    throw new Error(`pool universe file ${path} must be an array or { pools: [...] }`);
  }

  const minScore = opts.minScore ?? 0;
  const maxPools = opts.maxPools && opts.maxPools > 0 ? opts.maxPools : Infinity;
  const highSpreadPairQuota = Math.max(0, Math.floor(opts.highSpreadPairQuota ?? 0));
  const highSpreadMinFee = Math.max(0, Math.floor(opts.highSpreadMinFee ?? 10_000));
  const parsedPools = rawPools
    .map((raw, i) => parsePoolUniverseEntry(raw, `${path}.pools[${i}]`));
  const pools = parsedPools
    .filter((pool) => (pool.score ?? 0) >= minScore)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return appendForceIncluded(
    selectRankedPools(pools, maxPools, highSpreadPairQuota, highSpreadMinFee),
    parsedPools,
    opts.forceInclude ?? [],
  );
}

/** Reads only the universe file's generatedAt metadata (loadPoolUniverse discards it). "" if absent/array-form/missing. */
export function loadPoolUniverseGeneratedAt(path = DEFAULT_POOL_UNIVERSE_PATH): string {
  if (!existsSync(path)) return "";
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (isRecord(parsed) && typeof parsed.generatedAt === "string") return parsed.generatedAt;
    return "";
  } catch {
    return "";
  }
}

function selectRankedPools(
  pools: PoolUniverseEntry[],
  maxPools: number,
  highSpreadPairQuota: number,
  highSpreadMinFee: number,
): PoolUniverseEntry[] {
  if (!Number.isFinite(maxPools) || highSpreadPairQuota <= 0) {
    return pools.slice(0, maxPools);
  }
  const cappedMax = Math.max(0, Math.floor(maxPools));
  if (cappedMax === 0) return [];

  const selected: PoolUniverseEntry[] = [];
  const seenPools = new Set<string>();
  const representedPairs = new Set<string>();
  const primaryLimit = Math.max(0, cappedMax - Math.min(highSpreadPairQuota, cappedMax));

  for (const pool of pools.slice(0, primaryLimit)) {
    appendSelected(pool, selected, seenPools, representedPairs);
  }

  const highSpreadCandidates = pools
    .filter((pool) => !seenPools.has(poolRegistryKey(pool)) && impliedSpreadFee(pool) >= highSpreadMinFee)
    .sort((a, b) =>
      impliedSpreadFee(b) - impliedSpreadFee(a) ||
      (b.score ?? 0) - (a.score ?? 0) ||
      (b.lastSwapBlock ?? 0) - (a.lastSwapBlock ?? 0)
    );
  for (const pool of highSpreadCandidates) {
    if (selected.length >= cappedMax) break;
    const pairKey = unorderedTokenPairKey(pool);
    if (pairKey === null || representedPairs.has(pairKey)) continue;
    appendSelected(pool, selected, seenPools, representedPairs);
  }

  for (const pool of pools) {
    if (selected.length >= cappedMax) break;
    if (seenPools.has(poolRegistryKey(pool))) continue;
    appendSelected(pool, selected, seenPools, representedPairs);
  }

  return selected;
}

function appendSelected(
  pool: PoolUniverseEntry,
  selected: PoolUniverseEntry[],
  seenPools: Set<string>,
  representedPairs: Set<string>,
): void {
  selected.push(pool);
  seenPools.add(poolRegistryKey(pool));
  const pairKey = unorderedTokenPairKey(pool);
  if (pairKey !== null) representedPairs.add(pairKey);
}

function impliedSpreadFee(pool: PoolUniverseEntry): number {
  if (typeof pool.fee === "number") return pool.fee;
  if (pool.adapter === "univ2") return 3000;
  return 0;
}

export function selectPairCompletionPools(
  admittedPools: PoolEntry[],
  candidatePools: PoolUniverseEntry[],
): PoolUniverseEntry[] {
  const admittedPairs = new Set<string>();
  for (const pool of admittedPools) {
    const key = unorderedTokenPairKey(pool);
    if (key) admittedPairs.add(key);
  }
  const admittedPoolKeys = new Set(admittedPools.map(poolRegistryKey));
  for (const pool of candidatePools) {
    if (!admittedPoolKeys.has(poolRegistryKey(pool))) continue;
    const key = unorderedTokenPairKey(pool);
    if (key) admittedPairs.add(key);
  }
  if (admittedPairs.size === 0) return [];
  return candidatePools.filter((pool) => {
    const key = unorderedTokenPairKey(pool);
    return key !== null && admittedPairs.has(key);
  });
}

function appendForceIncluded(
  selected: PoolUniverseEntry[],
  allPools: PoolUniverseEntry[],
  forceInclude: string[],
): PoolUniverseEntry[] {
  if (forceInclude.length === 0) return selected;
  const wantedAddrs = new Set<string>();
  const wantedPoolIds = new Set<string>();
  for (const item of forceInclude) {
    if (ADDRESS_RE.test(item)) {
      wantedAddrs.add(ethers.getAddress(item).toLowerCase());
    } else if (BYTES32_RE.test(item)) {
      wantedPoolIds.add(item.toLowerCase());
    } else {
      throw new Error(`forceInclude entry must be an address or bytes32 poolId: ${item}`);
    }
  }
  const seenAddrs = new Set(
    selected
      .filter((pool) => pool.adapter !== "univ4")
      .map((pool) => pool.address.toLowerCase()),
  );
  const seenV4PoolIds = new Set(
    selected
      .filter((pool) => pool.adapter === "univ4" && typeof pool.poolId === "string")
      .map((pool) => pool.poolId!.toLowerCase()),
  );
  const warnedV4 = new Set<string>();
  const out = [...selected];
  for (const pool of allPools) {
    const key = pool.address.toLowerCase();
    if (pool.adapter === "univ4") {
      const poolId = pool.poolId?.toLowerCase();
      if (poolId && wantedPoolIds.has(poolId)) {
        if (seenV4PoolIds.has(poolId)) continue;
        out.push(pool);
        seenV4PoolIds.add(poolId);
        continue;
      }
      if (wantedAddrs.has(key) && !warnedV4.has(key)) {
        console.warn(
          `[pool-universe] forceInclude skipped univ4 entry ${pool.address}: ` +
            "address-only identity is ambiguous for the v4 PoolManager",
        );
        warnedV4.add(key);
      }
      continue;
    }
    if (!wantedAddrs.has(key)) continue;
    if (seenAddrs.has(key)) continue;
    out.push(pool);
    seenAddrs.add(key);
  }
  return out;
}

function parsePoolUniverseEntry(raw: unknown, field: string): PoolUniverseEntry {
  if (!isRecord(raw)) throw new Error(`${field} must be an object`);
  const adapter = raw.adapter;
  if (typeof adapter !== "string" || !ADAPTERS.has(adapter as PoolEntry["adapter"])) {
    throw new Error(`${field}.adapter unsupported: ${String(adapter)}`);
  }
  const score = numberField(raw.score, `${field}.score`) ??
    numberField(raw.swapCount30d, `${field}.swapCount30d`) ??
    0;
  const isV4 = adapter === "univ4";
  return {
    address: checksumField(raw.address ?? raw.pool, `${field}.address`),
    adapter: adapter as PoolEntry["adapter"],
    venueId: venueIdField(raw.venueId, `${field}.venueId`),
    factory: optionalAddress(raw.factory, `${field}.factory`),
    identitySource: identitySourceField(raw.identitySource, `${field}.identitySource`),
    poolId: stringField(raw.poolId, `${field}.poolId`),
    score,
    fixedTokenIn: isV4
      ? optionalCurrency(raw.fixedTokenIn, `${field}.fixedTokenIn`)
      : optionalAddress(raw.fixedTokenIn, `${field}.fixedTokenIn`),
    fixedTokenOut: isV4
      ? optionalCurrency(raw.fixedTokenOut, `${field}.fixedTokenOut`)
      : optionalAddress(raw.fixedTokenOut, `${field}.fixedTokenOut`),
    fixedSlotKind: parseFixedSlotKind(raw.fixedSlotKind, `${field}.fixedSlotKind`),
    token0: optionalAddress(raw.token0, `${field}.token0`),
    token1: optionalAddress(raw.token1, `${field}.token1`),
    currency0: optionalCurrency(raw.currency0, `${field}.currency0`),
    currency1: optionalCurrency(raw.currency1, `${field}.currency1`),
    fee: numberField(raw.fee, `${field}.fee`),
    tickSpacing: numberField(raw.tickSpacing, `${field}.tickSpacing`),
    hooks: optionalCurrency(raw.hooks, `${field}.hooks`),
    swapCount30d: numberField(raw.swapCount30d, `${field}.swapCount30d`),
    lastSwapBlock: numberField(raw.lastSwapBlock, `${field}.lastSwapBlock`),
    source: typeof raw.source === "string" ? raw.source : undefined,
  };
}

function checksumField(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be an address string`);
  return ethers.getAddress(value);
}

function optionalAddress(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return checksumField(value, field);
}

function optionalCurrency(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && value.toLowerCase() === "0x0") return ethers.ZeroAddress;
  return checksumField(value, field);
}

function stringField(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function venueIdField(value: unknown, field: string): VenueId | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || findVenueCapability(value) === null) {
    throw new Error(`${field} must be a known venue id`);
  }
  return value.toLowerCase() as VenueId;
}

function identitySourceField(value: unknown, field: string): VenueIdentitySource | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    value !== "factory-call" &&
    value !== "factory-event" &&
    value !== "curve-metaregistry" &&
    value !== "v4-manager" &&
    value !== "seed"
  ) {
    throw new Error(`${field} has unsupported identity source ${String(value)}`);
  }
  return value;
}

function numberField(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} must be a finite number`);
  return n;
}

function parseFixedSlotKind(value: unknown, field: string): PoolEntry["fixedSlotKind"] | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "lend" || value === "swap" || value === "protocol") return value;
  throw new Error(`${field} must be "lend", "swap", or "protocol"`);
}

function unorderedTokenPairKey(pool: Pick<PoolEntry, "token0" | "token1">): string | null {
  if (!pool.token0 || !pool.token1) return null;
  return [pool.token0.toLowerCase(), pool.token1.toLowerCase()].sort().join("/");
}

export function poolRegistryKey(pool: PoolEntry): string {
  if (pool.adapter !== "univ4") return pool.address.toLowerCase();
  return [
    pool.address.toLowerCase(),
    pool.poolId?.toLowerCase() ?? "",
    pool.currency0?.toLowerCase() ?? "",
    pool.currency1?.toLowerCase() ?? "",
    pool.fee === undefined ? "" : String(pool.fee),
    pool.tickSpacing === undefined ? "" : String(pool.tickSpacing),
    pool.hooks?.toLowerCase() ?? "",
  ].join(":");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
