import { ethers } from "ethers";
import type {
  PoolEntry,
  TokenEdge,
  TokenQueryBackend,
  VerifiedRouteSpec,
} from "../../planner/token-graph.js";
import type {
  ExactQuoteContext,
  PreparedRouteContext,
  ProtocolConversionAdapter,
} from "../route-leg-adapter.js";
import {
  ASTRA_MULTITOKEN_EDGE_ADAPTER,
  ASTRA_MULTITOKEN_IDENTITY_SOURCE,
  ASTRA_MULTITOKEN_POOL_ADAPTER,
  ASTRA_MULTITOKEN_VENUE,
  astraMultiTokenDiscovery,
  astraMultiTokenEdge,
  astraMultiTokenIdentityResolver,
  astraMultiTokenIface,
  astraMultiTokenInstanceId,
  quoteAstraMultiToken,
  readAstraTokenSet,
} from "./astra-multitoken-discovery.js";
import {
  createProtocolQuoteStateCapability,
  decodeUintResult,
} from "./protocol-state-framework.js";

const astraMultiTokenPricingState = createProtocolQuoteStateCapability({
  familyId: "protocol:astra-multitoken",
  edgeAdapterIds: [ASTRA_MULTITOKEN_EDGE_ADAPTER],
  addressTouchCarryPolicy: "dependency-touch",
  stateKey: (edge) =>
    `${edge.target}:${edge.tokenIn}:${edge.tokenOut}`.toLowerCase(),
  buildQuoteReads(edge, amountIn) {
    return [{
      suffix: "change",
      to: edge.target,
      data: astraMultiTokenIface.encodeFunctionData("getReturn", [
        edge.tokenIn,
        edge.tokenOut,
        amountIn,
      ]),
    }];
  },
  deriveAmountOut(_edge, _amountIn, result) {
    return decodeUintResult(
      astraMultiTokenIface,
      "getReturn",
      result("change"),
    );
  },
});

