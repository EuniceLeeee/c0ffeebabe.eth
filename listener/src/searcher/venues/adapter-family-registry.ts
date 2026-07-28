import { ethers } from "ethers";
import type { PoolEntry, TokenEdge } from "../planner/token-graph.js";
import type {
  AdapterFamily,
  CreditAdapterFamily,
  DiscoverableRouteLegAdapter,
  ExecutionFamilyId,
  FlashLoanAdapterFamily,
  LiquidityAdapterFamily,
  ProtocolConversionAdapter,
  RouteLegAdapter,
  SwapAdapter,
} from "./route-leg-adapter.js";
import { RouteLegRegistry } from "./route-leg-registry.js";
import type {
  RegisteredBlockScanStateFamily,
} from "./blockscan-state-capability.js";
import { registerBlockScanStateFamily } from "./blockscan-state-capability.js";
import type { RegisteredFundingFamily } from "./funding/funding-capability.js";
import {
  isKnownVenueIdentitySource,
  isKnownVenueId,
  isNonemptyRegistryId,
} from "./registry-ids.js";
import { LandedEventRegistry } from "./landed-event-registry.js";
import { VictimModelRegistry } from "./victim-model-registry.js";
import { LandedPoolDiscoveryRegistry } from "./landed-pool-discovery.js";
import { routeInstanceKey } from "./route-instance-identity.js";
import type { OracleVictimDescriptor } from "../detector/victim-effect.js";
import type { VictimModelDescriptor } from "./victim-model-registry.js";

export type PricingLane = "swap" | "protocol-conversion";

/**
 * The sole high-level production registration surface. Every consumer obtains
 * a typed projection from this object; category-specific arrays are never
 * independently registered.
 */
export class AdapterFamilyRegistry {
  private readonly byId = new Map<ExecutionFamilyId, AdapterFamily>();
  private readonly routeRegistry: RouteLegRegistry;
  private readonly swapFamilies: readonly SwapAdapter[];
  private readonly protocolFamilies: readonly ProtocolConversionAdapter[];
  private readonly flashFamilies: readonly FlashLoanAdapterFamily[];
  private readonly creditFamilies: readonly CreditAdapterFamily[];
  private readonly liquidityFamilies: readonly LiquidityAdapterFamily[];
  private readonly discoverableRouteFamilies: readonly DiscoverableRouteLegAdapter[];
  private readonly landedEventRegistry: LandedEventRegistry;
  private readonly victimModelRegistry: VictimModelRegistry;
  private readonly oracleVictimDescriptors: readonly OracleVictimDescriptor[];
  private readonly landedPoolDiscoveryRegistry: LandedPoolDiscoveryRegistry;
  private readonly ownedActionOwners = new Map<string, ExecutionFamilyId>();
  private readonly registeredVenueOwners = new Map<string, ExecutionFamilyId>();
  private readonly registeredIdentitySourceOwners = new Map<string, ExecutionFamilyId>();

  constructor(families: readonly AdapterFamily[]) {
    const swaps: SwapAdapter[] = [];
    const protocols: ProtocolConversionAdapter[] = [];
    const flash: FlashLoanAdapterFamily[] = [];
    const credit: CreditAdapterFamily[] = [];
    const liquidity: LiquidityAdapterFamily[] = [];
    const routes: RouteLegAdapter[] = [];

    for (const family of families) {
      this.registerBase(family);
      switch (family.kind) {
        case "swap":
          assertRoutePricingCapability(family);
          swaps.push(family);
          routes.push(family);
          break;
        case "protocol-conversion":
          assertRoutePricingCapability(family);
          protocols.push(family);
          routes.push(family);
          break;
        case "flash-loan":
          assertFlashCapability(family);
          flash.push(family);
          break;
        case "credit":
          credit.push(family);
          routes.push(family);
          break;
        case "liquidity":
          liquidity.push(family);
          routes.push(family);
          break;
      }
    }

    assertRouteDiscoveryDeclarations(routes);
    assertRouteIdentityDeclarations(
      routes,
      this.registeredVenueOwners,
      this.registeredIdentitySourceOwners,
    );
    assertProtocolVenueDeclarations(protocols);
    this.routeRegistry = new RouteLegRegistry(routes);
    this.swapFamilies = Object.freeze(swaps);
    this.protocolFamilies = Object.freeze(protocols);
    this.flashFamilies = Object.freeze(
      flash.sort((a, b) =>
        a.funding.planningPriority - b.funding.planningPriority ||
        a.id.localeCompare(b.id)
      ),
    );
    this.creditFamilies = Object.freeze(credit);
    this.liquidityFamilies = Object.freeze(liquidity);
    this.discoverableRouteFamilies = Object.freeze(
      routes.filter(isDiscoverableRoute),
    );
    this.oracleVictimDescriptors = collectOracleVictimDescriptors(routes);
    // These projections are derived only after every swap declaration has
    // passed its family-local validation. No central per-family table exists.
    this.landedEventRegistry = new LandedEventRegistry(this.swapFamilies);
    this.victimModelRegistry = VictimModelRegistry.fromSwapFamilies(
      this.swapFamilies,
      oracleVictimModels(this.oracleVictimDescriptors),
    );
    this.landedPoolDiscoveryRegistry = new LandedPoolDiscoveryRegistry(
      this.swapFamilies,
      this.landedEventRegistry,
    );
  }

