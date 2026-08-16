/**
 * F8: strict catalog -> legacy-shaped AdapterFamily projection.
 *
 * The strict plugin catalog (PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG)
 * is the sole production authority. This module projects a legacy-shaped
 * AdapterFamily[] from the strict catalog so the remaining legacy-shaped
 * runtime surfaces keep compiling and stay *provably inert*:
 *
 *  - metadata surfaces (poolAdapters / edgeAdapterIds / taxonomy / funding
 *    priorities / mature-DEX universe labels) are bridged verbatim from the
 *    plugin manifest declarations;
 *  - runtime surfaces owned by the strict pipeline (quote / plan build /
 *    observation decode / landed materialization / victim replay / credit
 *    sizing / borrow fragments) fail closed with an explicit "strict-only"
 *    error or outcome;
 *  - blockscan pricing and funding reads are backed by the committed strict
 *    views (StrictShadowCatalogViews) through the central views provider
 *    installed by main; absent views fail closed (no mids / no offers).
 *
 * No protocol semantics live here: every value below is derived from plugin
 * declarations or the central views. Adding a Family requires only its plugin
 * + manifest; this module never branches on a family id.
 */
import type { LandedEventEmitter } from "./landed-event-registry.js";
import type {
  FundingOffer,
  FundingSource,
  PreparedFundingFamily,
  RegisteredFundingFamily,
} from "./funding/funding-capability.js";
import type {
  LandedPoolMaterializationCapability,
  LandedPoolMaterializationContext,
  LandedPoolMaterializationResult,
} from "./landed-pool-discovery.js";
import type {
  ReceiptImpactResult,
  SwapEventLog,
  SwapObservationCapability,
} from "./swap-observation.js";
import type { SwapVictimModelDeclaration } from "./victim-model-registry.js";
import type {
  BlockScanStateCapability,
  StateKeyCoverage,
  StateRead,
} from "./blockscan-state-capability.js";
import type {
  AdapterFamily,
  AllowedTaxonomy,
  CreditAdapterFamily,
  ExecutionFamilyId,
  FlashLoanAdapterFamily,
  ProtocolConversionAdapter,
  RouteLegAdapter,
  SwapAdapter,
} from "./route-leg-adapter.js";
import type {
  FamilyCapabilityCatalog,
  LoadedStrictFamilyPlugin,
} from "./family-capability-catalog.js";
import type {
  AnyStrictFamilyPlugin,
  FamilyDomain,
  FamilyManifest,
  LogPattern,
} from "./adapter-family-plugin.js";
import type { FamilyId } from "./adapter-family-identifiers.js";
import type { StrictShadowCatalogViews } from
  "../adapter-family-shadow-catalog-publication.js";
import type { PoolEntry, TokenEdge } from "../planner/token-graph.js";
import type { RouteVenueMid } from "./mid-readers.js";
import {
  VENUE_IDENTITY_CATALOG,
} from "./capability.js";
import { hashCanonical } from "./canonical-value.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from
  "./production-family-composition.js";

/** Error raised by every legacy-shaped runtime surface the strict pipeline owns. */
export class StrictOnlySurfaceError extends Error {
  readonly code = "STRICT_ONLY_LEGACY_SURFACE";
  constructor(familyId: string, surface: string) {
    super(
      `strict-only: family ${familyId} legacy surface "${surface}" is owned by the strict pipeline`,
    );
    this.name = "StrictOnlySurfaceError";
  }
}

/**
 * Central committed-strict-views provider. main() installs the composition's
 * capture closure after the discovery continuity composition exists and before
 * any legacy-shaped runtime lane prepares. Absent views fail closed.
 */
let productionStrictViewsProvider: () => StrictShadowCatalogViews | null =
  () => null;

export function setProductionStrictViewsProvider(
  provider: () => StrictShadowCatalogViews | null,
): void {
  if (typeof provider !== "function") {
    throw new Error("strict views provider must be a function");
  }
  productionStrictViewsProvider = provider;
}

export function productionStrictViews(): StrictShadowCatalogViews | null {
  return productionStrictViewsProvider();
}

function toExecutionFamilyId(id: FamilyId): ExecutionFamilyId {
  // Strict family ids use the same vocabulary as the legacy execution family
  // ids (validated by the production composition); the branded cast is the
  // documented bridge boundary.
  return id as unknown as ExecutionFamilyId;
}

function strictOnlyThrow(familyId: string, surface: string): never {
  throw new StrictOnlySurfaceError(familyId, surface);
}

