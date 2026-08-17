/**
 * Deterministic planner tests for live-search candidate hygiene.
 * Pure in-memory — no RPC, no anvil.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { canonicalTokenRing, cycleFingerprint } from "../detector/cycle-fingerprint.js";
import type { BlockScanOpportunity, Opportunity } from "../detector/detector.js";
import { detectImpactFromLogs } from "../detector/pool-impact.js";
import { TemplatePlanner } from "../planner/planner.js";
import {
  buildTokenGraph,
  v4PoolId,
  type PoolEntry,
  type TokenEdge,
  type TokenQueryBackend,
  type V4PoolKey,
} from "../planner/token-graph.js";
import { mergePoolRegistries } from "../pool-registry-merge.js";
import { loadPoolUniverse, selectPairCompletionPools } from "../pool-universe.js";
import { deriveEdgeTaxonomy, type ProtocolAction } from "../strategy-taxonomy.js";
import type { FlashLiquidityView, FlashSource } from "../solver/flash-liquidity.js";
import { FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY, type PathTemplate } from "../templates/path-template.js";

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

function poolToSwapEdges(pool: PoolEntry): TokenEdge[] {
  if (!pool.token0 || !pool.token1) return [];
  const adapterId = pool.adapter === "univ2" ? "univ2-swap" : "univ3-swap";
  return [
    { ...swap(pool.token0, pool.token1, pool.address, adapterId), score: pool.score },
    { ...swap(pool.token1, pool.token0, pool.address, adapterId), score: pool.score },
  ];
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

// ── Real-case regression fixtures (repair-replay gate, docs/research/gates.md rule 12) ──
// Each pins a real failing case observed live so a coverage/routing fix can be
// confirmed deterministically (flip) and guarded against regression. Addresses are
// public on-chain evidence. The planner is address-agnostic, so these behave exactly
// like the synthetic unit tests above — the value is the provenance link + flip target.
const REAL_WETH = ADDR.WETH;
const REAL_WSTUSR = ADDR.WSTUSR;
const REAL_WSTETH = ADDR.WSTETH;
const REAL_STETH = ADDR.STETH;
const REAL_SUSDS = ADDR.SUSDS;
const REAL_USDS = ADDR.USDS;
const REAL_USDC = ADDR.USDC;
const REAL_DAI = ADDR.DAI;
const REAL_USDT = ADDR.USDT;
const FLUID_VAULT_WSTUSR_USDC = ADDR.FLUID_VAULT_WSTUSR_USDC;
const POOL_F88B_USDC_WSTUSR_DEX = "0xf88b498b835279ec9de597c7360ca21b7e880305";
const C470 = "0xc470f5E6C17a2977CeabB524D530F19024e5a719";
const POOL_E2A1437 = "0xE2a1437e2a15CfA591AA1D70e9a75C7598C73fDB";
const TOK_874376 = "0x27c70cd1946795b66be9d954418546998b546634";
const POOL_874376 = "0x874376be8231dad99aabf9ef0767b3cc054c60ee";
const POOL_USDC_WETH_100 = ADDR.UNISWAP_V3_USDC_WETH_100;
const POOL_USDC_USDT_100 = ADDR.UNISWAP_V3_USDC_USDT_100;
const POOL_V3FORK_WETH_USDT = "0x05dEf6d34631BbDd35e212CB749caCAEbf8c963D";
const CFG = ethers.getAddress("0xcccccccccc33d538dbc2ee4feab0a7a1ff4e8a94");
const POOL_V3_WETH_CFG = ethers.getAddress("0x08a10a8b713c03e2fecaa3e355cea18a459ffcbf");
const POOL_V4_ETH_CFG_ID = "0x267d01a3b23fe2340482242db5396f7544d36f398862efa591e92a079348cd9c";
const CFG_V4_POOL_KEY: V4PoolKey = {
  currency0: ethers.ZeroAddress,
  currency1: CFG,
  fee: 10001,
  tickSpacing: 200,
  hooks: ethers.ZeroAddress,
};
const OVR = "0x21BfBDa47A0B4B5b1248c767Ee49F7caA9B23697";
const POOL_OVR_WETH_INGRAPH = "0xc3f6b81fb9e6db259272026601689e383f94c0b0";
const POOL_OVR_WETH_ENQUEUED = "0x0b0d6c11d26b58cb25f59bd9b14190c8941e58fc";
const TOK_14FEE680 = "0x14feE680690900BA0ccCfC76AD70Fd1b95D10e16";
const POOL_14FEE_WETH_IMPACT = "0x2a6c340b00000000000000000000000000000000";
const POOL_14FEE_WETH_ALT = "0x49bd1fa4c7286c2754ec7607f6f2e835f3ca6ddd";
const TOK_FF208177 = "0xff20817700000000000000000000000000000000";
const POOL_FF208177_A = "0x15e86e6f00000000000000000000000000000000";
const POOL_FF208177_B = "0x08650bb900000000000000000000000000000000";
const TOK_1151 = "0x1151CB3d861920e07a38e03eEAd12C32178567F6";
const POOL_1151_USDT_A = "0x5ea523e496D049e2bA8B303C8D85C83FB6F285F8";
const POOL_1151_USDT_B = "0x1e84865E17B49286f26D356DC39fF671EDfaA199";
const POOL_WSTETH_STETH_SYNTH = "0x0000000000000000000000000000000000000e7e";
const POOL_SUSDS_USDS_SYNTH = "0x0000000000000000000000000000000000004626";
const POOL_7CE631_UNIV3_RETH_WETH = "0x553e9c493678d8606d6a5ba284643db2110df823";
const POOL_7CE631_BALANCER_V3 = "0xbb6f701f42a6104deffc041c5c0057b8a9c46bbc";

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
  console.log("[planner] block-scan planner binding from pinned seedEdges: PASS");
}

interface ReplayFixture {
  id: string;
  provenance: string;
  edges: TokenEdge[];
  impact: { tokenIn: string; tokenOut: string; pool: string; start: string };
  expectPlans?: number;     // current expected; flip target in the comment
  expectMinPlans?: number;
  maxHops?: number;
  expectClass?: string;     // no_candidate classification when expectPlans === 0
  expectTokenPathTokensGreaterThan?: number;
  templates?: PathTemplate[];              // default [FLASH_SWAP_REPAY]
  flashLiquidity?: Array<[string, bigint, string]>;   // [token, amount, adapterId] -> setFlashLiquidity
}

const REPLAY_FIXTURES: ReplayFixture[] = [
  {
    id: "tx-7ce631-rocksolid-balancer-v3-gap",
    provenance: "tx 0x7ce631b94570e8ebcaea60e93ccfb808327087405e6f0561450d4bb7f69b3c87 block 25535037; RockSolid and Balancer V3 edges absent",
    edges: [
      swap(REAL_WETH, ADDR.RETH, POOL_7CE631_UNIV3_RETH_WETH),
      swap(ADDR.RETH, REAL_WETH, POOL_7CE631_UNIV3_RETH_WETH),
    ],
    impact: { tokenIn: REAL_WETH, tokenOut: ADDR.RETH, pool: POOL_7CE631_UNIV3_RETH_WETH, start: REAL_WETH },
    maxHops: 4,
    expectPlans: 0,
    expectClass: "only_immediate_same_pool_reverse",
  },
  {
    id: "tx-7ce631-rocksolid-balancer-v3-flip",
    provenance: "tx 0x7ce631b94570e8ebcaea60e93ccfb808327087405e6f0561450d4bb7f69b3c87 block 25535037; full four-edge route admitted",
    edges: [
      swap(REAL_WETH, ADDR.RETH, POOL_7CE631_UNIV3_RETH_WETH),
      swap(ADDR.RETH, REAL_WETH, POOL_7CE631_UNIV3_RETH_WETH),
      protocol(ADDR.RETH, ADDR.ROCKSOLID_RETH, ADDR.ROCKSOLID_RETH, "wrap", "rocksolid-sync-deposit"),
      swap(ADDR.ROCKSOLID_RETH, ADDR.RETH, POOL_7CE631_BALANCER_V3, "balancer-v3-unlock"),
    ],
    impact: { tokenIn: REAL_WETH, tokenOut: ADDR.RETH, pool: POOL_7CE631_UNIV3_RETH_WETH, start: REAL_WETH },
    maxHops: 4,
    expectMinPlans: 1,
  },
  {
    // CR-3a credit-edge routing gate, modeled on reference tx
    // 0xf88b498b835279ec9de597c7360ca21b7e8803053b442a04c5fc664e04e39970 (block 24710788).
    // The direct USDC->wstUSR DEX edge collapses the reference multi-hop return route into one
    // deterministic fixture edge. Anti-binding note: the credit edge is strategy-AGNOSTIC; the
    // 0xf88b reference tx classifies backrun (source swap tx index 0). This fixture proves
    // credit-edge ROUTING, it does NOT bind strategy.
    id: "credit-f88b-absent",
    provenance: "reference tx 0xf88b498b835279ec9de597c7360ca21b7e8803053b442a04c5fc664e04e39970 block 24710788; Fluid credit edge absent",
    edges: [
      swap(REAL_USDC, REAL_WSTUSR, POOL_F88B_USDC_WSTUSR_DEX),
    ],
    impact: { tokenIn: REAL_USDC, tokenOut: REAL_WSTUSR, pool: POOL_F88B_USDC_WSTUSR_DEX, start: REAL_WSTUSR },
    templates: [FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY],
    flashLiquidity: [[REAL_WSTUSR, 1_000_000_000_000n, "morpho-flash"]],
    maxHops: 2,
    expectPlans: 0,
    expectClass: "impact_token_no_supported_return_venue",
  },
  {
    // Same graph with the S0 credit edge present: wstUSR->USDC (Fluid lend/credit)
    // then USDC->wstUSR (DEX return) closes the Morpho-flash repayment loop.
    id: "credit-f88b-present",
    provenance: "reference tx 0xf88b498b835279ec9de597c7360ca21b7e8803053b442a04c5fc664e04e39970 block 24710788; Fluid credit edge present",
    edges: [
      lend(REAL_WSTUSR, REAL_USDC, FLUID_VAULT_WSTUSR_USDC),
      swap(REAL_USDC, REAL_WSTUSR, POOL_F88B_USDC_WSTUSR_DEX),
    ],
    impact: { tokenIn: REAL_USDC, tokenOut: REAL_WSTUSR, pool: POOL_F88B_USDC_WSTUSR_DEX, start: REAL_WSTUSR },
    templates: [FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY],
    flashLiquidity: [[REAL_WSTUSR, 1_000_000_000_000n, "morpho-flash"]],
    maxHops: 2,
    expectMinPlans: 1,
  },
  {
    // PSM reverse (buyGem, DAI->USDC) routing; A1. Anti-binding note: the
    // protocol edge is strategy-AGNOSTIC, like credit-f88b; this fixture proves
    // protocol-edge routing through the existing swap slot, not strategy identity.
    id: "psm-reverse-absent",
    provenance: "A1 PSM reverse buyGem DAI->USDC routing; Sky LitePSM reverse edge absent",
    edges: [
      swap(REAL_USDC, REAL_DAI, ADDR.CURVE_3POOL, "curve-exchange-plain"),
    ],
    impact: { tokenIn: REAL_USDC, tokenOut: REAL_DAI, pool: ADDR.CURVE_3POOL, start: REAL_DAI },
    maxHops: 2,
    expectPlans: 0,
    expectClass: "impact_token_no_supported_return_venue",
  },
  {
    // Same graph with the synthetic DAI->USDC PSM protocol edge present: the
    // DAI->USDC->DAI loop closes without adding a live registry reverse edge.
    id: "psm-reverse-present",
    provenance: "A1 PSM reverse buyGem DAI->USDC routing; Sky LitePSM reverse protocol edge present",
    edges: [
      protocol(REAL_DAI, REAL_USDC, ADDR.SKY_PSM_LITE, "convert"),
      swap(REAL_USDC, REAL_DAI, ADDR.CURVE_3POOL, "curve-exchange-plain"),
    ],
    impact: { tokenIn: REAL_USDC, tokenOut: REAL_DAI, pool: ADDR.CURVE_3POOL, start: REAL_DAI },
    maxHops: 2,
    expectMinPlans: 1,
  },
  {
    // A5 wstETH wrap routing. Without the stETH->wstETH protocol edge, the
    // synthetic wstETH->stETH return venue cannot close a stETH flash loop.
    id: "wsteth-absent",
    provenance: "A5 wstETH wrap routing; stETH->wstETH protocol edge absent",
    edges: [
      swap(REAL_WSTETH, REAL_STETH, POOL_WSTETH_STETH_SYNTH),
    ],
    impact: { tokenIn: REAL_WSTETH, tokenOut: REAL_STETH, pool: POOL_WSTETH_STETH_SYNTH, start: REAL_STETH },
    maxHops: 2,
    expectPlans: 0,
    expectClass: "impact_token_no_supported_return_venue",
  },
  {
    // Same synthetic loop with the stETH->wstETH protocol edge present:
    // stETH->wstETH(wrap) then wstETH->stETH(synthetic swap) closes the loop.
    id: "wsteth-present",
    provenance: "A5 wstETH wrap routing; stETH->wstETH protocol edge present",
    edges: [
      protocol(REAL_STETH, REAL_WSTETH, ADDR.WSTETH, "wrap", "wsteth-wrap"),
      swap(REAL_WSTETH, REAL_STETH, POOL_WSTETH_STETH_SYNTH),
    ],
    impact: { tokenIn: REAL_WSTETH, tokenOut: REAL_STETH, pool: POOL_WSTETH_STETH_SYNTH, start: REAL_STETH },
    maxHops: 2,
    expectMinPlans: 1,
  },
  {
    // A3/A4 ERC4626 sUSDS deposit routing. Without the USDS->sUSDS protocol
    // edge, the synthetic sUSDS->USDS return venue cannot close a USDS flash loop.
    id: "erc4626-absent",
    provenance: "A3/A4 ERC4626 sUSDS deposit routing; USDS->sUSDS protocol edge absent",
    edges: [
      swap(REAL_SUSDS, REAL_USDS, POOL_SUSDS_USDS_SYNTH),
    ],
    impact: { tokenIn: REAL_SUSDS, tokenOut: REAL_USDS, pool: POOL_SUSDS_USDS_SYNTH, start: REAL_USDS },
    maxHops: 2,
    expectPlans: 0,
    expectClass: "impact_token_no_supported_return_venue",
  },
  {
    // Same synthetic loop with the USDS->sUSDS ERC4626 deposit edge present:
    // USDS->sUSDS(deposit) then sUSDS->USDS(synthetic swap) closes the loop.
    id: "erc4626-present",
    provenance: "A3/A4 ERC4626 sUSDS deposit routing; USDS->sUSDS protocol edge present",
    edges: [
      protocol(REAL_USDS, REAL_SUSDS, ADDR.SUSDS, "wrap", "erc4626-deposit"),
      swap(REAL_SUSDS, REAL_USDS, POOL_SUSDS_USDS_SYNTH),
    ],
    impact: { tokenIn: REAL_SUSDS, tokenOut: REAL_USDS, pool: POOL_SUSDS_USDS_SYNTH, start: REAL_USDS },
    maxHops: 2,
    expectMinPlans: 1,
  },
  {
    // run 20260701-032600: 7x no_candidate on E2a1437 (WETH/0xc470f5E6). On-chain
    // cross-ref Ppost=0 (no competitor) -> genuinely non-arbable single venue.
    // Guard: must STAY 0 (a "coverage fix" that fabricates a plan here is a regression).
    id: "single-venue-longtail",
    provenance: "run 20260701 block 25434876+ pool E2a1437 WETH/0xc470f5E6; competitor Ppost=0",
    edges: [swap(REAL_WETH, C470, POOL_E2A1437), swap(C470, REAL_WETH, POOL_E2A1437)],
    impact: { tokenIn: REAL_WETH, tokenOut: C470, pool: POOL_E2A1437, start: C470 },
    expectPlans: 0,
    expectClass: "only_immediate_same_pool_reverse",
  },
  {
    // run 9a20d602 block 25444402: impact pool 0x2a6c340b was in-graph, but
    // its same-pair alternate venue 0x49bd1fa4 (v3 fee-10000, universe score 3)
    // was below the global top-N cutoff (~11), leaving only same-pool reversal.
    id: "b2-14fee-weth-pair-gap",
    provenance: "run 9a20d602 block 25444402; universe alternate 0x49bd1fa4 score 3 < cutoff 11",
    edges: [
      swap(REAL_WETH, TOK_14FEE680, POOL_14FEE_WETH_IMPACT, "univ2-swap"),
      swap(TOK_14FEE680, REAL_WETH, POOL_14FEE_WETH_IMPACT, "univ2-swap"),
    ],
    impact: { tokenIn: REAL_WETH, tokenOut: TOK_14FEE680, pool: POOL_14FEE_WETH_IMPACT, start: REAL_WETH },
    expectPlans: 0,
    expectClass: "only_immediate_same_pool_reverse",
  },
  {
    // Same lane after pair-completion admits the below-cutoff same-pair alternate.
    // The planner should now find a cross-venue two-hop close.
    id: "b2-14fee-weth-pair-flip",
    provenance: "run 9a20d602 block 25444402; below-cutoff same-pair alternate 0x49bd1fa4 admitted",
    edges: [
      swap(REAL_WETH, TOK_14FEE680, POOL_14FEE_WETH_IMPACT, "univ2-swap"),
      swap(TOK_14FEE680, REAL_WETH, POOL_14FEE_WETH_IMPACT, "univ2-swap"),
      swap(REAL_WETH, TOK_14FEE680, POOL_14FEE_WETH_ALT),
      swap(TOK_14FEE680, REAL_WETH, POOL_14FEE_WETH_ALT),
    ],
    impact: { tokenIn: REAL_WETH, tokenOut: TOK_14FEE680, pool: POOL_14FEE_WETH_IMPACT, start: REAL_WETH },
    expectMinPlans: 1,
    expectTokenPathTokensGreaterThan: 2,
  },
  {
    // watchlist bot 0xae2Fc483 closed an OVR/WETH loop at block 25442493 through
    // pool 0x0b0d6c11, which was absent from our routing graph. With only our
    // in-graph OVR/WETH venue, the planner can only attempt same-pool reversal.
    id: "coverage-ovr-weth-gap",
    provenance: "watchlist 0xae2Fc483 tx 0x68f186f08eb61ff2d32486b66b9351f00063da4e955ccf6f3361642ccc920ead block 25442493; out-of-graph OVR/WETH pool absent",
    edges: [
      swap(REAL_WETH, OVR, POOL_OVR_WETH_INGRAPH),
      swap(OVR, REAL_WETH, POOL_OVR_WETH_INGRAPH),
    ],
    impact: { tokenIn: REAL_WETH, tokenOut: OVR, pool: POOL_OVR_WETH_INGRAPH, start: REAL_WETH },
    expectPlans: 0,
    expectClass: "only_immediate_same_pool_reverse",
  },
  {
    // Same recorded case after consuming the closable discovery-queue pool. The
    // second OVR/WETH venue lets the planner construct a cross-venue closed loop.
    id: "coverage-ovr-weth-flip",
    provenance: "watchlist 0xae2Fc483 tx 0x68f186f08eb61ff2d32486b66b9351f00063da4e955ccf6f3361642ccc920ead block 25442493; out-of-graph OVR/WETH pool covered",
    edges: [
      swap(REAL_WETH, OVR, POOL_OVR_WETH_INGRAPH),
      swap(OVR, REAL_WETH, POOL_OVR_WETH_INGRAPH),
      swap(REAL_WETH, OVR, POOL_OVR_WETH_ENQUEUED),
      swap(OVR, REAL_WETH, POOL_OVR_WETH_ENQUEUED),
    ],
    impact: { tokenIn: REAL_WETH, tokenOut: OVR, pool: POOL_OVR_WETH_INGRAPH, start: REAL_WETH },
    expectMinPlans: 1,
  },
  {
    // Block 25443539 WETH/0xff208177: documented competitor lane needs the
    // universe-loaded return venues 0x15e86e6f + 0x08650bb9. Without them, the
    // source impact pool is absent from the routing graph.
    id: "coverage-ff208177-gap",
    provenance: "block 25443539 WETH/0xff208177; universe return venues 0x15e86e6f + 0x08650bb9 absent",
    edges: [swap(TOK_FF208177, USDT, P2), swap(USDT, TOK_FF208177, P3)],
    impact: { tokenIn: REAL_WETH, tokenOut: TOK_FF208177, pool: POOL_FF208177_A, start: REAL_WETH },
    expectPlans: 0,
    expectClass: "impact_pool_not_in_routing_graph",
  },
  {
    // Same block 25443539 lane with both file-backed universe venues admitted.
    // Cross-venue WETH/0xff208177 coverage should produce at least one plan.
    id: "coverage-ff208177-flip",
    provenance: "block 25443539 WETH/0xff208177; universe return venues 0x15e86e6f + 0x08650bb9 covered",
    edges: [
      swap(REAL_WETH, TOK_FF208177, POOL_FF208177_A),
      swap(TOK_FF208177, REAL_WETH, POOL_FF208177_A),
      swap(REAL_WETH, TOK_FF208177, POOL_FF208177_B),
      swap(TOK_FF208177, REAL_WETH, POOL_FF208177_B),
    ],
    impact: { tokenIn: REAL_WETH, tokenOut: TOK_FF208177, pool: POOL_FF208177_A, start: REAL_WETH },
    expectMinPlans: 1,
  },
  {
    // run 9a20d602 block 25444461 tx 0x5610530b...d4511b7: TOK_1151/USDT pool A absent from routing graph.
    // INVALIDATED as R4 "real value" evidence (2026-07-03 manual trace, arch-review-2-verdict.md step 1c):
    // full Transfer-log trace of 0x5610530b...d4511b7 shows EOA 0x219fc40c...ec2781 spent 200 USDC and
    // received TOK_1151 only (no return leg to USDC) -- a one-way multi-route aggregator SWAP, not a
    // closed-loop arbitrage. Kept only as a coverage-mechanism (gap->flip) regression test; do NOT cite
    // as "competitor closed a real-value loop" evidence for the coverage epic decision.
    id: "r4-1151-usdt-pair-gap",
    provenance: "run 9a20d602 block 25444461 tx 0x5610530b4816cd6e405f2a5c788d13669c4fe0bc0ff0599cc0db95a88d4511b7; TOK_1151/USDT impact pool A absent from routing graph (mechanism-only fixture, NOT verified arb value)",
    edges: [swap(TOK_1151, REAL_WETH, P2), swap(REAL_WETH, TOK_1151, P3)],
    impact: { tokenIn: REAL_USDT, tokenOut: TOK_1151, pool: POOL_1151_USDT_A, start: REAL_USDT },
    expectPlans: 0,
    expectClass: "impact_pool_not_in_routing_graph",
  },
  {
    // run 9a20d602 blocks 25444461/25444621 txs 0x5610530b...d4511b7 + 0x26c6a22a...7523987: repeated TOK_1151/USDT lane covered.
    // Same invalidation as r4-1151-usdt-pair-gap above -- mechanism-only, not a verified real-value case.
    id: "r4-1151-usdt-pair-flip",
    provenance: "run 9a20d602 block 25444461 tx 0x5610530b4816cd6e405f2a5c788d13669c4fe0bc0ff0599cc0db95a88d4511b7 plus block 25444621 tx 0x26c6a22ade569e525225e6476849185889ca5665eb86e2c880b3855eb7523987; TOK_1151/USDT pools A+B covered (mechanism-only fixture, NOT verified arb value)",
    edges: [
      swap(REAL_USDT, TOK_1151, POOL_1151_USDT_A),
      swap(TOK_1151, REAL_USDT, POOL_1151_USDT_A),
      swap(REAL_USDT, TOK_1151, POOL_1151_USDT_B),
      swap(TOK_1151, REAL_USDT, POOL_1151_USDT_B),
    ],
    impact: { tokenIn: REAL_USDT, tokenOut: TOK_1151, pool: POOL_1151_USDT_A, start: REAL_USDT },
    expectMinPlans: 1,
  },
  {
    // run 20260701-t2: not_seen graph_gap -- watchlist bot arbed pool 0x874376be
    // (WETH/0x27c70cd1) which is NOT in our routing graph. FLIP TARGET: >0 once the
    // pool is covered (e.g. via the pool universe). Until then this asserts the gap.
    id: "graph-gap-pool-absent",
    provenance: "run 20260701-t2 block 25434931 pool 0x874376be WETH/0x27c70cd1; graph_gap",
    edges: [swap(TOK_874376, USDT, P2), swap(USDT, TOK_874376, P3)], // graph WITHOUT the impact pool
    impact: { tokenIn: REAL_WETH, tokenOut: TOK_874376, pool: POOL_874376, start: TOK_874376 },
    expectPlans: 0,
    expectClass: "impact_pool_not_in_routing_graph",
  },
  {
    // coffeebabe v3-fork triangle at block 25442109. The third leg is deliberately
    // absent here, pinning the missing-pool gap before the covered fixture below flips.
    id: "v3fork-triangle-gap",
    provenance: "coffeebabe 0xa3c18c97…a90d5 block 25442109; leg-3 v3-fork pool absent from graph",
    edges: [
      swap(REAL_WETH, REAL_USDC, POOL_USDC_WETH_100),
      swap(REAL_USDC, REAL_WETH, POOL_USDC_WETH_100),
      swap(REAL_USDC, REAL_USDT, POOL_USDC_USDT_100),
      swap(REAL_USDT, REAL_USDC, POOL_USDC_USDT_100),
    ],
    impact: { tokenIn: REAL_WETH, tokenOut: REAL_USDC, pool: POOL_USDC_WETH_100, start: REAL_WETH },
    maxHops: 3,
    expectPlans: 0,
    expectClass: "only_immediate_same_pool_reverse",
  },
  {
    // Same sample with the missing v3-fork WETH/USDT leg covered. This is the
    // repair-replay flip: the planner must now build at least one closed-loop plan.
    id: "v3fork-triangle-flip",
    provenance: "coffeebabe 0xa3c18c97…a90d5 block 25442109; leg-3 v3-fork pool absent from graph FLIPPED: pool covered",
    edges: [
      swap(REAL_WETH, REAL_USDC, POOL_USDC_WETH_100),
      swap(REAL_USDC, REAL_WETH, POOL_USDC_WETH_100),
      swap(REAL_USDC, REAL_USDT, POOL_USDC_USDT_100),
      swap(REAL_USDT, REAL_USDC, POOL_USDC_USDT_100),
      swap(REAL_WETH, REAL_USDT, POOL_V3FORK_WETH_USDT),
      swap(REAL_USDT, REAL_WETH, POOL_V3FORK_WETH_USDT),
    ],
    impact: { tokenIn: REAL_WETH, tokenOut: REAL_USDC, pool: POOL_USDC_WETH_100, start: REAL_WETH },
    maxHops: 3,
    expectMinPlans: 1,
  },
];

async function testRealCaseReplayFixtures(): Promise<void> {
  for (const fx of REPLAY_FIXTURES) {
    const planner = new TemplatePlanner();
    planner.setGraph(fx.edges);
    planner.setMaxHops(fx.maxHops ?? 2);
    if (fx.flashLiquidity) planner.setFlashLiquidity(fakeLiquidity(fx.flashLiquidity));
    const plans = await planner.plan(
      opportunityWithImpact(fx.impact.tokenIn, fx.impact.tokenOut, fx.impact.pool, fx.impact.start),
      fx.templates ?? [FLASH_SWAP_REPAY],
    );
    if (fx.expectMinPlans !== undefined) {
      assert(
        plans.length >= fx.expectMinPlans,
        `replay ${fx.id}: expected at least ${fx.expectMinPlans} plans, got ${plans.length}`,
      );
    } else {
      assert(fx.expectPlans !== undefined, `replay ${fx.id}: missing expectPlans`);
      assert(plans.length === fx.expectPlans, `replay ${fx.id}: expected ${fx.expectPlans} plans, got ${plans.length}`);
    }
    if (fx.expectPlans === 0 && fx.expectClass) {
      const diag = planner.lastNoCandidateDiagnostic();
      if (!diag) throw new Error(`FAIL: replay ${fx.id}: expected diagnostic`);
      assert(diag.classification === fx.expectClass, `replay ${fx.id}: class ${diag.classification} != ${fx.expectClass}`);
    }
    if (fx.expectTokenPathTokensGreaterThan !== undefined) {
      assert(
        plans.some((plan) => plan.tokenPath.edges.length + 1 > fx.expectTokenPathTokensGreaterThan!),
        `replay ${fx.id}: expected token path length > ${fx.expectTokenPathTokensGreaterThan}`,
      );
    }
    console.log(`[planner] replay fixture ${fx.id} (${fx.provenance}): PASS`);
  }
}

async function testCfgV4PoolClosesRoutingCycle(): Promise<void> {
  const backend: TokenQueryBackend = {
    async call() {
      throw new Error("CFG routing fixture should not call backend");
    },
  };
  const v3Pool: PoolEntry = {
    address: POOL_V3_WETH_CFG,
    adapter: "univ3",
    token0: REAL_WETH,
    token1: CFG,
    fee: 10000,
    tickSpacing: 200,
    score: 100,
  };
  const v4Pool: PoolEntry = {
    address: ADDR.UNISWAP_V4_POOL_MANAGER,
    adapter: "univ4",
    poolId: POOL_V4_ETH_CFG_ID,
    currency0: CFG_V4_POOL_KEY.currency0,
    currency1: CFG_V4_POOL_KEY.currency1,
    fee: CFG_V4_POOL_KEY.fee,
    tickSpacing: CFG_V4_POOL_KEY.tickSpacing,
    hooks: CFG_V4_POOL_KEY.hooks,
    fixedTokenIn: CFG_V4_POOL_KEY.currency0,
    fixedTokenOut: CFG_V4_POOL_KEY.currency1,
    score: 1,
  };

  const withoutV4 = await buildTokenGraph(backend, [v3Pool]);
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

  const withV4 = await buildTokenGraph(backend, [v3Pool, v4Pool]);
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

async function testHighSpreadUniverseSelectionReplay(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "planner-high-spread-universe-"));
  try {
    const file = join(dir, "active-pools.json");
    const filler = Array.from({ length: 1500 }, (_unused, i) => ({
      address: `0x${(0x600000 + i).toString(16).padStart(40, "0")}`,
      adapter: "univ3",
      token0: `0x${(0x700000 + i * 2).toString(16).padStart(40, "0")}`,
      token1: `0x${(0x700001 + i * 2).toString(16).padStart(40, "0")}`,
      fee: 500,
      score: 3000 - i,
    }));
    writeFileSync(file, JSON.stringify({
      pools: [
        ...filler,
        {
          address: POOL_1151_USDT_A,
          adapter: "univ3",
          token0: REAL_USDT,
          token1: TOK_1151,
          fee: 10000,
          score: 7,
          swapCount30d: 7,
        },
        {
          address: POOL_1151_USDT_B,
          adapter: "univ3",
          token0: REAL_USDT,
          token1: TOK_1151,
          fee: 10000,
          score: 9,
          swapCount30d: 9,
        },
      ],
    }));

    const oldSelected = loadPoolUniverse(file, {
      maxPools: 1500,
      minScore: 1,
      highSpreadPairQuota: 0,
    });
    assert(
      !oldSelected.some((pool) => pool.address === POOL_1151_USDT_A || pool.address === POOL_1151_USDT_B),
      "high-spread replay setup: old score-only topN should exclude both real low-score pools",
    );
    const oldPlanner = new TemplatePlanner();
    oldPlanner.setGraph(oldSelected.flatMap(poolToSwapEdges));
    oldPlanner.setMaxHops(2);
    const oldPlans = await oldPlanner.plan(
      opportunityWithImpact(REAL_USDT, TOK_1151, POOL_1151_USDT_A, REAL_USDT),
      [FLASH_SWAP_REPAY],
    );
    assert(oldPlans.length === 0, `high-spread replay before: expected 0 plans, got ${oldPlans.length}`);
    const oldDiagnostic = oldPlanner.lastNoCandidateDiagnostic();
    assert(
      oldDiagnostic?.classification === "impact_pool_not_in_routing_graph",
      `high-spread replay before: class ${oldDiagnostic?.classification}`,
    );

    const highSpreadSelected = loadPoolUniverse(file, {
      maxPools: 1500,
      minScore: 1,
      highSpreadPairQuota: 150,
      highSpreadMinFee: 10000,
    });
    const completion = selectPairCompletionPools(
      highSpreadSelected,
      loadPoolUniverse(file, { maxPools: 0, minScore: 1 }),
    );
    const completed = mergePoolRegistries(highSpreadSelected, completion);
    assert(
      completed.some((pool) => pool.address === POOL_1151_USDT_A) &&
        completed.some((pool) => pool.address === POOL_1151_USDT_B),
      "high-spread replay after: high-fee pair floor plus pair-completion should include both real pools",
    );
    const planner = new TemplatePlanner();
    planner.setGraph(completed.flatMap(poolToSwapEdges));
    planner.setMaxHops(2);
    const plans = await planner.plan(
      opportunityWithImpact(REAL_USDT, TOK_1151, POOL_1151_USDT_A, REAL_USDT),
      [FLASH_SWAP_REPAY],
    );
    assert(plans.length > 0, `high-spread replay after: expected >0 plans, got ${plans.length}`);
    console.log(
      "[planner] high-spread universe replay 0x1151/USDT: " +
        `score-only excluded->${oldPlans.length} plans, high-spread quota+pair-completion->${plans.length} plans: PASS`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  await testRealCaseReplayFixtures();
  await testCfgV4PoolClosesRoutingCycle();
  await testHighSpreadUniverseSelectionReplay();
  console.log(`planner PASS (15/15) + replay fixtures (${REPLAY_FIXTURES.length}/${REPLAY_FIXTURES.length}) + high-spread universe replay`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