export const astraMultiTokenAdapter = Object.freeze({
  id: "protocol:astra-multitoken",
  kind: "protocol-conversion",
  poolAdapters: [ASTRA_MULTITOKEN_POOL_ADAPTER],
  identityPolicies: [{
    poolAdapter: ASTRA_MULTITOKEN_POOL_ADAPTER,
    policy: "trusted-singleton-seed",
    registeredVenueIds: [ASTRA_MULTITOKEN_VENUE],
    registeredIdentitySources: [ASTRA_MULTITOKEN_IDENTITY_SOURCE],
  }],
  declaredVenues: [],
  undeclaredVenueReason:
    "instances require observed Change evidence plus current-block identity and execution proof",
  discovery: astraMultiTokenDiscovery,
  discoveryIdentityResolver: astraMultiTokenIdentityResolver,
  discoveryIdentityAuthority: {
    class: "canonical-onchain",
    strength: 300,
  },
  edgeAdapterIds: [ASTRA_MULTITOKEN_EDGE_ADAPTER],
  allowedTaxonomy: [{
    slotKind: "protocol",
    protocolAction: "convert",
  }],
  ownedActionAdapterIds: [ASTRA_MULTITOKEN_EDGE_ADAPTER],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  requiresProtocolEdgesFlag: true,
  pricingState: astraMultiTokenPricingState,
  prepared: {
    quote: async (ctx: PreparedRouteContext) => {
      const quoted = await ctx.callPrepared(
        ctx.request.target,
        astraMultiTokenIface.encodeFunctionData("getReturn", [
          ctx.request.tokenIn,
          ctx.request.tokenOut,
          ctx.request.amountIn,
        ]),
        { gasLimit: 500_000 },
      );
      return {
        amountOut: BigInt(
          astraMultiTokenIface.decodeFunctionResult(
            "getReturn",
            quoted.output,
          )[0],
        ),
        latencyMs: quoted.latencyMs,
        cacheStats: quoted.cacheStats,
      };
    },
    quoteUnsupportedReason: null,
    encodeQuotePrewarm: async (ctx: PreparedRouteContext) => [{
      from: ethers.ZeroAddress,
      to: ctx.request.target,
      calldata: astraMultiTokenIface.encodeFunctionData("getReturn", [
        ctx.request.tokenIn,
        ctx.request.tokenOut,
        ctx.request.amountIn,
      ]),
      gasLimit: 500_000,
    }],
    allowanceSpender: (request) => ethers.getAddress(request.target),
    prewarmAddresses: (request) => [
      ethers.getAddress(request.target),
      ethers.getAddress(request.tokenIn),
      ethers.getAddress(request.tokenOut),
    ],
  },

  async buildEdges(
    pool: PoolEntry,
    backend: TokenQueryBackend,
  ): Promise<TokenEdge[]> {
    if (
      pool.adapter !== ASTRA_MULTITOKEN_POOL_ADAPTER ||
      pool.logicalInstanceId !== astraMultiTokenInstanceId(pool.address)
    ) {
      throw new Error(
        "AstraMultiToken pool requires a discovery-attested instance",
      );
    }
    const surface = await readAstraTokenSet(
      { call: (request) => backend.call(request) },
      pool.address,
      false,
    );
    const expected = new Map<string, TokenEdge>();
    for (const tokenIn of surface.tokens) {
      for (const tokenOut of surface.tokens) {
        if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) continue;
        const edge = astraMultiTokenEdge(
          pool.address,
          tokenIn,
          tokenOut,
          pool.score,
        );
        expected.set(routeKey(edge), edge);
      }
    }
    const verified = pool.verifiedRoutes;
    if (
      !verified ||
      verified.length === 0 ||
      new Set(verified.map(verifiedRouteKey)).size !== verified.length ||
      verified.some((route) => !expected.has(verifiedRouteKey(route)))
    ) {
      throw new Error(
        "AstraMultiToken pool routes differ from its current token registry",
      );
    }
    // Discovery projects the complete actively-probed registry, while a
    // route-pinned execution replay intentionally carries only the witnessed
    // route. Re-attest every supplied route against the current registry and
    // emit only that verified permission set; never regrow an unverified pair.
    return verified.map((route) => expected.get(verifiedRouteKey(route))!);
  },

  async quoteExact(ctx: ExactQuoteContext): Promise<bigint> {
    if (!ctx.tokenIn || !ctx.tokenOut) {
      throw new Error("AstraMultiToken quote requires tokenIn/tokenOut");
    }
    return quoteAstraMultiToken(
      ctx.state,
      ctx.target,
      ctx.tokenIn,
      ctx.tokenOut,
      ctx.amountIn,
    );
  },

  async buildPlanFragment(ctx) {
    if (
      ctx.edge.adapterId !== ASTRA_MULTITOKEN_EDGE_ADAPTER ||
      ctx.edge.slotKind !== "protocol" ||
      ctx.edge.protocolAction !== "convert" ||
      ctx.edge.leavesStandingPosition
    ) {
      throw new Error("AstraMultiToken plan received a foreign edge");
    }
    if (ctx.amountIn <= 0n || ctx.amountOut <= 0n) {
      throw new Error("AstraMultiToken plan requires positive exact-in quote");
    }
    return {
      requirements: [{
        kind: "approve",
        token: ctx.edge.tokenIn,
        spender: ctx.edge.target,
        amount: ctx.amountIn,
      }],
      nodes: [{
        adapterId: ASTRA_MULTITOKEN_EDGE_ADAPTER,
        target: ctx.edge.target,
        tokenIn: ctx.edge.tokenIn,
        tokenOut: ctx.edge.tokenOut,
        amount: ctx.amountIn,
        params: { minAmountOut: ctx.amountOut },
        children: [],
      }],
    };
  },
} satisfies ProtocolConversionAdapter);

function routeKey(
  route: Pick<
    TokenEdge,
    "adapterId" | "tokenIn" | "tokenOut" | "slotKind" | "protocolAction"
  >,
): string {
  return [
    route.adapterId,
    route.tokenIn.toLowerCase(),
    route.tokenOut.toLowerCase(),
    route.slotKind,
    route.protocolAction ?? "",
  ].join("|");
}

function verifiedRouteKey(route: VerifiedRouteSpec): string {
  return [
    route.edgeAdapterId,
    route.tokenIn.toLowerCase(),
    route.tokenOut.toLowerCase(),
    route.slotKind,
    route.protocolAction ?? "",
  ].join("|");
}
