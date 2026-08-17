import "../../../listener/src/adapters/index.js";
import { listDescriptors } from
  "../../../listener/src/adapters/registry.js";
import { ADDR as LISTENER_ADDR } from "../../../listener/src/shared/constants/addresses.js";
import { POOL_REGISTRY } from "../../../listener/src/searcher/planner/token-graph.js";
import { lower, TOPICS } from "../registry/protocols.js";
import type { VenueScanInput } from "./venue-evidence.js";

/**
 * Per-transaction receipt evidence. Topic recognition says what happened; it does not by itself prove
 * that the production listener can route the emitting venue. Swap routability is assessed separately
 * against the listener's adapter descriptors and remains unassessed when receipt-only input cannot
 * attest factory identity or routing-graph membership.
 */

export type ObservedRole =
  | "flashloan"
  | "liquidity"
  | "protocol"
  | "swap"
  | "token"
  | "unclassified";

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
  | "emitter_or_routing_graph_not_attested"
  | "factory_or_routing_graph_not_attested"
  | "no_adapter"
  | "no_swap_adapter"
  | "routing_attested";

export type ObservedFundingFamily = "aave-v3" | "balancer-v2" | "morpho" | "univ3";
export type FundingIdentity = "attested" | "unassessed";
export type FundingIdentityReason =
  | "canonical_address"
  | "emitter_identity_not_attested"
  | "factory_identity_not_attested"
  | "known_singleton_address";
export type FundingRoutabilityReason =
  | "flash_adapter_attested"
  | "funding_identity_not_attested"
  | "no_flash_adapter";

// Topic-to-family recognition is receipt evidence only. Production capability is derived below from
// listener adapter descriptors, never from this map.
export const OBSERVED_SWAP_TOPIC_FAMILIES: ReadonlyMap<string, ObservedSwapFamily> = new Map<
  string,
  ObservedSwapFamily
