// BS-3a gate: the solver resolves a block-scan plan's search center from the scanner's
// searchSeed (in flashToken units) — NOT the victim-amount / 1n-dust path. The 1n dust-grid
// failure mode (the verified landing blocker) stays dead for block-scan.
import { TemplatePlanner } from "../planner/planner.js";
import { resolveSearchCenter } from "../solver/solver.js";
import { FLASH_SWAP_REPAY } from "../templates/path-template.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import { canonicalTokenRing, cycleFingerprint } from "../detector/cycle-fingerprint.js";
import { ADDR } from "../../shared/constants/addresses.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type { BlockScanOpportunity } from "../detector/detector.js";
import type { StateBackend } from "../../shared/state/state-backend.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function swap(tokenIn: string, tokenOut: string, pool: string): TokenEdge {
  return {
    adapterId: "univ3-swap",
    target: pool,
    tokenIn,
    tokenOut,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
    score: 100,
  };
}

const WETH = ADDR.WETH;
const TOK = "0x27c70cd1946795b66be9d954418546998b546634";
const POOL_A = "0x0000000000000000000000000000000000000b51";
const POOL_B = "0x0000000000000000000000000000000000000b52";

async function main(): Promise<void> {
  const seedEdges = [swap(WETH, TOK, POOL_A), swap(TOK, WETH, POOL_B)];
  const sourceBlock = 25455296;
  const ring = [WETH, TOK];
  const opp: BlockScanOpportunity = {
    kind: "block-scan-arb",
    sourceBlock,
    stateBlock: sourceBlock,
    cycleId: canonicalTokenRing(ring).join("|"),
    cycleFingerprint: cycleFingerprint(sourceBlock, ring),
    seedEdges,
    flashToken: WETH,
    searchSeed: { startToken: WETH, searchCenter: 4_242n, maxInput: 1_000_000n },
    leavesStandingPosition: false,
  };

  const planner = new TemplatePlanner();
  planner.setGraph(seedEdges);
  const plans = await planner.plan(opp, [FLASH_SWAP_REPAY]);
  assert(plans.length >= 1, `expected a block-scan plan, got ${plans.length}`);

  // resolveSearchCenter returns EARLY for block-scan (before touching state/options),
  // so a stub state is sufficient — that early return is exactly what this asserts.
  const stubState = {} as unknown as StateBackend;
  const center = await resolveSearchCenter(plans[0], WETH, stubState, {});
  assert(center === 4_242n, `expected searchCenter 4242 from searchSeed, got ${center}`);
  console.log("[blockscan-solver-center] center comes from searchSeed.searchCenter: PASS");

  assert(center > 8n, `center must be > 8n (the 1n dust fallback stays dead), got ${center}`);
  console.log("[blockscan-solver-center] no 1n dust fallback for block-scan: PASS");

  console.log("blockscan-solver-center PASS (2/2)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
