import {
  AdapterFamilyCatalogPublicationStore,
  catalogInstancePublicationKey,
  catalogPublicationDefinition,
  createCatalogPublicationValueAuthority,
  prepareAdapterFamilyCatalogPublication,
  type AdapterFamilyCatalogPublicationEnvelope,
  type CatalogDiscoverySourceAnchor,
  type CatalogFamilyStage,
  type CatalogInventoryMode,
  type CatalogStagedInstance,
  type CatalogSourceTransitionAuthority,
  type CatalogSourceTransitionProof,
  type CatalogStagedInstanceBundle,
  type CatalogTerminalRemovalAuthority,
  type CatalogTerminalRemovalProof,
  type CatalogValueBinding,
} from "./adapter-family-catalog-publication.js";
import type {
  FundingFamilyPublication,
  FundingInstanceOutcome,
  PreparedFundingOffer,
} from "./adapter-funding-runtime.js";
import {
  assertIssuedCreditRouteRuntimeHandle,
  assertIssuedProjectedCreditRoute,
  projectCreditRouteGraph,
  type CreditRouteRuntimeHandle,
  type PreparedCreditRoutePublication,
  type ProjectedCreditRouteGraph,
} from "./adapter-credit-runtime.js";
import {
  assertIssuedProjectedFamilyRouteGraph,
  projectFamilyRouteGraph,
  type ProjectedFamilyRouteGraph,
} from "./adapter-family-graph-runtime.js";
import type { TokenEdge } from "./planner/token-graph.js";
import {
  assertIssuedFamilyRouteRuntimeHandleAtSource,
  assertIssuedPreparedFamilyInstance,
  assertIssuedPreparedFamilyPricingStateInstance,
  type AdapterFamilyPublication,
  type FamilyRouteRuntimeHandle,
  type PreparedFamilyInstance,
  type PreparedPricingStateInstance,
} from "./venues/adapter-family-runtime.js";
import {
  instanceKey,
  lineageId,
  type FamilyId,
  type InstanceKey,
  type LineageId,
  type RouteKey,
} from
  "./venues/adapter-family-identifiers.js";
import type { RouteVenueMid } from
  "./venues/mid-readers.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { CanonicalEdgeId } from
  "./venues/blockscan-state-capability.js";
import { hashCanonical } from "./venues/canonical-value.js";
import {
  type FamilyCapabilityCatalog,
  type LoadedFamilyPlugin,
  type LoadedFamilyBox,
} from "./venues/family-capability-catalog.js";

export interface StrictFundingPublicationState {
  readonly kind: "funding";
  readonly familyId: FamilyId;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly tombstone: boolean;
  readonly offers: readonly PreparedFundingOffer[];
  readonly outcomes: readonly FundingInstanceOutcome[];
}

export type StrictShadowCatalogInstance =
  | PreparedFamilyInstance
  | StrictFundingPublicationState;

export type StrictShadowCatalogRouteHandle =
  | FamilyRouteRuntimeHandle
  | CreditRouteRuntimeHandle;

export type StrictShadowCatalogGraphEntry =
  | ProjectedFamilyRouteGraph
  | ProjectedCreditRouteGraph;

function isFundingState(
  value: StrictShadowCatalogInstance,
): value is StrictFundingPublicationState {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { readonly kind?: string }).kind === "funding"
  );
}

export type StrictShadowCatalogFamilyStage = CatalogFamilyStage<
  StrictShadowCatalogInstance,
  StrictShadowCatalogRouteHandle,
  StrictShadowCatalogGraphEntry,
  PreparedPricingStateInstance
>;

export type StrictShadowCatalogEnvelope =
  AdapterFamilyCatalogPublicationEnvelope<
    StrictShadowCatalogInstance,
    StrictShadowCatalogRouteHandle,
    StrictShadowCatalogGraphEntry,
    PreparedPricingStateInstance
  >;

export interface StrictShadowCatalogViews {
  readonly revision: number;
  readonly source: CanonicalSource;
  readonly publicationFingerprint: string;
  readonly graphRoutes: readonly StrictShadowCatalogGraphEntry[];
  readonly edges: readonly (TokenEdge & {
    readonly canonicalEdgeId: CanonicalEdgeId;
  })[];
  readonly handleByCanonicalEdgeId: ReadonlyMap<
    CanonicalEdgeId,
    StrictShadowCatalogRouteHandle
  >;
  readonly pricingByPublicationKey: ReadonlyMap<
    string,
    PreparedPricingStateInstance
  >;
  readonly fundingByPublicationKey: ReadonlyMap<
    string,
    StrictFundingPublicationState
  >;
}

export type StrictPricingReadOutcome =
  | { readonly kind: "mid"; readonly mid: RouteVenueMid }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "missing" };

/**
 * Strict pricing consumer read: resolves a RouteKey against one committed
 * pricing publication. Production consumers must go through this view (or
 * the issuer-bound handle path) instead of querying a legacy registry; a
 * missing pricing publication and an explicit unavailable row are distinct
 * outcomes.
 */
export function readStrictPricingMid(input: {
  readonly views: StrictShadowCatalogViews;
  readonly pricingPublicationKey: string;
  readonly routeKey: RouteKey;
}): StrictPricingReadOutcome {
  const pricing = input.views.pricingByPublicationKey.get(
    input.pricingPublicationKey,
  );
  if (pricing === undefined) return Object.freeze({ kind: "missing" });
  const unavailable = pricing.unavailable.get(input.routeKey);
  if (unavailable !== undefined) {
    return Object.freeze({ kind: "unavailable", reason: unavailable });
  }
  const mid = pricing.mids.get(input.routeKey);
  return mid === undefined
    ? Object.freeze({ kind: "missing" })
    : Object.freeze({ kind: "mid", mid });
}

export type StrictFundingReadOutcome =
  | { readonly kind: "offers"; readonly offers: readonly PreparedFundingOffer[] }
  | { readonly kind: "tombstone" }
  | { readonly kind: "missing" };

/**
 * Strict Funding consumer read: an explicit empty verified publication is a
 * tombstone, never an implicit carry of the previous offer set. Production
 * consumers must go through this view (or the issuer-bound offer handles).
 */
