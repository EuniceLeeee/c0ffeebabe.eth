import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { sealInstanceCatalog, sealInstancePublication } from "../../catalog/src/index.ts";
import { buildPersistedGraph, GraphViewLeaseV1, type GraphRouteHandle } from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/graph", value);
const cutoff = { chainId: "1", number: "10", hash: h("block"), stateRoot: h("state") };
const releaseProvenanceHash = h("release-provenance");
const candidatePartitionProofStorageHash = h("candidate-proof-storage");
const publication = sealInstancePublication({
  familyId: "family-a",
  familyDefinitionHash: h("definition"),
  familyCandidateKey: h("candidate"),
  instanceKey: "instance-a",
  cutoff,
  identityMemoHash: h("identity"),
  descriptorHash: h("descriptor"),
  staticProjectionMemoHash: h("memo"),
  requestedArtifactDependencyRoot: h("dependencies"),
  validityDependencyRoot: h("validity"),
  transitions: [{
    inputAssetPorts: [{ assetRef: h("in"), portRef: h("in-port"), ordinal: "0" }],
    outputAssetPorts: [{ assetRef: h("out"), portRef: h("out-port"), ordinal: "0" }],
    opaqueTransitionRef: h("transition"),
    constraintRefs: [],
    staticProjectionHash: h("projection"),
  }],
  evidenceRoot: h("evidence"),
});

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
