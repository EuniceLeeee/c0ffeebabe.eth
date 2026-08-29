import assert from "node:assert/strict";
import test from "node:test";
import { decodeCanonicalBytes, encodeCanonicalBytes, hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { erc20AssetPortBindingV1, type AssetPortBindingV1 } from "../../asset-ref/src/index.ts";
import { sealInstanceCatalog, sealInstancePublication } from "../../catalog/src/index.ts";
import {
  buildPersistedGraph,
  decodePersistedGraphV1,
  encodePersistedGraphV1,
  GraphViewLeaseV1,
  type GraphRouteHandle,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/graph", value);
const cutoff = { chainId: "1", number: "10", hash: h("block"), stateRoot: h("state") };
const releaseProvenanceHash = h("release-provenance");
const candidatePartitionProofStorageHash = h("candidate-proof-storage");
const nominationClosureRoot = h("nomination-closure");
const nominationClosureStorageHash = h("nomination-closure-storage");
const inputAsset = erc20AssetPortBindingV1("1", "0x1111111111111111111111111111111111111111");
const outputAsset = erc20AssetPortBindingV1("1", "0x2222222222222222222222222222222222222222");

function makePublication(
  familyId: string,
  instanceKey: string,
  input: AssetPortBindingV1,
  output: AssetPortBindingV1,
  evidenceRoot = h(`${familyId}:evidence`),
  transitionCount = 1,
) {
  const identityMemo = { kind: "graph-test-identity", familyId, instanceKey };
  return sealInstancePublication({
    familyId,
    familyDefinitionHash: h(`${familyId}:definition`),
    familyCandidateKey: h(`${familyId}:candidate`),
    instanceKey,
    cutoff,
    identityMemo,
    identityMemoHash: hashDomain("aloha/identity-memo/v1", identityMemo),
    descriptorHash: h(`${familyId}:descriptor`),
    staticProjectionMemoHash: h(`${familyId}:memo`),
    requestedArtifactDependencyRoot: h(`${familyId}:dependencies`),
    validityDependencyRoot: h(`${familyId}:validity`),
    transitions: Array.from({ length: transitionCount }, (_, transitionIndex) => ({
      inputAssetPorts: [{ ...input, portRef: h(`${familyId}:in-port`), ordinal: "0" }],
      outputAssetPorts: [{ ...output, portRef: h(`${familyId}:out-port`), ordinal: "0" }],
      opaqueTransitionRef: h(`${familyId}:transition:${transitionIndex}`),
      constraintRefs: [],
      staticProjectionHash: h(`${familyId}:projection:${transitionIndex}`),
    })),
    evidenceRoot,
  });
}

const publication = makePublication("family-a", "instance-a", inputAsset, outputAsset);

test("Graph is deterministically projected only from verified publications", () => {
  const catalog = sealInstanceCatalog(cutoff, [publication]);
  const graph = buildPersistedGraph(catalog);
  assert.equal(graph.edgeCount, "1");
  assert.equal(graph.graphRoot, buildPersistedGraph(catalog).graphRoot);
  assert.deepEqual(Object.keys(graph.edges[0]!).sort(), [
    "constraintRefs", "edgeId", "inputAssetPorts", "instancePublicationHash",
    "opaqueTransitionRef", "outputAssetPorts", "owningFamilyDefinitionHash", "projectionHash",
    "owningFamilyId", "owningInstanceKey", "rehydrationRef", "staticProjectionHash",
  ].sort());
});

test("cross-Family joins share AssetRef while Family ports and existing edge identities stay isolated", () => {
  const familyB = makePublication("family-b", "instance-b", outputAsset, inputAsset);
  const unrelatedInput = erc20AssetPortBindingV1("1", "0x3333333333333333333333333333333333333333");
  const unrelatedOutput = erc20AssetPortBindingV1("1", "0x4444444444444444444444444444444444444444");
  const unrelated = makePublication("family-c", "instance-c", unrelatedInput, unrelatedOutput);
  const base = buildPersistedGraph(sealInstanceCatalog(cutoff, [publication, familyB]));
  const expanded = buildPersistedGraph(sealInstanceCatalog(cutoff, [publication, familyB, unrelated]));
  const familyAEdge = base.edges.find(edge => edge.owningFamilyId === "family-a")!;
  const familyBEdge = base.edges.find(edge => edge.owningFamilyId === "family-b")!;
  assert.equal(familyAEdge.outputAssetPorts[0]!.assetRef, familyBEdge.inputAssetPorts[0]!.assetRef);
  assert.notEqual(familyAEdge.outputAssetPorts[0]!.portRef, familyBEdge.inputAssetPorts[0]!.portRef);
  for (const edge of base.edges) {
    const sameEdge = expanded.edges.find(candidate => candidate.owningFamilyId === edge.owningFamilyId)!;
    assert.equal(sameEdge.edgeId, edge.edgeId);
    assert.equal(sameEdge.projectionHash, edge.projectionHash);
    assert.deepEqual(sameEdge.inputAssetPorts, edge.inputAssetPorts);
    assert.deepEqual(sameEdge.outputAssetPorts, edge.outputAssetPorts);
  }
  assert.notEqual(expanded.graphRoot, base.graphRoot);
});

test("route handle authority is lease-owned and cannot alter persisted graph root", async () => {
  const catalog = sealInstanceCatalog(cutoff, [publication]);
  const graph = buildPersistedGraph(catalog);
  const binding = {
    generationId: "generation-a",
    readyRecordHash: h("ready"),
    generationRefreshPolicyHash: h("policy"),
    cutoff,
    definitionCatalogRoot: h("definitions"),
    instanceCatalogRoot: catalog.instanceCatalogRoot,
    graphRoot: graph.graphRoot,
    releaseProvenanceHash,
    candidatePartitionProofStorageHash,
    nominationClosureRoot,
    nominationClosureStorageHash,
  };
  let canonical = true;
  let readyActive = true;
  const observedReadyBindings: object[] = [];
  const canonicalGuard = {
    assertViewAuthorityActive() {
      if (!canonical) throw new Error("canonical-view-revoked");
    },
  };
  const admission = { opaque: {} };
  const firstIssued = { opaque: { process: "a" } };
  const secondIssued = { opaque: { process: "b" } };
  const servingAdmissionGuard = {
    async assertServingBindingCurrent(value: typeof binding) {
      observedReadyBindings.push(value);
      if (!readyActive) throw new Error("ready-authority-superseded");
    },
    async consumeServingAdmission(value: typeof admission) {
      if (value !== admission) throw new Error("graph-serving-admission-not-issued");
      return binding;
    },
  };
  const first = await GraphViewLeaseV1.open(admission, graph, catalog, {
    issueRouteHandle: () => firstIssued,
  }, "epoch-a", canonicalGuard, servingAdmissionGuard);
  const second = await GraphViewLeaseV1.open(admission, graph, catalog, {
    issueRouteHandle: () => secondIssued,
  }, "epoch-b", canonicalGuard, servingAdmissionGuard);
  assert.notEqual(first.leaseId, second.leaseId);
  assert.deepEqual(Object.keys(observedReadyBindings[0]!).sort(), [
    "generationId",
    "readyRecordHash",
    "generationRefreshPolicyHash",
    "cutoff",
    "definitionCatalogRoot",
    "instanceCatalogRoot",
    "graphRoot",
    "releaseProvenanceHash",
    "candidatePartitionProofStorageHash",
    "nominationClosureRoot",
    "nominationClosureStorageHash",
  ].sort());
  assert.equal(graph.graphRoot, buildPersistedGraph(catalog).graphRoot);
  assert.equal("issuedRouteHandle" in graph.edges[0]!, false);
  assert.equal("issuedRouteHandle" in first.edges[0]!, false);
  const firstRouteHandle = first.edges[0]!.routeHandle;
  const secondRouteHandle = second.edges[0]!.routeHandle;
  const edgeId = first.edges[0]!.edgeId;
  assert.notEqual(firstRouteHandle, firstIssued);
  assert.equal(Object.isFrozen(firstRouteHandle), true);
  assert.equal(await first.resolveRouteHandle(edgeId, firstRouteHandle), firstIssued);
  assert.equal(await second.resolveRouteHandle(edgeId, secondRouteHandle), secondIssued);
  await assert.rejects(
    () => first.resolveRouteHandle(h("another-edge"), firstRouteHandle),
    /graph-route-handle-edge-mismatch/,
  );
  await assert.rejects(
    () => first.resolveRouteHandle(edgeId, {} as GraphRouteHandle),
    /graph-route-handle-not-owned/,
  );
  await assert.rejects(
    () => second.resolveRouteHandle(edgeId, firstRouteHandle),
    /graph-route-handle-not-owned/,
  );
  canonical = false;
  await assert.rejects(() => first.assertActive(), /canonical-view-revoked/);
  await assert.rejects(() => first.resolveRouteHandle(edgeId, firstRouteHandle), /canonical-view-revoked/);
  canonical = true;
  readyActive = false;
  await assert.rejects(() => second.assertActive(), /ready-authority-superseded/);
  await assert.rejects(() => second.resolveRouteHandle(edgeId, secondRouteHandle), /ready-authority-superseded/);
  readyActive = true;
  first.release();
  await assert.rejects(() => first.assertActive(), /released/);
  await assert.rejects(() => first.resolveRouteHandle(edgeId, firstRouteHandle), /released/);
});

test("a publication/root mismatch cannot open a GraphView", async () => {
  const catalog = sealInstanceCatalog(cutoff, [publication]);
  const graph = buildPersistedGraph(catalog);
  const wrongBinding = {
    generationId: "generation-a",
    readyRecordHash: h("ready"),
    generationRefreshPolicyHash: h("policy"),
    cutoff,
    definitionCatalogRoot: h("definitions"),
    instanceCatalogRoot: h("wrong"),
    graphRoot: graph.graphRoot,
    releaseProvenanceHash,
    candidatePartitionProofStorageHash,
    nominationClosureRoot,
    nominationClosureStorageHash,
  };
  const admission = { opaque: {} };
  await assert.rejects(() => GraphViewLeaseV1.open(
    admission,
    graph,
    catalog,
    { issueRouteHandle: () => ({ opaque: {} }) },
    "epoch",
    { assertViewAuthorityActive() {} },
    { async assertServingBindingCurrent() {}, async consumeServingAdmission() { return wrongBinding; } },
  ), /root-mismatch/);
});

test("evidence-root mutation changes publication/Graph identity before any route handle is issued", async () => {
  const catalog = sealInstanceCatalog(cutoff, [publication]);
  const graph = buildPersistedGraph(catalog);
  const mutatedPublication = makePublication(
    "family-a",
    "instance-a",
    inputAsset,
    outputAsset,
    h("family-a:mutated-evidence"),
  );
  const mutatedCatalog = sealInstanceCatalog(cutoff, [mutatedPublication]);
  const mutatedGraph = buildPersistedGraph(mutatedCatalog);
  assert.notEqual(mutatedPublication.instancePublicationHash, publication.instancePublicationHash);
  assert.notEqual(mutatedCatalog.instanceCatalogRoot, catalog.instanceCatalogRoot);
  assert.notEqual(mutatedGraph.graphRoot, graph.graphRoot);

  const binding = {
    generationId: "generation-a",
    readyRecordHash: h("ready"),
    generationRefreshPolicyHash: h("policy"),
    cutoff,
    definitionCatalogRoot: h("definitions"),
    instanceCatalogRoot: catalog.instanceCatalogRoot,
    graphRoot: graph.graphRoot,
    releaseProvenanceHash,
    candidatePartitionProofStorageHash,
    nominationClosureRoot,
    nominationClosureStorageHash,
  };
  const admission = { opaque: {} };
  let issued = 0;
  await assert.rejects(() => GraphViewLeaseV1.open(
    admission,
    mutatedGraph,
    mutatedCatalog,
    { issueRouteHandle() { issued += 1; return { opaque: {} }; } },
    "epoch",
    { assertViewAuthorityActive() {} },
    { async assertServingBindingCurrent() {}, async consumeServingAdmission() { return binding; } },
  ), /root-mismatch/);
  assert.equal(issued, 0);
});

test("a revoked cutoff cannot construct or continue a GraphView lease", async () => {
  const catalog = sealInstanceCatalog(cutoff, [publication]);
  const graph = buildPersistedGraph(catalog);
  const binding = {
    generationId: "generation-a",
    readyRecordHash: h("ready"),
    generationRefreshPolicyHash: h("policy"),
    cutoff,
    definitionCatalogRoot: h("definitions"),
    instanceCatalogRoot: catalog.instanceCatalogRoot,
    graphRoot: graph.graphRoot,
    releaseProvenanceHash,
    candidatePartitionProofStorageHash,
    nominationClosureRoot,
    nominationClosureStorageHash,
  };
  const admission = { opaque: {} };
  await assert.rejects(() => GraphViewLeaseV1.open(
    admission,
    graph,
    catalog,
    { issueRouteHandle: () => ({ opaque: {} }) },
    "epoch",
    { assertViewAuthorityActive() { throw new Error("canonical-view-revoked"); } },
    { async assertServingBindingCurrent() {}, async consumeServingAdmission() { return binding; } },
  ), /canonical-view-revoked/);
});

test("30k graph uses bounded linked chunks and reopens every edge without sampling", (t) => {
  const timings: Record<string, number> = {};
  let mark = Date.now();
  const publications = Array.from({ length: 300 }, (_, index) => makePublication(
    `dense-family-${String(index).padStart(3, "0")}`,
    `dense-instance-${index}`,
    inputAsset,
    outputAsset,
    h(`dense-evidence-${index}`),
    100,
  ));
  const catalog = sealInstanceCatalog(cutoff, publications);
  timings.catalog = Date.now() - mark;
  mark = Date.now();
  const graph = buildPersistedGraph(catalog);
  timings.build = Date.now() - mark;
  mark = Date.now();
  const encoded = encodePersistedGraphV1(graph);
  timings.encode = Date.now() - mark;
  assert.equal(graph.edgeCount, "30000");
  assert.ok(encoded.chunks.length > 1);
  assert.ok(encoded.manifestBytes.byteLength <= 500_000);
  assert.ok(encoded.chunks.every(chunk => chunk.bytes.byteLength <= 500_000));
  assert.deepEqual(Object.keys(encoded.manifest).sort(), [
    "cutoff",
    "edgeChunkCount",
    "edgeCount",
    "edgeSequenceRoot",
    "firstEdgeChunkRef",
    "graphRoot",
    "instanceCatalogRoot",
    "kind",
    "schemaVersion",
  ]);
  assert.deepEqual(Object.keys(encoded.chunks[0]!.ref), ["contentSha256"]);
  assert.deepEqual(Object.keys(encoded.chunks[0]!.chunk).sort(), [
    "edges",
    "kind",
    "nextEdgeChunkRef",
    "schemaVersion",
  ]);
  const bySha = new Map(encoded.chunks.map(chunk => [chunk.ref.contentSha256, chunk.bytes]));
  mark = Date.now();
  const reopened = decodePersistedGraphV1(encoded.manifestBytes, ref => {
    const bytes = bySha.get(ref.contentSha256);
    if (!bytes) throw new Error("missing test chunk");
    return bytes;
  }, catalog);
  timings.decode = Date.now() - mark;
  assert.equal(reopened.edges.length, 30_000);
  assert.equal(reopened.graphRoot, graph.graphRoot);
  for (const ordinal of [0, 14_999, 29_999]) {
    assert.equal(reopened.edges[ordinal]!.edgeId, graph.edges[ordinal]!.edgeId);
  }
  assert.throws(() => encodePersistedGraphV1({ ...graph, edges: [...graph.edges].reverse() }), /root-mismatch/);
  t.diagnostic(`30k graph timings ms ${JSON.stringify(timings)}`);
});

test("graph linked chunks fail closed on missing, duplicate, cross-graph, mutation, or manifest reroot", () => {
  const firstCatalog = sealInstanceCatalog(cutoff, Array.from({ length: 3 }, (_, index) => (
    makePublication(`chunk-family-a-${index}`, `chunk-instance-a-${index}`, inputAsset, outputAsset, undefined, 100)
  )));
  const secondCatalog = sealInstanceCatalog(cutoff, Array.from({ length: 3 }, (_, index) => (
    makePublication(`chunk-family-b-${index}`, `chunk-instance-b-${index}`, inputAsset, outputAsset, undefined, 100)
  )));
  const graph = buildPersistedGraph(firstCatalog);
  const encoded = encodePersistedGraphV1(graph);
  const foreign = encodePersistedGraphV1(buildPersistedGraph(secondCatalog));
  const bySha = new Map(encoded.chunks.map(chunk => [chunk.ref.contentSha256, chunk.bytes]));
  assert.throws(() => decodePersistedGraphV1(encoded.manifestBytes, () => {
    throw new Error("missing");
  }, firstCatalog), /missing/);
  const firstBytes = encoded.chunks[0]!.bytes;
  const firstChunkSha = encoded.chunks[0]!.ref.contentSha256;
  assert.throws(() => decodePersistedGraphV1(encoded.manifestBytes, () => firstBytes, firstCatalog), /content mismatch/);
  assert.throws(() => decodePersistedGraphV1(encoded.manifestBytes, ref => (
    ref.contentSha256 === firstChunkSha ? foreign.chunks[0]!.bytes : bySha.get(ref.contentSha256)!
  ), firstCatalog), /content mismatch/);
  const mutated = encoded.chunks[0]!.bytes.slice();
  mutated[mutated.length - 2] = mutated[mutated.length - 2]! ^ 1;
  assert.throws(() => decodePersistedGraphV1(encoded.manifestBytes, ref => (
    ref.contentSha256 === firstChunkSha ? mutated : bySha.get(ref.contentSha256)!
  ), firstCatalog), /content mismatch/);
  const manifest = decodeCanonicalBytes(encoded.manifestBytes) as Record<string, unknown>;
  const rerooted = encodeCanonicalBytes({ ...manifest, graphRoot: h("rerooted-graph") });
  assert.throws(() => decodePersistedGraphV1(rerooted, ref => bySha.get(ref.contentSha256)!, firstCatalog), /manifest .* mismatch/);
});