export function readStrictFundingOffers(input: {
  readonly views: StrictShadowCatalogViews;
  readonly fundingPublicationKey: string;
}): StrictFundingReadOutcome {
  const state = input.views.fundingByPublicationKey.get(
    input.fundingPublicationKey,
  );
  if (state === undefined) return Object.freeze({ kind: "missing" });
  if (state.tombstone) return Object.freeze({ kind: "tombstone" });
  return Object.freeze({ kind: "offers", offers: state.offers });
}

/**
 * Strict Credit consumer read: resolves a canonical edge to the exact
 * issuer-bound route handle published in the same CAS. A null result means
 * the edge was not published by the strict catalog, never a legacy registry
 * lookup.
 */
export function readStrictCreditRoute(input: {
  readonly views: StrictShadowCatalogViews;
  readonly canonicalEdgeId: CanonicalEdgeId;
}): StrictShadowCatalogRouteHandle | null {
  return input.views.handleByCanonicalEdgeId.get(
    input.canonicalEdgeId,
  ) ?? null;
}

/**
 * Public pricing publication key derivation, identical to the internal
 * strict-shadow-pricing-key-v1 format so consumers can locate the exact
 * publication without reverse-engineering the envelope.
 */
export function strictPricingPublicationKey(input: {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly instanceKey: InstanceKey;
  readonly stateInstanceKey: string;
}): string {
  return hashCanonical({
    format: "strict-shadow-pricing-key-v1",
    familyId: input.familyId,
    lineageId: input.lineageId,
    instanceKey: input.instanceKey,
    stateInstanceKey: input.stateInstanceKey,
  });
}

/** Funding publication keys published for one Family in a committed view. */
export function strictFundingPublicationKeysByFamily(input: {
  readonly views: StrictShadowCatalogViews;
  readonly familyId: FamilyId;
}): readonly string[] {
  return [...input.views.fundingByPublicationKey.entries()]
    .filter(([, state]) => state.familyId === input.familyId)
    .map(([key]) => key)
    .sort();
}

/** Pricing publication keys published for one Family in a committed view. */
export function strictPricingPublicationKeysByFamily(input: {
  readonly views: StrictShadowCatalogViews;
  readonly familyId: FamilyId;
}): readonly string[] {
  return [...input.views.pricingByPublicationKey.entries()]
    .filter(([, state]) => state.familyId === input.familyId)
    .map(([key]) => key)
    .sort();
}

export interface StrictCatalogConsumer {
  readonly views: StrictShadowCatalogViews;
  readonly resolvePricingMid: (input: {
    readonly pricingPublicationKey: string;
    readonly routeKey: RouteKey;
  }) => StrictPricingReadOutcome;
  readonly resolveFundingOffers: (input: {
    readonly fundingPublicationKey: string;
  }) => StrictFundingReadOutcome;
  readonly resolveCreditRoute: (input: {
    readonly canonicalEdgeId: CanonicalEdgeId;
  }) => StrictShadowCatalogRouteHandle | null;
}

export interface SourceBoundStrictCatalogConsumer {
  readonly boundSource: CanonicalSource;
  readonly resolvePricingMid: StrictCatalogConsumer["resolvePricingMid"];
  readonly resolveFundingOffers: StrictCatalogConsumer["resolveFundingOffers"];
  readonly resolveCreditRoute: StrictCatalogConsumer["resolveCreditRoute"];
}

/**
 * Single production-facing entry point over one committed strict catalog
 * publication. Solver/planner wiring must consume pricing/funding/credit
 * exclusively through this object (or the issuer-bound handles); a missing
 * strict value is an explicit outcome and never a legacy-registry fallback.
 */
export function createStrictCatalogConsumer(
  views: StrictShadowCatalogViews,
): StrictCatalogConsumer {
  if (
    views === null ||
    typeof views !== "object" ||
    !Object.isFrozen(views) ||
    !("pricingByPublicationKey" in views) ||
    !("fundingByPublicationKey" in views) ||
    !("handleByCanonicalEdgeId" in views)
  ) {
    throw new Error(
      "strict catalog consumer requires a committed frozen view",
    );
  }
  const resolvePricingMid: StrictCatalogConsumer["resolvePricingMid"] =
    (input) => readStrictPricingMid({
      views,
      ...input,
    });
  const resolveFundingOffers: StrictCatalogConsumer["resolveFundingOffers"] =
    (input) => readStrictFundingOffers({
      views,
      ...input,
    });
  const resolveCreditRoute: StrictCatalogConsumer["resolveCreditRoute"] =
    (input) => readStrictCreditRoute({
      views,
      ...input,
    });
  return Object.freeze({
    views,
    resolvePricingMid,
    resolveFundingOffers,
    resolveCreditRoute,
  });
}

/**
 * Source-bound production consumer. The solver/planner must create one
 * consumer per committed publication and never let a stale committed view
 * serve a newer canonical source: every resolve first asserts the view
 * source/generation and the runtime generation fence. This is still a
 * shadow/disabled-path consumer, not a default authority cutover.
 */
export function createSourceBoundStrictCatalogConsumer(input: {
  readonly views: StrictShadowCatalogViews;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly assertGenerationCurrent: (
    generation: number,
    source: CanonicalSource,
  ) => void;
}): SourceBoundStrictCatalogConsumer {
  const { views, source, generation, assertGenerationCurrent } = input;
  const assertBound = (): void => {
    if (
      views.source.number !== source.number ||
      views.source.hash.toLowerCase() !== source.hash.toLowerCase() ||
      views.source.generation !== source.generation
    ) {
      throw new Error(
        "strict catalog consumer source mismatch: committed view " +
          `${views.source.number}/${views.source.hash} cannot serve ` +
          `${source.number}/${source.hash}`,
      );
    }
    if (typeof assertGenerationCurrent !== "function") {
      throw new Error(
        "strict catalog consumer requires a generation fence",
      );
    }
    assertGenerationCurrent(generation, source);
  };
  const base = createStrictCatalogConsumer(views);
  return Object.freeze({
    boundSource: Object.freeze({
      number: source.number,
      hash: source.hash.toLowerCase(),
      generation: source.generation,
    }),
    resolvePricingMid: (input: {
      readonly pricingPublicationKey: string;
      readonly routeKey: RouteKey;
    }) => {
      assertBound();
      return base.resolvePricingMid(input);
    },
    resolveFundingOffers: (input: {
      readonly fundingPublicationKey: string;
    }) => {
      assertBound();
      return base.resolveFundingOffers(input);
    },
    resolveCreditRoute: (input: {
      readonly canonicalEdgeId: CanonicalEdgeId;
    }) => {
      assertBound();
      return base.resolveCreditRoute(input);
    },
  });
}

