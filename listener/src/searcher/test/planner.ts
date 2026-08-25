/**
 * Deterministic planner tests for live-search candidate hygiene.
 * Pure in-memory — no RPC, no anvil.
 */

import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { canonicalTokenRing, cycleFingerprint } from "../detector/cycle-fingerprint.js";
import type { BlockScanOpportunity, Opportunity } from "../detector/detector.js";
import { detectImpactFromLogs } from "../detector/pool-impact.js";
import { TemplatePlanner } from "../planner/planner.js";
import {
  v4PoolId,
  type TokenEdge,
  type V4PoolKey,
} from "../planner/token-graph.js";
import { deriveEdgeTaxonomy, type ProtocolAction } from "../strategy-taxonomy.js";
import type { FlashLiquidityView, FlashSource } from "../solver/flash-liquidity.js";
import { FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY } from "../templates/path-template.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const BEL = "0x0000000000000000000000000000000000000b01";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0x0000000000000000000000000000000000000dAc";
const WETH = ADDR.WETH;
const ZeroAddress = ethers.ZeroAddress;
const P1 = "0x0000000000000000000000000000000000000001";
const P2 = "0x0000000000000000000000000000000000000002";
const P3 = "0x0000000000000000000000000000000000000003";

function swap(tokenIn: string, tokenOut: string, pool: string, adapterId = "univ3-swap"): TokenEdge {
  return {
    adapterId,
    target: pool,
    tokenIn,
    tokenOut,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
    score: 100,
  };
}

function lend(tokenIn: string, tokenOut: string, pool: string, adapterId = "fluid-vault"): TokenEdge {
  return {
    adapterId,
    target: pool,
    tokenIn,
    tokenOut,
    slotKind: "lend",
    // S0 contract: deriveEdgeTaxonomy("lend") sets edgeKind:"credit" and leavesStandingPosition:true.
    ...deriveEdgeTaxonomy("lend"),
    score: 100,
  };
}

function protocol(
  tokenIn: string,
  tokenOut: string,
  pool: string,
  protocolAction: ProtocolAction,
  adapterId = "psm",
): TokenEdge {
  return {
    adapterId,
    target: pool,
    tokenIn,
    tokenOut,
    slotKind: "protocol",
    protocolAction,
    ...deriveEdgeTaxonomy("protocol", protocolAction),
    score: 100,
  };
}

function opportunity(): Opportunity {
  return {
    kind: "backrun-arb",
    victimTxHash: "0xplanner",
    blockNumber: 1,
    affectedPools: [P1],
    affectedTokens: [A, B],
    startToken: A,
    profitToken: A,
    victimAmountIn: 1_000_000n,
    victimEffect: {
      kind: "swap",
      impact: {
        pool: P1,
        tokenIn: A,
        tokenOut: B,
        amountIn: 1_000_000n,
        matchedAdapterId: "univ3-swap",
      },
    },
    hints: {
      impact: {
        pool: P1,
        tokenIn: A,
        tokenOut: B,
      },
    },
  };
}

function opportunityWithImpact(tokenIn: string, tokenOut: string, pool: string, start = tokenOut): Opportunity {
  return {
    kind: "backrun-arb",
    victimTxHash: "0xplanner",
    blockNumber: 1,
    affectedPools: [pool],
    affectedTokens: [tokenIn, tokenOut],
    startToken: start,
    profitToken: start,
    victimAmountIn: 1_000_000n,
    victimEffect: {
      kind: "swap",
      impact: {
        pool,
        tokenIn,
        tokenOut,
        amountIn: 1_000_000n,
        matchedAdapterId: "univ3-swap",
      },
    },
    hints: {
      impact: {
        pool,
        tokenIn,
        tokenOut,
      },
    },
  };
}

class FakeFlashLiquidity implements FlashLiquidityView {
  constructor(private readonly sources: Map<string, FlashSource>) {}

