import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import type { PoolEntry } from "./planner/token-graph.js";

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
}

const ADAPTERS = new Set<PoolEntry["adapter"]>([
  "curve",
  "curve-nr",
  "univ3",
  "univ2",
  "univ4",
  "psm",
  "fluid-vault",
]);

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
  const maxPools = opts.maxPools ?? Infinity;
  const pools = rawPools
    .map((raw, i) => parsePoolUniverseEntry(raw, `${path}.pools[${i}]`))
    .filter((pool) => (pool.score ?? 0) >= minScore)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return pools.slice(0, maxPools);
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

function numberField(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} must be a finite number`);
  return n;
}

function parseFixedSlotKind(value: unknown, field: string): PoolEntry["fixedSlotKind"] | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "lend" || value === "swap") return value;
  throw new Error(`${field} must be "lend" or "swap"`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
