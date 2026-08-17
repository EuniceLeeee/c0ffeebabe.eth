import { ADDR } from "../../shared/constants/addresses.js";
import {
  detectBlockScanOpportunities,
  type ProtocolMid,
} from "../detector/blockscan-scanner.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { PoolStateCache } from "../solver/pool-state-cache.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import { STRICT_PROJECTED_FAMILY_TEST_REGISTRY } from "./strict-family-test-compat.js";

const BLOCK = 25_535_037;
const UNIT = 10n ** 18n;
const V2_POOL = "0x0000000000000000000000000000000000003131";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function swap(tokenIn: string, tokenOut: string): TokenEdge {
  return {
    adapterId: "univ2-swap",
    target: V2_POOL,
    tokenIn,
    tokenOut,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
  };
}

function protocolKey(pool: string, tokenIn: string, tokenOut: string): string {
  return `${pool.toLowerCase()}|${tokenIn.toLowerCase()}|${tokenOut.toLowerCase()}`;
}

const protocolEdge: TokenEdge = {
  adapterId: "metronome-hgusdc-exit",
  target: ADDR.METRONOME_HGUSDC_ROUTER,
  tokenIn: ADDR.MSUSD,
  tokenOut: ADDR.USDC,
  slotKind: "protocol",
  protocolAction: "redeem",
  ...deriveEdgeTaxonomy("protocol", "redeem"),
};
const edges = [
  protocolEdge,
  swap(ADDR.USDC, ADDR.MSUSD),
  swap(ADDR.MSUSD, ADDR.USDC),
];
const cache = new PoolStateCache();
cache.seedV2({
  pool: V2_POOL,
  token0: ADDR.USDC,
  token1: ADDR.MSUSD,
  reserve0: 1_000_000n * 10n ** 6n,
  reserve1: 980_000n * UNIT,
  feeBps: 30n,
  blockNumber: BLOCK,
});
const pricedTokens = new Map([
  [ADDR.USDC.toLowerCase(), { maxBorrow: 100_000n * 10n ** 6n }],
]);

function scan(protocolMids?: ReadonlyMap<string, ProtocolMid>) {
  return detectBlockScanOpportunities({
    edges,
    cache,
    sourceBlock: BLOCK,
    swapTouched: null,
    cfg: {
      maxHops: 3,
      minSpreadBps: 0,
      maxCandidates: 8,
      budgetMs: 2_000,
      pricedTokens,
      protocolMids,
    },
  });
}

const adapter = STRICT_PROJECTED_FAMILY_TEST_REGISTRY.routes().forEdge("metronome-hgusdc-exit");
const pricingAdapter = STRICT_PROJECTED_FAMILY_TEST_REGISTRY.protocols().find(
  (candidate) => candidate.id === adapter.id,
);
assert(
  pricingAdapter?.pricingState !== null && pricingAdapter?.pricingState !== undefined,
  "hGUSDC adapter must expose family-owned current-N pricing state",
);

const beforeWarm = scan();
assert(
  !beforeWarm.opportunities.some((opportunity) =>
    opportunity.seedEdges.some((edge) => edge.adapterId === "metronome-hgusdc-exit")
  ),
  "hGUSDC route must not emit before its prewarmed mid exists",
);

const afterWarm = scan(new Map([[
  protocolKey(ADDR.METRONOME_HGUSDC_ROUTER, ADDR.MSUSD, ADDR.USDC),
  {
    mid: 1.05e-12,
    feeBps: 0,
    depthIn: 1_000_000n * UNIT,
  },
]]));
const opportunity = afterWarm.opportunities.find((item) =>
  item.seedEdges.some((edge) => edge.adapterId === "metronome-hgusdc-exit")
);
assert(opportunity !== undefined, "prewarmed hGUSDC mid should make scanner enumerate the ring");
assert(opportunity.flashToken === ADDR.USDC.toLowerCase(), "hGUSDC ring should rotate to USDC");
assert(opportunity.seedEdges[0].tokenIn.toLowerCase() === ADDR.USDC.toLowerCase(), "ring starts in USDC");
assert(
  opportunity.seedEdges[opportunity.seedEdges.length - 1].tokenOut.toLowerCase() ===
    ADDR.USDC.toLowerCase(),
  "ring closes in USDC",
);

console.log("blockscan-metronome-mid PASS (adapter warm -> scanner ring)");