type StrictPluginForDomain<Domain extends FamilyDomain> = Extract<
  AnyStrictFamilyPlugin,
  { readonly manifest: { readonly domain: Domain } }
>;

function strictPluginForDomain<Domain extends FamilyDomain>(
  plugin: LoadedStrictFamilyPlugin["plugin"],
  domain: Domain,
): StrictPluginForDomain<Domain> {
  if (plugin.manifest.domain !== domain) {
    throw new Error(
      `strict projection: family manifest domain ${plugin.manifest.domain} does not match ${domain}`,
    );
  }
  return plugin as unknown as StrictPluginForDomain<Domain>;
}

/**
 * Resolve a pattern id to its receipt topic, or null when the pattern is
 * call-based (no topic). Patterns must be declared in the plugin discovery
 * log/call pattern sets; undeclared ids fail loudly.
 */
function patternTopicById(
  family: LoadedStrictFamilyPlugin,
  patternId: string,
): string | null {
  // Swap-family bridges are the only callers; the swap plugin carries the
  // discovery capability with the pattern declarations.
  const discovery = strictPluginForDomain(family.plugin, "swap").discovery;
  const logPattern = discovery?.logPatterns?.find(
    (candidate) => candidate.id === patternId,
  );
  if (logPattern !== undefined) return logPattern.topic.toLowerCase();
  const callPattern = discovery?.callPatterns?.find(
    (candidate) => candidate.id === patternId,
  );
  if (callPattern !== undefined) return null;
  throw new Error(
    `strict projection: family ${family.plugin.manifest.familyId} pattern ${patternId} is undeclared`,
  );
}

/** Resolve the declaring LogPattern for a topic-bearing pattern id. */
function patternTopicPattern(
  family: LoadedStrictFamilyPlugin,
  patternId: string,
): LogPattern {
  const discovery = strictPluginForDomain(family.plugin, "swap").discovery;
  const logPattern = discovery?.logPatterns?.find(
    (candidate) => candidate.id === patternId,
  );
  if (logPattern !== undefined) return logPattern;
  throw new Error(
    `strict projection: family ${family.plugin.manifest.familyId} pattern ${patternId} has no log pattern`,
  );
}

function bridgeEmitter(pattern: LogPattern): LandedEventEmitter {
  const emitter = pattern.emitter;
  if (emitter === undefined || emitter.mode === "address") {
    return Object.freeze({ mode: "address" });
  }
  if (
    emitter.mode === "singleton-indexed-address" ||
    emitter.mode === "singleton-indexed-bytes32"
  ) {
    return Object.freeze({
      mode: emitter.mode,
      address: emitter.address,
      topicIndex: emitter.topicIndex,
    });
  }
  return Object.freeze({ mode: "address" });
}

/**
 * Route identity bridge: the registry default keys by address + logical
 * instance; singleton families (v4-style pools with a poolId) must key by
 * poolId so sibling instances at one target never collide. Data-driven from
 * the pool fields, never a family branch.
 */
function bridgeRouteIdentity(): NonNullable<RouteLegAdapter["routeIdentity"]> {
  return Object.freeze({
    instanceKey(pool: PoolEntry): string {
      const address = pool.address.toLowerCase();
      if (pool.poolId !== undefined) {
        return JSON.stringify([address, `pool-id:${pool.poolId.toLowerCase()}`]);
      }
      if (pool.logicalInstanceId !== undefined) {
        return JSON.stringify([address, pool.logicalInstanceId]);
      }
      return JSON.stringify([address, null]);
    },
    executionVariantKey(edge: TokenEdge): string {
      return edge.adapterId;
    },
  });
}

/**
 * Landed-event bridge: the strict LandedEventSpec pattern set projected to the
 * legacy swap/mutation declaration vocabulary (topics + emitters from the
 * plugin log patterns). Materialization and warm-invalidation semantics stay
 * strict-owned; the legacy side only consumes this as an inert topic index.
 */
function bridgeLandedEvents(
  family: LoadedStrictFamilyPlugin,
): SwapAdapter["landedEvents"] {
  const swapSemantics = strictPluginForDomain(family.plugin, "swap").swap;
  const events = swapSemantics.landedEvents.patternIds.flatMap((patternId) => {
    const topic = patternTopicById(family, patternId);
    // Call-based landed observations have no receipt topic and cannot be
    // indexed by the legacy lane; they stay strict-owned.
    if (topic === null) return [];
    return [Object.freeze({
      id: patternId,
      topic,
      emitter: bridgeEmitter(patternTopicPattern(family, patternId)),
      discovery: Object.freeze({
        poolAdapter: (family.plugin.manifest.poolAdapterIds?.[0] ??
          family.plugin.manifest.familyId) as unknown as PoolEntry["adapter"],
        label: patternId,
      }),
      invalidatesWarmState: true,
    })];
  });
  if (events.length === 0) {
    throw new Error(
      `strict projection: family ${family.plugin.manifest.familyId} declares no log-based landed event`,
    );
  }
  return Object.freeze({
    swaps: events,
    mutations: Object.freeze([]),
  });
}