  borrowable(token: string): bigint {
    return this.source(token)?.amount ?? 0n;
  }

  source(token: string): FlashSource | null {
    return this.sources.get(token.toLowerCase()) ?? null;
  }
}

function fakeLiquidity(entries: Array<[string, bigint, string]>): FlashLiquidityView {
  return new FakeFlashLiquidity(new Map(
    entries.map(([token, amount, adapterId]) => [
      token.toLowerCase(),
      { amount, adapterId },
    ]),
  ));
}

async function plan(graph: TokenEdge[]) {
  const planner = new TemplatePlanner();
  planner.setGraph(graph);
  planner.setMaxHops(2);
  return planner.plan(opportunity(), [FLASH_SWAP_REPAY]);
}

async function testPrunesSamePoolReverse(): Promise<void> {
  const plans = await plan([
    swap(A, B, P1),
    swap(B, A, P1),
  ]);
  assert(plans.length === 0, `same-pool reverse: expected 0 plans, got ${plans.length}`);
  console.log("[planner] same-pool immediate reverse prune: PASS");
}

async function testKeepsCrossVenueReverse(): Promise<void> {
  const plans = await plan([
    swap(A, B, P1),
    swap(B, A, P1),
    swap(B, A, P2),
  ]);
  assert(plans.length === 1, `cross-venue reverse: expected 1 plan, got ${plans.length}`);
  assert(plans[0].tokenPath.edges[1].target === P2, "cross-venue reverse: should keep the different pool");
  console.log("[planner] cross-venue reverse survives prune: PASS");
}

async function testFlashAdaptersDoNotDuplicateQuotes(): Promise<void> {
  const plans = await plan([
    swap(A, B, P1),
    swap(B, A, P2),
  ]);
  assert(plans.length === 1, `flash adapter dedupe: expected 1 path plan, got ${plans.length}`);
  assert(
    plans[0].flashAdapterIds.join(",") === "morpho-flash,balancer-flash",
    `flash adapter dedupe: adapter set ${plans[0].flashAdapterIds.join(",")}`,
  );
  assert(plans[0].flashAdapterId === "morpho-flash", `flash adapter dedupe: preferred ${plans[0].flashAdapterId}`);
  console.log("[planner] flash adapters carried without quote duplication: PASS");
}

async function testLendTemplateRequiresLendEdge(): Promise<void> {
  const planner = new TemplatePlanner();
  planner.setGraph([
    swap(A, B, P1),
    swap(B, A, P2),
  ]);
  planner.setMaxHops(2);

  const plans = await planner.plan(opportunity(), [FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY]);
  assert(plans.length === 1, `lend slot: expected only swap template plan, got ${plans.length}`);
  assert(plans[0].templateName === "flash-swap-repay", `lend slot: selected ${plans[0].templateName}`);
  console.log("[planner] lend template requires a lend edge: PASS");
}

async function testBorrowabilityRotatesIntermediateToken(): Promise<void> {
  const planner = new TemplatePlanner();
  planner.setGraph([
    swap(BEL, USDT, P1),
    swap(USDT, WETH, P2),
    swap(WETH, BEL, P3),
  ]);
  planner.setMaxHops(3);
  planner.setFlashLiquidity(fakeLiquidity([
    [BEL, 0n, "morpho-flash"],
    [WETH, 1_000_000n, "balancer-flash"],
  ]));

  const plans = await planner.plan(
    opportunityWithImpact(USDT, BEL, P1, BEL),
    [FLASH_SWAP_REPAY],
  );
  assert(plans.length === 1, `borrowability rotation: expected 1 plan, got ${plans.length}`);
  const plan = plans[0];
  assert(plan.opportunity.startToken === WETH, `borrowability rotation: start ${plan.opportunity.startToken}`);
  assert(plan.opportunity.profitToken === WETH, `borrowability rotation: profit ${plan.opportunity.profitToken}`);
  assert(plan.flashAdapterIds.join(",") === "balancer-flash", `borrowability rotation: adapter ${plan.flashAdapterIds}`);
  assert(plan.maxFlashAmount === 1_000_000n, `borrowability rotation: maxFlash ${plan.maxFlashAmount}`);
  const path = plan.tokenPath.edges.map((e) => `${e.tokenIn}->${e.tokenOut}`).join("|");
  assert(
    path === `${WETH}->${BEL}|${BEL}->${USDT}|${USDT}->${WETH}`,
    `borrowability rotation: wrong rotated path ${path}`,
  );
  console.log("[planner] borrowability rotates intermediate token: PASS");
}

