import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";

/** Minimal interface for on-chain read queries. StateBackend and ethers Provider both satisfy this. */
export interface TokenQueryBackend {
  call(req: { to: string; data: string }): Promise<string>;
}

export interface TokenEdge {
  adapterId: string;
  target: string;
  tokenIn: string;
  tokenOut: string;
  slotKind: "flash" | "lend" | "swap";
  curveI?: number;
  curveJ?: number;
  poolToken0?: string;
  poolToken1?: string;
  /** Activity/liquidity proxy (swap-event count from discovery). undefined = curated backbone (pinned, never pruned). */
  score?: number;
}

export interface TokenPath {
  edges: TokenEdge[];
}

// ─── Pool Registry (only pool addresses + adapter type) ───────

export interface PoolEntry {
  address: string;
  adapter: "curve" | "curve-nr" | "univ3" | "univ2" | "univ4" | "psm" | "fluid-vault";
  /** Optional file-backed metadata for standard two-token pools. */
  token0?: string;
  token1?: string;
  /** For PSM/fluid where direction is protocol-fixed */
  fixedTokenIn?: string;
  fixedTokenOut?: string;
  fixedSlotKind?: "lend" | "swap";
  /** Activity proxy from discovery (swap-event count). undefined = curated backbone (pinned). */
  score?: number;
}

// DEX pools are discovered via scanActivePools / factory events.
// Only protocol-specific contracts without standard factory go here.
export const POOL_REGISTRY: PoolEntry[] = [
  {
    address: ADDR.SKY_PSM_LITE,
    adapter: "psm",
    fixedTokenIn: ADDR.USDC,
    fixedTokenOut: ADDR.DAI,
    fixedSlotKind: "swap",
  },
  {
    address: ADDR.FLUID_VAULT_WSTUSR_USDC,
    adapter: "fluid-vault",
    fixedTokenIn: ADDR.WSTUSR,
    fixedTokenOut: ADDR.USDC,
    fixedSlotKind: "lend",
  },
];

// ─── Auto-build graph from pool registry via eth_call ─────────

const curveCoinsIface = new ethers.Interface([
  "function coins(uint256 i) view returns (address)",
]);
const curveCoinsIntIface = new ethers.Interface([
  "function coins(int128 i) view returns (address)",
]);
const univ3Iface = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const univ2ReservesIface = new ethers.Interface([
  "function getReserves() view returns (uint112, uint112, uint32)",
]);

const ADAPTER_MAP: Record<string, string> = {
  "curve": "curve-exchange-plain",
  "curve-nr": "curve-exchange-nr",
  "univ3": "univ3-swap",
  "univ2": "univ2-swap",
  "univ4": "univ4-unlock",
  "psm": "psm",
  "fluid-vault": "fluid-vault",
};

/**
 * Build the token graph by querying each pool's tokens on-chain.
 * Queries run in parallel batches for speed.
 */
export async function buildTokenGraph(
  backend: TokenQueryBackend,
  pools: PoolEntry[] = POOL_REGISTRY,
): Promise<TokenEdge[]> {
  const edges: TokenEdge[] = [];
  let skipped = 0;

  const BATCH = 50;
  for (let i = 0; i < pools.length; i += BATCH) {
    const batch = pools.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map((pool) => queryPoolEdges(pool, backend)),
    );
    for (const r of results) {
      if (r.status === "fulfilled") edges.push(...r.value);
      else skipped++;
    }
    if (pools.length > 200 && i % 500 === 0 && i > 0) {
      console.log(`[token-graph] progress: ${i}/${pools.length} pools, ${edges.length} edges, ${skipped} skipped`);
    }
  }

  console.log(
    `[token-graph] built ${edges.length} edges from ${pools.length} pools` +
      (skipped > 0 ? ` (${skipped} skipped)` : ""),
  );
  return edges;
}

/**
 * Build a token→pools index from edges.
 * Given a token address, returns all pool addresses that trade it.
 */
