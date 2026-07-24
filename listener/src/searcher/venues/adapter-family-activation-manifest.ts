import type { AdapterFamilyRegistry } from "./adapter-family-registry.js";
import type {
  AdapterFamily,
  CreditAdapterFamily,
  ProtocolConversionAdapter,
  RouteLegAdapter,
  SwapAdapter,
} from "./route-leg-adapter.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "./production-registry.js";

export interface AdapterFamilyDiscoveryInventory {
  readonly candidateSources: readonly string[];
  readonly candidateAddressHints: readonly string[];
  readonly eventTopicCount: number;
  readonly callSelectorCount: number;
  readonly hasAddressMatcher: boolean;
  readonly hasObservedMatcher: boolean;
  readonly addressMatcherVersion: string | null;
  readonly observedMatcherVersion: string | null;
  readonly hasIdentityResolver: boolean;
}

export interface AdapterFamilyPricingInventory {
  readonly hasPreparedCapability: boolean;
  readonly hasPreparedQuote: boolean;
  readonly hasPricingStateCapability: boolean;
}

export interface AdapterFamilyRouteInventory {
  readonly poolAdapters: readonly string[];
  readonly edgeAdapterIds: readonly string[];
  readonly allowedTaxonomy: readonly string[];
  readonly requiresProtocolEdgesFlag: boolean;
  readonly staticDeclaredVenueCount: number;
  readonly creditActionAdapterIds: readonly string[];
  readonly discovery: AdapterFamilyDiscoveryInventory | null;
  readonly pricing: AdapterFamilyPricingInventory | null;
}

export interface AdapterFamilyFundingInventory {
  readonly actionAdapterId: string;
  readonly lineage: string;
  readonly target: string;
  readonly liquidityHolder: string;
  readonly repayment: string;
  readonly paramShape: string;
  readonly planningPriority: number;
  readonly liquidityPriority: number;
}

export interface AdapterFamilyActivationRow {
  readonly familyId: string;
  readonly kind: AdapterFamily["kind"];
  readonly activation: "active_family";
  readonly ownedActionAdapterIds: readonly string[];
  readonly requiredInfraActionAdapterIds: readonly string[];
  readonly route: AdapterFamilyRouteInventory | null;
  readonly funding: AdapterFamilyFundingInventory | null;
}

export interface AdapterFamilyActivationManifest {
  readonly schemaVersion: 1;
  readonly familyOrder: readonly string[];
  readonly routeFamilyOrder: readonly string[];
  readonly kindCounts: Readonly<Record<AdapterFamily["kind"], number>>;
  readonly staticDeclaredVenueCount: number;
  readonly fundingPlanningOrder: readonly string[];
  readonly fundingLiquidityOrder: readonly string[];
  readonly defaultFundingFamilyId: string;
  readonly defaultFundingActionAdapterId: string;
  readonly families: readonly AdapterFamilyActivationRow[];
}

function discoveryInventory(
  adapter: RouteLegAdapter,
): AdapterFamilyDiscoveryInventory | null {
  if (!adapter.discovery) return null;
  return Object.freeze({
    candidateSources: Object.freeze([...adapter.discovery.candidateSources]),
    candidateAddressHints: Object.freeze([
      ...(adapter.discovery.candidateAddressHints ?? []),
    ]),
    eventTopicCount: adapter.discovery.eventTopics.length,
    callSelectorCount: adapter.discovery.callSelectors.length,
    hasAddressMatcher: adapter.discovery.candidateFromAddress !== undefined,
    hasObservedMatcher: adapter.discovery.candidateFromObservedCall !== undefined,
    addressMatcherVersion: adapter.discovery.addressMatcherVersion ?? null,
    observedMatcherVersion: adapter.discovery.observedMatcherVersion ?? null,
    hasIdentityResolver: adapter.discoveryIdentityResolver !== undefined,
  });
}

function pricingInventory(
  adapter: RouteLegAdapter,
): AdapterFamilyPricingInventory | null {
  if (adapter.kind !== "swap" && adapter.kind !== "protocol-conversion") return null;
  const pricingState = (adapter as SwapAdapter | ProtocolConversionAdapter).pricingState;
  return Object.freeze({
    hasPreparedCapability: adapter.prepared !== null,
    hasPreparedQuote: adapter.prepared?.quote !== null &&
      adapter.prepared?.quote !== undefined,
    hasPricingStateCapability: pricingState !== null && pricingState !== undefined,
  });
}