  list(): readonly AdapterFamily[] {
    return [...this.byId.values()];
  }

  forFamily(id: ExecutionFamilyId): AdapterFamily {
    const family = this.byId.get(id);
    if (!family) throw new Error(`adapter-family registry: unsupported family ${id}`);
    return family;
  }

  routes(): RouteLegRegistry {
    return this.routeRegistry;
  }

  swaps(): readonly SwapAdapter[] {
    return this.swapFamilies;
  }

  landedEvents(): LandedEventRegistry {
    return this.landedEventRegistry;
  }

  victimModels(): VictimModelRegistry {
    return this.victimModelRegistry;
  }

  oracleVictims(): readonly OracleVictimDescriptor[] {
    return this.oracleVictimDescriptors;
  }

  landedPoolDiscovery(): LandedPoolDiscoveryRegistry {
    return this.landedPoolDiscoveryRegistry;
  }

  protocols(): readonly ProtocolConversionAdapter[] {
    return this.protocolFamilies;
  }

  /**
   * Families whose baseline graph is sourced by the mature DEX universe or
   * by code-owned declared venues. This is the registry-derived replacement
   * for main recognizing univ2/univ3 or protocol IDs.
   */
  registryBackedDiscoveryFamilies(
    protocolEdgesEnabled: boolean,
  ): readonly RouteLegAdapter[] {
    return Object.freeze([
      ...this.swapFamilies.filter((family) =>
        family.matureDexUniverseDiscovery === true
      ),
      ...this.protocolFamilies.filter((family) =>
        family.declaredVenues.length > 0 &&
        (!family.requiresProtocolEdgesFlag || protocolEdgesEnabled)
      ),
    ]);
  }

  /**
   * Pool adapters owned by the existing factory/active-pool discovery lane.
   * Factory roots remain identity evidence; this projection is the only
   * runtime-support half of that join.
   */
  matureDexUniversePoolAdapters(): readonly PoolEntry["adapter"][] {
    return Object.freeze([
      ...new Set(
        this.swapFamilies
          .filter((family) => family.matureDexUniverseDiscovery === true)
          .flatMap((family) => family.poolAdapters),
      ),
    ]);
  }

  credits(): readonly CreditAdapterFamily[] {
    return this.creditFamilies;
  }

  liquidities(): readonly LiquidityAdapterFamily[] {
    return this.liquidityFamilies;
  }

  /** All swap/protocol/credit/liquidity families using the one admission coordinator. */
  discoverableRoutes(): readonly DiscoverableRouteLegAdapter[] {
    return this.discoverableRouteFamilies;
  }

  pricing(lane: PricingLane): readonly (SwapAdapter | ProtocolConversionAdapter)[] {
    return lane === "swap" ? this.swapFamilies : this.protocolFamilies;
  }

