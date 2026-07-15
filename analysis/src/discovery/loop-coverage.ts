import { ADAPTER_DESCRIPTORS } from "../../../listener/src/adapters/adapter-descriptors.js";
import { POOL_REGISTRY } from "../../../listener/src/searcher/planner/token-graph.js";
import { lower, TOPICS } from "../registry/protocols.js";
import type { VenueScanInput } from "./venue-evidence.js";

/**
 * Per-transaction receipt evidence. Topic recognition says what happened; it does not by itself prove
 * that the production listener can route the emitting venue. Swap routability is assessed separately
 * against the listener's adapter descriptors and remains unassessed when receipt-only input cannot
 * attest factory identity or routing-graph membership.
 */

export type ObservedRole = "flashloan" | "protocol" | "swap" | "token" | "unclassified";

export type ObservedSwapFamily =
  | "balancer-v2"
  | "curve"
  | "dodo"
  | "fluid"
  | "pancake-v3"
  | "univ2"
  | "univ3"
  | "univ4";

export type ProductionRoutability = "routable" | "not_routable" | "unassessed";

export type ProductionRoutabilityReason =
  | "factory_or_routing_graph_not_attested"
  | "no_adapter"
  | "no_swap_adapter"
  | "routing_attested";

// Topic-to-family recognition is receipt evidence only. Production capability is derived below from
// listener adapter descriptors, never from this map.
export const OBSERVED_SWAP_TOPIC_FAMILIES: ReadonlyMap<string, ObservedSwapFamily> = new Map<
  string,
  ObservedSwapFamily
>(
  [
    [lower(TOPICS.univ2Swap), "univ2"],
    // Sync is retained as UniV2 venue evidence for compatibility with the broader coverage scan.
    ["0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1", "univ2"],
    [lower(TOPICS.univ3Swap), "univ3"],
    [lower(TOPICS.pancakeV3Swap), "pancake-v3"],
    [lower(TOPICS.univ4Swap), "univ4"],
    [lower(TOPICS.curveTokenExchange), "curve"],
    [lower(TOPICS.curveCryptoTokenExchange), "curve"],
    ["0xb2e76ae99761dc136e598d4a629bb347eccb9532a5f8bbd72e18467c3c34cc98", "curve"],
    [lower(TOPICS.curveTokenExchangeUnderlying), "curve"],
    [lower(TOPICS.balancerV2Swap), "balancer-v2"],
    [lower(TOPICS.dodoSwap), "dodo"],
    [lower(TOPICS.fluidDexSwap), "fluid"],
  ] as const,
);

// Curve router Exchange is an observed topic prefix whose full ABI variant is not available.
const CURVE_ROUTER_EXCHANGE_PREFIX = "0x56d0661e";

export const FLASHLOAN_EVENT_TOPICS: ReadonlySet<string> = new Set(
  [
    TOPICS.balancerV2FlashLoan,
    TOPICS.morphoFlashLoan,
    TOPICS.univ3Flash,
    TOPICS.aaveV3FlashLoan,
  ].map(lower),
);

export const ERC4626_EVENT_TOPICS: ReadonlySet<string> = new Set(
  [TOPICS.erc4626Deposit, TOPICS.erc4626Withdraw].map(lower),
);

const PSM_EVENT_TOPICS: ReadonlySet<string> = new Set(
  [TOPICS.psmSellGem, TOPICS.psmBuyGem].map(lower),
);

/** Named protocol evidence is strong enough to report a protocol gap when no registered adapter matches.
 * Morpho Supply/Withdraw is intentionally absent: a vault may emit it internally without making the
 * transaction a credit/protocol leg we take (decision-log F-007/F-009). */
const NAMED_PROTOCOL_EVENT_TOPICS: ReadonlySet<string> = new Set(
  [
    ...ERC4626_EVENT_TOPICS,
    ...PSM_EVENT_TOPICS,
    TOPICS.liquityTroveOperation,
    TOPICS.liquityTroveUpdated,
    TOPICS.liquityBatchUpdated,
  ].map(lower),
);

export const TOKEN_TOPICS: ReadonlySet<string> = new Set(
  [
    TOPICS.transfer,
    "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
    TOPICS.wethDeposit,
    TOPICS.wethWithdrawal,
  ].map(lower),
);

const REGISTERED_ENTRY_BY_ADDRESS = new Map(
  POOL_REGISTRY.flatMap((entry) => [
    [lower(entry.address), entry] as const,
    ...(entry.receiptEmitters ?? []).map((emitter) => [lower(emitter), entry] as const),
  ]),
);

