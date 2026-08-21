import { deepFreeze, hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import type {
  AssetPortV1,
  InstanceCatalogV1,
  InstancePublicationV1,
  StaticTransitionProjectionV1,
} from "../../catalog/src/index.ts";
import { validateInstanceCatalog } from "../../catalog/src/index.ts";
import type { CanonicalCutoffV1 } from "../../discovery/src/index.ts";

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

export interface RuntimeGraphEdgeV1 extends PersistedGraphEdgeV1 {
  readonly issuedRouteHandle: IssuedRouteHandle;
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
  readonly generationRefreshPolicyHash: Hash;
  readonly cutoff: CanonicalCutoffV1;
  readonly definitionCatalogRoot: Hash;
  readonly instanceCatalogRoot: Hash;
  readonly graphRoot: Hash;
}

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

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

  constructor(
    binding: GraphLeaseBindingV1,
    graph: PersistedGraphV1,
    catalog: InstanceCatalogV1,
    issuer: RouteHandleIssuerPort,
    processEpoch: string,
    onRelease: () => void = () => {},
  ) {
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
      return deepFreeze({ ...edge, issuedRouteHandle: issuer.issueRouteHandle(publication, projection, edge.rehydrationRef) });
    });
    this.binding = deepFreeze({ ...binding, cutoff: deepFreeze({ ...binding.cutoff }) });
    this.leaseId = hashDomain("aloha/graph-view-lease/v1", {
      generationId: binding.generationId,
      generationRefreshPolicyHash: binding.generationRefreshPolicyHash,
      cutoff: binding.cutoff,
      definitionCatalogRoot: binding.definitionCatalogRoot,
      instanceCatalogRoot: binding.instanceCatalogRoot,
      graphRoot: binding.graphRoot,
      processEpoch,
    });
    this.edges = deepFreeze(runtimeEdges);
    this.#onRelease = onRelease;
  }

  get released(): boolean { return this.#released; }

  assertActive(): void {
    if (this.#released) throw new Error("graph-lease-released");
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#onRelease();
  }
}
