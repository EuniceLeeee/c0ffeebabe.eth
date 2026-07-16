import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type { ExactQuoteContext, PlanBuildContext, PlanFragment, SwapAdapter } from "../route-leg-adapter.js";

const vaultIface = new ethers.Interface([
  "function getPoolTokens(address pool) view returns (address[] tokens)",
]);
const routerIface = new ethers.Interface([
  "function querySwapSingleTokenExactIn(address pool,address tokenIn,address tokenOut,uint256 exactAmountIn,address sender,bytes userData) returns (uint256 amountOut)",
]);

export const balancerV3Adapter = Object.freeze({
  id: "balancer-v3",
  kind: "swap",
  poolAdapters: ["balancer-v3"],
  edgeAdapterIds: ["balancer-v3-unlock"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  actionAdapterIds: [
    "balancer-v3-unlock",
    "balancer-v3-settle",
    "balancer-v3-swap",
    "balancer-v3-send-to",
    "erc20-transfer",
  ],

  buildEdges: buildBalancerV3Edges,
  quoteExact: quoteBalancerV3Exact,
  buildPlanFragment: buildBalancerV3PlanFragment,
} satisfies SwapAdapter);

export async function quoteBalancerV3(
  state: { call(req: { to: string; data: string }): Promise<string> },
  pool: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const data = routerIface.encodeFunctionData("querySwapSingleTokenExactIn", [
    pool,
    tokenIn,
    tokenOut,
    amountIn,
    ethers.ZeroAddress,
    "0x",
  ]);
  const result = await state.call({ to: ADDR.BALANCER_V3_ROUTER, data });
  return BigInt(routerIface.decodeFunctionResult("querySwapSingleTokenExactIn", result)[0]);
}

async function buildBalancerV3Edges(
  pool: PoolEntry,
  backend: TokenQueryBackend,
): Promise<TokenEdge[]> {
  const data = vaultIface.encodeFunctionData("getPoolTokens", [pool.address]);
  const result = await backend.call({ to: ADDR.BALANCER_V3_VAULT, data });
  const tokens = (vaultIface.decodeFunctionResult("getPoolTokens", result)[0] as string[])
    .map((token) => ethers.getAddress(token));
  if (tokens.length < 2) {
    throw new Error(`balancer-v3 pool ${pool.address} returned fewer than two tokens`);
  }
  const taxonomy = deriveEdgeTaxonomy("swap");
  const edges: TokenEdge[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = 0; j < tokens.length; j++) {
      if (i === j) continue;
      edges.push({
        adapterId: "balancer-v3-unlock",
        target: ethers.getAddress(pool.address),
        tokenIn: tokens[i],
        tokenOut: tokens[j],
        slotKind: "swap",
        score: pool.score,
        ...taxonomy,
      });
    }
  }
  return edges;
}

async function quoteBalancerV3Exact(ctx: ExactQuoteContext): Promise<bigint> {
  const { state, target, tokenIn, tokenOut, amountIn } = ctx;
  if (!tokenIn || !tokenOut) throw new Error("balancer-v3 quote requires tokenIn/tokenOut");
  if (amountIn <= 0n) return 0n;
  return quoteBalancerV3(state, target, tokenIn, tokenOut, amountIn);
}

async function buildBalancerV3PlanFragment(ctx: PlanBuildContext): Promise<PlanFragment> {
  const { edge, amountIn, amountOut, rawOut } = ctx;
  const outputAmount = rawOut ?? amountOut;
  const vault = ADDR.BALANCER_V3_VAULT;
  return {
    requirements: [],
    nodes: [{
      adapterId: "balancer-v3-unlock",
      target: vault,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amount: 0n,
      params: {},
      children: [
        {
          adapterId: "erc20-transfer",
          target: edge.tokenIn,
          tokenIn: edge.tokenIn,
          tokenOut: edge.tokenIn,
          amount: amountIn,
          params: { to: vault, amount: amountIn },
          children: [],
        },
        {
          adapterId: "balancer-v3-settle",
          target: vault,
          tokenIn: edge.tokenIn,
          tokenOut: edge.tokenIn,
          amount: amountIn,
          params: { token: edge.tokenIn },
          children: [],
        },
        {
          adapterId: "balancer-v3-swap",
          target: vault,
          tokenIn: edge.tokenIn,
          tokenOut: edge.tokenOut,
          amount: amountIn,
          params: { kind: 0n, pool: edge.target, limitRaw: 0n, userData: "0x" },
          children: [],
        },
        {
          adapterId: "balancer-v3-send-to",
          target: vault,
          tokenIn: edge.tokenOut,
          tokenOut: edge.tokenOut,
          amount: outputAmount,
          params: { token: edge.tokenOut },
          children: [],
        },
      ],
    }],
  };
}
