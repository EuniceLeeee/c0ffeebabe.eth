import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { OrderflowEvent } from "../orderflow/manual-source.js";
import { v4PoolId, type TokenEdge, type TokenQueryBackend } from "../planner/token-graph.js";

export interface PoolImpact {
  pool: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  /** Victim's swap output amount. v2/v3/curve appliers recompute it locally from amountIn, so it is
   *  only carried for v4 (whose Swap event provides the exact deltas and whose applier does no math). */
  amountOut?: bigint;
  matchedAdapterId: string;
  /** Uniswap v4 poolId — preserves pool identity across the singleton PoolManager
   *  (all v4 pools share the same `pool` address). Undefined for v2/v3/curve. */
  poolId?: string;
  /** Exact UniV3 post-swap state carried by Swap events. Undefined for non-v3 impacts. */
  v3PostState?: {
    sqrtPriceX96: bigint;
    liquidity: bigint;
    tick: number;
  };
  /** Exact UniV2 post-swap reserves carried by Sync events, or computed from pre-reserves + Swap amounts. */
  v2PostState?: {
    reserve0: bigint;
    reserve1: bigint;
    blockTimestampLast?: number;
    token0?: string;
    token1?: string;
  };
  /** Exact UniV4 post-swap state carried by PoolManager Swap events. Undefined for non-v4 impacts. */
  v4PostState?: {
    sqrtPriceX96: bigint;
    liquidity: bigint;
    tick: number;
    poolId: string;
    lpFee?: number;
  };
  /** Pool token order, when known from the graph or token0/token1 reads. */
  poolToken0?: string;
  poolToken1?: string;
}

interface EventLog {
  address: string;
  topics: string[];
  data: string;
}

interface ImpactDecoder {
  adapterIds: string[];
  decodeLog(log: EventLog, edges: TokenEdge[]): PoolImpact[];
}

// ─── Topic hashes (computed, not hand-written) ────────────────

const topic = (sig: string) => ethers.id(sig);

const CURVE_TOKEN_EXCHANGE_TOPICS = new Set([
  topic("TokenExchange(address,int128,uint256,int128,uint256)"),
  topic("TokenExchange(address,uint256,uint256,uint256,uint256)"),
  topic("TokenExchangeUnderlying(address,int128,uint256,int128,uint256)"),
]);
const UNIV3_SWAP = topic("Swap(address,address,int256,int256,uint160,uint128,int24)");
const UNIV2_SWAP = topic("Swap(address,uint256,uint256,uint256,uint256,address)");
const UNIV2_SYNC = topic("Sync(uint112,uint112)");
const UNIV4_SWAP = topic("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const ERC20_TRANSFER = topic("Transfer(address,address,uint256)");

const univ2PairIface = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

function decodeUniV3SwapData(data: string): {
  amount0: bigint;
  amount1: bigint;
  v3PostState: NonNullable<PoolImpact["v3PostState"]>;
} {
  const [amount0, amount1, sqrtPriceX96, liquidity, tick] = ethers.AbiCoder.defaultAbiCoder().decode(
    ["int256", "int256", "uint160", "uint128", "int24"],
    data,
  );
  return {
    amount0: BigInt(amount0),
    amount1: BigInt(amount1),
    v3PostState: {
      sqrtPriceX96: BigInt(sqrtPriceX96),
      liquidity: BigInt(liquidity),
      tick: Number(tick),
    },
  };
}

function decodeUniV2SwapData(data: string): {
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
} {
  const [amount0In, amount1In, amount0Out, amount1Out] = ethers.AbiCoder.defaultAbiCoder().decode(
    ["uint256", "uint256", "uint256", "uint256"],
    data,
  );
  return {
    amount0In: BigInt(amount0In),
    amount1In: BigInt(amount1In),
    amount0Out: BigInt(amount0Out),
    amount1Out: BigInt(amount1Out),
  };
}

function decodeUniV2SyncData(data: string): NonNullable<PoolImpact["v2PostState"]> {
  const [reserve0, reserve1] = ethers.AbiCoder.defaultAbiCoder().decode(["uint112", "uint112"], data);
  return {
    reserve0: BigInt(reserve0),
    reserve1: BigInt(reserve1),
  };
}

// ─── Curve direct-call selectors ──────────────────────────────

const curveIface = new ethers.Interface([
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)",
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)",
  "function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy)",
  "function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)",
  "function exchange_underlying(int128 i, int128 j, uint256 dx, uint256 min_dy)",
]);

