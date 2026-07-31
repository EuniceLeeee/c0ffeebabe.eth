import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
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
import { createProtocolQuoteStateCapability } from "./protocol-state-framework.js";
import {
  ETHERTOKEN_NATIVE_REDEEM_EDGE_ADAPTER,
  ETHERTOKEN_NATIVE_REDEEM_IDENTITY_SOURCE,
  ETHERTOKEN_NATIVE_REDEEM_POOL_ADAPTER,
  ETHERTOKEN_NATIVE_REDEEM_VENUE,
  etherTokenNativeRedeemDiscovery,
  etherTokenNativeRedeemIdentityResolver,
  etherTokenNativeRedeemInstanceId,
} from "./ethertoken-native-redeem-discovery.js";

const FAMILY_ID = "protocol:ethertoken-native-redeem" as const;
const iface = new ethers.Interface([
  "function totalSupply() view returns (uint256)",
  "function withdraw(uint256 amount)",
]);

const pricingState = createProtocolQuoteStateCapability({
  familyId: FAMILY_ID,
  edgeAdapterIds: [ETHERTOKEN_NATIVE_REDEEM_EDGE_ADAPTER],
  buildQuoteReads(edge) {
    requireOwnedEdge(edge);
    return [{
      suffix: "total-supply",
      to: edge.target,
      data: iface.encodeFunctionData("totalSupply"),
    }];
  },
  deriveAmountOut(edge, amountIn, result) {
    requireOwnedEdge(edge);
    const totalSupply = BigInt(
      iface.decodeFunctionResult("totalSupply", result("total-supply"))[0],
    );
    if (totalSupply < amountIn) {
      throw new Error(
        "ethertoken-native-redeem current supply is below the pricing probe",
      );
    }
    // Active admission proves this execution family spends and burns exactly
    // amountIn and pays the same native amount. Exact route quotes still
    // re-simulate the concrete solver amount below.
    return amountIn;
  },
});

