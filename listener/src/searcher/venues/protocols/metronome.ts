import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type { ExactQuoteContext, PlanBuildContext, PlanFragment, ProtocolConversionAdapter } from "../route-leg-adapter.js";
import { quoteCurvePlain } from "../swaps/curve-shared.js";
import { buildDescriptorProtocolPlan } from "./protocol-plan.js";
import {
  metronomeSynthPoolIface,
  quoteMetronomeSynthSwap,
  quoteProtocolLeg,
} from "./protocol-quote.js";

const SYNTH_TOKENS = [ADDR.MSETH, ADDR.MSBTC, ADDR.MSUSD] as const;
const synthPoolDiscoveryIface = new ethers.Interface([
  "function doesSyntheticTokenExist(address syntheticToken) view returns (bool)",
]);

export const metronomeAdapter = Object.freeze({
  id: "protocol:metronome",
  kind: "protocol-conversion",
  poolAdapters: ["metronome-synth", "metronome-hgusdc"],
  edgeAdapterIds: ["metronome-synth-swap", "metronome-hgusdc-exit"],
  allowedTaxonomy: [
    { slotKind: "protocol", protocolAction: "convert" },
    { slotKind: "protocol", protocolAction: "redeem" },
  ],
  actionAdapterIds: ["metronome-synth-swap", "metronome-hgusdc-exit", "erc20-approve", "erc20-transfer"],
  async buildEdges(pool: PoolEntry, backend: TokenQueryBackend): Promise<TokenEdge[]> {
    if (pool.adapter === "metronome-hgusdc") {
      if (!pool.fixedTokenIn || !pool.fixedTokenOut) {
        throw new Error(`metronome-hgusdc pool ${pool.address} missing fixed token metadata`);
      }
      return [{
        adapterId: "metronome-hgusdc-exit", target: pool.address,
        tokenIn: ethers.getAddress(pool.fixedTokenIn), tokenOut: ethers.getAddress(pool.fixedTokenOut),
        slotKind: "protocol", protocolAction: "redeem", score: pool.score,
        ...deriveEdgeTaxonomy("protocol", "redeem"),
      }];
    }
    const synths = await queryMetronomeSynths(backend, pool.address);
    const edges: TokenEdge[] = [];
    for (let i = 0; i < synths.length; i++) {
      for (let j = 0; j < synths.length; j++) {
        if (i === j) continue;
        edges.push({
          adapterId: "metronome-synth-swap", target: pool.address,
          tokenIn: synths[i], tokenOut: synths[j],
          slotKind: "protocol", protocolAction: "convert", score: pool.score,
          ...deriveEdgeTaxonomy("protocol", "convert"),
        });
      }
    }
    return edges;
  },
  async quoteExact(ctx: ExactQuoteContext): Promise<bigint> {
    if (!ctx.tokenIn || !ctx.tokenOut) throw new Error("metronome quote requires tokenIn/tokenOut");
    if (ctx.edgeAdapterId === "metronome-synth-swap") {
      return quoteMetronomeSynthSwap(ctx.state, ctx.target, ctx.tokenIn, ctx.tokenOut, ctx.amountIn);
    }
    let frxUsdOut: bigint;
    if (ctx.cache) {
      try {
        frxUsdOut = await ctx.cache.quoteCurve(
          ctx.state, ADDR.CURVE_MSUSD_FRXUSD, ADDR.MSUSD, ADDR.FRXUSD, ctx.amountIn,
        );
      } catch {
        frxUsdOut = await quoteCurvePlain(
          ctx.state, ADDR.CURVE_MSUSD_FRXUSD, ADDR.MSUSD, ADDR.FRXUSD, ctx.amountIn,
        );
      }
    } else {
      frxUsdOut = await quoteCurvePlain(
        ctx.state, ADDR.CURVE_MSUSD_FRXUSD, ADDR.MSUSD, ADDR.FRXUSD, ctx.amountIn,
      );
    }
    return quoteProtocolLeg(ctx.state, ADDR.HGUSDC, "erc4626-redeem", frxUsdOut);
  },
  async buildPlanFragment(ctx: PlanBuildContext): Promise<PlanFragment> {
    if (ctx.edge.adapterId === "metronome-synth-swap") {
      return buildDescriptorProtocolPlan(ctx);
    }
    return {
      requirements: [{
        kind: "transfer-to-pool",
        token: ctx.edge.tokenIn,
        pool: ADDR.CURVE_MSUSD_FRXUSD,
        amount: ctx.amountIn,
      }],
      nodes: [{
        adapterId: "metronome-hgusdc-exit", target: ctx.edge.target,
        tokenIn: ctx.edge.tokenIn, tokenOut: ctx.edge.tokenOut,
        amount: ctx.amountIn, params: {}, children: [],
      }],
    };
  },
} satisfies ProtocolConversionAdapter);

async function queryMetronomeSynths(
  backend: TokenQueryBackend,
  pool: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const synth of SYNTH_TOKENS) {
    const result = await backend.call({
      to: pool,
      data: synthPoolDiscoveryIface.encodeFunctionData("doesSyntheticTokenExist", [synth]),
    });
    if (Boolean(synthPoolDiscoveryIface.decodeFunctionResult("doesSyntheticTokenExist", result)[0])) {
      out.push(ethers.getAddress(synth));
    }
  }
  if (out.length < 2) throw new Error(`metronome synth pool ${pool} has fewer than two known synths`);
  return out;
}