const CURVE_SELECTORS = new Set([
  "0x3df02124",
  "0xddc1f59d",
  "0x7e3db030",
  "0xafb43012",
  "0xa6417ed6",
]);

// ─── Curve decoder ────────────────────────────────────────────

const curveDecoder: ImpactDecoder = {
  adapterIds: [
    "curve-exchange-plain",
    "curve-exchange-nr",
    "curve-exchange",
    "curve-exchange-received-uint",
    "curve-exchange-underlying",
  ],

  decodeLog(log, edges) {
    if (!CURVE_TOKEN_EXCHANGE_TOPICS.has(log.topics[0]?.toLowerCase() ?? "")) return [];

    const [soldId, tokensSold, boughtId] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint256", "uint256", "uint256", "uint256"],
      log.data,
    );

    return impactsFromCurveIds(log.address, BigInt(soldId), BigInt(boughtId), BigInt(tokensSold), edges);
  },
};

function impactsFromCurveIds(
  pool: string,
  i: bigint,
  j: bigint,
  amountIn: bigint,
  edges: TokenEdge[],
): PoolImpact[] {
  const out: PoolImpact[] = [];

  for (const edge of edges) {
    if (edge.curveI === undefined || edge.curveJ === undefined) continue;
    if (BigInt(edge.curveI) === i && BigInt(edge.curveJ) === j) {
      out.push({
        pool: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
        amountIn,
        matchedAdapterId: edge.adapterId,
      });
    } else if (BigInt(edge.curveI) === j && BigInt(edge.curveJ) === i) {
      out.push({
        pool: edge.target,
        tokenIn: edge.tokenOut,
        tokenOut: edge.tokenIn,
        amountIn,
        matchedAdapterId: edge.adapterId,
      });
    }
  }

  if (out.length > 0) return out;
  // Fallback: single edge, direction unknown — return as-is
  if (edges.length === 1) {
    return [{
      pool: edges[0].target,
      tokenIn: edges[0].tokenIn,
      tokenOut: edges[0].tokenOut,
      amountIn,
      matchedAdapterId: edges[0].adapterId,
    }];
  }

  return [];
}

// ─── UniV3 decoder ────────────────────────────────────────────

const uniV3Decoder: ImpactDecoder = {
  adapterIds: ["univ3-swap"],

  decodeLog(log, edges) {
    if (log.topics[0]?.toLowerCase() !== UNIV3_SWAP) return [];

    const { amount0: a0, amount1: a1, v3PostState } = decodeUniV3SwapData(log.data);

    const sample = edges.find((e) => e.poolToken0 && e.poolToken1);
    if (!sample?.poolToken0 || !sample?.poolToken1) return [];

    const tokenIn = a0 > 0n ? sample.poolToken0 : sample.poolToken1;
    const tokenOut = a0 > 0n ? sample.poolToken1 : sample.poolToken0;
    const amountIn = a0 > 0n ? a0 : a1;

    const edge = edges.find(
      (e) =>
        e.adapterId === "univ3-swap" &&
        e.tokenIn.toLowerCase() === tokenIn.toLowerCase() &&
        e.tokenOut.toLowerCase() === tokenOut.toLowerCase(),
    );
    if (!edge) return [];

    return [{
      pool: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amountIn,
      matchedAdapterId: edge.adapterId,
      v3PostState,
    }];
  },
};

// ─── UniV2 decoder ────────────────────────────────────────────

