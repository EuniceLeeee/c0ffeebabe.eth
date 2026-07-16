import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import type { QuoteRequest } from "./live-state-backend.js";
import type { PoolEntry, TokenEdge } from "./planner/token-graph.js";

export const DEFAULT_PINNED_WARM_POOLS_PATH = resolve(
  "searcher",
  "pools",
  "pinned-warm-pools.json",
);

export interface PinnedWarmDirection {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  weight: number;
}

export interface PinnedWarmPoolEntry extends PoolEntry {
  label?: string;
  warmDirections: PinnedWarmDirection[];
}

export interface PinnedWarmHop extends QuoteRequest {
  weight: number;
  label?: string;
}

type RawPinnedWarmPoolFile = unknown[] | { pools?: unknown[] };

const ADAPTERS = new Set<PoolEntry["adapter"]>([
  "curve",
  "curve-nr",
  "univ3",
  "univ2",
  "univ4",
  "balancer-v3",
  "psm",
  "fluid-vault",
  "fluid-dex",
]);

export function loadPinnedWarmPools(
  path = DEFAULT_PINNED_WARM_POOLS_PATH,
): PinnedWarmPoolEntry[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawPinnedWarmPoolFile;
  const entries = Array.isArray(raw) ? raw : raw.pools;
  if (!Array.isArray(entries)) {
    throw new Error(`pinned warm pool file ${path} must be an array or { pools: [...] }`);
  }
  return entries.map((entry, i) => parsePinnedWarmPool(entry, i, path));
}

export function pinnedWarmHopsFromGraph(
  graph: TokenEdge[],
  pools: PinnedWarmPoolEntry[],
): PinnedWarmHop[] {
  const edgeByDirection = new Map<string, TokenEdge>();
  for (const edge of graph) {
    edgeByDirection.set(
      directionKey(edge.target, edge.tokenIn, edge.tokenOut, v4PoolKeyIdentity(edge.v4PoolKey)),
      edge,
    );
  }

  const hops: PinnedWarmHop[] = [];
  for (const pool of pools) {
    const poolKey = poolEntryV4PoolKeyIdentity(pool);
    for (const dir of pool.warmDirections) {
      const edge = edgeByDirection.get(directionKey(pool.address, dir.tokenIn, dir.tokenOut, poolKey));
      if (!edge) {
        console.log(
          `[searcher/live] pinned warm skip ${pool.label ?? pool.address}: ` +
            `${short(dir.tokenIn)}→${short(dir.tokenOut)} not in graph`,
        );
        continue;
      }
      hops.push({
        adapterId: edge.adapterId,
        target: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
        amountIn: dir.amountIn,
        poolToken0: edge.poolToken0,
        poolToken1: edge.poolToken1,
        v4PoolKey: edge.v4PoolKey,
        weight: dir.weight,
        label: pool.label,
      });
    }
  }
  return hops;
}

function parsePinnedWarmPool(raw: unknown, index: number, path: string): PinnedWarmPoolEntry {
  if (!isRecord(raw)) throw new Error(`pinned warm pool ${path}[${index}] must be an object`);
  const adapter = raw.adapter;
  if (typeof adapter !== "string" || !ADAPTERS.has(adapter as PoolEntry["adapter"])) {
    throw new Error(`pinned warm pool ${path}[${index}] has unsupported adapter ${String(adapter)}`);
  }
  const entry: PinnedWarmPoolEntry = {
    address: checksumField(raw.address, `${path}[${index}].address`),
    adapter: adapter as PoolEntry["adapter"],
    label: typeof raw.label === "string" ? raw.label : undefined,
    poolId: optionalString(raw.poolId, `${path}[${index}].poolId`),
    fixedTokenIn: adapter === "univ4"
      ? optionalCurrency(raw.fixedTokenIn, `${path}[${index}].fixedTokenIn`)
      : optionalAddress(raw.fixedTokenIn, `${path}[${index}].fixedTokenIn`),
    fixedTokenOut: adapter === "univ4"
      ? optionalCurrency(raw.fixedTokenOut, `${path}[${index}].fixedTokenOut`)
      : optionalAddress(raw.fixedTokenOut, `${path}[${index}].fixedTokenOut`),
    fixedSlotKind: parseFixedSlotKind(raw.fixedSlotKind, `${path}[${index}].fixedSlotKind`),
    token0: optionalAddress(raw.token0, `${path}[${index}].token0`),
    token1: optionalAddress(raw.token1, `${path}[${index}].token1`),
    currency0: optionalCurrency(raw.currency0, `${path}[${index}].currency0`),
    currency1: optionalCurrency(raw.currency1, `${path}[${index}].currency1`),
    fee: optionalNumber(raw.fee, `${path}[${index}].fee`),
    tickSpacing: optionalNumber(raw.tickSpacing, `${path}[${index}].tickSpacing`),
    hooks: optionalCurrency(raw.hooks, `${path}[${index}].hooks`),
    warmDirections: parseWarmDirections(
      raw.warmDirections,
      `${path}[${index}].warmDirections`,
      adapter === "univ4",
    ),
  };
  return entry;
}

