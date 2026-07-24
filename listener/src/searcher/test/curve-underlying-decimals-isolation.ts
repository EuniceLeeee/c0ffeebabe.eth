import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  BlockScanStateCoordinator,
  type BlockScanStateReadBackend,
} from "../blockscan-state-coordinator.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  blockScanEdgeKey,
  createVerifiedGraphView,
  registerBlockScanStateFamily,
  type StateRead,
  type StateReadResult,
  type StateReadSuccess,
} from "../venues/blockscan-state-capability.js";
import { blockScanErc20Iface } from "../venues/swaps/blockscan-state-shared.js";
import { curveUnderlyingBlockScanState } from "../venues/swaps/curve-underlying.js";

const SOURCE_BLOCK = 25_599_790;
const SOURCE_HASH = `0x${"cd".repeat(32)}`;
const HEALTHY_POOL = "0x1111111111111111111111111111111111111111";
const BROKEN_POOL = "0x2222222222222222222222222222222222222222";
const HEALTHY_TOKEN_6 = "0x3333333333333333333333333333333333333333";
const HEALTHY_TOKEN_18 = "0x4444444444444444444444444444444444444444";
const BROKEN_TOKEN = "0x5555555555555555555555555555555555555555";
const BROKEN_POOL_PEER =
  "0x6666666666666666666666666666666666666666";
const taxonomy = deriveEdgeTaxonomy("swap");
const curveUnderlyingIface = new ethers.Interface([
  "function get_dy_underlying(int128 i,int128 j,uint256 dx) view returns (uint256)",
]);

class CurveUnderlyingBackend implements BlockScanStateReadBackend {
  readonly quoteTargets: string[] = [];
  readonly decimalsTargets: string[] = [];

  async readBatch(
    _lane: "swap" | "protocol",
    reads: readonly StateRead[],
    control: {
      readonly sourceBlock: number;
      readonly sourceBlockHash: string;
      readonly sourceGeneration: number;
    },
  ): Promise<readonly StateReadResult[]> {
    assert.equal(control.sourceBlock, SOURCE_BLOCK);
    assert.equal(control.sourceBlockHash, SOURCE_HASH);
    return reads.map((read): StateReadResult => {
      const selector = read.data.slice(0, 10);
      if (
        selector === blockScanErc20Iface.getFunction("decimals")!.selector
      ) {
        this.decimalsTargets.push(read.to.toLowerCase());
        if (same(read.to, BROKEN_TOKEN)) {
          return Object.freeze({
            id: read.id,
            ok: false as const,
            sourceBlock: read.sourceBlock,
            sourceBlockHash: read.sourceBlockHash,
            kind: "rpc" as const,
            error: "non-standard token decimals() reverted",
          });
        }
        const decimals = same(read.to, HEALTHY_TOKEN_6) ? 6 : 18;
        return success(
          read,
          control.sourceGeneration,
          blockScanErc20Iface.encodeFunctionResult("decimals", [decimals]),
        );
      }
      if (
        selector ===
          curveUnderlyingIface.getFunction("get_dy_underlying")!.selector
      ) {
        this.quoteTargets.push(read.to.toLowerCase());
        assert.equal(
          same(read.to, HEALTHY_POOL),
          true,
          "a state key with unresolved decimals must not schedule quotes",
        );
        const decoded = curveUnderlyingIface.decodeFunctionData(
          "get_dy_underlying",
          read.data,
        );
        const amountIn = BigInt(decoded[2]);
        const expectedAmount = decoded[0] === 0n
          ? 10n ** 6n
          : 10n ** 18n;
        assert.equal(
          amountIn,
          expectedAmount,
          "Curve-underlying must use the successfully decoded token decimals",
        );
        return success(
          read,
          control.sourceGeneration,
          curveUnderlyingIface.encodeFunctionResult(
            "get_dy_underlying",
            [amountIn * 2n],
          ),
        );
      }
      throw new Error(`unexpected Curve-underlying read ${read.id}`);
    });
  }

  async verifyCanonicalSource(source: {
    readonly number: number;
    readonly hash: string;
  }): Promise<void> {
    assert.equal(source.number, SOURCE_BLOCK);
    assert.equal(source.hash, SOURCE_HASH);
  }
}