function routeInventory(adapter: RouteLegAdapter): AdapterFamilyRouteInventory {
  const protocol = adapter.kind === "protocol-conversion"
    ? adapter as ProtocolConversionAdapter
    : null;
  return Object.freeze({
    poolAdapters: Object.freeze([...adapter.poolAdapters]),
    edgeAdapterIds: Object.freeze([...adapter.edgeAdapterIds]),
    allowedTaxonomy: Object.freeze(adapter.allowedTaxonomy.map(
      (taxonomy) => `${taxonomy.slotKind}:${taxonomy.protocolAction ?? "-"}`,
    )),
    requiresProtocolEdgesFlag: adapter.requiresProtocolEdgesFlag,
    staticDeclaredVenueCount: protocol?.declaredVenues.length ?? 0,
    creditActionAdapterIds: Object.freeze(
      adapter.kind === "credit"
        ? [...(adapter as CreditAdapterFamily).creditActionAdapterIds]
        : [],
    ),
    discovery: discoveryInventory(adapter),
    pricing: pricingInventory(adapter),
  });
}

function activationRow(family: AdapterFamily): AdapterFamilyActivationRow {
  if (family.kind === "flash-loan") {
    return Object.freeze({
      familyId: family.id,
      kind: family.kind,
      activation: "active_family" as const,
      ownedActionAdapterIds: Object.freeze([...family.ownedActionAdapterIds]),
      requiredInfraActionAdapterIds: Object.freeze([
        ...family.requiredInfraActionAdapterIds,
      ]),
      route: null,
      funding: Object.freeze({
        actionAdapterId: family.funding.actionAdapterId,
        lineage: family.funding.lineage,
        target: family.funding.target,
        liquidityHolder: family.funding.liquidityHolder,
        repayment: family.funding.repayment,
        paramShape: family.funding.paramShape,
        planningPriority: family.funding.planningPriority,
        liquidityPriority: family.funding.liquidityPriority,
      }),
    });
  }
  return Object.freeze({
    familyId: family.id,
    kind: family.kind,
    activation: "active_family" as const,
    ownedActionAdapterIds: Object.freeze([...family.ownedActionAdapterIds]),
    requiredInfraActionAdapterIds: Object.freeze([
      ...family.requiredInfraActionAdapterIds,
    ]),
    route: routeInventory(family),
    funding: null,
  });
}

/**
 * Generate the activation inventory exclusively from the universal registry.
 * The frozen baseline fixture is a comparison oracle, never an input here.
 */
export function deriveAdapterFamilyActivationManifest(
  registry: AdapterFamilyRegistry,
): AdapterFamilyActivationManifest {
  const families = registry.list();
  const fundingPlanning = registry.funding();
  const fundingLiquidity = [...fundingPlanning].sort((a, b) =>
    a.funding.liquidityPriority - b.funding.liquidityPriority ||
    a.id.localeCompare(b.id)
  );
  const defaultFunding = registry.defaultFunding();
  const counts: Record<AdapterFamily["kind"], number> = {
    swap: 0,
    "protocol-conversion": 0,
    "flash-loan": 0,
    credit: 0,
    liquidity: 0,
  };
  for (const family of families) counts[family.kind] += 1;
  const rows = Object.freeze(families.map(activationRow));

  return Object.freeze({
    schemaVersion: 1 as const,
    familyOrder: Object.freeze(rows.map((row) => row.familyId)),
    routeFamilyOrder: Object.freeze(
      registry.routes().list().map((family) => family.id),
    ),
    kindCounts: Object.freeze(counts),
    staticDeclaredVenueCount: rows.reduce(
      (sum, row) => sum + (row.route?.staticDeclaredVenueCount ?? 0),
      0,
    ),
    fundingPlanningOrder: Object.freeze(
      fundingPlanning.map((family) => family.id),
    ),
    fundingLiquidityOrder: Object.freeze(
      fundingLiquidity.map((family) => family.id),
    ),
    defaultFundingFamilyId: defaultFunding.id,
    defaultFundingActionAdapterId: defaultFunding.funding.actionAdapterId,
    families: rows,
  });
}

export const PRODUCTION_ADAPTER_FAMILY_ACTIVATION_MANIFEST =
  deriveAdapterFamilyActivationManifest(PRODUCTION_ADAPTER_FAMILIES);