export const etherTokenNativeRedeemAdapter = Object.freeze({
  id: FAMILY_ID,
  kind: "protocol-conversion",
  poolAdapters: [ETHERTOKEN_NATIVE_REDEEM_POOL_ADAPTER],
  identityPolicies: [{
    poolAdapter: ETHERTOKEN_NATIVE_REDEEM_POOL_ADAPTER,
    policy: "trusted-singleton-seed",
    registeredVenueIds: [ETHERTOKEN_NATIVE_REDEEM_VENUE],
    registeredIdentitySources: [ETHERTOKEN_NATIVE_REDEEM_IDENTITY_SOURCE],
  }],
  declaredVenues: [],
  undeclaredVenueReason:
    "instances require an observed withdraw plus active spend/burn/native-delta proof",
  discovery: etherTokenNativeRedeemDiscovery,
  discoveryIdentityResolver: etherTokenNativeRedeemIdentityResolver,
  discoveryIdentityAuthority: {
    class: "canonical-onchain",
    strength: 300,
  },
  edgeAdapterIds: [ETHERTOKEN_NATIVE_REDEEM_EDGE_ADAPTER],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "redeem" }],
  requiresProtocolEdgesFlag: true,
  ownedActionAdapterIds: [ETHERTOKEN_NATIVE_REDEEM_EDGE_ADAPTER],
  requiredInfraActionAdapterIds: ["weth-deposit-value"],
  pricingState,
  prepared: null,

  async buildEdges(
    pool: PoolEntry,
    backend: TokenQueryBackend,
  ): Promise<TokenEdge[]> {
    if (
      pool.adapter !== ETHERTOKEN_NATIVE_REDEEM_POOL_ADAPTER ||
      pool.verifiedRoutes?.length !== 1 ||
      pool.logicalInstanceId !==
        etherTokenNativeRedeemInstanceId(pool.address)
    ) {
      throw new Error(
        "ethertoken-native-redeem pool requires one discovery-verified route",
      );
    }
    const route = pool.verifiedRoutes[0];
    if (
      route.edgeAdapterId !== ETHERTOKEN_NATIVE_REDEEM_EDGE_ADAPTER ||
      route.tokenIn.toLowerCase() !== pool.address.toLowerCase() ||
      route.tokenOut.toLowerCase() !== ADDR.WETH.toLowerCase() ||
      route.slotKind !== "protocol" ||
      route.protocolAction !== "redeem"
    ) {
      throw new Error("ethertoken-native-redeem verified route shape drifted");
    }
    const raw = await backend.call({
      to: pool.address,
      data: iface.encodeFunctionData("totalSupply"),
    });
    iface.decodeFunctionResult("totalSupply", raw);
    return [{
      adapterId: ETHERTOKEN_NATIVE_REDEEM_EDGE_ADAPTER,
      target: ethers.getAddress(pool.address),
      tokenIn: ethers.getAddress(pool.address),
      tokenOut: ADDR.WETH,
      slotKind: "protocol",
      protocolAction: "redeem",
      score: pool.score,
      ...deriveEdgeTaxonomy("protocol", "redeem"),
    }];
  },

  async quoteExact(ctx: ExactQuoteContext): Promise<bigint> {
    if (
      ctx.edgeAdapterId !== ETHERTOKEN_NATIVE_REDEEM_EDGE_ADAPTER ||
      ctx.tokenIn?.toLowerCase() !== ctx.target.toLowerCase() ||
      ctx.tokenOut?.toLowerCase() !== ADDR.WETH.toLowerCase()
    ) {
      throw new Error("ethertoken-native-redeem exact quote received a foreign edge");
    }
    if (!ctx.executor) {
      throw new Error("ethertoken-native-redeem exact quote requires executor");
    }
    if (!ctx.state.simulateTokenToNativeDelta) {
      throw new Error(
        "ethertoken-native-redeem exact quote requires value-delta simulation",
      );
    }
    const token = ethers.getAddress(ctx.target);
    const result = await ctx.state.simulateTokenToNativeDelta({
      token,
      caller: ctx.executor,
      amountIn: ctx.amountIn,
      callData: iface.encodeFunctionData("withdraw", [ctx.amountIn]),
    });
    if (
      result.tokenInSpent !== ctx.amountIn ||
      result.totalSupplyBurned !== ctx.amountIn ||
      result.nativeOut !== ctx.amountIn
    ) {
      throw new Error(
        "ethertoken-native-redeem exact quote invariants failed",
      );
    }
    return result.nativeOut;
  },

  async buildPlanFragment(ctx) {
    requireOwnedEdge(ctx.edge);
    return {
      requirements: [],
      nodes: [
        {
          adapterId: ETHERTOKEN_NATIVE_REDEEM_EDGE_ADAPTER,
          target: ctx.edge.target,
          tokenIn: ctx.edge.tokenIn,
          tokenOut: ctx.edge.tokenIn,
          amount: ctx.amountIn,
          params: {},
          children: [],
        },
        {
          adapterId: "weth-deposit-value",
          target: ADDR.WETH,
          tokenIn: ADDR.ZERO,
          tokenOut: ADDR.WETH,
          amount: ctx.amountOut,
          params: {},
          children: [],
        },
      ],
    };
  },
} satisfies ProtocolConversionAdapter);

function requireOwnedEdge(edge: TokenEdge): void {
  if (
    edge.adapterId !== ETHERTOKEN_NATIVE_REDEEM_EDGE_ADAPTER ||
    edge.target.toLowerCase() !== edge.tokenIn.toLowerCase() ||
    edge.tokenOut.toLowerCase() !== ADDR.WETH.toLowerCase() ||
    edge.slotKind !== "protocol" ||
    edge.protocolAction !== "redeem"
  ) {
    throw new Error("ethertoken-native-redeem received a foreign edge");
  }
}