const healthyEdges = curveEdges(
  HEALTHY_POOL,
  HEALTHY_TOKEN_6,
  HEALTHY_TOKEN_18,
);
const brokenEdges = curveEdges(BROKEN_POOL, BROKEN_TOKEN, BROKEN_POOL_PEER);
const edges = Object.freeze([...healthyEdges, ...brokenEdges]);
const backend = new CurveUnderlyingBackend();
const result = await new BlockScanStateCoordinator(backend).prepare({
  graph: createVerifiedGraphView({
    id: "curve-underlying-decimals-isolation",
    generation: 1,
    sourceBlock: SOURCE_BLOCK,
    sourceBlockHash: SOURCE_HASH,
    completenessWatermark: SOURCE_BLOCK,
    perSourceCoverage: [{
      familyId: "curve-underlying",
      sourceId: "curve-underlying-decimals-isolation",
      sourceFingerprint: "curve-underlying-decimals-isolation-v1",
      completeThroughBlock: SOURCE_BLOCK,
      completeThroughHash: SOURCE_HASH,
    }],
    edges,
    familyIdForEdge: () => "curve-underlying",
  }),
  families: [registerBlockScanStateFamily({
    familyId: "curve-underlying",
    lane: "swap",
    capability: curveUnderlyingBlockScanState,
    ownsEdge: (edge) => edge.adapterId === "curve-exchange-underlying",
  })],
  deadlineAtMs: Date.now() + 2_000,
});

assert.equal(result.status, "degraded");
assert.equal(result.snapshot.graph.edges.length, 4, "graph is not reduced");
assert.equal(result.snapshot.mids.size, 2, "healthy pool mids remain published");
const healthyGraphEdges = result.snapshot.graph.edges.filter((edge) =>
  same(edge.target, HEALTHY_POOL)
);
const brokenGraphEdges = result.snapshot.graph.edges.filter((edge) =>
  same(edge.target, BROKEN_POOL)
);
assert.deepEqual(
  [...result.coverage.resolvedEdgeKeys].sort(),
  healthyGraphEdges.map(blockScanEdgeKey).sort(),
);
assert.deepEqual(
  [...result.coverage.unresolvedEdgeKeys].sort(),
  brokenGraphEdges.map(blockScanEdgeKey).sort(),
);
assert.equal(result.coverage.unavailableEdgeKeys.length, 0);
assert.deepEqual(result.snapshot.incompleteFamilyIds, ["curve-underlying"]);
for (const edge of healthyGraphEdges) {
  const key = blockScanEdgeKey(edge);
  assert.equal(result.snapshot.coverageByEdgeKey.get(key)?.status, "resolved");
  assert.equal(result.snapshot.mids.has(key), true);
}
for (const edge of brokenGraphEdges) {
  const key = blockScanEdgeKey(edge);
  assert.equal(result.snapshot.coverageByEdgeKey.get(key)?.status, "unresolved");
  assert.equal(result.snapshot.mids.has(key), false);
}
assert.equal(backend.quoteTargets.length, 2);
assert(
  backend.quoteTargets.every((target) => same(target, HEALTHY_POOL)),
  "only the healthy state key reaches current-N quote",
);
assert(backend.decimalsTargets.some((target) => same(target, BROKEN_TOKEN)));
assert(
  result.issues.some((issue) =>
    issue.familyId === "curve-underlying" &&
    issue.stateKey?.includes(BROKEN_POOL.toLowerCase()) &&
    issue.message.includes("non-standard token decimals() reverted")
  ),
  "the decimals failure remains attributed to its owning state key",
);
assert(
  result.issues.every((issue) =>
    !issue.message.includes("static schema") &&
    !issue.message.includes("static read")
  ),
  "one token failure must not become a family compile failure",
);

console.log(
  "[curve-underlying-decimals-isolation] bad token is state-key local: PASS",
);

function curveEdges(
  pool: string,
  token0: string,
  token1: string,
): TokenEdge[] {
  return [
    {
      adapterId: "curve-exchange-underlying",
      target: pool,
      tokenIn: token0,
      tokenOut: token1,
      poolToken0: token0,
      poolToken1: token1,
      curveI: 0,
      curveJ: 1,
      slotKind: "swap",
      ...taxonomy,
    },
    {
      adapterId: "curve-exchange-underlying",
      target: pool,
      tokenIn: token1,
      tokenOut: token0,
      poolToken0: token0,
      poolToken1: token1,
      curveI: 1,
      curveJ: 0,
      slotKind: "swap",
      ...taxonomy,
    },
  ];
}

function success(
  read: StateRead,
  generation: number,
  data: string,
): StateReadSuccess {
  return Object.freeze({
    id: read.id,
    ok: true,
    sourceBlock: read.sourceBlock,
    sourceBlockHash: read.sourceBlockHash,
    provenance: Object.freeze({
      kind: "eip1898" as const,
      source: Object.freeze({
        number: read.sourceBlock,
        hash: read.sourceBlockHash,
        generation,
      }),
      requireCanonical: true as const,
    }),
    data,
  });
}

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
