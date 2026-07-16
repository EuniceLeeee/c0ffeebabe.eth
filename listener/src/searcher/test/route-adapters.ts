import "../../shared/adapters/index.js";

import { ethers } from "ethers";
import { listAll } from "../../adapters/registry.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import type { PoolEntry, TokenQueryBackend } from "../planner/token-graph.js";
import { quoteV2ExactInput } from "../solver/v2-fee.js";
import { PRODUCTION_ROUTE_ADAPTERS } from "../venues/production-registry.js";
import { RouteLegRegistry } from "../venues/route-leg-registry.js";
import type { SwapAdapter } from "../venues/route-leg-adapter.js";

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

const pair = "0x00000000000000000000000000000000000000A1";
const curvePool = "0x00000000000000000000000000000000000000C1";
const curveUnderlyingPool = "0x00000000000000000000000000000000000000C2";
const token0 = "0x0000000000000000000000000000000000000001";
const token1 = "0x0000000000000000000000000000000000000002";
const uniswapV2Factory = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const pairIface = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const curveIface = new ethers.Interface([
  "function coins(uint256 i) view returns (address)",
  "function coins(int128 i) view returns (address)",
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
]);
const curveUnderlyingIface = new ethers.Interface([
  "function underlying_coins(int128 i) view returns (address)",
  "function get_dy_underlying(int128 i, int128 j, uint256 dx) view returns (uint256)",
]);

const backend: TokenQueryBackend = {
  async call(req) {
    const selector = req.data.slice(0, 10);
    if (selector === pairIface.getFunction("getReserves")!.selector) {
      return pairIface.encodeFunctionResult("getReserves", [1_000_000n, 2_000_000n, 1n]);
    }
    if (selector === pairIface.getFunction("token0")!.selector) {
      return pairIface.encodeFunctionResult("token0", [token0]);
    }
    if (selector === pairIface.getFunction("token1")!.selector) {
      return pairIface.encodeFunctionResult("token1", [token1]);
    }
    if (selector === pairIface.getFunction("factory")!.selector) {
      return pairIface.encodeFunctionResult("factory", [uniswapV2Factory]);
    }
    throw new Error(`unexpected selector ${selector}`);
  },
};

const curveBackend: TokenQueryBackend = {
  async call(req) {
    const selector = req.data.slice(0, 10);
    const uintCoins = curveIface.getFunction("coins(uint256)")!;
    const intCoins = curveIface.getFunction("coins(int128)")!;
    if (selector === uintCoins.selector || selector === intCoins.selector) {
      const fn = selector === uintCoins.selector ? uintCoins : intCoins;
      const index = Number(curveIface.decodeFunctionData(fn, req.data)[0]);
      const token = index === 0 ? token0 : index === 1 ? token1 : ethers.ZeroAddress;
      return curveIface.encodeFunctionResult(fn, [token]);
    }
    if (selector === curveIface.getFunction("get_dy")!.selector) {
      const amountIn = BigInt(curveIface.decodeFunctionData("get_dy", req.data)[2]);
      return curveIface.encodeFunctionResult("get_dy", [amountIn * 2n]);
    }
    throw new Error(`unexpected Curve selector ${selector}`);
  },
};

const curveUnderlyingBackend: TokenQueryBackend = {
  async call(req) {
    const selector = req.data.slice(0, 10);
    if (selector === curveUnderlyingIface.getFunction("underlying_coins")!.selector) {
      const index = Number(curveUnderlyingIface.decodeFunctionData("underlying_coins", req.data)[0]);
      if (index > 1) throw new Error("underlying coin index out of range");
      return curveUnderlyingIface.encodeFunctionResult("underlying_coins", [index === 0 ? token0 : token1]);
    }
    if (selector === curveUnderlyingIface.getFunction("get_dy_underlying")!.selector) {
      const amountIn = BigInt(curveUnderlyingIface.decodeFunctionData("get_dy_underlying", req.data)[2]);
      return curveUnderlyingIface.encodeFunctionResult("get_dy_underlying", [amountIn * 3n]);
    }
    // Force the explicitly allowed direct-pool fallback instead of fabricating MetaRegistry state.
    throw new Error(`unexpected Curve underlying selector ${selector}`);
  },
};