>(
  [
    [lower(TOPICS.univ2Swap), "univ2"],
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

export const OBSERVED_FUNDING_TOPIC_FAMILIES: ReadonlyMap<string, ObservedFundingFamily> = new Map(
  [
    [lower(TOPICS.aaveV3FlashLoan), "aave-v3"],
    [lower(TOPICS.balancerV2FlashLoan), "balancer-v2"],
    [lower(TOPICS.morphoFlashLoan), "morpho"],
    [lower(TOPICS.univ3Flash), "univ3"],
  ] as const,
);

export const FLASHLOAN_EVENT_TOPICS: ReadonlySet<string> = new Set(
  OBSERVED_FUNDING_TOPIC_FAMILIES.keys(),
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

const LIQUIDITY_EVENT_TOPICS: ReadonlySet<string> = new Set(
  [
    TOPICS.balancerV2PoolBalanceChanged,
    TOPICS.univ2Mint,
    TOPICS.univ2Burn,
    TOPICS.univ3Mint,
    TOPICS.univ3Burn,
    TOPICS.univ4ModifyLiquidity,
  ]
    .map(lower),
);

const UNIV2_SYNC_TOPIC = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1";

// Recognized receipt events that are intentionally not promoted to a loop role by this classifier.
const RECOGNIZED_AUXILIARY_TOPICS: ReadonlySet<string> = new Set(
  [
    UNIV2_SYNC_TOPIC,
    TOPICS.univ4Initialize,
    TOPICS.morphoBorrow,
    TOPICS.morphoRepay,
    TOPICS.morphoSupply,
    TOPICS.morphoWithdraw,
    TOPICS.morphoSupplyCollateral,
    TOPICS.morphoWithdrawCollateral,
    TOPICS.aaveV3Borrow,
    TOPICS.aaveV3Repay,
  ].map(lower),
);

// These known credit events still require a trace before a transaction can be called route-complete.
// Sync/Initialize are benign pool bookkeeping and remain recognized without creating a trace gap.
const TRACE_REQUIRED_AUXILIARY_TOPICS: ReadonlySet<string> = new Set(
  [
    TOPICS.morphoBorrow,
    TOPICS.morphoRepay,
    TOPICS.morphoSupply,
    TOPICS.morphoWithdraw,
    TOPICS.morphoSupplyCollateral,
    TOPICS.morphoWithdrawCollateral,
    TOPICS.aaveV3Borrow,
    TOPICS.aaveV3Repay,
  ].map(lower),
);

const REGISTERED_ENTRY_BY_ADDRESS = new Map(
  POOL_REGISTRY.flatMap((entry) => [
    [lower(entry.address), entry] as const,
    ...(entry.receiptEmitters ?? []).map((emitter) => [lower(emitter), entry] as const),
  ]),
);

const REGISTERED_POOL_ENTRY_BY_ADDRESS = new Map(
  POOL_REGISTRY.map((entry) => [lower(entry.address), entry] as const),
);

/** Backward-compatible export used by callers that need our registered ERC4626 vault set. */
export const OUR_VAULT_ADDRESSES: ReadonlySet<string> = new Set(
  POOL_REGISTRY.filter((entry) => entry.adapter === "erc4626").map((entry) => lower(entry.address)),
);

const PRODUCTION_SWAP_LINEAGES: ReadonlySet<string> = new Set(
  listDescriptors()
    .filter((descriptor) => descriptor.edgeKind === "swap" && descriptor.action === "swap")
    .map((descriptor) => descriptor.lineage),
);

const PRODUCTION_FLASH_LINEAGES: ReadonlySet<string> = new Set(
  listDescriptors()
    .filter((descriptor) => descriptor.edgeKind === "flash" && descriptor.action === "flash")
    .map((descriptor) => descriptor.lineage),
);

const PRODUCTION_PROTOCOL_ACTIONS: ReadonlySet<string> = new Set(
  listDescriptors()
    .filter((descriptor) => descriptor.edgeKind === "protocol")
    .map((descriptor) => `${descriptor.lineage}:${descriptor.action}`),
);

const FUNDING_ADAPTER_LINEAGE: Partial<Record<ObservedFundingFamily, string>> = {
  "balancer-v2": "balancer-flash",
  morpho: "morpho-flash",
};

// Ethereum mainnet singleton/canonical identities. Balancer and Morpho are shared with production;
// Aave is analysis-only because production has no Aave flash adapter.
const AAVE_V3_POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
const ATTESTED_FUNDING_ADDRESS: Partial<Record<ObservedFundingFamily, string>> = {
  "aave-v3": AAVE_V3_POOL,
  "balancer-v2": lower(LISTENER_ADDR.BALANCER_VAULT),
  morpho: lower(LISTENER_ADDR.MORPHO),
};

export interface ObservedSwapVenue {
  addr: string;
  family: ObservedSwapFamily;
  topic0s: string[];
  productionRoutability: ProductionRoutability;
  reason: ProductionRoutabilityReason;
  /** Bundle-postmortem-compatible graph fact: null means receipt-only evidence cannot assess identity. */
  in_graph: boolean | null;
}

export interface ObservedFundingVenue {
  addr: string;
  family: ObservedFundingFamily;
  topic0s: string[];
  fundingIdentity: FundingIdentity;
  identityReason: FundingIdentityReason;
  productionRoutability: ProductionRoutability;
  reason: FundingRoutabilityReason;
}

export interface ObservedVenue {
  addr: string;
  observedRoles: ObservedRole[];
  observedSwapFamilies: ObservedSwapFamily[];
  observedFundingFamilies: ObservedFundingFamily[];
  topic0s: string[];
  /** Topics not recognized by any role or known auxiliary-event registry. */
  unrecognizedTopic0s: string[];
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
  /** Observed flashloan events with independent identity and production-adapter assessments. */
  observedFundingVenues: ObservedFundingVenue[];
  /** Flashloan observations whose emitter identity cannot be attested from receipt-only evidence. */
  fundingIdentityGaps: ObservedFundingVenue[];
  /** Identity-attested funding venues for which production has no flash adapter. */
  fundingRouteGaps: ObservedFundingVenue[];
  /** Distinct emitter addresses with at least one observed swap event. */
  observedSwapEmitterCount: number;
  /** Named protocol events whose emitter has no matching registered adapter. */
  protocolVenueGaps: Array<{ addr: string; topic0: string }>;
  /** One entry per unrecognized topic (or role-less known topic) needing trace inspection. */
  unclassifiedEmitters: Array<{ addr: string; topic0: string }>;
  /** Receipt evidence maps every named protocol leg to an adapter. Still requires a trace. */
  protocolAdapterCandidate: boolean;
  /**
   * True only when at least one named protocol event is adapter-matched, every named protocol event is
   * matched, every swap/funding observation is production-routable, and no receipt evidence is
   * unclassified or identity-unassessed. It is never proof of trace comparability or loop closure.
   */
  receiptRouteCoverageComplete: boolean;
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
    // Anonymous events have no topic0. Preserve the emitter conservatively instead of silently
    // removing receipt evidence and making route coverage look complete.
    const topic0 = topic0Of(log.topics) ?? "";
    const topics = topicsByEmitter.get(addr);
    if (topics) topics.add(topic0);
    else topicsByEmitter.set(addr, new Set([topic0]));
  }

  const venues: ObservedVenue[] = [];
  const observedSwapVenues: ObservedSwapVenue[] = [];
  const observedFundingVenues: ObservedFundingVenue[] = [];
  const vaults = new Set<string>();
  const protocolVenues = new Set<string>();
  const protocolVenueGaps: Array<{ addr: string; topic0: string }> = [];
  const unclassifiedEmitters: Array<{ addr: string; topic0: string }> = [];

  for (const [addr, topicSet] of topicsByEmitter) {
    const topic0s = [...topicSet].sort();
    const observedSwapFamilies = observedSwapFamiliesFor(topic0s);
    const observedFundingFamilies = observedFundingFamiliesFor(topic0s);
    const unrecognizedTopic0s = topic0s.filter((topic0) => !isRecognizedTopic(topic0));
    const traceRequiredTopic0s = topic0s.filter(
      (topic0) => unrecognizedTopic0s.includes(topic0) || TRACE_REQUIRED_AUXILIARY_TOPICS.has(topic0),
    );
    const observedRoles = observedRolesFor(
      topic0s,
      observedSwapFamilies,
      observedFundingFamilies,
      traceRequiredTopic0s,
    );
    venues.push({
      addr,
      observedRoles,
      observedSwapFamilies,
      observedFundingFamilies,
      topic0s,
      unrecognizedTopic0s,
    });

    for (const family of observedSwapFamilies) {
      observedSwapVenues.push({
        addr,
        family,
        topic0s: topic0s.filter((topic0) => observedSwapFamilyForTopic(topic0) === family),
        ...assessProductionRoutability(addr, family),
      });
    }

    for (const family of observedFundingFamilies) {
      observedFundingVenues.push({
        addr,
        family,
        topic0s: topic0s.filter((topic0) => OBSERVED_FUNDING_TOPIC_FAMILIES.get(topic0) === family),
        ...assessFundingVenue(addr, family),
      });
    }

    const namedProtocolTopics = topic0s.filter((topic0) => NAMED_PROTOCOL_EVENT_TOPICS.has(topic0));
    if (namedProtocolTopics.length > 0) {
      const entry = REGISTERED_ENTRY_BY_ADDRESS.get(addr);
      const supportedProtocolTopics = namedProtocolTopics.filter((topic0) =>
        hasRegisteredProtocolEvent(entry, topic0)
      );
      if (supportedProtocolTopics.length > 0) {
        protocolVenues.add(addr);
        if (entry?.adapter === "erc4626") vaults.add(addr);
      }
      for (const topic0 of namedProtocolTopics) {
        if (!hasRegisteredProtocolEvent(entry, topic0)) {
          protocolVenueGaps.push({ addr, topic0 });
        }
      }
    }

    for (const topic0 of traceRequiredTopic0s) {
      unclassifiedEmitters.push({ addr, topic0 });
    }
  }

  const sortedObservedSwaps = observedSwapVenues.sort(compareObservedSwaps);
  const swapRouteGaps = sortedObservedSwaps.filter(
    (venue) => venue.productionRoutability === "not_routable",
  );
  const hasUnassessedSwap = sortedObservedSwaps.some(
    (venue) => venue.productionRoutability === "unassessed",
  );
  const sortedObservedFunding = observedFundingVenues.sort(compareObservedFunding);
  const fundingIdentityGaps = sortedObservedFunding.filter(
    (venue) => venue.fundingIdentity === "unassessed",
  );
  const fundingRouteGaps = sortedObservedFunding.filter(
    (venue) => venue.productionRoutability === "not_routable",
  );
  const hasUnassessedFunding = sortedObservedFunding.some(
    (venue) => venue.productionRoutability === "unassessed",
  );
  const sortedProtocolGaps = protocolVenueGaps.sort(compareEmitterTopic);
  const sortedUnclassified = unclassifiedEmitters.sort(compareEmitterTopic);
  const sortedProtocolVenues = [...protocolVenues].sort();
  const protocolAdapterCandidate = sortedProtocolVenues.length >= 1 && sortedProtocolGaps.length === 0;

  return {
    tx: input.txHash ?? "",
    vaults: [...vaults].sort(),
    protocolVenues: sortedProtocolVenues,
    observedSwapVenues: sortedObservedSwaps,
    swapRouteGaps,
    observedFundingVenues: sortedObservedFunding,
    fundingIdentityGaps,
    fundingRouteGaps,
    observedSwapEmitterCount: new Set(sortedObservedSwaps.map((venue) => venue.addr)).size,
    protocolVenueGaps: sortedProtocolGaps,
    unclassifiedEmitters: sortedUnclassified,
    protocolAdapterCandidate,
    receiptRouteCoverageComplete: protocolAdapterCandidate
      && sortedProtocolGaps.length === 0
      && sortedUnclassified.length === 0
      && swapRouteGaps.length === 0
      && !hasUnassessedSwap
      && fundingIdentityGaps.length === 0
      && fundingRouteGaps.length === 0
      && !hasUnassessedFunding,
    coverageScope: "receipt_log_emitters_only",
    routabilityScope: "production_listener_descriptors_receipt_only",
    comparability: "requires_trace",
    venues: venues.sort((a, b) => a.addr.localeCompare(b.addr)),
  };
}

function observedRolesFor(
  topic0s: string[],
  observedSwapFamilies: ObservedSwapFamily[],
  observedFundingFamilies: ObservedFundingFamily[],
  traceRequiredTopic0s: string[],
): ObservedRole[] {
  const roles = new Set<ObservedRole>();
  if (observedSwapFamilies.length > 0) roles.add("swap");
  if (observedFundingFamilies.length > 0) roles.add("flashloan");
  if (topic0s.some((topic0) => LIQUIDITY_EVENT_TOPICS.has(topic0))) roles.add("liquidity");
  if (topic0s.some((topic0) => NAMED_PROTOCOL_EVENT_TOPICS.has(topic0))) roles.add("protocol");
  if (topic0s.some((topic0) => TOKEN_TOPICS.has(topic0))) roles.add("token");
  if (roles.size === 0 || traceRequiredTopic0s.length > 0) roles.add("unclassified");
  return [...roles].sort();
}

function observedSwapFamiliesFor(topic0s: string[]): ObservedSwapFamily[] {
  return [...new Set(topic0s.map(observedSwapFamilyForTopic).filter(isObservedSwapFamily))].sort();
}

function observedSwapFamilyForTopic(topic0: string): ObservedSwapFamily | null {
  return OBSERVED_SWAP_TOPIC_FAMILIES.get(topic0)
    ?? (topic0.startsWith(CURVE_ROUTER_EXCHANGE_PREFIX) ? "curve" : null);
}

function observedFundingFamiliesFor(topic0s: string[]): ObservedFundingFamily[] {
  return [...new Set(topic0s.map((topic0) => OBSERVED_FUNDING_TOPIC_FAMILIES.get(topic0)))].filter(
    isObservedFundingFamily,
  ).sort();
}

function isRecognizedTopic(topic0: string): boolean {
  return observedSwapFamilyForTopic(topic0) !== null
    || OBSERVED_FUNDING_TOPIC_FAMILIES.has(topic0)
    || NAMED_PROTOCOL_EVENT_TOPICS.has(topic0)
    || TOKEN_TOPICS.has(topic0)
    || LIQUIDITY_EVENT_TOPICS.has(topic0)
    || RECOGNIZED_AUXILIARY_TOPICS.has(topic0);
}

function assessProductionRoutability(
  addr: string,
  family: ObservedSwapFamily,
): Pick<ObservedSwapVenue, "productionRoutability" | "reason" | "in_graph"> {
  const productionLineage = family === "pancake-v3"
    ? "univ3"
    : family === "fluid"
      ? "fluid-dex"
      : family;

  // Balancer V2 is a canonical singleton. A matching Swap from any other emitter is only a
  // topic observation until its identity is established by trace/registry evidence.
  if (family === "balancer-v2" && addr !== lower(LISTENER_ADDR.BALANCER_VAULT)) {
    return {
      productionRoutability: "unassessed",
      reason: "emitter_or_routing_graph_not_attested",
      in_graph: null,
    };
  }

  // DODO is factory/pool based and production has no DODO registry. The event signature proves an
  // observed family, not that an arbitrary emitter is a real DODO pool.
  if (family === "dodo") {
    return {
      productionRoutability: "unassessed",
      reason: "factory_or_routing_graph_not_attested",
      in_graph: null,
    };
  }

  if (!PRODUCTION_SWAP_LINEAGES.has(productionLineage)) {
    return {
      productionRoutability: "not_routable",
      reason: family === "balancer-v2" ? "no_swap_adapter" : "no_adapter",
      in_graph: false,
    };
  }
  const registeredEntry = REGISTERED_POOL_ENTRY_BY_ADDRESS.get(addr);
  if (family === "fluid" && registeredEntry?.adapter === "fluid-dex") {
    return {
      productionRoutability: "routable",
      reason: "routing_attested",
      in_graph: true,
    };
  }
  return {
    productionRoutability: "unassessed",
    reason: family === "fluid"
      ? "emitter_or_routing_graph_not_attested"
      : "factory_or_routing_graph_not_attested",
    in_graph: null,
  };
}

function assessFundingVenue(
  addr: string,
  family: ObservedFundingFamily,
): Pick<
  ObservedFundingVenue,
  "fundingIdentity" | "identityReason" | "productionRoutability" | "reason"
> {
  const attestedAddress = ATTESTED_FUNDING_ADDRESS[family];
  if (!attestedAddress || addr !== attestedAddress) {
    return {
      fundingIdentity: "unassessed",
      identityReason: family === "univ3"
        ? "factory_identity_not_attested"
        : "emitter_identity_not_attested",
      productionRoutability: "unassessed",
      reason: "funding_identity_not_attested",
    };
  }

  const productionLineage = FUNDING_ADAPTER_LINEAGE[family];
  const hasFlashAdapter = productionLineage !== undefined
    && PRODUCTION_FLASH_LINEAGES.has(productionLineage);
  return {
    fundingIdentity: "attested",
    identityReason: family === "morpho" ? "canonical_address" : "known_singleton_address",
    productionRoutability: hasFlashAdapter ? "routable" : "not_routable",
    reason: hasFlashAdapter ? "flash_adapter_attested" : "no_flash_adapter",
  };
}

function hasRegisteredProtocolEvent(
  entry: (typeof POOL_REGISTRY)[number] | undefined,
  topic0: string,
): boolean {
  if (!entry) return false;
  switch (entry.adapter) {
    case "erc4626":
      return topic0 === lower(TOPICS.erc4626Deposit)
        ? hasProductionProtocolAction("erc4626", "deposit")
        : topic0 === lower(TOPICS.erc4626Withdraw)
          && hasProductionProtocolAction("erc4626", "redeem");
    case "psm":
      return PSM_EVENT_TOPICS.has(topic0) && hasProductionProtocolAction("psm", "convert");
    case "metronome-hgusdc":
      return topic0 === lower(TOPICS.erc4626Withdraw)
        && hasProductionProtocolAction("metronome", "redeem");
    default:
      return false;
  }
}

function hasProductionProtocolAction(lineage: string, action: string): boolean {
  return PRODUCTION_PROTOCOL_ACTIONS.has(`${lineage}:${action}`);
}

function compareObservedSwaps(a: ObservedSwapVenue, b: ObservedSwapVenue): number {
  return a.addr.localeCompare(b.addr) || a.family.localeCompare(b.family);
}

function compareObservedFunding(a: ObservedFundingVenue, b: ObservedFundingVenue): number {
  return a.addr.localeCompare(b.addr) || a.family.localeCompare(b.family);
}

function compareEmitterTopic(
  a: { addr: string; topic0: string },
  b: { addr: string; topic0: string },
): number {
  return a.addr.localeCompare(b.addr) || a.topic0.localeCompare(b.topic0);
}

function isObservedSwapFamily(value: ObservedSwapFamily | null): value is ObservedSwapFamily {
  return value !== null;
}

function isObservedFundingFamily(
  value: ObservedFundingFamily | undefined,
): value is ObservedFundingFamily {
  return value !== undefined;
}

function topic0Of(topics: unknown): string {
  return Array.isArray(topics) && typeof topics[0] === "string" ? lower(topics[0]) : "";
}
