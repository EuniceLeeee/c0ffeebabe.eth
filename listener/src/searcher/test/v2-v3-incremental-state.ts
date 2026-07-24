import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { StateBackend } from "../../shared/state/state-backend.js";
import { BlockScanBackrunStateBridge } from "../blockscan-backrun-state-bridge.js";
import {
  BlockScanStateCoordinator,
  type BlockScanStateReadBackend,
} from "../blockscan-state-coordinator.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { PoolStateCache } from "../solver/pool-state-cache.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  blockScanEdgeKey,
  createVerifiedGraphView,
  deterministicHash,
  registerBlockScanStateFamily,
  type BlockScanPricingLane,
  type BlockSource,
  type CanonicalMutationRange,
  type ChainLog,
  type MutationQueryDescriptor,
  type RegisteredBlockScanStateFamily,
  type StateRead,
  type StateReadResult,
} from "../venues/blockscan-state-capability.js";
import { univ2BlockScanState } from "../venues/swaps/univ2-standard.js";
import { univ3BlockScanState } from "../venues/swaps/univ3-standard.js";

const V2_POOL = "0x1000000000000000000000000000000000000001";
const V3_POOL = "0x1000000000000000000000000000000000000002";
const V2_POOL_2 = "0x1000000000000000000000000000000000000003";
const TOKEN0 = "0x2000000000000000000000000000000000000001";
const TOKEN1 = "0x2000000000000000000000000000000000000002";
const FIRST_BLOCK = 25_000_000;
const taxonomy = deriveEdgeTaxonomy("swap");
const v2Iface = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
]);
const v3Iface = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)",
]);
const V2_SYNC_TOPIC = ethers.id("Sync(uint112,uint112)").toLowerCase();
const V3_SWAP_TOPIC = ethers.id(
  "Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)",
).toLowerCase();
const V3_MINT_TOPIC = ethers.id(
  "Mint(address,address,int24,int24,uint128,uint256,uint256)",
).toLowerCase();
const V3_BURN_TOPIC = ethers.id(
  "Burn(address,int24,int24,uint128,uint256,uint256)",
).toLowerCase();

type MutationMode =
  | "unchanged"
  | "v2-changed"
  | "v3-swap"
  | "v3-changed"
  | "missing-logs";

class IncrementalBackend implements BlockScanStateReadBackend {
  mutationMode: MutationMode = "unchanged";
  physicalReads: string[] = [];
  mutationFamilies: string[] = [];

  async readBatch(
    _lane: BlockScanPricingLane,
    reads: readonly StateRead[],
    control: {
      readonly sourceGeneration: number;
    },
  ): Promise<readonly StateReadResult[]> {
    this.physicalReads.push(...reads.map((read) => read.id));
    return reads.map((read) => {
      const selector = read.data.slice(0, 10);
      let data: string;
      if (selector === v2Iface.getFunction("getReserves")!.selector) {
        data = v2Iface.encodeFunctionResult("getReserves", [
          BigInt(control.sourceGeneration) * 1_000n,
          2_000n,
          1,
        ]);
      } else if (selector === v3Iface.getFunction("slot0")!.selector) {
        data = v3Iface.encodeFunctionResult("slot0", [
          (1n << 96n) + BigInt(control.sourceGeneration),
          0,
          0,
          1,
          1,
          0,
          true,
        ]);
      } else if (selector === v3Iface.getFunction("liquidity")!.selector) {
        data = v3Iface.encodeFunctionResult("liquidity", [1_000_000n]);
      } else {
        throw new Error(`unexpected state read ${read.id}`);
      }
      return Object.freeze({
        id: read.id,
        ok: true as const,
        sourceBlock: read.sourceBlock,
        sourceBlockHash: read.sourceBlockHash,
        provenance: Object.freeze({
          kind: "eip1898" as const,
          source: Object.freeze({
            number: read.sourceBlock,
            hash: read.sourceBlockHash,
            generation: control.sourceGeneration,
          }),
          requireCanonical: true as const,
        }),
        data,
      });
    });
  }

  async verifyCanonicalSource(): Promise<void> {
    return;
  }

