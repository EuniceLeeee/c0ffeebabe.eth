import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";

/** Minimal interface for on-chain read queries. StateBackend and ethers Provider both satisfy this. */
export interface TokenQueryBackend {
  call(req: { to: string; data: string }): Promise<string>;
  getLogs?(req: {
    address: string;
    topics: string[];
    fromBlock: string;
    toBlock: string;
  }): Promise<Array<{ data: string; topics: string[] }>>;
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
  /** Uniswap v4 PoolKey. Required for univ4-unlock quotes. */
  v4PoolKey?: V4PoolKey;
  /** Uniswap v4 poolId = keccak256(abi.encode(PoolKey)). Disambiguates v4 pools
   *  that share the singleton PoolManager target (same address, different pool). */
  poolId?: string;
  /** v4 PoolKey currencyN is native ETH (0x0); the graph node is aliased to WETH, execution (slice 2b) wraps/unwraps. */
  nativeCurrency0?: boolean;
  nativeCurrency1?: boolean;
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
  /** Optional v4 pool id from Initialize/Swap logs. address remains the PoolManager target. */
  poolId?: string;
  /** Uniswap v4 PoolKey fields. Required for univ4 entries. */
  currency0?: string;
  currency1?: string;
  fee?: number;
  tickSpacing?: number;
  hooks?: string;
  /** For PSM/fluid where direction is protocol-fixed */
  fixedTokenIn?: string;
  fixedTokenOut?: string;
  fixedSlotKind?: "lend" | "swap";
  /** Activity proxy from discovery (swap-event count). undefined = curated backbone (pinned). */
  score?: number;
}

export interface V4PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

const V4_POOLKEY_TUPLE =
  "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";

