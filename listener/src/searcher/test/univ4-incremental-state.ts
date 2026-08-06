import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  BlockScanStateCoordinator,
  type BlockScanStateReadBackend,
} from "../blockscan-state-coordinator.js";
import {
  v4PoolId,
  type TokenEdge,
  type V4PoolKey,
} from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  createVerifiedGraphView,
  deterministicHash,
  registerBlockScanStateFamily,
  type BlockScanPricingLane,
  type BlockSource,
  type ChainLog,
  type StateRead,
  type StateReadResult,
} from "../venues/blockscan-state-capability.js";
import {
  UNIV4_SWAP_TOPIC,
} from "../venues/landed-event-registry.js";
import { univ4BlockScanState } from "../venues/swaps/univ4.js";

const FIRST_BLOCK = 25_600_000;
const TOKEN0 = "0x1000000000000000000000000000000000000001";
const TOKEN1 = "0x2000000000000000000000000000000000000002";
const STATIC_KEY: V4PoolKey = {
  currency0: TOKEN0,
  currency1: TOKEN1,
  fee: 3_000,
  tickSpacing: 60,
  hooks: ethers.ZeroAddress,
};
const DYNAMIC_KEY: V4PoolKey = {
  ...STATIC_KEY,
  fee: 0x800000,
};
const STATIC_POOL_ID = v4PoolId(STATIC_KEY);
const DYNAMIC_POOL_ID = v4PoolId(DYNAMIC_KEY);
const OUTSIDE_POOL_ID = `0x${"ff".repeat(32)}`;
const stateViewIface = new ethers.Interface([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
type MutationMode =
  | "unchanged"
  | "static-swap"
  | "outside-swap"
  | "donate"
  | "missing-range";

class V4IncrementalBackend implements BlockScanStateReadBackend {
  mutationMode: MutationMode = "unchanged";
  physicalReads: string[] = [];
  activityReads = 0;

  async readBatch(
    _lane: BlockScanPricingLane,
    reads: readonly StateRead[],
    control: { readonly sourceGeneration: number },
  ): Promise<readonly StateReadResult[]> {
    this.physicalReads.push(...reads.map((read) => read.id));
    return reads.map((read) => {
      const selector = read.data.slice(0, 10);
      const data = selector === stateViewIface.getFunction("getSlot0")!.selector
        ? stateViewIface.encodeFunctionResult("getSlot0", [
            (1n << 96n) + BigInt(control.sourceGeneration),
            0,
            0,
            read.id.includes(DYNAMIC_POOL_ID) ? 500 : 3_000,
          ])
        : selector === stateViewIface.getFunction("getLiquidity")!.selector
          ? stateViewIface.encodeFunctionResult("getLiquidity", [1_000_000n])
          : (() => {
              throw new Error(`unexpected V4 state read ${read.id}`);
            })();
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

  async readCanonicalBlockActivity(
    fromExclusive: BlockSource,
    through: BlockSource,
  ): Promise<{
    readonly fromExclusive: BlockSource;
    readonly through: BlockSource;
    readonly canonicalBlocks: readonly {
      readonly number: number;
      readonly hash: string;
    }[];
    readonly events: readonly ChainLog[];
    readonly touchedAddresses: readonly string[];
    readonly transactionCount: number;
    readonly canonicalPathFingerprint: string;
    readonly rangeFingerprint: string;
  }> {
    this.activityReads++;
    if (this.mutationMode === "missing-range") {
      throw new Error("canonical V4 log range unavailable");
    }
    const eventPoolId = this.mutationMode === "static-swap"
      ? STATIC_POOL_ID
      : this.mutationMode === "outside-swap"
        ? OUTSIDE_POOL_ID
        : null;
    // Donate is intentionally absent: it does not change slot0/liquidity and
    // the production query does not request it.
    const events: readonly ChainLog[] = eventPoolId === null
      ? []
      : [Object.freeze({
          blockNumber: through.number,
          blockHash: through.hash,
          transactionIndex: 0,
          logIndex: 0,
          address: ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(),
          topics: Object.freeze([UNIV4_SWAP_TOPIC, eventPoolId]),
          data: "0x",
          removed: false,
        })];
    const canonicalPathFingerprint = deterministicHash({
      fromExclusive,
      through,
    });
    const rangeFingerprint = deterministicHash({
      fromExclusive,
      through,
      canonicalPathFingerprint,
      events,
    });
    return Object.freeze({
      fromExclusive,
      through,
      canonicalBlocks: Object.freeze([
        Object.freeze({ number: through.number, hash: through.hash }),
      ]),
      events,
      touchedAddresses: Object.freeze([
        ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(),
      ]),
      transactionCount: events.length,
      canonicalPathFingerprint,
      rangeFingerprint,
    });
  }
}

const taxonomy = deriveEdgeTaxonomy("swap");
const edges = Object.freeze([
  ...directedEdges(STATIC_KEY),
  ...directedEdges(DYNAMIC_KEY),
]);
const family = registerBlockScanStateFamily({
  familyId: "univ4",
  lane: "swap",
  capability: univ4BlockScanState,
  ownsEdge: (edge) => edge.adapterId === "univ4-unlock",
});
const backend = new V4IncrementalBackend();
const coordinator = new BlockScanStateCoordinator(backend);

const cold = await prepare(1);
assert.equal(cold.status, "complete");
assert.equal(backend.physicalReads.length, 4);

backend.physicalReads.length = 0;
backend.mutationMode = "unchanged";
const unchanged = await prepare(2);
assert.equal(unchanged.status, "complete");
assert.equal(
  backend.physicalReads.length,
  0,
  "static and dynamic-fee V4 carry without an event (dynamic fee does not affect mid price)",
);

backend.physicalReads.length = 0;
backend.mutationMode = "static-swap";
const changed = await prepare(3);
assert.equal(changed.status, "complete");
assert.equal(
  backend.physicalReads.length,
  2,
  "a static-pool Swap refreshes only that pool",
);

backend.physicalReads.length = 0;
backend.mutationMode = "outside-swap";
const unrelated = await prepare(4);
assert.equal(unrelated.status, "complete");
assert.equal(
  backend.physicalReads.length,
  0,
  "an untracked singleton poolId must not dirty any existing V4 pool",
);

backend.physicalReads.length = 0;
backend.mutationMode = "donate";
const donated = await prepare(5);
assert.equal(donated.status, "complete");
assert.equal(
  backend.physicalReads.length,
  0,
  "Donate does not dirty any V4 pool",
);

backend.physicalReads.length = 0;
backend.mutationMode = "missing-range";
const fallback = await prepare(6);
assert.equal(fallback.status, "complete");
assert.equal(
  backend.physicalReads.length,
  4,
  "an unproven canonical range falls back to direct reads for every V4 key",
);

console.log("univ4-incremental-state PASS");

async function prepare(generation: number) {
  const blockNumber = FIRST_BLOCK + generation - 1;
  const blockHash = hash(generation);
  const graph = createVerifiedGraphView({
    id: `univ4-incremental-${generation}`,
    generation,
    sourceBlock: blockNumber,
    sourceBlockHash: blockHash,
    completenessWatermark: blockNumber,
    perSourceCoverage: [{
      familyId: "univ4",
      sourceId: "fixture",
      sourceFingerprint: "univ4-incremental-fixture",
      completeThroughBlock: blockNumber,
      completeThroughHash: blockHash,
    }],
    edges,
    familyIdForEdge: () => "univ4",
  });
  return coordinator.prepare({
    graph,
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
  });
}

function directedEdges(key: V4PoolKey): TokenEdge[] {
  const poolId = v4PoolId(key);
  const common = {
    adapterId: "univ4-unlock",
    target: ADDR.UNISWAP_V4_POOL_MANAGER,
    poolId,
    v4PoolKey: key,
    poolToken0: key.currency0,
    poolToken1: key.currency1,
    slotKind: "swap" as const,
    ...taxonomy,
  };
  return [
    { ...common, tokenIn: TOKEN0, tokenOut: TOKEN1 },
    { ...common, tokenIn: TOKEN1, tokenOut: TOKEN0 },
  ];
}

function hash(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