  async readCanonicalMutationRange(
    descriptor: MutationQueryDescriptor,
    fromExclusive: BlockSource,
    through: BlockSource,
  ): Promise<CanonicalMutationRange> {
    const isV2 = descriptor.topics.some(
      (topic) => Array.isArray(topic) && topic.includes(V2_SYNC_TOPIC),
    );
    this.mutationFamilies.push(isV2 ? "v2" : "v3");
    if (this.mutationMode === "missing-logs") {
      throw new Error("eth_getLogs could not prove a complete range");
    }
    const changed =
      this.mutationMode === "v2-changed" && isV2
        ? [{ address: V2_POOL, topic: V2_SYNC_TOPIC }]
        : this.mutationMode === "v3-changed" && !isV2
          ? [
              { address: V3_POOL, topic: V3_SWAP_TOPIC },
              { address: V3_POOL, topic: V3_MINT_TOPIC },
              { address: V3_POOL, topic: V3_BURN_TOPIC },
            ]
          : this.mutationMode === "v3-swap" && !isV2
            ? [{ address: V3_POOL, topic: V3_SWAP_TOPIC }]
          : [];
    const events: readonly ChainLog[] = changed
      .map((item, logIndex) => Object.freeze({
          blockNumber: through.number,
          blockHash: through.hash,
          transactionIndex: 0,
          logIndex,
          address: item.address.toLowerCase(),
          topics: Object.freeze([item.topic]),
          data: "0x",
          removed: false,
        }));
    const canonicalPathFingerprint = deterministicHash({
      from: fromExclusive,
      through,
    });
    const rangeFingerprint = deterministicHash({
      fromExclusive,
      through,
      queryDescriptorFingerprint: descriptor.fingerprint,
      canonicalPathFingerprint,
      events,
    });
    return Object.freeze({
      fromExclusive,
      through,
      events,
      complete: true,
      queryDescriptorFingerprint: descriptor.fingerprint,
      canonicalPathFingerprint,
      rangeFingerprint,
    });
  }
}

const edges = Object.freeze([
  ...directedEdges("univ2-swap", V2_POOL, { v2FeeBps: 30n }),
  ...directedEdges("univ2-swap", V2_POOL_2, { v2FeeBps: 30n }),
  ...directedEdges("univ3-swap", V3_POOL, {
    v3Fee: 3_000,
    v3TickSpacing: 60,
  }),
]);
const families: readonly RegisteredBlockScanStateFamily[] = Object.freeze([
  registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: univ2BlockScanState,
    ownsEdge: (edge: TokenEdge) => edge.adapterId === "univ2-swap",
  }),
  registerBlockScanStateFamily({
    familyId: "univ3-standard",
    lane: "swap",
    capability: univ3BlockScanState,
    ownsEdge: (edge: TokenEdge) => edge.adapterId === "univ3-swap",
  }),
]);

const backend = new IncrementalBackend();
const coordinator = new BlockScanStateCoordinator(backend);
const backrunCache = new PoolStateCache();
const backrunBridge = new BlockScanBackrunStateBridge(backrunCache);