/** One pointer is the only observable shadow publication state. */
export interface CommittedStrictShadowCatalogPublication {
  readonly envelope: StrictShadowCatalogEnvelope;
  readonly views: StrictShadowCatalogViews;
}

declare const preparedStrictShadowCatalogPublicationBrand: unique symbol;

/** Opaque CAS candidate. Its envelope remains root-private until commit. */
export interface PreparedStrictShadowCatalogPublication {
  readonly [preparedStrictShadowCatalogPublicationBrand]: true;
}

interface RouteValueOwner {
  readonly family: LoadedFamilyPlugin;
  readonly instance: PreparedFamilyInstance;
  readonly publicationKey: string;
}

interface GraphValueOwner extends RouteValueOwner {
  readonly handle: FamilyRouteRuntimeHandle;
}

interface PricingValueOwner extends RouteValueOwner {
  readonly pricingKey: string;
}

interface CreditRouteValueOwner {
  readonly family: LoadedFamilyBox;
  readonly instance: PreparedFamilyInstance;
  readonly publicationKey: string;
  readonly source: CanonicalSource;
}

interface CreditGraphValueOwner extends CreditRouteValueOwner {
  readonly route: CreditRouteRuntimeHandle;
}

/**
 * Shadow-only Phase-D composition root. It does not import main/planner or
 * mutate any production registry. Every route/pricing value must first pass
 * through a lifecycle issuer, then all catalog Families enter one CAS.
 */
export class StrictAdapterFamilyShadowCatalogPublicationRoot {
  readonly #catalog: FamilyCapabilityCatalog;
  readonly #chainId: string;
  readonly #definition: ReturnType<typeof catalogPublicationDefinition>;
  readonly #routeOwners = new WeakMap<object, RouteValueOwner>();
  readonly #graphOwners = new WeakMap<object, GraphValueOwner>();
  readonly #pricingOwners = new WeakMap<object, PricingValueOwner>();
  readonly #creditRouteOwners = new WeakMap<object, CreditRouteValueOwner>();
  readonly #creditGraphOwners = new WeakMap<object, CreditGraphValueOwner>();
  readonly #prepared = new WeakMap<object, StrictShadowCatalogEnvelope>();
  readonly #valueAuthority: ReturnType<
    typeof createCatalogPublicationValueAuthority<
      StrictShadowCatalogInstance,
      StrictShadowCatalogRouteHandle,
      StrictShadowCatalogGraphEntry,
      PreparedPricingStateInstance
    >
  >;
  readonly #store: AdapterFamilyCatalogPublicationStore<
    StrictShadowCatalogInstance,
    StrictShadowCatalogRouteHandle,
    StrictShadowCatalogGraphEntry,
    PreparedPricingStateInstance
  >;
  #committed: CommittedStrictShadowCatalogPublication | null = null;

