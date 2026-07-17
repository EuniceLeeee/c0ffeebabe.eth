import { ethers } from "ethers";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type {
  ExactQuoteContext,
  ProbeContext,
  ProtocolConversionAdapter,
  ProtocolInstance,
  ProtocolRoute,
  RouteProbeResult,
} from "../route-leg-adapter.js";
import { readProtocolExternalMid } from "../mid-readers.js";
import { buildDescriptorProtocolPlan } from "./protocol-plan.js";
import { quoteProtocolLeg, quoteSiloRedeem } from "./protocol-quote.js";

const erc4626Iface = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256 shares)",
  "function convertToAssets(uint256 shares) view returns (uint256 assets)",
  "function previewDeposit(uint256 assets) view returns (uint256 shares)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
]);

// Small enough to be harmless against supply caps, large enough that per-call
// rounding stays inside the tolerance below for 6- and 18-decimal assets.
const DISCOVERY_PROBE_AMOUNT = 10n ** 6n;
const roundingTolerance = (value: bigint): bigint => value / 1000n + 2n;

async function readVaultUint(
  backend: TokenQueryBackend,
  vault: string,
  fn: string,
  args: readonly bigint[],
): Promise<bigint> {
  const raw = await backend.call({ to: vault, data: erc4626Iface.encodeFunctionData(fn, [...args]) });
  return BigInt(erc4626Iface.decodeFunctionResult(fn, raw)[0]);
}

async function readVaultAsset(backend: TokenQueryBackend, vault: string): Promise<string> {
  const raw = await backend.call({ to: vault, data: erc4626Iface.encodeFunctionData("asset") });
  return ethers.getAddress(String(erc4626Iface.decodeFunctionResult("asset", raw)[0]));
}