async function testBorrowabilityChoosesDeepestProvider(): Promise<void> {
  const planner = new TemplatePlanner();
  planner.setGraph([
    swap(BEL, USDT, P1),
    swap(USDT, WETH, P2),
    swap(WETH, BEL, P3),
  ]);
  planner.setMaxHops(3);
  planner.setFlashLiquidity(fakeLiquidity([
    [WETH, 2_000_000n, "balancer-flash"],
    [USDT, 1_000n, "morpho-flash"],
  ]));
  planner.setMaxRotationsPerPath(1);

  const plans = await planner.plan(
    opportunityWithImpact(USDT, BEL, P1, BEL),
    [FLASH_SWAP_REPAY],
  );
  assert(plans.length === 1, `deepest provider: expected 1 plan, got ${plans.length}`);
  assert(plans[0].opportunity.startToken === WETH, `deepest provider: start ${plans[0].opportunity.startToken}`);
  assert(plans[0].flashAdapterId === "balancer-flash", `deepest provider: adapter ${plans[0].flashAdapterId}`);
  console.log("[planner] borrowability prefers deepest provider: PASS");
}

async function testBorrowabilitySkipsNoBorrowableCycle(): Promise<void> {
  const planner = new TemplatePlanner();
  planner.setGraph([
    swap(BEL, USDT, P1),
    swap(USDT, WETH, P2),
    swap(WETH, BEL, P3),
  ]);
  planner.setMaxHops(3);
  planner.setFlashLiquidity(fakeLiquidity([]));

  const plans = await planner.plan(
    opportunityWithImpact(USDT, BEL, P1, BEL),
    [FLASH_SWAP_REPAY],
  );
  assert(plans.length === 0, `no borrowable cycle: expected 0 plans, got ${plans.length}`);
  const diagnostic = planner.lastNoCandidateDiagnostic();
  if (!diagnostic) throw new Error("FAIL: no borrowable cycle: expected diagnostic");
  assert(
    diagnostic.classification === "borrowability_missing",
    `no borrowable cycle: classification ${diagnostic.classification}`,
  );
  console.log("[planner] no borrowable cycle skips candidate: PASS");
}

async function testNoCandidateDiagnosticClassifiesImpactPoolNotInGraph(): Promise<void> {
  const planner = new TemplatePlanner();
  planner.setGraph([
    swap(B, USDT, P2),
    swap(USDT, B, P3),
  ]);
  planner.setMaxHops(2);

  const plans = await planner.plan(
    opportunityWithImpact(A, B, P1, B),
    [FLASH_SWAP_REPAY],
  );
  assert(plans.length === 0, `pool-not-in-graph diagnostic: expected 0 plans, got ${plans.length}`);
  const diagnostic = planner.lastNoCandidateDiagnostic();
  if (!diagnostic) throw new Error("FAIL: pool-not-in-graph diagnostic: expected diagnostic");
  assert(
    diagnostic.classification === "impact_pool_not_in_routing_graph",
    `pool-not-in-graph diagnostic: classification ${diagnostic.classification}`,
  );
  assert(!diagnostic.impact_pool_edge_in_routing_graph, "pool-not-in-graph diagnostic: pool should be absent");
  console.log("[planner] no-candidate diagnostic classifies impact pool not in routing graph: PASS");
}