  constructor(input: {
    readonly catalog: FamilyCapabilityCatalog;
    readonly chainId: string;
    readonly terminalRemovalAuthority: CatalogTerminalRemovalAuthority;
    readonly sourceTransitionAuthority: CatalogSourceTransitionAuthority;
  }) {
    this.#catalog = input.catalog;
    this.#chainId = input.chainId;
    this.#definition = catalogPublicationDefinition(input.catalog, {
      terminalRemovalAuthority: input.terminalRemovalAuthority,
      sourceTransitionAuthority: input.sourceTransitionAuthority,
    });
    this.#valueAuthority = createCatalogPublicationValueAuthority({
      instance: this.#instanceValueContract(),
      routeHandle: this.#routeValueContract(),
      graphEntry: this.#graphValueContract(),
      pricingEntry: this.#pricingValueContract(),
    });
    this.#store = new AdapterFamilyCatalogPublicationStore({
      definition: this.#definition,
      chainId: input.chainId,
      valueAuthority: this.#valueAuthority,
    });
  }

  capture(): CommittedStrictShadowCatalogPublication | null {
    return this.#committed;
  }

  /** Converts one real lifecycle publication into a strict staged shard. */
  stageRouteFamily(input: {
    readonly publication: AdapterFamilyPublication;
    readonly status?: "resolved" | "partial";
    readonly inventoryMode?: CatalogInventoryMode;
    readonly outcomeRefs?: readonly string[];
    readonly centralScores?: ReadonlyMap<string, number>;
    readonly terminalRemovals?: readonly CatalogTerminalRemovalProof[];
  }): StrictShadowCatalogFamilyStage {
    if (
      input.inventoryMode !== undefined &&
      input.inventoryMode !== "append-only-delta"
    ) {
      throw new Error(
        "strict shadow catalog currently requires append-only-delta inventory",
      );
    }
    const family = this.#catalog.forFamily(input.publication.familyId);
    const domain = family.plugin.manifest.domain;
    assertSameSource(
      input.publication.source,
      input.publication.generation,
      "route Family publication",
    );
    const instances = input.publication.instances.map((instance) =>
      this.#stageRouteInstance({
        family,
        instance,
        source: input.publication.source,
        centralScores: input.centralScores,
      })
    );
    return Object.freeze({
      familyId: family.plugin.manifest.familyId,
      domain,
      source: freezeSource(input.publication.source),
      status: input.status ?? "resolved",
      inventoryMode: "append-only-delta",
      instances: Object.freeze(instances),
      terminalRemovals: Object.freeze([...(input.terminalRemovals ?? [])]),
      outcomeRefs: Object.freeze([...(input.outcomeRefs ?? [])]),
    });
  }

  /** Explicit stage for a strict Family not yet wired into this shadow slice. */
  stageUnsupported(input: {
    readonly familyId: FamilyId;
    readonly source: CanonicalSource;
    readonly outcomeRefs?: readonly string[];
  }): StrictShadowCatalogFamilyStage {
    if (
      !Array.isArray(input.outcomeRefs) ||
      input.outcomeRefs.length === 0 ||
      input.outcomeRefs.some((ref) => ref.trim().length === 0)
    ) {
      throw new Error(
        "unsupported stage requires explicit non-empty outcome refs",
      );
    }
    const family = this.#catalog.forStrictFamily(input.familyId);
    return Object.freeze({
      familyId: input.familyId,
      domain: family.plugin.manifest.domain,
      source: freezeSource(input.source),
      status: "unsupported",
      inventoryMode: "append-only-delta",
      instances: Object.freeze([]),
      terminalRemovals: Object.freeze([]),
      outcomeRefs: Object.freeze([...(input.outcomeRefs ?? [])]),
    });
  }

  /** Converts one real Funding lifecycle publication into a strict staged shard. */
  stageFundingFamily(input: {
    readonly publication: FundingFamilyPublication;
  }): StrictShadowCatalogFamilyStage {
    const family = this.#catalog.forStrictFamily(input.publication.familyId);
    const manifest = family.plugin.manifest as unknown as {
      readonly familyId: FamilyId;
      readonly domain: string;
    };
    if (manifest.domain !== "funding") {
      throw new Error("stageFundingFamily requires a Funding FamilyBox");
    }
    assertSameSource(
      input.publication.source,
      input.publication.generation,
      "Funding publication",
    );
    const source = freezeSource(input.publication.source);
    const state: StrictFundingPublicationState = Object.freeze({
      kind: "funding",
      familyId: manifest.familyId,
      source,
      generation: input.publication.generation,
      tombstone: input.publication.offers.length === 0,
      offers: Object.freeze([...input.publication.offers]),
      outcomes: Object.freeze([...input.publication.outcomes]),
    });
    for (const offer of input.publication.offers) {
      this.#assertFundingOfferProjection(offer, source);
    }
    for (const outcome of input.publication.outcomes) {
      if (
        outcome.status === "verified" &&
        (!Array.isArray(outcome.evidenceRefs) ||
          outcome.evidenceRefs.length === 0)
      ) {
        throw new Error(
          "verified funding outcome requires non-empty evidence refs",
        );
      }
    }
    const instance: CatalogStagedInstance<StrictFundingPublicationState> = {
      familyId: manifest.familyId,
      lineageId: lineageId("funding-publication"),
      instanceKey: instanceKey("state:funding"),
      fingerprint: hashCanonical({
        format: "strict-shadow-funding-state-v1",
        familyId: state.familyId,
        source: {
          number: source.number,
          hash: source.hash,
          generation: source.generation,
        },
        generation: state.generation,
        tombstone: state.tombstone,
        offers: state.offers.map((offer) => ({
          fundingId: offer.fundingId,
          asset: offer.asset.toLowerCase(),
          maxBorrow: offer.maxBorrow,
          fee: offer.fee,
        })),
      }),
      value: state,
    };
    return Object.freeze({
      familyId: manifest.familyId,
      domain: "funding",
      source,
      status: "resolved",
      inventoryMode: "append-only-delta",
      instances: Object.freeze([{
        instancePublicationKey: catalogInstancePublicationKey(instance),
        source,
        instance,
        routeHandles: new Map(),
        graphEntries: new Map(),
        pricingEntries: new Map(),
      }]),
      terminalRemovals: Object.freeze([]),
      outcomeRefs: Object.freeze(
        input.publication.outcomes.flatMap((outcome) => outcome.evidenceRefs),
      ),
    });
  }

  #assertFundingOfferProjection(
    offer: PreparedFundingOffer,
    source: CanonicalSource,
  ): void {
    if (!Object.isFrozen(offer)) {
      throw new Error("funding offer projection must be frozen");
    }
    if (offer.fundingId.trim().length === 0) {
      throw new Error("funding offer fundingId must be non-empty");
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(offer.asset)) {
      throw new Error("funding offer asset must be an address");
    }
    if (
      typeof offer.maxBorrow !== "bigint" ||
      offer.maxBorrow < 0n ||
      typeof offer.fee !== "bigint" ||
      offer.fee < 0n
    ) {
      throw new Error("funding offer amounts must be non-negative bigints");
    }
    if (offer.actionAdapterId.trim().length === 0) {
      throw new Error("funding offer actionAdapterId must be non-empty");
    }
    if (
      offer.source.number !== source.number ||
      offer.source.hash.toLowerCase() !== source.hash.toLowerCase() ||
      offer.source.generation !== source.generation
    ) {
      throw new Error("funding offer source escaped its publication");
    }
    if (
      !Array.isArray(offer.evidenceRefs) ||
      offer.evidenceRefs.length === 0
    ) {
      throw new Error("funding offer requires non-empty evidence refs");
    }
  }

  /** Converts one Credit lifecycle publication into a strict staged shard. */
  stageCreditFamily(input: {
    readonly family: LoadedFamilyBox;
    readonly publication: PreparedCreditRoutePublication;
    readonly instance: PreparedFamilyInstance;
    readonly centralScores?: ReadonlyMap<string, number>;
  }): StrictShadowCatalogFamilyStage {
    const manifest = input.family.plugin.manifest as unknown as {
      readonly familyId: FamilyId;
      readonly domain: string;
    };
    if (manifest.domain !== "credit") {
      throw new Error("stageCreditFamily requires a Credit FamilyBox");
    }
    if (input.publication.familyId !== manifest.familyId) {
      throw new Error("Credit publication escaped its FamilyBox");
    }
    assertSameSource(
      input.publication.source,
      input.publication.generation,
      "Credit publication",
    );
    assertIssuedPreparedFamilyInstance({
      family: input.family,
      instance: input.instance,
      source: input.publication.source,
      generation: input.publication.generation,
    });
    const source = freezeSource(input.publication.source);
    const publicationKey = catalogInstancePublicationKey({
      familyId: manifest.familyId,
      lineageId: input.instance.lineageId,
      instanceKey: input.instance.instanceKey,
    });
    const routeHandles = new Map<
      string,
      { readonly fingerprint: string; readonly value: CreditRouteRuntimeHandle }
    >();
    const graphEntries = new Map<
      string,
      { readonly fingerprint: string; readonly value: ProjectedCreditRouteGraph }
    >();
    for (const route of input.publication.routes) {
      assertIssuedCreditRouteRuntimeHandle(input.family, route);
      if (route.instanceKey !== input.instance.instanceKey) {
        throw new Error("Credit route escaped its staged instance");
      }
      if (
        route.source.number !== input.publication.source.number ||
        route.source.hash.toLowerCase() !==
          input.publication.source.hash.toLowerCase() ||
        route.source.generation !== input.publication.source.generation
      ) {
        throw new Error("Credit route source escaped its publication");
      }
      const projected = projectCreditRouteGraph({
        family: input.family,
        route,
        centralScores: input.centralScores,
      });
      assertIssuedProjectedCreditRoute(projected);
      this.#creditRouteOwners.set(route, {
        family: input.family,
        instance: input.instance,
        publicationKey,
        source,
      });
      this.#creditGraphOwners.set(projected, {
        family: input.family,
        route,
        instance: input.instance,
        publicationKey,
        source,
      });
      routeHandles.set(projected.edge.canonicalEdgeId, {
        fingerprint: projected.edge.canonicalEdgeId,
        value: route,
      });
      graphEntries.set(projected.edge.canonicalEdgeId, {
        fingerprint: projected.edge.canonicalEdgeId,
        value: projected,
      });
    }
    return Object.freeze({
      familyId: manifest.familyId,
      domain: "credit",
      source,
      status: "resolved",
      inventoryMode: "append-only-delta",
      instances: Object.freeze([{
        instancePublicationKey: publicationKey,
        source,
        instance: Object.freeze({
          familyId: manifest.familyId,
          lineageId: input.instance.lineageId,
          instanceKey: input.instance.instanceKey,
          fingerprint: hashCanonical({
            format: "strict-shadow-credit-instance-v1",
            familyId: manifest.familyId,
            lineageId: input.instance.lineageId,
            instanceKey: input.instance.instanceKey,
            routes: input.publication.routes.map((route) => route.routeKey),
          }),
          value: input.instance,
        }),
        routeHandles,
        graphEntries,
        pricingEntries: new Map(),
      }]),
      terminalRemovals: Object.freeze([]),
      outcomeRefs: Object.freeze([]),
    });
  }

  prepare(input: {
    readonly source: CanonicalSource;
    readonly previous: CommittedStrictShadowCatalogPublication | null;
    readonly stages: readonly StrictShadowCatalogFamilyStage[];
    readonly sourceAnchors: readonly CatalogDiscoverySourceAnchor[];
    readonly sourceTransitionProof?: CatalogSourceTransitionProof;
  }): PreparedStrictShadowCatalogPublication {
    if (input.previous !== this.#committed) {
      throw new Error("shadow catalog prepare must use the captured publication");
    }
    for (const stage of input.stages) {
      if (stage.inventoryMode !== "append-only-delta") {
        throw new Error(
          "strict shadow catalog currently requires append-only-delta inventory",
        );
      }
    }
    const envelope = prepareAdapterFamilyCatalogPublication({
      definition: this.#definition,
      chainId: this.#chainId,
      source: input.source,
      previous: input.previous?.envelope ?? null,
      stages: input.stages,
      sourceAnchors: input.sourceAnchors,
      valueAuthority: this.#valueAuthority,
      ...(input.sourceTransitionProof === undefined
        ? {}
        : { sourceTransitionProof: input.sourceTransitionProof }),
    });
    if (
      input.previous !== null &&
      envelope.snapshot.sourceTransition?.status !== "canonical-descendant"
    ) {
      throw new Error(
        "strict shadow catalog requires a resolved canonical source transition proof",
      );
    }
    // Cross-map validation happens before CAS; only the exact resulting
    // envelope is later allowed to become observable.
    deriveStrictShadowCatalogViews(envelope);
    const prepared = Object.freeze({}) as PreparedStrictShadowCatalogPublication;
    this.#prepared.set(prepared, envelope);
    return prepared;
  }

  async compareAndPublish(input: {
    readonly expected: CommittedStrictShadowCatalogPublication | null;
    readonly staged: PreparedStrictShadowCatalogPublication;
    readonly verifyCanonicalSource: (
      source: CanonicalSource,
    ) => void | Promise<void>;
    readonly assertGenerationCurrent: (source: CanonicalSource) => void;
  }): Promise<boolean> {
    const stagedEnvelope = this.#prepared.get(input.staged);
    if (stagedEnvelope === undefined) {
      throw new Error("shadow catalog candidate was not prepared by this root");
    }
    this.#prepared.delete(input.staged);
    if (this.#committed !== input.expected) return false;
    const committed = await this.#store.compareAndPublish({
      expected: input.expected?.envelope ?? null,
      staged: stagedEnvelope,
      verifyCanonicalSource: input.verifyCanonicalSource,
      assertGenerationCurrent: input.assertGenerationCurrent,
    });
    if (!committed) return false;
    const envelope = this.#store.capture();
    if (envelope !== stagedEnvelope) {
      throw new Error("shadow catalog store committed an unexpected envelope");
    }
    const next = Object.freeze({
      envelope,
      views: deriveStrictShadowCatalogViews(envelope),
    });
    this.#committed = next;
    return true;
  }

  #stageRouteInstance(input: {
    readonly family: LoadedFamilyPlugin;
    readonly instance: PreparedFamilyInstance;
    readonly source: CanonicalSource;
    readonly centralScores?: ReadonlyMap<string, number>;
  }): CatalogStagedInstanceBundle<
    PreparedFamilyInstance,
    FamilyRouteRuntimeHandle,
    ProjectedFamilyRouteGraph,
    PreparedPricingStateInstance
  > {
    assertIssuedPreparedFamilyInstance({
      family: input.family,
      instance: input.instance,
      source: input.source,
      generation: input.source.generation,
    });
    const publicationKey = catalogInstancePublicationKey(input.instance);
    const handles = new Map<string, {
      readonly fingerprint: string;
      readonly value: FamilyRouteRuntimeHandle;
    }>();
    const graphs = new Map<string, {
      readonly fingerprint: string;
      readonly value: ProjectedFamilyRouteGraph;
    }>();
    for (const route of input.instance.routes) {
      const handle = input.instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(`prepared route ${route.routeKey} has no issued handle`);
      }
      const graph = projectFamilyRouteGraph({
        family: input.family,
        descriptor: input.instance.descriptor,
        route,
        handle,
      }, input.centralScores);
      const key = graph.edge.canonicalEdgeId;
      if (handles.has(key) || graphs.has(key)) {
        throw new Error(`prepared instance duplicates canonical edge ${key}`);
      }
      const owner = Object.freeze({
        family: input.family,
        instance: input.instance,
        publicationKey,
      });
      this.#routeOwners.set(handle, owner);
      this.#graphOwners.set(graph, Object.freeze({ ...owner, handle }));
      const fingerprint = routePublicationFingerprint(graph);
      handles.set(key, Object.freeze({ fingerprint, value: handle }));
      graphs.set(key, Object.freeze({ fingerprint, value: graph }));
    }
    if (handles.size !== input.instance.routeHandles.length) {
      throw new Error("prepared instance has an unprojected route handle");
    }
    const pricing = new Map<string, {
      readonly fingerprint: string;
      readonly value: PreparedPricingStateInstance;
    }>();
    for (const state of input.instance.pricingInstances) {
      assertIssuedPreparedFamilyPricingStateInstance({
        family: input.family,
        instance: input.instance,
        pricing: state,
        source: input.source,
        generation: input.source.generation,
      });
      const key = pricingPublicationKey(input.instance, state);
      if (pricing.has(key)) {
        throw new Error(`prepared instance duplicates pricing shard ${key}`);
      }
      this.#pricingOwners.set(state, Object.freeze({
        family: input.family,
        instance: input.instance,
        publicationKey,
        pricingKey: key,
      }));
      pricing.set(key, Object.freeze({
        fingerprint: pricingPublicationFingerprint(state),
        value: state,
      }));
    }
    return Object.freeze({
      instancePublicationKey: publicationKey,
      source: freezeSource(input.source),
      instance: Object.freeze({
        familyId: input.instance.familyId,
        lineageId: input.instance.lineageId,
        instanceKey: input.instance.instanceKey,
        // This is a publication-bundle fingerprint, not a descriptor compile
        // key. Bind every derived value so score-only Graph changes can enter
        // the atomic CAS without pretending the instance stayed unchanged.
        fingerprint: hashCanonical({
          format: "strict-shadow-instance-bundle-v1",
          instance: preparedInstancePublicationFingerprint(input.instance),
          routeHandles: [...handles]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => ({ key, fingerprint: entry.fingerprint })),
          graphs: [...graphs]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => ({ key, fingerprint: entry.fingerprint })),
          pricing: [...pricing]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => ({ key, fingerprint: entry.fingerprint })),
        }),
        value: input.instance,
      }),
      routeHandles: new SealedReadonlyMap(handles),
      graphEntries: new SealedReadonlyMap(graphs),
      pricingEntries: new SealedReadonlyMap(pricing),
    });
  }

  #instanceValueContract() {
    return Object.freeze({
      seal: (value: StrictShadowCatalogInstance, binding: CatalogValueBinding) => {
        this.#assertShadowInstance(value, binding);
        return value;
      },
      carry: () => rejectCrossGenerationCarry(),
      assertValid: (
        value: StrictShadowCatalogInstance,
        binding: CatalogValueBinding,
      ) => {
        this.#assertShadowInstance(value, binding);
      },
    });
  }

  #routeValueContract() {
    return Object.freeze({
      seal: (
        value: StrictShadowCatalogRouteHandle,
        binding: CatalogValueBinding,
      ) => {
        this.#assertRoute(value, binding);
        return value;
      },
      carry: () => rejectCrossGenerationCarry(),
      assertValid: (
        value: StrictShadowCatalogRouteHandle,
        binding: CatalogValueBinding,
      ) => {
        this.#assertRoute(value, binding);
      },
    });
  }

  #graphValueContract() {
    return Object.freeze({
      seal: (
        value: StrictShadowCatalogGraphEntry,
        binding: CatalogValueBinding,
      ) => {
        this.#assertGraph(value, binding);
        return value;
      },
      carry: () => rejectCrossGenerationCarry(),
      assertValid: (
        value: StrictShadowCatalogGraphEntry,
        binding: CatalogValueBinding,
      ) => {
        this.#assertGraph(value, binding);
      },
    });
  }

  #pricingValueContract() {
    return Object.freeze({
      seal: (value: PreparedPricingStateInstance, binding: CatalogValueBinding) => {
        this.#assertPricing(value, binding);
        return value;
      },
      carry: () => rejectCrossGenerationCarry(),
      assertValid: (
        value: PreparedPricingStateInstance,
        binding: CatalogValueBinding,
      ) => {
        this.#assertPricing(value, binding);
      },
    });
  }

  #assertInstance(
    value: PreparedFamilyInstance,
    binding: CatalogValueBinding,
  ): void {
    const family = this.#catalog.forStrictFamily(binding.familyId);
    assertBindingIdentity(value, binding);
    assertIssuedPreparedFamilyInstance({
      family,
      instance: value,
      source: binding.source,
      generation: binding.source.generation,
    });
  }

  #assertShadowInstance(
    value: StrictShadowCatalogInstance,
    binding: CatalogValueBinding,
  ): void {
    if (isFundingState(value)) {
      this.#assertFunding(value, binding);
      return;
    }
    this.#assertInstance(value as PreparedFamilyInstance, binding);
  }

  #assertFunding(
    value: StrictFundingPublicationState,
    binding: CatalogValueBinding,
  ): void {
    if (
      binding.kind !== "instance" ||
      binding.key !== binding.instancePublicationKey
    ) {
      throw new Error("funding state escaped its catalog instance binding");
    }
    if (
      value.familyId !== binding.familyId ||
      value.generation !== binding.source.generation ||
      value.source.number !== binding.source.number ||
      value.source.hash.toLowerCase() !== binding.source.hash.toLowerCase() ||
      value.source.generation !== binding.source.generation
    ) {
      throw new Error("funding state escaped its catalog source binding");
    }
    if (
      !Object.isFrozen(value) ||
      !Object.isFrozen(value.offers) ||
      !Object.isFrozen(value.outcomes)
    ) {
      throw new Error("funding state must be deep-frozen");
    }
  }

  #assertRoute(
    value: StrictShadowCatalogRouteHandle,
    binding: CatalogValueBinding,
  ): RouteValueOwner {
    const creditOwner = this.#creditRouteOwners.get(value);
    if (creditOwner !== undefined) {
      this.#assertCreditOwner(creditOwner, binding);
      assertIssuedCreditRouteRuntimeHandle(
        creditOwner.family,
        value as CreditRouteRuntimeHandle,
      );
      return creditOwner as unknown as RouteValueOwner;
    }
    const owner = this.#routeOwners.get(value);
    if (owner === undefined) {
      throw new Error("route handle was not staged by this shadow catalog root");
    }
    assertOwnerBinding(owner, binding);
    assertIssuedFamilyRouteRuntimeHandleAtSource({
      family: owner.family,
      handle: value as FamilyRouteRuntimeHandle,
      source: binding.source,
      generation: binding.source.generation,
    });
    return owner;
  }

  #assertGraph(
    value: StrictShadowCatalogGraphEntry,
    binding: CatalogValueBinding,
  ): GraphValueOwner {
    const creditOwner = this.#creditGraphOwners.get(value);
    if (creditOwner !== undefined) {
      this.#assertCreditOwner(creditOwner, binding);
      assertIssuedProjectedCreditRoute(value as ProjectedCreditRouteGraph);
      if ((value as ProjectedCreditRouteGraph).handle !== creditOwner.route) {
        throw new Error("Credit Graph route changed after issue");
      }
      return creditOwner as unknown as GraphValueOwner;
    }
    const owner = this.#graphOwners.get(value);
    if (owner === undefined || owner.handle !== value.handle) {
      throw new Error("Graph route was not staged by this shadow catalog root");
    }
    assertOwnerBinding(owner, binding);
    if (value.edge.canonicalEdgeId !== binding.key) {
      throw new Error("Graph route canonical edge key changed");
    }
    assertIssuedProjectedFamilyRouteGraph({
      family: owner.family,
      projected: value as ProjectedFamilyRouteGraph,
      source: binding.source,
    });
    return owner;
  }

  #assertCreditOwner(
    owner: CreditRouteValueOwner | CreditGraphValueOwner,
    binding: CatalogValueBinding,
  ): void {
    if (
      binding.instancePublicationKey !== owner.publicationKey ||
      binding.familyId !== owner.family.plugin.manifest.familyId ||
      binding.lineageId !== owner.instance.lineageId ||
      binding.instanceKey !== owner.instance.instanceKey ||
      binding.source.number !== owner.source.number ||
      binding.source.hash.toLowerCase() !== owner.source.hash.toLowerCase() ||
      binding.source.generation !== owner.source.generation
    ) {
      throw new Error("Credit value escaped its catalog binding");
    }
  }

  #assertPricing(
    value: PreparedPricingStateInstance,
    binding: CatalogValueBinding,
  ): PricingValueOwner {
    const owner = this.#pricingOwners.get(value);
    if (owner === undefined || owner.pricingKey !== binding.key) {
      throw new Error("pricing state was not staged by this shadow catalog root");
    }
    assertOwnerBinding(owner, binding);
    assertIssuedPreparedFamilyPricingStateInstance({
      family: owner.family,
      instance: owner.instance,
      pricing: value,
      source: binding.source,
      generation: binding.source.generation,
    });
    return owner;
  }

}

