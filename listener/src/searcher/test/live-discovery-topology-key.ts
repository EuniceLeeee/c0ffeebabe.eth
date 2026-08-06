import test from "node:test";
import assert from "node:assert/strict";
import type { TokenEdge } from "../planner/token-graph.js";
import {
  computeDiscoveryGraphTopologyKey,
  type LiveDiscoveryPublicationState,
} from "../live-discovery-publication.js";

function swapEdge(
  target: string,
  tokenIn: string,
  tokenOut: string,
  feeBps = 30n,
): TokenEdge {
  return {
    adapterId: "univ2",
    target,
    tokenIn,
    tokenOut,
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
    poolToken0: tokenIn,
    poolToken1: tokenOut,
    v2FeeBps: feeBps,
    score: 1,
  };
}

function publicationWith(edges: readonly TokenEdge[]): LiveDiscoveryPublicationState {
  return {
    blockscanGraph: edges,
  } as unknown as LiveDiscoveryPublicationState;
}

test("computeDiscoveryGraphTopologyKey is stable for an unchanged graph", () => {
  const a = publicationWith([swapEdge("0xaaa", "0xt1", "0xt2")]);
  const b = publicationWith([swapEdge("0xaaa", "0xt1", "0xt2")]);
  assert.equal(
    computeDiscoveryGraphTopologyKey(a),
    computeDiscoveryGraphTopologyKey(b),
  );
});

test("computeDiscoveryGraphTopologyKey changes when an edge is added", () => {
  const before = publicationWith([swapEdge("0xaaa", "0xt1", "0xt2")]);
  const after = publicationWith([
    swapEdge("0xaaa", "0xt1", "0xt2"),
    swapEdge("0xaaa", "0xt2", "0xt1"),
  ]);
  assert.notEqual(
    computeDiscoveryGraphTopologyKey(before),
    computeDiscoveryGraphTopologyKey(after),
  );
});

test("computeDiscoveryGraphTopologyKey changes on same-identity fee metadata", () => {
  // Regression: the old key hashed only blockScanEdgeKey (identity), so a
  // fee/factory/token change on the same edge could reuse a stale GraphView.
  const lowFee = publicationWith([swapEdge("0xaaa", "0xt1", "0xt2", 30n)]);
  const highFee = publicationWith([swapEdge("0xaaa", "0xt1", "0xt2", 100n)]);
  assert.notEqual(
    computeDiscoveryGraphTopologyKey(lowFee),
    computeDiscoveryGraphTopologyKey(highFee),
  );
});

test("computeDiscoveryGraphTopologyKey ignores score-only changes", () => {
  const low = publicationWith([swapEdge("0xaaa", "0xt1", "0xt2")]);
  const high = publicationWith([{
    ...swapEdge("0xaaa", "0xt1", "0xt2"),
    score: 100,
  }]);
  assert.equal(
    computeDiscoveryGraphTopologyKey(low),
    computeDiscoveryGraphTopologyKey(high),
  );
});