const first = await prepare(1, FIRST_BLOCK, hash(1));
assert.equal(first.status, "complete");
assert.equal(backend.physicalReads.length, 4, "startup directly reads reserves/slot0/liquidity");
assert.equal(first.snapshot.laneTelemetry.find((lane) => lane.lane === "swap")?.reads, 4);
assert(
  [...first.snapshot.freshnessByReadKey.values()].every(
    (proof) => proof.kind === "direct-read",
  ),
);
const firstV2Mid = first.snapshot.mids.get(blockScanEdgeKey(first.snapshot.graph.edges[0]))?.mid;
const firstBridge = backrunBridge.publish(first.snapshot);
assert.equal(firstBridge.v2Seeds, 2);
assert.equal(firstBridge.v3LiveSeeds, 1);
assert.equal(firstBridge.reorgReset, false);
assert.equal(
  backrunCache.snapshotV2(V2_POOL, FIRST_BLOCK)?.reserve0,
  1_000n,
);
assert.equal(
  backrunCache.snapshotV3Live(V3_POOL, FIRST_BLOCK)?.sqrtPriceX96,
  (1n << 96n) + 1n,
);
assert.equal(
  backrunCache.snapshotV3(V3_POOL, FIRST_BLOCK),
  null,
  "the bridge publishes V3 live state only; tick words stay on the existing JIT lifecycle",
);
const duplicateFirstBridge = backrunBridge.publish(first.snapshot);
assert.equal(duplicateFirstBridge.alreadyPublished, true);
assert.equal(duplicateFirstBridge.v2Seeds, 0);
assert.equal(duplicateFirstBridge.v3LiveSeeds, 0);
backrunCache.seedV3Ticks({
  pool: V3_POOL,
  token0: TOKEN0,
  token1: TOKEN1,
  fee: 3_000n,
  tickSpacing: 60,
  tickBitmap: new Map(
    Array.from({ length: 17 }, (_, index) => [index - 8, 0n]),
  ),
  ticks: new Map(),
  blockNumber: FIRST_BLOCK,
});
let backrunStateCalls = 0;
const noJitState = {
  async call(): Promise<string> {
    backrunStateCalls++;
    throw new Error("current-N bridge unexpectedly fell through to JIT state");
  },
} as unknown as StateBackend;
backrunCache.beginHint(FIRST_BLOCK);
assert(
  await backrunCache.quoteV2(
    noJitState,
    V2_POOL,
    TOKEN0,
    TOKEN1,
    10n,
  ) > 0n,
);
assert(
  await backrunCache.quoteV3(
    noJitState,
    V3_POOL,
    TOKEN0,
    TOKEN1,
    1n,
  ) >= 0n,
);
assert.equal(
  backrunStateCalls,
  0,
  "bridged V2 reserves and V3 live state avoid duplicate current-N reads",
);
backrunCache.beginHint(FIRST_BLOCK, [V2_POOL]);
await assert.rejects(
  backrunCache.quoteV2(
    noJitState,
    V2_POOL,
    TOKEN0,
    TOKEN1,
    10n,
  ),
  /overlay-only/,
  "a victim-impact pool must still bypass the pre-victim block seed",
);
assert.equal(backrunStateCalls, 0);
backrunCache.beginHint(FIRST_BLOCK);

backend.physicalReads.length = 0;
backend.mutationFamilies.length = 0;
backend.mutationMode = "unchanged";
const unchanged = await prepare(2, FIRST_BLOCK + 1, hash(2));
assert.equal(unchanged.status, "complete");
assert.deepEqual(backend.mutationFamilies.sort(), ["v2", "v3"]);
assert.equal(
  backend.physicalReads.length,
  0,
  "complete unchanged canonical ranges carry forward without a second state read",
);
assert.equal(
  unchanged.snapshot.laneTelemetry.find((lane) => lane.lane === "swap")?.reads,
  0,
);
assert(
  [...unchanged.snapshot.freshnessByReadKey.values()].every(
    (proof) =>
      proof.kind === "carry-forward" &&
      proof.completeThroughBlock === FIRST_BLOCK + 1 &&
      proof.completeThroughHash === hash(2),
  ),
);
assert.equal(
  unchanged.snapshot.mids.get(blockScanEdgeKey(unchanged.snapshot.graph.edges[0]))?.mid,
  firstV2Mid,
);
const unchangedBridge = backrunBridge.publish(unchanged.snapshot);
assert.equal(unchangedBridge.reorgReset, false);
assert.equal(
  backrunCache.snapshotV2(V2_POOL, FIRST_BLOCK + 1)?.reserve0,
  1_000n,
  "unchanged carry-forward reserves are restamped at current N",
);
assert.equal(
  backrunCache.snapshotV3Live(V3_POOL, FIRST_BLOCK + 1)?.sqrtPriceX96,
  (1n << 96n) + 1n,
  "unchanged V3 live state is restamped without a duplicate read",
);

