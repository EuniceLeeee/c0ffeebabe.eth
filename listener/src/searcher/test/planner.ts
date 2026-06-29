/**
 * Deterministic planner tests for live-search candidate hygiene.
 * Pure in-memory — no RPC, no anvil.
 */

import type { Opportunity } from "../detector/detector.js";
import { TemplatePlanner } from "../planner/planner.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type { FlashLiquidityView, FlashSource } from "../solver/flash-liquidity.js";
import { FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY } from "../templates/path-template.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const BEL = "0x0000000000000000000000000000000000000b01";
const USDT = "0x0000000000000000000000000000000000000dAc";
const WETH = "0x0000000000000000000000000000000000000c02";
const P1 = "0x0000000000000000000000000000000000000001";
const P2 = "0x0000000000000000000000000000000000000002";
const P3 = "0x0000000000000000000000000000000000000003";

function swap(tokenIn: string, tokenOut: string, pool: string): TokenEdge {
  return {
    adapterId: "univ3-swap",
    target: pool,
    tokenIn,
    tokenOut,
    slotKind: "swap",
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
  console.log("[planner] no borrowable cycle skips candidate: PASS");
}

async function main(): Promise<void> {
  await testPrunesSamePoolReverse();
  await testKeepsCrossVenueReverse();
  await testFlashAdaptersDoNotDuplicateQuotes();
  await testLendTemplateRequiresLendEdge();
  await testBorrowabilityRotatesIntermediateToken();
  await testBorrowabilityChoosesDeepestProvider();
  await testBorrowabilitySkipsNoBorrowableCycle();
  console.log("planner PASS (7/7)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
