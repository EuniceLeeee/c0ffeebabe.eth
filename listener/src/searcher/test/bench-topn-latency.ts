/**
 * Deterministic TopN planner-latency bench.
 * Pure in-memory: load pool metadata, build TokenEdge[] with a stub backend, then time plan().
 */

import { existsSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { Opportunity } from "../detector/detector.js";
import { TemplatePlanner } from "../planner/planner.js";
import {
  buildTokenGraph,
  type PoolEntry,
  type TokenEdge,
  type TokenQueryBackend,
} from "../planner/token-graph.js";
import type { FlashLiquidityView, FlashSource } from "../solver/flash-liquidity.js";
import { FLASH_SWAP_REPAY } from "../templates/path-template.js";

const DEFAULT_POOLS_PATH = "/opt/MEV/listener/searcher/pools/active-pools.json";
const BUILTIN_SMOKE = "builtin-smoke";
const WETH = ADDR.WETH;

interface BenchOptions {
  poolsPath: string;
  topnsRaw?: string;
  iters: number;
}

interface RankedPoolEntry extends PoolEntry {
  swapCount30d?: number;
  lastSwapBlock?: number;
  source?: string;
}

interface BenchRow {
  topN: number;
  pools: number;
  edges: number;
  buildMs: number;
  planP50Ms: number;
  planP95Ms: number;
}

const ABI = ethers.AbiCoder.defaultAbiCoder();
const TOKEN_IFACE = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function coins(uint256 i) view returns (address)",
  "function coins(int128 i) view returns (address)",
]);

const TOKEN0_SELECTOR = selector("token0");
const TOKEN1_SELECTOR = selector("token1");
const RESERVES_SELECTOR = selector("getReserves");
const COINS_UINT_SELECTOR = selector("coins(uint256)");
const COINS_INT_SELECTOR = selector("coins(int128)");

function selector(name: string): string {
  const fn = TOKEN_IFACE.getFunction(name);
  if (!fn) throw new Error(`missing interface function ${name}`);
  return fn.selector.toLowerCase();
}

class StubTokenBackend implements TokenQueryBackend {
  private readonly byAddress = new Map<string, RankedPoolEntry>();

  constructor(pools: RankedPoolEntry[]) {
    for (const pool of pools) {
      const key = pool.address.toLowerCase();
      if (!this.byAddress.has(key)) this.byAddress.set(key, pool);
    }
  }

  async call(req: { to: string; data: string }): Promise<string> {
    const pool = this.byAddress.get(req.to.toLowerCase());
    if (!pool) throw new Error(`stub has no pool metadata for ${req.to}`);

    const sig = req.data.slice(0, 10).toLowerCase();
    if (sig === TOKEN0_SELECTOR) return encodeAddress(requiredToken(pool, "token0"));
    if (sig === TOKEN1_SELECTOR) return encodeAddress(requiredToken(pool, "token1"));
    if (sig === RESERVES_SELECTOR) return ABI.encode(["uint112", "uint112", "uint32"], [1_000_000n, 1_000_000n, 1]);

    if (sig === COINS_UINT_SELECTOR || sig === COINS_INT_SELECTOR) {
      const [idx] = ABI.decode(["uint256"], `0x${req.data.slice(10)}`) as unknown as [bigint];
      if (idx === 0n) return encodeAddress(requiredToken(pool, "token0"));
      if (idx === 1n) return encodeAddress(requiredToken(pool, "token1"));
      return encodeAddress(ethers.ZeroAddress);
    }

    throw new Error(`unsupported stub call selector ${sig} for ${req.to}`);
  }

  async getLogs(): Promise<Array<{ data: string; topics: string[] }>> {
    return [];
  }
}

function requiredToken(pool: RankedPoolEntry, field: "token0" | "token1"): string {
  const token = pool[field];
  if (!token) throw new Error(`${pool.address} missing ${field}`);
  return token;
}

function encodeAddress(address: string): string {
  return ABI.encode(["address"], [address]);
}

class FakeFlashLiquidity implements FlashLiquidityView {
  constructor(private readonly sources: Map<string, FlashSource>) {}

  borrowable(token: string): bigint {
    return this.source(token)?.amount ?? 0n;
  }

  source(token: string): FlashSource | null {
    return this.sources.get(token.toLowerCase()) ?? null;
  }
}

function fakeLiquidity(token: string): FlashLiquidityView {
  return new FakeFlashLiquidity(new Map([
    [token.toLowerCase(), { amount: 1_000_000_000_000_000_000_000_000n, adapterId: "balancer-flash" }],
  ]));
}

