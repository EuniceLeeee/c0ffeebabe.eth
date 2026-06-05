import { ADDR } from "../../shared/constants/addresses.js";
import { DEFAULT_SEARCHER_EXECUTOR } from "../../shared/executor/botvm-executor.js";
import type { ResolvedPlanNode } from "../../shared/types/plan.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { CandidatePlan } from "../planner/planner.js";
import { candidateFlashAmounts, estimateFlashBounds } from "./amount-bounds.js";
import { captureDynamicAmounts } from "./capture-engine.js";
import { assertNoUnresolvedAmounts, deriveAmounts, type ModeBAmounts } from "./quote-engine.js";

export interface ResolvedPlan {
  root: ResolvedPlanNode;
  netProfit: bigint;
  profitToken: string;
  flashAmount: bigint;
}

export interface SolverProbe {
  simulate(plan: ResolvedPlan): Promise<{ success: boolean; netProfit: bigint; revertReason?: string }>;
}

export interface Solver {
  solve(plan: CandidatePlan, state: StateBackend, probe: SolverProbe): Promise<ResolvedPlan>;
}

const MIN_SQRT_PRICE = 4295128740n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970341n;
const MAX_UINT = (1n << 256n) - 1n;

export class AnvilSolver implements Solver {
  async solve(plan: CandidatePlan, state: StateBackend, probe: SolverProbe): Promise<ResolvedPlan> {
    let best: ResolvedPlan | null = null;
    let lastFailure = "no candidates simulated";
    const [low, high] = estimateFlashBounds(plan.opportunity.victimAmountIn);

    for (const flashAmount of candidateFlashAmounts(low, high)) {
      console.log(`[searcher/ac3] solver: try flashAmount=${flashAmount}`);
      let amounts: ModeBAmounts;
      try {
        amounts = await captureDynamicAmounts(state, deriveAmounts(plan, flashAmount));
      } catch (err) {
        lastFailure = err instanceof Error ? err.message : String(err);
        console.log(`[searcher/ac3] solver: capture rejected ${flashAmount}: ${lastFailure.slice(0, 160)}`);
        continue;
      }
      const resolved: ResolvedPlan = {
        root: buildResolvedWstUsrPlan(amounts),
        netProfit: 0n,
        profitToken: plan.opportunity.profitToken,
        flashAmount,
      };
      assertNoUnresolvedAmounts(resolved.root);

      const sim = await probe.simulate(resolved);
      if (!sim.success) {
        lastFailure = sim.revertReason ?? "simulation failed";
        console.log(`[searcher/ac3] solver: rejected ${flashAmount}: ${lastFailure.slice(0, 160)}`);
        continue;
      }
      const scored = { ...resolved, netProfit: sim.netProfit };
      console.log(`[searcher/ac3] solver: accepted ${flashAmount} netProfit=${sim.netProfit}`);
      if (!best || scored.netProfit > best.netProfit) best = scored;
    }

    if (!best) throw new Error(`no profitable resolved plan: ${lastFailure}`);
    return best;
  }
}