const uniV2Decoder: ImpactDecoder = {
  adapterIds: ["univ2-swap"],

  decodeLog(log, edges) {
    if (log.topics[0]?.toLowerCase() !== UNIV2_SWAP) return [];

    const { amount0In, amount1In } = decodeUniV2SwapData(log.data);

    const sample = edges.find((e) => e.poolToken0 && e.poolToken1);
    if (!sample?.poolToken0 || !sample?.poolToken1) return [];

    const tokenIn = amount0In > 0n ? sample.poolToken0 : sample.poolToken1;
    const tokenOut = amount0In > 0n ? sample.poolToken1 : sample.poolToken0;
    const amountIn = amount0In > 0n ? amount0In : amount1In;

    const edge = edges.find(
      (e) =>
        e.adapterId === "univ2-swap" &&
        e.tokenIn.toLowerCase() === tokenIn.toLowerCase() &&
        e.tokenOut.toLowerCase() === tokenOut.toLowerCase(),
    );
    if (!edge) return [];

    return [{
      pool: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amountIn,
      matchedAdapterId: edge.adapterId,
      poolToken0: sample.poolToken0,
      poolToken1: sample.poolToken1,
    }];
  },
};

// ─── UniV4 decoder ────────────────────────────────────────────
// V4 swaps are emitted by the singleton PoolManager (log.address == PoolManager
// for EVERY pool), so the pool is identified by poolId = keccak256(abi.encode(
// PoolKey)) in topics[1], not by address. Edges are matched by recomputing that
// hash from each edge's V4PoolKey. amount0/amount1 are int128 pool-balance deltas:
// positive = pool received (tokenIn), negative = pool paid out (tokenOut) — same
// convention as the v3 decoder above. Verified against the on-chain USDC/USDT swap
// in tx 0xd60d80df (amount1 +35045872323 USDT in / amount0 -35013321757 USDC out)
// cross-checked with the V4Quoter.

const uniV4Decoder: ImpactDecoder = {
  adapterIds: ["univ4-unlock"],

  decodeLog(log, edges) {
    if (log.topics[0]?.toLowerCase() !== UNIV4_SWAP) return [];
    const poolId = log.topics[1]?.toLowerCase();
    if (!poolId) return [];

    const [amount0, amount1, sqrtPriceX96, liquidity, tick, fee] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["int128", "int128", "uint160", "uint128", "int24", "uint24"],
      log.data,
    );
    const a0 = BigInt(amount0);
    const a1 = BigInt(amount1);

    // All v4 pools share the PoolManager target, so filter by poolId. Prefer the
    // edge's precomputed poolId (set at graph build); fall back to computing it.
    const matching = edges.filter(
      (e) => e.v4PoolKey && (e.poolId ?? v4PoolId(e.v4PoolKey)) === poolId,
    );
    if (matching.length === 0) return [];
    const key = matching[0].v4PoolKey!;

    const rawTokenIn = a0 > 0n ? key.currency0 : key.currency1;
    const rawTokenOut = a0 > 0n ? key.currency1 : key.currency0;
    const amountIn = a0 > 0n ? a0 : a1;
    if (amountIn <= 0n) return [];
    // Native ETH is aliased to WETH for routing (1:1 via wrap/unwrap; executed in slice 2b).
    const aliasWeth = (c: string) => (c === ethers.ZeroAddress ? ADDR.WETH : c);
    const tokenIn = aliasWeth(rawTokenIn);
    const tokenOut = aliasWeth(rawTokenOut);

    const edge = matching.find(
      (e) =>
        e.tokenIn.toLowerCase() === tokenIn.toLowerCase() &&
        e.tokenOut.toLowerCase() === tokenOut.toLowerCase(),
    );
    if (!edge) return [];

    // poolId preserves v4 pool identity downstream (dedupe / focus), since every
    // v4 pool shares the PoolManager `pool` address.
    return [{
      pool: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amountIn,
      // Output = the negative (paid-out) delta's magnitude; amountIn is the positive one.
      amountOut: a0 > 0n ? -a1 : -a0,
      matchedAdapterId: edge.adapterId,
      poolId,
      v4PostState: {
        sqrtPriceX96: BigInt(sqrtPriceX96),
        liquidity: BigInt(liquidity),
        tick: Number(tick),
        poolId,
        lpFee: Number(fee),
      },
    }];
  },
};

// ─── Decoder registry ─────────────────────────────────────────

const IMPACT_DECODERS: ImpactDecoder[] = [
  curveDecoder,
  uniV3Decoder,
  uniV2Decoder,
  uniV4Decoder,
];

