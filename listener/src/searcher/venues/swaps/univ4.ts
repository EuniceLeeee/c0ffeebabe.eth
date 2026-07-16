import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import type { ResolvedPlanNode } from "../../../shared/types/plan.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend, V4PoolKey } from "../../planner/token-graph.js";
import { quoteV4ExactInLocal } from "../../solver/v4-math.js";
import type {
  ExactQuoteContext,
  PlanBuildContext,
  PlanFragment,
  SwapAdapter,
  V4QuotePathStats,
} from "../route-leg-adapter.js";
import {
  int24,
  normalizeV4Currency,
  normalizeV4PoolKey,
  realV4Currency,
  rejectNativeWethV4Pool,
  uint24,
  v4HooksAffectSwap,
  v4PoolId,
  validateV4CurrencyPair,
} from "./univ4-common.js";

const MIN_SQRT_PRICE = 4295128740n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970341n;
const MAX_UINT128 = (1n << 128n) - 1n;
const V4_POOL_MANAGER_DEPLOY_BLOCK = "0x0";
const initializeIface = new ethers.Interface([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);
const INITIALIZE_TOPIC = ethers.id(
  "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)",
);
const poolKeyCache = new Map<string, V4PoolKey>();

export const uniV4QuoterIface = new ethers.Interface([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);

export const univ4Adapter = Object.freeze({
  id: "univ4",
  kind: "swap",
  poolAdapters: ["univ4"],
  edgeAdapterIds: ["univ4-unlock"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  actionAdapterIds: [
    "univ4-unlock",
    "univ4-swap",
    "univ4-take",
    "univ4-sync",
    "univ4-settle",
    "univ4-settle-value",
    "erc20-transfer",
    "weth-deposit-value",
    "weth-withdraw-amount",
  ],

  buildEdges: buildUniV4Edges,
  quoteExact: quoteUniV4Exact,
  buildPlanFragment: buildUniV4PlanFragment,
} satisfies SwapAdapter);

export function encodeUniV4QuoteExactInputSingle(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  poolKey: V4PoolKey | undefined,
): string {
  const key = validateQuoteInput(tokenIn, tokenOut, amountIn, poolKey);
  const zeroForOne = v4ZeroForOne(key, tokenIn, tokenOut, "V4 quoter");
  return uniV4QuoterIface.encodeFunctionData("quoteExactInputSingle", [{
    poolKey: key,
    zeroForOne,
    exactAmount: amountIn,
    hookData: "0x",
  }]);
}

async function buildUniV4Edges(
  pool: PoolEntry,
  backend: TokenQueryBackend,
): Promise<TokenEdge[]> {
  if (!pool.fixedTokenIn || !pool.fixedTokenOut) {
    throw new Error(`univ4 pool ${pool.address} requires fixedTokenIn/fixedTokenOut`);
  }
  const poolKey = await resolveV4PoolKey(pool, backend);
  if (v4HooksAffectSwap(poolKey.hooks)) return [];
  const tIn = normalizeV4Currency(pool.fixedTokenIn, "fixedTokenIn", "univ4 PoolKey");
  const tOut = normalizeV4Currency(pool.fixedTokenOut, "fixedTokenOut", "univ4 PoolKey");
  validateGraphPair(pool.address, poolKey, tIn, tOut);
  const poolId = v4PoolId(poolKey);
  const graphIn = tIn === ethers.ZeroAddress ? ADDR.WETH : tIn;
  const graphOut = tOut === ethers.ZeroAddress ? ADDR.WETH : tOut;
  const nativeCurrency0 = poolKey.currency0 === ethers.ZeroAddress;
  const nativeCurrency1 = poolKey.currency1 === ethers.ZeroAddress;
  const taxonomy = deriveEdgeTaxonomy("swap");
  const common = {
    adapterId: "univ4-unlock",
    target: pool.address,
    slotKind: "swap" as const,
    v4PoolKey: poolKey,
    poolId,
    nativeCurrency0,
    nativeCurrency1,
    score: pool.score,
    ...taxonomy,
  };
  return [
    { ...common, tokenIn: graphIn, tokenOut: graphOut },
    { ...common, tokenIn: graphOut, tokenOut: graphIn },
  ];
}

async function quoteUniV4Exact(ctx: ExactQuoteContext): Promise<bigint> {
  const { state, tokenIn, tokenOut, amountIn, v4PoolKey, v4QuoteStats: stats } = ctx;
  if (!tokenIn || !tokenOut) throw new Error("univ4 quote requires tokenIn/tokenOut");
  if (amountIn <= 0n) return 0n;
  const key = validateQuoteInput(tokenIn, tokenOut, amountIn, v4PoolKey);
  if (isLocalQuoteEligible(key)) {
    try {
      const amountOut = await quoteV4ExactInLocal(state, key, tokenIn, tokenOut, amountIn);
      if (stats) stats.local++;
      return amountOut;
    } catch {
      if (stats) stats.localFailures++;
    }
  } else if (stats) {
    stats.hookSkipped++;
  }

  if (stats) stats.fallback++;
  const data = encodeUniV4QuoteExactInputSingle(tokenIn, tokenOut, amountIn, key);
  const result = await state.call({ to: ADDR.UNISWAP_V4_QUOTER, data });
  return BigInt(uniV4QuoterIface.decodeFunctionResult("quoteExactInputSingle", result)[0]);
}

async function buildUniV4PlanFragment(ctx: PlanBuildContext): Promise<PlanFragment> {
  const { edge, amountIn, amountOut, rawOut } = ctx;
  if (!edge.v4PoolKey) {
    throw new Error(`univ4-unlock edge missing v4PoolKey: ${edge.tokenIn} -> ${edge.tokenOut}`);
  }
  const key = normalizeV4PoolKey(edge.v4PoolKey, "plan-builder: v4 PoolKey");
  rejectNativeWethV4Pool(key, "plan-builder");
  const realIn = realV4Currency(edge.tokenIn, key, "tokenIn", "plan-builder: v4");
  const realOut = realV4Currency(edge.tokenOut, key, "tokenOut", "plan-builder: v4");
  validateV4CurrencyPair(realIn, realOut, key, "plan-builder");
  const zeroForOne = realIn.toLowerCase() === key.currency0.toLowerCase();
  const inputIsNative = realIn.toLowerCase() === ethers.ZeroAddress.toLowerCase();
  const outputIsNative = realOut.toLowerCase() === ethers.ZeroAddress.toLowerCase();
  const takeAmount = rawOut ?? amountOut;

  const children: ResolvedPlanNode[] = [
    {
      adapterId: "univ4-swap",
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amount: amountIn,
      params: {
        currency0: key.currency0,
        currency1: key.currency1,
        fee: BigInt(key.fee),
        tickSpacing: BigInt(key.tickSpacing),
        hooks: key.hooks,
        zeroForOne,
        amountSpecified: -amountIn,
        sqrtPriceLimit: zeroForOne ? MIN_SQRT_PRICE : MAX_SQRT_PRICE,
      },
      children: [],
    },
    {
      adapterId: "univ4-take",
      target: edge.target,
      tokenIn: "",
      tokenOut: edge.tokenOut,
      amount: takeAmount,
      params: { currency: realOut },
      children: [],
    },
  ];

  if (outputIsNative) {
    children.push({
      adapterId: "weth-deposit-value",
      target: ADDR.WETH,
      tokenIn: realOut,
      tokenOut: ADDR.WETH,
      amount: takeAmount,
      params: {},
      children: [],
    });
  }

  if (inputIsNative) {
    children.push(
      {
        adapterId: "weth-withdraw-amount",
        target: ADDR.WETH,
        tokenIn: ADDR.WETH,
        tokenOut: realIn,
        amount: amountIn,
        params: {},
        children: [],
      },
      {
        adapterId: "univ4-sync",
        target: edge.target,
        tokenIn: realIn,
        tokenOut: "",
        amount: 0n,
        params: { currency: ethers.ZeroAddress },
        children: [],
      },
      {
        adapterId: "univ4-settle-value",
        target: edge.target,
        tokenIn: "",
        tokenOut: "",
        amount: amountIn,
        params: {},
        children: [],
      },
    );
  } else {
    children.push(
      {
        adapterId: "univ4-sync",
        target: edge.target,
        tokenIn: realIn,
        tokenOut: "",
        amount: 0n,
        params: { currency: realIn },
        children: [],
      },
      {
        adapterId: "erc20-transfer",
        target: realIn,
        tokenIn: realIn,
        tokenOut: realIn,
        amount: amountIn,
        params: { to: edge.target, amount: amountIn },
        children: [],
      },
      {
        adapterId: "univ4-settle",
        target: edge.target,
        tokenIn: "",
        tokenOut: "",
        amount: 0n,
        params: {},
        children: [],
      },
    );
  }

  return {
    requirements: [],
    nodes: [{
      adapterId: "univ4-unlock",
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amount: 0n,
      params: {},
      children,
    }],
  };
}

function validateQuoteInput(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  poolKey: V4PoolKey | undefined,
): V4PoolKey {
  if (!poolKey) throw new Error(`V4 quoter: missing PoolKey for ${tokenIn} -> ${tokenOut}`);
  if (amountIn < 0n || amountIn > MAX_UINT128) {
    throw new Error(`V4 quoter: exactAmount does not fit uint128: ${amountIn}`);
  }
  const key = normalizeV4PoolKey(poolKey, "V4 quoter: PoolKey");
  v4ZeroForOne(key, tokenIn, tokenOut, "V4 quoter");
  return key;
}

function v4ZeroForOne(
  key: V4PoolKey,
  tokenIn: string,
  tokenOut: string,
  context: string,
): boolean {
  rejectNativeWethV4Pool(key, context);
  const realIn = realV4Currency(tokenIn, key, "tokenIn", context);
  const realOut = realV4Currency(tokenOut, key, "tokenOut", context);
  validateV4CurrencyPair(realIn, realOut, key, context);
  if (realIn.toLowerCase() === key.currency0.toLowerCase()) return true;
  if (realIn.toLowerCase() === key.currency1.toLowerCase()) return false;
  throw new Error(`V4 quoter: tokens ${tokenIn} -> ${tokenOut} do not match PoolKey`);
}

function isLocalQuoteEligible(key: V4PoolKey): boolean {
  return key.hooks.toLowerCase() === ethers.ZeroAddress.toLowerCase() &&
    !v4HooksAffectSwap(key.hooks);
}

async function resolveV4PoolKey(pool: PoolEntry, backend: TokenQueryBackend): Promise<V4PoolKey> {
  if (hasInlineV4PoolKey(pool)) return v4PoolKeyFromEntry(pool);
  if (pool.poolId && backend.getLogs) {
    const cacheKey = pool.poolId.toLowerCase();
    const cached = poolKeyCache.get(cacheKey);
    if (cached) return cached;
    const logs = await backend.getLogs({
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      topics: [INITIALIZE_TOPIC, normalizeBytes32(pool.poolId, "poolId")],
      fromBlock: V4_POOL_MANAGER_DEPLOY_BLOCK,
      toBlock: "latest",
    });
    const first = logs[0];
    if (first) {
      const parsed = initializeIface.parseLog({ topics: first.topics, data: first.data });
      if (parsed) {
        const key = {
          currency0: normalizeV4Currency(String(parsed.args.currency0), "currency0", "univ4 PoolKey"),
          currency1: normalizeV4Currency(String(parsed.args.currency1), "currency1", "univ4 PoolKey"),
          fee: uint24(Number(parsed.args.fee), "fee", "univ4 PoolKey"),
          tickSpacing: int24(Number(parsed.args.tickSpacing), "tickSpacing", "univ4 PoolKey"),
          hooks: normalizeV4Currency(String(parsed.args.hooks), "hooks", "univ4 PoolKey"),
        };
        poolKeyCache.set(cacheKey, key);
        return key;
      }
    }
  }
  return v4PoolKeyFromEntry(pool);
}

function hasInlineV4PoolKey(pool: PoolEntry): boolean {
  return pool.currency0 !== undefined && pool.currency1 !== undefined && pool.fee !== undefined &&
    pool.tickSpacing !== undefined && pool.hooks !== undefined;
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
  return normalizeV4PoolKey({
    currency0: pool.currency0!,
    currency1: pool.currency1!,
    fee: pool.fee!,
    tickSpacing: pool.tickSpacing!,
    hooks: pool.hooks!,
  }, "univ4 PoolKey");
}

function normalizeBytes32(value: string, field: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`univ4 ${field} must be bytes32, got ${value}`);
  }
  return value.toLowerCase();
}

function validateGraphPair(pool: string, key: V4PoolKey, tokenIn: string, tokenOut: string): void {
  const currencies = new Set([key.currency0.toLowerCase(), key.currency1.toLowerCase()]);
  if (!currencies.has(tokenIn.toLowerCase()) || !currencies.has(tokenOut.toLowerCase())) {
    throw new Error(
      `univ4 pool ${pool} fixed tokens ${tokenIn}/${tokenOut} do not match PoolKey ` +
        `${key.currency0}/${key.currency1}`,
    );
  }
}

export type { V4QuotePathStats };