function buildResolvedWstUsrPlan(a: ModeBAmounts): ResolvedPlanNode {
  const half = a.flashAmount / 2n;
  const otherHalf = a.flashAmount - half;
  const totalDebt = a.debtAmount1 + a.debtAmount2;

  const v3PayUsdt: ResolvedPlanNode = {
    adapterId: "erc20-transfer",
    target: ADDR.USDT,
    tokenIn: ADDR.USDT,
    tokenOut: ADDR.USDT,
    amount: a.v4TakeAmount,
    params: { to: ADDR.UNISWAP_V3_USDT_WETH, amount: a.v4TakeAmount },
    children: [],
  };

  const curveChain: ResolvedPlanNode[] = [
    {
      adapterId: "erc20-transfer",
      target: ADDR.USDT,
      tokenIn: ADDR.USDT,
      tokenOut: ADDR.USDT,
      amount: a.usdtReceived,
      params: { to: ADDR.CURVE_SUSDS_USDT, amount: a.usdtReceived },
      children: [],
    },
    {
      adapterId: "curve-exchange",
      target: ADDR.CURVE_SUSDS_USDT,
      tokenIn: ADDR.USDT,
      tokenOut: ADDR.SUSDS,
      amount: a.usdtReceived,
      params: { i: 1n, j: 0n, minDy: 0n, receiver: ADDR.CURVE_DOLA_SUSDS },
      children: [],
    },
    {
      adapterId: "curve-exchange",
      target: ADDR.CURVE_DOLA_SUSDS,
      tokenIn: ADDR.SUSDS,
      tokenOut: ADDR.DOLA,
      amount: a.susdsOut,
      params: { i: 1n, j: 0n, minDy: 0n, receiver: DEFAULT_SEARCHER_EXECUTOR },
      children: [],
    },
    {
      adapterId: "erc20-transfer",
      target: ADDR.DOLA,
      tokenIn: ADDR.DOLA,
      tokenOut: ADDR.DOLA,
      amount: a.dolaAmount,
      params: { to: ADDR.CURVE_DOLA_WSTUSR, amount: a.dolaAmount },
      children: [],
    },
    {
      adapterId: "curve-exchange-nr",
      target: ADDR.CURVE_DOLA_WSTUSR,
      tokenIn: ADDR.DOLA,
      tokenOut: ADDR.WSTUSR,
      amount: a.dolaAmount,
      params: { i: 0n, j: 1n, minDy: 0n },
      children: [],
    },
    {
      adapterId: "erc20-transfer",
      target: ADDR.WETH,
      tokenIn: ADDR.WETH,
      tokenOut: ADDR.WETH,
      amount: a.wethOwed,
      params: { to: ADDR.UNISWAP_V3_USDT_WETH, amount: a.wethOwed },
      children: [],
    },
  ];

  const v3InsideV4: ResolvedPlanNode = {
    adapterId: "univ3-swap",
    target: ADDR.UNISWAP_V3_USDT_WETH,
    tokenIn: ADDR.USDT,
    tokenOut: ADDR.WETH,
    amount: a.v4TakeAmount,
    params: {
      zeroForOne: false,
      amountSpecified: a.v4TakeAmount,
      sqrtPriceLimit: MAX_SQRT_PRICE,
    },
    children: [v3PayUsdt],
  };

  const v4Unlock: ResolvedPlanNode = {
    adapterId: "univ4-unlock",
    target: ADDR.UNISWAP_V4_POOL_MANAGER,
    tokenIn: ADDR.DAI,
    tokenOut: ADDR.USDT,
    amount: 0n,
    params: {},
    children: [
      {
        adapterId: "univ4-swap",
        target: ADDR.UNISWAP_V4_POOL_MANAGER,
        tokenIn: ADDR.DAI,
        tokenOut: ADDR.USDT,
        amount: a.daiAmount,
        params: {
          currency0: ADDR.DAI,
          currency1: ADDR.USDT,
          fee: 68n,
          tickSpacing: 1n,
          hooks: ADDR.ZERO,
          zeroForOne: true,
          amountSpecified: -a.daiAmount,
          sqrtPriceLimit: MIN_SQRT_PRICE,
        },
        children: [],
      },
      {
        adapterId: "univ4-take",
        target: ADDR.UNISWAP_V4_POOL_MANAGER,
        tokenIn: "",
        tokenOut: ADDR.USDT,
        amount: a.v4TakeAmount,
        params: { currency: ADDR.USDT },
        children: [],
      },
      v3InsideV4,
      {
        adapterId: "univ4-sync",
        target: ADDR.UNISWAP_V4_POOL_MANAGER,
        tokenIn: ADDR.DAI,
        tokenOut: "",
        amount: 0n,
        params: { currency: ADDR.DAI },
        children: [],
      },
      {
        adapterId: "erc20-transfer",
        target: ADDR.DAI,
        tokenIn: ADDR.DAI,
        tokenOut: ADDR.DAI,
        amount: a.daiAmount,
        params: { to: ADDR.UNISWAP_V4_POOL_MANAGER, amount: a.daiAmount },
        children: [],
      },
      {
        adapterId: "univ4-settle",
        target: ADDR.UNISWAP_V4_POOL_MANAGER,
        tokenIn: "",
        tokenOut: "",
        amount: 0n,
        params: {},
        children: [],
      },
    ],
  };

  const v3Phase2: ResolvedPlanNode = {
    adapterId: "univ3-swap",
    target: ADDR.UNISWAP_V3_USDT_WETH,
    tokenIn: ADDR.WETH,
    tokenOut: ADDR.USDT,
    amount: a.v3ExactOutput,
    params: {
      zeroForOne: true,
      amountSpecified: -a.v3ExactOutput,
      sqrtPriceLimit: MIN_SQRT_PRICE,
    },
    children: curveChain,
  };

  return {
    adapterId: "morpho-flash",
    target: ADDR.MORPHO,
    tokenIn: ADDR.WSTUSR,
    tokenOut: ADDR.WSTUSR,
    amount: a.flashAmount,
    params: {},
    children: [
      {
        adapterId: "erc20-approve",
        target: ADDR.WSTUSR,
        tokenIn: ADDR.WSTUSR,
        tokenOut: ADDR.WSTUSR,
        amount: a.flashAmount,
        params: { spender: ADDR.FLUID_VAULT_WSTUSR_USDC, amount: a.flashAmount },
        children: [],
      },
      {
        adapterId: "erc20-approve",
        target: ADDR.USDC,
        tokenIn: ADDR.USDC,
        tokenOut: ADDR.USDC,
        amount: MAX_UINT,
        params: { spender: ADDR.SKY_PSM_LITE, amount: MAX_UINT },
        children: [],
      },
      {
        adapterId: "fluid-vault",
        target: ADDR.FLUID_VAULT_WSTUSR_USDC,
        tokenIn: ADDR.WSTUSR,
        tokenOut: ADDR.USDC,
        amount: half,
        params: { nftId: 0n, collateralDelta: half, debtDelta: a.debtAmount1 },
        children: [],
      },
      {
        adapterId: "fluid-vault",
        target: ADDR.FLUID_VAULT_WSTUSR_USDC,
        tokenIn: ADDR.WSTUSR,
        tokenOut: ADDR.USDC,
        amount: otherHalf,
        params: { nftId: 0n, collateralDelta: otherHalf, debtDelta: a.debtAmount2 },
        children: [],
      },
      {
        adapterId: "psm",
        target: ADDR.SKY_PSM_LITE,
        tokenIn: ADDR.USDC,
        tokenOut: ADDR.DAI,
        amount: totalDebt,
        params: {},
        children: [],
      },
      v4Unlock,
      v3Phase2,
      {
        adapterId: "assert-balance",
        target: ADDR.WSTUSR,
        tokenIn: ADDR.WSTUSR,
        tokenOut: ADDR.WSTUSR,
        amount: a.flashAmount + a.minProfit,
        params: {},
        children: [],
      },
      {
        adapterId: "erc20-approve",
        target: ADDR.WSTUSR,
        tokenIn: ADDR.WSTUSR,
        tokenOut: ADDR.WSTUSR,
        amount: a.flashAmount,
        params: { spender: ADDR.MORPHO, amount: a.flashAmount },
        children: [],
      },
    ],
  };
}