// ─── Transfer-based pool detection ───────────────────────────
// MEV-Share hints often only expose ERC-20 Transfer logs.
// Paired transfers (tokenA→pool + pool→tokenB in same hint) reliably
// indicate a swap. Single transfers are ambiguous (could be LP add,
// repay, settlement) and only logged, not acted on.

interface PoolTouch {
  pool: string;
  token: string;
  amount: bigint;
  direction: "in" | "out";
}

function collectPoolTouches(
  logs: EventLog[],
  edgesByTarget: Map<string, TokenEdge[]>,
  broadPoolAddrs?: Map<string, string> | null,
): PoolTouch[] {
  const touches: PoolTouch[] = [];
  // Use broad pool map (factory-indexed) if available, otherwise routing graph keys
  const poolSet: { has(k: string): boolean } = broadPoolAddrs ?? new Set(edgesByTarget.keys());

  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER) continue;
    if (log.topics.length < 3) continue;

    const token = log.address.toLowerCase();
    const from = ("0x" + log.topics[1].slice(26)).toLowerCase();
    const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
    const value = parseUintLogData(log.data);
    if (value === null) continue;
    if (value === 0n) continue;

    if (poolSet.has(to)) {
      touches.push({ pool: to, token, amount: value, direction: "in" });
    }
    if (poolSet.has(from)) {
      touches.push({ pool: from, token, amount: value, direction: "out" });
    }
  }
  return touches;
}

/** Adapter ID suffix → full swap adapter ID */
const FACTORY_ADAPTER_MAP: Record<string, string> = {
  univ2: "univ2-swap",
  univ3: "univ3-swap",
  curve: "curve-exchange",
  "curve-nr": "curve-exchange-nr",
};

function pairedTransferImpacts(
  touches: PoolTouch[],
  edgesByTarget: Map<string, TokenEdge[]>,
  broadPoolAddrs?: Map<string, string> | null,
): PoolImpact[] {
  const byPool = new Map<string, PoolTouch[]>();
  for (const t of touches) {
    const arr = byPool.get(t.pool) ?? [];
    arr.push(t);
    byPool.set(t.pool, arr);
  }

  const impacts: PoolImpact[] = [];
  for (const [pool, poolTouches] of byPool) {
    const ins = poolTouches.filter(isInboundTouch);
    const outs = poolTouches.filter(isOutboundTouch);
    if (ins.length === 0 || outs.length === 0) continue;

    const edges = edgesByTarget.get(pool);

    for (const inT of ins) {
      for (const outT of outs) {
        if (inT.token === outT.token) continue;

        if (edges) {
          // Routing graph pool: match against known edges
          const edge = edges.find(
            (e) =>
              e.tokenIn.toLowerCase() === inT.token &&
              e.tokenOut.toLowerCase() === outT.token,
          );
          if (edge) {
            impacts.push({
              pool: edge.target,
              tokenIn: edge.tokenIn,
              tokenOut: edge.tokenOut,
              amountIn: inT.amount,
              matchedAdapterId: edge.adapterId,
              poolToken0: edge.poolToken0,
              poolToken1: edge.poolToken1,
            });
          }
        } else {
          // Factory-indexed pool without routing graph edges:
          // create impact from Transfer log tokens directly.
          // Look up adapter type from factory pool map.
          const factoryAdapter = broadPoolAddrs?.get(pool);
          const adapterId = factoryAdapter
            ? (FACTORY_ADAPTER_MAP[factoryAdapter] ?? "univ2-swap")
            : "univ2-swap";
          impacts.push({
            pool,
            tokenIn: inT.token,
            tokenOut: outT.token,
            amountIn: inT.amount,
            matchedAdapterId: adapterId,
          });
        }
      }
    }
  }
  return impacts;
}

/**
 * Detect pools by correlating Swap events with Transfer events.
 *
 * If a log address emits a UniV2 Swap (0xd78ad95f) or UniV3 Swap (0xc42079f9),
 * and the same address appears as from/to in Transfer events, it's a pool —
 * even if not in our factory set or routing graph.
 *
 * Skips pools already covered by standard decoders or Transfer fallback.
 */