/**
 * Observation bridge: receipt topics from the plugin log patterns. Decode is
 * strict-owned and fails closed with an explicit unresolved outcome so the
 * legacy backrun lane can never manufacture impacts from legacy decoders.
 */
function bridgeObservation(
  family: LoadedStrictFamilyPlugin,
): SwapObservationCapability {
  const swapSemantics = strictPluginForDomain(family.plugin, "swap").swap;
  // The legacy LandedEventRegistry requires observation topics to equal the
  // landed swap topics exactly, so both bridge from the same pattern set.
  const topics = Object.freeze(
    swapSemantics.landedEvents.patternIds.flatMap((patternId) => {
      const topic = patternTopicById(family, patternId);
      return topic === null ? [] : [topic];
    }),
  );
  return Object.freeze({
    topics,
    canonicalIntakeTargets: Object.freeze([]),
    observedPoolIdentity(_log: SwapEventLog): string | null {
      return null;
    },
    async decodeReceiptImpacts(): Promise<ReceiptImpactResult> {
      return Object.freeze({
        status: "unresolved",
        reason: "strict-only: receipt impact decode is owned by the strict observation pipeline",
      });
    },
  });
}

/**
 * Fail-closed landed materializer: declares the family's event ids so the
 * legacy LandedPoolDiscoveryRegistry shape holds, but materializes nothing.
 * The strict discovery pipeline owns landed pool materialization.
 */
