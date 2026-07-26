import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import type {
  BlockScanStateReadBackend,
} from "../blockscan-state-coordinator.js";
import {
  blockScanMulticallIface,
} from "../blockscan-multicall.js";
import type {
  PoolUniverseEntry,
} from "../pool-universe.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import type { TokenEdge } from "../planner/token-graph.js";
import {
  deterministicHash,
  type BlockScanPricingLane,
  type BlockSource,
  type CanonicalMutationRange,
  type ChainLog,
  type MutationQueryDescriptor,
  type StateRead,
  type StateReadResult,
} from "../venues/blockscan-state-capability.js";
import {
  UNIV2_SYNC_TOPIC,
  UNIV3_SWAP_TOPIC,
} from "../venues/landed-event-registry.js";
import {
  compareV2V3ShadowRange,
  selectV2V3UniverseCandidates,
  v2V3ShadowParityExitCode,
  writeCanonicalShadowArtifact,
  type SelectedV2V3Pool,
  type ShadowBlockHeader,
} from "./v2-v3-shadow-parity.js";

const V2_A = "0x1000000000000000000000000000000000000001";
const V2_B = "0x1000000000000000000000000000000000000002";
const V3_A = "0x1000000000000000000000000000000000000003";
const V3_B = "0x1000000000000000000000000000000000000004";
const TOKEN0 = "0x2000000000000000000000000000000000000001";
const TOKEN1 = "0x2000000000000000000000000000000000000002";
const UNIV2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const UNIV3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const PANCAKE_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
const Q96 = 1n << 96n;
const taxonomy = deriveEdgeTaxonomy("swap");

const v2Iface = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
]);
const v3Iface = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)",
]);
const v3FactoryIface = new ethers.Interface([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
]);

interface FakePoolState {
  readonly family: "v2" | "v3";
  readonly token0: string;
  readonly token1: string;
  readonly reserve0?: bigint;
  readonly reserve1?: bigint;
  readonly timestamp?: number;
  readonly sqrtPriceX96?: bigint;
  readonly tick?: number;
  readonly liquidity?: bigint;
}

class FakeChain {
  corruptCoordinatorV3 = false;
  readonly headers: ReadonlyMap<number, ShadowBlockHeader>;

  constructor() {
    const block100: ShadowBlockHeader = Object.freeze({
      number: 100,
      hash: hash("block-100"),
      parentHash: hash("block-99"),
      generation: 100,
    });
    const block101: ShadowBlockHeader = Object.freeze({
      number: 101,
      hash: hash("block-101"),
      parentHash: block100.hash,
      generation: 101,
    });
    this.headers = new Map([
      [100, block100],
      [101, block101],
    ]);
  }

  state(pool: string, block: number, coordinator = false): FakePoolState {
    const key = pool.toLowerCase();
    const changed = block >= 101;
    if (key === V2_A.toLowerCase()) {
      return {
        family: "v2",
        token0: TOKEN0,
        token1: TOKEN1,
        reserve0: changed ? 1_100n : 1_000n,
        reserve1: changed ? 1_900n : 2_000n,
        timestamp: block,
      };
    }
    if (key === V2_B.toLowerCase()) {
      return {
        family: "v2",
        token0: TOKEN0,
        token1: TOKEN1,
        reserve0: 4_000n,
        reserve1: 8_000n,
        timestamp: 7,
      };
    }
    if (key === V3_A.toLowerCase()) {
      return {
        family: "v3",
        token0: TOKEN0,
        token1: TOKEN1,
        sqrtPriceX96:
          changed && coordinator && this.corruptCoordinatorV3
            ? Q96 * 3n
            : changed
              ? Q96 * 2n
              : Q96,
        tick: changed ? 13_863 : 0,
        liquidity: 1_000_000n,
      };
    }
    if (key === V3_B.toLowerCase()) {
      return {
        family: "v3",
        token0: TOKEN0,
        token1: TOKEN1,
        sqrtPriceX96: Q96,
        tick: 0,
        liquidity: 2_000_000n,
      };
    }
    throw new Error(`unknown fake pool ${pool}`);
  }

