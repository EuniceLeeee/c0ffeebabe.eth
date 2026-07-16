import { ADDR } from "../../shared/constants/addresses.js";
import { evaluateEv } from "../ev-evaluator.js";
import { TemplatePlanner } from "../planner/planner.js";
import {
  createProfitTokenValuation,
  DEFAULT_PROFIT_TOKEN_VALUATION,
} from "../profit-token-valuation.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import type { FlashLiquidityView, FlashSource } from "../solver/flash-liquidity.js";
import { FLASH_SWAP_REPAY } from "../templates/path-template.js";

const LONGTAIL = "0x0000000000000000000000000000000000000b01";
const MID = "0x0000000000000000000000000000000000000dac";
const P1 = "0x0000000000000000000000000000000000000001";
const P2 = "0x0000000000000000000000000000000000000002";
const P3 = "0x0000000000000000000000000000000000000003";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function edge(tokenIn: string, tokenOut: string, target: string) {
  return {
    adapterId: "univ3-swap",
    target,
    tokenIn,
    tokenOut,
    slotKind: "swap" as const,
    ...deriveEdgeTaxonomy("swap"),
    score: 100,
  };
}

function opportunity() {
  return {
    kind: "backrun-arb" as const,
    victimTxHash: "0xprofit-token-valuation",
    blockNumber: 1,
    affectedPools: [P1],
    affectedTokens: [MID, LONGTAIL],
    startToken: LONGTAIL,
    profitToken: LONGTAIL,
    victimAmountIn: 1n,
    victimEffect: {
      kind: "swap" as const,
      impact: {
        pool: P1,
        tokenIn: MID,
        tokenOut: LONGTAIL,
        amountIn: 1n,
        matchedAdapterId: "univ3-swap",
      },
    },
    hints: {},
  };
}

function liquidity(entries: Array<[string, bigint]>): FlashLiquidityView {
  const byToken = new Map(entries.map(([token, amount]) => [token.toLowerCase(), amount]));
  return {
    borrowable(token: string): bigint {
      return byToken.get(token.toLowerCase()) ?? 0n;
    },
    source(token: string): FlashSource | null {
      const amount = byToken.get(token.toLowerCase()) ?? 0n;
      return amount > 0n ? { amount, adapterId: "balancer-flash" } : null;
    },
  };
}

function planner(view = DEFAULT_PROFIT_TOKEN_VALUATION): TemplatePlanner {
  const instance = new TemplatePlanner();
  instance.setGraph([
    edge(LONGTAIL, MID, P1),
    edge(MID, ADDR.WETH, P2),
    edge(ADDR.WETH, LONGTAIL, P3),
  ]);
  instance.setMaxHops(3);
  instance.setProfitTokenValuation(view);
  return instance;
}

async function main(): Promise<void> {
  const unpriceable = planner();
  unpriceable.setFlashLiquidity(liquidity([[LONGTAIL, 1_000_000n]]));
  const rejected = await unpriceable.plan(opportunity(), [FLASH_SWAP_REPAY]);
  assert(rejected.length === 0, `unpriceable token emitted ${rejected.length} plans`);
  assert(
    unpriceable.lastNoCandidateDiagnostic()?.classification === "unpriceable_profit_token",
    `unexpected classification ${unpriceable.lastNoCandidateDiagnostic()?.classification}`,
  );
  assert(
    unpriceable.lastNoCandidateDiagnostic()?.unpriceable_profit_tokens.includes(LONGTAIL.toLowerCase()) ?? false,
    "diagnostic did not identify the unpriceable token",
  );
  console.log("[profit-token-valuation] unpriceable borrowable token rejects before solve: PASS");

  const valuedView = createProfitTokenValuation([{
    token: LONGTAIL,
    decimals: 8,
    kind: "eth-fixed",
    weiPerToken: 15n * 10n ** 18n,
  }]);
  const valued = planner(valuedView);
  valued.setFlashLiquidity(liquidity([[LONGTAIL, 1_000_000n]]));
  const admitted = await valued.plan(opportunity(), [FLASH_SWAP_REPAY]);
  assert(admitted.length === 1, `valued token emitted ${admitted.length} plans`);
  assert(admitted[0].opportunity.profitToken === LONGTAIL, "valued longtail token not selected");

  let baseFeeReads = 0;
  const provider = {
    async getBlock(_tag: "latest") {
      baseFeeReads++;
      return { baseFeePerGas: 20n };
    },
  };
  const ev = await evaluateEv(
    provider,
    LONGTAIL,
    100_000_000n,
    100n,
    {
      ethUsd: 3_500,
      profitHaircutBps: 0,
      defaultGasUsed: 100,
      gasBufferMultX10: 10,
      evGate: true,
      bribeAllAboveGas: false,
      bribeBps: 5_000,
    },
    valuedView,
  );
  assert(ev.valuationAvailable, "custom valued token reported unavailable");
  assert(ev.rawProfitEth === 15n * 10n ** 18n, `raw valuation ${ev.rawProfitEth}`);
  assert(ev.netEvWei > 0n, `valued token net EV ${ev.netEvWei}`);
  assert(baseFeeReads === 1, `valued token base-fee reads ${baseFeeReads}`);
  console.log("[profit-token-valuation] borrowable + valued longtail token passes EV: PASS");

  const deepestUnpriceable = planner();
  deepestUnpriceable.setMaxRotationsPerPath(1);
  deepestUnpriceable.setFlashLiquidity(liquidity([
    [LONGTAIL, 10_000_000n],
    [ADDR.WETH, 1_000_000n],
  ]));
  const fallback = await deepestUnpriceable.plan(opportunity(), [FLASH_SWAP_REPAY]);
  assert(fallback.length === 1, `priceable fallback emitted ${fallback.length} plans`);
  assert(
    fallback[0].opportunity.profitToken.toLowerCase() === ADDR.WETH.toLowerCase(),
    `unpriceable depth crowded out WETH: ${fallback[0].opportunity.profitToken}`,
  );
  console.log("[profit-token-valuation] priceability filters before depth top-N: PASS");

  console.log("profit-token-valuation PASS (3/3)");
}

await main();
