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
import { quotePSM } from "./protocol-quote.js";
import { createProtocolQuoteStateCapability } from "./protocol-state-framework.js";

const MAX_UINT = (1n << 256n) - 1n;
const PSM_WAD = 10n ** 18n;
const PSM_TO_18 = 10n ** 12n;
const litePsmIface = new ethers.Interface([
  "function gem() view returns (address)",
  "function dai() view returns (address)",
  "function tin() view returns (uint256)",
  "function tout() view returns (uint256)",
]);

const psmPricingState = createProtocolQuoteStateCapability({
  familyId: "protocol:psm",
  edgeAdapterIds: ["psm"],
  buildQuoteReads(edge) {
    const functionName = psmDirection(edge.tokenIn, edge.tokenOut) === "sell"
      ? "tin"
      : "tout";
    return [{
      suffix: functionName,
      to: edge.target,
      data: litePsmIface.encodeFunctionData(functionName),
    }];
  },
  deriveAmountOut(edge, amountIn, result) {
    const direction = psmDirection(edge.tokenIn, edge.tokenOut);
    const functionName = direction === "sell" ? "tin" : "tout";
    const fee = BigInt(
      litePsmIface.decodeFunctionResult(functionName, result(functionName))[0],
    );
    if (fee < 0n || fee > PSM_WAD) {
      throw new Error(`PSM ${functionName} returned invalid fee ${fee}`);
    }
    if (direction === "sell") {
      const gemAmount18 = amountIn * PSM_TO_18;
      return gemAmount18 - gemAmount18 * fee / PSM_WAD;
    }
    return (amountIn * PSM_WAD / (PSM_WAD + fee)) / PSM_TO_18;
  },
});

export const psmAdapter = Object.freeze({
  id: "protocol:psm",
  kind: "protocol-conversion",
  poolAdapters: ["psm"],
  identityPolicies: [{ poolAdapter: "psm", policy: "trusted-singleton-seed" }],
  declaredVenues: [{
    address: ADDR.SKY_PSM_LITE,
    adapter: "psm",
    fixedTokenIn: ADDR.USDC,
    fixedTokenOut: ADDR.DAI,
    fixedSlotKind: "protocol",
    fixedProtocolAction: "convert",
  }],
  undeclaredVenueReason: null,
  edgeAdapterIds: ["psm"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
  requiresProtocolEdgesFlag: false,
  ownedActionAdapterIds: ["psm"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  pricingState: psmPricingState,
  prepared: {
    quote: async (ctx: PreparedRouteContext) => ({
      amountOut: quotePreparedPSM(
        ctx.request.tokenIn,
        ctx.request.tokenOut,
        ctx.request.amountIn,
      ),
      latencyMs: 0,
    }),
    quoteUnsupportedReason: null,
    encodeQuotePrewarm: async () => [],
    allowanceSpender: () => null,
    prewarmAddresses: () => [ADDR.SKY_PSM_LITE],
  },
  async buildEdges(pool: PoolEntry, backend: TokenQueryBackend): Promise<TokenEdge[]> {
    if (!pool.fixedTokenIn || !pool.fixedTokenOut) {
      throw new Error(`psm pool ${pool.address} missing fixedTokenIn/Out`);
    }
    // LitePSM publishes its pair as immutables; the declared pair must match them.
    const [gemRaw, daiRaw] = await Promise.all([
      backend.call({ to: pool.address, data: litePsmIface.encodeFunctionData("gem") }),
      backend.call({ to: pool.address, data: litePsmIface.encodeFunctionData("dai") }),
    ]);
    for (const [fn, raw, expected] of [
      ["gem", gemRaw, pool.fixedTokenIn],
      ["dai", daiRaw, pool.fixedTokenOut],
    ] as const) {
      const reported = String(litePsmIface.decodeFunctionResult(fn, raw)[0]);
      if (reported.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`psm identity attestation failed: ${pool.address} reports ${fn}() ${reported}`);
      }
    }
    return [{
      adapterId: "psm", target: pool.address,
      tokenIn: pool.fixedTokenIn, tokenOut: pool.fixedTokenOut,
      slotKind: "protocol", protocolAction: "convert", score: pool.score,
      ...deriveEdgeTaxonomy("protocol", "convert"),
    }];
  },
  async quoteExact(ctx: ExactQuoteContext): Promise<bigint> {
    if (!ctx.tokenIn || !ctx.tokenOut) throw new Error("psm quote requires tokenIn/tokenOut");
    return quotePSM(ctx.state, ctx.target, ctx.tokenIn, ctx.tokenOut, ctx.amountIn);
  },
  async buildPlanFragment(ctx: PlanBuildContext): Promise<PlanFragment> {
    const { edge, amountIn, amountOut } = ctx;
    const gemAmount = edge.tokenIn.toLowerCase() === ADDR.USDC.toLowerCase() ? amountIn : amountOut;
    return {
      requirements: [{ kind: "approve", token: edge.tokenIn, spender: edge.target, amount: MAX_UINT }],
      nodes: [{
        adapterId: "psm", target: edge.target,
        tokenIn: edge.tokenIn, tokenOut: edge.tokenOut,
        amount: gemAmount, params: {}, children: [],
      }],
    };
  },
} satisfies ProtocolConversionAdapter);

function quotePreparedPSM(tokenIn: string, tokenOut: string, amountIn: bigint): bigint {
  const usdc = ADDR.USDC.toLowerCase();
  const dai = ADDR.DAI.toLowerCase();
  const tIn = tokenIn.toLowerCase();
  const tOut = tokenOut.toLowerCase();
  if (tIn === usdc && tOut === dai) return amountIn * 10n ** 12n;
  if (tIn === dai && tOut === usdc) return amountIn / 10n ** 12n;
  throw new Error(`PSM only supports USDC<->DAI, got ${tokenIn} -> ${tokenOut}`);
}

function psmDirection(tokenIn: string, tokenOut: string): "sell" | "buy" {
  const tIn = tokenIn.toLowerCase();
  const tOut = tokenOut.toLowerCase();
  if (tIn === ADDR.USDC.toLowerCase() && tOut === ADDR.DAI.toLowerCase()) return "sell";
  if (tIn === ADDR.DAI.toLowerCase() && tOut === ADDR.USDC.toLowerCase()) return "buy";
  throw new Error(`PSM only supports USDC<->DAI, got ${tokenIn} -> ${tokenOut}`);
}