  blockScanStateFamilies(): readonly RegisteredBlockScanStateFamily[] {
    return Object.freeze([
      ...this.swapFamilies.map((family): RegisteredBlockScanStateFamily => Object.freeze({
        ...registerBlockScanStateFamily({
          familyId: family.id,
          lane: "swap",
          capability: family.pricingState,
          ownsEdge: (edge: TokenEdge) =>
            family.edgeAdapterIds.includes(edge.adapterId),
        }),
      })),
      ...this.protocolFamilies.map(
        (family): RegisteredBlockScanStateFamily =>
          registerBlockScanStateFamily({
            familyId: family.id,
            lane: "protocol",
            capability: family.pricingState,
            ownsEdge: (edge: TokenEdge) =>
              family.edgeAdapterIds.includes(edge.adapterId),
          }),
      ),
    ]);
  }

  isBlockScanPricedEdge(edge: TokenEdge): boolean {
    return this.swapFamilies.some((family) => family.edgeAdapterIds.includes(edge.adapterId)) ||
      this.protocolFamilies.some((family) => family.edgeAdapterIds.includes(edge.adapterId));
  }

  funding(): readonly FlashLoanAdapterFamily[] {
    return this.flashFamilies;
  }

  /** Typed current-N funding projection derived from the sole family registry. */
  fundingStateFamilies(): readonly RegisteredFundingFamily[] {
    return Object.freeze(this.flashFamilies.map((family) => family.funding));
  }

  defaultFunding(): FlashLoanAdapterFamily {
    const family = this.flashFamilies[0];
    if (!family) throw new Error("adapter-family registry: no flash funding family");
    return family;
  }

  findFundingByAction(actionAdapterId: string): FlashLoanAdapterFamily | null {
    return this.flashFamilies.find(
      (family) => family.funding.actionAdapterId === actionAdapterId,
    ) ?? null;
  }

  fundingActionIds(): readonly string[] {
    return this.flashFamilies.map((family) => family.funding.actionAdapterId);
  }

  creditActionIds(): readonly string[] {
    return [...new Set(
      this.creditFamilies.flatMap((family) => family.creditActionAdapterIds),
    )];
  }

  actionIds(): {
    readonly owned: readonly string[];
    readonly requiredInfra: readonly string[];
  } {
    return Object.freeze({
      owned: Object.freeze([...this.ownedActionOwners.keys()]),
      requiredInfra: Object.freeze([
        ...new Set(
          this.list().flatMap((family) => family.requiredInfraActionAdapterIds),
        ),
      ]),
    });
  }

  ownerForAction(actionAdapterId: string): ExecutionFamilyId | null {
    return this.ownedActionOwners.get(actionAdapterId) ?? null;
  }

  isRegisteredVenueId(value: unknown): boolean {
    return isKnownVenueId(value) ||
      (typeof value === "string" && this.registeredVenueOwners.has(value));
  }

  isRegisteredIdentitySource(value: unknown): boolean {
    return isKnownVenueIdentitySource(value) ||
      (typeof value === "string" && this.registeredIdentitySourceOwners.has(value));
  }

  private registerBase(family: AdapterFamily): void {
    if (this.byId.has(family.id)) {
      throw new Error(`adapter-family registry: duplicate family ${family.id}`);
    }
    const local = new Set<string>();
    for (const id of family.ownedActionAdapterIds) {
      if (!id || local.has(id)) {
        throw new Error(`adapter-family registry: ${family.id} has duplicate/empty owned action ${id}`);
      }
      local.add(id);
      const prior = this.ownedActionOwners.get(id);
      if (prior) {
        throw new Error(
          `adapter-family registry: ActionAdapter ${id} owned by ${prior} and ${family.id}`,
        );
      }
      this.ownedActionOwners.set(id, family.id);
    }
    for (const id of family.requiredInfraActionAdapterIds) {
      if (!id || local.has(id)) {
        throw new Error(
          `adapter-family registry: ${family.id} misclassifies owned action ${id} as shared infra`,
        );
      }
    }
    this.byId.set(family.id, family);
  }
}

function assertRoutePricingCapability(
  family: SwapAdapter | ProtocolConversionAdapter,
): void {
  if (!family.pricingState) {
    throw new Error(
      `adapter-family registry: ${family.id} lacks production block-scan pricing capability`,
    );
  }
}