  header(block: number): ShadowBlockHeader {
    const header = this.headers.get(block);
    if (!header) throw new Error(`unknown fake block ${block}`);
    return header;
  }
}

class FakeLegacyProvider {
  constructor(private readonly chain: FakeChain) {}

  async getBlock(blockNumber: number): Promise<{
    hash: string;
    parentHash: string;
  }> {
    const header = this.chain.header(blockNumber);
    return { hash: header.hash, parentHash: header.parentHash };
  }

  async call(tx: {
    readonly data: string;
    readonly blockTag?: ethers.BlockTag;
  }): Promise<string> {
    const block = Number(tx.blockTag);
    const calls = blockScanMulticallIface.decodeFunctionData(
      "aggregate3",
      tx.data,
    )[0] as readonly {
      target: string;
      allowFailure: boolean;
      callData: string;
    }[];
    return blockScanMulticallIface.encodeFunctionResult("aggregate3", [
      calls.map((call) => ({
        success: true,
        returnData: encodePoolCall(
          this.chain.state(call.target, block),
          call.callData,
        ),
      })),
    ]);
  }
}

class FakeCoordinatorBackend implements BlockScanStateReadBackend {
  constructor(private readonly chain: FakeChain) {}

  async readBatch(
    _lane: BlockScanPricingLane,
    reads: readonly StateRead[],
    control: {
      readonly sourceBlock: number;
      readonly sourceBlockHash: string;
      readonly sourceGeneration: number;
    },
  ): Promise<readonly StateReadResult[]> {
    return Object.freeze(
      reads.map((read) => Object.freeze({
        id: read.id,
        ok: true as const,
        sourceBlock: read.sourceBlock,
        sourceBlockHash: read.sourceBlockHash,
        provenance: Object.freeze({
          kind: "eip1898" as const,
          source: Object.freeze({
            number: control.sourceBlock,
            hash: control.sourceBlockHash,
            generation: control.sourceGeneration,
          }),
          requireCanonical: true as const,
        }),
        data:
          read.to.toLowerCase() === UNIV3_FACTORY.toLowerCase()
            ? v3FactoryIface.encodeFunctionResult("getPool", [V3_A])
            : read.to.toLowerCase() === PANCAKE_V3_FACTORY.toLowerCase()
              ? v3FactoryIface.encodeFunctionResult("getPool", [V3_B])
              : encodePoolCall(
                  this.chain.state(read.to, control.sourceBlock, true),
                  read.data,
                ),
      })),
    );
  }

  async verifyCanonicalSource(source: BlockSource): Promise<void> {
    const header = this.chain.header(source.number);
    if (header.hash !== source.hash) {
      throw new Error("fake canonical hash mismatch");
    }
  }

  async readCanonicalMutationRange(
    descriptor: MutationQueryDescriptor,
    fromExclusive: BlockSource,
    through: BlockSource,
  ): Promise<CanonicalMutationRange> {
    const isV2 = descriptor.topics.some((topic) =>
      Array.isArray(topic) && topic.includes(UNIV2_SYNC_TOPIC)
    );
    const mutations =
      through.number >= 101 && fromExclusive.number < 101
        ? isV2
          ? [{ address: V2_A, topic: UNIV2_SYNC_TOPIC }]
          : [{ address: V3_A, topic: UNIV3_SWAP_TOPIC }]
        : [];
    const events: readonly ChainLog[] = Object.freeze(
      mutations.map((mutation, logIndex) => Object.freeze({
        blockNumber: through.number,
        blockHash: through.hash,
        transactionIndex: 0,
        logIndex,
        address: mutation.address.toLowerCase(),
        topics: Object.freeze([mutation.topic]),
        data: "0x",
        removed: false,
      })),
    );
    const canonicalPathFingerprint = deterministicHash({
      fromExclusive,
      through,
    });
    return Object.freeze({
      fromExclusive,
      through,
      events,
      complete: true,
      queryDescriptorFingerprint: descriptor.fingerprint,
      canonicalPathFingerprint,
      rangeFingerprint: deterministicHash({
        fromExclusive,
        through,
        queryDescriptorFingerprint: descriptor.fingerprint,
        canonicalPathFingerprint,
        events,
      }),
    });
  }
}