/** Backward-compatible export used by callers that need our registered ERC4626 vault set. */
export const OUR_VAULT_ADDRESSES: ReadonlySet<string> = new Set(
  POOL_REGISTRY.filter((entry) => entry.adapter === "erc4626").map((entry) => lower(entry.address)),
);

const PRODUCTION_SWAP_LINEAGES: ReadonlySet<string> = new Set(
  Object.values(ADAPTER_DESCRIPTORS)
    .filter((descriptor) => descriptor.edgeKind === "swap" && descriptor.action === "swap")
    .map((descriptor) => descriptor.lineage),
);

export interface ObservedSwapVenue {
  addr: string;
  family: ObservedSwapFamily;
  topic0s: string[];
  productionRoutability: ProductionRoutability;
  reason: ProductionRoutabilityReason;
  /** Bundle-postmortem-compatible graph fact: null means receipt-only evidence cannot assess identity. */
  in_graph: boolean | null;
}

export interface ObservedVenue {
  addr: string;
  observedRoles: ObservedRole[];
  observedSwapFamilies: ObservedSwapFamily[];
  topic0s: string[];
}

/** @deprecated Use ObservedVenue. The alias no longer exposes a scalar class. */
export type ClassifiedVenue = ObservedVenue;

export interface TxLoopCoverage {
  tx: string;
  /** OUR vault addresses that emitted a real ERC4626 event in this transaction. */
  vaults: string[];
  /** All registered protocol venues evidenced in the receipt (includes vaults and PSM). */
  protocolVenues: string[];
  /** Distinct observed swap address/family pairs with an independent production assessment. */
  observedSwapVenues: ObservedSwapVenue[];
  /** Definitive production route gaps. Unassessed receipt-only venues are not gaps. */
  swapRouteGaps: ObservedSwapVenue[];
  /** @deprecated Use observedSwapVenues.length. */
  swapVenues: number;
  /** Named protocol events whose emitter has no matching registered adapter. */
  protocolVenueGaps: Array<{ addr: string; topic0: string }>;
  /** Unknown emitters needing trace/call-order inspection; not automatically route gaps. */
  unclassifiedEmitters: Array<{ addr: string; topic0: string }>;
  /** Receipt evidence maps every named protocol leg to an adapter. Still requires a trace. */
  protocolAdapterCandidate: boolean;
  /** @deprecated Conservative compatibility signal only; never proof of route closure or comparability. */
  fullyCovered: boolean;
  coverageScope: "receipt_log_emitters_only";
  routabilityScope: "production_listener_descriptors_receipt_only";
  comparability: "requires_trace";
  /** Full per-emitter role observation (audit trail). */
  venues: ObservedVenue[];
}

export function classifyTxLoopCoverage(input: VenueScanInput): TxLoopCoverage {
  const topicsByEmitter = new Map<string, Set<string>>();
  for (const log of input.receiptLogs) {
    const addr = lower(log.address);
    if (!addr) continue;
    const topic0 = topic0Of(log.topics);
    if (!topic0) continue;
    const topics = topicsByEmitter.get(addr);
    if (topics) topics.add(topic0);
    else topicsByEmitter.set(addr, new Set([topic0]));
  }

  const venues: ObservedVenue[] = [];
  const observedSwapVenues: ObservedSwapVenue[] = [];
  const vaults: string[] = [];
  const protocolVenues: string[] = [];
  const protocolVenueGaps: Array<{ addr: string; topic0: string }> = [];
  const unclassifiedEmitters: Array<{ addr: string; topic0: string }> = [];

  for (const [addr, topicSet] of topicsByEmitter) {
    const topic0s = [...topicSet].sort();
    const observedSwapFamilies = observedSwapFamiliesFor(topic0s);
    const observedRoles = observedRolesFor(topic0s, observedSwapFamilies);
    venues.push({ addr, observedRoles, observedSwapFamilies, topic0s });

    for (const family of observedSwapFamilies) {
      observedSwapVenues.push({
        addr,
        family,
        topic0s: topic0s.filter((topic0) => observedSwapFamilyForTopic(topic0) === family),
        ...assessProductionRoutability(family),
      });
    }

    const namedProtocolTopic = topic0s.find((topic0) => NAMED_PROTOCOL_EVENT_TOPICS.has(topic0));
    if (namedProtocolTopic) {
      const entry = REGISTERED_ENTRY_BY_ADDRESS.get(addr);
      if (hasRegisteredProtocolEvent(entry, topic0s)) {
        protocolVenues.push(addr);
        if (entry?.adapter === "erc4626") vaults.push(addr);
      } else {
        protocolVenueGaps.push({ addr, topic0: namedProtocolTopic });
      }
    }

    if (observedRoles.length === 1 && observedRoles[0] === "unclassified") {
      unclassifiedEmitters.push({ addr, topic0: topic0s[0] ?? "" });
    }
  }

  const sortedObservedSwaps = observedSwapVenues.sort(compareObservedSwaps);
  const swapRouteGaps = sortedObservedSwaps.filter(
    (venue) => venue.productionRoutability === "not_routable",
  );
  const hasUnassessedSwap = sortedObservedSwaps.some(
    (venue) => venue.productionRoutability === "unassessed",
  );
  const sortedProtocolGaps = protocolVenueGaps.sort((a, b) => a.addr.localeCompare(b.addr));
  const sortedUnclassified = unclassifiedEmitters.sort((a, b) => a.addr.localeCompare(b.addr));
  const sortedProtocolVenues = protocolVenues.sort();
  const protocolAdapterCandidate = sortedProtocolVenues.length >= 1 && sortedProtocolGaps.length === 0;

  return {
    tx: input.txHash ?? "",
    vaults: vaults.sort(),
    protocolVenues: sortedProtocolVenues,
    observedSwapVenues: sortedObservedSwaps,
    swapRouteGaps,
    swapVenues: sortedObservedSwaps.length,
    protocolVenueGaps: sortedProtocolGaps,
    unclassifiedEmitters: sortedUnclassified,
    protocolAdapterCandidate,
    fullyCovered: protocolAdapterCandidate
      && sortedProtocolGaps.length === 0
      && sortedUnclassified.length === 0
      && swapRouteGaps.length === 0
      && !hasUnassessedSwap,
    coverageScope: "receipt_log_emitters_only",
    routabilityScope: "production_listener_descriptors_receipt_only",
    comparability: "requires_trace",
    venues: venues.sort((a, b) => a.addr.localeCompare(b.addr)),
  };
}