function opportunity(impact: TokenEdge, hotToken: string): Opportunity {
  const reverseForHot = sameAddress(impact.tokenIn, hotToken);
  const tokenIn = reverseForHot ? impact.tokenOut : impact.tokenIn;
  const tokenOut = reverseForHot ? impact.tokenIn : impact.tokenOut;
  return {
    kind: "backrun-arb",
    victimTxHash: "0xbench",
    blockNumber: 1,
    affectedPools: [impact.target],
    affectedTokens: uniqueAddresses([impact.tokenIn, impact.tokenOut]),
    startToken: hotToken,
    profitToken: hotToken,
    victimAmountIn: 1_000_000n,
    victimEffect: {
      kind: "swap",
      impact: {
        pool: impact.target,
        tokenIn,
        tokenOut,
        amountIn: 1_000_000n,
        matchedAdapterId: impact.adapterId,
        ...(impact.poolId ? { poolId: impact.poolId } : {}),
      },
    },
    hints: {
      impact: {
        pool: impact.target,
        tokenIn,
        tokenOut,
        ...(impact.poolId ? { poolId: impact.poolId } : {}),
      },
    },
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const pools = loadPools(opts.poolsPath);
  if (pools.length === 0) throw new Error(`pool list is empty: ${opts.poolsPath}`);

  const topns = parseTopNs(opts.topnsRaw, pools.length);
  const smallestTopN = Math.min(...topns);
  const stub = new StubTokenBackend(pools);
  const smallestGraph = await quiet(() => buildTokenGraph(stub, pools.slice(0, smallestTopN)));
  if (smallestGraph.length === 0) {
    throw new Error(`smallest slice TopN=${smallestTopN} produced 0 edges; pool metadata is insufficient`);
  }

  const hotToken = pickHotToken(smallestGraph);
  const impact = pickImpactEdge(smallestGraph, hotToken);
  const opp = opportunity(impact, hotToken);
  const liquidity = fakeLiquidity(hotToken);
  const rows: BenchRow[] = [];

  for (const topN of topns) {
    const slice = pools.slice(0, topN);
    const buildStart = performance.now();
    const graph = await quiet(() => buildTokenGraph(stub, slice));
    const buildMs = performance.now() - buildStart;

    const planner = new TemplatePlanner();
    planner.setGraph(graph);
    planner.setMaxHops(3);
    planner.setFlashLiquidity(liquidity);

    for (let i = 0; i < 3; i++) {
      await quiet(() => planner.plan(opp, [FLASH_SWAP_REPAY]));
    }

    const planTimes: number[] = [];
    for (let i = 0; i < opts.iters; i++) {
      const start = performance.now();
      await quiet(() => planner.plan(opp, [FLASH_SWAP_REPAY]));
      planTimes.push(performance.now() - start);
    }

    rows.push({
      topN,
      pools: slice.length,
      edges: graph.length,
      buildMs,
      planP50Ms: percentile(planTimes, 0.50),
      planP95Ms: percentile(planTimes, 0.95),
    });
  }

  printRows(rows);
}

function parseArgs(argv: string[]): BenchOptions {
  const opts: BenchOptions = {
    poolsPath: DEFAULT_POOLS_PATH,
    iters: 30,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: npm run searcher:bench-topn -- [--pools <path|${BUILTIN_SMOKE}>] ` +
          "[--topns 500,1000,1500,2500] [--iters 30]",
      );
      process.exit(0);
    }
    if (arg === "--pools") {
      opts.poolsPath = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--topns") {
      opts.topnsRaw = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--iters") {
      opts.iters = parsePositiveInt(requireValue(argv, ++i, arg), arg);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInt(raw: string, field: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

function parseTopNs(raw: string | undefined, poolCount: number): number[] {
  const parts = raw ? raw.split(",") : ["500", "1000", "1500", "2500", "full"];
  const out: number[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const topN = trimmed.toLowerCase() === "full"
      ? poolCount
      : parsePositiveInt(trimmed, "--topns");
    out.push(topN);
  }
  if (out.length === 0) throw new Error("--topns must contain at least one positive integer or full");
  return out;
}

function loadPools(path: string): RankedPoolEntry[] {
  if (path === BUILTIN_SMOKE) return builtinSmokePools();
  if (!existsSync(path)) {
    throw new Error(`pool file not found: ${path}; use --pools ${BUILTIN_SMOKE} for the offline smoke fixture`);
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const rawPools = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.pools)
      ? parsed.pools
      : null;
  if (!rawPools) throw new Error(`pool file ${path} must be an array or { pools: [...] }`);

  return rawPools
    .map((raw, i) => parsePool(raw, `${path}.pools[${i}]`))
    .sort((a, b) =>
      (b.score ?? 0) - (a.score ?? 0) ||
      (b.lastSwapBlock ?? 0) - (a.lastSwapBlock ?? 0)
    );
}

function parsePool(raw: unknown, field: string): RankedPoolEntry {
  if (!isRecord(raw)) throw new Error(`${field} must be an object`);
  const adapter = stringField(raw.adapter, `${field}.adapter`) as PoolEntry["adapter"];
  if (!isAdapter(adapter)) throw new Error(`${field}.adapter unsupported: ${adapter}`);
  const score = numberField(raw.score, `${field}.score`) ??
    numberField(raw.swapCount30d, `${field}.swapCount30d`) ??
    0;
  return {
    address: stringField(raw.address ?? raw.pool, `${field}.address`),
    adapter,
    token0: optionalString(raw.token0, `${field}.token0`),
    token1: optionalString(raw.token1, `${field}.token1`),
    poolId: optionalString(raw.poolId, `${field}.poolId`),
    currency0: optionalString(raw.currency0, `${field}.currency0`),
    currency1: optionalString(raw.currency1, `${field}.currency1`),
    fee: numberField(raw.fee, `${field}.fee`),
    tickSpacing: numberField(raw.tickSpacing, `${field}.tickSpacing`),
    hooks: optionalString(raw.hooks, `${field}.hooks`),
    fixedTokenIn: optionalString(raw.fixedTokenIn, `${field}.fixedTokenIn`),
    fixedTokenOut: optionalString(raw.fixedTokenOut, `${field}.fixedTokenOut`),
    fixedSlotKind: fixedSlotKind(raw.fixedSlotKind, `${field}.fixedSlotKind`),
    score,
    swapCount30d: numberField(raw.swapCount30d, `${field}.swapCount30d`),
    lastSwapBlock: numberField(raw.lastSwapBlock, `${field}.lastSwapBlock`),
    source: optionalString(raw.source, `${field}.source`),
  };
}

function isAdapter(value: string): value is PoolEntry["adapter"] {
  return value === "curve" ||
    value === "curve-nr" ||
    value === "univ3" ||
    value === "univ2" ||
    value === "univ4" ||
    value === "psm" ||
    value === "fluid-vault";
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a string`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return stringField(value, field);
}

function numberField(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} must be a finite number`);
  return n;
}

function fixedSlotKind(value: unknown, field: string): PoolEntry["fixedSlotKind"] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "lend" || value === "swap") return value;
  throw new Error(`${field} must be lend or swap`);
}

function pickHotToken(edges: TokenEdge[]): string {
  const wethEdge = edges.find((edge) => sameAddress(edge.tokenIn, WETH) || sameAddress(edge.tokenOut, WETH));
  if (wethEdge) return WETH;

  const venuesByToken = new Map<string, Set<string>>();
  const canonical = new Map<string, string>();
  for (const edge of edges) {
    for (const token of [edge.tokenIn, edge.tokenOut]) {
      const key = token.toLowerCase();
      canonical.set(key, token);
      const venues = venuesByToken.get(key) ?? new Set<string>();
      venues.add(edge.target.toLowerCase());
      venuesByToken.set(key, venues);
    }
  }

  let best: { key: string; degree: number } | null = null;
  for (const [key, venues] of venuesByToken) {
    const degree = venues.size;
    if (!best || degree > best.degree || (degree === best.degree && key < best.key)) {
      best = { key, degree };
    }
  }
  if (!best) throw new Error("graph has no tokens");
  return canonical.get(best.key) ?? best.key;
}

function pickImpactEdge(edges: TokenEdge[], hotToken: string): TokenEdge {
  const touching = edges.find((edge) => sameAddress(edge.tokenIn, hotToken) || sameAddress(edge.tokenOut, hotToken));
  if (touching) return touching;
  throw new Error(`hot token ${hotToken} is not present in the smallest graph`);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function printRows(rows: BenchRow[]): void {
  const headers = ["TopN", "pools", "edges", "buildMs", "plan_p50_ms", "plan_p95_ms"];
  const body = rows.map((row) => [
    String(row.topN),
    String(row.pools),
    String(row.edges),
    formatMs(row.buildMs),
    formatMs(row.planP50Ms),
    formatMs(row.planP95Ms),
  ]);
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...body.map((row) => row[i].length))
  );
  const format = (cols: string[]) => cols.map((col, i) => col.padStart(widths[i])).join(" | ");
  console.log(format(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("-|-"));
  for (const row of body) console.log(format(row));
}

function formatMs(value: number): string {
  return value.toFixed(3);
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => undefined;
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function uniqueAddresses(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function builtinSmokePools(): RankedPoolEntry[] {
  const pools: RankedPoolEntry[] = [
    pool(1, ADDR.WETH, ADDR.USDC, 10_000, 10_000),
    pool(2, ADDR.USDC, ADDR.DAI, 9_999, 9_999),
    pool(3, ADDR.DAI, ADDR.WETH, 9_998, 9_998),
    pool(4, ADDR.WETH, ADDR.USDT, 9_997, 9_997),
    pool(5, ADDR.USDT, ADDR.DAI, 9_996, 9_996),
  ];

  for (let i = 0; i < 140; i++) {
    const token = addr(0x2000 + i);
    const score = 9_000 - i;
    pools.push(pool(0x100 + i * 2, ADDR.WETH, token, score, score));
    pools.push(pool(0x101 + i * 2, token, ADDR.USDC, score - 1, score - 1));
  }
  return pools;
}

function pool(id: number, token0: string, token1: string, score: number, lastSwapBlock: number): RankedPoolEntry {
  return {
    address: addr(id),
    adapter: id % 2 === 0 ? "univ2" : "univ3",
    token0,
    token1,
    score,
    swapCount30d: score,
    lastSwapBlock,
  };
}

function addr(id: number): string {
  return ethers.getAddress(`0x${id.toString(16).padStart(40, "0")}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[bench-topn] ${message}`);
  process.exitCode = 1;
});
