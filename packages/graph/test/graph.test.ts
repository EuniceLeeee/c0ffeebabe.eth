import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { sealInstanceCatalog, sealInstancePublication } from "../../catalog/src/index.ts";
import { buildPersistedGraph, GraphViewLeaseV1 } from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/graph", value);
const cutoff = { chainId: "1", number: "10", hash: h("block"), stateRoot: h("state") };
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

test("route handle is process-local and cannot alter persisted graph root", () => {
  const catalog = sealInstanceCatalog(cutoff, [publication]);
  const graph = buildPersistedGraph(catalog);
  const binding = {
    generationId: "generation-a",
    generationRefreshPolicyHash: h("policy"),
    cutoff,
    definitionCatalogRoot: h("definitions"),
    instanceCatalogRoot: catalog.instanceCatalogRoot,
    graphRoot: graph.graphRoot,
  };
  const first = new GraphViewLeaseV1(binding, graph, catalog, {
    issueRouteHandle: () => ({ opaque: { process: "a" } }),
  }, "epoch-a");
  const second = new GraphViewLeaseV1(binding, graph, catalog, {
    issueRouteHandle: () => ({ opaque: { process: "b" } }),
  }, "epoch-b");
  assert.notEqual(first.leaseId, second.leaseId);
  assert.equal(graph.graphRoot, buildPersistedGraph(catalog).graphRoot);
  assert.equal("issuedRouteHandle" in graph.edges[0]!, false);
  first.release();
  assert.throws(() => first.assertActive(), /released/);
});

test("a publication/root mismatch cannot open a GraphView", () => {
  const catalog = sealInstanceCatalog(cutoff, [publication]);
  const graph = buildPersistedGraph(catalog);
  assert.throws(() => new GraphViewLeaseV1({
    generationId: "generation-a",
    generationRefreshPolicyHash: h("policy"),
    cutoff,
    definitionCatalogRoot: h("definitions"),
    instanceCatalogRoot: h("wrong"),
    graphRoot: graph.graphRoot,
  }, graph, catalog, { issueRouteHandle: () => ({ opaque: {} }) }, "epoch"), /root-mismatch/);
});
