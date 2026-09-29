/** Synthetic amount-quote contract, not a protocol price or historical replay.
 * Explicit effective amounts are required; raw mid metadata cannot fill gaps. */
import assert from "node:assert/strict";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  scanBlockStateFromResolvedMids,
  type ResolvedBlockScanMid,
  type ResolvedBlockScanQuote,
} from "../detector/blockscan-scanner-core.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import { STRICT_PROJECTED_FAMILY_TEST_REGISTRY } from "./strict-family-test-compat.js";

const BLOCK = 25_535_037;
const UNIT = 10n ** 18n;
const USDC_UNIT = 10n ** 6n;
const V2_POOL = "0x0000000000000000000000000000000000003131";

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
  { ...swap(ADDR.USDC, ADDR.WETH), target: "0x0000000000000000000000000000000000003132" },
];
function quote(edge: TokenEdge, amountIn: bigint, amountOut: bigint): ResolvedBlockScanQuote {
  return {
    kind: "synthetic-effective",
    pool: edge.target,
    edges: [edge],
    // Deliberately unusable legacy pricing metadata: only amounts may price.
    mid: 0,
    feeBps: 10_000,
    depthProxy: 0,
    quoteAmountIn: amountIn,
    quoteAmountOut: amountOut,
  };
}
const effectiveQuotes = new Map<string, ResolvedBlockScanQuote>([
  [blockScanEdgeKey(edges[0]!), quote(edges[0]!, 98n * UNIT, 103n * USDC_UNIT)],
  [blockScanEdgeKey(edges[1]!), quote(edges[1]!, 100n * USDC_UNIT, 98n * UNIT)],
  [blockScanEdgeKey(edges[2]!), quote(edges[2]!, 98n * UNIT, 99n * USDC_UNIT)],
  // One directed effective quote supplies the ETH reference; it cannot close a ring.
  [blockScanEdgeKey(edges[3]!), quote(edges[3]!, 2_000n * USDC_UNIT, UNIT)],
]);
const pricedTokens = new Map([
  [ADDR.USDC.toLowerCase(), { maxBorrow: 100_000n * USDC_UNIT }],
]);

function scan(mids: ReadonlyMap<string, ResolvedBlockScanQuote>) {
  return scanBlockStateFromResolvedMids({
    edges,
    mids,
    sourceBlock: BLOCK,
    swapTouched: null,
    cfg: {
      maxHops: 3,
      minSpreadBps: 0,
      maxCandidates: 8,
      budgetMs: 2_000,
      pricedTokens,
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

const withoutProtocolQuote = new Map(effectiveQuotes);
withoutProtocolQuote.delete(blockScanEdgeKey(protocolEdge));
const beforeQuote = scan(withoutProtocolQuote);
assert(
  !beforeQuote.opportunities.some((opportunity) =>
    opportunity.seedEdges.some((edge) => edge.adapterId === "metronome-hgusdc-exit")
  ),
  "hGUSDC route must not emit without its explicit effective amount quote",
);

// Runtime negative control for a malformed legacy caller that bypasses the type.
// A seemingly profitable raw mark still cannot replace missing amount fields.
const rawOnly = new Map<string, ResolvedBlockScanMid>(effectiveQuotes);
const { quoteAmountIn: _input, quoteAmountOut: _output, ...rawMetadata } =
  effectiveQuotes.get(blockScanEdgeKey(protocolEdge))!;
rawOnly.set(blockScanEdgeKey(protocolEdge), {
  ...rawMetadata, mid: 2e-12, feeBps: 0,
});
assert.throws(
  () => {
    // @ts-expect-error Raw rows are deliberately outside the effective-only API.
    scan(rawOnly);
  },
  "raw mid metadata cannot fill a missing effective amount quote",
);

const afterQuote = scan(effectiveQuotes);
const opportunity = afterQuote.opportunities.find((item) =>
  item.seedEdges.some((edge) => edge.adapterId === "metronome-hgusdc-exit")
);
assert(opportunity !== undefined, "explicit hGUSDC amount output should make scanner enumerate the ring");
assert(opportunity.flashToken === ADDR.USDC.toLowerCase(), "hGUSDC ring should rotate to USDC");
assert(opportunity.searchSeed.searchCenter === 100n * USDC_UNIT, "effective input owns the search center");
assert(Math.abs(opportunity.coarseSpreadBps! - 300) < 1e-8, "explicit amounts imply three percent coarse return");
assert(opportunity.seedEdges[0].tokenIn.toLowerCase() === ADDR.USDC.toLowerCase(), "ring starts in USDC");
assert(
  opportunity.seedEdges[opportunity.seedEdges.length - 1].tokenOut.toLowerCase() ===
    ADDR.USDC.toLowerCase(),
  "ring closes in USDC",
);

console.log("blockscan-metronome-mid PASS (synthetic effective amounts required; no raw-mid fallback)");