async function testNoCandidateDiagnosticClassifiesOnlyImmediateSamePoolReverse(): Promise<void> {
  const planner = new TemplatePlanner();
  planner.setGraph([
    swap(A, B, P1),
    swap(B, A, P1),
  ]);
  planner.setMaxHops(2);

  const plans = await planner.plan(
    opportunityWithImpact(A, B, P1, B),
    [FLASH_SWAP_REPAY],
  );
  assert(plans.length === 0, `same-pool diagnostic: expected 0 plans, got ${plans.length}`);
  const diagnostic = planner.lastNoCandidateDiagnostic();
  if (!diagnostic) throw new Error("FAIL: same-pool diagnostic: expected diagnostic");
  assert(
    diagnostic.classification === "only_immediate_same_pool_reverse",
    `same-pool diagnostic: classification ${diagnostic.classification}`,
  );
  assert(diagnostic.impact_pool_edge_in_routing_graph, "same-pool diagnostic: impact pool should be in graph");
  assert(diagnostic.same_pool_reverse_edge_exists, "same-pool diagnostic: reverse edge should exist");
  assert(diagnostic.same_pool_reverse_pruned > 0, "same-pool diagnostic: reverse path should be pruned");
  assert(
    diagnostic.impact_token_return_venues_excluding_impact_pool === 0,
    `same-pool diagnostic: return venues ${diagnostic.impact_token_return_venues_excluding_impact_pool}`,
  );
  console.log("[planner] no-candidate diagnostic classifies only immediate same-pool reverse: PASS");
}

async function testNoCandidateDiagnosticClassifiesNoSupportedReturnVenue(): Promise<void> {
  const planner = new TemplatePlanner();
  planner.setGraph([
    swap(A, B, P1),
    swap(B, USDT, P2),
    swap(USDT, B, P3),
  ]);
  planner.setMaxHops(2);

  const plans = await planner.plan(
    opportunityWithImpact(A, B, P1, B),
    [FLASH_SWAP_REPAY],
  );
  assert(plans.length === 0, `no-return diagnostic: expected 0 plans, got ${plans.length}`);
  const diagnostic = planner.lastNoCandidateDiagnostic();
  if (!diagnostic) throw new Error("FAIL: no-return diagnostic: expected diagnostic");
  assert(
    diagnostic.classification === "impact_token_no_supported_return_venue",
    `no-return diagnostic: classification ${diagnostic.classification}`,
  );
  assert(diagnostic.impact_pool_edge_in_routing_graph, "no-return diagnostic: impact pool should be in graph");
  assert(!diagnostic.same_pool_reverse_edge_exists, "no-return diagnostic: same-pool reverse should not exist");
  assert(
    diagnostic.impact_token_return_venues === 1,
    `no-return diagnostic: return venues ${diagnostic.impact_token_return_venues}`,
  );
  console.log("[planner] no-candidate diagnostic classifies no supported return venue: PASS");
}

async function testNoCandidateDiagnosticClassifiesPlanBudgetExhausted(): Promise<void> {
  const planner = new TemplatePlanner();
  planner.setGraph([
    swap(A, B, P1),
    swap(B, A, P2),
  ]);
  planner.setMaxHops(2);

  const plans = await planner.plan(opportunity(), [FLASH_SWAP_REPAY], { deadlineAtMs: Date.now() - 1 });
  assert(plans.length === 0, `plan budget diagnostic: expected 0 plans, got ${plans.length}`);
  const diagnostic = planner.lastNoCandidateDiagnostic();
  if (!diagnostic) throw new Error("FAIL: plan budget diagnostic: expected diagnostic");
  assert(
    diagnostic.classification === "plan_budget_exhausted",
    `plan budget diagnostic: classification ${diagnostic.classification}`,
  );
  console.log("[planner] no-candidate diagnostic classifies plan budget exhausted: PASS");
}