backend.physicalReads.length = 0;
backend.mutationMode = "v2-changed";
const v2Changed = await prepare(3, FIRST_BLOCK + 2, hash(3));
assert.equal(v2Changed.status, "complete");
assert.equal(backend.physicalReads.length, 1);
assert.equal(v2Changed.snapshot.laneTelemetry.find((lane) => lane.lane === "swap")?.reads, 1);
assert.match(backend.physicalReads[0], /reserves:/);
assert(
  [...v2Changed.snapshot.freshnessByReadKey.entries()]
    .filter(([readKey]) => readKey.includes(V2_POOL.toLowerCase()))
    .every(([, proof]) => proof.kind === "direct-read"),
);
assert(
  [...v2Changed.snapshot.freshnessByReadKey.entries()]
    .filter(([readKey]) => readKey.includes(V3_POOL.toLowerCase()))
    .every(([, proof]) => proof.kind === "carry-forward"),
);
assert(
  [...v2Changed.snapshot.freshnessByReadKey.entries()]
    .filter(([readKey]) => readKey.includes(V2_POOL_2.toLowerCase()))
    .every(([, proof]) => proof.kind === "carry-forward"),
  "an unchanged sibling stateKey in the same family is not reread",
);
backrunBridge.publish(v2Changed.snapshot);
assert.equal(
  backrunCache.snapshotV2(V2_POOL, FIRST_BLOCK + 2)?.reserve0,
  3_000n,
  "changed pool publishes its new reserve snapshot",
);
assert.equal(
  backrunCache.snapshotV2(V2_POOL_2, FIRST_BLOCK + 2)?.reserve0,
  1_000n,
  "unchanged sibling keeps its value and receives current provenance",
);

backend.physicalReads.length = 0;
backrunCache.seedV3Ticks({
  pool: V3_POOL,
  token0: TOKEN0,
  token1: TOKEN1,
  fee: 3_000n,
  tickSpacing: 60,
  tickBitmap: new Map([[0, 1n]]),
  ticks: new Map([[0, 1n]]),
  blockNumber: FIRST_BLOCK + 2,
});
backend.mutationMode = "v3-changed";
const v3Changed = await prepare(4, FIRST_BLOCK + 3, hash(4));
assert.equal(v3Changed.status, "complete");
assert.equal(backend.physicalReads.length, 2);
assert(backend.physicalReads.some((readKey) => readKey.includes("slot0:")));
assert(backend.physicalReads.some((readKey) => readKey.includes("liquidity:")));
const v3ChangedBridge = backrunBridge.publish(v3Changed.snapshot);
assert.equal(v3ChangedBridge.v3TickInvalidations, 1);
assert.equal(
  backrunCache.snapshotV3Live(V3_POOL, FIRST_BLOCK + 3)?.sqrtPriceX96,
  (1n << 96n) + 4n,
);
assert.equal(
  backrunCache.snapshotV3(V3_POOL, FIRST_BLOCK + 3),
  null,
  "Swap/Mint/Burn invalidation refreshes live state but cannot carry prior-block tick words into N",
);

backend.physicalReads.length = 0;
backend.mutationMode = "missing-logs";
const missingLogs = await prepare(5, FIRST_BLOCK + 4, hash(5));
assert.equal(missingLogs.status, "complete");
assert.equal(
  backend.physicalReads.length,
  4,
  "an unproven log range forces full direct current-N refresh for both families",
);
assert(
  [...missingLogs.snapshot.freshnessByReadKey.values()].every(
    (proof) => proof.kind === "direct-read",
  ),
);
backrunBridge.publish(missingLogs.snapshot);
backrunCache.seedV3Ticks({
  pool: V3_POOL,
  token0: TOKEN0,
  token1: TOKEN1,
  fee: 3_000n,
  tickSpacing: 60,
  tickBitmap: new Map(),
  ticks: new Map(),
  blockNumber: FIRST_BLOCK + 4,
});
assert(backrunCache.snapshotV3(V3_POOL, FIRST_BLOCK + 4));

backend.physicalReads.length = 0;
backend.mutationMode = "unchanged";
const reorgSameHeight = await prepare(6, FIRST_BLOCK + 4, hash(6));
assert.equal(reorgSameHeight.status, "complete");
assert.equal(
  backend.physicalReads.length,
  4,
  "same-height replacement cannot reuse the prior canonical mutation proof",
);
const reorgBridge = backrunBridge.publish(reorgSameHeight.snapshot);
assert.equal(reorgBridge.reorgReset, true);
assert.equal(
  backrunCache.snapshotV3(V3_POOL, FIRST_BLOCK + 4),
  null,
  "same-height hash replacement clears potentially orphaned tick words",
);
assert.equal(
  backrunCache.snapshotV3Live(V3_POOL, FIRST_BLOCK + 4)?.sqrtPriceX96,
  (1n << 96n) + 6n,
  "replacement generation publishes its current live state after the reset",
);
assert.equal(
  backrunCache.snapshotV2(V2_POOL, FIRST_BLOCK + 4)?.reserve0,
  6_000n,
);