function assertFlashCapability(family: FlashLoanAdapterFamily): void {
  if (family.funding.familyId !== family.id) {
    throw new Error(
      `adapter-family registry: ${family.id} funding provider identity mismatch ` +
        family.funding.familyId,
    );
  }
  if (!family.ownedActionAdapterIds.includes(family.funding.actionAdapterId)) {
    throw new Error(
      `adapter-family registry: ${family.id} does not own funding action ` +
        family.funding.actionAdapterId,
    );
  }
  if (
    !Number.isSafeInteger(family.funding.planningPriority) ||
    !Number.isSafeInteger(family.funding.liquidityPriority)
  ) {
    throw new Error(`adapter-family registry: ${family.id} has invalid funding priority`);
  }
}

function assertProtocolVenueDeclarations(
  adapters: readonly ProtocolConversionAdapter[],
): void {
  const instanceKeys = new Set<string>();
  const graphOrders = new Set<number>();
  for (const adapter of adapters) {
    const reason = adapter.undeclaredVenueReason?.trim() ?? "";
    if (adapter.declaredVenues.length > 0 && reason.length !== 0) {
      throw new Error(
        `adapter-family registry: ${adapter.id} declares venues and an undeclared reason`,
      );
    }
    if (
      adapter.declaredVenues.length === 0 &&
      (
        adapter.discovery === undefined ||
        adapter.discoveryIdentityResolver === undefined ||
        adapter.discoveryIdentityAuthority === undefined ||
        adapter.discovery.candidateSources.length === 0
      )
    ) {
      throw new Error(
        `adapter-family registry: ${adapter.id} has no venues and no complete discovery contract`,
      );
    }
    for (const venue of adapter.declaredVenues) {
      assertDeclaredVenue(adapter, venue, instanceKeys, graphOrders);
    }
  }
}

function assertRouteDiscoveryDeclarations(
  adapters: readonly RouteLegAdapter[],
): void {
  for (const adapter of adapters) {
    if (
      Boolean(adapter.discovery) !== Boolean(adapter.discoveryIdentityResolver) ||
      Boolean(adapter.discovery) !== Boolean(adapter.discoveryIdentityAuthority)
    ) {
      throw new Error(
        `adapter-family registry: ${adapter.id} discovery, identity and authority must ship together`,
      );
    }
    if (adapter.discoveryIdentityAuthority !== undefined) {
      assertIdentityAuthority(adapter);
    }
    assertDiscoverySources(adapter);
  }
}

function assertIdentityAuthority(adapter: RouteLegAdapter): void {
  const authority = adapter.discoveryIdentityAuthority!;
  if (
    ![
      "canonical-onchain",
      "observed-event",
      "provisional",
      "trusted-seed",
    ].includes(authority.class) ||
    !Number.isSafeInteger(authority.strength) ||
    authority.strength < 0 ||
    authority.strength > 1_000
  ) {
    throw new Error(
      `adapter-family registry: ${adapter.id} has invalid discovery identity authority`,
    );
  }
}

