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
  "psm",
  "fluid-vault",
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
    edgeByDirection.set(directionKey(edge.target, edge.tokenIn, edge.tokenOut), edge);
  }

  const hops: PinnedWarmHop[] = [];
  for (const pool of pools) {
    for (const dir of pool.warmDirections) {
      const edge = edgeByDirection.get(directionKey(pool.address, dir.tokenIn, dir.tokenOut));
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
    fixedTokenIn: optionalAddress(raw.fixedTokenIn, `${path}[${index}].fixedTokenIn`),
    fixedTokenOut: optionalAddress(raw.fixedTokenOut, `${path}[${index}].fixedTokenOut`),
    fixedSlotKind: parseFixedSlotKind(raw.fixedSlotKind, `${path}[${index}].fixedSlotKind`),
    warmDirections: parseWarmDirections(raw.warmDirections, `${path}[${index}].warmDirections`),
  };
  return entry;
}

function parseWarmDirections(raw: unknown, field: string): PinnedWarmDirection[] {
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
      tokenIn: checksumField(dir.tokenIn, `${field}[${i}].tokenIn`),
      tokenOut: checksumField(dir.tokenOut, `${field}[${i}].tokenOut`),
      amountIn: BigInt(amountIn),
      weight,
    };
  });
}

function checksumField(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be an address string`);
  return ethers.getAddress(value);
}

function optionalAddress(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return checksumField(value, field);
}

function parseFixedSlotKind(value: unknown, field: string): PoolEntry["fixedSlotKind"] | undefined {
  if (value === undefined) return undefined;
  if (value === "lend" || value === "swap") return value;
  throw new Error(`${field} must be "lend" or "swap"`);
}

function directionKey(pool: string, tokenIn: string, tokenOut: string): string {
  return `${pool.toLowerCase()}|${tokenIn.toLowerCase()}|${tokenOut.toLowerCase()}`;
}

function short(address: string): string {
  return address.slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