backend.physicalReads.length = 0;
const feeChangedEdges = edges.map((edge) =>
  edge.target.toLowerCase() === V2_POOL.toLowerCase()
    ? { ...edge, v2FeeBps: 25n }
    : edge
);
const staticMetadataChanged = await prepare(
  7,
  FIRST_BLOCK + 5,
  hash(7),
  feeChangedEdges,
);
assert.equal(staticMetadataChanged.status, "complete");
assert.equal(
  backend.physicalReads.length,
  2,
  "a changed V2 fee/schema fingerprint forces the whole family to direct-read",
);
assert(backend.physicalReads.every((readKey) => readKey.includes("reserves:")));
backrunBridge.publish(staticMetadataChanged.snapshot);
assert.equal(
  backrunCache.snapshotV2(V2_POOL, FIRST_BLOCK + 5)?.feeBps,
  25n,
);

// Blind/replay attempt lifecycle: discard the prior source N, rebuild a clean
// N-1 outside the timed pass, then retain that exact base as the incremental
// predecessor for N. Repeating the flow must never reuse the prior attempt's N.
backend.mutationMode = "unchanged";
coordinator.resetDynamicStateForReplay();
backend.physicalReads.length = 0;
const attemptOneBase = await prepare(
  8,
  FIRST_BLOCK + 10,
  hash(8),
);
assert.equal(attemptOneBase.status, "complete");
assert.equal(
  backend.physicalReads.length,
  4,
  "the first per-attempt N-1 base is rebuilt after dynamic reset",
);
backend.physicalReads.length = 0;
const attemptOneSource = await prepare(
  9,
  FIRST_BLOCK + 11,
  hash(9),
);
assert.equal(attemptOneSource.status, "complete");
assert.equal(
  backend.physicalReads.length,
  0,
  "unchanged source-N keys carry forward from the clean N-1 base",
);
assert(
  [...attemptOneSource.snapshot.freshnessByReadKey.values()]
    .every((proof) => proof.kind === "carry-forward"),
);
assert.equal(
  attemptOneSource.snapshot.stateByStateKey
    .get(`univ2-standard\u001f${V2_POOL.toLowerCase()}`)
    ?.snapshot.projectBackrunState?.({
      number: FIRST_BLOCK + 11,
      hash: hash(9),
      generation: 9,
    }).state.blockNumber,
  FIRST_BLOCK + 11,
);
backrunBridge.publish(attemptOneSource.snapshot);
backrunCache.seedV3Ticks({
  pool: V3_POOL,
  token0: TOKEN0,
  token1: TOKEN1,
  fee: 3_000n,
  tickSpacing: 60,
  tickBitmap: new Map(
    Array.from({ length: 17 }, (_, index) => [index - 8, 0n]),
  ),
  ticks: new Map([[0, 9n]]),
  blockNumber: FIRST_BLOCK + 11,
});
assert.equal(
  backrunCache.snapshotV3(V3_POOL, FIRST_BLOCK + 11)?.state.ticks.get(0),
  9n,
  "the first attempt owns a source-N tick cache before replay reset",
);

coordinator.resetDynamicStateForReplay();
backrunBridge.resetDynamicStateForReplay();
assert.equal(
  backrunCache.snapshotV3(V3_POOL, FIRST_BLOCK + 11),
  null,
  "the next blind attempt starts without the prior source-N tick cache",
);
backend.physicalReads.length = 0;
const attemptTwoBase = await prepare(
  10,
  FIRST_BLOCK + 10,
  hash(8),
);
assert.equal(attemptTwoBase.status, "complete");
assert.equal(
  backend.physicalReads.length,
  4,
  "the next attempt must rebuild N-1 instead of reusing the prior source N",
);
const attemptTwoBaseSeed = attemptTwoBase.snapshot.stateByStateKey
  .get(`univ2-standard\u001f${V2_POOL.toLowerCase()}`)
  ?.snapshot.projectBackrunState?.({
    number: FIRST_BLOCK + 10,
    hash: hash(8),
    generation: 10,
  });