function assertRouteIdentityDeclarations(
  adapters: readonly RouteLegAdapter[],
  registeredVenueOwners: Map<string, ExecutionFamilyId>,
  registeredIdentitySourceOwners: Map<string, ExecutionFamilyId>,
): void {
  for (const adapter of adapters) {
    if (
      adapter.routeIdentity !== undefined &&
      (
        typeof adapter.routeIdentity.instanceKey !== "function" ||
        typeof adapter.routeIdentity.executionVariantKey !== "function"
      )
    ) {
      throw new Error(
        `adapter-family registry: ${adapter.id} has invalid route identity capability`,
      );
    }
    if (
      adapter.planExecutionIdentity !== undefined &&
      typeof adapter.planExecutionIdentity.resolve !== "function"
    ) {
      throw new Error(
        `adapter-family registry: ${adapter.id} has invalid plan execution identity capability`,
      );
    }
    const localPoolAdapters = new Set<string>();
    for (const poolAdapter of adapter.poolAdapters) {
      if (!isNonemptyRegistryId(poolAdapter) || localPoolAdapters.has(poolAdapter)) {
        throw new Error(
          `adapter-family registry: ${adapter.id} has duplicate/empty pool adapter ${poolAdapter}`,
        );
      }
      localPoolAdapters.add(poolAdapter);
    }
    const declared = new Set(adapter.identityPolicies.map((item) => item.poolAdapter));
    const expected = new Set(adapter.poolAdapters);
    const missing = [...expected].filter((item) => !declared.has(item));
    const extra = [...declared].filter((item) => !expected.has(item));
    if (
      declared.size !== adapter.identityPolicies.length ||
      missing.length > 0 ||
      extra.length > 0
    ) {
      throw new Error(
        `adapter-family registry: ${adapter.id} identity coverage mismatch ` +
          `missing=[${missing.join(",")}] extra=[${extra.join(",")}]`,
      );
    }
    for (const policy of adapter.identityPolicies) {
      registerIdentityIds(
        adapter.id,
        policy.registeredVenueIds ?? [],
        "venue",
        isKnownVenueId,
        registeredVenueOwners,
      );
      registerIdentityIds(
        adapter.id,
        policy.registeredIdentitySources ?? [],
        "identity source",
        isKnownVenueIdentitySource,
        registeredIdentitySourceOwners,
      );
      if (
        policy.policy === "trusted-singleton-seed" &&
        policy.canonicalVenueId !== undefined
      ) {
        assertFamilyOwnsIdentityId(
          adapter.id,
          policy.canonicalVenueId,
          "venue",
          isKnownVenueId,
          policy.registeredVenueIds ?? [],
        );
      }
      if (
        policy.policy === "trusted-singleton-seed" &&
        policy.canonicalIdentitySource !== undefined
      ) {
        assertFamilyOwnsIdentityId(
          adapter.id,
          policy.canonicalIdentitySource,
          "identity source",
          isKnownVenueIdentitySource,
          policy.registeredIdentitySources ?? [],
        );
      }
    }
  }
}

function registerIdentityIds(
  familyId: ExecutionFamilyId,
  ids: readonly string[],
  kind: string,
  isKnown: (value: unknown) => boolean,
  owners: Map<string, ExecutionFamilyId>,
): void {
  const local = new Set<string>();
  for (const id of ids) {
    if (!isNonemptyRegistryId(id)) {
      throw new Error(`adapter-family registry: ${familyId} has empty ${kind} id`);
    }
    if (isKnown(id)) {
      throw new Error(
        `adapter-family registry: ${familyId} redeclares known ${kind} ${id}`,
      );
    }
    const prior = owners.get(id);
    if (local.has(id) || prior !== undefined) {
      throw new Error(
        `adapter-family registry: duplicate registered ${kind} ${id}` +
          (prior === undefined ? "" : ` owned by ${prior} and ${familyId}`),
      );
    }
    local.add(id);
    owners.set(id, familyId);
  }
}

function assertFamilyOwnsIdentityId(
  familyId: ExecutionFamilyId,
  id: string,
  kind: string,
  isKnown: (value: unknown) => boolean,
  registered: readonly string[],
): void {
  if (!isNonemptyRegistryId(id)) {
    throw new Error(`adapter-family registry: ${familyId} has empty ${kind} id`);
  }
  if (!isKnown(id) && !registered.includes(id)) {
    throw new Error(
      `adapter-family registry: ${familyId} uses unregistered ${kind} ${id}`,
    );
  }
}

function isDiscoverableRoute(
  adapter: RouteLegAdapter,
): adapter is DiscoverableRouteLegAdapter {
  return adapter.discovery !== undefined &&
    adapter.discoveryIdentityResolver !== undefined &&
    adapter.discoveryIdentityAuthority !== undefined;
}