async function testNativeEthV4RoutesViaWethAlias(): Promise<void> {
  const nativeKey: V4PoolKey = {
    currency0: ZeroAddress,
    currency1: USDC,
    fee: 500,
    tickSpacing: 1,
    hooks: ZeroAddress,
  };
  const poolId = v4PoolId(nativeKey);
  const nativeV4Edges: TokenEdge[] = [
    {
      adapterId: "univ4-unlock",
      target: ADDR.UNISWAP_V4_POOL_MANAGER,
      tokenIn: WETH,
      tokenOut: USDC,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
      nativeCurrency0: true,
      nativeCurrency1: false,
      v4PoolKey: nativeKey,
      poolId,
      score: 100,
    },
    {
      adapterId: "univ4-unlock",
      target: ADDR.UNISWAP_V4_POOL_MANAGER,
      tokenIn: USDC,
      tokenOut: WETH,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
      nativeCurrency0: true,
      nativeCurrency1: false,
      v4PoolKey: nativeKey,
      poolId,
      score: 100,
    },
  ];
  // FLIP gate for the pool-impact.ts change (governance 12): a RAW native-ETH v4
  // Swap log must decode to an impact aliased to WETH, not the 0x0 dead-end. If the
  // decoder alias were reverted, impact.tokenIn would be ZeroAddress and this fails.
  const UNIV4_SWAP_TOPIC = ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
  const nativeSwapLog = {
    address: ADDR.UNISWAP_V4_POOL_MANAGER,
    topics: [UNIV4_SWAP_TOPIC, poolId, "0x000000000000000000000000e08d97e151473a848c3d9ca3f323cb720472d015"],
    data: ethers.AbiCoder.defaultAbiCoder().encode(
      ["int128", "int128", "uint160", "uint128", "int24", "uint24"],
      [-900n, 1_000_000n, 0n, 0n, 0, 500],
    ),
  };
  const v4Impacts = (await detectImpactFromLogs([nativeSwapLog], nativeV4Edges))
    .filter((i) => i.matchedAdapterId === "univ4-unlock");
  assert(v4Impacts.length === 1, `native-ETH v4 decode: expected 1 impact, got ${v4Impacts.length}`);
  assert(
    v4Impacts[0].tokenIn.toLowerCase() === WETH.toLowerCase() &&
      v4Impacts[0].tokenOut.toLowerCase() === USDC.toLowerCase(),
    `native-ETH v4 decode alias: expected WETH->USDC, got ${v4Impacts[0].tokenIn}->${v4Impacts[0].tokenOut}`,
  );
  assert(v4Impacts[0].poolId === poolId, `native-ETH v4 decode: poolId identity lost`);

  const planner = new TemplatePlanner();
  planner.setGraph([
    ...nativeV4Edges,
    swap(WETH, USDC, ADDR.UNISWAP_V3_USDC_WETH_500),
    swap(USDC, WETH, ADDR.UNISWAP_V3_USDC_WETH_500),
  ]);
  planner.setMaxHops(2);

  const plans = await planner.plan({
    kind: "backrun-arb",
    victimTxHash: "0xplanner",
    blockNumber: 1,
    affectedPools: [ADDR.UNISWAP_V4_POOL_MANAGER],
    affectedTokens: [WETH, USDC],
    startToken: WETH,
    profitToken: WETH,
    victimAmountIn: 1_000_000n,
    victimEffect: {
      kind: "swap",
      impact: {
        pool: ADDR.UNISWAP_V4_POOL_MANAGER,
        tokenIn: WETH,
        tokenOut: USDC,
        amountIn: 1_000_000n,
        matchedAdapterId: "univ4-unlock",
        poolId,
      },
    },
    hints: {
      impact: {
        pool: ADDR.UNISWAP_V4_POOL_MANAGER,
        tokenIn: WETH,
        tokenOut: USDC,
        poolId,
      },
    },
  }, [FLASH_SWAP_REPAY]);
  assert(plans.length > 0, `native-ETH v4 WETH alias: expected >0 plans, got ${plans.length}`);
  console.log("[planner] native-ETH v4 pool routes through WETH alias: PASS");
}