export function buildTokenIndex(edges: TokenEdge[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const edge of edges) {
    for (const token of [edge.tokenIn, edge.tokenOut]) {
      const key = token.toLowerCase();
      let pools = index.get(key);
      if (!pools) {
        pools = new Set();
        index.set(key, pools);
      }
      pools.add(edge.target.toLowerCase());
    }
  }
  return index;
}

async function queryPoolEdges(pool: PoolEntry, backend: TokenQueryBackend): Promise<TokenEdge[]> {
  const adapterId = ADAPTER_MAP[pool.adapter];
  const edges: TokenEdge[] = [];

  switch (pool.adapter) {
    case "curve":
    case "curve-nr": {
      const coins = await queryCurveCoins(backend, pool.address);
      for (let i = 0; i < coins.length; i++) {
        for (let j = 0; j < coins.length; j++) {
          if (i === j) continue;
          edges.push({
            adapterId, target: pool.address,
            tokenIn: coins[i], tokenOut: coins[j],
            slotKind: "swap", curveI: i, curveJ: j,
          });
        }
      }
      break;
    }
    case "univ3": {
      const [t0, t1] = pool.token0 && pool.token1
        ? [ethers.getAddress(pool.token0), ethers.getAddress(pool.token1)]
        : await queryUniV3Tokens(backend, pool.address);
      edges.push(
        { adapterId, target: pool.address, tokenIn: t0, tokenOut: t1, slotKind: "swap", poolToken0: t0, poolToken1: t1 },
        { adapterId, target: pool.address, tokenIn: t1, tokenOut: t0, slotKind: "swap", poolToken0: t0, poolToken1: t1 },
      );
      break;
    }
    case "univ2": {
      const [t0, t1] = pool.token0 && pool.token1
        ? [ethers.getAddress(pool.token0), ethers.getAddress(pool.token1)]
        : await queryUniV3Tokens(backend, pool.address);
      await verifyUniV2Pair(backend, pool.address);
      edges.push(
        { adapterId, target: pool.address, tokenIn: t0, tokenOut: t1, slotKind: "swap", poolToken0: t0, poolToken1: t1 },
        { adapterId, target: pool.address, tokenIn: t1, tokenOut: t0, slotKind: "swap", poolToken0: t0, poolToken1: t1 },
      );
      break;
    }
    case "univ4": {
      // V4 pools live inside the PoolManager — no individual contracts.
      // Edges must carry fixedTokenIn/fixedTokenOut from the registry entry.
      if (!pool.fixedTokenIn || !pool.fixedTokenOut) {
        throw new Error(`univ4 pool ${pool.address} requires fixedTokenIn/fixedTokenOut`);
      }
      edges.push(
        { adapterId, target: pool.address, tokenIn: pool.fixedTokenIn, tokenOut: pool.fixedTokenOut, slotKind: "swap" },
        { adapterId, target: pool.address, tokenIn: pool.fixedTokenOut, tokenOut: pool.fixedTokenIn, slotKind: "swap" },
      );
      break;
    }
    case "psm":
    case "fluid-vault": {
      if (!pool.fixedTokenIn || !pool.fixedTokenOut) {
        throw new Error(`${pool.adapter} pool ${pool.address} missing fixedTokenIn/Out`);
      }
      edges.push({
        adapterId, target: pool.address,
        tokenIn: pool.fixedTokenIn, tokenOut: pool.fixedTokenOut,
        slotKind: pool.fixedSlotKind ?? "swap",
      });
      break;
    }
  }

  // Propagate the discovery activity score onto every edge of this pool.
  // undefined (curated POOL_REGISTRY / protocol pools) stays undefined → pinned.
  for (const edge of edges) edge.score = pool.score;
  return edges;
}

// ─── On-chain queries ─────────────────────────────────────────

async function queryCurveCoins(backend: TokenQueryBackend, pool: string): Promise<string[]> {
  const coins: string[] = [];
  for (let i = 0; i < 8; i++) {
    const addr = await queryCurveCoinAt(backend, pool, i);
    if (!addr) break;
    coins.push(addr);
  }
  if (coins.length === 0) throw new Error(`curve pool ${pool} returned no coins`);
  return coins;
}

