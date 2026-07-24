import { ethers } from "ethers";
import type {
  PoolEntry,
  TokenEdge,
  TokenQueryBackend,
} from "../../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type {
  ExactQuoteContext,
  ProtocolConversionAdapter,
} from "../route-leg-adapter.js";
import { buildDescriptorProtocolPlan } from "./protocol-plan.js";
import { quoteSiloRedeem } from "./protocol-quote.js";
import {
  createProtocolQuoteStateCapability,
  decodeUintResult,
} from "./protocol-state-framework.js";
import {
  erc4626SiloRedeemDiscovery,
  erc4626SiloRedeemIdentityResolver,
} from "./erc4626-silo-redeem-discovery.js";

const iface = new ethers.Interface([
  "function asset() view returns (address)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
  "function previewWithdraw(uint256 assets) view returns (uint256 shares)",
]);

const pricingState = createProtocolQuoteStateCapability({
  familyId: "protocol:erc4626-silo-redeem",
  edgeAdapterIds: ["erc4626-redeem-silo"],
  buildQuoteReads(edge, amountIn) {
    return [{
      suffix: "assets",
      to: edge.target,
      data: iface.encodeFunctionData("previewRedeem", [amountIn]),
    }];
  },
  buildDependentQuoteReads(edge, _amountIn, completedRound, result) {
    if (completedRound !== 1) return [];
    const assets = decodeUintResult(iface, "previewRedeem", result("assets"));
    return [{
      suffix: "payout",
      to: edge.tokenOut,
      data: iface.encodeFunctionData("previewWithdraw", [assets]),
    }];
  },
  deriveAmountOut(_edge, _amountIn, result) {
    return decodeUintResult(iface, "previewWithdraw", result("payout"));
  },
});

export const erc4626SiloRedeemAdapter = Object.freeze({
  id: "protocol:erc4626-silo-redeem",
  kind: "protocol-conversion",
  poolAdapters: ["erc4626-silo-redeem"],
  identityPolicies: [{
    poolAdapter: "erc4626-silo-redeem",
    policy: "trusted-singleton-seed",
  }],
  declaredVenues: [],
  undeclaredVenueReason:
    "silo payout routes require address/observed provenance plus current-block behavior proof",
  discovery: erc4626SiloRedeemDiscovery,
  discoveryIdentityResolver: erc4626SiloRedeemIdentityResolver,
  discoveryIdentityAuthority: { class: "canonical-onchain", strength: 300 },
  edgeAdapterIds: ["erc4626-redeem-silo"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "redeem" }],
  requiresProtocolEdgesFlag: true,
  ownedActionAdapterIds: ["erc4626-redeem-silo"],
  requiredInfraActionAdapterIds: [],
  pricingState,
  prepared: null,

  async buildEdges(
    pool: PoolEntry,
    backend: TokenQueryBackend,
  ): Promise<TokenEdge[]> {
    if (pool.verifiedRoutes === undefined) return [];
    if (
      pool.adapter !== "erc4626-silo-redeem" ||
      pool.verifiedRoutes.length !== 1
    ) {
      throw new Error("erc4626 silo pool requires exactly one verified route");
    }
    const [route] = pool.verifiedRoutes;
    if (
      route.edgeAdapterId !== "erc4626-redeem-silo" ||
      route.tokenIn.toLowerCase() !== pool.address.toLowerCase() ||
      route.tokenOut.toLowerCase() === pool.address.toLowerCase() ||
      route.slotKind !== "protocol" ||
      route.protocolAction !== "redeem"
    ) {
      throw new Error("erc4626 silo verified route has an invalid shape");
    }
    // Re-attest the shared underlying relation. This never replaces the
    // current-block nonzero execution proof that originally admitted the edge.
    const targetAssetRaw = await backend.call({
      to: pool.address,
      data: iface.encodeFunctionData("asset"),
    });
    const payoutAssetRaw = await backend.call({
      to: route.tokenOut,
      data: iface.encodeFunctionData("asset"),
    });
    const targetAsset = ethers.getAddress(
      String(iface.decodeFunctionResult("asset", targetAssetRaw)[0]),
    );
    const payoutAsset = ethers.getAddress(
      String(iface.decodeFunctionResult("asset", payoutAssetRaw)[0]),
    );
    if (targetAsset.toLowerCase() !== payoutAsset.toLowerCase()) {
      throw new Error("erc4626 silo payout-token asset relation drifted");
    }
    return [{
      adapterId: "erc4626-redeem-silo",
      target: ethers.getAddress(pool.address),
      tokenIn: ethers.getAddress(pool.address),
      tokenOut: ethers.getAddress(route.tokenOut),
      slotKind: "protocol",
      protocolAction: "redeem",
      score: pool.score,
      ...deriveEdgeTaxonomy("protocol", "redeem"),
    }];
  },

  async quoteExact(ctx: ExactQuoteContext): Promise<bigint> {
    if (!ctx.tokenOut) {
      throw new Error("erc4626 silo quote requires the proven payout token");
    }
    return quoteSiloRedeem(ctx.state, ctx.target, ctx.tokenOut, ctx.amountIn);
  },

  async buildPlanFragment(ctx) {
    return buildDescriptorProtocolPlan(ctx);
  },
} satisfies ProtocolConversionAdapter);