function swapEventCorrelatedImpacts(
  logs: EventLog[],
  edgesByTarget: Map<string, TokenEdge[]>,
  broadPoolAddrs?: Map<string, string> | null,
): PoolImpact[] {
  // Step 1: Find addresses that emitted a Swap event
  const swapPools = new Map<string, { adapter: string; v3PostState?: NonNullable<PoolImpact["v3PostState"]> }>();
  for (const log of logs) {
    const t0 = log.topics[0]?.toLowerCase();
    const addr = log.address.toLowerCase();
    // Skip if already in routing graph or broadPoolAddrs (handled above)
    if (edgesByTarget.has(addr)) continue;
    if (broadPoolAddrs?.has(addr)) continue;

    if (t0 === UNIV2_SWAP) {
      swapPools.set(addr, { adapter: "univ2-swap" });
    } else if (t0 === UNIV3_SWAP) {
      try {
        swapPools.set(addr, { adapter: "univ3-swap", v3PostState: decodeUniV3SwapData(log.data).v3PostState });
      } catch {
        swapPools.set(addr, { adapter: "univ3-swap" });
      }
    }
  }
  if (swapPools.size === 0) return [];

  // Step 2: Find Transfer events involving these Swap-emitting addresses
  const transfers = new Map<string, { ins: PoolTouch[]; outs: PoolTouch[] }>();
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER) continue;
    if (log.topics.length < 3) continue;
    const token = log.address.toLowerCase();
    const from = ("0x" + log.topics[1].slice(26)).toLowerCase();
    const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
    const value = parseUintLogData(log.data);
    if (value === null) continue;
    if (value === 0n) continue;

    if (swapPools.has(to)) {
      const entry = transfers.get(to) ?? { ins: [], outs: [] };
      entry.ins.push({ pool: to, token, amount: value, direction: "in" });
      transfers.set(to, entry);
    }
    if (swapPools.has(from)) {
      const entry = transfers.get(from) ?? { ins: [], outs: [] };
      entry.outs.push({ pool: from, token, amount: value, direction: "out" });
      transfers.set(from, entry);
    }
  }

  // Step 3: Create impacts for pools with paired in+out transfers
  const impacts: PoolImpact[] = [];
  for (const [pool, { ins, outs }] of transfers) {
    if (ins.length === 0 || outs.length === 0) continue;
    const swapMeta = swapPools.get(pool)!;
    for (const inT of ins) {
      for (const outT of outs) {
        if (inT.token === outT.token) continue;
        impacts.push({
          pool,
          tokenIn: inT.token,
          tokenOut: outT.token,
          amountIn: inT.amount,
          matchedAdapterId: swapMeta.adapter,
          ...(swapMeta.v3PostState ? { v3PostState: swapMeta.v3PostState } : {}),
        });
      }
    }
  }
  return impacts;
}

// ─── Swap-only detection (async, queries token0/token1) ─────
// MEV-Share sometimes exposes ONLY the Swap event — no Transfer logs.
// Standard decoders handle this for pools in the routing graph.
// For unknown pools (not in edgesByTarget), we query token0/token1
// on-chain, then decode swap direction from the event data.

const TOKEN0_TOKEN1_IFACE = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

// Module-level cache: pool address → [token0, token1].
// Survives across calls within the same process (avoids duplicate on-chain queries).
const poolTokenCache = new Map<string, [string, string]>();