function encodePoolCall(state: FakePoolState, data: string): string {
  const selector = data.slice(0, 10);
  if (selector === v2Iface.getFunction("token0")!.selector) {
    return v2Iface.encodeFunctionResult("token0", [state.token0]);
  }
  if (selector === v2Iface.getFunction("token1")!.selector) {
    return v2Iface.encodeFunctionResult("token1", [state.token1]);
  }
  if (selector === v2Iface.getFunction("factory")!.selector) {
    return v2Iface.encodeFunctionResult("factory", [UNIV2_FACTORY]);
  }
  if (selector === v2Iface.getFunction("getReserves")!.selector) {
    return v2Iface.encodeFunctionResult("getReserves", [
      state.reserve0!,
      state.reserve1!,
      state.timestamp!,
    ]);
  }
  if (selector === v3Iface.getFunction("fee")!.selector) {
    return v3Iface.encodeFunctionResult("fee", [3_000]);
  }
  if (selector === v3Iface.getFunction("tickSpacing")!.selector) {
    return v3Iface.encodeFunctionResult("tickSpacing", [60]);
  }
  if (selector === v3Iface.getFunction("slot0")!.selector) {
    return v3Iface.encodeFunctionResult("slot0", [
      state.sqrtPriceX96!,
      state.tick!,
      0,
      1,
      1,
      0,
      true,
    ]);
  }
  if (selector === v3Iface.getFunction("liquidity")!.selector) {
    return v3Iface.encodeFunctionResult("liquidity", [state.liquidity!]);
  }
  throw new Error(`unexpected fake call selector ${selector}`);
}

function selectedPool(
  familyId: "univ2-standard" | "univ3-standard",
  pool: string,
  rank: number,
): SelectedV2V3Pool {
  const adapter = familyId === "univ2-standard" ? "univ2" : "univ3";
  return Object.freeze({
    familyId,
    rank,
    pool: Object.freeze({
      address: pool,
      adapter,
      ...(familyId === "univ3-standard"
        ? {
            factory: pool.toLowerCase() === V3_A.toLowerCase()
              ? UNIV3_FACTORY
              : PANCAKE_V3_FACTORY,
          }
        : {}),
      score: 100 - rank,
      lastSwapBlock: 99,
    }),
    edges: Object.freeze(directedEdges(familyId, pool)),
  });
}

function directedEdges(
  familyId: "univ2-standard" | "univ3-standard",
  pool: string,
): TokenEdge[] {
  const adapterId =
    familyId === "univ2-standard" ? "univ2-swap" : "univ3-swap";
  return [
    [TOKEN0, TOKEN1],
    [TOKEN1, TOKEN0],
  ].map(([tokenIn, tokenOut]) => ({
    adapterId,
    target: pool,
    tokenIn,
    tokenOut,
    slotKind: "swap" as const,
    edgeKind: taxonomy.edgeKind,
    leavesStandingPosition: taxonomy.leavesStandingPosition,
    poolToken0: TOKEN0,
    poolToken1: TOKEN1,
    ...(familyId === "univ2-standard"
      ? { v2FeeBps: 30n }
      : {
          v3Fee: 3_000,
          v3TickSpacing: 60,
          factory: pool.toLowerCase() === V3_A.toLowerCase()
            ? UNIV3_FACTORY
            : PANCAKE_V3_FACTORY,
        }),
  }));
}