/** Canonical Uniswap v4 poolId = keccak256(abi.encode(PoolKey)). */
export function v4PoolId(key: V4PoolKey): string {
  return ethers
    .keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        [V4_POOLKEY_TUPLE],
        [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]],
      ),
    )
    .toLowerCase();
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
const v4InitializeIface = new ethers.Interface([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);
const V4_INITIALIZE_TOPIC = ethers.id("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
const V4_POOL_MANAGER_DEPLOY_BLOCK = "0x0";
const v4PoolKeyCache = new Map<string, V4PoolKey>();

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
      // Edges must carry fixedTokenIn/fixedTokenOut and the full PoolKey from the registry entry.
      if (!pool.fixedTokenIn || !pool.fixedTokenOut) {
        throw new Error(`univ4 pool ${pool.address} requires fixedTokenIn/fixedTokenOut`);
      }
      const poolKey = await resolveV4PoolKey(pool, backend);
      const tIn = normalizeV4Currency(pool.fixedTokenIn, "fixedTokenIn");
      const tOut = normalizeV4Currency(pool.fixedTokenOut, "fixedTokenOut");
      validateV4Pair(pool.address, poolKey, tIn, tOut);
      const poolId = v4PoolId(poolKey);
      const graphIn = tIn === ethers.ZeroAddress ? ADDR.WETH : tIn;
      const graphOut = tOut === ethers.ZeroAddress ? ADDR.WETH : tOut;
      const nc0 = poolKey.currency0 === ethers.ZeroAddress;
      const nc1 = poolKey.currency1 === ethers.ZeroAddress;
      edges.push(
        { adapterId, target: pool.address, tokenIn: graphIn, tokenOut: graphOut, slotKind: "swap", v4PoolKey: poolKey, poolId, nativeCurrency0: nc0, nativeCurrency1: nc1 },
        { adapterId, target: pool.address, tokenIn: graphOut, tokenOut: graphIn, slotKind: "swap", v4PoolKey: poolKey, poolId, nativeCurrency0: nc0, nativeCurrency1: nc1 },
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
      v4PoolKey: {
        currency0: ADDR.DAI,
        currency1: ADDR.USDT,
        fee: 68,
        tickSpacing: 1,
        hooks: ADDR.ZERO,
      },
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
  deadlineAtMs?: number;
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
  const deadlineAtMs = opts.deadlineAtMs;

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
  let nodeExpansions = 0;

  function walk(token: string, path: TokenEdge[]): void {
    if (paths.length >= maxPaths) return;
    nodeExpansions++;
    if (nodeExpansions % 64 === 0 && deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) return;
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
    a.tokenOut.toLowerCase() === b.tokenOut.toLowerCase() &&
    v4PoolKeyIdentity(a.v4PoolKey) === v4PoolKeyIdentity(b.v4PoolKey);
}

async function resolveV4PoolKey(pool: PoolEntry, backend: TokenQueryBackend): Promise<V4PoolKey> {
  if (hasInlineV4PoolKey(pool)) return v4PoolKeyFromEntry(pool);
  if (pool.poolId && backend.getLogs) {
    const cached = v4PoolKeyCache.get(pool.poolId.toLowerCase());
    if (cached) return cached;
    const logs = await backend.getLogs({
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      topics: [V4_INITIALIZE_TOPIC, normalizeBytes32(pool.poolId, "poolId")],
      fromBlock: V4_POOL_MANAGER_DEPLOY_BLOCK,
      toBlock: "latest",
    });
    const first = logs[0];
    if (first) {
      const parsed = v4InitializeIface.parseLog({ topics: first.topics, data: first.data });
      if (parsed) {
        const key = {
          currency0: normalizeV4Currency(String(parsed.args.currency0), "currency0"),
          currency1: normalizeV4Currency(String(parsed.args.currency1), "currency1"),
          fee: uint24(Number(parsed.args.fee), "fee"),
          tickSpacing: int24(Number(parsed.args.tickSpacing), "tickSpacing"),
          hooks: normalizeV4Currency(String(parsed.args.hooks), "hooks"),
        };
        v4PoolKeyCache.set(pool.poolId.toLowerCase(), key);
        return key;
      }
    }
  }
  return v4PoolKeyFromEntry(pool);
}

function hasInlineV4PoolKey(pool: PoolEntry): boolean {
  return pool.currency0 !== undefined &&
    pool.currency1 !== undefined &&
    pool.fee !== undefined &&
    pool.tickSpacing !== undefined &&
    pool.hooks !== undefined;
}

function v4PoolKeyFromEntry(pool: PoolEntry): V4PoolKey {
  const missing: string[] = [];
  if (pool.currency0 === undefined) missing.push("currency0");
  if (pool.currency1 === undefined) missing.push("currency1");
  if (pool.fee === undefined) missing.push("fee");
  if (pool.tickSpacing === undefined) missing.push("tickSpacing");
  if (pool.hooks === undefined) missing.push("hooks");
  if (missing.length > 0) {
    const id = pool.poolId ? `${pool.address} poolId=${pool.poolId}` : pool.address;
    throw new Error(`univ4 pool ${id} missing PoolKey field(s): ${missing.join(", ")}`);
  }
  const { currency0, currency1, fee, tickSpacing, hooks } = pool as Required<
    Pick<PoolEntry, "currency0" | "currency1" | "fee" | "tickSpacing" | "hooks">
  >;
  return {
    currency0: normalizeV4Currency(currency0, "currency0"),
    currency1: normalizeV4Currency(currency1, "currency1"),
    fee: uint24(fee, "fee"),
    tickSpacing: int24(tickSpacing, "tickSpacing"),
    hooks: normalizeV4Currency(hooks, "hooks"),
  };
}

function normalizeBytes32(value: string, field: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`univ4 ${field} must be bytes32, got ${value}`);
  }
  return value.toLowerCase();
}

function validateV4Pair(pool: string, key: V4PoolKey, tokenIn: string, tokenOut: string): void {
  const currencies = new Set([key.currency0.toLowerCase(), key.currency1.toLowerCase()]);
  if (!currencies.has(tokenIn.toLowerCase()) || !currencies.has(tokenOut.toLowerCase())) {
    throw new Error(
      `univ4 pool ${pool} fixed tokens ${tokenIn}/${tokenOut} do not match PoolKey ` +
        `${key.currency0}/${key.currency1}`,
    );
  }
}

function normalizeV4Currency(value: string, field: string): string {
  if (value.toLowerCase() === "0x0") return ethers.ZeroAddress;
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(`univ4 PoolKey ${field} must be an address or 0x0, got ${value}`);
  }
}

function uint24(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) {
    throw new Error(`univ4 PoolKey ${field} must be a uint24, got ${value}`);
  }
  return value;
}

function int24(value: number, field: string): number {
  if (!Number.isInteger(value) || value < -0x800000 || value > 0x7fffff) {
    throw new Error(`univ4 PoolKey ${field} must be an int24, got ${value}`);
  }
  return value;
}

function v4PoolKeyIdentity(key: V4PoolKey | undefined): string {
  if (!key) return "";
  return [
    key.currency0.toLowerCase(),
    key.currency1.toLowerCase(),
    String(key.fee),
    String(key.tickSpacing),
    key.hooks.toLowerCase(),
  ].join(":");
}
