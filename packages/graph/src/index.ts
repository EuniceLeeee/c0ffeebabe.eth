import {
  assertDecimalString,
  assertHash,
  decodeCanonicalBytes,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalBytes,
  fieldArray,
  hashCanonicalPartition,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import type {
  AssetPortV1,
  InstanceCatalogV1,
  InstancePublicationV1,
  StaticTransitionProjectionV1,
} from "../../catalog/src/index.ts";
import { validateInstanceCatalog } from "../../catalog/src/index.ts";
import { decodeCanonicalCutoff, type CanonicalCutoffV1 } from "../../discovery/src/index.ts";
import type { CanonicalLeaseGuardPort } from "../../canonical-source/src/lease-guard-port.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
  type RuntimeAuthorityProjectionV1,
} from "../../runtime-authority/src/index.ts";

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

export interface PersistedGraphEdgeChunkRefV1 {
  readonly contentSha256: Hash;
}

export interface PersistedGraphEdgeChunkV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.persisted-graph-edge-chunk-v1";
  readonly edges: readonly PersistedGraphEdgeV1[];
  readonly nextEdgeChunkRef: PersistedGraphEdgeChunkRefV1 | null;
}

export interface PersistedGraphManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.persisted-graph-manifest-v1";
  readonly cutoff: CanonicalCutoffV1;
  readonly instanceCatalogRoot: Hash;
  readonly edgeCount: string;
  readonly edgeSequenceRoot: Hash;
  readonly edgeChunkCount: string;
  readonly firstEdgeChunkRef: PersistedGraphEdgeChunkRefV1 | null;
  readonly graphRoot: Hash;
}

export interface EncodedPersistedGraphV1 {
  readonly manifest: PersistedGraphManifestV1;
  readonly manifestBytes: Uint8Array;
  readonly chunks: readonly Readonly<{
    readonly ref: PersistedGraphEdgeChunkRefV1;
    readonly chunk: PersistedGraphEdgeChunkV1;
    readonly bytes: Uint8Array;
  }>[];
}

const GRAPH_SEQUENCE_FANOUT = 128;
const GRAPH_CHUNK_MAX_ITEMS = 128;
const GRAPH_CHUNK_MAX_BYTES = 500_000;
const ownerBuiltGraphCatalogRoots = new WeakMap<object, Hash>();

function edgeSequenceRoot(edges: readonly PersistedGraphEdgeV1[]): Hash {
  return hashCanonicalPartition(
    "aloha/persisted-graph-edge-sequence/v1",
    edges.map(value => value.edgeId),
    GRAPH_SEQUENCE_FANOUT,
  );
}

function graphSemanticRoot(
  cutoff: CanonicalCutoffV1,
  instanceCatalogRoot: Hash,
  edgeCount: string,
  sequenceRoot: Hash,
): Hash {
  return hashDomain("aloha/persisted-graph/v2", {
    cutoff,
    instanceCatalogRoot,
    edgeCount,
    edgeSequenceRoot: sequenceRoot,
  });
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
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
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
  const edgeCount = String(edges.length);
  const graphRoot = graphSemanticRoot(
    instanceCatalog.cutoff,
    instanceCatalog.instanceCatalogRoot,
    edgeCount,
    edgeSequenceRoot(edges),
  );
  const graph = deepFreeze({
    cutoff: instanceCatalog.cutoff,
    instanceCatalogRoot: instanceCatalog.instanceCatalogRoot,
    edges,
    edgeCount,
    graphRoot,
  });
  ownerBuiltGraphCatalogRoots.set(graph, instanceCatalog.instanceCatalogRoot);
  return graph;
}

function exactGraphChunkRef(value: unknown, path: string): PersistedGraphEdgeChunkRefV1 {
  return decodeExactObject(value, {
    contentSha256: (field, fieldPath) => assertHash(field, fieldPath),
  }, path);
}

function buildGraphChunk(
  edges: readonly PersistedGraphEdgeV1[],
  nextEdgeChunkRef: PersistedGraphEdgeChunkRefV1 | null,
): EncodedPersistedGraphV1["chunks"][number] {
  const chunk = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.persisted-graph-edge-chunk-v1" as const,
    edges: deepFreeze([...edges]),
    nextEdgeChunkRef,
  });
  const bytes = encodeCanonicalBytes(chunk);
  if (bytes.byteLength > GRAPH_CHUNK_MAX_BYTES) {
    throw new TypeError("persisted graph edge chunk exceeds durable byte cap");
  }
  return Object.freeze({
    chunk,
    bytes: bytes.slice(),
    ref: deepFreeze({
      contentSha256: sha256Hex(bytes),
    }),
  });
}