function assertDiscoverySources(adapter: RouteLegAdapter): void {
  const discovery = adapter.discovery;
  if (!discovery) return;
  const sources = new Set(discovery.candidateSources);
  if (sources.size === 0 || sources.size !== discovery.candidateSources.length) {
    throw new Error(`adapter-family registry: ${adapter.id} has invalid candidate sources`);
  }
  if (Boolean(discovery.candidateFromAddress) !== sources.has("dex-token-domain")) {
    throw new Error(`adapter-family registry: ${adapter.id} address source/matcher mismatch`);
  }
  if (Boolean(discovery.candidateFromObservedCall) !== sources.has("observed-interaction")) {
    throw new Error(`adapter-family registry: ${adapter.id} observed source/matcher mismatch`);
  }
  const candidateAddressHints = discovery.candidateAddressHints ?? [];
  if (
    candidateAddressHints.length > 0 &&
    (
      !sources.has("dex-token-domain") ||
      discovery.candidateFromAddress === undefined
    )
  ) {
    throw new Error(
      `adapter-family registry: ${adapter.id} candidate address hints require dex-token-domain matcher`,
    );
  }
  const normalizedHints = new Set<string>();
  for (const hint of candidateAddressHints) {
    let normalized: string;
    try {
      normalized = ethers.getAddress(hint).toLowerCase();
    } catch {
      throw new Error(
        `adapter-family registry: ${adapter.id} has invalid candidate address hint ${hint}`,
      );
    }
    if (normalized === ethers.ZeroAddress.toLowerCase() || normalizedHints.has(normalized)) {
      throw new Error(
        `adapter-family registry: ${adapter.id} has duplicate/zero candidate address hint ${hint}`,
      );
    }
    normalizedHints.add(normalized);
  }
  if (
    discovery.candidateFromAddress &&
    !discovery.addressMatcherVersion?.trim()
  ) {
    throw new Error(`adapter-family registry: ${adapter.id} lacks address matcher version`);
  }
  const addressCache = discovery.addressMatcherCachePolicy;
  if (addressCache !== undefined) {
    if (discovery.candidateFromAddress === undefined) {
      throw new Error(
        `adapter-family registry: ${adapter.id} address cache requires an address matcher`,
      );
    }
    if (
      addressCache.kind !== "current-block-dependency-fingerprint" ||
      addressCache.invariant !==
        "matcher-output-immutable-while-code-implementation-and-dependencies-match" ||
      !addressCache.version?.trim() ||
      typeof addressCache.currentDependencyFingerprint !== "function"
    ) {
      throw new Error(
        `adapter-family registry: ${adapter.id} has an invalid address matcher cache contract`,
      );
    }
  }
  if (
    discovery.candidateFromObservedCall &&
    !discovery.observedMatcherVersion?.trim()
  ) {
    throw new Error(`adapter-family registry: ${adapter.id} lacks observed matcher version`);
  }
  if (
    sources.has("observed-interaction") &&
    discovery.eventTopics.length === 0
  ) {
    throw new Error(
      `adapter-family registry: ${adapter.id} observed source has no enumerable event topic`,
    );
  }
  if (sources.has("canonical-registry")) {
    throw new Error(
      `adapter-family registry: ${adapter.id} canonical-registry has no shared enumerator`,
    );
  }
}

function assertDeclaredVenue(
  adapter: ProtocolConversionAdapter,
  venue: PoolEntry & { readonly graphOrder?: number },
  instanceKeys: Set<string>,
  graphOrders: Set<number>,
): void {
  if (!adapter.poolAdapters.includes(venue.adapter)) {
    throw new Error(
      `adapter-family registry: ${adapter.id} declared foreign adapter ${venue.adapter}`,
    );
  }
  if (venue.score !== undefined) {
    throw new Error(`adapter-family registry: ${adapter.id} declared a scored venue`);
  }
  try {
    ethers.getAddress(venue.address);
  } catch {
    throw new Error(`adapter-family registry: ${adapter.id} declared invalid address`);
  }
  const instanceKey = routeInstanceKey(adapter, venue);
  if (instanceKeys.has(instanceKey)) {
    throw new Error(
      `adapter-family registry: duplicate declared route instance ${instanceKey}`,
    );
  }
  instanceKeys.add(instanceKey);
  if (venue.graphOrder === undefined) return;
  if (!Number.isSafeInteger(venue.graphOrder) || venue.graphOrder < 0) {
    throw new Error(`adapter-family registry: ${adapter.id} declared invalid graph order`);
  }
  if (graphOrders.has(venue.graphOrder)) {
    throw new Error(`adapter-family registry: duplicate graph order ${venue.graphOrder}`);
  }
  graphOrders.add(venue.graphOrder);
}

