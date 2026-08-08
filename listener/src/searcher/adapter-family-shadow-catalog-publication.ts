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
  type CatalogSourceTransitionAuthority,
  type CatalogSourceTransitionProof,
  type CatalogStagedInstanceBundle,
  type CatalogTerminalRemovalAuthority,
  type CatalogTerminalRemovalProof,
  type CatalogValueBinding,
} from "./adapter-family-catalog-publication.js";
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
import type { FamilyId } from
  "./venues/adapter-family-identifiers.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { CanonicalEdgeId } from
  "./venues/blockscan-state-capability.js";
import { hashCanonical } from "./venues/canonical-value.js";
import {
  type FamilyCapabilityCatalog,
  type LoadedFamilyPlugin,
} from "./venues/family-capability-catalog.js";

export type StrictShadowCatalogFamilyStage = CatalogFamilyStage<
  PreparedFamilyInstance,
  FamilyRouteRuntimeHandle,
  ProjectedFamilyRouteGraph,
  PreparedPricingStateInstance
>;

export type StrictShadowCatalogEnvelope =
  AdapterFamilyCatalogPublicationEnvelope<
    PreparedFamilyInstance,
    FamilyRouteRuntimeHandle,
    ProjectedFamilyRouteGraph,
    PreparedPricingStateInstance
  >;

export interface StrictShadowCatalogViews {
  readonly revision: number;
  readonly source: CanonicalSource;
  readonly publicationFingerprint: string;
  readonly graphRoutes: readonly ProjectedFamilyRouteGraph[];
  readonly edges: readonly (TokenEdge & {
    readonly canonicalEdgeId: CanonicalEdgeId;
  })[];
  readonly handleByCanonicalEdgeId: ReadonlyMap<
    CanonicalEdgeId,
    FamilyRouteRuntimeHandle
  >;
  readonly pricingByPublicationKey: ReadonlyMap<
    string,
    PreparedPricingStateInstance
  >;
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
  readonly #prepared = new WeakMap<object, StrictShadowCatalogEnvelope>();
  readonly #valueAuthority: ReturnType<
    typeof createCatalogPublicationValueAuthority<
      PreparedFamilyInstance,
      FamilyRouteRuntimeHandle,
      ProjectedFamilyRouteGraph,
      PreparedPricingStateInstance
    >
  >;
  readonly #store: AdapterFamilyCatalogPublicationStore<
    PreparedFamilyInstance,
    FamilyRouteRuntimeHandle,
    ProjectedFamilyRouteGraph,
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
      seal: (value: PreparedFamilyInstance, binding: CatalogValueBinding) => {
        this.#assertInstance(value, binding);
        return value;
      },
      carry: () => rejectCrossGenerationCarry(),
      assertValid: (value: PreparedFamilyInstance, binding: CatalogValueBinding) => {
        this.#assertInstance(value, binding);
      },
    });
  }

  #routeValueContract() {
    return Object.freeze({
      seal: (value: FamilyRouteRuntimeHandle, binding: CatalogValueBinding) => {
        this.#assertRoute(value, binding);
        return value;
      },
      carry: () => rejectCrossGenerationCarry(),
      assertValid: (
        value: FamilyRouteRuntimeHandle,
        binding: CatalogValueBinding,
      ) => {
        this.#assertRoute(value, binding);
      },
    });
  }

  #graphValueContract() {
    return Object.freeze({
      seal: (value: ProjectedFamilyRouteGraph, binding: CatalogValueBinding) => {
        this.#assertGraph(value, binding);
        return value;
      },
      carry: () => rejectCrossGenerationCarry(),
      assertValid: (
        value: ProjectedFamilyRouteGraph,
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
    const family = this.#routeFamily(binding);
    assertBindingIdentity(value, binding);
    assertIssuedPreparedFamilyInstance({
      family,
      instance: value,
      source: binding.source,
      generation: binding.source.generation,
    });
  }

  #assertRoute(
    value: FamilyRouteRuntimeHandle,
    binding: CatalogValueBinding,
  ): RouteValueOwner {
    const owner = this.#routeOwners.get(value);
    if (owner === undefined) {
      throw new Error("route handle was not staged by this shadow catalog root");
    }
    assertOwnerBinding(owner, binding);
    assertIssuedFamilyRouteRuntimeHandleAtSource({
      family: owner.family,
      handle: value,
      source: binding.source,
      generation: binding.source.generation,
    });
    return owner;
  }

  #assertGraph(
    value: ProjectedFamilyRouteGraph,
    binding: CatalogValueBinding,
  ): GraphValueOwner {
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
      projected: value,
      source: binding.source,
    });
    return owner;
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

  #routeFamily(binding: CatalogValueBinding): LoadedFamilyPlugin {
    const family = this.#catalog.forFamily(binding.familyId);
    const domain = family.plugin.manifest.domain;
    if (domain !== "swap" && domain !== "protocol") {
      throw new Error(`${binding.familyId} has no ordinary route publication`);
    }
    return family;
  }
}

function deriveStrictShadowCatalogViews(
  envelope: StrictShadowCatalogEnvelope,
): StrictShadowCatalogViews {
  const routes: ProjectedFamilyRouteGraph[] = [];
  const edges: (TokenEdge & { readonly canonicalEdgeId: CanonicalEdgeId })[] = [];
  const handles = new Map<CanonicalEdgeId, FamilyRouteRuntimeHandle>();
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
  return Object.freeze({
    revision: envelope.snapshot.revision,
    source: envelope.snapshot.source,
    publicationFingerprint: envelope.snapshot.publicationFingerprint,
    graphRoutes: Object.freeze(routes),
    edges: Object.freeze(edges),
    handleByCanonicalEdgeId: new SealedReadonlyMap(handles),
    pricingByPublicationKey: new SealedReadonlyMap(pricing),
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
  return hashCanonical({
    format: "strict-shadow-pricing-key-v1",
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