function observedRolesFor(
  topic0s: string[],
  observedSwapFamilies: ObservedSwapFamily[],
): ObservedRole[] {
  const roles = new Set<ObservedRole>();
  if (observedSwapFamilies.length > 0) roles.add("swap");
  if (topic0s.some((topic0) => FLASHLOAN_EVENT_TOPICS.has(topic0))) roles.add("flashloan");
  if (topic0s.some((topic0) => NAMED_PROTOCOL_EVENT_TOPICS.has(topic0))) roles.add("protocol");
  if (topic0s.some((topic0) => TOKEN_TOPICS.has(topic0))) roles.add("token");
  if (roles.size === 0) roles.add("unclassified");
  return [...roles].sort();
}

function observedSwapFamiliesFor(topic0s: string[]): ObservedSwapFamily[] {
  return [...new Set(topic0s.map(observedSwapFamilyForTopic).filter(isObservedSwapFamily))].sort();
}

function observedSwapFamilyForTopic(topic0: string): ObservedSwapFamily | null {
  return OBSERVED_SWAP_TOPIC_FAMILIES.get(topic0)
    ?? (topic0.startsWith(CURVE_ROUTER_EXCHANGE_PREFIX) ? "curve" : null);
}

function assessProductionRoutability(
  family: ObservedSwapFamily,
): Pick<ObservedSwapVenue, "productionRoutability" | "reason" | "in_graph"> {
  const productionLineage = family === "pancake-v3"
    ? "univ3"
    : family === "fluid"
      ? "fluid-dex"
      : family;
  if (!PRODUCTION_SWAP_LINEAGES.has(productionLineage)) {
    return {
      productionRoutability: "not_routable",
      reason: family === "balancer-v2" ? "no_swap_adapter" : "no_adapter",
      in_graph: false,
    };
  }
  return {
    productionRoutability: "unassessed",
    reason: "factory_or_routing_graph_not_attested",
    in_graph: null,
  };
}

function hasRegisteredProtocolEvent(
  entry: (typeof POOL_REGISTRY)[number] | undefined,
  topic0s: string[],
): boolean {
  if (!entry) return false;
  if (entry.adapter === "erc4626") {
    return topic0s.some((topic0) => ERC4626_EVENT_TOPICS.has(topic0));
  }
  return entry.fixedSlotKind === "protocol"
    && topic0s.some((topic0) => NAMED_PROTOCOL_EVENT_TOPICS.has(topic0));
}

function compareObservedSwaps(a: ObservedSwapVenue, b: ObservedSwapVenue): number {
  return a.addr.localeCompare(b.addr) || a.family.localeCompare(b.family);
}

function isObservedSwapFamily(value: ObservedSwapFamily | null): value is ObservedSwapFamily {
  return value !== null;
}

function topic0Of(topics: unknown): string {
  return Array.isArray(topics) && typeof topics[0] === "string" ? lower(topics[0]) : "";
}