async function swapOnlyImpacts(
  logs: EventLog[],
  edgesByTarget: Map<string, TokenEdge[]>,
  broadPoolAddrs: Map<string, string> | null | undefined,
  tokenQuery: TokenQueryBackend,
): Promise<PoolImpact[]> {
  const impacts: PoolImpact[] = [];

  // Collect Swap events at pools NOT already in routing graph
  const unknownSwaps: Array<{ log: EventLog; addr: string; swapType: "univ2" | "univ3" }> = [];
  for (const log of logs) {
    const addr = log.address.toLowerCase();
    if (edgesByTarget.has(addr)) continue; // standard decoder handles it
    const t0 = log.topics[0]?.toLowerCase();
    if (t0 === UNIV2_SWAP) unknownSwaps.push({ log, addr, swapType: "univ2" });
    else if (t0 === UNIV3_SWAP) unknownSwaps.push({ log, addr, swapType: "univ3" });
  }
  if (unknownSwaps.length === 0) return impacts;

  // Query token0/token1 for uncached pools (parallel, 2 eth_calls each)
  const uniquePools = [...new Set(unknownSwaps.map((s) => s.addr))];
  const uncached = uniquePools.filter((p) => !poolTokenCache.has(p));

  if (uncached.length > 0) {
    const t0Data = TOKEN0_TOKEN1_IFACE.encodeFunctionData("token0");
    const t1Data = TOKEN0_TOKEN1_IFACE.encodeFunctionData("token1");

    await Promise.allSettled(
      uncached.map(async (pool) => {
        try {
          const [r0, r1] = await Promise.all([
            tokenQuery.call({ to: pool, data: t0Data }),
            tokenQuery.call({ to: pool, data: t1Data }),
          ]);
          if (!r0 || r0 === "0x" || !r1 || r1 === "0x") return;
          const token0 = ethers.getAddress("0x" + r0.slice(-40));
          const token1 = ethers.getAddress("0x" + r1.slice(-40));
          if (token0 !== ethers.ZeroAddress && token1 !== ethers.ZeroAddress) {
            poolTokenCache.set(pool, [token0, token1]);
          }
        } catch {
          // Not a standard Uni pool, or RPC failure — skip silently
        }
      }),
    );
  }

  for (const { log, addr, swapType } of unknownSwaps) {
    const tokens = poolTokenCache.get(addr);
    if (!tokens) continue;
    const [token0, token1] = tokens;

    try {
      let tokenIn: string, tokenOut: string, amountIn: bigint;
      let v3PostState: PoolImpact["v3PostState"];
      let v2PostState: PoolImpact["v2PostState"];

      if (swapType === "univ2") {
        const swap = decodeUniV2SwapData(log.data);
        tokenIn = swap.amount0In > 0n ? token0 : token1;
        tokenOut = swap.amount0In > 0n ? token1 : token0;
        amountIn = swap.amount0In > 0n ? swap.amount0In : swap.amount1In;
        v2PostState = await computeUniV2PostStateFromPreReserves(addr, swap, tokenQuery) ?? undefined;
      } else {
        const { amount0: a0, amount1: a1, v3PostState: postState } = decodeUniV3SwapData(log.data);
        // UniV3: positive amount = tokens sent TO pool (input)
        tokenIn = a0 > 0n ? token0 : token1;
        tokenOut = a0 > 0n ? token1 : token0;
        amountIn = a0 > 0n ? a0 : a1;
        if (amountIn < 0n) amountIn = -amountIn;
        v3PostState = postState;
      }

      const factoryAdapter = broadPoolAddrs?.get(addr);
      const adapterId = factoryAdapter
        ? (FACTORY_ADAPTER_MAP[factoryAdapter] ?? (swapType === "univ2" ? "univ2-swap" : "univ3-swap"))
        : (swapType === "univ2" ? "univ2-swap" : "univ3-swap");

      impacts.push({
        pool: addr,
        tokenIn,
        tokenOut,
        amountIn,
        matchedAdapterId: adapterId,
        poolToken0: token0,
        poolToken1: token1,
        ...(v2PostState ? { v2PostState } : {}),
        ...(v3PostState ? { v3PostState } : {}),
      });
      console.log(
        `[pool-impact] swap-only decoded: pool=${addr.slice(0, 10)} ` +
          `${tokenIn.slice(0, 10)}→${tokenOut.slice(0, 10)} amt=${amountIn}`,
      );
    } catch {
      // Malformed Swap event data — skip
    }
  }

  return impacts;
}

function isInboundTouch(touch: PoolTouch): boolean {
  const { direction } = touch;
  return direction === "in";
}

function parseUintLogData(data: string): bigint | null {
  if (!data || data === "0x") return null;
  try {
    return BigInt(data);
  } catch {
    return null;
  }
}

function isOutboundTouch(touch: PoolTouch): boolean {
  const { direction } = touch;
  return direction === "out";
}

// ─── Public API ───────────────────────────────────────────────

