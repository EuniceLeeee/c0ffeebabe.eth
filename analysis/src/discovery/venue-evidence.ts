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

/** Token-ish topic0s: ERC20 Transfer/Approval + WETH Deposit/Withdrawal. An emitter whose only topics
 *  are these is a plain token, not a venue. */
const TOKEN_TOPIC0S: ReadonlySet<string> = new Set([
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", // Transfer
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", // Approval
  "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c", // WETH Deposit
  "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65", // WETH Withdrawal
]);

export type VenueCaptureStatus = "classified" | "unclassified_venue" | "token_only" | "excluded";

/** A captured emitter. CAPTURE is complete (nothing dropped) — classification/filtering is downstream. */
export interface CapturedVenue extends VenueCandidate {
  topic0s: string[];
  status: VenueCaptureStatus;
}

/** Capture EVERY emitter in the input, tagged with a status — drops NOTHING (the completeness contract:
 *  an unknown-topic venue must never be silently discarded the way extractVenueCandidates does).
 *  Washing (which to route/adapter) is a downstream filter on `status`, not a capture-time drop. */
export function captureAllVenues(input: VenueScanInput): CapturedVenue[] {
  const logsByEmitter = new Map<string, VenueScanInput["receiptLogs"]>();
  for (const log of input.receiptLogs) {
    const address = lowerAddress(log.address);
    if (!address) continue;
    const logs = logsByEmitter.get(address);
    if (logs) logs.push({ ...log, address });
    else logsByEmitter.set(address, [{ ...log, address }]);
  }
  const txParties = new Set([input.from, input.to].map(lowerAddress).filter(Boolean));
  const out: CapturedVenue[] = [];
  for (const [address, logs] of logsByEmitter) {
    const edgeKinds = deriveEdgeKindsFromLogs(logs);
    const topic0s = [...new Set(logs.map((l) => topic0Of(l.topics)).filter(Boolean))];
    let status: VenueCaptureStatus;
    if (isExcludedAddress(address, txParties)) status = "excluded";
    else if (edgeKinds.length > 0) status = "classified";
    else if (topic0s.every((t) => TOKEN_TOPIC0S.has(t))) status = "token_only";
    else status = "unclassified_venue";
    out.push({
      address, edgeKinds, protocolActions: deriveProtocolActionsFromLogs(logs),
      logCount: logs.length, topic0s, status,
    });
  }
  return out.sort((a, b) => b.logCount - a.logCount || a.address.localeCompare(b.address));
}

function topic0Of(topics: unknown): string {
  return Array.isArray(topics) && typeof topics[0] === "string" ? topics[0].toLowerCase() : "";
}

function lowerAddress(address: string | null | undefined): string {
  return address?.toLowerCase() ?? "";
}
