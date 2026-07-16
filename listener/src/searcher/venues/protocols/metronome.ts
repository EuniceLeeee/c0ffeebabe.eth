import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type {
  ExactQuoteContext,
  PlanBuildContext,
  PlanFragment,
  PreparedRouteContext,
  ProtocolConversionAdapter,
} from "../route-leg-adapter.js";
import { readProtocolExternalMid } from "../mid-readers.js";
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

export const metronomeSynthAdapter = Object.freeze({
  id: "protocol:metronome-synth",
  kind: "protocol-conversion",
  poolAdapters: ["metronome-synth"],
  edgeAdapterIds: ["metronome-synth-swap"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
  requiresProtocolEdgesFlag: true,
  actionAdapterIds: ["metronome-synth-swap", "erc20-approve"],
  readMid: readProtocolExternalMid,
  warm: { kind: "protocol-mid", priority: 1 },
  prepared: {
    quote: async (ctx: PreparedRouteContext) => {
      const quoted = await ctx.callPrepared(
        ctx.request.target,
        metronomeSynthPoolIface.encodeFunctionData("quoteSwapOut", [
          ctx.request.tokenIn,
          ctx.request.tokenOut,
          ctx.request.amountIn,
        ]),
        { gasLimit: 1_000_000 },
      );
      return {
        amountOut: BigInt(
          metronomeSynthPoolIface.decodeFunctionResult("quoteSwapOut", quoted.output)[0],
        ),
        latencyMs: quoted.latencyMs,
        cacheStats: quoted.cacheStats,
      };
    },
    quoteUnsupportedReason: null,
    encodeQuotePrewarm: async (ctx: PreparedRouteContext) => [{
      from: ethers.ZeroAddress,
      to: ctx.request.target,
      calldata: metronomeSynthPoolIface.encodeFunctionData("quoteSwapOut", [
        ctx.request.tokenIn,
        ctx.request.tokenOut,
        ctx.request.amountIn,
      ]),
      gasLimit: 1_000_000,
    }],
    allowanceSpender: (request) => ethers.getAddress(request.target),
    prewarmAddresses: () => [],
  },
  async buildEdges(pool: PoolEntry, backend: TokenQueryBackend): Promise<TokenEdge[]> {
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
    return quoteMetronomeSynthSwap(ctx.state, ctx.target, ctx.tokenIn, ctx.tokenOut, ctx.amountIn);
  },
  buildPlanFragment: buildDescriptorProtocolPlan,
} satisfies ProtocolConversionAdapter);

export const metronomeHgusdcAdapter = Object.freeze({
  id: "protocol:metronome-hgusdc",
  kind: "protocol-conversion",
  poolAdapters: ["metronome-hgusdc"],
  edgeAdapterIds: ["metronome-hgusdc-exit"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "redeem" }],
  requiresProtocolEdgesFlag: true,
  actionAdapterIds: ["metronome-hgusdc-exit", "erc20-transfer"],
  readMid: readProtocolExternalMid,
  warm: { kind: "protocol-mid", priority: 1 },
  prepared: null,
  async buildEdges(pool: PoolEntry, _backend: TokenQueryBackend): Promise<TokenEdge[]> {
    if (!pool.fixedTokenIn || !pool.fixedTokenOut) {
      throw new Error(`metronome-hgusdc pool ${pool.address} missing fixed token metadata`);
    }
    return [{
      adapterId: "metronome-hgusdc-exit", target: pool.address,
      tokenIn: ethers.getAddress(pool.fixedTokenIn), tokenOut: ethers.getAddress(pool.fixedTokenOut),
      slotKind: "protocol", protocolAction: "redeem", score: pool.score,
      ...deriveEdgeTaxonomy("protocol", "redeem"),
    }];
  },
  async quoteExact(ctx: ExactQuoteContext): Promise<bigint> {
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