// Blockscan receives one scanner-bounded route and must not perform a second
// full-Graph search or apply the backrun DFS caps to that route.
const REAL_WETH = ADDR.WETH;
const REAL_USDC = ADDR.USDC;
const TOK_874376 = "0x27c70cd1946795b66be9d954418546998b546634";
const POOL_USDC_WETH_100 = ADDR.UNISWAP_V3_USDC_WETH_100;
const CFG = ethers.getAddress("0xcccccccccc33d538dbc2ee4feab0a7a1ff4e8a94");
const POOL_V3_WETH_CFG = ethers.getAddress("0x08a10a8b713c03e2fecaa3e355cea18a459ffcbf");
const POOL_V4_ETH_CFG_ID = "0x267d01a3b23fe2340482242db5396f7544d36f398862efa591e92a079348cd9c";

async function testBlockScanPlannerBinding(): Promise<void> {
  const token = TOK_874376;
  const seedPoolA = "0x0000000000000000000000000000000000000b51";
  const seedPoolB = "0x0000000000000000000000000000000000000b52";
  const seedEdges = [
    swap(REAL_WETH, token, seedPoolA),
    swap(token, REAL_WETH, seedPoolB),
  ];
  const sourceBlock = 25455296;
  const ring = [REAL_WETH, token];
  const opp: BlockScanOpportunity = {
    kind: "block-scan-arb",
    sourceBlock,
    stateBlock: sourceBlock,
    cycleId: canonicalTokenRing(ring).join("|"),
    cycleFingerprint: cycleFingerprint(sourceBlock, ring),
    seedEdges,
    flashToken: REAL_WETH,
    searchSeed: {
      startToken: REAL_WETH,
      searchCenter: 5_000n,
      maxInput: 1_000_000n,
    },
    leavesStandingPosition: false,
  };
  const planner = new TemplatePlanner();
  planner.setGraph([
    swap(REAL_WETH, token, P1),
    swap(token, REAL_WETH, P2),
    swap(REAL_WETH, REAL_USDC, POOL_USDC_WETH_100),
    swap(REAL_USDC, REAL_WETH, POOL_USDC_WETH_100),
  ]);

  const plans = await planner.plan(opp, [FLASH_SWAP_REPAY]);
  assert(plans.length >= 1, `block-scan binding: expected at least 1 plan, got ${plans.length}`);
  const expectedPools = seedEdges.map((edge) => edge.target.toLowerCase()).join("|");
  for (const plan of plans) {
    const actualPools = plan.tokenPath.edges.map((edge) => edge.target.toLowerCase()).join("|");
    assert(
      actualPools === expectedPools,
      `block-scan binding: expected pinned seed pools ${expectedPools}, got ${actualPools}`,
    );
  }
  assert(plans[0].maxFlashAmount === 1_000_000n, `block-scan binding: maxFlash ${plans[0].maxFlashAmount}`);
  assert(
    plans[0].opportunity.startToken.toLowerCase() === REAL_WETH.toLowerCase(),
    `block-scan binding: start token ${plans[0].opportunity.startToken}`,
  );
  assert(
    plans[0].opportunity.profitToken.toLowerCase() === REAL_WETH.toLowerCase(),
    `block-scan binding: profit token ${plans[0].opportunity.profitToken}`,
  );

  const liveFundingPlanner = new TemplatePlanner();
  liveFundingPlanner.setFlashLiquidity(fakeLiquidity([
    [REAL_WETH, 1_234n, "morpho-flash"],
  ]));
  const fundedPlans = await liveFundingPlanner.planBlockScanFromSeedEdges(
    opp,
    [FLASH_SWAP_REPAY],
  );
  assert(fundedPlans.length >= 1, "block-scan binding: live funding should admit plan");
  assert(
    fundedPlans[0].flashAdapterId === "morpho-flash",
    `block-scan binding: expected live provider, got ${fundedPlans[0].flashAdapterId}`,
  );
  assert(
    fundedPlans[0].maxFlashAmount === 1_234n,
    `block-scan binding: expected funding cap, got ${fundedPlans[0].maxFlashAmount}`,
  );
  const fundedOpportunity = fundedPlans[0].opportunity;
  assert(
    "searchSeed" in fundedOpportunity &&
      fundedOpportunity.searchSeed.searchCenter === 1_234n &&
      fundedOpportunity.searchSeed.maxInput === 1_234n,
    "block-scan binding: solver domain must be capped to current-N funding",
  );

  const unfundedPlanner = new TemplatePlanner();
  unfundedPlanner.setFlashLiquidity(fakeLiquidity([]));
  const unfundedPlans = await unfundedPlanner.planBlockScanFromSeedEdges(
    opp,
    [FLASH_SWAP_REPAY],
  );
  assert(
    unfundedPlans.length === 0,
    "block-scan binding: missing current-N funding must fail closed",
  );

  const sixHopTokens = [
    REAL_WETH,
    "0x0000000000000000000000000000000000000c11",
    "0x0000000000000000000000000000000000000c12",
    "0x0000000000000000000000000000000000000c13",
    "0x0000000000000000000000000000000000000c14",
    "0x0000000000000000000000000000000000000c15",
    REAL_WETH,
  ];
  const sixHopEdges = Array.from({ length: 6 }, (_, index) =>
    swap(
      sixHopTokens[index],
      sixHopTokens[index + 1],
      `0x${(0xc21 + index).toString(16).padStart(40, "0")}`,
    )
  );
  const sixHopRing = sixHopTokens.slice(0, -1);
  const sixHopOpportunity: BlockScanOpportunity = {
    kind: "block-scan-arb",
    sourceBlock,
    stateBlock: sourceBlock,
    cycleId: canonicalTokenRing(sixHopRing).join("|"),
    cycleFingerprint: cycleFingerprint(sourceBlock, sixHopRing),
    seedEdges: sixHopEdges,
    flashToken: REAL_WETH,
    searchSeed: {
      startToken: REAL_WETH,
      searchCenter: 5_000n,
      maxInput: 1_000_000n,
    },
    leavesStandingPosition: false,
  };
  const narrowFullGraphPlanner = new TemplatePlanner();
  narrowFullGraphPlanner.setMaxHops(2);
  narrowFullGraphPlanner.setMaxPoolsPerToken(1);
  const sixHopPlans = await narrowFullGraphPlanner.planBlockScanFromSeedEdges(
    sixHopOpportunity,
    [FLASH_SWAP_REPAY],
  );
  assert(
    sixHopPlans.length === 1 &&
      sixHopPlans[0].tokenPath.edges.length === sixHopEdges.length &&
      sixHopPlans[0].tokenPath.edges.every(
        (edge, index) => edge.target === sixHopEdges[index].target,
      ),
    "block-scan binding: pre-bounded six-hop seed route must bypass full-Graph DFS caps",
  );
  console.log("[planner] block-scan planner binding from pinned seedEdges: PASS");
}