function deriveStrictShadowCatalogViews(
  envelope: StrictShadowCatalogEnvelope,
): StrictShadowCatalogViews {
  const routes: StrictShadowCatalogGraphEntry[] = [];
  const edges: (TokenEdge & { readonly canonicalEdgeId: CanonicalEdgeId })[] = [];
  const handles = new Map<CanonicalEdgeId, StrictShadowCatalogRouteHandle>();
  for (const [key, graphEntry] of [...envelope.privateState.graphEntries].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const graph = graphEntry.value;
    const edgeId = graph.edge.canonicalEdgeId;
    if (key !== edgeId) {
      throw new Error(`Graph publication key ${key} does not equal ${edgeId}`);
    }
    const routeEntry = envelope.privateState.routeHandles.get(key);
    if (routeEntry === undefined || routeEntry.value !== graph.handle) {
      throw new Error(`Graph/handle publication identity differs at ${key}`);
    }
    if (handles.has(edgeId)) {
      throw new Error(`duplicate committed canonical edge ${edgeId}`);
    }
    handles.set(edgeId, routeEntry.value);
    routes.push(graph);
    edges.push(graph.edge);
  }
  if (handles.size !== envelope.privateState.routeHandles.size) {
    throw new Error("committed route-handle view contains an unprojected handle");
  }
  const pricing = new Map<string, PreparedPricingStateInstance>(
    [...envelope.privateState.pricingEntries]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, entry.value]),
  );
  const funding = new Map<string, StrictFundingPublicationState>();
  for (const [key, entry] of envelope.privateState.instances) {
    if (isFundingState(entry.value)) {
      funding.set(key, entry.value);
    }
  }
  return Object.freeze({
    revision: envelope.snapshot.revision,
    source: envelope.snapshot.source,
    publicationFingerprint: envelope.snapshot.publicationFingerprint,
    graphRoutes: Object.freeze(routes),
    edges: Object.freeze(edges),
    handleByCanonicalEdgeId: new SealedReadonlyMap(handles),
    pricingByPublicationKey: new SealedReadonlyMap(pricing),
    fundingByPublicationKey: new SealedReadonlyMap(funding),
  });
}