export async function detectImpactFromLogs(
  logs: EventLog[],
  graph: TokenEdge[],
  broadPoolAddrs?: Map<string, string> | null,
  tokenQuery?: TokenQueryBackend | null,
): Promise<PoolImpact[]> {
  const impacts: PoolImpact[] = [];
  const edgesByTarget = groupEdgesByTarget(graph);
  const v2PostStates = await collectUniV2PostStates(logs, tokenQuery);

  for (const log of logs) {
    // Standard decoders: log.address is a known pool in routing graph
    const edges = edgesByTarget.get(log.address.toLowerCase());
    if (edges && edges.length > 0) {
      for (const decoder of IMPACT_DECODERS) {
        if (!edges.some((edge) => decoder.adapterIds.includes(edge.adapterId))) continue;
        try {
          impacts.push(...withExactPostStates(decoder.decodeLog(log, edges), v2PostStates));
        } catch {
          continue;
        }
      }
    }
  }

  // Paired Transfer fallback: tokenA→pool + pool→tokenB = swap
  // Uses broadPoolAddrs (factory-indexed) for wider matching
  const touches = collectPoolTouches(logs, edgesByTarget, broadPoolAddrs);
  impacts.push(...withExactPostStates(pairedTransferImpacts(touches, edgesByTarget, broadPoolAddrs), v2PostStates));

  // Swap-event correlation: detect unknown pools by correlating Swap events
  // with Transfer events in the same log set. Works for any pool, even those
  // not in broadPoolAddrs (created before our factory scan window).
  impacts.push(...withExactPostStates(swapEventCorrelatedImpacts(logs, edgesByTarget, broadPoolAddrs), v2PostStates));

  // Swap-only hints: MEV-Share often exposes only the Swap event (no Transfer).
  // For pools in the routing graph, the standard decoder already handles this.
  // For unknown pools, query token0/token1 on-chain and decode from Swap data.
  if (tokenQuery) {
    impacts.push(...withExactPostStates(
      await swapOnlyImpacts(logs, edgesByTarget, broadPoolAddrs, tokenQuery),
      v2PostStates,
    ));
  }

  return dedupeImpacts(impacts);
}

async function collectUniV2PostStates(
  logs: EventLog[],
  tokenQuery?: TokenQueryBackend | null,
): Promise<Map<string, NonNullable<PoolImpact["v2PostState"]>>> {
  const out = new Map<string, NonNullable<PoolImpact["v2PostState"]>>();
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    if (log.topics[0]?.toLowerCase() !== UNIV2_SWAP) continue;
    const pool = log.address.toLowerCase();
    const syncState = adjacentUniV2SyncPostState(logs, i);
    if (syncState) {
      out.set(pool, syncState);
      continue;
    }
    if (!tokenQuery) continue;
    try {
      const postState = await computeUniV2PostStateFromPreReserves(
        pool,
        decodeUniV2SwapData(log.data),
        tokenQuery,
      );
      if (postState) out.set(pool, postState);
    } catch {
      continue;
    }
  }
  return out;
}

function adjacentUniV2SyncPostState(
  logs: EventLog[],
  swapIndex: number,
): NonNullable<PoolImpact["v2PostState"]> | null {
  const pool = logs[swapIndex].address.toLowerCase();
  for (let i = swapIndex - 1; i >= 0; i--) {
    if (logs[i].address.toLowerCase() !== pool) continue;
    const t0 = logs[i].topics[0]?.toLowerCase();
    if (t0 === UNIV2_SYNC) return decodeUniV2SyncData(logs[i].data);
    if (t0 === UNIV2_SWAP) break;
  }
  for (let i = swapIndex + 1; i < logs.length; i++) {
    if (logs[i].address.toLowerCase() !== pool) continue;
    const t0 = logs[i].topics[0]?.toLowerCase();
    if (t0 === UNIV2_SYNC) return decodeUniV2SyncData(logs[i].data);
    if (t0 === UNIV2_SWAP) break;
  }
  return null;
}