async function testCfgV4PoolClosesRoutingCycle(): Promise<void> {
  // Strict graph authority: edges come from the verified family lifecycle,
  // never from a parallel eth_call builder.
  const withoutV4: TokenEdge[] = [];
  assert(
    !withoutV4.some((edge) => edge.poolId === POOL_V4_ETH_CFG_ID),
    "CFG gate baseline: missing v4 pool should not be in routing graph",
  );
  const baselinePlanner = new TemplatePlanner();
  baselinePlanner.setGraph(withoutV4);
  baselinePlanner.setMaxHops(2);
  const baselinePlans = await baselinePlanner.plan(
    opportunityWithImpact(REAL_WETH, CFG, POOL_V3_WETH_CFG, REAL_WETH),
    [FLASH_SWAP_REPAY],
  );
  assert(baselinePlans.length === 0, `CFG gate baseline: expected 0 plans, got ${baselinePlans.length}`);

  const withV4: TokenEdge[] = [
    swap(REAL_WETH, CFG, POOL_V3_WETH_CFG),
    swap(CFG, REAL_WETH, POOL_V3_WETH_CFG),
    {
      adapterId: "univ4-unlock",
      target: ADDR.UNISWAP_V4_POOL_MANAGER,
      tokenIn: CFG,
      tokenOut: REAL_WETH,
      slotKind: "swap",
      edgeKind: "swap",
      leavesStandingPosition: false,
      poolId: POOL_V4_ETH_CFG_ID,
      nativeCurrency0: true,
    },
    {
      adapterId: "univ4-unlock",
      target: ADDR.UNISWAP_V4_POOL_MANAGER,
      tokenIn: REAL_WETH,
      tokenOut: CFG,
      slotKind: "swap",
      edgeKind: "swap",
      leavesStandingPosition: false,
      poolId: POOL_V4_ETH_CFG_ID,
      nativeCurrency1: true,
    },
  ];
  const cfgV4Edges = withV4.filter((edge) => edge.poolId === POOL_V4_ETH_CFG_ID);
  assert(cfgV4Edges.length === 2, `CFG gate fixed: expected 2 directed v4 edges, got ${cfgV4Edges.length}`);
  assert(
    cfgV4Edges.some((edge) =>
      edge.adapterId === "univ4-unlock" &&
      edge.tokenIn.toLowerCase() === CFG.toLowerCase() &&
      edge.tokenOut.toLowerCase() === REAL_WETH.toLowerCase() &&
      edge.nativeCurrency0 === true
    ),
    "CFG gate fixed: missing CFG->WETH(native ETH) v4 edge",
  );
  const fixedPlanner = new TemplatePlanner();
  fixedPlanner.setGraph(withV4);
  fixedPlanner.setMaxHops(2);
  const fixedPlans = await fixedPlanner.plan(
    opportunityWithImpact(REAL_WETH, CFG, POOL_V3_WETH_CFG, REAL_WETH),
    [FLASH_SWAP_REPAY],
  );
  assert(fixedPlans.length > 0, `CFG gate fixed: expected enumerable cycle, got ${fixedPlans.length}`);
  assert(
    fixedPlans.some((plan) =>
      plan.tokenPath.edges.some((edge) => edge.target.toLowerCase() === POOL_V3_WETH_CFG.toLowerCase()) &&
      plan.tokenPath.edges.some((edge) => edge.poolId === POOL_V4_ETH_CFG_ID)
    ),
    "CFG gate fixed: expected WETH->CFG(v3)->ETH/WETH(v4) cycle",
  );
  console.log(
    "[planner] CFG v4 route gap flip: pool_in_routing_graph false->true, " +
      `candidate_plans 0->${fixedPlans.length}: PASS`,
  );
}

async function main(): Promise<void> {
  await testPrunesSamePoolReverse();
  await testKeepsCrossVenueReverse();
  await testFlashAdaptersDoNotDuplicateQuotes();
  await testLendTemplateRequiresLendEdge();
  await testBorrowabilityRotatesIntermediateToken();
  await testBorrowabilityChoosesDeepestProvider();
  await testBorrowabilitySkipsNoBorrowableCycle();
  await testNoCandidateDiagnosticClassifiesImpactPoolNotInGraph();
  await testNoCandidateDiagnosticClassifiesOnlyImmediateSamePoolReverse();
  await testNoCandidateDiagnosticClassifiesNoSupportedReturnVenue();
  await testNoCandidateDiagnosticClassifiesPlanBudgetExhausted();
  await testNativeEthV4RoutesViaWethAlias();
  await testBlockScanPlannerBinding();
  await testCfgV4PoolClosesRoutingCycle();
  console.log("planner PASS (14/14)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