function rejectCrossGenerationCarry(): never {
  throw new Error(
    "route Family publication carry requires an issuer-bound StateInstance mutation proof",
  );
}

function preparedInstancePublicationFingerprint(
  instance: PreparedFamilyInstance,
): string {
  return hashCanonical({
    format: "strict-shadow-prepared-instance-v1",
    familyId: instance.familyId,
    lineageId: instance.lineageId,
    candidateKey: instance.candidateKey,
    instanceKey: instance.instanceKey,
    staticBindingFingerprint: instance.staticBindingFingerprint,
    staticEvidenceFingerprint: instance.staticEvidenceFingerprint,
    routes: instance.routes.map((route) => ({
      routeKey: route.routeKey,
      tokenIn: route.tokenIn.toLowerCase(),
      tokenOut: route.tokenOut.toLowerCase(),
      bindingFingerprint: route.bindingRef.fingerprint,
    })),
    pricing: instance.pricingInstances.map((state) => ({
      stateInstanceKey: state.stateInstanceKey,
      groupBindingFingerprint: state.groupBindingFingerprint,
      staticBindingFingerprint: state.staticBindingFingerprint,
      snapshotCompatibilityFingerprint: state.snapshotCompatibilityFingerprint,
      staticEvidenceFingerprint: state.staticEvidenceFingerprint,
      currentEvidenceFingerprint: state.currentEvidenceFingerprint,
    })),
  });
}

