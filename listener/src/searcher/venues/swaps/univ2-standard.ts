import { ethers } from "ethers";
import type { ResolvedPlanNode } from "../../../shared/types/plan.js";
import type { StateBackend } from "../../../shared/state/state-backend.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import { DEFAULT_V2_FEE_BPS, quoteV2ExactInput, v2FeeBpsForFactory } from "../../solver/v2-fee.js";
import type { ExactQuoteContext, PlanBuildContext, PlanFragment, SwapAdapter } from "../route-leg-adapter.js";

const pairIface = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const feeBpsCache = new Map<string, bigint>();

export const univ2StandardAdapter = Object.freeze({
  id: "univ2-standard",
  kind: "swap",
  poolAdapters: ["univ2"],
  edgeAdapterIds: ["univ2-swap"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  actionAdapterIds: ["univ2-swap", "erc20-transfer"],

  buildEdges: buildUniV2Edges,
  quoteExact: quoteUniV2Exact,
  buildPlanFragment: buildUniV2PlanFragment,
} satisfies SwapAdapter);

async function buildUniV2Edges(
  pool: PoolEntry,
  backend: TokenQueryBackend,
): Promise<TokenEdge[]> {
  const [token0, token1] = pool.token0 && pool.token1
    ? [ethers.getAddress(pool.token0), ethers.getAddress(pool.token1)]
    : await queryPairTokens(backend, pool.address);
  const reserves = await backend.call({
    to: pool.address,
    data: pairIface.encodeFunctionData("getReserves"),
  });
  if (!reserves || reserves === "0x" || reserves.length < 194) {
    throw new Error(`${pool.address} failed getReserves — not a valid UniV2 pair`);
  }
  const taxonomy = deriveEdgeTaxonomy("swap");
  return [
    {
      adapterId: "univ2-swap",
      target: pool.address,
      tokenIn: token0,
      tokenOut: token1,
      slotKind: "swap",
      poolToken0: token0,
      poolToken1: token1,
      score: pool.score,
      ...taxonomy,
    },
    {
      adapterId: "univ2-swap",
      target: pool.address,
      tokenIn: token1,
      tokenOut: token0,
      slotKind: "swap",
      poolToken0: token0,
      poolToken1: token1,
      score: pool.score,
      ...taxonomy,
    },
  ];
}

async function quoteUniV2Exact(ctx: ExactQuoteContext): Promise<bigint> {
  const { state, target, tokenIn, tokenOut, amountIn, cache } = ctx;
  if (!tokenIn || !tokenOut) throw new Error("univ2 quote requires tokenIn/tokenOut");
  if (amountIn <= 0n) return 0n;
  if (cache) {
    try {
      return await cache.quoteV2(state, target, tokenIn, tokenOut, amountIn);
    } catch {
      // Preserve the existing exact-quote fallback to on-chain pair reads.
    }
  }
  return quoteUniV2Onchain(state, target, tokenIn, amountIn);
}

async function quoteUniV2Onchain(
  state: StateBackend,
  pool: string,
  tokenIn: string,
  amountIn: bigint,
): Promise<bigint> {
  const token0Raw = await state.call({
    to: pool,
    data: pairIface.encodeFunctionData("token0"),
  });
  const token0 = ethers.getAddress(`0x${token0Raw.slice(-40)}`);
  const zeroForOne = tokenIn.toLowerCase() === token0.toLowerCase();
  const reservesRaw = await state.call({
    to: pool,
    data: pairIface.encodeFunctionData("getReserves"),
  });
  const decoded = pairIface.decodeFunctionResult("getReserves", reservesRaw);
  const [reserve0, reserve1] = [BigInt(decoded[0]), BigInt(decoded[1])];
  const [reserveIn, reserveOut] = zeroForOne
    ? [reserve0, reserve1]
    : [reserve1, reserve0];
  const feeBps = await resolveFeeBps(state, pool);
  return quoteV2ExactInput(reserveIn, reserveOut, amountIn, feeBps);
}

async function resolveFeeBps(state: StateBackend, pool: string): Promise<bigint> {
  const key = pool.toLowerCase();
  const cached = feeBpsCache.get(key);
  if (cached !== undefined) return cached;
  let feeBps = DEFAULT_V2_FEE_BPS;
  try {
    const raw = await state.call({
      to: pool,
      data: pairIface.encodeFunctionData("factory"),
    });
    const factory = pairIface.decodeFunctionResult("factory", raw)[0] as string;
    feeBps = v2FeeBpsForFactory(factory);
  } catch {
    // Behavior-equivalence phase: retain the baseline fallback. Tightening
    // provisional-factory fee admission is a separate replay-gated change.
  }
  feeBpsCache.set(key, feeBps);
  return feeBps;
}

async function buildUniV2PlanFragment(ctx: PlanBuildContext): Promise<PlanFragment> {
  const { edge, amountIn, amountOut, executor } = ctx;
  const [token0] = sortedPair(edge.tokenIn, edge.tokenOut);
  const zeroForOne = edge.tokenIn.toLowerCase() === token0.toLowerCase();
  const transfer: ResolvedPlanNode = {
    adapterId: "erc20-transfer",
    target: edge.tokenIn,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenIn,
    amount: amountIn,
    params: { to: edge.target, amount: amountIn },
    children: [],
  };
  return {
    requirements: [],
    nodes: [{
      adapterId: "univ2-swap",
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amount: amountIn,
      params: {
        amount0Out: zeroForOne ? 0n : amountOut,
        amount1Out: zeroForOne ? amountOut : 0n,
        to: executor,
      },
      children: [transfer],
    }],
  };
}

async function queryPairTokens(
  backend: TokenQueryBackend,
  pool: string,
): Promise<[string, string]> {
  const [token0Raw, token1Raw] = await Promise.all([
    backend.call({ to: pool, data: pairIface.encodeFunctionData("token0") }),
    backend.call({ to: pool, data: pairIface.encodeFunctionData("token1") }),
  ]);
  return [
    ethers.getAddress(`0x${token0Raw.slice(-40)}`),
    ethers.getAddress(`0x${token1Raw.slice(-40)}`),
  ];
}

function sortedPair(a: string, b: string): [string, string] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}
