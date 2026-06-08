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
}

export interface TokenPath {
  edges: TokenEdge[];
}

// ─── Pool Registry (only pool addresses + adapter type) ───────

export interface PoolEntry {
  address: string;
  adapter: "curve" | "curve-nr" | "univ3" | "univ2" | "univ4" | "psm" | "fluid-vault";
  /** For PSM/fluid where direction is protocol-fixed */
  fixedTokenIn?: string;
  fixedTokenOut?: string;
  fixedSlotKind?: "lend" | "swap";
}

export const POOL_REGISTRY: PoolEntry[] = [
  // Curve pools — tokens auto-discovered via coins()
  { address: ADDR.CURVE_3POOL, adapter: "curve" },
  { address: ADDR.CURVE_DOLA_WSTUSR, adapter: "curve-nr" },
  { address: ADDR.CURVE_DOLA_SUSDS, adapter: "curve" },
  { address: ADDR.CURVE_SUSDS_USDT, adapter: "curve" },

  // UniV3 pools — tokens auto-discovered via token0()/token1()
  { address: ADDR.UNISWAP_V3_USDT_WETH, adapter: "univ3" },

  // Fixed-direction protocols
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

  const BATCH = 10;
  for (let i = 0; i < pools.length; i += BATCH) {
    const batch = pools.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map((pool) => queryPoolEdges(pool, backend)),
    );
    for (const r of results) {
      if (r.status === "fulfilled") edges.push(...r.value);
      else skipped++;
    }
  }

  console.log(
    `[token-graph] built ${edges.length} edges from ${pools.length} pools` +
      (skipped > 0 ? ` (${skipped} skipped)` : ""),
  );
  return edges;
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
      const [t0, t1] = await queryUniV3Tokens(backend, pool.address);
      edges.push(
        { adapterId, target: pool.address, tokenIn: t0, tokenOut: t1, slotKind: "swap", poolToken0: t0, poolToken1: t1 },
        { adapterId, target: pool.address, tokenIn: t1, tokenOut: t0, slotKind: "swap", poolToken0: t0, poolToken1: t1 },
      );
      break;
    }
    case "univ2": {
      const [t0, t1] = await queryUniV3Tokens(backend, pool.address);
      await verifyUniV2Pair(backend, pool.address);
      edges.push(
        { adapterId, target: pool.address, tokenIn: t0, tokenOut: t1, slotKind: "swap", poolToken0: t0, poolToken1: t1 },
        { adapterId, target: pool.address, tokenIn: t1, tokenOut: t0, slotKind: "swap", poolToken0: t0, poolToken1: t1 },
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

export function buildTokenPaths(
  edges: TokenEdge[],
  startToken: string,
  profitToken: string,
  maxDepth = 8,
): TokenPath[] {
  const paths: TokenPath[] = [];

  function walk(token: string, path: TokenEdge[]): void {
    if (path.length > 0 && token.toLowerCase() === profitToken.toLowerCase()) {
      paths.push({ edges: path });
      return;
    }
    if (path.length >= maxDepth) return;

    for (const edge of edges) {
      if (edge.tokenIn.toLowerCase() !== token.toLowerCase()) continue;
      walk(edge.tokenOut, [...path, edge]);
    }
  }

  walk(startToken, []);
  return paths;
}

