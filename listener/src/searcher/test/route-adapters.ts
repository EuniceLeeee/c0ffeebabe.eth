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
const token0 = "0x0000000000000000000000000000000000000001";
const token1 = "0x0000000000000000000000000000000000000002";
const uniswapV2Factory = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const pairIface = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
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

async function main(): Promise<void> {
  const adapters = PRODUCTION_ROUTE_ADAPTERS.routeLegs.list();
  assert(adapters.length === 2, `production route adapter count ${adapters.length}`);
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

  console.log("route-adapters PASS (6/6)");
}

await main();