function routePublicationFingerprint(graph: ProjectedFamilyRouteGraph): string {
  return hashCanonical({
    format: "strict-shadow-route-v1",
    canonicalEdgeId: graph.edge.canonicalEdgeId,
    familyId: graph.handle.familyId,
    lineageId: graph.handle.lineageId,
    instanceKey: graph.handle.instanceKey,
    routeKey: graph.handle.routeKey,
    adapterId: graph.edge.adapterId,
    target: graph.edge.target.toLowerCase(),
    tokenIn: graph.edge.tokenIn.toLowerCase(),
    tokenOut: graph.edge.tokenOut.toLowerCase(),
    venueIdentityHash: graph.venueIdentityHash,
    score: graph.edge.score ?? 0,
  });
}

function pricingPublicationKey(
  instance: PreparedFamilyInstance,
  pricing: PreparedPricingStateInstance,
): string {
  return strictPricingPublicationKey({
    familyId: instance.familyId,
    lineageId: instance.lineageId,
    instanceKey: instance.instanceKey,
    stateInstanceKey: pricing.stateInstanceKey,
  });
}

function pricingPublicationFingerprint(
  pricing: PreparedPricingStateInstance,
): string {
  return hashCanonical({
    format: "strict-shadow-pricing-v1",
    stateKey: pricing.stateKey,
    stateInstanceKey: pricing.stateInstanceKey,
    groupBindingFingerprint: pricing.groupBindingFingerprint,
    staticBindingFingerprint: pricing.staticBindingFingerprint,
    snapshotCompatibilityFingerprint: pricing.snapshotCompatibilityFingerprint,
    staticEvidenceFingerprint: pricing.staticEvidenceFingerprint,
    currentEvidenceFingerprint: pricing.currentEvidenceFingerprint,
    unavailable: [...pricing.unavailable].sort(([left], [right]) =>
      left.localeCompare(right)
    ),
  });
}