async function computeUniV2PostStateFromPreReserves(
  pool: string,
  swap: ReturnType<typeof decodeUniV2SwapData>,
  tokenQuery: TokenQueryBackend,
): Promise<NonNullable<PoolImpact["v2PostState"]> | null> {
  const [reservesRaw, token0Raw, token1Raw] = await Promise.all([
    tokenQuery.call({ to: pool, data: univ2PairIface.encodeFunctionData("getReserves") }),
    tokenQuery.call({ to: pool, data: univ2PairIface.encodeFunctionData("token0") }),
    tokenQuery.call({ to: pool, data: univ2PairIface.encodeFunctionData("token1") }),
  ]);
  if (!reservesRaw || reservesRaw === "0x" || !token0Raw || token0Raw === "0x" || !token1Raw || token1Raw === "0x") {
    return null;
  }
  const decoded = univ2PairIface.decodeFunctionResult("getReserves", reservesRaw);
  const reserve0 = BigInt(decoded[0]) + swap.amount0In - swap.amount0Out;
  const reserve1 = BigInt(decoded[1]) + swap.amount1In - swap.amount1Out;
  if (reserve0 < 0n || reserve1 < 0n) return null;
  return {
    reserve0,
    reserve1,
    blockTimestampLast: Number(decoded[2]),
    token0: ethers.getAddress("0x" + token0Raw.slice(-40)),
    token1: ethers.getAddress("0x" + token1Raw.slice(-40)),
  };
}

function withExactPostStates(
  impacts: PoolImpact[],
  v2PostStates: Map<string, NonNullable<PoolImpact["v2PostState"]>>,
): PoolImpact[] {
  for (const impact of impacts) {
    if (impact.matchedAdapterId !== "univ2-swap" || impact.v2PostState) continue;
    const postState = v2PostStates.get(impact.pool.toLowerCase());
    if (!postState) continue;
    impact.v2PostState = postState;
    impact.poolToken0 ??= postState.token0;
    impact.poolToken1 ??= postState.token1;
  }
  return impacts;
}

export async function detectPoolImpact(
  event: OrderflowEvent,
  graph: TokenEdge[],
  broadPoolAddrs?: Map<string, string> | null,
  tokenQuery?: TokenQueryBackend | null,
): Promise<PoolImpact[]> {
  const directImpacts = detectDirectCalls(event, graph);
  const logImpacts = await detectImpactFromLogs(event.logs, graph, broadPoolAddrs, tokenQuery);
  return dedupeImpacts([...directImpacts, ...logImpacts]);
}

// ─── Direct calldata detection ────────────────────────────────

function detectDirectCalls(event: OrderflowEvent, graph: TokenEdge[]): PoolImpact[] {
  const target = event.to?.toLowerCase();
  if (!target) return [];

  const edges = graph.filter((edge) => edge.target.toLowerCase() === target);
  if (edges.length === 0) return [];

  const selector = event.input.slice(0, 10).toLowerCase();
  if (CURVE_SELECTORS.has(selector)) {
    const parsed = curveIface.parseTransaction({ data: event.input });
    if (!parsed) return [];
    return impactsFromCurveIds(
      event.to!,
      BigInt(parsed.args[0]),
      BigInt(parsed.args[1]),
      BigInt(parsed.args[2]),
      edges,
    );
  }

  return [];
}

// ─── Helpers ──────────────────────────────────────────────────

function groupEdgesByTarget(graph: TokenEdge[]): Map<string, TokenEdge[]> {
  const map = new Map<string, TokenEdge[]>();
  for (const edge of graph) {
    const key = edge.target.toLowerCase();
    const arr = map.get(key) ?? [];
    arr.push(edge);
    map.set(key, arr);
  }
  return map;
}

function dedupeImpacts(impacts: PoolImpact[]): PoolImpact[] {
  const order: string[] = [];
  const seen = new Map<string, PoolImpact>();
  for (const impact of impacts) {
    const key = [
      impact.pool.toLowerCase(),
      impact.poolId ?? "",
      impact.tokenIn.toLowerCase(),
      impact.tokenOut.toLowerCase(),
      impact.amountIn.toString(),
      impact.matchedAdapterId,
    ].join(":");
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, impact);
      order.push(key);
    } else if (!hasExactPostState(existing) && hasExactPostState(impact)) {
      seen.set(key, impact);
    }
  }
  return order.map((key) => seen.get(key)!);
}

function hasExactPostState(impact: PoolImpact): boolean {
  return Boolean(impact.v2PostState || impact.v3PostState || impact.v4PostState);
}