function parseWarmDirections(raw: unknown, field: string, allowNative: boolean): PinnedWarmDirection[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${field} must be an array`);
  return raw.map((dir, i) => {
    if (!isRecord(dir)) throw new Error(`${field}[${i}] must be an object`);
    const amountIn = dir.amountIn;
    if (typeof amountIn !== "string" || !/^\d+$/.test(amountIn)) {
      throw new Error(`${field}[${i}].amountIn must be a decimal string`);
    }
    const weight = dir.weight === undefined ? 1 : Number(dir.weight);
    if (!Number.isInteger(weight) || weight <= 0) {
      throw new Error(`${field}[${i}].weight must be a positive integer`);
    }
    return {
      tokenIn: allowNative
        ? currencyField(dir.tokenIn, `${field}[${i}].tokenIn`)
        : checksumField(dir.tokenIn, `${field}[${i}].tokenIn`),
      tokenOut: allowNative
        ? currencyField(dir.tokenOut, `${field}[${i}].tokenOut`)
        : checksumField(dir.tokenOut, `${field}[${i}].tokenOut`),
      amountIn: BigInt(amountIn),
      weight,
    };
  });
}

function checksumField(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be an address string`);
  return ethers.getAddress(value);
}

function currencyField(value: unknown, field: string): string {
  if (typeof value === "string" && value.toLowerCase() === "0x0") return ethers.ZeroAddress;
  return checksumField(value, field);
}

function optionalAddress(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return checksumField(value, field);
}

function optionalCurrency(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && value.toLowerCase() === "0x0") return ethers.ZeroAddress;
  return checksumField(value, field);
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} must be a finite number`);
  return n;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function parseFixedSlotKind(value: unknown, field: string): PoolEntry["fixedSlotKind"] | undefined {
  if (value === undefined) return undefined;
  if (value === "lend" || value === "swap" || value === "protocol") return value;
  throw new Error(`${field} must be "lend", "swap", or "protocol"`);
}

function directionKey(pool: string, tokenIn: string, tokenOut: string, poolKey: string): string {
  return `${pool.toLowerCase()}|${tokenIn.toLowerCase()}|${tokenOut.toLowerCase()}|${poolKey}`;
}

function short(address: string): string {
  return address.slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function poolEntryV4PoolKeyIdentity(pool: PoolEntry): string {
  if (
    pool.adapter !== "univ4" ||
    pool.currency0 === undefined ||
    pool.currency1 === undefined ||
    pool.fee === undefined ||
    pool.tickSpacing === undefined ||
    pool.hooks === undefined
  ) {
    return "";
  }
  return [
    pool.currency0.toLowerCase(),
    pool.currency1.toLowerCase(),
    String(pool.fee),
    String(pool.tickSpacing),
    pool.hooks.toLowerCase(),
  ].join(":");
}

function v4PoolKeyIdentity(key: TokenEdge["v4PoolKey"] | undefined): string {
  if (!key) return "";
  return [
    key.currency0.toLowerCase(),
    key.currency1.toLowerCase(),
    String(key.fee),
    String(key.tickSpacing),
    key.hooks.toLowerCase(),
  ].join(":");
}
