import assert from "node:assert/strict";
import { StrictReadyGraphViewCoordinator } from
  "../strict-ready-graph-view.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { canonicalEdgeId } from
  "../venues/blockscan-state-capability.js";
import type { ReadyUniverseGeneration } from
  "../universe-rebuild-checkpoint.js";

const HASH = `0x${"ab".repeat(32)}`;
const EDGE_BASE = Object.freeze({
  adapterId: "strict-action",
  target: `0x${"11".repeat(20)}`,
  tokenIn: `0x${"22".repeat(20)}`,
  tokenOut: `0x${"33".repeat(20)}`,
  slotKind: "swap" as const,
  edgeKind: "swap" as const,
  leavesStandingPosition: false,
  score: 0,
}) as TokenEdge;
const EDGE = Object.freeze({
  ...EDGE_BASE,
  canonicalEdgeId: canonicalEdgeId("strict-family", EDGE_BASE),
}) as TokenEdge;
const READY = Object.freeze({
  generation: 7,
  graphHash: "ready-graph-hash",
  catalogHash: "ready-catalog-hash",
  sourceCoverage: Object.freeze([Object.freeze({
    familyId: "strict-family",
    sourceId: "startup-universe",
    completeThroughBlock: 100,
    completeThroughHash: HASH,
  })]),
}) as ReadyUniverseGeneration;
const CATALOG = Object.freeze({
  ownerOfAction(actionId: string) {
    if (actionId !== EDGE.adapterId) throw new Error("unknown action");
    return "strict-family";
  },
}) as never;

const coordinator = new StrictReadyGraphViewCoordinator({
  catalog: CATALOG,
  ready: READY,
  edges: Object.freeze([EDGE]),
});
const topologyKey = `strict-ready:${READY.generation}:${READY.graphHash}`;
const first = coordinator.build({
  id: "strict-ready-current-101",
  topologyKey,
  generation: 8,
  sourceBlock: 101,
  sourceBlockHash: HASH,
  edges: Object.freeze([EDGE]),
});
assert.equal(first.edges.length, 1);
assert.equal(first.edges[0]?.canonicalEdgeId, EDGE.canonicalEdgeId);
assert.equal(first.completenessWatermark, 101);
assert.equal(first.perSourceCoverage[0]?.completeThroughBlock, 101);
assert.equal(first.perSourceCoverage[0]?.completeThroughHash, HASH);

const second = coordinator.build({
  id: "strict-ready-current-102",
  topologyKey,
  generation: 9,
  sourceBlock: 102,
  sourceBlockHash: HASH,
  edges: Object.freeze([EDGE]),
});
assert.equal(second.edges, first.edges, "ready topology should be cached");
assert.equal(second.orderedEdgeHash, first.orderedEdgeHash);
assert.equal(second.sourceBlock, 102);
assert.throws(() => coordinator.build({
  id: "wrong-key",
  topologyKey: "legacy-topology",
  generation: 10,
  sourceBlock: 103,
  sourceBlockHash: HASH,
  edges: Object.freeze([EDGE]),
}), /topology key mismatch/);
assert.throws(() => coordinator.build({
  id: "cloned-edge",
  topologyKey,
  generation: 10,
  sourceBlock: 103,
  sourceBlockHash: HASH,
  edges: Object.freeze([{ ...EDGE }]),
}), /differs from ready edge objects/);

console.log("strict ready GraphView contract: PASS");
