/**
 * Deterministic planner tests for live-search candidate hygiene.
 * Pure in-memory — no RPC, no anvil.
 */

import type { Opportunity } from "../detector/detector.js";
import { TemplatePlanner } from "../planner/planner.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY } from "../templates/path-template.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const P1 = "0x0000000000000000000000000000000000000001";
const P2 = "0x0000000000000000000000000000000000000002";

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

async function main(): Promise<void> {
  await testPrunesSamePoolReverse();
  await testKeepsCrossVenueReverse();
  await testFlashAdaptersDoNotDuplicateQuotes();
  await testLendTemplateRequiresLendEdge();
  console.log("planner PASS (4/4)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
