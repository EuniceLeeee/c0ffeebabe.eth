import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type {
  CompatRouteLegAdapter,
  ExactQuoteContext,
  PlanBuildContext,
  PlanFragment,
} from "../route-leg-adapter.js";

const MAX_UINT = (1n << 256n) - 1n;

/**
 * Legacy credit leg retained for diagnostic/planner equivalence only. Its
 * standing-position taxonomy keeps production submission fail-closed unless
 * the existing explicit credit-live marker authorizes it.
 */
export const fluidCreditCompatAdapter = Object.freeze({
  id: "compat:fluid-credit",
  kind: "compat",
  poolAdapters: ["fluid-vault"],
  edgeAdapterIds: ["fluid-vault"],
  allowedTaxonomy: [{ slotKind: "lend" }],
  actionAdapterIds: ["fluid-vault", "erc20-approve"],
  async buildEdges(pool: PoolEntry, _backend: TokenQueryBackend): Promise<TokenEdge[]> {
    if (!pool.fixedTokenIn || !pool.fixedTokenOut) {
      throw new Error(`fluid-vault pool ${pool.address} missing fixedTokenIn/Out`);
    }
    return [{
      adapterId: "fluid-vault",
      target: pool.address,
      tokenIn: pool.fixedTokenIn,
      tokenOut: pool.fixedTokenOut,
      slotKind: "lend",
      score: pool.score,
      ...deriveEdgeTaxonomy("lend"),
    }];
  },
  async quoteExact(_ctx: ExactQuoteContext): Promise<bigint> {
    throw new Error("unsupported exact quote: fluid-vault requires solver debt search");
  },
  async buildPlanFragment(ctx: PlanBuildContext): Promise<PlanFragment> {
    const { edge, amountIn, amountOut } = ctx;
    return {
      requirements: [{ kind: "approve", token: edge.tokenIn, spender: edge.target, amount: MAX_UINT }],
      nodes: [{
        adapterId: "fluid-vault",
        target: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
        amount: amountIn,
        params: { nftId: 0n, collateralDelta: amountIn, debtDelta: amountOut },
        children: [],
      }],
    };
  },
} satisfies CompatRouteLegAdapter);