function assertBindingIdentity(
  instance: PreparedFamilyInstance,
  binding: CatalogValueBinding,
): void {
  if (
    binding.kind !== "instance" ||
    binding.key !== binding.instancePublicationKey ||
    instance.familyId !== binding.familyId ||
    instance.lineageId !== binding.lineageId ||
    instance.instanceKey !== binding.instanceKey
  ) {
    throw new Error("prepared instance escaped its catalog binding");
  }
}

function assertOwnerBinding(
  owner: RouteValueOwner,
  binding: CatalogValueBinding,
): void {
  if (
    owner.publicationKey !== binding.instancePublicationKey ||
    owner.family.plugin.manifest.familyId !== binding.familyId ||
    owner.instance.lineageId !== binding.lineageId ||
    owner.instance.instanceKey !== binding.instanceKey
  ) {
    throw new Error(`${binding.kind} escaped its staged instance binding`);
  }
}

function assertSameSource(
  source: CanonicalSource,
  generation: number,
  label: string,
): void {
  if (
    source.generation !== generation ||
    !Number.isSafeInteger(source.number) ||
    source.number < 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(source.hash)
  ) {
    throw new Error(`${label} has an invalid canonical source`);
  }
}

function freezeSource(source: CanonicalSource): CanonicalSource {
  assertSameSource(source, source.generation, "canonical source");
  return Object.freeze({
    number: source.number,
    hash: source.hash.toLowerCase(),
    generation: source.generation,
  });
}

class SealedReadonlyMap<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #values: Map<Key, Value>;

  constructor(values: ReadonlyMap<Key, Value>) {
    this.#values = new Map(values);
    Object.freeze(this);
  }

  get size(): number { return this.#values.size; }
  get(key: Key): Value | undefined { return this.#values.get(key); }
  has(key: Key): boolean { return this.#values.has(key); }
  entries(): MapIterator<[Key, Value]> { return this.#values.entries(); }
  keys(): MapIterator<Key> { return this.#values.keys(); }
  values(): MapIterator<Value> { return this.#values.values(); }
  forEach(
    callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
    thisArg?: unknown,
  ): void {
    this.#values.forEach((value, key) => {
      callbackfn.call(thisArg, value, key, this);
    });
  }
  [Symbol.iterator](): MapIterator<[Key, Value]> { return this.entries(); }
  get [Symbol.toStringTag](): string { return "SealedReadonlyMap"; }
}

Object.freeze(SealedReadonlyMap.prototype);
