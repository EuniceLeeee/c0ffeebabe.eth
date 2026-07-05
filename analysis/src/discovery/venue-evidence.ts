import type { EdgeKind, ProtocolAction } from "../../../listener/src/searcher/strategy-taxonomy.js";
import { ADDR } from "../../../listener/src/shared/constants/addresses.js";
import { deriveEdgeKindsFromLogs, deriveProtocolActionsFromLogs } from "../learning/edge-kinds.js";
import { PUBLIC_ROUTERS, isPublicRouter } from "../registry/routers.js";

export interface VenueCandidate {
  address: string;
  edgeKinds: EdgeKind[];
  protocolActions: ProtocolAction[];
  logCount: number;
}

export interface VenueScanInput {
  txHash?: string;
  from?: string;
  to?: string;
  receiptLogs: Array<{ address?: string; topics?: unknown; data?: unknown }>;
}

export const KNOWN_EXCLUDED_ADDRESSES: ReadonlySet<string> = new Set([
  ...[
    ADDR.WETH,
    ADDR.USDC,
    ADDR.DAI,
    ADDR.USDT,
    ADDR.WSTUSR,
    ADDR.DOLA,
    ADDR.SUSDS,
    ADDR.MORPHO,
    ADDR.BALANCER_VAULT,
    ADDR.FLUID_VAULT_WSTUSR_USDC,
    ADDR.SKY_PSM_LITE,
    ADDR.UNISWAP_V4_POOL_MANAGER,
    ADDR.UNISWAP_V4_POSITION_MANAGER,
    ADDR.UNISWAP_V4_QUOTER,
    ADDR.UNISWAP_V3_USDT_WETH,
    ADDR.UNISWAP_V3_USDC_WETH_100,
    ADDR.UNISWAP_V3_USDC_USDT_100,
    ADDR.UNISWAP_V3_USDC_WETH_500,
    ADDR.CURVE_SUSDS_USDT,
    ADDR.CURVE_DOLA_SUSDS,
    ADDR.CURVE_DOLA_WSTUSR,
    ADDR.CURVE_3POOL,
  ].map(lowerAddress),
  ...PUBLIC_ROUTERS,
]);

export function extractVenueCandidates(input: VenueScanInput): VenueCandidate[] {
  const logsByEmitter = new Map<string, VenueScanInput["receiptLogs"]>();

  for (const log of input.receiptLogs) {
    const address = lowerAddress(log.address);
    if (!address) continue;
    const normalizedLog = { ...log, address };
    const logs = logsByEmitter.get(address);
    if (logs) logs.push(normalizedLog);
    else logsByEmitter.set(address, [normalizedLog]);
  }

  const txParties = new Set([input.from, input.to].map(lowerAddress).filter(Boolean));
  const candidates: VenueCandidate[] = [];

  for (const [address, logs] of logsByEmitter) {
    const edgeKinds = deriveEdgeKindsFromLogs(logs);
    if (edgeKinds.length === 0 || isExcludedAddress(address, txParties)) continue;
    candidates.push({
      address,
      edgeKinds,
      protocolActions: deriveProtocolActionsFromLogs(logs),
      logCount: logs.length,
    });
  }

  return candidates.sort((a, b) => b.logCount - a.logCount || a.address.localeCompare(b.address));
}

function isExcludedAddress(address: string, txParties: Set<string>): boolean {
  return txParties.has(address) || KNOWN_EXCLUDED_ADDRESSES.has(address) || isPublicRouter(address);
}

function lowerAddress(address: string | null | undefined): string {
  return address?.toLowerCase() ?? "";
}