async function main(): Promise<void> {
  const adapters = PRODUCTION_ROUTE_ADAPTERS.routeLegs.list();
  assert(adapters.length === 12, `production route adapter count ${adapters.length}`);
  for (const routeAdapter of adapters) {
    for (const poolAdapter of routeAdapter.poolAdapters) {
      assert(PRODUCTION_ROUTE_ADAPTERS.routeLegs.forPool(poolAdapter) === routeAdapter, `${routeAdapter.id} pool alias`);
    }
    for (const edgeAdapterId of routeAdapter.edgeAdapterIds) {
      assert(PRODUCTION_ROUTE_ADAPTERS.routeLegs.forEdge(edgeAdapterId) === routeAdapter, `${routeAdapter.id} edge alias`);
    }
  }
  const adapter = PRODUCTION_ROUTE_ADAPTERS.routeLegs.forEdge("univ2-swap");
  assert(adapter.id === "univ2-standard", `univ2 family ${adapter.id}`);
  assert(PRODUCTION_ROUTE_ADAPTERS.routeLegs.forPool("univ2") === adapter, "pool alias lookup");
  console.log("[route-adapters] registry aliases: PASS");

  const pool: PoolEntry = { address: pair, adapter: "univ2", token0, token1, score: 7 };
  const edges = await PRODUCTION_ROUTE_ADAPTERS.routeLegs.buildEdges(pool, backend);
  assert(edges.length === 2, `univ2 edge count ${edges.length}`);
  assert(edges[0].adapterId === "univ2-swap", `edge adapter ${edges[0].adapterId}`);
  assert(edges[0].tokenIn === ethers.getAddress(token0), `edge token0 ${edges[0].tokenIn}`);
  assert(edges[0].tokenOut === ethers.getAddress(token1), `edge token1 ${edges[0].tokenOut}`);
  assert(edges.every((edge) => edge.edgeKind === "swap" && !edge.leavesStandingPosition), "edge taxonomy");
  assert(edges.every((edge) => edge.score === 7), "edge score propagation");
  console.log("[route-adapters] univ2 graph equivalence: PASS");

  const amountIn = 10_000n;
  const quoted = await adapter.quoteExact({
    state: backend as never,
    target: pair,
    edgeAdapterId: "univ2-swap",
    tokenIn: token0,
    tokenOut: token1,
    amountIn,
  });
  assert(
    quoted === quoteV2ExactInput(1_000_000n, 2_000_000n, amountIn, 30n),
    `univ2 quote ${quoted}`,
  );
  console.log("[route-adapters] univ2 quote equivalence: PASS");

  const fragment = await adapter.buildPlanFragment({
    edge: edges[0],
    amountIn,
    amountOut: quoted,
    executor: "0x00000000000000000000000000000000000000E1",
    state: backend as never,
  });
  assert(fragment.requirements.length === 0, "univ2 has no sibling requirement");
  assert(fragment.nodes.length === 1, "univ2 one wrapper node");
  assert(fragment.nodes[0].adapterId === "univ2-swap", "univ2 wrapper action");
  assert(fragment.nodes[0].children[0]?.adapterId === "erc20-transfer", "univ2 callback transfer");
  console.log("[route-adapters] univ2 plan fragment equivalence: PASS");

  const curveAdapter = PRODUCTION_ROUTE_ADAPTERS.routeLegs.forFamily("curve-plain");
  const curveEdges = await PRODUCTION_ROUTE_ADAPTERS.routeLegs.buildEdges(
    { address: curvePool, adapter: "curve", score: 5 },
    curveBackend,
  );
  assert(curveEdges.length === 2, `curve edge count ${curveEdges.length}`);
  assert(curveEdges.every((edge) => edge.curveI !== edge.curveJ && edge.score === 5), "curve indices/score");
  const curveQuote = await curveAdapter.quoteExact({
    state: curveBackend as never,
    target: curvePool,
    edgeAdapterId: "curve-exchange-plain",
    tokenIn: token0,
    tokenOut: token1,
    amountIn,
  });
  assert(curveQuote === amountIn * 2n, `curve quote ${curveQuote}`);
  const curveFragment = await curveAdapter.buildPlanFragment({
    edge: curveEdges[0], amountIn, amountOut: curveQuote,
    executor: ethers.ZeroAddress, state: curveBackend as never,
  });
  assert(curveFragment.requirements[0]?.kind === "approve", "curve approval requirement");
  assert(curveFragment.nodes[0]?.adapterId === "curve-exchange-plain", "curve plain action");
  console.log("[route-adapters] curve plain graph/quote/plan equivalence: PASS");

  const underlyingAdapter = PRODUCTION_ROUTE_ADAPTERS.routeLegs.forFamily("curve-underlying");
  const underlyingEdges = await PRODUCTION_ROUTE_ADAPTERS.routeLegs.buildEdges(
    { address: curveUnderlyingPool, adapter: "curve-underlying", score: 3 },
    curveUnderlyingBackend,
  );
  assert(underlyingEdges.length === 2, `curve underlying edge count ${underlyingEdges.length}`);
  const underlyingQuote = await underlyingAdapter.quoteExact({
    state: curveUnderlyingBackend as never,
    target: curveUnderlyingPool,
    edgeAdapterId: "curve-exchange-underlying",
    tokenIn: token0,
    tokenOut: token1,
    amountIn,
  });
  assert(underlyingQuote === amountIn * 3n, `curve underlying quote ${underlyingQuote}`);
  const underlyingFragment = await underlyingAdapter.buildPlanFragment({
    edge: underlyingEdges[0], amountIn, amountOut: underlyingQuote,
    executor: ethers.ZeroAddress, state: curveUnderlyingBackend as never,
  });
  assert(underlyingFragment.requirements[0]?.kind === "approve", "underlying approval requirement");
  assert(underlyingFragment.nodes[0]?.adapterId === "curve-exchange-underlying", "underlying action");
  console.log("[route-adapters] curve underlying graph/quote/plan equivalence: PASS");

  const actionIds = new Set(listAll().map((action) => action.id));
  for (const routeAdapter of adapters) {
    for (const actionId of routeAdapter.actionAdapterIds) {
      assert(actionIds.has(actionId), `missing action adapter ${actionId}`);
    }
  }
  console.log("[route-adapters] action registry coverage: PASS");

  const badAdapter: SwapAdapter = {
    ...adapter,
    id: "custom-swap:bad",
    kind: "swap",
    poolAdapters: ["univ2"],
    edgeAdapterIds: ["bad-edge"],
    async buildEdges() {
      return [{
        ...edges[0],
        adapterId: "bad-edge",
        ...deriveEdgeTaxonomy("protocol", "wrap"),
      }];
    },
  };
  const badRegistry = new RouteLegRegistry([badAdapter]);
  let rejected = false;
  try {
    await badRegistry.buildEdges(pool, backend);
  } catch {
    rejected = true;
  }
  assert(rejected, "runtime taxonomy mismatch must reject");
  console.log("[route-adapters] dynamic taxonomy guard: PASS");

  console.log("route-adapters PASS (8/8)");
}

await main();