async function queryCurveCoinAt(backend: TokenQueryBackend, pool: string, index: number): Promise<string | null> {
  for (const iface of [curveCoinsIface, curveCoinsIntIface]) {
    try {
      const data = iface.encodeFunctionData("coins", [BigInt(index)]);
      const result = await backend.call({ to: pool, data });
      if (!result || result === "0x") continue;
      const addr = ethers.getAddress("0x" + result.slice(-40));
      if (addr === ethers.ZeroAddress) return null;
      return addr;
    } catch {
      continue;
    }
  }
  return null;
}

async function queryUniV3Tokens(backend: TokenQueryBackend, pool: string): Promise<[string, string]> {
  const t0Data = univ3Iface.encodeFunctionData("token0");
  const t1Data = univ3Iface.encodeFunctionData("token1");
  const r0 = await backend.call({ to: pool, data: t0Data });
  const r1 = await backend.call({ to: pool, data: t1Data });
  return [
    ethers.getAddress("0x" + r0.slice(-40)),
    ethers.getAddress("0x" + r1.slice(-40)),
  ];
}

async function verifyUniV2Pair(backend: TokenQueryBackend, pool: string): Promise<void> {
  const data = univ2ReservesIface.encodeFunctionData("getReserves");
  const result = await backend.call({ to: pool, data });
  if (!result || result === "0x" || result.length < 194) {
    throw new Error(`${pool} failed getReserves — not a valid UniV2 pair`);
  }
}

// ─── Sync fallback (used by AC-3 tests that don't want async init) ──

/**
 * Hardcoded fallback — same pools, manually written edges.
 * Kept for AC-3 tests that run without a live Anvil for graph init.
 * Production should use buildTokenGraph(state) instead.
 */
export function defaultTokenGraph(): TokenEdge[] {
  return [
    {
      adapterId: "fluid-vault",
      target: ADDR.FLUID_VAULT_WSTUSR_USDC,
      tokenIn: ADDR.WSTUSR,
      tokenOut: ADDR.USDC,
      slotKind: "lend",
    },
    {
      adapterId: "psm",
      target: ADDR.SKY_PSM_LITE,
      tokenIn: ADDR.USDC,
      tokenOut: ADDR.DAI,
      slotKind: "swap",
    },
    {
      adapterId: "univ4-unlock",
      target: ADDR.UNISWAP_V4_POOL_MANAGER,
      tokenIn: ADDR.DAI,
      tokenOut: ADDR.USDT,
      slotKind: "swap",
    },
    {
      adapterId: "curve-exchange-plain",
      target: ADDR.CURVE_3POOL,
      tokenIn: ADDR.USDC,
      tokenOut: ADDR.USDT,
      slotKind: "swap",
      curveI: 1,
      curveJ: 2,
    },
    {
      adapterId: "curve-exchange-plain",
      target: ADDR.CURVE_3POOL,
      tokenIn: ADDR.USDC,
      tokenOut: ADDR.DAI,
      slotKind: "swap",
      curveI: 1,
      curveJ: 0,
    },
    {
      adapterId: "curve-exchange-plain",
      target: ADDR.CURVE_3POOL,
      tokenIn: ADDR.DAI,
      tokenOut: ADDR.USDT,
      slotKind: "swap",
      curveI: 0,
      curveJ: 2,
    },
    {
      adapterId: "univ3-swap",
      target: ADDR.UNISWAP_V3_USDT_WETH,
      tokenIn: ADDR.USDT,
      tokenOut: ADDR.WETH,
      slotKind: "swap",
      poolToken0: ADDR.WETH,
      poolToken1: ADDR.USDT,
    },
    {
      adapterId: "univ3-swap",
      target: ADDR.UNISWAP_V3_USDT_WETH,
      tokenIn: ADDR.WETH,
      tokenOut: ADDR.USDT,
      slotKind: "swap",
      poolToken0: ADDR.WETH,
      poolToken1: ADDR.USDT,
    },
    {
      adapterId: "curve-exchange",
      target: ADDR.CURVE_SUSDS_USDT,
      tokenIn: ADDR.USDT,
      tokenOut: ADDR.SUSDS,
      slotKind: "swap",
    },
    {
      adapterId: "curve-exchange",
      target: ADDR.CURVE_DOLA_SUSDS,
      tokenIn: ADDR.SUSDS,
      tokenOut: ADDR.DOLA,
      slotKind: "swap",
    },
    {
      adapterId: "curve-exchange-nr",
      target: ADDR.CURVE_DOLA_WSTUSR,
      tokenIn: ADDR.DOLA,
      tokenOut: ADDR.WSTUSR,
      slotKind: "swap",
      curveI: 0,
      curveJ: 1,
    },
  ];
}