function encodeGraphChunks(graph: PersistedGraphV1): EncodedPersistedGraphV1["chunks"] {
  const groups: Array<readonly PersistedGraphEdgeV1[]> = Array.from(
    { length: Math.ceil(graph.edges.length / GRAPH_CHUNK_MAX_ITEMS) },
    (_, index) => graph.edges.slice(
      index * GRAPH_CHUNK_MAX_ITEMS,
      (index + 1) * GRAPH_CHUNK_MAX_ITEMS,
    ),
  );
  for (;;) {
    const output: Array<EncodedPersistedGraphV1["chunks"][number]> = new Array(groups.length);
    let next: PersistedGraphEdgeChunkRefV1 | null = null;
    let failed = -1;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index]!;
      try {
        const encoded = buildGraphChunk(group, next);
        output[index] = encoded;
        next = encoded.ref;
      } catch {
        failed = index;
        break;
      }
    }
    if (failed === -1) return Object.freeze(output.slice());
    const group = groups[failed]!;
    if (group.length <= 1) {
      buildGraphChunk(group, null);
      throw new TypeError("unreachable persisted graph chunk encoding failure");
    }
    const middle = Math.ceil(group.length / 2);
    groups.splice(failed, 1, group.slice(0, middle), group.slice(middle));
  }
}

function validatePersistedGraphShape(graph: PersistedGraphV1): void {
  if (ownerBuiltGraphCatalogRoots.get(graph) === graph.instanceCatalogRoot) return;
  if (graph.edgeCount !== String(graph.edges.length)
    || new Set(graph.edges.map(edge => edge.edgeId)).size !== graph.edges.length
    || graph.edges.some((edge, index) => index > 0 && graph.edges[index - 1]!.edgeId >= edge.edgeId)
    || graph.edges.some(edge => {
      const { edgeId, ...payload } = edge;
      return edgeId !== hashDomain("aloha/persisted-graph-edge/v1", payload);
    })
    || graph.graphRoot !== graphSemanticRoot(
      graph.cutoff,
      graph.instanceCatalogRoot,
      graph.edgeCount,
      edgeSequenceRoot(graph.edges),
    )) {
    throw new TypeError("persisted-graph-root-mismatch");
  }
}

export function validatePersistedGraphForCatalog(
  graph: PersistedGraphV1,
  catalog: InstanceCatalogV1,
): void {
  validateInstanceCatalog(catalog);
  if (ownerBuiltGraphCatalogRoots.get(graph) === catalog.instanceCatalogRoot) return;
  validatePersistedGraphShape(graph);
  const rebuilt = buildPersistedGraph(catalog);
  if (rebuilt.graphRoot !== graph.graphRoot
    || rebuilt.edgeCount !== graph.edgeCount
    || rebuilt.instanceCatalogRoot !== graph.instanceCatalogRoot
    || !sameCutoff(rebuilt.cutoff, graph.cutoff)) {
    throw new TypeError("persisted-graph-catalog-mismatch");
  }
}

export function encodePersistedGraphV1(graph: PersistedGraphV1): EncodedPersistedGraphV1 {
  validatePersistedGraphShape(graph);
  const chunks = encodeGraphChunks(graph);
  const manifest = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.persisted-graph-manifest-v1" as const,
    cutoff: graph.cutoff,
    instanceCatalogRoot: graph.instanceCatalogRoot,
    edgeCount: graph.edgeCount,
    edgeSequenceRoot: edgeSequenceRoot(graph.edges),
    edgeChunkCount: String(chunks.length),
    firstEdgeChunkRef: chunks[0]?.ref ?? null,
    graphRoot: graph.graphRoot,
  });
  const manifestBytes = encodeCanonicalBytes(manifest);
  if (manifestBytes.byteLength > GRAPH_CHUNK_MAX_BYTES) {
    throw new TypeError("persisted graph manifest exceeds durable byte cap");
  }
  return Object.freeze({ manifest, manifestBytes: manifestBytes.slice(), chunks });
}