function collectOracleVictimDescriptors(
  adapters: readonly RouteLegAdapter[],
): readonly OracleVictimDescriptor[] {
  const descriptorIds = new Set<string>();
  const modelIds = new Set<string>();
  const out: OracleVictimDescriptor[] = [];
  for (const adapter of adapters) {
    const descriptor = adapter.oracleVictim;
    if (!descriptor) continue;
    if (
      !descriptor.id.trim() ||
      !descriptor.modelId.trim() ||
      descriptorIds.has(descriptor.id) ||
      modelIds.has(descriptor.modelId)
    ) {
      throw new Error(
        `adapter-family registry: ${adapter.id} has duplicate/empty oracle victim id`,
      );
    }
    if (
      descriptor.affectedEdges.length === 0 ||
      descriptor.affectedEdges.some(
        (edge) =>
          !adapter.edgeAdapterIds.includes(edge.adapterId) ||
          !edge.adapterId.trim(),
      )
    ) {
      throw new Error(
        `adapter-family registry: ${adapter.id} oracle victim owns foreign/empty edges`,
      );
    }
    if (
      !Number.isSafeInteger(descriptor.maxSearchHops) ||
      descriptor.maxSearchHops <= 0 ||
      descriptor.priceProbe.amountIn <= 0n ||
      !Number.isSafeInteger(descriptor.priceProbe.outputIndex) ||
      descriptor.priceProbe.outputIndex < 0 ||
      !descriptor.priceProbe.signature.trim() ||
      !descriptor.priceProbe.functionName.trim()
    ) {
      throw new Error(
        `adapter-family registry: ${adapter.id} has invalid oracle victim probe`,
      );
    }
    validateOracleMatcher(adapter, descriptor);
    descriptorIds.add(descriptor.id);
    modelIds.add(descriptor.modelId);
    out.push(freezeOracleVictimDescriptor(descriptor));
  }
  return Object.freeze(out);
}

function validateOracleMatcher(
  adapter: RouteLegAdapter,
  descriptor: OracleVictimDescriptor,
): void {
  const matcher = descriptor.matcher;
  const addresses = matcher.kind === "direct"
    ? [matcher.target]
    : [matcher.forwarder, matcher.target];
  try {
    for (const address of addresses) ethers.getAddress(address);
  } catch {
    throw new Error(
      `adapter-family registry: ${adapter.id} has invalid oracle victim address`,
    );
  }
  if (
    matcher.selectors.length === 0 ||
    matcher.selectors.some((selector) => !/^0x[0-9a-fA-F]{8}$/.test(selector))
  ) {
    throw new Error(
      `adapter-family registry: ${adapter.id} has invalid oracle victim selector`,
    );
  }
  if (
    matcher.kind === "forwarded" &&
    (
      !matcher.signature.trim() ||
      !Number.isSafeInteger(matcher.targetArg) ||
      matcher.targetArg < 0 ||
      !Number.isSafeInteger(matcher.dataArg) ||
      matcher.dataArg < 0
    )
  ) {
    throw new Error(
      `adapter-family registry: ${adapter.id} has invalid oracle forwarder matcher`,
    );
  }
}

function freezeOracleVictimDescriptor(
  descriptor: OracleVictimDescriptor,
): OracleVictimDescriptor {
  const matcher = descriptor.matcher.kind === "direct"
    ? Object.freeze({
        ...descriptor.matcher,
        selectors: Object.freeze([...descriptor.matcher.selectors]),
      })
    : Object.freeze({
        ...descriptor.matcher,
        selectors: Object.freeze([...descriptor.matcher.selectors]),
      });
  return Object.freeze({
    ...descriptor,
    matcher,
    affectedEdges: Object.freeze(
      descriptor.affectedEdges.map((edge) => Object.freeze({ ...edge })),
    ),
    priceProbe: Object.freeze({ ...descriptor.priceProbe }),
  });
}

function oracleVictimModels(
  descriptors: readonly OracleVictimDescriptor[],
): readonly VictimModelDescriptor[] {
  return Object.freeze(
    descriptors.map((descriptor) =>
      Object.freeze({
        id: descriptor.modelId,
        kind: "oracle-rawtx" as const,
        edgeAdapterIds: Object.freeze([]),
        runtime: null,
      })
    ),
  );
}