// ─── DFS path enumeration ─────────────────────────────────────

export interface PathOpts {
  /** Max number of hops (edges) in a path. */
  maxHops?: number;
  /** Per-token cap on outgoing edges explored, ranked by score desc. Pinned edges are exempt. */
  maxPoolsPerToken?: number;
  /** Pool addresses (lowercase) exempt from top-N truncation (e.g. the victim/affected pool). */
  pinnedPools?: Set<string>;
  /** Hard safety cap on total enumerated paths (prevents DFS blow-up / OOM). */
  maxPaths?: number;
}

/**
 * Enumerate token paths from startToken to profitToken via DFS.
 *
 * sui-mev-style "fewer paths": at each token we only expand the top-N outgoing
 * edges by score (activity/liquidity proxy), keeping pinned edges (curated
 * backbone with score===undefined, plus the victim pool) regardless of rank.
 * maxHops caps depth; maxPaths is a hard OOM guard. Defaults are unbounded
 * (maxPoolsPerToken=Infinity, maxHops=8) so existing callers/tests are unchanged.
 */
export function buildTokenPaths(
  edges: TokenEdge[],
  startToken: string,
  profitToken: string,
  opts: PathOpts = {},
): TokenPath[] {
  const maxHops = opts.maxHops ?? 8;
  const maxPoolsPerToken = opts.maxPoolsPerToken ?? Infinity;
  const pinnedPools = opts.pinnedPools;
  const maxPaths = opts.maxPaths ?? 20000;

  const isPinned = (e: TokenEdge): boolean =>
    e.score === undefined || (pinnedPools?.has(e.target.toLowerCase()) ?? false);

  // Group outgoing edges by tokenIn, then truncate each token to its top-N by
  // score (pinned edges always kept). This is the core path-count limiter.
  const outByToken = new Map<string, TokenEdge[]>();
  for (const e of edges) {
    const k = e.tokenIn.toLowerCase();
    const arr = outByToken.get(k);
    if (arr) arr.push(e);
    else outByToken.set(k, [e]);
  }
  if (maxPoolsPerToken !== Infinity) {
    for (const [k, arr] of outByToken) {
      if (arr.length <= maxPoolsPerToken) continue;
      const pinned = arr.filter(isPinned);
      const rest = arr
        .filter((e) => !isPinned(e))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, Math.max(0, maxPoolsPerToken - pinned.length));
      outByToken.set(k, [...pinned, ...rest]);
    }
  }

  const paths: TokenPath[] = [];

  function walk(token: string, path: TokenEdge[]): void {
    if (paths.length >= maxPaths) return;
    if (path.length > 0 && token.toLowerCase() === profitToken.toLowerCase()) {
      paths.push({ edges: path });
      return;
    }
    if (path.length >= maxHops) return;

    const outs = outByToken.get(token.toLowerCase());
    if (!outs) return;
    for (const edge of outs) {
      if (path.some((used) => sameDirectedEdge(used, edge))) continue;
      walk(edge.tokenOut, [...path, edge]);
      if (paths.length >= maxPaths) return;
    }
  }

  walk(startToken, []);
  return paths;
}

function sameDirectedEdge(a: TokenEdge, b: TokenEdge): boolean {
  return a.adapterId === b.adapterId &&
    a.target.toLowerCase() === b.target.toLowerCase() &&
    a.tokenIn.toLowerCase() === b.tokenIn.toLowerCase() &&
    a.tokenOut.toLowerCase() === b.tokenOut.toLowerCase();
}
