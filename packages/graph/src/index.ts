import { assertHash, deepFreeze, hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import type {
  AssetPortV1,
  InstanceCatalogV1,
  InstancePublicationV1,
  StaticTransitionProjectionV1,
} from "../../catalog/src/index.ts";
import { validateInstanceCatalog } from "../../catalog/src/index.ts";
import type { CanonicalCutoffV1 } from "../../discovery/src/index.ts";
import type { CanonicalLeaseGuardPort } from "../../canonical-source/src/lease-guard-port.ts";

export interface RehydrationRefV1 {
  readonly familyDefinitionHash: Hash;
  readonly instanceKey: string;
  readonly instancePublicationHash: Hash;
  readonly staticProjectionMemoHash: Hash;
  readonly requestedArtifactDependencyRoot: Hash;
}

export interface PersistedGraphEdgeV1 {
  readonly edgeId: Hash;
  readonly inputAssetPorts: readonly AssetPortV1[];
  readonly outputAssetPorts: readonly AssetPortV1[];
  readonly opaqueTransitionRef: Hash;
  readonly constraintRefs: readonly Hash[];
  readonly owningFamilyId: string;
  readonly owningFamilyDefinitionHash: Hash;
  readonly owningInstanceKey: string;
  readonly instancePublicationHash: Hash;
  readonly staticProjectionHash: Hash;
  readonly projectionHash: Hash;
  readonly rehydrationRef: RehydrationRefV1;
}

export interface PersistedGraphV1 {
  readonly cutoff: CanonicalCutoffV1;
  readonly instanceCatalogRoot: Hash;
  readonly edges: readonly PersistedGraphEdgeV1[];
  readonly edgeCount: string;
  readonly graphRoot: Hash;
}

export interface IssuedRouteHandle {
  readonly opaque: object;
}

declare const graphRouteHandleBrand: unique symbol;

/**
 * A process-local capability for one runtime graph edge.
 *
 * The brand is intentionally module-private.  The lease also authenticates
 * the object by identity before returning the family-issued handle it owns.
 */
export type GraphRouteHandle = {
  readonly [graphRouteHandleBrand]: "GraphRouteHandle";
};

export interface RuntimeGraphEdgeV1 extends PersistedGraphEdgeV1 {
  readonly routeHandle: GraphRouteHandle;
}

export interface RouteHandleIssuerPort {
  issueRouteHandle(
    publication: InstancePublicationV1,
    projection: StaticTransitionProjectionV1,
    ref: RehydrationRefV1,
  ): IssuedRouteHandle;
}

export interface GraphLeaseBindingV1 {
  readonly generationId: string;
  readonly readyRecordHash: Hash;
  readonly generationRefreshPolicyHash: Hash;
  readonly cutoff: CanonicalCutoffV1;
  readonly definitionCatalogRoot: Hash;
  readonly instanceCatalogRoot: Hash;
  readonly graphRoot: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly candidatePartitionProofStorageHash: Hash;
  readonly nominationClosureRoot: Hash;
  readonly nominationClosureStorageHash: Hash;
}

export type ActiveReadyAuthorityBindingV1 = GraphLeaseBindingV1;

export interface GraphServingAdmissionV1 {
  readonly opaque: object;
}

export interface GraphServingAdmissionGuardPort {
  assertServingBindingCurrent(binding: GraphLeaseBindingV1): Promise<void>;
  consumeServingAdmission(admission: GraphServingAdmissionV1): Promise<GraphLeaseBindingV1>;
}

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function createGraphRouteHandle(): GraphRouteHandle {
  return Object.freeze(Object.create(null)) as GraphRouteHandle;
}

function sealEdge(
  publication: InstancePublicationV1,
  projection: StaticTransitionProjectionV1,
): PersistedGraphEdgeV1 {
  const rehydrationRef = deepFreeze({
    familyDefinitionHash: publication.familyDefinitionHash,
    instanceKey: publication.instanceKey,
    instancePublicationHash: publication.instancePublicationHash,
    staticProjectionMemoHash: publication.staticProjectionMemoHash,
    requestedArtifactDependencyRoot: publication.requestedArtifactDependencyRoot,
  });
  const payload = {
    inputAssetPorts: projection.inputAssetPorts,
    outputAssetPorts: projection.outputAssetPorts,
    opaqueTransitionRef: projection.opaqueTransitionRef,
    constraintRefs: projection.constraintRefs,
    owningFamilyId: publication.familyId,
    owningFamilyDefinitionHash: publication.familyDefinitionHash,
    owningInstanceKey: publication.instanceKey,
    instancePublicationHash: publication.instancePublicationHash,
    staticProjectionHash: projection.staticProjectionHash,
    projectionHash: projection.projectionHash,
    rehydrationRef,
  };
  return deepFreeze({ edgeId: hashDomain("aloha/persisted-graph-edge/v1", payload), ...payload });
}

export function buildPersistedGraph(instanceCatalog: InstanceCatalogV1): PersistedGraphV1 {
  validateInstanceCatalog(instanceCatalog);
  const edges = instanceCatalog.publications.flatMap(publication =>
    publication.transitions.map(projection => sealEdge(publication, projection))
  ).sort((left, right) => compareText(left.edgeId, right.edgeId));
  if (new Set(edges.map(edge => edge.edgeId)).size !== edges.length) throw new Error("duplicate-graph-edge");
  const graphRoot = hashDomain("aloha/persisted-graph/v1", {
    cutoff: instanceCatalog.cutoff,
    instanceCatalogRoot: instanceCatalog.instanceCatalogRoot,
    edges,
  });
  return deepFreeze({
    cutoff: instanceCatalog.cutoff,
    instanceCatalogRoot: instanceCatalog.instanceCatalogRoot,
    edges,
    edgeCount: String(edges.length),
    graphRoot,
  });
}

function sameCutoff(left: CanonicalCutoffV1, right: CanonicalCutoffV1): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

export class GraphViewLeaseV1 {
  readonly leaseId: Hash;
  readonly binding: GraphLeaseBindingV1;
  readonly edges: readonly RuntimeGraphEdgeV1[];
  #released = false;
  readonly #onRelease: () => void;
  readonly #canonicalGuard: CanonicalLeaseGuardPort;
  readonly #assertServingCurrent: () => Promise<void>;
  readonly #routeHandleAuthority = new WeakMap<GraphRouteHandle, {
    readonly edgeId: Hash;
    readonly issuedRouteHandle: IssuedRouteHandle;
  }>();

  private constructor(
    binding: GraphLeaseBindingV1,
    graph: PersistedGraphV1,
    catalog: InstanceCatalogV1,
    issuer: RouteHandleIssuerPort,
    processEpoch: string,
    canonicalGuard: CanonicalLeaseGuardPort,
    assertServingCurrent: () => Promise<void>,
    onRelease: () => void = () => {},
  ) {
    canonicalGuard.assertViewAuthorityActive(binding.cutoff);
    const activeReadyBinding = deepFreeze({
      generationId: binding.generationId,
      readyRecordHash: binding.readyRecordHash,
      generationRefreshPolicyHash: binding.generationRefreshPolicyHash,
      cutoff: deepFreeze({ ...binding.cutoff }),
      definitionCatalogRoot: binding.definitionCatalogRoot,
      instanceCatalogRoot: binding.instanceCatalogRoot,
      graphRoot: binding.graphRoot,
      releaseProvenanceHash: binding.releaseProvenanceHash,
      candidatePartitionProofStorageHash: binding.candidatePartitionProofStorageHash,
      nominationClosureRoot: binding.nominationClosureRoot,
      nominationClosureStorageHash: binding.nominationClosureStorageHash,
    });
    const recomputedGraph = buildPersistedGraph(catalog);
    const suppliedGraphRoot = hashDomain("aloha/persisted-graph/v1", {
      cutoff: graph.cutoff,
      instanceCatalogRoot: graph.instanceCatalogRoot,
      edges: graph.edges,
    });
    if (
      graph.graphRoot !== binding.graphRoot
      || graph.graphRoot !== recomputedGraph.graphRoot
      || graph.graphRoot !== suppliedGraphRoot
      || graph.edgeCount !== String(graph.edges.length)
      || graph.instanceCatalogRoot !== binding.instanceCatalogRoot
      || catalog.instanceCatalogRoot !== binding.instanceCatalogRoot
      || !sameCutoff(graph.cutoff, binding.cutoff)
      || !sameCutoff(catalog.cutoff, binding.cutoff)
    ) throw new Error("graph-lease-root-mismatch");
    const publications = new Map(catalog.publications.map(value => [value.instancePublicationHash, value]));
    const runtimeEdges = graph.edges.map(edge => {
      const publication = publications.get(edge.instancePublicationHash);
      if (!publication) throw new Error("graph-publication-missing");
      if (
        edge.rehydrationRef.familyDefinitionHash !== publication.familyDefinitionHash
        || edge.rehydrationRef.instanceKey !== publication.instanceKey
        || edge.rehydrationRef.staticProjectionMemoHash !== publication.staticProjectionMemoHash
        || edge.rehydrationRef.requestedArtifactDependencyRoot !== publication.requestedArtifactDependencyRoot
      ) throw new Error("graph-rehydration-ref-mismatch");
      const projection = publication.transitions.find(value => value.projectionHash === edge.projectionHash);
      if (!projection) throw new Error("graph-projection-missing");
      const routeHandle = createGraphRouteHandle();
      this.#routeHandleAuthority.set(routeHandle, {
        edgeId: edge.edgeId,
        issuedRouteHandle: issuer.issueRouteHandle(publication, projection, edge.rehydrationRef),
      });
      return deepFreeze({ ...edge, routeHandle });
    });
    this.binding = deepFreeze({ ...binding, cutoff: deepFreeze({ ...binding.cutoff }) });
    this.leaseId = hashDomain("aloha/graph-view-lease/v1", {
      generationId: binding.generationId,
      readyRecordHash: binding.readyRecordHash,
      generationRefreshPolicyHash: binding.generationRefreshPolicyHash,
      cutoff: binding.cutoff,
      definitionCatalogRoot: binding.definitionCatalogRoot,
      instanceCatalogRoot: binding.instanceCatalogRoot,
      graphRoot: binding.graphRoot,
      releaseProvenanceHash: binding.releaseProvenanceHash,
      candidatePartitionProofStorageHash: binding.candidatePartitionProofStorageHash,
      nominationClosureRoot: binding.nominationClosureRoot,
      nominationClosureStorageHash: binding.nominationClosureStorageHash,
      processEpoch,
    });
    this.edges = deepFreeze(runtimeEdges);
    this.#canonicalGuard = canonicalGuard;
    this.#assertServingCurrent = assertServingCurrent;
    this.#onRelease = onRelease;
    this.#canonicalGuard.assertViewAuthorityActive(this.binding.cutoff);
  }

  static async open(
    admission: GraphServingAdmissionV1,
    graph: PersistedGraphV1,
    catalog: InstanceCatalogV1,
    issuer: RouteHandleIssuerPort,
    processEpoch: string,
    canonicalGuard: CanonicalLeaseGuardPort,
    servingAdmissionGuard: GraphServingAdmissionGuardPort,
    onRelease: () => void = () => {},
  ): Promise<GraphViewLeaseV1> {
    const binding = await servingAdmissionGuard.consumeServingAdmission(admission);
    await servingAdmissionGuard.assertServingBindingCurrent(binding);
    return new GraphViewLeaseV1(
      binding,
      graph,
      catalog,
      issuer,
      processEpoch,
      canonicalGuard,
      () => servingAdmissionGuard.assertServingBindingCurrent(binding),
      onRelease,
    );
  }

  get released(): boolean { return this.#released; }

  async assertActive(): Promise<void> {
    if (this.#released) throw new Error("graph-lease-released");
    this.#canonicalGuard.assertViewAuthorityActive(this.binding.cutoff);
    await this.#assertServingCurrent();
  }

  async resolveRouteHandle(edgeId: Hash, handle: GraphRouteHandle): Promise<IssuedRouteHandle> {
    await this.assertActive();
    const entry = typeof handle === "object" && handle !== null
      ? this.#routeHandleAuthority.get(handle)
      : undefined;
    if (!entry) throw new Error("graph-route-handle-not-owned");
    if (entry.edgeId !== assertHash(edgeId, "graphRouteHandle.edgeId")) {
      throw new Error("graph-route-handle-edge-mismatch");
    }
    return entry.issuedRouteHandle;
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#onRelease();
  }
}