function bridgePoolMaterialization(
  family: LoadedStrictFamilyPlugin,
): LandedPoolMaterializationCapability {
  const swapSemantics = strictPluginForDomain(family.plugin, "swap").swap;
  // The legacy LandedPoolDiscoveryRegistry requires the materializer to own
  // every landed swap event id, so the bridge declares exactly the bridged
  // landed event set (the strict poolMaterialization patterns stay strict).
  const eventIds = Object.freeze(
    swapSemantics.landedEvents.patternIds.filter(
      (patternId) => patternTopicById(family, patternId) !== null,
    ),
  );
  const poolAdapter = (family.plugin.manifest.poolAdapterIds?.[0] ??
    family.plugin.manifest.familyId) as unknown as PoolEntry["adapter"];
  return Object.freeze({
    version: hashCanonical({
      format: "strict-projected-pool-materialization-v1",
      familyId: family.plugin.manifest.familyId,
      eventIds,
    }),
    eventIds,
    async materialize(
      context: LandedPoolMaterializationContext,
    ): Promise<LandedPoolMaterializationResult> {
      // Every observed identity stays deferred (retryable): the legacy lane
      // never claims terminal coverage for a source the strict pipeline
      // materializes, and it never drops a candidate. Event identities are
      // reconstructed from the log addresses (provenance only; admission is
      // strict-owned).
      const seen = new Set<string>();
      const candidates: PoolEntry[] = [];
      for (const log of context.logs) {
        const address = log.address.toLowerCase();
        if (seen.has(address)) continue;
        seen.add(address);
        candidates.push(Object.freeze({
          address: log.address,
          adapter: poolAdapter,
        }));
      }
      for (const pool of context.retryablePools) {
        const key = `${pool.adapter}:${pool.address.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(pool);
      }
      const issue = Object.freeze([
        "strict-only: landed pool materialization is owned by the strict discovery pipeline",
      ]);
      if (candidates.length === 0) {
        // No qualifying identities in this source: terminal with zero pools.
        return Object.freeze({
          pools: Object.freeze([]),
          complete: true,
          issues: issue,
        });
      }
      return Object.freeze({
        pools: Object.freeze([]),
        complete: false,
        issues: issue,
        retryablePools: Object.freeze(candidates),
      });
    },
  });
}

/** Strict-backed mid index over one committed views revision (per family). */
interface StrictViewsEdgeIndex {
  readonly revision: number;
  /** canonicalEdgeId -> (familyId, instanceKey, routeKey) resolved through views. */
  readonly byEdge: ReadonlyMap<
    string,
    { readonly familyId: string; readonly instanceKey: string; readonly routeKey: string }
  >;
  /** routeKey -> (publicationKey, mid) for this family's publications. */
  readonly midByRoute: ReadonlyMap<
    string,
    { readonly publicationKey: string; readonly mid: RouteVenueMid }
  >;
  /** routeKey -> unavailable reason for this family's publications. */
  readonly unavailableByRoute: ReadonlyMap<string, string>;
}

function buildStrictViewsEdgeIndex(
  views: StrictShadowCatalogViews,
  familyId: string,
): StrictViewsEdgeIndex {
  const byEdge = new Map<
    string,
    { readonly familyId: string; readonly instanceKey: string; readonly routeKey: string }
  >();
  for (const edge of views.edges) {
    const handle = views.handleByCanonicalEdgeId.get(edge.canonicalEdgeId);
    if (!handle || handle.familyId !== familyId) continue;
    byEdge.set(edge.canonicalEdgeId, Object.freeze({
      familyId: handle.familyId,
      instanceKey: handle.instanceKey,
      routeKey: handle.routeKey,
    }));
  }
  const midByRoute = new Map<
    string,
    { readonly publicationKey: string; readonly mid: RouteVenueMid }
  >();
  const unavailableByRoute = new Map<string, string>();
  for (const [publicationKey, state] of views.pricingByPublicationKey) {
    if (state.familyId !== familyId) continue;
    for (const [routeKey, mid] of state.mids) {
      if (!midByRoute.has(routeKey)) {
        midByRoute.set(routeKey, Object.freeze({ publicationKey, mid }));
      }
    }
    for (const [routeKey, reason] of state.unavailable) {
      if (!unavailableByRoute.has(routeKey)) {
        unavailableByRoute.set(routeKey, reason);
      }
    }
  }
  return Object.freeze({
    revision: views.revision,
    byEdge: new Map(byEdge),
    midByRoute: new Map(midByRoute),
    unavailableByRoute: new Map(unavailableByRoute),
  });
}

const STRICT_VIEWS_SCHEMA_FORMAT = "strict-views-backed-schema-v1";

/**
 * Blockscan pricing capability backed by the committed strict pricing views.
 * The legacy BlockScanStateCoordinator machinery (topology/ownership/cache)
 * keeps running unchanged; this capability only sources mids from the strict
 * publication instead of legacy state reads. An edge missing from the
 * committed views is behavior-proven unavailable (strict fail-closed), never
 * priced through a legacy read.
 */
function createStrictViewsPricingCapability(
  family: LoadedStrictFamilyPlugin,
): BlockScanStateCapability<unknown, unknown> {
  const familyId = family.plugin.manifest.familyId;
  let cachedRevision = -1;
  let cachedIndex: StrictViewsEdgeIndex | null = null;
  const stateKeyFor = (edge: TokenEdge): string =>
    `strict:state:${familyId}:${
      edge.instanceKey ?? edge.poolId ?? edge.target.toLowerCase()
    }`;
  const edgeIndexFor = (): StrictViewsEdgeIndex | null => {
    const views = productionStrictViews();
    if (views === null) return null;
    if (cachedIndex !== null && cachedIndex.revision === views.revision) {
      return cachedIndex;
    }
    cachedIndex = buildStrictViewsEdgeIndex(views, familyId);
    return cachedIndex;
  };
  return Object.freeze({
    familyId,
    schemaMode: "legacy-family",
    stateKey: stateKeyFor,
    compileStaticSchema() {
      return Object.freeze({ format: STRICT_VIEWS_SCHEMA_FORMAT, familyId });
    },
    buildCurrentBlockReads() {
      return Object.freeze([]);
    },
    decodeState(schema: unknown) {
      return schema;
    },
    deriveMids(
      _snapshot: unknown,
      edges: readonly TokenEdge[],
    ): ReadonlyMap<string, RouteVenueMid> {
      const index = edgeIndexFor();
      const derived = new Map<string, RouteVenueMid>();
      if (index === null) return derived;
      for (const edge of edges) {
        const key = edge.canonicalEdgeId ?? stateKeyFor(edge);
        const binding = edge.canonicalEdgeId === undefined
          ? null
          : index.byEdge.get(edge.canonicalEdgeId) ?? null;
        if (binding === null) continue;
        const resolved = index.midByRoute.get(binding.routeKey);
        if (resolved !== undefined) derived.set(key, resolved.mid);
      }
      return derived;
    },
    behaviorProvenUnavailableEdges(
      _snapshot: unknown,
      edges: readonly TokenEdge[],
    ): ReadonlyMap<string, string> {
      const index = edgeIndexFor();
      const unavailable = new Map<string, string>();
      for (const edge of edges) {
        const key = edge.canonicalEdgeId ?? stateKeyFor(edge);
        const binding = edge.canonicalEdgeId === undefined
          ? null
          : index?.byEdge.get(edge.canonicalEdgeId) ?? null;
        if (index === null || binding === null) {
          unavailable.set(
            key,
            "strict-only: no committed strict pricing views for this route",
          );
          continue;
        }
        const reason = index.unavailableByRoute.get(binding.routeKey);
        if (reason !== undefined) {
          unavailable.set(key, `strict-only: ${reason}`);
        } else if (!index.midByRoute.has(binding.routeKey)) {
          unavailable.set(
            key,
            "strict-only: route missing from committed strict pricing publication",
          );
        }
      }
      return unavailable;
    },
    dependencies() {
      return Object.freeze([]);
    },
  });
}

/**
 * Funding bridge: describeSources/prepare read the plugin liquidity program's
 * static source declaration and the committed strict funding views. The legacy
 * source shape and the strict FundingSourceDescriptor shape are identical;
 * requiredReadKeys are dropped because strict views carry their own
 * provenance. Borrow/repayment fragment building is strict-owned (the strict
 * funding runtime returns PlanFragment, not ResolvedPlanNode).
 */
function bridgeFundingFamily(
  family: LoadedStrictFamilyPlugin,
): FlashLoanAdapterFamily["funding"] {
  const manifest = family.plugin.manifest;
  const fundingSemantics = strictPluginForDomain(family.plugin, "funding").funding;
  const fundingPriority = manifest.fundingPriority;
  if (!fundingPriority) {
    throw new Error(
      `strict projection: funding family ${manifest.familyId} lacks fundingPriority declaration`,
    );
  }
  const describeSources = (assets: readonly string[]): readonly FundingSource[] =>
    Object.freeze(
      fundingSemantics.liquidity.sources(assets).map((source) =>
        Object.freeze({
          fundingId: source.fundingId,
          instanceKey: source.instanceKey,
          provider: source.provider,
          stateKey: source.stateKey,
          asset: source.asset,
          requiredReadKeys: Object.freeze([]),
        })
      ),
    );
  const prepare = async (input: {
    readonly assets: readonly string[];
    readonly source: { readonly number: number; readonly hash: string; readonly generation?: number };
    readonly control: { readonly deadlineAtMs?: number; readonly signal?: AbortSignal };
  }): Promise<PreparedFundingFamily> => {
    const sources = describeSources(input.assets);
    const source = Object.freeze({
      number: input.source.number,
      hash: input.source.hash,
      generation: input.source.generation ?? 0,
    });
    return Object.freeze({
      familyId: manifest.familyId as unknown as PreparedFundingFamily["familyId"],
      source,
      sources,
      reads: Object.freeze([]) as readonly StateRead[],
      actionAdapterId: manifest.ownedActionAdapterIds[0],
      planningPriority: fundingPriority.planningPriority,
      liquidityPriority: fundingPriority.liquidityPriority,
      decodeAndDerive() {
        const offers = new Map<string, FundingOffer>();
        const coverageByFundingId = new Map<string, StateKeyCoverage>();
        const offersByAsset = new Map<
          string,
          readonly (readonly [string, FundingOffer])[]
        >();
        const views = productionStrictViews();
        if (views !== null) {
          for (const [, state] of views.fundingByPublicationKey) {
            if (state.familyId !== manifest.familyId) continue;
            for (const offer of state.offers) {
              const legacyOffer: FundingOffer = Object.freeze({
                fundingId: offer.fundingId,
                asset: offer.asset,
                maxBorrow: offer.maxBorrow,
                fee: offer.fee,
                actionAdapterId: offer.actionAdapterId,
                planningPriority: offer.planningPriority,
                liquidityPriority: offer.liquidityPriority,
              });
              const prior = offersByAsset.get(offer.asset.toLowerCase()) ?? [];
              offersByAsset.set(offer.asset.toLowerCase(), Object.freeze([
                ...prior,
                Object.freeze([offer.fundingId, legacyOffer] as const),
              ]));
            }
          }
        }
        const decodedCoverage = new Map<
          string,
          ReadonlyMap<string, StateKeyCoverage>
        >();
        for (const fundingSource of sources) {
          const candidates = offersByAsset.get(fundingSource.asset.toLowerCase()) ?? [];
          const best = candidates
            .filter(([, offer]) => offer.fundingId === fundingSource.fundingId)
            .sort((a, b) => {
              const delta = b[1].maxBorrow - a[1].maxBorrow;
              return delta > 0n ? 1 : delta < 0n ? -1 : 0;
            })[0];
          if (best !== undefined) {
            offers.set(best[1].fundingId, best[1]);
            coverageByFundingId.set(best[1].fundingId, Object.freeze({ status: "resolved" }));
          } else {
            coverageByFundingId.set(fundingSource.fundingId, Object.freeze({
              status: "unresolved",
              reason: "strict-only: no committed strict funding offer for this source",
            }));
          }
          decodedCoverage.set(fundingSource.stateKey, new Map());
        }
        return Object.freeze({
          decodedCoverage,
          derived: Object.freeze({
            offers,
            coverageByFundingId,
          }),
        });
      },
    });
  };
  return Object.freeze({
    familyId: manifest.familyId as unknown as RegisteredFundingFamily["familyId"],
    actionAdapterId: manifest.ownedActionAdapterIds[0],
    lineage: manifest.supportedLineages[0] as unknown as RegisteredFundingFamily["lineage"],
    target: fundingSemantics.repayment.target,
    liquidityHolder: fundingSemantics.repayment.liquidityHolder,
    repayment: fundingSemantics.repayment.mode,
    paramShape: fundingSemantics.repayment.paramShape,
    planningPriority: fundingPriority.planningPriority,
    liquidityPriority: fundingPriority.liquidityPriority,
    buildBorrowFragment() {
      return strictOnlyThrow(manifest.familyId, "funding.buildBorrowFragment");
    },
    buildRepaymentFragment() {
      return strictOnlyThrow(manifest.familyId, "funding.buildRepaymentFragment");
    },
    describeSources,
    prepare,
  });
}

/**
 * Mature DEX universe derivation from the identity catalog (data-driven). A
 * family joins the mature DEX universe lane when every identity-catalog pool
 * adapter it declares is a factory-mode standard adapter (univ2/univ3) and at
 * least one such adapter is declared. Labels unknown to the identity catalog
 * (family-id provenance labels) are ignored; a family declaring a
 * pool-registry-mode adapter (e.g. dodo-v2) is never mature-DEX.
 */
interface MatureDexCatalog {
  readonly knownPoolAdapters: ReadonlySet<string>;
  readonly factoryStandard: ReadonlySet<string>;
}

function matureDexCatalog(): MatureDexCatalog {
  const known = new Set<string>();
  const factoryStandard = new Set<string>();
  for (const entry of VENUE_IDENTITY_CATALOG) {
    if (!("poolAdapter" in entry)) continue;
    known.add(entry.poolAdapter);
    if (entry.discovery.mode === "factory" && entry.compatibility === "standard") {
      factoryStandard.add(entry.poolAdapter);
    }
  }
  return Object.freeze({ knownPoolAdapters: known, factoryStandard });
}

function familyIsMatureDex(
  poolAdapters: readonly string[],
  catalog: MatureDexCatalog,
): boolean {
  const known = poolAdapters.filter((label) => catalog.knownPoolAdapters.has(label));
  return known.length > 0 && known.every((label) => catalog.factoryStandard.has(label));
}

function bridgeTaxonomy(
  manifest: FamilyManifest<"swap" | "protocol" | "funding" | "credit">,
): readonly AllowedTaxonomy[] {
  return Object.freeze([...manifest.allowedTaxonomy]);
}

function projectSwapFamily(
  family: LoadedStrictFamilyPlugin,
  matureDexCatalogInfo: MatureDexCatalog,
): SwapAdapter {
  const manifest = family.plugin.manifest;
  const familyId = toExecutionFamilyId(manifest.familyId);
  const poolAdapters = Object.freeze([
    ...(manifest.poolAdapterIds ?? []),
  ]) as readonly PoolEntry["adapter"][];
  const edgeAdapterIds = Object.freeze([...(manifest.edgeAdapterIds ?? [])]);
  const matureDex = familyIsMatureDex(poolAdapters, matureDexCatalogInfo);
  return Object.freeze({
    id: familyId,
    kind: "swap",
    ownedActionAdapterIds: Object.freeze([...manifest.ownedActionAdapterIds]),
    requiredInfraActionAdapterIds: Object.freeze([
      ...manifest.requiredInfraActionAdapterIds,
    ]),
    poolAdapters,
    edgeAdapterIds,
    allowedTaxonomy: bridgeTaxonomy(manifest),
    identityPolicies: Object.freeze([]),
    requiresProtocolEdgesFlag: manifest.requiresProtocolEdgesFlag ?? false,
    prepared: null,
    routeIdentity: bridgeRouteIdentity(),
    matureDexUniverseDiscovery: matureDex ? true : undefined,
    landedEvents: bridgeLandedEvents(family),
    // Mature DEX families (univ2/univ3) keep the legacy shape: no family
    // materializer (generic address-emitter events). Every other swap family
    // carries a fail-closed materializer; the strict pipeline owns landing.
    ...(matureDex
      ? {}
      : { poolDiscovery: bridgePoolMaterialization(family) }),
    observation: bridgeObservation(family),
    victimModel: Object.freeze({
      id: `${manifest.familyId}:strict-detect-only`,
      mode: "detect-only",
    }) as SwapVictimModelDeclaration,
    pricingState: createStrictViewsPricingCapability(family),
    quoteExact() {
      return strictOnlyThrow(manifest.familyId, "quoteExact");
    },
    buildEdges() {
      return strictOnlyThrow(manifest.familyId, "buildEdges");
    },
    buildPlanFragment() {
      return strictOnlyThrow(manifest.familyId, "buildPlanFragment");
    },
  });
}

function projectProtocolFamily(
  family: LoadedStrictFamilyPlugin,
): ProtocolConversionAdapter {
  const manifest = family.plugin.manifest;
  const familyId = toExecutionFamilyId(manifest.familyId);
  return Object.freeze({
    id: familyId,
    kind: "protocol-conversion",
    ownedActionAdapterIds: Object.freeze([...manifest.ownedActionAdapterIds]),
    requiredInfraActionAdapterIds: Object.freeze([
      ...manifest.requiredInfraActionAdapterIds,
    ]),
    poolAdapters: Object.freeze([
      ...(manifest.poolAdapterIds ?? []),
    ]) as readonly PoolEntry["adapter"][],
    edgeAdapterIds: Object.freeze([...(manifest.edgeAdapterIds ?? [])]),
    allowedTaxonomy: bridgeTaxonomy(manifest),
    identityPolicies: Object.freeze([]),
    requiresProtocolEdgesFlag: manifest.requiresProtocolEdgesFlag ?? false,
    prepared: null,
    routeIdentity: bridgeRouteIdentity(),
    declaredVenues: Object.freeze([]),
    undeclaredVenueReason: null,
    pricingState: createStrictViewsPricingCapability(family),
    quoteExact() {
      return strictOnlyThrow(manifest.familyId, "quoteExact");
    },
    buildEdges() {
      return strictOnlyThrow(manifest.familyId, "buildEdges");
    },
    buildPlanFragment() {
      return strictOnlyThrow(manifest.familyId, "buildPlanFragment");
    },
  });
}

function projectCreditFamily(
  family: LoadedStrictFamilyPlugin,
): CreditAdapterFamily {
  const manifest = family.plugin.manifest;
  const familyId = toExecutionFamilyId(manifest.familyId);
  const risk = strictPluginForDomain(family.plugin, "credit").credit.risk;
  return Object.freeze({
    id: familyId,
    kind: "credit",
    ownedActionAdapterIds: Object.freeze([...manifest.ownedActionAdapterIds]),
    requiredInfraActionAdapterIds: Object.freeze([
      ...manifest.requiredInfraActionAdapterIds,
    ]),
    poolAdapters: Object.freeze([
      ...(manifest.poolAdapterIds ?? []),
    ]) as readonly PoolEntry["adapter"][],
    edgeAdapterIds: Object.freeze([...(manifest.edgeAdapterIds ?? [])]),
    allowedTaxonomy: bridgeTaxonomy(manifest),
    identityPolicies: Object.freeze([]),
    requiresProtocolEdgesFlag: manifest.requiresProtocolEdgesFlag ?? false,
    prepared: null,
    routeIdentity: bridgeRouteIdentity(),
    creditActionAdapterIds: Object.freeze([...manifest.ownedActionAdapterIds]),
    creditPolicy: Object.freeze({
      debtBpsCandidates: Object.freeze([...risk.debtBpsCandidates]),
      quoteOutputByDebtBps() {
        return strictOnlyThrow(manifest.familyId, "creditPolicy.quoteOutputByDebtBps");
      },
      blocksPrefixInversion: true,
    }),
    quoteExact() {
      return strictOnlyThrow(manifest.familyId, "quoteExact");
    },
    buildEdges() {
      return strictOnlyThrow(manifest.familyId, "buildEdges");
    },
    buildPlanFragment() {
      return strictOnlyThrow(manifest.familyId, "buildPlanFragment");
    },
  });
}

function projectFundingFamily(
  family: LoadedStrictFamilyPlugin,
): FlashLoanAdapterFamily {
  const manifest = family.plugin.manifest;
  const familyId = toExecutionFamilyId(manifest.familyId);
  return Object.freeze({
    id: familyId,
    kind: "flash-loan",
    ownedActionAdapterIds: Object.freeze([...manifest.ownedActionAdapterIds]),
    requiredInfraActionAdapterIds: Object.freeze([
      ...manifest.requiredInfraActionAdapterIds,
    ]),
    funding: bridgeFundingFamily(family),
  });
}

function projectFamily(
  family: LoadedStrictFamilyPlugin,
  matureDexCatalogInfo: MatureDexCatalog,
): AdapterFamily {
  const domain = family.plugin.manifest.domain;
  switch (domain) {
    case "swap":
      return projectSwapFamily(family, matureDexCatalogInfo);
    case "protocol":
      return projectProtocolFamily(family);
    case "credit":
      return projectCreditFamily(family);
    case "funding":
      return projectFundingFamily(family);
    default: {
      const never: never = domain;
      throw new Error(`strict projection: unsupported domain ${String(never)}`);
    }
  }
}

/**
 * Project every strict catalog family to a legacy-shaped AdapterFamily. The
 * projection is frozen once and shared by the production registry; consumers
 * must treat strict surfaces as fail-closed (see StrictOnlySurfaceError).
 */
export function createStrictRegistryProjection(
  catalog: FamilyCapabilityCatalog,
): readonly AdapterFamily[] {
  const matureDexCatalogInfo = matureDexCatalog();
  const families = catalog.listAll().map((family) =>
    projectFamily(family, matureDexCatalogInfo)
  );
  return Object.freeze(families);
}

/**
 * Strict-views-backed legacy graph edge resolution: resolve a pool universe
 * entry to its committed strict edges. Used by the legacy-shaped token graph
 * builder so the routing graph is sourced from strict views, never from a
 * legacy buildEdges path. Unmatched pools fail closed (retryable) until the
 * committed publication covers them.
 */
export function resolveStrictEdgesForPool(
  pool: PoolEntry,
): readonly TokenEdge[] {
  const views = productionStrictViews();
  if (views === null) return Object.freeze([]);
  const familyId = poolFamilyIdForPoolAdapter(pool.adapter);
  const matches: TokenEdge[] = [];
  for (const edge of views.edges) {
    const handle = views.handleByCanonicalEdgeId.get(edge.canonicalEdgeId);
    if (!handle || handle.familyId !== familyId) continue;
    if (
      pool.logicalInstanceId !== undefined &&
      edge.instanceKey !== undefined &&
      edge.instanceKey !== pool.logicalInstanceId
    ) {
      continue;
    }
    if (edge.poolId !== undefined) {
      if (pool.poolId !== undefined &&
          edge.poolId.toLowerCase() !== pool.poolId.toLowerCase()) continue;
    } else if (edge.target.toLowerCase() !== pool.address.toLowerCase()) {
      continue;
    }
    if (pool.token0 !== undefined &&
        edge.tokenIn.toLowerCase() !== pool.token0.toLowerCase() &&
        edge.tokenOut.toLowerCase() !== pool.token0.toLowerCase()) continue;
    if (pool.token1 !== undefined &&
        edge.tokenIn.toLowerCase() !== pool.token1.toLowerCase() &&
        edge.tokenOut.toLowerCase() !== pool.token1.toLowerCase()) continue;
    matches.push(edge);
  }
  return Object.freeze(matches);
}

let poolFamilyIdByAdapter: ReadonlyMap<string, string> | null = null;

function poolFamilyIdForPoolAdapter(poolAdapter: string): string {
  if (poolFamilyIdByAdapter === null) {
    // Derive the label -> family map from the strict catalog manifest
    // declarations (data-driven, no central per-family table).
    const map = new Map<string, string>();
    for (const family of PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
      .listAll()) {
      for (const label of family.plugin.manifest.poolAdapterIds ?? []) {
        map.set(label, family.plugin.manifest.familyId);
      }
    }
    poolFamilyIdByAdapter = map;
  }
  return poolFamilyIdByAdapter.get(poolAdapter) ?? poolAdapter;
}

/** Stable projection fingerprint for scan/universe authority artifacts. */
export function strictProjectionFingerprint(
  catalog: FamilyCapabilityCatalog,
): string {
  return hashCanonical({
    format: "strict-catalog-registry-projection-v1",
    families: catalog.listAll().map((family) => ({
      familyId: family.plugin.manifest.familyId,
      domain: family.plugin.manifest.domain,
      definitionBoundaryHash: family.definitionBoundaryHash,
    })),
  });
}