function hash(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

const selected = Object.freeze([
  selectedPool("univ2-standard", V2_A, 1),
  selectedPool("univ2-standard", V2_B, 2),
  selectedPool("univ3-standard", V3_A, 1),
  selectedPool("univ3-standard", V3_B, 2),
]);
const chain = new FakeChain();
const headers = Object.freeze([chain.header(100), chain.header(101)]);
const pass = await compareV2V3ShadowRange({
  chainId: 1,
  headers,
  selectedPools: selected,
  legacyProvider: new FakeLegacyProvider(chain) as unknown as ethers.JsonRpcProvider,
  coordinatorBackend: new FakeCoordinatorBackend(chain),
  universeContentSha256: deterministicHash("fake-production-universe"),
  universeRowCount: 5,
  poolsPerFamily: 2,
  candidateLimitPerFamily: 4,
  verifyHeader: async (expected) => chain.header(expected.number),
});
assert.equal(pass.status, "pass", pass.summary.failures.join("\n"));
assert.equal(v2V3ShadowParityExitCode(pass), 0);
assert.equal(pass.summary.changeCoverage, "changed-and-unchanged");
assert.deepEqual(
  pass.summary.changedStateKeys.map((key) => key.split("\u001f")[0]),
  ["univ2-standard", "univ3-standard"],
);
assert.deepEqual(
  pass.summary.unchangedStateKeys.map((key) => key.split("\u001f")[0]),
  ["univ2-standard", "univ3-standard"],
);
assert(
  pass.blocks[1].coordinator.freshness.some(
    (entry) => entry.kind === "carry-forward",
  ),
  JSON.stringify(pass.blocks[1].coordinator.freshness),
);
assert(
  pass.blocks[1].coordinator.freshness.some(
    (entry) => entry.kind === "direct-read",
  ),
);
const artifactDir = mkdtempSync(join(tmpdir(), "v2-v3-shadow-parity-"));
try {
  const firstPath = join(artifactDir, "first.json");
  const secondPath = join(artifactDir, "second.json");
  const firstSha = writeCanonicalShadowArtifact(firstPath, pass);
  const secondSha = writeCanonicalShadowArtifact(secondPath, pass);
  assert.equal(firstSha, secondSha);
  assert.equal(readFileSync(firstPath, "utf8"), readFileSync(secondPath, "utf8"));
  assert.equal(statSync(firstPath).mode & 0o777, 0o600);
} finally {
  rmSync(artifactDir, { recursive: true, force: true });
}

const universe: PoolUniverseEntry[] = [
  {
    address: V3_B,
    adapter: "univ3",
    score: 50,
    lastSwapBlock: 7,
  },
  {
    address: V2_B,
    adapter: "univ2",
    score: 40,
    lastSwapBlock: 8,
  },
  {
    address: V2_A,
    adapter: "univ2",
    score: 100,
    lastSwapBlock: 6,
  },
  {
    address: V3_A,
    adapter: "univ3",
    score: 60,
    lastSwapBlock: 9,
  },
  {
    address: "0x1000000000000000000000000000000000000005",
      adapter: "curve",
    score: 1_000,
    lastSwapBlock: 10,
  },
];
const candidates = selectV2V3UniverseCandidates(universe, 1);
assert.equal(candidates.get("univ2-standard")?.[0].pool.address, V2_A);
assert.equal(candidates.get("univ3-standard")?.[0].pool.address, V3_A);

const corruptChain = new FakeChain();
corruptChain.corruptCoordinatorV3 = true;
const fail = await compareV2V3ShadowRange({
  chainId: 1,
  headers: Object.freeze([
    corruptChain.header(100),
    corruptChain.header(101),
  ]),
  selectedPools: selected,
  legacyProvider:
    new FakeLegacyProvider(corruptChain) as unknown as ethers.JsonRpcProvider,
  coordinatorBackend: new FakeCoordinatorBackend(corruptChain),
  universeContentSha256: deterministicHash("fake-production-universe"),
  universeRowCount: 5,
  poolsPerFamily: 2,
  candidateLimitPerFamily: 4,
});
assert.equal(fail.status, "fail");
assert.equal(v2V3ShadowParityExitCode(fail), 1);
assert(
  fail.summary.failures.some((failure) =>
    failure.includes("normalized snapshots differ")
  ),
);

console.log(
  "v2-v3-shadow-parity-test: pass " +
    "(real legacy updater/reader vs coordinator, changed+unchanged, fail exit contract)",
);