export function decodePersistedGraphV1(
  manifestBytes: Uint8Array,
  readChunk: (ref: PersistedGraphEdgeChunkRefV1) => Uint8Array,
  catalog: InstanceCatalogV1,
): PersistedGraphV1 {
  if (manifestBytes.byteLength > GRAPH_CHUNK_MAX_BYTES) {
    throw new TypeError("persisted graph manifest exceeds durable byte cap");
  }
  const manifest = decodeExactObject(decodeCanonicalBytes(manifestBytes), {
    schemaVersion: field => {
      if (field !== 1) throw new TypeError("persisted graph manifest schema version mismatch");
      return 1 as const;
    },
    kind: field => {
      if (field !== "aloha.persisted-graph-manifest-v1") throw new TypeError("persisted graph manifest kind mismatch");
      return "aloha.persisted-graph-manifest-v1" as const;
    },
    cutoff: (field, path) => decodeCanonicalCutoff(field, path),
    instanceCatalogRoot: (field, path) => assertHash(field, path),
    edgeCount: (field, path) => assertDecimalString(field, path),
    edgeSequenceRoot: (field, path) => assertHash(field, path),
    edgeChunkCount: (field, path) => assertDecimalString(field, path),
    firstEdgeChunkRef: (field, path) => field === null ? null : exactGraphChunkRef(field, path),
    graphRoot: (field, path) => assertHash(field, path),
  }, "persistedGraphManifest");
  const expected = buildPersistedGraph(catalog);
  if (manifest.graphRoot !== expected.graphRoot
    || manifest.instanceCatalogRoot !== expected.instanceCatalogRoot
    || manifest.edgeCount !== expected.edgeCount
    || manifest.edgeSequenceRoot !== edgeSequenceRoot(expected.edges)
    || !sameCutoff(manifest.cutoff, expected.cutoff)) {
    throw new TypeError("persisted graph manifest semantic root mismatch");
  }
  const refs: PersistedGraphEdgeChunkRefV1[] = [];
  let edgeOrdinal = 0;
  let ref = manifest.firstEdgeChunkRef;
  while (ref !== null) {
    if (BigInt(refs.length) >= BigInt(manifest.edgeChunkCount)) {
      throw new TypeError("persisted graph edge chunk range mismatch");
    }
    const bytes = readChunk(ref);
    if (bytes.byteLength > GRAPH_CHUNK_MAX_BYTES || sha256Hex(bytes) !== ref.contentSha256) {
      throw new TypeError("persisted graph edge chunk content mismatch");
    }
    const chunk = decodeExactObject(decodeCanonicalBytes(bytes), {
      schemaVersion: field => {
        if (field !== 1) throw new TypeError("persisted graph chunk schema version mismatch");
        return 1 as const;
      },
      kind: field => {
        if (field !== "aloha.persisted-graph-edge-chunk-v1") throw new TypeError("persisted graph chunk kind mismatch");
        return "aloha.persisted-graph-edge-chunk-v1" as const;
      },
      edges: (field, path) => fieldArray(field, item => item, path),
      nextEdgeChunkRef: (field, path) => field === null ? null : exactGraphChunkRef(field, path),
    }, `persistedGraphChunk[${refs.length}]`);
    const expectedEdges = expected.edges.slice(edgeOrdinal, edgeOrdinal + chunk.edges.length);
    if (chunk.edges.length === 0
      || chunk.edges.length > GRAPH_CHUNK_MAX_ITEMS
      || sha256Hex(encodeCanonicalBytes(chunk.edges)) !== sha256Hex(encodeCanonicalBytes(expectedEdges))) {
      throw new TypeError("persisted graph edge chunk binding mismatch");
    }
    refs.push(ref);
    edgeOrdinal += chunk.edges.length;
    ref = chunk.nextEdgeChunkRef;
  }
  if (manifest.edgeChunkCount !== String(refs.length)
    || manifest.edgeCount !== String(edgeOrdinal)
    || (manifest.edgeCount === "0") !== (manifest.firstEdgeChunkRef === null)) {
    throw new TypeError("persisted graph edge chunk denominator incomplete");
  }
  return expected;
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
    const runtimeAuthority = decodeRuntimeAuthorityProjectionV1(binding.runtimeAuthority);
    const releaseFactsPresent = binding.releaseProvenanceHash !== null
      && binding.candidatePartitionProofStorageHash !== null
      && binding.nominationClosureStorageHash !== null;
    if (runtimeAuthority.authorityClass !== "signed-release" || !releaseFactsPresent) {
      throw new Error("graph-lease-authority-facts-mismatch");
    }
    const activeReadyBinding = deepFreeze({
      generationId: binding.generationId,
      readyRecordHash: binding.readyRecordHash,
      generationRefreshPolicyHash: binding.generationRefreshPolicyHash,
      cutoff: deepFreeze({ ...binding.cutoff }),
      definitionCatalogRoot: binding.definitionCatalogRoot,
      instanceCatalogRoot: binding.instanceCatalogRoot,
      graphRoot: binding.graphRoot,
      runtimeAuthority,
      releaseProvenanceHash: binding.releaseProvenanceHash,
      candidatePartitionProofStorageHash: binding.candidatePartitionProofStorageHash,
      nominationClosureRoot: binding.nominationClosureRoot,
      nominationClosureStorageHash: binding.nominationClosureStorageHash,
    });
    validatePersistedGraphForCatalog(graph, catalog);
    const recomputedGraph = graph;
    let suppliedGraphRoot: Hash;
    try {
      validatePersistedGraphShape(graph);
      suppliedGraphRoot = graph.graphRoot;
    } catch {
      suppliedGraphRoot = hashDomain("aloha/invalid-persisted-graph/v1", {});
    }
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
    this.binding = deepFreeze({
      ...binding,
      cutoff: deepFreeze({ ...binding.cutoff }),
      runtimeAuthority,
    });
    this.leaseId = hashDomain("aloha/graph-view-lease/v1", {
      generationId: binding.generationId,
      readyRecordHash: binding.readyRecordHash,
      generationRefreshPolicyHash: binding.generationRefreshPolicyHash,
      cutoff: binding.cutoff,
      definitionCatalogRoot: binding.definitionCatalogRoot,
      instanceCatalogRoot: binding.instanceCatalogRoot,
      graphRoot: binding.graphRoot,
      runtimeAuthority,
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