assert(
  attemptTwoBaseSeed?.kind === "v2" &&
    attemptTwoBaseSeed.state.reserve0 === 10_000n,
  "the rebuilt base must reflect its own generation, not stale source-N state",
);
backend.physicalReads.length = 0;
const attemptTwoSource = await prepare(
  11,
  FIRST_BLOCK + 11,
  hash(9),
);
assert.equal(attemptTwoSource.status, "complete");
assert.equal(
  backend.physicalReads.length,
  0,
  "the second source N also carries forward only from its own N-1",
);
const attemptTwoSourceSeed = attemptTwoSource.snapshot.stateByStateKey
  .get(`univ2-standard\u001f${V2_POOL.toLowerCase()}`)
  ?.snapshot.projectBackrunState?.({
    number: FIRST_BLOCK + 11,
    hash: hash(9),
    generation: 11,
  });
assert(
  attemptTwoSourceSeed?.kind === "v2" &&
    attemptTwoSourceSeed.state.reserve0 === 10_000n,
  "source N must not reuse the previous attempt's current-N value",
);
backrunBridge.publish(attemptTwoSource.snapshot);
assert.equal(
  backrunCache.snapshotV3(V3_POOL, FIRST_BLOCK + 11),
  null,
  "publishing the same N/hash in a later attempt must not resurrect prior N tick words",
);

// A pure Swap refreshes slot0/liquidity but does not change initialized tick
// bitmap/liquidityNet. Preserve that expensive cache; only Mint/Burn (tested
// above) or an unproven mutation range may invalidate it.
coordinator.resetDynamicStateForReplay();
backrunBridge.resetDynamicStateForReplay();
backend.mutationMode = "unchanged";
const swapOnlyBase = await prepare(20, FIRST_BLOCK + 20, hash(20));
backrunBridge.publish(swapOnlyBase.snapshot);
backrunCache.seedV3Ticks({
  pool: V3_POOL,
  token0: TOKEN0,
  token1: TOKEN1,
  fee: 3_000n,
  tickSpacing: 60,
  tickBitmap: new Map([[0, 1n]]),
  ticks: new Map([[0, 20n]]),
  blockNumber: FIRST_BLOCK + 20,
});
backend.mutationMode = "v3-swap";
const swapOnlySource = await prepare(21, FIRST_BLOCK + 21, hash(21));
const swapOnlyBridge = backrunBridge.publish(swapOnlySource.snapshot);
assert.equal(
  swapOnlyBridge.v3TickInvalidations,
  0,
  "a proven Swap-only range must not discard unchanged tick words",
);
assert.equal(
  backrunCache.snapshotV3(V3_POOL, FIRST_BLOCK + 21)?.state.ticks.get(0),
  20n,
  "Swap-only current-N publication preserves the prior canonical tick cache",
);

console.log("v2-v3-incremental-state + backrun bridge PASS");

async function prepare(
  generation: number,
  blockNumber: number,
  blockHash: string,
  graphEdges: readonly TokenEdge[] = edges,
) {
  const graph = createVerifiedGraphView({
    id: `v2-v3-${generation}`,
    generation,
    sourceBlock: blockNumber,
    sourceBlockHash: blockHash,
    completenessWatermark: blockNumber,
    perSourceCoverage: [{
      familyId: "registry:swap",
      sourceId: "fixture",
      sourceFingerprint: "v2-v3-fixture",
      completeThroughBlock: blockNumber,
      completeThroughHash: blockHash,
    }],
    edges: graphEdges,
    familyIdForEdge: (edge) =>
      edge.adapterId === "univ2-swap" ? "univ2-standard" : "univ3-standard",
  });
  const result = await coordinator.prepare({
    graph,
    families,
    deadlineAtMs: Date.now() + 2_000,
  });
  if (result.status === "incomplete") {
    throw new Error(result.issues.map((issue) => issue.message).join("; "));
  }
  return result;
}

function directedEdges(
  adapterId: string,
  target: string,
  metadata: Pick<TokenEdge, "v2FeeBps" | "v3Fee" | "v3TickSpacing">,
): TokenEdge[] {
  return [
    {
      adapterId,
      target,
      tokenIn: TOKEN0,
      tokenOut: TOKEN1,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
      slotKind: "swap",
      ...metadata,
      ...taxonomy,
    },
    {
      adapterId,
      target,
      tokenIn: TOKEN1,
      tokenOut: TOKEN0,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
      slotKind: "swap",
      ...metadata,
      ...taxonomy,
    },
  ];
}

function hash(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
