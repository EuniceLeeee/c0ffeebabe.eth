import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type { ExactQuoteContext, ProtocolConversionAdapter } from "../route-leg-adapter.js";
import { readProtocolExternalMid } from "../mid-readers.js";
import { buildDescriptorProtocolPlan } from "./protocol-plan.js";
import { quoteProtocolLeg } from "./protocol-quote.js";

const rocksolidIface = new ethers.Interface([
  "function convertToShares(uint256 assets) view returns (uint256 shares)",
]);

export const rocksolidAdapter = Object.freeze({
  id: "protocol:rocksolid",
  kind: "protocol-conversion",
  poolAdapters: ["rocksolid"],
  declaredVenues: [{
    address: ADDR.ROCKSOLID_RETH,
    adapter: "rocksolid",
    fixedTokenIn: ADDR.RETH,
    fixedSlotKind: "protocol",
    fixedProtocolAction: "wrap",
  }],
  undeclaredVenueReason: null,
  edgeAdapterIds: ["rocksolid-sync-deposit"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "wrap" }],
  requiresProtocolEdgesFlag: true,
  actionAdapterIds: ["rocksolid-sync-deposit", "erc20-approve"],
  readMid: readProtocolExternalMid,
  warm: { kind: "protocol-mid", priority: 2 },
  prepared: null,
  async buildEdges(pool: PoolEntry, backend: TokenQueryBackend): Promise<TokenEdge[]> {
    if (!pool.fixedTokenIn) throw new Error(`rocksolid pool ${pool.address} missing fixedTokenIn`);
    // No token-address view is published, so the pair stays code-owned; attest
    // the deposit-quote view the leg depends on instead of trusting the pin.
    const raw = await backend.call({
      to: pool.address,
      data: rocksolidIface.encodeFunctionData("convertToShares", [10n ** 18n]),
    });
    const shares = BigInt(rocksolidIface.decodeFunctionResult("convertToShares", raw)[0]);
    if (shares <= 0n) {
      throw new Error(`rocksolid identity attestation failed: ${pool.address} convertToShares = ${shares}`);
    }
    return [{
      adapterId: "rocksolid-sync-deposit", target: ethers.getAddress(pool.address),
      tokenIn: ethers.getAddress(pool.fixedTokenIn), tokenOut: ethers.getAddress(pool.address),
      slotKind: "protocol", protocolAction: "wrap", score: pool.score,
      ...deriveEdgeTaxonomy("protocol", "wrap"),
    }];
  },
  async quoteExact(ctx: ExactQuoteContext): Promise<bigint> {
    return quoteProtocolLeg(ctx.state, ctx.target, ctx.edgeAdapterId, ctx.amountIn);
  },
  buildPlanFragment: buildDescriptorProtocolPlan,
} satisfies ProtocolConversionAdapter);