export const erc4626Adapter = Object.freeze({
  id: "protocol:erc4626",
  kind: "protocol-conversion",
  poolAdapters: ["erc4626"],
  declaredVenues: [],
  undeclaredVenueReason: "ERC4626 instances require external discovery and per-vault probe admission",
  edgeAdapterIds: ["erc4626-deposit", "erc4626-redeem", "erc4626-redeem-silo"],
  allowedTaxonomy: [
    { slotKind: "protocol", protocolAction: "wrap" },
    { slotKind: "protocol", protocolAction: "redeem" },
  ],
  requiresProtocolEdgesFlag: true,
  actionAdapterIds: [
    "erc4626-deposit", "erc4626-redeem", "erc4626-redeem-silo", "erc20-approve",
  ],
  readMid: readProtocolExternalMid,
  warm: { kind: "protocol-mid", priority: 2 },
  prepared: null,
  async buildEdges(pool: PoolEntry, backend: TokenQueryBackend): Promise<TokenEdge[]> {
    if (!pool.fixedTokenIn) throw new Error(`erc4626 pool ${pool.address} missing fixedTokenIn`);
    if (pool.nonStandardRedeem) {
      // fixedTokenIn feeds no edge here and silo payout semantics are verified
      // at the fork-receipt level, so no asset() attestation on this branch.
      if (!pool.redeemTokenOut) return [];
      return [{
        adapterId: "erc4626-redeem-silo", target: pool.address,
        tokenIn: pool.address, tokenOut: pool.redeemTokenOut,
        slotKind: "protocol", protocolAction: "redeem", score: pool.score,
        ...deriveEdgeTaxonomy("protocol", "redeem"),
      }];
    }
    // previewDeposit/previewRedeem quotes are denominated in asset(); a vault
    // whose asset drifts from the registry pin must fail edge build.
    const raw = await backend.call({ to: pool.address, data: erc4626Iface.encodeFunctionData("asset") });
    const reported = String(erc4626Iface.decodeFunctionResult("asset", raw)[0]);
    if (reported.toLowerCase() !== pool.fixedTokenIn.toLowerCase()) {
      throw new Error(
        `erc4626 identity attestation failed: ${pool.address} reports asset ${reported}, pinned ${pool.fixedTokenIn}`,
      );
    }
    return [
      {
        adapterId: "erc4626-deposit", target: pool.address,
        tokenIn: pool.fixedTokenIn, tokenOut: pool.address,
        slotKind: "protocol", protocolAction: "wrap", score: pool.score,
        ...deriveEdgeTaxonomy("protocol", "wrap"),
      },
      {
        adapterId: "erc4626-redeem", target: pool.address,
        tokenIn: pool.address, tokenOut: pool.fixedTokenIn,
        slotKind: "protocol", protocolAction: "redeem", score: pool.score,
        ...deriveEdgeTaxonomy("protocol", "redeem"),
      },
    ];
  },
  async quoteExact(ctx: ExactQuoteContext): Promise<bigint> {
    if (ctx.edgeAdapterId === "erc4626-redeem-silo") {
      if (!ctx.tokenOut) throw new Error("erc4626 silo quote requires tokenOut");
      return quoteSiloRedeem(ctx.state, ctx.target, ctx.tokenOut, ctx.amountIn);
    }
    return quoteProtocolLeg(ctx.state, ctx.target, ctx.edgeAdapterId, ctx.amountIn);
  },
  buildPlanFragment: buildDescriptorProtocolPlan,
  // Shadow-grade discovery (plan Slice B). Candidate source = the DEX universe
  // token set, per Slice C: the legacy registry is the recall answer sheet and
  // must never feed candidates. probeRoute is preview-consistency only —
  // receiptVerified stays false until the Slice C fork-receipt probe exists,
  // so the coordinator can never report these routes as admissible.
  discovery: {
    async discoverInstances(ctx) {
      return ctx.universeTokens.map((token) => ({
        target: token,
        source: "universe-token" as const,
      }));
    },
    async attestIdentity(candidate, ctx: ProbeContext): Promise<ProtocolInstance | null> {
      // asset() being readable is not identity by itself (plan Slice C): the
      // standard-interface surfaces must exist AND agree with each other.
      try {
        const vault = ethers.getAddress(candidate.target);
        const asset = await readVaultAsset(ctx.backend, vault);
        if (asset === ethers.ZeroAddress || asset.toLowerCase() === vault.toLowerCase()) return null;
        await readVaultUint(ctx.backend, vault, "totalAssets", []);
        const shares = await readVaultUint(ctx.backend, vault, "convertToShares", [DISCOVERY_PROBE_AMOUNT]);
        if (shares <= 0n) return null;
        const roundTrip = await readVaultUint(ctx.backend, vault, "convertToAssets", [shares]);
        const drift = roundTrip > DISCOVERY_PROBE_AMOUNT
          ? roundTrip - DISCOVERY_PROBE_AMOUNT
          : DISCOVERY_PROBE_AMOUNT - roundTrip;
        if (drift > roundingTolerance(DISCOVERY_PROBE_AMOUNT)) return null;
        return { target: vault, adapter: "erc4626" };
      } catch {
        return null;
      }
    },
    async enumerateRoutes(instance, ctx: ProbeContext): Promise<ProtocolRoute[]> {
      const asset = await readVaultAsset(ctx.backend, instance.target);
      return [
        {
          target: instance.target, tokenIn: asset, tokenOut: instance.target,
          action: "wrap", edgeAdapterId: "erc4626-deposit",
        },
        {
          target: instance.target, tokenIn: instance.target, tokenOut: asset,
          action: "redeem", edgeAdapterId: "erc4626-redeem",
        },
      ];
    },
    async probeRoute(route, ctx: ProbeContext): Promise<RouteProbeResult> {
      // Fee-bearing vaults may preview below convertTo*, but a preview ABOVE
      // it over-promises output — inconsistent, fail.
      const [previewFn, convertFn] = route.edgeAdapterId === "erc4626-deposit"
        ? (["previewDeposit", "convertToShares"] as const)
        : (["previewRedeem", "convertToAssets"] as const);
      const preview = await readVaultUint(ctx.backend, route.target, previewFn, [DISCOVERY_PROBE_AMOUNT]);
      const converted = await readVaultUint(ctx.backend, route.target, convertFn, [DISCOVERY_PROBE_AMOUNT]);
      if (preview <= 0n) {
        return { ok: false, reason: `${previewFn} returned ${preview}`, receiptVerified: false };
      }
      if (preview > converted + roundingTolerance(converted)) {
        return {
          ok: false,
          reason: `${previewFn} ${preview} exceeds ${convertFn} ${converted}`,
          receiptVerified: false,
        };
      }
      return { ok: true, reason: null, receiptVerified: false };
    },
  },
} satisfies ProtocolConversionAdapter);
