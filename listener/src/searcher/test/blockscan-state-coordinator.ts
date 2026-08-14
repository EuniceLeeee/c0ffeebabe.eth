import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import {
  BlockScanStateCoordinator,
  type BlockScanFamilyTelemetry,
  type BlockScanStateReadBackend,
  type CanonicalAddressTouchRange,
  type ProtocolAddressTouchShadowTelemetry,
} from "../blockscan-state-coordinator.js";
import type { CanonicalBlockActivity } from "../blockscan-state-read-backend.js";
import type { TokenEdge } from "../planner/token-graph.js";
import {
  assertPureSynchronousDeriveMids,
  blockScanEdgeKey,
  stateSchemaFingerprint,
  createMutationQueryDescriptor,
  createVerifiedGraphView,
  deterministicHash,
  registerBlockScanStateFamily,
  type BlockSource,
  type BlockScanPricingLane,
  type BlockScanStateCapability,
  type CanonicalMutationRange,
  type ChainLog,
  type CompileStateInstanceInput,
  type FamilySharedBinding,
  type MutationQueryDescriptor,
  type RegisteredBlockScanStateFamily,
  type StateRead,
  type StateReadResult,
} from "../venues/blockscan-state-capability.js";
import { univ2BlockScanState } from "../venues/swaps/univ2-standard.js";
import { univ4BlockScanState } from "../venues/swaps/univ4.js";
import { univ3BlockScanState } from "../venues/swaps/univ3-standard.js";
import { dodoV2BlockScanState } from "../venues/swaps/dodo-v2.js";
import { angstromSpotBlockScanState } from "../venues/swaps/angstrom-v4.js";
import type { RouteVenueMid } from "../venues/mid-readers.js";

const SOURCE_BLOCK = 25_585_380;
const SOURCE_HASH = `0x${"ab".repeat(32)}`;
const TOKEN_A = "0x0000000000000000000000000000000000000001";
const TOKEN_B = "0x0000000000000000000000000000000000000002";
const TOKEN_C = "0x0000000000000000000000000000000000000003";
const TOKEN_D = "0x0000000000000000000000000000000000000004";
const SWAP_POOL = "0x0000000000000000000000000000000000000011";
const SWAP_POOL_B = "0x0000000000000000000000000000000000000033";
const SWAP_POOL_C = "0x0000000000000000000000000000000000000044";
const PROTOCOL_POOL = "0x0000000000000000000000000000000000000022";
const SINGLETON_MANAGER = "0x0000000000000000000000000000000000000055";
const SINGLETON_POOL_ID_A = `0x${"aa".repeat(32)}`;
const SINGLETON_POOL_ID_B = `0x${"bb".repeat(32)}`;
const UNIV3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const ERC6909_TRANSFER_TOPIC =
  "0x1b3d7edb2e9c0b0e7c525b20aaaef0f5940d2ed71663c7d39266ecafac728859";
const UNIV4_DONATE_TOPIC =
  "0x29ef05caaff9404b7cb6d1c0e9bbae9eaa7ab2541feba1a9c4248594c08156cb";
const UNIV4_INITIALIZE_TOPIC =
  "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
const UNKNOWN_POOL_ID = `0x${"cc".repeat(32)}`;

interface FakeSnapshot {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const swapForward = edge("swap-action", SWAP_POOL, TOKEN_A, TOKEN_B);
const swapReverse = edge("swap-action", SWAP_POOL, TOKEN_B, TOKEN_A);
const swapBForward = edge("swap-action", SWAP_POOL_B, TOKEN_A, TOKEN_C);
const swapBReverse = edge("swap-action", SWAP_POOL_B, TOKEN_C, TOKEN_A);
const swapCForward = edge("swap-action", SWAP_POOL_C, TOKEN_A, TOKEN_D);
const swapCReverse = edge("swap-action", SWAP_POOL_C, TOKEN_D, TOKEN_A);
const protocol = edge("protocol-action", PROTOCOL_POOL, TOKEN_B, TOKEN_C, "protocol");

function edge(
  adapterId: string,
  target: string,
  tokenIn: string,
  tokenOut: string,
  slotKind: "swap" | "protocol" = "swap",
): TokenEdge {
  return {
    adapterId,
    target,
    tokenIn,
    tokenOut,
    slotKind,
    protocolAction: slotKind === "protocol" ? "convert" : undefined,
    edgeKind: slotKind === "protocol" ? "protocol" : "swap",
    leavesStandingPosition: false,
  };
}

function graph(
  generation: number,
  complete = true,
  edges: readonly TokenEdge[] = [swapForward, swapReverse, protocol],
) {
  return createVerifiedGraphView({
    id: `graph-${generation}`,
    generation,
    sourceBlock: SOURCE_BLOCK,
    sourceBlockHash: SOURCE_HASH,
    completenessWatermark: complete ? SOURCE_BLOCK : SOURCE_BLOCK - 1,
    perSourceCoverage: [{
      familyId: complete ? "fixture" : "protocol:fixture",
      sourceId: "active-pools",
      sourceFingerprint: "fixture-v1",
      completeThroughBlock: complete ? SOURCE_BLOCK : SOURCE_BLOCK - 1,
      completeThroughHash: SOURCE_HASH,
    }],
    edges,
  });
}

function mid(edgeValue: TokenEdge, value: number): RouteVenueMid {
  return {
    kind: edgeValue.slotKind === "swap" ? "v2" : "protocol",
    pool: edgeValue.target,
    edges: [edgeValue],
    mid: value,
    feeBps: 0,
    reserveA: 1_000n,
    reserveB: BigInt(Math.floor(1_000 * value)),
    depthProxy: 1_000,
  };
}

function fakeCapability(
  name: string,
  calls: { schema: number; reads: number; derives: number },
): BlockScanStateCapability<{ readonly name: string }, FakeSnapshot> {
  return {
    stateKey: (edgeValue) => edgeValue.target.toLowerCase(),
    compileStaticSchema: ({ signal }) => {
      assert.equal(signal.aborted, false);
      calls.schema++;
      return { name };
    },
    buildCurrentBlockReads: ({ sourceBlock, sourceBlockHash, edges }) => {
      calls.reads++;
      return [{
        id: "state",
        sourceBlock,
        sourceBlockHash,
        to: edges[0]?.target ?? (name === "swap" ? SWAP_POOL : PROTOCOL_POOL),
        data: "0x12345678",
        transport: "multicall-safe",
      }];
    },
    decodeState: (_schema, results) => {
      assert.equal(results.length, 1);
      assert.equal(results[0]?.ok, true);
      return { numerator: name === "swap" ? 2n : 3n, denominator: 1n };
    },
    deriveMids: (snapshot, edges) => {
      calls.derives++;
      return new Map(edges.map((edgeValue) => [
        blockScanEdgeKey(edgeValue),
        mid(edgeValue, Number(snapshot.numerator) / Number(snapshot.denominator)),
      ]));
    },
    dependencies: (edges) => edges.map((edgeValue) => edgeValue.target),
  };
}

function staticSchemaFixtureCapability(
  calls: { compiles: number },
): BlockScanStateCapability<{ readonly hydrated: boolean }, FakeSnapshot> {
  return {
    stateKey: (edgeValue) => edgeValue.target.toLowerCase(),
    compileStaticSchema() {
      calls.compiles++;
      return { hydrated: false };
    },
    buildStaticSchemaReads({ sourceBlock, sourceBlockHash }) {
      return [{
        id: "metadata",
        sourceBlock,
        sourceBlockHash,
        to: SWAP_POOL,
        data: "0x01",
        transport: "rpc-batch",
      }];
    },
    hydrateStaticSchema(_schema, results) {
      assert.equal(results.length, 1);
      assert.equal(results[0]?.ok, true);
      return { hydrated: true };
    },
    buildCurrentBlockReads({ sourceBlock, sourceBlockHash, schema }) {
      assert.equal(schema.hydrated, true);
      return [{
        id: "state",
        sourceBlock,
        sourceBlockHash,
        to: SWAP_POOL,
        data: "0x02",
        transport: "rpc-batch",
      }];
    },
    decodeState(_schema, results) {
      assert.equal(results.length, 1);
      assert.equal(results[0]?.ok, true);
      return { numerator: 2n, denominator: 1n };
    },
    deriveMids(snapshot, edges) {
      return new Map(edges.map((edgeValue) => [
        blockScanEdgeKey(edgeValue),
        mid(
          edgeValue,
          Number(snapshot.numerator) / Number(snapshot.denominator),
        ),
      ]));
    },
    dependencies: (edges) => edges.map((edgeValue) => edgeValue.target),
  };
}

function staticSchemaFixtureFamily(
  calls: { compiles: number },
): RegisteredBlockScanStateFamily {
  return registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: staticSchemaFixtureCapability(calls),
    ownsEdge: (edgeValue) => edgeValue.adapterId === "swap-action",
  });
}

function families() {
  const swapCalls = { schema: 0, reads: 0, derives: 0 };
  const protocolCalls = { schema: 0, reads: 0, derives: 0 };
  const list: RegisteredBlockScanStateFamily[] = [
    registerBlockScanStateFamily({
      familyId: "univ2-standard",
      lane: "swap",
      capability: fakeCapability("swap", swapCalls),
      ownsEdge: (edgeValue) => edgeValue.adapterId === "swap-action",
    }),
    registerBlockScanStateFamily({
      familyId: "protocol:fixture",
      lane: "protocol",
      capability: fakeCapability("protocol", protocolCalls),
      ownsEdge: (edgeValue) => edgeValue.adapterId === "protocol-action",
    }),
  ];
  return { list, swapCalls, protocolCalls };
}

const FIXTURE_MUTATION_TOPIC = `0x${"cd".repeat(32)}`;

function incrementalFakeCapability(options: {
  readonly buildTargets?: string[];
  readonly classifiedReadKey?: () => string;
} = {}): BlockScanStateCapability<
  { readonly name: string },
  FakeSnapshot
> {
  return {
    stateKey: (edgeValue) => edgeValue.target.toLowerCase(),
    compileStaticSchema: () => ({ name: "incremental-swap" }),
    buildCurrentBlockReads: ({ sourceBlock, sourceBlockHash, edges }) => {
      const target = edges[0]?.target ?? SWAP_POOL;
      options.buildTargets?.push(target.toLowerCase());
      return [{
        id: "state",
        sourceBlock,
        sourceBlockHash,
        to: target,
        data: "0x12345678",
        transport: "multicall-safe",
      }];
    },
    decodeState: (_schema, results) => {
      assert.equal(results.length, 1);
      assert.equal(results[0]?.ok, true);
      return { numerator: 2n, denominator: 1n };
    },
    deriveMids: (snapshot, edges) =>
      new Map(edges.map((edgeValue) => [
        blockScanEdgeKey(edgeValue),
        mid(
          edgeValue,
          Number(snapshot.numerator) / Number(snapshot.denominator),
        ),
      ])),
    dependencies: (edges) => edges.map((edgeValue) => edgeValue.target),
    incremental: {
      mutationQueryDescriptor: ({ edges }) =>
        createMutationQueryDescriptor({
          addresses: edges.map((edgeValue) => edgeValue.target),
          topics: [[FIXTURE_MUTATION_TOPIC]],
        }),
      classifyMutations: ({ range }) => {
        const changedReadKeysByStateKey = new Map<
          string,
          ReadonlySet<string>
        >();
        for (const event of range.events) {
          changedReadKeysByStateKey.set(
            event.address.toLowerCase(),
            new Set([options.classifiedReadKey?.() ?? "state"]),
          );
        }
        return Object.freeze({
          mutationRangeFingerprint: range.rangeFingerprint,
          classifierFingerprint: deterministicHash(
            "fixture-state-key-local-classifier-v1",
          ),
          changedReadKeysByStateKey,
        });
      },
    },
  };
}

function incrementalGraph(
  generation: number,
  edges: readonly TokenEdge[],
) {
  const sourceBlock = SOURCE_BLOCK + generation;
  const sourceBlockHash =
    `0x${generation.toString(16).padStart(64, "0")}`;
  return createVerifiedGraphView({
    id: `incremental-graph-${generation}`,
    generation,
    sourceBlock,
    sourceBlockHash,
    completenessWatermark: sourceBlock,
    perSourceCoverage: [{
      familyId: "univ2-standard",
      sourceId: "incremental-fixture",
      sourceFingerprint: "incremental-fixture-v1",
      completeThroughBlock: sourceBlock,
      completeThroughHash: sourceBlockHash,
    }],
    edges,
  });
}

class StateKeyIncrementalBackend implements BlockScanStateReadBackend {
  readonly readTargets: string[] = [];
  readonly rangeSources: BlockSource[] = [];
  readonly failTargets = new Set<string>();
  readonly stallTargets = new Set<string>();
  readonly mutationTargets = new Set<string>();
  rangeFailure = false;

  async readBatch(
    _lane: BlockScanPricingLane,
    reads: readonly StateRead[],
    control: {
      sourceGeneration: number;
      signal: AbortSignal;
    },
  ): Promise<readonly StateReadResult[]> {
    if (
      reads.some((read) => this.stallTargets.has(read.to.toLowerCase()))
    ) {
      await new Promise<void>((resolve) => {
        if (control.signal.aborted) resolve();
        else control.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    }
    return reads.map((read) => {
      const target = read.to.toLowerCase();
      this.readTargets.push(target);
      if (this.failTargets.has(target)) {
        return Object.freeze({
          id: read.id,
          ok: false as const,
          sourceBlock: read.sourceBlock,
          sourceBlockHash: read.sourceBlockHash,
          kind: "rpc" as const,
          error: "injected previous-state failure",
        });
      }
      return successfulRead(read, control.sourceGeneration);
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
    this.rangeSources.push(Object.freeze({ ...fromExclusive }));
    if (this.rangeFailure) {
      throw new Error("injected mutation range failure");
    }
    const events: readonly ChainLog[] = Object.freeze(
      [...this.mutationTargets]
        .sort()
        .map((address, logIndex) => Object.freeze({
          blockNumber: through.number,
          blockHash: through.hash,
          transactionIndex: 0,
          logIndex,
          address,
          topics: Object.freeze([FIXTURE_MUTATION_TOPIC]),
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

  async readCanonicalBlockActivity(
    fromExclusive: BlockSource,
    through: BlockSource,
    control?: {
      readonly maxRangeBlocks?: number;
    },
  ): Promise<CanonicalBlockActivity> {
    this.rangeSources.push(Object.freeze({ ...fromExclusive }));
    const distance = through.number - fromExclusive.number;
    const maxRangeBlocks = Math.max(1, control?.maxRangeBlocks ?? 8);
    if (distance <= 0 || distance > maxRangeBlocks) {
      throw new Error("injected activity range out of bounds");
    }
    if (this.rangeFailure) {
      throw new Error("injected mutation range failure");
    }
    const events: readonly ChainLog[] = Object.freeze(
      [...this.mutationTargets]
        .sort()
        .map((address, logIndex) => Object.freeze({
          blockNumber: through.number,
          blockHash: through.hash,
          transactionIndex: 0,
          logIndex,
          address,
          topics: Object.freeze([FIXTURE_MUTATION_TOPIC]),
          data: "0x",
          removed: false,
        })),
    );
    const canonicalBlocks = Object.freeze(
      Array.from({ length: distance + 1 }, (_, index) => {
        const number = fromExclusive.number + index;
        return Object.freeze({
          number,
          hash: number === fromExclusive.number
            ? fromExclusive.hash
            : number === through.number
            ? through.hash
            : `0x${(number - SOURCE_BLOCK).toString(16).padStart(64, "0")}`,
        });
      }),
    );
    return Object.freeze({
      fromExclusive,
      through,
      canonicalBlocks,
      events,
      touchedAddresses: Object.freeze([...this.mutationTargets]),
      transactionCount: this.mutationTargets.size,
      canonicalPathFingerprint: deterministicHash({
        fromExclusive,
        through,
      }),
      rangeFingerprint: deterministicHash({
        fromExclusive,
        through,
        events,
      }),
    });
  }
}

class SingletonActivityBackend extends StateKeyIncrementalBackend {
  event: Readonly<{
    readonly topics: readonly string[];
    readonly data: string;
  }> | null = null;

  override async readCanonicalBlockActivity(
    fromExclusive: BlockSource,
    through: BlockSource,
    control?: { readonly maxRangeBlocks?: number },
  ): Promise<CanonicalBlockActivity> {
    const base = await super.readCanonicalBlockActivity(
      fromExclusive,
      through,
      control,
    );
    const events: readonly ChainLog[] = this.event === null
      ? Object.freeze([])
      : Object.freeze([Object.freeze({
          blockNumber: through.number,
          blockHash: through.hash,
          transactionIndex: 0,
          logIndex: 0,
          address: SINGLETON_MANAGER,
          topics: Object.freeze([...this.event.topics]),
          data: this.event.data,
          removed: false,
        })]);
    return Object.freeze({
      ...base,
      events,
      touchedAddresses: this.event === null
        ? Object.freeze([])
        : Object.freeze([SINGLETON_MANAGER]),
      transactionCount: this.event === null ? 0 : 1,
      rangeFingerprint: deterministicHash({
        fromExclusive,
        through,
        events,
      }),
    });
  }
}

class AddressTouchShadowBackend implements BlockScanStateReadBackend {
  value = 3n;
  readBatchCount = 0;
  readonly touchedAddresses = new Set<string>();
  activityFailure = false;

  async readBatch(
    _lane: BlockScanPricingLane,
    reads: readonly StateRead[],
    control: { readonly sourceGeneration: number },
  ): Promise<readonly StateReadResult[]> {
    this.readBatchCount++;
    return reads.map((read) => Object.freeze({
      ...successfulRead(read, control.sourceGeneration),
      data: `0x${this.value.toString(16)}`,
    }));
  }

  async verifyCanonicalSource(): Promise<void> {
    return;
  }

  async readCanonicalAddressTouches(
    fromExclusive: BlockSource,
    through: BlockSource,
  ): Promise<CanonicalAddressTouchRange> {
    if (this.activityFailure) throw new Error("injected activity failure");
    const touchedAddresses = Object.freeze(
      [...this.touchedAddresses].map((value) => value.toLowerCase()).sort(),
    );
    return Object.freeze({
      fromExclusive,
      through,
      touchedAddresses,
      transactionCount: 1,
      complete: true,
      rangeFingerprint: deterministicHash({
        fromExclusive,
        through,
        touchedAddresses,
      }),
    });
  }

  async readCanonicalBlockActivity(
    fromExclusive: BlockSource,
    through: BlockSource,
  ): Promise<CanonicalBlockActivity> {
    if (this.activityFailure) throw new Error("injected activity failure");
    const touchedAddresses = Object.freeze(
      [...this.touchedAddresses].map((value) => value.toLowerCase()).sort(),
    );
    return Object.freeze({
      fromExclusive,
      through,
      events: Object.freeze([]),
      touchedAddresses,
      transactionCount: 1,
      canonicalPathFingerprint: deterministicHash({
        fromExclusive,
        through,
      }),
      rangeFingerprint: deterministicHash({
        fromExclusive,
        through,
        touchedAddresses,
      }),
    });
  }
}

class BarrierBackend implements BlockScanStateReadBackend {
  readonly laneCalls: BlockScanPricingLane[] = [];
  private releaseBarrier: (() => void) | null = null;
  private readonly barrier = new Promise<void>((resolve) => {
    this.releaseBarrier = resolve;
  });

  async readBatch(
    lane: BlockScanPricingLane,
    reads: readonly StateRead[],
    control: {
      sourceBlock: number;
      sourceBlockHash: string;
      sourceGeneration: number;
      signal: AbortSignal;
    },
  ): Promise<readonly StateReadResult[]> {
    assert.equal(control.sourceBlock, SOURCE_BLOCK);
    assert.equal(control.sourceBlockHash, SOURCE_HASH);
    assert.equal(control.signal.aborted, false);
    this.laneCalls.push(lane);
    if (this.laneCalls.length === 2) this.releaseBarrier?.();
    await this.barrier;
    return reads.map((read) => successfulRead(read, control.sourceGeneration));
  }

  async verifyCanonicalSource(): Promise<void> {
    return;
  }

  async readCanonicalBlockActivity(
    fromExclusive: BlockSource,
    through: BlockSource,
  ): Promise<CanonicalBlockActivity> {
    return Object.freeze({
      fromExclusive,
      through,
      events: Object.freeze([]),
      touchedAddresses: Object.freeze([]),
      transactionCount: 0,
      canonicalPathFingerprint: deterministicHash({
        fromExclusive,
        through,
      }),
      rangeFingerprint: deterministicHash({ fromExclusive, through }),
    });
  }
}

class ConcurrentProofBackend implements BlockScanStateReadBackend {
  readBatchCalls = 0;
  readBatchCallsWhileProofPending = 0;
  proofPending = false;
  blockNextActivity = false;
  private resolveProofStarted: (() => void) | null = null;
  readonly proofStarted = new Promise<void>((resolve) => {
    this.resolveProofStarted = resolve;
  });
  private releaseProof: (() => void) | null = null;
  private readonly proofRelease = new Promise<void>((resolve) => {
    this.releaseProof = resolve;
  });

  async readBatch(
    _lane: BlockScanPricingLane,
    reads: readonly StateRead[],
    control: { readonly sourceGeneration: number },
  ): Promise<readonly StateReadResult[]> {
    this.readBatchCalls++;
    if (this.proofPending) this.readBatchCallsWhileProofPending++;
    return reads.map((read) => successfulRead(read, control.sourceGeneration));
  }

  async readCanonicalMutationRange(
    descriptor: MutationQueryDescriptor,
    fromExclusive: BlockSource,
    through: BlockSource,
  ): Promise<CanonicalMutationRange> {
    this.proofPending = true;
    this.resolveProofStarted?.();
    await this.proofRelease;
    this.proofPending = false;
    const canonicalPathFingerprint = deterministicHash({
      fromExclusive,
      through,
    });
    return Object.freeze({
      fromExclusive,
      through,
      events: Object.freeze([]),
      complete: true,
      queryDescriptorFingerprint: descriptor.fingerprint,
      canonicalPathFingerprint,
      rangeFingerprint: deterministicHash({
        fromExclusive,
        through,
        queryDescriptorFingerprint: descriptor.fingerprint,
        canonicalPathFingerprint,
        events: [],
      }),
    });
  }

  async readCanonicalBlockActivity(
    fromExclusive: BlockSource,
    through: BlockSource,
  ): Promise<CanonicalBlockActivity> {
    if (this.blockNextActivity) {
      this.blockNextActivity = false;
      this.proofPending = true;
      this.resolveProofStarted?.();
      await this.proofRelease;
      this.proofPending = false;
    }
    return Object.freeze({
      fromExclusive,
      through,
      events: Object.freeze([]),
      touchedAddresses: Object.freeze([]),
      transactionCount: 0,
      canonicalPathFingerprint: deterministicHash({
        fromExclusive,
        through,
      }),
      rangeFingerprint: deterministicHash({ fromExclusive, through }),
    });
  }

  finishProof(): void {
    this.releaseProof?.();
  }

  async verifyCanonicalSource(): Promise<void> {
    return;
  }
}

async function phasedProofsSettleBeforeSiblingReads(): Promise<void> {
  const backend = new ConcurrentProofBackend();
  const coordinator = new BlockScanStateCoordinator(backend, {
    familyTimeoutMs: 25,
  });
  const swapFamily = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: incrementalFakeCapability(),
    ownsEdge: (edgeValue) => edgeValue.adapterId === "swap-action",
  });
  const protocolCalls = { schema: 0, reads: 0, derives: 0 };
  const protocolFamily = registerBlockScanStateFamily({
    familyId: "protocol:fixture",
    lane: "protocol",
    capability: fakeCapability("protocol", protocolCalls),
    ownsEdge: (edgeValue) => edgeValue.adapterId === "protocol-action",
  });
  const familyList = [swapFamily, protocolFamily];
  const edges = [swapForward, swapReverse, protocol];

  const bootstrap = await coordinator.prepare({
    graph: incrementalGraph(1, edges),
    families: familyList,
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "startup-bootstrap",
  });
  assert.equal(bootstrap.status, "complete");
  const bootstrapReadCalls = backend.readBatchCalls;
  backend.blockNextActivity = true;

  let settled = false;
  const next = coordinator.prepare({
    graph: incrementalGraph(2, edges),
    families: familyList,
    deadlineAtMs: Date.now() + 2_000,
  }).finally(() => {
    settled = true;
  });
  await backend.proofStarted;
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(
    backend.readBatchCalls,
    bootstrapReadCalls,
    "phased execution must not start sibling direct reads before every " +
      "canonical activity proof settles",
  );
  assert.equal(
    backend.readBatchCallsWhileProofPending,
    0,
    "no sibling read may run while the canonical activity proof is pending",
  );
  assert.equal(
    settled,
    false,
    "a pending canonical activity proof keeps the generation in flight",
  );

  backend.finishProof();
  const result = await next;
  assert.equal(backend.proofPending, false);
  assert.equal(result.status, "complete");
  assert(
    result.snapshot.resolvedFamilyIds.includes("protocol:fixture"),
    "the protocol family must resolve after the canonical activity proof settles",
  );
}

async function completeAndDeterministic(): Promise<void> {
  const backend = new BarrierBackend();
  const coordinator = new BlockScanStateCoordinator(backend);
  const registered = families();
  const view = graph(1);
  const result = await coordinator.prepare({
    graph: view,
    families: registered.list,
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(result.status, "complete");
  assert.deepEqual([...backend.laneCalls].sort(), ["protocol", "swap"]);
  assert.equal(registered.swapCalls.schema, 1, "schema compiles once per family");
  assert.equal(registered.swapCalls.reads, 1, "two directional edges dedupe to one state key");
  assert.equal(registered.swapCalls.derives, 1, "one snapshot derives both directions");
  assert.equal(result.coverage.expectedStateKeys.length, 2);
  assert.equal(result.coverage.resolvedStateKeys.length, 2);
  assert.equal(result.coverage.unresolvedStateKeys.length, 0);
  assert.equal(result.coverage.expectedEdgeKeys.length, 3);
  assert.equal(result.coverage.resolvedEdgeKeys.length, 3);
  assert.equal(result.coverage.expectedStateKeyHash, result.coverage.resolvedStateKeyHash);
  assert.equal(result.coverage.expectedEdgeKeyHash, result.coverage.resolvedEdgeKeyHash);
  assert.equal(result.snapshot.mids.size, 3);
  assert.deepEqual(
    result.familyTelemetry?.map(({
      wallMs: _wallMs,
      carryStateKeys: _carryStateKeys,
      directStateKeys: _directStateKeys,
      missingPreviousStateKeys: _missingPreviousStateKeys,
      fullFallbackReason: _fullFallbackReason,
      ...telemetry
    }) => telemetry),
    [
      {
        familyId: "protocol:fixture",
        lane: "protocol",
        uniqueStateKeys: 1,
        reads: 1,
        batches: 1,
        status: "complete",
        issueCount: 0,
      },
      {
        familyId: "univ2-standard",
        lane: "swap",
        uniqueStateKeys: 1,
        reads: 1,
        batches: 1,
        status: "complete",
        issueCount: 0,
      },
    ],
    "per-family telemetry is stable, sorted, and keeps lane aggregates separate",
  );
  assert.equal(
    result.snapshot.familyTelemetry,
    result.familyTelemetry,
    "the result and published snapshot share the same frozen family evidence",
  );
  assert(
    result.familyTelemetry?.every((family) =>
      family.wallMs >= 0 && Object.isFrozen(family)
    ),
  );
  for (const lane of result.laneTelemetry) {
    const familyRows: readonly BlockScanFamilyTelemetry[] =
      (result.familyTelemetry ?? []).filter(
        (family) => family.lane === lane.lane,
      );
    assert.equal(
      lane.uniqueStateKeys,
      familyRows.reduce((sum, family) => sum + family.uniqueStateKeys, 0),
    );
    assert.equal(
      lane.reads,
      familyRows.reduce((sum, family) => sum + family.reads, 0),
    );
    assert.equal(
      lane.batches,
      familyRows.reduce((sum, family) => sum + family.batches, 0),
    );
  }
  assert.equal(coordinator.latestSnapshot(), result.snapshot);
  assert(Object.isFrozen(view));
  assert(Object.isFrozen(view.edges));
  assert(Object.isFrozen(view.edges[0]));
  assert.throws(
    () => (view.edges as TokenEdge[]).push(swapForward),
    TypeError,
    "verified graph edge array is immutable",
  );

  const second = createVerifiedGraphView({
    id: "same-input",
    generation: 1,
    sourceBlock: SOURCE_BLOCK,
    sourceBlockHash: SOURCE_HASH.toUpperCase().replace("0X", "0x"),
    completenessWatermark: SOURCE_BLOCK,
    perSourceCoverage: [{
      familyId: "fixture",
      sourceId: "active-pools",
      sourceFingerprint: "fixture-v1",
      completeThroughBlock: SOURCE_BLOCK,
      completeThroughHash: SOURCE_HASH,
    }],
    edges: [swapForward, swapReverse, protocol],
  });
  assert.equal(view.orderedEdgeHash, second.orderedEdgeHash);
  assert.equal(view.metadataHash, second.metadataHash);
  assert.equal(view.ownershipHash, second.ownershipHash);
}

async function simulationSemanticsParticipateInDedupIdentity(): Promise<void> {
  let physicalReads = 0;
  const capability: BlockScanStateCapability<null, FakeSnapshot> = {
    stateKey: (edgeValue) => edgeValue.target.toLowerCase(),
    compileStaticSchema: () => null,
    buildCurrentBlockReads({ sourceBlock, sourceBlockHash, edges }) {
      const target = edges[0]?.target ?? PROTOCOL_POOL;
      return ["01", "02"].map((suffix, index) => ({
        id: `simulation-${index}`,
        sourceBlock,
        sourceBlockHash,
        to: target,
        from: TOKEN_D,
        data: "0x12345678",
        transport: "eth-simulate-v1" as const,
        simulation: {
          calls: [{ from: TOKEN_D, to: target, data: "0x12345678" }],
          stateOverrides: {
            [target]: {
              stateDiff: {
                [`0x${"00".repeat(31)}${suffix}`]:
                  `0x${"00".repeat(31)}${suffix}`,
              },
            },
          },
          traceTransfers: false,
        },
      }));
    },
    decodeState(_schema, results) {
      assert.equal(results.length, 2);
      return { numerator: 1n, denominator: 1n };
    },
    deriveMids(snapshot, edges) {
      return new Map(edges.map((edgeValue) => [
        blockScanEdgeKey(edgeValue),
        mid(
          edgeValue,
          Number(snapshot.numerator) / Number(snapshot.denominator),
        ),
      ]));
    },
    dependencies: (edges) => edges.map((edgeValue) => edgeValue.target),
  };
  const family = registerBlockScanStateFamily({
    familyId: "protocol:simulation-dedup",
    lane: "protocol",
    capability,
    ownsEdge: (edgeValue) => edgeValue.adapterId === "protocol-action",
  });
  const backend: BlockScanStateReadBackend = {
    async readBatch(_lane, reads, control) {
      physicalReads += reads.length;
      return reads.map((read) =>
        successfulRead(read, control.sourceGeneration)
      );
    },
    async verifyCanonicalSource() {
      return;
    },
  };
  const result = await new BlockScanStateCoordinator(backend).prepare({
    graph: graph(1, true, [protocol]),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(result.status, "complete");
  assert.equal(
    physicalReads,
    2,
    "different state overrides must not collapse into one physical read",
  );
}

async function replayResetDropsOnlyDynamicPublication(): Promise<void> {
  const registered = families();
  const backend: BlockScanStateReadBackend = {
    async readBatch(_lane, reads, control) {
      return reads.map((read) => successfulRead(read, control.sourceGeneration));
    },
    async verifyCanonicalSource() {},
  };
  const coordinator = new BlockScanStateCoordinator(backend);
  const input = {
    graph: graph(7),
    families: registered.list,
    deadlineAtMs: Date.now() + 2_000,
  };
  const first = await coordinator.prepare(input);
  assert.equal(first.status, "complete");
  assert.equal(registered.swapCalls.schema, 1);
  assert.equal(registered.protocolCalls.schema, 1);

  coordinator.resetDynamicStateForReplay();
  assert.equal(coordinator.latestSnapshot(), null);

  const repeated = await coordinator.prepare({
    ...input,
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(repeated.status, "complete");
  assert.equal(
    registered.swapCalls.schema,
    1,
    "replay reset retains graph-bound static schema",
  );
  assert.equal(
    registered.protocolCalls.schema,
    1,
    "replay reset retains protocol static schema",
  );
  assert.equal(registered.swapCalls.reads, 2, "source state is re-read");
  assert.equal(registered.protocolCalls.reads, 2, "protocol state is re-read");
}

async function failedFamilyPublishesHealthyFamiliesAsDegraded(): Promise<void> {
  const registered = families();
  const backend: BlockScanStateReadBackend = {
    async readBatch(lane, reads, control) {
      if (lane === "protocol") return [];
      return reads.map((read) => successfulRead(read, control.sourceGeneration));
    },
    async verifyCanonicalSource() {},
  };
  const coordinator = new BlockScanStateCoordinator(backend);
  const result = await coordinator.prepare({
    graph: graph(1),
    families: registered.list,
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(result.status, "degraded");
  if (result.status !== "degraded") throw new Error("expected degraded state");
  assert.equal(
    result.snapshot.mids.size,
    2,
    "healthy swap family remains published",
  );
  assert.deepEqual(result.snapshot.resolvedFamilyIds, ["univ2-standard"]);
  assert.deepEqual(result.snapshot.incompleteFamilyIds, ["protocol:fixture"]);
  assert.equal(result.coverage.resolvedStateKeys.length, 1);
  assert.equal(result.coverage.unresolvedStateKeys.length, 1);
  assert.equal(result.coverage.resolvedEdgeKeys.length, 2);
  assert.equal(result.coverage.unresolvedEdgeKeys.length, 1);
  assert.deepEqual(
    result.familyTelemetry?.map(({
      wallMs: _wallMs,
      carryStateKeys: _carryStateKeys,
      directStateKeys: _directStateKeys,
      missingPreviousStateKeys: _missingPreviousStateKeys,
      fullFallbackReason: _fullFallbackReason,
      ...telemetry
    }) => telemetry),
    [
      {
        familyId: "protocol:fixture",
        lane: "protocol",
        uniqueStateKeys: 1,
        reads: 1,
        batches: 1,
        status: "incomplete",
        issueCount: 1,
      },
      {
        familyId: "univ2-standard",
        lane: "swap",
        uniqueStateKeys: 1,
        reads: 1,
        batches: 1,
        status: "complete",
        issueCount: 0,
      },
    ],
  );
  assert.equal(coordinator.latestSnapshot(), result.snapshot);

  const sourcePinnedBackend: BlockScanStateReadBackend = {
    async readBatch(_lane, reads, control) {
      return reads.map((read) =>
        successfulRead(read, control.sourceGeneration)
      );
    },
    async verifyCanonicalSource() {},
  };
  const graphIncomplete = await new BlockScanStateCoordinator(
    sourcePinnedBackend,
  ).prepare({
    graph: graph(2, false),
    families: families().list,
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(graphIncomplete.status, "degraded");
  if (graphIncomplete.status !== "degraded") {
    throw new Error("expected family-local graph degradation");
  }
  assert.deepEqual(
    graphIncomplete.snapshot.resolvedFamilyIds,
    ["protocol:fixture", "univ2-standard"],
    "source-N re-attested protocol edges remain usable without topology completeness",
  );
  assert.deepEqual(
    graphIncomplete.snapshot.incompleteFamilyIds,
    [],
    "negative topology incompleteness must not erase a positively proven protocol edge",
  );
  assert.equal(
    graphIncomplete.snapshot.mids.size,
    3,
    "the proven protocol edge must still publish its current-block mid",
  );
  assert.equal(
    graphIncomplete.snapshot.graph.completenessWatermark,
    SOURCE_BLOCK - 1,
    "using a proven edge must not manufacture global topology completeness",
  );
  assert.deepEqual(
    graphIncomplete.familyTelemetry?.map(
      ({
        wallMs: _wallMs,
        carryStateKeys: _carryStateKeys,
        directStateKeys: _directStateKeys,
        missingPreviousStateKeys: _missingPreviousStateKeys,
        fullFallbackReason: _fullFallbackReason,
        ...telemetry
      }) => telemetry,
    ),
    [
      {
        familyId: "protocol:fixture",
        lane: "protocol",
        uniqueStateKeys: 1,
        reads: 1,
        batches: 1,
        status: "degraded",
        issueCount: 1,
      },
      {
        familyId: "univ2-standard",
        lane: "swap",
        uniqueStateKeys: 1,
        reads: 1,
        batches: 1,
        status: "complete",
        issueCount: 0,
      },
    ],
    "topology incompleteness stays visible while the proven protocol lane runs",
  );
  assert(
    graphIncomplete.issues.some((issue) =>
      issue.kind === "graph-incomplete" &&
      issue.familyId === "protocol:fixture" &&
      issue.sourceId === "active-pools"
    ),
    "graph degradation must retain its exact family/source owner",
  );
}

async function oneFailedStateKeyPreservesHealthySiblingInstance(): Promise<void> {
  const registered = families();
  const backend: BlockScanStateReadBackend = {
    async readBatch(_lane, reads, control) {
      return reads.map((read): StateReadResult =>
        read.id.includes(SWAP_POOL_B.toLowerCase())
          ? Object.freeze({
              id: read.id,
              ok: false as const,
              sourceBlock: read.sourceBlock,
              sourceBlockHash: read.sourceBlockHash,
              kind: "rpc" as const,
              error: "injected sibling state failure",
            })
          : successfulRead(read, control.sourceGeneration)
      );
    },
    async verifyCanonicalSource() {},
  };
  const result = await new BlockScanStateCoordinator(backend).prepare({
    graph: graph(1, true, [
      swapForward,
      swapReverse,
      swapBForward,
      swapBReverse,
      protocol,
    ]),
    families: registered.list,
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(result.status, "degraded");
  if (result.status !== "degraded") throw new Error("expected degraded state");
  assert.deepEqual(
    result.snapshot.resolvedFamilyIds,
    ["protocol:fixture"],
    "a family remains degraded until all of its stateKeys are terminal",
  );
  assert.deepEqual(result.snapshot.incompleteFamilyIds, ["univ2-standard"]);
  assert.equal(result.coverage.expectedStateKeys.length, 3);
  assert.equal(result.coverage.resolvedStateKeys.length, 2);
  assert.equal(result.coverage.unresolvedStateKeys.length, 1);
  assert.equal(result.coverage.expectedReadKeys.length, 3);
  assert.equal(result.coverage.resolvedReadKeys.length, 2);
  assert.equal(result.coverage.unresolvedReadKeys.length, 1);
  assert.equal(result.coverage.expectedEdgeKeys.length, 5);
  assert.equal(result.coverage.resolvedEdgeKeys.length, 3);
  assert.equal(result.coverage.unresolvedEdgeKeys.length, 2);
  assert.deepEqual(
    result.familyTelemetry?.map(({
      wallMs: _wallMs,
      carryStateKeys: _carryStateKeys,
      directStateKeys: _directStateKeys,
      missingPreviousStateKeys: _missingPreviousStateKeys,
      fullFallbackReason: _fullFallbackReason,
      ...telemetry
    }) => telemetry),
    [
      {
        familyId: "protocol:fixture",
        lane: "protocol",
        uniqueStateKeys: 1,
        reads: 1,
        batches: 1,
        status: "complete",
        issueCount: 0,
      },
      {
        familyId: "univ2-standard",
        lane: "swap",
        uniqueStateKeys: 2,
        reads: 2,
        batches: 1,
        status: "degraded",
        issueCount: 1,
      },
    ],
    "a failed instance degrades only its family and retains exact work counts",
  );
  assert.equal(
    result.snapshot.mids.size,
    3,
    "healthy stateKeys publish even while a sibling instance is unresolved",
  );
  assert.deepEqual(
    [...result.snapshot.mids.values()]
      .map((value) => value.pool.toLowerCase())
      .sort(),
    [
      PROTOCOL_POOL.toLowerCase(),
      SWAP_POOL.toLowerCase(),
      SWAP_POOL.toLowerCase(),
    ].sort(),
  );
  assert(
    [...result.snapshot.mids.values()].every(
      (value) => value.pool.toLowerCase() !== SWAP_POOL_B.toLowerCase(),
    ),
    "the failed stateKey may not publish a mid",
  );
  assert(
    result.coverage.unresolvedEdgeKeys.every((edgeKey) =>
      edgeKey.includes(SWAP_POOL_B.toLowerCase())
    ),
    "only the failed instance's two directed edges stay unresolved",
  );
  assert(
    result.issues.some((issue) =>
      issue.familyId === "univ2-standard" &&
      issue.stateKey?.includes(SWAP_POOL_B.toLowerCase()) &&
      issue.message.includes("injected sibling state failure")
    ),
  );
}

async function graphIncompleteSwapFamilyPreservesHealthySibling(): Promise<void> {
  const readTargets: string[] = [];
  const backend: BlockScanStateReadBackend = {
    async readBatch(_lane, reads, control) {
      readTargets.push(...reads.map((read) => read.to.toLowerCase()));
      return reads.map((read) =>
        successfulRead(read, control.sourceGeneration)
      );
    },
    async verifyCanonicalSource() {},
  };
  const incompleteSwapGraph = createVerifiedGraphView({
    id: "graph-incomplete-swap-family",
    generation: 1,
    sourceBlock: SOURCE_BLOCK,
    sourceBlockHash: SOURCE_HASH,
    completenessWatermark: SOURCE_BLOCK - 1,
    perSourceCoverage: [{
      familyId: "univ2-standard",
      sourceId: "landed-event:fixture",
      sourceFingerprint: "fixture-swap-retry-v1",
      completeThroughBlock: SOURCE_BLOCK - 1,
      completeThroughHash: SOURCE_HASH,
    }],
    edges: [swapForward, swapReverse, protocol],
  });
  const result = await new BlockScanStateCoordinator(backend).prepare({
    graph: incompleteSwapGraph,
    families: families().list,
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "startup-bootstrap",
  });
  assert.equal(result.status, "degraded");
  if (result.status !== "degraded") {
    throw new Error("expected family-local swap graph degradation");
  }
  assert.deepEqual(result.snapshot.resolvedFamilyIds, ["protocol:fixture"]);
  assert.deepEqual(result.snapshot.incompleteFamilyIds, ["univ2-standard"]);
  assert.equal(result.snapshot.mids.size, 3);
  assert(
    readTargets.includes(SWAP_POOL.toLowerCase()) &&
      readTargets.includes(PROTOCOL_POOL.toLowerCase()),
    "startup bootstrap may establish admitted swap state while retaining degraded topology",
  );
  assert(
    result.issues.some((issue) =>
      issue.kind === "graph-incomplete" &&
      issue.familyId === "univ2-standard"
    ),
    "bootstrap must retain the topology coverage gap",
  );

  readTargets.length = 0;
  const withoutBootstrap = await new BlockScanStateCoordinator(backend).prepare({
    graph: incompleteSwapGraph,
    families: families().list,
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "proof-scoped",
  });
  assert.equal(withoutBootstrap.status, "degraded");
  if (withoutBootstrap.status !== "degraded") {
    throw new Error("expected first steady generation to fail closed");
  }
  assert.equal(
    withoutBootstrap.snapshot.mids.size,
    3,
    "steady generations price the lagging swap family through the same " +
      "event-driven incremental path (carry unchanged pools, read only the " +
      "pools the previous block traded); topology completeness is labeling, " +
      "not a pricing gate",
  );
  assert.deepEqual(
    readTargets,
    [SWAP_POOL.toLowerCase(), PROTOCOL_POOL.toLowerCase()].sort(),
    "lagging topology must not prevent pricing pools the graph owns",
  );
}

async function graphSourceHashMismatchBlocksOwningFamily(): Promise<void> {
  const readTargets: string[] = [];
  const backend: BlockScanStateReadBackend = {
    async readBatch(_lane, reads, control) {
      readTargets.push(...reads.map((read) => read.to.toLowerCase()));
      return reads.map((read) =>
        successfulRead(read, control.sourceGeneration)
      );
    },
    async verifyCanonicalSource() {},
  };
  const hashMismatchGraph = createVerifiedGraphView({
    id: "graph-source-hash-mismatch",
    generation: 1,
    sourceBlock: SOURCE_BLOCK,
    sourceBlockHash: SOURCE_HASH,
    completenessWatermark: SOURCE_BLOCK,
    perSourceCoverage: [{
      familyId: "univ2-standard",
      sourceId: "landed-event:fixture",
      sourceFingerprint: "fixture-swap-wrong-fork-v1",
      completeThroughBlock: SOURCE_BLOCK,
      completeThroughHash: `0x${"cd".repeat(32)}`,
    }],
    edges: [swapForward, swapReverse, protocol],
  });
  const result = await new BlockScanStateCoordinator(backend).prepare({
    graph: hashMismatchGraph,
    families: families().list,
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "startup-bootstrap",
  });
  assert.equal(result.status, "degraded");
  if (result.status !== "degraded") {
    throw new Error("expected source-hash mismatch degradation");
  }
  assert.deepEqual(result.snapshot.resolvedFamilyIds, ["protocol:fixture"]);
  assert.deepEqual(result.snapshot.incompleteFamilyIds, ["univ2-standard"]);
  assert.equal(result.snapshot.mids.size, 1);
  assert(
    readTargets.every((target) => target === PROTOCOL_POOL.toLowerCase()),
    "same-height source hash mismatch must remain blocked during bootstrap",
  );

  readTargets.length = 0;
  const unknownHashGraph = createVerifiedGraphView({
    id: "graph-source-hash-unknown",
    generation: 1,
    sourceBlock: SOURCE_BLOCK,
    sourceBlockHash: SOURCE_HASH,
    completenessWatermark: SOURCE_BLOCK,
    perSourceCoverage: [{
      familyId: "univ2-standard",
      sourceId: "landed-event:fixture",
      sourceFingerprint: "fixture-swap-unproven-hash-v1",
      completeThroughBlock: SOURCE_BLOCK,
      completeThroughHash: `0x${"00".repeat(32)}`,
    }],
    edges: [swapForward, swapReverse, protocol],
  });
  const unknownHash = await new BlockScanStateCoordinator(backend).prepare({
    graph: unknownHashGraph,
    families: families().list,
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "startup-bootstrap",
  });
  assert.notEqual(unknownHash.status, "incomplete");
  assert(
    readTargets.includes(SWAP_POOL.toLowerCase()),
    "zeroHash means no hash proof; it must not masquerade as a proven " +
      "same-height fork mismatch and block the owning family",
  );
}

async function laggingSwapProofFailureDoesNotFallbackWholeFamily(): Promise<void> {
  const backend = new StateKeyIncrementalBackend();
  const coordinator = new BlockScanStateCoordinator(backend);
  const swapFamily = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: incrementalFakeCapability(),
    ownsEdge: (edgeValue) => edgeValue.adapterId === "swap-action",
  });
  const protocolCalls = { schema: 0, reads: 0, derives: 0 };
  const protocolFamily = registerBlockScanStateFamily({
    familyId: "protocol:fixture",
    lane: "protocol",
    capability: fakeCapability("protocol", protocolCalls),
    ownsEdge: (edgeValue) => edgeValue.adapterId === "protocol-action",
  });
  const laggingGraph = (
    generation: number,
    edges: readonly TokenEdge[] = [
      swapForward,
      swapReverse,
      swapBForward,
      swapBReverse,
      protocol,
    ],
  ) => {
    const sourceBlock = SOURCE_BLOCK + generation;
    const sourceBlockHash =
      `0x${generation.toString(16).padStart(64, "0")}`;
    return createVerifiedGraphView({
      id: `proof-scoped-lagging-${generation}`,
      generation,
      sourceBlock,
      sourceBlockHash,
      completenessWatermark: sourceBlock - 1,
      perSourceCoverage: [
        {
          familyId: "univ2-standard",
          sourceId: "landed-event:fixture",
          sourceFingerprint: "fixture-swap-lagging-v1",
          completeThroughBlock: sourceBlock - 1,
          completeThroughHash: sourceBlockHash,
        },
        {
          familyId: "protocol:fixture",
          sourceId: "protocol-observed:fixture",
          sourceFingerprint: "fixture-protocol-current-v1",
          completeThroughBlock: sourceBlock,
          completeThroughHash: sourceBlockHash,
        },
      ],
      edges,
    });
  };

  backend.failTargets.add(SWAP_POOL_B.toLowerCase());
  const bootstrap = await coordinator.prepare({
    graph: laggingGraph(1),
    families: [swapFamily, protocolFamily],
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "startup-bootstrap",
  });
  assert.equal(bootstrap.status, "degraded");
  if (bootstrap.status !== "degraded") {
    throw new Error("expected degraded startup bootstrap");
  }
  assert.equal(bootstrap.snapshot.stateByStateKey.size, 2);
  assert(
    bootstrap.coverage.unresolvedStateKeys.some((stateKey) =>
      stateKey.includes(SWAP_POOL_B.toLowerCase())
    ),
    "startup must record an admitted key whose dynamic read failed",
  );

  backend.failTargets.clear();
  backend.readTargets.length = 0;
  backend.rangeFailure = true;
  const steady = await coordinator.prepare({
    graph: laggingGraph(2),
    families: [swapFamily, protocolFamily],
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "proof-scoped",
  });
  assert.equal(steady.status, "degraded");
  if (steady.status !== "degraded") {
    throw new Error("expected proof-scoped degradation");
  }
  assert.deepEqual(
    [...backend.readTargets].sort(),
    [SWAP_POOL, SWAP_POOL_B, PROTOCOL_POOL]
      .map((value) => value.toLowerCase())
      .sort(),
    "a failed mutation range must not drop the family: every pool the graph " +
      "owns is priced by a source-pinned direct read at current N (backrun- " +
      "style whole-graph update pipe); the mutation proof only makes the " +
      "carry path cheaper when it succeeds",
  );
  assert.equal(steady.snapshot.mids.size, 5);
  assert(
    [...steady.snapshot.mids.values()].every((value) =>
      [SWAP_POOL, SWAP_POOL_B, PROTOCOL_POOL]
        .map((pool) => pool.toLowerCase())
        .includes(value.pool.toLowerCase())
    ),
    "every admitted graph pool must publish a mid after a whole-family " +
      "direct-read fallback",
  );
  const swapTelemetry = steady.familyTelemetry?.find(
    (entry) => entry.familyId === "univ2-standard",
  );
  assert.equal(
    swapTelemetry?.directStateKeys,
    2,
    "a failed mutation range direct-reads every owned pool instead of " +
      "dropping the unproven sibling",
  );
  assert.equal(
    swapTelemetry?.recoveryRequiredStateKeys ?? 0,
    0,
    "a successful current-block read must clear the missing-base backlog",
  );
  assert(
    !steady.coverage.unresolvedStateKeys.some((stateKey) =>
      stateKey.includes(SWAP_POOL.toLowerCase())
    ),
    "a successful source-pinned direct read resolves the pool; only the " +
      "topology coverage gap stays degraded",
  );

  backend.rangeFailure = false;
  backend.readTargets.length = 0;
  const missingBaseResumed = await coordinator.prepare({
    graph: laggingGraph(3),
    families: [swapFamily, protocolFamily],
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "proof-scoped",
  });
  assert.equal(missingBaseResumed.status, "degraded");
  assert.equal(
    missingBaseResumed.familyTelemetry?.find(
      (entry) => entry.familyId === "univ2-standard",
    )?.recoveryRequiredStateKeys ?? 0,
    0,
  );
  assert.deepEqual(
    backend.readTargets,
    [],
    "the pass after missing-base recovery must resume proof-based carry " +
      "(both lanes carry through the unified activity plan)",
  );
  const recoveredBaseState = missingBaseResumed.snapshot.stateByStateKey.get(
    `univ2-standard\u001f${SWAP_POOL_B.toLowerCase()}`,
  );
  assert(
    [...(recoveredBaseState?.freshnessByReadKey.values() ?? [])].some(
      (proof) =>
        proof.kind === "carry-forward" &&
        proof.previousSource.number === SOURCE_BLOCK + 2,
    ),
    "the resumed proof must carry from the family-local recovery source",
  );

  backend.rangeFailure = true;
  backend.readTargets.length = 0;
  const withNewKey = await coordinator.prepare({
    graph: laggingGraph(5, [
      swapForward,
      swapReverse,
      swapCForward,
      swapCReverse,
      protocol,
    ]),
    families: [swapFamily, protocolFamily],
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "proof-scoped",
  });
  assert.equal(withNewKey.status, "degraded");
  if (withNewKey.status !== "degraded") {
    throw new Error("expected new-key proof-scoped degradation");
  }
  assert.deepEqual(
    [...backend.readTargets].sort(),
    [SWAP_POOL, SWAP_POOL_C, PROTOCOL_POOL]
      .map((value) => value.toLowerCase())
      .sort(),
    "a failed mutation range direct-reads every owned pool including the " +
      "newly admitted key; nothing stays unresolved behind a topology gap",
  );
  assert.equal(
    withNewKey.familyTelemetry?.find(
      (entry) => entry.familyId === "univ2-standard",
    )?.directStateKeys,
    2,
  );

  backend.rangeFailure = false;
  backend.mutationTargets.add(SWAP_POOL.toLowerCase());
  backend.readTargets.length = 0;
  const withChangedKey = await coordinator.prepare({
    graph: laggingGraph(6, [
      swapForward,
      swapReverse,
      swapCForward,
      swapCReverse,
      protocol,
    ]),
    families: [swapFamily, protocolFamily],
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "proof-scoped",
  });
  assert.equal(withChangedKey.status, "degraded");
  if (withChangedKey.status !== "degraded") {
    throw new Error("expected changed-key proof-scoped degradation");
  }
  assert.deepEqual(
    [...backend.readTargets].sort(),
    [SWAP_POOL].map((value) => value.toLowerCase()).sort(),
    "a touched activity identity reads current N without rereading an " +
      "unchanged sibling (protocol carries through the unified activity plan)",
  );
  assert.equal(
    withChangedKey.familyTelemetry?.find(
      (entry) => entry.familyId === "univ2-standard",
    )?.directStateKeys,
    1,
  );

  backend.mutationTargets.clear();
  backend.readTargets.length = 0;
  backend.rangeSources.length = 0;
  backend.failTargets.add(SWAP_POOL_C.toLowerCase());
  const partialRecovery = await coordinator.prepare({
    graph: laggingGraph(40, [
      swapForward,
      swapReverse,
      swapCForward,
      swapCReverse,
      protocol,
    ]),
    families: [swapFamily, protocolFamily],
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "proof-scoped",
  });
  assert.equal(partialRecovery.status, "degraded");
  if (partialRecovery.status !== "degraded") {
    throw new Error("expected partial recovery bootstrap");
  }
  assert(
    partialRecovery.coverage.unresolvedStateKeys.some((stateKey) =>
      stateKey.includes(SWAP_POOL_C.toLowerCase())
    ),
    "a failed recovery key must not publish its old value",
  );

  backend.failTargets.clear();
  backend.readTargets.length = 0;
  const recovery = await coordinator.prepare({
    graph: laggingGraph(41, [
      swapForward,
      swapReverse,
      swapCForward,
      swapCReverse,
      protocol,
    ]),
    families: [swapFamily, protocolFamily],
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "proof-scoped",
  });
  assert.equal(recovery.status, "degraded");
  if (recovery.status !== "degraded") {
    throw new Error("expected topology-degraded recovery bootstrap");
  }
  const recoveredSwap = recovery.familyTelemetry?.find(
    (entry) => entry.familyId === "univ2-standard",
  );
  assert.equal(recoveredSwap?.recoveryRequiredStateKeys ?? 0, 0);
  assert.deepEqual(
    [...backend.readTargets].sort(),
    [SWAP_POOL_C].map((value) => value.toLowerCase()).sort(),
    "recovery must direct-read only the key that remains outside the proof " +
      "window (protocol carries through the unified activity plan)",
  );
  for (const pool of [SWAP_POOL, SWAP_POOL_C]) {
    const stateKey = `univ2-standard\u001f${pool.toLowerCase()}`;
    const state = recovery.snapshot.stateByStateKey.get(stateKey);
    assert.equal(state?.source.number, SOURCE_BLOCK + 41);
    assert.equal(state?.source.hash, `0x${"29".padStart(64, "0")}`);
    const directRecovery = pool === SWAP_POOL_C;
    assert.equal(
      state?.refreshMode,
      directRecovery ? "unproven-direct" : "carry-forward",
    );
    assert(
      [...(state?.freshnessByReadKey.values() ?? [])].every(
        (proof) =>
          proof.kind ===
            (directRecovery ? "direct-read" : "carry-forward"),
      ),
      "each recovered state must have current-block direct or canonical carry proof",
    );
  }

  backend.readTargets.length = 0;
  backend.rangeSources.length = 0;
  const resumed = await coordinator.prepare({
    graph: laggingGraph(42, [
      swapForward,
      swapReverse,
      swapCForward,
      swapCReverse,
      protocol,
    ]),
    families: [swapFamily, protocolFamily],
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "proof-scoped",
  });
  assert.equal(resumed.status, "degraded");
  assert.equal(
    resumed.familyTelemetry?.find(
      (entry) => entry.familyId === "univ2-standard",
    )?.recoveryRequiredStateKeys ?? 0,
    0,
  );
  assert.deepEqual(
    backend.readTargets,
    [],
    "the pass after recovery must resume activity-proof carry for both lanes",
  );
  assert(
    backend.rangeSources.some((source) => source.number === SOURCE_BLOCK + 41),
    "the next proof must start from the recovered canonical source",
  );
}

async function hotRecoveryIsBoundedPerFamily(): Promise<void> {
  const backend = new StateKeyIncrementalBackend();
  const coordinator = new BlockScanStateCoordinator(backend);
  const family = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: incrementalFakeCapability(),
    ownsEdge: (edgeValue) => edgeValue.adapterId === "swap-action",
  });
  const pools = Array.from({ length: 18 }, (_, index) =>
    `0x${(0x100 + index).toString(16).padStart(40, "0")}`
  );
  const laggingGraph = (
    generation: number,
    selectedPools: readonly string[] = pools,
  ) => {
    const sourceBlock = SOURCE_BLOCK + generation;
    const sourceBlockHash =
      `0x${generation.toString(16).padStart(64, "0")}`;
    return createVerifiedGraphView({
      id: `bounded-recovery-${generation}`,
      generation,
      sourceBlock,
      sourceBlockHash,
      completenessWatermark: sourceBlock - 1,
      perSourceCoverage: [{
        familyId: "univ2-standard",
        sourceId: "landed-event:fixture",
        sourceFingerprint: "fixture-bounded-recovery-v1",
        completeThroughBlock: sourceBlock - 1,
        completeThroughHash: sourceBlockHash,
      }],
      edges: selectedPools.map((pool) =>
        edge("swap-action", pool, TOKEN_A, TOKEN_B)
      ),
    });
  };

  const bootstrap = await coordinator.prepare({
    graph: laggingGraph(1),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "startup-bootstrap",
  });
  assert.notEqual(bootstrap.status, "incomplete");
  if (bootstrap.status === "incomplete") {
    throw new Error("expected bounded recovery bootstrap snapshot");
  }
  assert.equal(bootstrap.snapshot.stateByStateKey.size, pools.length);

  backend.readTargets.length = 0;
  backend.rangeSources.length = 0;
  const recovery = await coordinator.prepare({
    graph: laggingGraph(40),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "proof-scoped",
  });
  const telemetry = recovery.familyTelemetry?.find(
    (entry) => entry.familyId === "univ2-standard",
  );
  assert.equal(
    telemetry?.directStateKeys,
    pools.length,
    "a stale base (gap > 32) triggers a whole-family direct read, not a " +
      "16-key recovery quota: every pool the graph owns is priced",
  );
  assert.equal(telemetry?.recoveryRequiredStateKeys ?? 0, 0);
  assert.equal(backend.readTargets.length, pools.length);
  assert.equal(
    backend.rangeSources.length,
    0,
    "when every base is already outside the configured range, the " +
      "coordinator skips a doomed activity RPC and direct-reads current N",
  );
  assert.equal(recovery.coverage.unresolvedStateKeys.length, 0);

  backend.readTargets.length = 0;
  const drained = await coordinator.prepare({
    graph: laggingGraph(41),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "proof-scoped",
  });
  const drainedTelemetry = drained.familyTelemetry?.find(
    (entry) => entry.familyId === "univ2-standard",
  );
  assert.equal(
    drainedTelemetry?.directStateKeys,
    0,
    "once the base is current the family carries every unchanged pool",
  );
  assert.equal(drainedTelemetry?.recoveryRequiredStateKeys ?? 0, 0);
  assert.equal(drained.coverage.unresolvedStateKeys.length, 0);

  const newKeyBackend = new StateKeyIncrementalBackend();
  const newKeyCoordinator = new BlockScanStateCoordinator(newKeyBackend);
  const expandedPools = [
    pools[0],
    ...Array.from({ length: 18 }, (_, index) =>
      `0x${(0x200 + index).toString(16).padStart(40, "0")}`
    ),
  ];
  const graphWithPools = (
    generation: number,
    selectedPools: readonly string[],
  ) => {
    const sourceBlock = SOURCE_BLOCK + generation;
    const sourceBlockHash =
      `0x${generation.toString(16).padStart(64, "0")}`;
    return createVerifiedGraphView({
      id: `bounded-new-key-recovery-${generation}`,
      generation,
      sourceBlock,
      sourceBlockHash,
      completenessWatermark: sourceBlock - 1,
      perSourceCoverage: [{
        familyId: "univ2-standard",
        sourceId: "landed-event:fixture",
        sourceFingerprint: "fixture-bounded-new-key-recovery-v1",
        completeThroughBlock: sourceBlock - 1,
        completeThroughHash: sourceBlockHash,
      }],
      edges: selectedPools.map((pool) =>
        edge("swap-action", pool, TOKEN_A, TOKEN_B)
      ),
    });
  };
  await newKeyCoordinator.prepare({
    graph: graphWithPools(1, [expandedPools[0]]),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "startup-bootstrap",
  });
  newKeyBackend.readTargets.length = 0;
  const expanded = await newKeyCoordinator.prepare({
    graph: graphWithPools(2, expandedPools),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "proof-scoped",
  });
  const expandedTelemetry = expanded.familyTelemetry?.find(
    (entry) => entry.familyId === "univ2-standard",
  );
  assert.equal(
    expandedTelemetry?.directStateKeys,
    expandedPools.length - 1,
    "newly admitted keys are read in full: the bounded recovery quota is " +
      "obsolete once topology completeness no longer gates pricing",
  );
  assert.equal(expandedTelemetry?.recoveryRequiredStateKeys ?? 0, 0);
  assert.equal(newKeyBackend.readTargets.length, expandedPools.length - 1);
  assert.equal(expanded.coverage.unresolvedStateKeys.length, 0);

  const failingBackend = new StateKeyIncrementalBackend();
  const failingCoordinator = new BlockScanStateCoordinator(failingBackend);
  await failingCoordinator.prepare({
    graph: laggingGraph(1),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "startup-bootstrap",
  });
  for (const pool of pools) {
    failingBackend.failTargets.add(pool.toLowerCase());
  }
  failingBackend.readTargets.length = 0;
  await failingCoordinator.prepare({
    graph: laggingGraph(40),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "proof-scoped",
  });
  const firstFailedAttempt = new Set(failingBackend.readTargets);
  assert.equal(
    firstFailedAttempt.size,
    pools.length,
    "a stale base attempts every owned pool in one pass; the family-local " +
      "read quota no longer caps whole-family direct pricing",
  );

  const replacementPool = `0x${"1".padStart(40, "0")}`;
  failingBackend.failTargets.add(replacementPool);
  failingBackend.readTargets.length = 0;
  await failingCoordinator.prepare({
    graph: laggingGraph(1_040, [...pools.slice(1), replacementPool]),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "proof-scoped",
  });
  const attemptedAcrossTwoPasses = new Set([
    ...firstFailedAttempt,
    ...failingBackend.readTargets,
  ]);
  assert(
    pools.every((pool) => attemptedAcrossTwoPasses.has(pool.toLowerCase())),
    "a family-local cursor must reach every continuously failing key when generations and candidates change",
  );
}

async function derivedSwapIncrementalCarriesUntouchedPools(): Promise<void> {
  const backend = new StateKeyIncrementalBackend();
  const coordinator = new BlockScanStateCoordinator(backend);
  const family = registerBlockScanStateFamily({
    familyId: "derived-swap",
    lane: "swap",
    // No hand-written incremental capability: the family only declares its
    // events through the landed-event registration, and the coordinator
    // derives the update pipe from them.
    capability: fakeCapability("swap", { schema: 0, reads: 0, derives: 0 }),
    mutationEvents: [{
      topic: FIXTURE_MUTATION_TOPIC,
      emitter: { mode: "address" as const },
    }],
    ownsEdge: (edgeValue) => edgeValue.adapterId === "swap-action",
  });
  const graphGen = (
    generation: number,
    edges: readonly TokenEdge[],
  ) => {
    const sourceBlock = SOURCE_BLOCK + generation;
    const sourceBlockHash =
      `0x${generation.toString(16).padStart(64, "0")}`;
    return createVerifiedGraphView({
      id: `derived-swap-${generation}`,
      generation,
      sourceBlock,
      sourceBlockHash,
      completenessWatermark: sourceBlock - 1,
      perSourceCoverage: [{
        familyId: "derived-swap",
        sourceId: "fixture-derived-source",
        sourceFingerprint: "fixture-derived-v1",
        completeThroughBlock: sourceBlock - 1,
        completeThroughHash: sourceBlockHash,
      }],
      edges,
    });
  };

  await coordinator.prepare({
    graph: graphGen(1, [
      swapForward,
      swapReverse,
      swapBForward,
      swapBReverse,
    ]),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "startup-bootstrap",
  });
  backend.mutationTargets.add(SWAP_POOL_B.toLowerCase());
  backend.readTargets.length = 0;
  const next = await coordinator.prepare({
    graph: graphGen(2, [swapForward, swapReverse, swapBForward, swapBReverse]),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
    laggingTopologyRefreshMode: "proof-scoped",
  });
  assert.deepEqual(
    [...backend.readTargets].sort(),
    [SWAP_POOL_B.toLowerCase()],
    "the derived incremental must re-read only the pool that emitted a " +
      "declared mutation topic and carry the untouched pool",
  );
  assert.notEqual(next.status, "incomplete");
  if (next.status !== "incomplete") {
    assert.equal(next.snapshot.mids.size, 4);
  }
  const telemetry = next.familyTelemetry?.find(
    (entry) => entry.familyId === "derived-swap",
  );
  assert.equal(telemetry?.carryStateKeys, 1);
  assert.equal(telemetry?.directStateKeys, 1);
}

async function singletonActivityIsResolvedCentrallyByPoolId(): Promise<void> {
  const backend = new SingletonActivityBackend();
  const calls = { schema: 0, reads: 0, derives: 0 };
  const baseCapability = fakeCapability("swap", calls);
  const family = registerBlockScanStateFamily({
    familyId: "singleton-swap",
    lane: "swap",
    capability: {
      ...baseCapability,
      stateKey: (edgeValue) => {
        if (!edgeValue.poolId) throw new Error("fixture edge lacks poolId");
        return edgeValue.poolId.toLowerCase();
      },
      buildCurrentBlockReads: ({
        sourceBlock,
        sourceBlockHash,
        edges: stateEdges,
      }) => [{
        id: "state",
        sourceBlock,
        sourceBlockHash,
        to: SINGLETON_MANAGER,
        data: stateEdges[0]?.poolId ?? "0x",
        transport: "multicall-safe" as const,
      }],
    },
    ownsEdge: (edgeValue) => edgeValue.adapterId === "singleton-action",
  });
  const singletonEdge = (
    poolId: string,
    tokenIn: string,
    tokenOut: string,
  ): TokenEdge => Object.freeze({
    ...edge(
      "singleton-action",
      SINGLETON_MANAGER,
      tokenIn,
      tokenOut,
    ),
    poolId,
  });
  const edges = Object.freeze([
    singletonEdge(SINGLETON_POOL_ID_A, TOKEN_A, TOKEN_B),
    singletonEdge(SINGLETON_POOL_ID_A, TOKEN_B, TOKEN_A),
    singletonEdge(SINGLETON_POOL_ID_B, TOKEN_A, TOKEN_C),
    singletonEdge(SINGLETON_POOL_ID_B, TOKEN_C, TOKEN_A),
  ]);
  const singletonGraph = (generation: number) => {
    const sourceBlock = SOURCE_BLOCK + generation;
    const sourceBlockHash =
      `0x${generation.toString(16).padStart(64, "0")}`;
    return createVerifiedGraphView({
      id: `singleton-activity-${generation}`,
      generation,
      sourceBlock,
      sourceBlockHash,
      completenessWatermark: sourceBlock,
      perSourceCoverage: [{
        familyId: "singleton-swap",
        sourceId: "singleton-fixture",
        sourceFingerprint: "singleton-fixture-v1",
        completeThroughBlock: sourceBlock,
        completeThroughHash: sourceBlockHash,
      }],
      edges,
    });
  };
  const coordinator = new BlockScanStateCoordinator(backend);
  const prepare = (generation: number) => coordinator.prepare({
    graph: singletonGraph(generation),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
  });

  assert.equal((await prepare(1)).status, "complete");

  backend.readTargets.length = 0;
  backend.event = Object.freeze({
    topics: Object.freeze([`0x${"ef".repeat(32)}`]),
    data: SINGLETON_POOL_ID_B,
  });
  const poolScoped = await prepare(2);
  assert.equal(poolScoped.status, "complete");
  assert.equal(
    backend.readTargets.length,
    1,
    "an undeclared singleton event containing a known poolId refreshes only " +
      "that pool",
  );
  assert.equal(
    poolScoped.snapshot.stateByStateKey.get(
      `singleton-swap\u001f${SINGLETON_POOL_ID_A}`,
    )?.refreshMode,
    "carry-forward",
  );
  assert.equal(
    poolScoped.snapshot.stateByStateKey.get(
      `singleton-swap\u001f${SINGLETON_POOL_ID_B}`,
    )?.refreshMode,
    "unproven-direct",
  );

  backend.readTargets.length = 0;
  backend.event = Object.freeze({
    topics: Object.freeze([ERC6909_TRANSFER_TOPIC]),
    data: "0x",
  });
  assert.equal((await prepare(3)).status, "complete");
  assert.equal(
    backend.readTargets.length,
    0,
    "ERC-6909 claim transfers are state-neutral for pool pricing and must " +
      "not direct-read every pool behind the manager",
  );

  backend.readTargets.length = 0;
  backend.event = Object.freeze({
    topics: Object.freeze([UNIV4_DONATE_TOPIC]),
    data: SINGLETON_POOL_ID_B,
  });
  assert.equal((await prepare(4)).status, "complete");
  assert.equal(
    backend.readTargets.length,
    0,
    "Donate sends protocol fees only and must not refresh even a known pool",
  );

  backend.readTargets.length = 0;
  backend.event = Object.freeze({
    topics: Object.freeze([UNIV4_INITIALIZE_TOPIC]),
    data: SINGLETON_POOL_ID_B,
  });
  assert.equal((await prepare(5)).status, "complete");
  assert.equal(
    backend.readTargets.length,
    0,
    "Initialize creates a new pool and must not refresh existing pools",
  );

  backend.readTargets.length = 0;
  backend.event = Object.freeze({
    topics: Object.freeze([`0x${"ee".repeat(32)}`]),
    data: UNKNOWN_POOL_ID,
  });
  assert.equal((await prepare(6)).status, "complete");
  assert.equal(
    backend.readTargets.length,
    0,
    "a decoded-but-untracked poolId must be ignored instead of refreshing " +
      "the whole singleton family",
  );

  backend.readTargets.length = 0;
  backend.event = Object.freeze({
    topics: Object.freeze([`0x${"ee".repeat(32)}`]),
    data: "0x",
  });
  assert.equal((await prepare(7)).status, "complete");
  assert.equal(
    backend.readTargets.length,
    2,
    "a truly unresolved singleton mutation still fails closed to a family " +
      "refresh",
  );
}

async function incrementalRefreshIsStateKeyLocal(): Promise<void> {
  const backend = new StateKeyIncrementalBackend();
  const coordinator = new BlockScanStateCoordinator(backend);
  const buildTargets: string[] = [];
  let classifiedReadKey = "state";
  const family = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: incrementalFakeCapability({
      buildTargets,
      classifiedReadKey: () => classifiedReadKey,
    }),
    ownsEdge: (edgeValue) => edgeValue.adapterId === "swap-action",
  });
  const prepare = (generation: number, edges: readonly TokenEdge[]) =>
    coordinator.prepare({
      graph: incrementalGraph(generation, edges),
      families: [family],
      deadlineAtMs: Date.now() + 2_000,
    });
  const familyTelemetry = (
    result: Awaited<ReturnType<typeof coordinator.prepare>>,
  ) => {
    const telemetry = result.familyTelemetry?.find(
      (entry) => entry.familyId === "univ2-standard",
    );
    assert(telemetry, "incremental fixture must emit family telemetry");
    return telemetry;
  };

  backend.failTargets.add(SWAP_POOL_B.toLowerCase());
  const first = await prepare(1, [
    swapForward,
    swapReverse,
    swapBForward,
    swapBReverse,
  ]);
  assert.equal(first.status, "degraded");
  if (first.status !== "degraded") throw new Error("expected degraded base");
  assert.equal(first.snapshot.stateByStateKey.size, 1);

  backend.failTargets.clear();
  backend.readTargets.length = 0;
  buildTargets.length = 0;
  const recoveredAndNew = await prepare(2, [
    swapForward,
    swapReverse,
    swapBForward,
    swapBReverse,
    swapCForward,
    swapCReverse,
  ]);
  assert.equal(recoveredAndNew.status, "complete");
  if (recoveredAndNew.status !== "complete") {
    throw new Error("expected complete stateKey-local refresh");
  }
  assert.deepEqual(
    [...backend.readTargets].sort(),
    [SWAP_POOL_B, SWAP_POOL_C].map((value) => value.toLowerCase()).sort(),
    "a healthy prior sibling carries while the failed and new stateKeys read N",
  );
  assert.deepEqual(
    [...buildTargets].sort(),
    [SWAP_POOL_B, SWAP_POOL_C].map((value) => value.toLowerCase()).sort(),
    "descriptor construction is skipped for a proven carry-forward stateKey",
  );
  assert.deepEqual(
    recoveredAndNew.coverage.expectedReadKeys,
    recoveredAndNew.coverage.resolvedReadKeys,
    "carry-forward preserves the exact expected and resolved read-key set",
  );
  assert.equal(
    recoveredAndNew.snapshot.stateByStateKey.get(
      `univ2-standard\u001f${SWAP_POOL.toLowerCase()}`,
    )?.refreshMode,
    "carry-forward",
  );
  assert.equal(
    recoveredAndNew.snapshot.stateByStateKey.get(
      `univ2-standard\u001f${SWAP_POOL_B.toLowerCase()}`,
    )?.refreshMode,
    "unproven-direct",
  );
  assert.deepEqual(
    {
      carry: familyTelemetry(recoveredAndNew).carryStateKeys,
      direct: familyTelemetry(recoveredAndNew).directStateKeys,
      missing: familyTelemetry(recoveredAndNew).missingPreviousStateKeys,
      fallback: familyTelemetry(recoveredAndNew).fullFallbackReason,
    },
    { carry: 1, direct: 2, missing: 2, fallback: undefined },
  );

  const changedBForward = Object.freeze({
    ...swapBForward,
    v2FeeBps: 31n,
  });
  const changedBReverse = Object.freeze({
    ...swapBReverse,
    v2FeeBps: 31n,
  });
  const changedSchemaEdges = [
    swapForward,
    swapReverse,
    changedBForward,
    changedBReverse,
    swapCForward,
    swapCReverse,
  ];
  backend.readTargets.length = 0;
  buildTargets.length = 0;
  const localSchemaChange = await prepare(3, changedSchemaEdges);
  assert.equal(localSchemaChange.status, "complete");
  if (localSchemaChange.status !== "complete") {
    throw new Error("expected schema-local direct refresh");
  }
  assert.deepEqual(
    backend.readTargets,
    [SWAP_POOL_B.toLowerCase()],
    "a schema change directs only that stateKey",
  );
  assert.deepEqual(
    buildTargets,
    [SWAP_POOL_B.toLowerCase()],
    "schema-compatible siblings do not build current-N descriptors",
  );
  assert.deepEqual(
    {
      carry: familyTelemetry(localSchemaChange).carryStateKeys,
      direct: familyTelemetry(localSchemaChange).directStateKeys,
      missing: familyTelemetry(localSchemaChange).missingPreviousStateKeys,
      fallback: familyTelemetry(localSchemaChange).fullFallbackReason,
    },
    { carry: 2, direct: 1, missing: 0, fallback: undefined },
  );

  backend.mutationTargets.add(SWAP_POOL_C.toLowerCase());
  backend.readTargets.length = 0;
  buildTargets.length = 0;
  const mutationChanged = await prepare(4, changedSchemaEdges);
  assert.equal(mutationChanged.status, "complete");
  assert.deepEqual(
    backend.readTargets,
    [SWAP_POOL_C.toLowerCase()],
    "only the stateKey named by a valid mutation classification reads N",
  );
  assert.deepEqual(
    buildTargets,
    [SWAP_POOL_C.toLowerCase()],
    "only the classified-direct stateKey builds current-N descriptors",
  );
  assert.equal(
    mutationChanged.snapshot.stateByStateKey.get(
      `univ2-standard\u001f${SWAP_POOL_C.toLowerCase()}`,
    )?.refreshMode,
    "unproven-direct",
  );

  backend.mutationTargets.clear();
  backend.mutationTargets.add(SWAP_POOL_B.toLowerCase());
  classifiedReadKey = "unknown-state";
  backend.readTargets.length = 0;
  buildTargets.length = 0;
  const classifierMismatch = await prepare(5, changedSchemaEdges);
  assert.equal(classifierMismatch.status, "complete");
  assert.deepEqual(
    [...backend.readTargets].sort(),
    [SWAP_POOL_B].map((value) => value.toLowerCase()).sort(),
    "a touched activity identity directs only its own stateKey",
  );
  assert.deepEqual(
    [...buildTargets].sort(),
    [SWAP_POOL_B].map((value) => value.toLowerCase()).sort(),
  );

  backend.mutationTargets.clear();
  classifiedReadKey = "state";
  backend.rangeFailure = true;
  backend.readTargets.length = 0;
  buildTargets.length = 0;
  const fullFallback = await prepare(6, changedSchemaEdges);
  assert.equal(fullFallback.status, "complete");
  if (fullFallback.status !== "complete") {
    throw new Error("expected direct-read fallback to remain complete");
  }
  assert.deepEqual(
    [...backend.readTargets].sort(),
    [SWAP_POOL, SWAP_POOL_B, SWAP_POOL_C]
      .map((value) => value.toLowerCase())
      .sort(),
    "a mutation range failure falls back to direct reads for the full family",
  );
  assert.deepEqual(
    {
      carry: familyTelemetry(fullFallback).carryStateKeys,
      direct: familyTelemetry(fullFallback).directStateKeys,
      missing: familyTelemetry(fullFallback).missingPreviousStateKeys,
    },
    {
      carry: 0,
      direct: 3,
      missing: 0,
    },
  );
}

async function partialPublishedSnapshotDoesNotEraseRecoveryBases(): Promise<void> {
  const backend = new StateKeyIncrementalBackend();
  const coordinator = new BlockScanStateCoordinator(backend);
  const family = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: incrementalFakeCapability({ buildTargets: [] }),
    ownsEdge: (edgeValue) => edgeValue.adapterId === "swap-action",
  });
  const prepare = (generation: number) =>
    coordinator.prepare({
      graph: incrementalGraph(generation, [
        swapForward,
        swapReverse,
        swapBForward,
        swapBReverse,
      ]),
      families: [family],
      deadlineAtMs: Date.now() + 2_000,
    });

  const base = await prepare(1);
  assert.equal(base.status, "complete");
  if (base.status !== "complete") throw new Error("expected recovery base");
  assert.equal(base.snapshot.stateByStateKey.size, 2);

  // Generation 2 cannot prove activity; pool A refreshes, pool B fails, so
  // the published shell advances while B's per-key last-good remains at 1.
  backend.rangeFailure = true;
  backend.failTargets.add(SWAP_POOL_B.toLowerCase());
  const partial = await prepare(2);
  assert.equal(partial.status, "degraded");
  if (partial.status !== "degraded") {
    throw new Error("expected partial degradation");
  }
  assert.equal(
    partial.snapshot.stateByStateKey.size,
    1,
    "the current PricingView publishes the healthy key but not the failed key",
  );
  assert.equal(coordinator.latestSnapshot(), partial.snapshot);

  backend.rangeFailure = false;
  backend.failTargets.clear();
  backend.readTargets.length = 0;
  backend.rangeSources.length = 0;
  const recovered = await prepare(3);
  assert.equal(recovered.status, "complete");
  if (recovered.status !== "complete") {
    throw new Error("expected recovery-only carry");
  }
  assert.equal(
    backend.readTargets.length,
    0,
    "an unchanged key must carry from its own last-good source instead of " +
      "full-directing because the published shell is newer",
  );
  assert.deepEqual(
    backend.rangeSources,
    [{
      number: SOURCE_BLOCK + 1,
      hash: `0x${"1".padStart(64, "0")}`,
      generation: 1,
    }],
    "the unified activity proof anchors from the stateKey-local base",
  );
  const state = recovered.snapshot.stateByStateKey.get(
    `univ2-standard\u001f${SWAP_POOL_B.toLowerCase()}`,
  );
  assert.equal(state?.source.number, SOURCE_BLOCK + 3);
  assert.equal(state?.refreshMode, "carry-forward");
  const freshness = state?.freshnessByReadKey.get("state");
  assert.equal(freshness?.kind, "carry-forward");
  if (freshness?.kind === "carry-forward") {
    assert.equal(freshness.previousSource.number, SOURCE_BLOCK + 1);
  }
  const healthyFreshness = recovered.snapshot.stateByStateKey.get(
    `univ2-standard\u001f${SWAP_POOL.toLowerCase()}`,
  )?.freshnessByReadKey.get("state");
  assert.equal(healthyFreshness?.kind, "carry-forward");
  if (healthyFreshness?.kind === "carry-forward") {
    assert.equal(
      healthyFreshness.previousSource.number,
      SOURCE_BLOCK + 2,
      "each key keeps its own previousSource inside the shared activity range",
    );
  }
}

async function persistentDecodeFailuresAreDeferredAndRetried(): Promise<void> {
  const backend = new StateKeyIncrementalBackend();
  const coordinator = new BlockScanStateCoordinator(backend);
  const failingPool = SWAP_POOL_B.toLowerCase();
  const calls = { schema: 0, reads: 0, derives: 0 };
  const capability: BlockScanStateCapability<{ name: string }, FakeSnapshot> = {
    ...fakeCapability("swap", calls),
    buildCurrentBlockReads: ({ sourceBlock, sourceBlockHash, edges }) => {
      calls.reads++;
      const target = edges[0]?.target.toLowerCase() ?? SWAP_POOL;
      return [{
        id: `state:${target}`,
        sourceBlock,
        sourceBlockHash,
        to: target,
        data: "0x01",
        transport: "multicall-safe",
      }];
    },
    decodeState: (_schema, results) => {
      if (results[0]?.id === `state:${failingPool}`) {
        throw new Error("deterministic decode failure");
      }
      return { numerator: 2n, denominator: 1n };
    },
  };
  const family = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability,
    ownsEdge: (edgeValue) => edgeValue.adapterId === "swap-action",
  });
  const edges = Object.freeze([
    swapForward,
    swapReverse,
    swapBForward,
    swapBReverse,
  ]);
  const prepare = (generation: number) => coordinator.prepare({
    graph: incrementalGraph(generation, edges),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
  });

  // Three consecutive deterministic failures are required before deferral.
  for (let generation = 1; generation <= 3; generation++) {
    const result = await prepare(generation);
    assert.equal(result.status, "degraded");
    assert(
      backend.readTargets.includes(failingPool),
      `generation ${generation} must still retry the failing key`,
    );
  }

  // Generation 4 defers the key: no read for it, healthy sibling still carries.
  backend.readTargets.length = 0;
  const deferred = await prepare(4);
  assert.equal(deferred.status, "degraded");
  assert(
    !backend.readTargets.includes(failingPool),
    "persistent decode failures must stop re-running the quote ladder",
  );
  const healthy = deferred.snapshot?.stateByStateKey.get(
    `univ2-standard\u001f${SWAP_POOL.toLowerCase()}`,
  );
  assert.equal(healthy?.refreshMode, "carry-forward");

  // After the 256-block cooldown the key is retried once more.
  backend.readTargets.length = 0;
  const retried = await prepare(4 + 255);
  assert(
    backend.readTargets.includes(failingPool),
    "deferred key must be retried after the cooldown window",
  );
  assert.equal(retried.status, "degraded");
}

async function familyDeadlinePreservesProvenSiblingStateKey(): Promise<void> {
  const backend = new StateKeyIncrementalBackend();
  const registered = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: incrementalFakeCapability(),
    ownsEdge: (edgeValue) => edgeValue.adapterId === "swap-action",
  });
  const coordinator = new BlockScanStateCoordinator(backend, {
    familyTimeoutMs: 30,
  });
  const edges = [
    swapForward,
    swapReverse,
    swapBForward,
    swapBReverse,
  ];
  const base = await coordinator.prepare({
    graph: incrementalGraph(1, edges),
    families: [registered],
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(base.status, "complete");

  backend.mutationTargets.add(SWAP_POOL_B.toLowerCase());
  backend.stallTargets.add(SWAP_POOL_B.toLowerCase());
  const refreshed = await coordinator.prepare({
    graph: incrementalGraph(2, edges),
    families: [registered],
    familySettleDeadlineAtMs: Date.now() + 30,
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(refreshed.status, "degraded");
  if (refreshed.status !== "degraded") {
    throw new Error("expected stateKey-local deadline degradation");
  }
  assert.equal(
    refreshed.snapshot.stateByStateKey.size,
    1,
    "a timed-out direct stateKey must not erase a proven sibling carry",
  );
  assert.equal(refreshed.snapshot.mids.size, 2);
  assert(
    [...refreshed.snapshot.mids.values()].every(
      (value) => value.pool.toLowerCase() === SWAP_POOL.toLowerCase(),
    ),
  );
  assert.equal(
    refreshed.snapshot.stateByStateKey.get(
      `univ2-standard\u001f${SWAP_POOL.toLowerCase()}`,
    )?.refreshMode,
    "carry-forward",
  );
  const carryFreshness = refreshed.snapshot.stateByStateKey.get(
    `univ2-standard\u001f${SWAP_POOL.toLowerCase()}`,
  )?.freshnessByReadKey.get("state");
  assert.equal(carryFreshness?.kind, "carry-forward");
  assert.equal(carryFreshness?.source.number, SOURCE_BLOCK + 2);
  assert(
    refreshed.coverage.unresolvedStateKeys.includes(
      `univ2-standard\u001f${SWAP_POOL_B.toLowerCase()}`,
    ),
    "the timed-out stateKey must remain explicit unresolved coverage",
  );
  assert(
    refreshed.issues.some((issue) =>
      issue.kind === "deadline" &&
      issue.familyId === "univ2-standard"
    ),
    "the timed-out sibling must remain family-attributed",
  );
  assert.deepEqual(
    refreshed.snapshot.resolvedFamilyIds,
    [],
    "partial stateKey coverage must not claim whole-family completeness",
  );
  assert.deepEqual(
    refreshed.snapshot.incompleteFamilyIds,
    ["univ2-standard"],
  );
  assert.equal(refreshed.familyTelemetry?.[0]?.status, "degraded");
  const published = coordinator.latestSnapshot();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    coordinator.latestSnapshot(),
    published,
    "a late direct read may not overwrite the partial family publication",
  );
}

async function generationAbortStillErasesFamilyPartial(): Promise<void> {
  const backend = new StateKeyIncrementalBackend();
  const registered = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: incrementalFakeCapability(),
    ownsEdge: (edgeValue) => edgeValue.adapterId === "swap-action",
  });
  const coordinator = new BlockScanStateCoordinator(backend, {
    familyTimeoutMs: 2_000,
  });
  const edges = [
    swapForward,
    swapReverse,
    swapBForward,
    swapBReverse,
  ];
  const base = await coordinator.prepare({
    graph: incrementalGraph(1, edges),
    families: [registered],
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(base.status, "complete");

  backend.mutationTargets.add(SWAP_POOL_B.toLowerCase());
  backend.stallTargets.add(SWAP_POOL_B.toLowerCase());
  const outer = new AbortController();
  const timer = setTimeout(
    () => outer.abort(new Error("fixture generation abort")),
    20,
  );
  const aborted = await coordinator.prepare({
    graph: incrementalGraph(2, edges),
    families: [registered],
    familySettleDeadlineAtMs: Date.now() + 1_000,
    deadlineAtMs: Date.now() + 2_000,
    signal: outer.signal,
  });
  clearTimeout(timer);
  assert.equal(aborted.status, "incomplete");
  assert.equal(aborted.coverage.resolvedEdgeKeys.length, 0);
  assert.equal(
    coordinator.latestSnapshot(),
    base.status === "complete" ? base.snapshot : null,
    "generation abort must retain the last published snapshot and donate no partial state",
  );
}

async function familyLocalCompileDeadlineDoesNotCacheLateSchema(): Promise<void> {
  const swapCalls = { schema: 0, reads: 0, derives: 0 };
  const protocolCalls = { schema: 0, reads: 0, derives: 0 };
  const protocolBase = fakeCapability("protocol", protocolCalls);
  let compileCalls = 0;
  const firstCompile: {
    signal?: AbortSignal;
    release?: (schema: { readonly name: string }) => void;
  } = {};
  const slowProtocol: BlockScanStateCapability<
    { readonly name: string },
    FakeSnapshot
  > = {
    ...protocolBase,
    compileStaticSchema(input) {
      compileCalls++;
      if (compileCalls > 1) return { name: "protocol" };
      firstCompile.signal = input.signal;
      return new Promise((resolve) => {
        firstCompile.release = resolve;
      });
    },
  };
  const registered: readonly RegisteredBlockScanStateFamily[] = [
    registerBlockScanStateFamily({
      familyId: "univ2-standard",
      lane: "swap",
      capability: fakeCapability("swap", swapCalls),
      ownsEdge: (edgeValue) => edgeValue.adapterId === "swap-action",
    }),
    registerBlockScanStateFamily({
      familyId: "protocol:fixture",
      lane: "protocol",
      capability: slowProtocol,
      ownsEdge: (edgeValue) => edgeValue.adapterId === "protocol-action",
    }),
  ];
  const backend: BlockScanStateReadBackend = {
    async readBatch(_lane, reads, control) {
      return reads.map((read) => successfulRead(read, control.sourceGeneration));
    },
    async verifyCanonicalSource(_source, signal) {
      assert.equal(
        signal.aborted,
        false,
        "a family timeout must not abort the generation controller",
      );
    },
  };
  const coordinator = new BlockScanStateCoordinator(backend, {
    familyTimeoutMs: 25,
  });
  const startedAtMs = Date.now();
  const first = await coordinator.prepare({
    graph: graph(1),
    families: registered,
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(first.status, "degraded");
  if (first.status !== "degraded") throw new Error("expected degraded state");
  assert(
    Date.now() - startedAtMs < 500,
    "a never-settling compile may not consume the generation deadline",
  );
  assert.deepEqual(first.snapshot.resolvedFamilyIds, ["univ2-standard"]);
  assert.deepEqual(first.snapshot.incompleteFamilyIds, ["protocol:fixture"]);
  assert(
    first.issues.some((issue) =>
      issue.kind === "deadline" &&
      issue.familyId === "protocol:fixture"
    ),
  );
  assert.equal(firstCompile.signal?.aborted, true);

  const published = coordinator.latestSnapshot();
  firstCompile.release?.({ name: "protocol" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    coordinator.latestSnapshot(),
    published,
    "late compile completion may not mutate the published generation",
  );

  const second = await coordinator.prepare({
    graph: graph(2),
    families: registered,
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(second.status, "complete");
  assert.equal(
    compileCalls,
    2,
    "a schema that completed after its family fence may not enter the cache",
  );
}

async function familyLocalReadDeadlineFencesLateBackendResult(): Promise<void> {
  const readProbe: {
    releaseProtocol?: () => void;
    protocolSignal?: AbortSignal;
    swapSignal?: AbortSignal;
  } = {};
  const backend: BlockScanStateReadBackend = {
    async readBatch(lane, reads, control) {
      if (lane === "swap") {
        readProbe.swapSignal = control.signal;
        return reads.map((read) =>
          successfulRead(read, control.sourceGeneration)
        );
      }
      readProbe.protocolSignal = control.signal;
      return await new Promise<readonly StateReadResult[]>((resolve) => {
        readProbe.releaseProtocol = () => resolve(
          reads.map((read) =>
            successfulRead(read, control.sourceGeneration)
          ),
        );
      });
    },
    async verifyCanonicalSource(_source, signal) {
      assert.equal(
        signal.aborted,
        false,
        "a stalled family read must leave the generation usable",
      );
    },
  };
  const coordinator = new BlockScanStateCoordinator(backend, {
    familyTimeoutMs: 25,
  });
  const startedAtMs = Date.now();
  const result = await coordinator.prepare({
    graph: graph(1),
    families: families().list,
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(result.status, "degraded");
  if (result.status !== "degraded") throw new Error("expected degraded state");
  assert(
    Date.now() - startedAtMs < 500,
    "a never-settling read may not consume the generation deadline",
  );
  assert.notEqual(
    readProbe.swapSignal,
    readProbe.protocolSignal,
    "families must receive independent abort controllers",
  );
  assert.equal(readProbe.swapSignal?.aborted, false);
  assert.equal(readProbe.protocolSignal?.aborted, true);
  assert.deepEqual(result.snapshot.resolvedFamilyIds, ["univ2-standard"]);
  assert.deepEqual(result.snapshot.incompleteFamilyIds, ["protocol:fixture"]);
  assert.equal(result.snapshot.mids.size, 2);
  assert.equal(result.coverage.expectedReadKeys.length, 2);
  assert.equal(result.coverage.resolvedReadKeys.length, 1);
  assert(
    result.coverage.unresolvedReadKeys[0]?.startsWith("protocol:fixture\u001f"),
    "a read scheduled before timeout remains explicit unresolved coverage",
  );
  assert(
    result.issues.some((issue) =>
      issue.kind === "deadline" &&
      issue.familyId === "protocol:fixture"
    ),
  );

  const published = coordinator.latestSnapshot();
  readProbe.releaseProtocol?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    coordinator.latestSnapshot(),
    published,
    "late backend completion may not overwrite family staging",
  );
  assert.equal(coordinator.latestSnapshot()?.mids.size, 2);
}

async function explicitFamilySettleDeadlinePreservesGeneration(): Promise<void> {
  let releaseProtocol: (() => void) | undefined;
  let protocolSignal: AbortSignal | undefined;
  const backend: BlockScanStateReadBackend = {
    async readBatch(lane, reads, control) {
      if (lane === "swap") {
        return reads.map((read) =>
          successfulRead(read, control.sourceGeneration)
        );
      }
      protocolSignal = control.signal;
      return await new Promise<readonly StateReadResult[]>((resolve) => {
        releaseProtocol = () => resolve(
          reads.map((read) =>
            successfulRead(read, control.sourceGeneration)
          ),
        );
      });
    },
    async verifyCanonicalSource(_source, signal) {
      assert.equal(
        signal.aborted,
        false,
        "the earlier family-settlement boundary must leave CAS alive",
      );
    },
  };
  const coordinator = new BlockScanStateCoordinator(backend, {
    // Production startup may allow a long cold-family budget. The hot input
    // boundary must still be able to settle the family earlier.
    familyTimeoutMs: 2_000,
  });
  const startedAtMs = Date.now();
  const result = await coordinator.prepare({
    graph: graph(1),
    families: families().list,
    familySettleDeadlineAtMs: Date.now() + 25,
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(result.status, "degraded");
  if (result.status !== "degraded") throw new Error("expected degraded state");
  assert(
    Date.now() - startedAtMs < 500,
    "hot family settlement must not consume the outer generation deadline",
  );
  assert.deepEqual(result.snapshot.resolvedFamilyIds, ["univ2-standard"]);
  assert.deepEqual(result.snapshot.incompleteFamilyIds, ["protocol:fixture"]);
  assert.equal(result.snapshot.mids.size, 2);
  assert.equal(protocolSignal?.aborted, true);
  assert(
    result.issues.some((issue) =>
      issue.kind === "deadline" &&
      issue.familyId === "protocol:fixture"
    ),
    "the isolated family timeout must stay structurally attributable",
  );
  releaseProtocol?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(coordinator.latestSnapshot()?.mids.size, 2);
}

async function deadlineAndExternalAbort(): Promise<void> {
  let observedAbort = false;
  const backend: BlockScanStateReadBackend = {
    async readBatch(_lane, _reads, control) {
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          observedAbort = true;
          resolve();
        };
        if (control.signal.aborted) finish();
        else control.signal.addEventListener("abort", finish, { once: true });
      });
      throw control.signal.reason;
    },
    async verifyCanonicalSource() {},
  };
  const startedAt = Date.now();
  const result = await new BlockScanStateCoordinator(backend).prepare({
    graph: graph(1),
    families: families().list,
    deadlineAtMs: Date.now() + 40,
  });
  assert.equal(result.status, "incomplete");
  assert(observedAbort, "absolute deadline must reach the backend AbortSignal");
  assert(Date.now() - startedAt < 500);
  assert(result.issues.some((issue) => issue.kind === "deadline"));

  const external = new AbortController();
  external.abort(new Error("caller stopped"));
  const externallyAborted = await new BlockScanStateCoordinator(backend).prepare({
    graph: graph(1),
    families: families().list,
    deadlineAtMs: Date.now() + 2_000,
    signal: external.signal,
  });
  assert.equal(externallyAborted.status, "incomplete");
  assert(externallyAborted.issues.some((issue) => issue.kind === "aborted"));
}

async function generationFence(): Promise<void> {
  let generationOneStarted: (() => void) | null = null;
  const generationOneReady = new Promise<void>((resolve) => {
    generationOneStarted = resolve;
  });
  const backend: BlockScanStateReadBackend = {
    async readBatch(_lane, reads, control) {
      const generation = control.signal.reason;
      void generation;
      if (!control.signal.aborted && control.sourceBlock === SOURCE_BLOCK) {
        generationOneStarted?.();
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 10);
        control.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(control.signal.reason);
        }, { once: true });
      });
      return reads.map((read) => successfulRead(read, control.sourceGeneration));
    },
    async verifyCanonicalSource() {},
  };
  const coordinator = new BlockScanStateCoordinator(backend);
  const first = coordinator.prepare({
    graph: graph(1),
    families: families().list,
    deadlineAtMs: Date.now() + 2_000,
  });
  await generationOneReady;
  const second = coordinator.prepare({
    graph: graph(2),
    families: families().list,
    deadlineAtMs: Date.now() + 2_000,
  });
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.status, "incomplete");
  assert(one.issues.some((issue) => issue.kind === "stale-generation"));
  assert.equal(two.status, "complete");
  assert.equal(coordinator.latestSnapshot()?.generation, 2);
}

class ActivityRangeRecordingBackend implements BlockScanStateReadBackend {
  readonly activityRanges: Array<{ readonly from: number; readonly to: number }> = [];
  readonly directTargets: string[] = [];

  async readBatch(
    _lane: BlockScanPricingLane,
    reads: readonly StateRead[],
    control: { readonly sourceGeneration: number },
  ): Promise<readonly StateReadResult[]> {
    this.directTargets.push(...reads.map((read) => read.to.toLowerCase()));
    return reads.map((read) => successfulRead(read, control.sourceGeneration));
  }

  async readCanonicalBlockActivity(
    fromExclusive: BlockSource,
    through: BlockSource,
  ): Promise<CanonicalBlockActivity> {
    this.activityRanges.push({
      from: fromExclusive.number,
      to: through.number,
    });
    return Object.freeze({
      fromExclusive,
      through,
      events: Object.freeze([]),
      touchedAddresses: Object.freeze([]),
      transactionCount: 0,
      canonicalPathFingerprint: deterministicHash({
        fromExclusive,
        through,
      }),
      rangeFingerprint: deterministicHash({ fromExclusive, through }),
    });
  }

  async verifyCanonicalSource(): Promise<void> {
    return;
  }
}

class GateReadsBackend implements BlockScanStateReadBackend {
  private resolveStarted!: () => void;
  private resolveRelease!: () => void;
  readonly readsStarted = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  private readonly release = new Promise<void>((resolve) => {
    this.resolveRelease = resolve;
  });
  private released = false;

  async readBatch(
    _lane: BlockScanPricingLane,
    reads: readonly StateRead[],
    control: {
      readonly sourceGeneration: number;
      readonly signal: AbortSignal;
    },
  ): Promise<readonly StateReadResult[]> {
    this.resolveStarted();
    if (!this.released) {
      await new Promise<void>((resolve) => {
        if (control.signal.aborted) resolve();
        else control.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
        void this.release.then(() => resolve());
      });
    }
    return reads.map((read) => successfulRead(read, control.sourceGeneration));
  }

  finishReads(): void {
    this.released = true;
    this.resolveRelease();
  }

  async readCanonicalBlockActivity(
    fromExclusive: BlockSource,
    through: BlockSource,
  ): Promise<CanonicalBlockActivity> {
    return Object.freeze({
      fromExclusive,
      through,
      events: Object.freeze([]),
      touchedAddresses: Object.freeze([]),
      transactionCount: 0,
      canonicalPathFingerprint: deterministicHash({
        fromExclusive,
        through,
      }),
      rangeFingerprint: deterministicHash({ fromExclusive, through }),
    });
  }

  async verifyCanonicalSource(): Promise<void> {
    return;
  }
}

async function activityRangeIsCappedToEightBlocks(): Promise<void> {
  const backend = new ActivityRangeRecordingBackend();
  const coordinator = new BlockScanStateCoordinator(backend, {
    incrementalRangeBlocks: 128,
  });
  const family = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: incrementalFakeCapability(),
    ownsEdge: (edgeValue) => edgeValue.adapterId === "swap-action",
  });
  const edges = [swapForward, swapReverse];

  const bootstrap = await coordinator.prepare({
    graph: incrementalGraph(1, edges),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
    laggingTopologyRefreshMode: "startup-bootstrap",
  });
  assert.equal(bootstrap.status, "complete");
  assert.equal(
    backend.activityRanges.length,
    0,
    "bootstrap with no recovery base must skip the canonical activity read",
  );

  const adjacent = await coordinator.prepare({
    graph: incrementalGraph(2, edges),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(adjacent.status, "complete");
  assert.equal(
    backend.activityRanges.length,
    1,
    "a one-block gap must use the canonical activity proof",
  );
  assert.equal(
    backend.activityRanges[0]!.to - backend.activityRanges[0]!.from,
    1,
  );

  const distant = await coordinator.prepare({
    graph: incrementalGraph(11, edges),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(distant.status, "complete");
  assert.equal(
    backend.activityRanges.length,
    1,
    "a 9-block gap must not attempt one giant canonical activity read",
  );
  assert(
    backend.directTargets.some(
      (target) => target === SWAP_POOL.toLowerCase(),
    ),
    "the stale-base keys must direct-read at current N instead of carrying",
  );
}

async function headPassDoesNotSupersedeActiveBootstrap(): Promise<void> {
  const backend = new GateReadsBackend();
  const coordinator = new BlockScanStateCoordinator(backend, {
    familyTimeoutMs: 25,
  });
  const family = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: incrementalFakeCapability(),
    ownsEdge: (edgeValue) => edgeValue.adapterId === "swap-action",
  });
  const edges = [swapForward, swapReverse];

  const bootstrap = coordinator.prepare({
    graph: incrementalGraph(1, edges),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
    laggingTopologyRefreshMode: "startup-bootstrap",
  });
  await backend.readsStarted;

  const headPass = await coordinator.prepare({
    graph: incrementalGraph(2, edges),
    families: [family],
    deadlineAtMs: Date.now() + 300,
  });
  assert.equal(
    headPass.status,
    "incomplete",
    "a head pass must fail closed instead of aborting an active bootstrap",
  );

  let bootstrapSettled = false;
  void bootstrap.then(() => {
    bootstrapSettled = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  assert.equal(
    bootstrapSettled,
    false,
    "the bootstrap generation must still be running after the head pass wait",
  );

  backend.finishReads();
  const result = await bootstrap;
  assert.equal(result.status, "complete");

  const afterBootstrap = await coordinator.prepare({
    graph: incrementalGraph(2, edges),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(afterBootstrap.status, "complete");
}

async function dependentReadClosureIsExplicit(): Promise<void> {
  const backendCalls: string[][] = [];
  const backend: BlockScanStateReadBackend = {
    async readBatch(_lane, reads, control) {
      backendCalls.push(reads.map((read) => read.id));
      return reads.map((read) => successfulRead(read, control.sourceGeneration));
    },
    async verifyCanonicalSource() {},
  };
  const makeDependentCapability = (
    overflow: boolean,
  ): BlockScanStateCapability<{ readonly name: string }, FakeSnapshot> => ({
    stateKey: (edgeValue) => edgeValue.target.toLowerCase(),
    compileStaticSchema: () => ({ name: "dependent" }),
    buildCurrentBlockReads: ({ sourceBlock, sourceBlockHash }) => [{
      id: "round-current",
      sourceBlock,
      sourceBlockHash,
      to: SWAP_POOL,
      data: "0x12345678",
      transport: "multicall-safe",
    }],
    buildDependentBlockReads: ({
      completedRound,
      sourceBlock,
      sourceBlockHash,
    }) => (
      completedRound <= (overflow ? 4 : 3)
        ? [{
            id: `round-dependent-${completedRound}`,
            sourceBlock,
            sourceBlockHash,
            to: SWAP_POOL,
            data: `0x${(completedRound + 1).toString(16).padStart(8, "0")}`,
            transport: "multicall-safe",
          }]
        : []
    ),
    decodeState: (_schema, results) => {
      assert.equal(results.length, 5);
      return { numerator: 2n, denominator: 1n };
    },
    deriveMids: (snapshot, edges) => new Map(edges.map((edgeValue) => [
      blockScanEdgeKey(edgeValue),
      mid(edgeValue, Number(snapshot.numerator) / Number(snapshot.denominator)),
    ])),
    dependencies: (edges) => edges.map((edgeValue) => edgeValue.target),
  });
  const makeFamilies = (
    overflow: boolean,
  ): readonly RegisteredBlockScanStateFamily[] => [
    registerBlockScanStateFamily({
      familyId: "univ2-standard",
      lane: "swap",
      capability: makeDependentCapability(overflow),
      ownsEdge: (edgeValue) => edgeValue.adapterId === "swap-action",
    }),
    registerBlockScanStateFamily({
      familyId: "protocol:fixture",
      lane: "protocol",
      capability: fakeCapability(
        "protocol",
        { schema: 0, reads: 0, derives: 0 },
      ),
      ownsEdge: (edgeValue) => edgeValue.adapterId === "protocol-action",
    }),
  ];

  const closed = await new BlockScanStateCoordinator(backend).prepare({
    graph: graph(1),
    families: makeFamilies(false),
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(closed.status, "complete");
  assert.deepEqual(
    backendCalls
      .flat()
      .filter((id) => id.includes(`\u001f${SWAP_POOL}\u001f`))
      .map((id) => id.slice(id.lastIndexOf("\u001f") + 1)),
    [
      "round-current",
      "round-dependent-0",
      "round-dependent-1",
      "round-dependent-2",
      "round-dependent-3",
    ],
    "five executed read rounds must be followed by an empty closure probe",
  );

  backendCalls.length = 0;
  const overflow = await new BlockScanStateCoordinator(backend).prepare({
    graph: graph(1),
    families: makeFamilies(true),
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(overflow.status, "degraded");
  if (overflow.status !== "degraded") throw new Error("expected degraded state");
  assert.deepEqual(overflow.snapshot.resolvedFamilyIds, ["protocol:fixture"]);
  assert.deepEqual(overflow.snapshot.incompleteFamilyIds, ["univ2-standard"]);
  assert(
    overflow.issues.some(
      (issue) =>
        issue.kind === "resource-limited" &&
        issue.familyId === "univ2-standard",
    ),
  );
  assert.equal(
    overflow.coverage.unresolvedStateKeys.length,
    1,
    "only the overflowing swap state key is unresolved",
  );
}

async function staticSchemaReadsAreCachedAndDynamicReadsStayCurrent(): Promise<void> {
  let compiles = 0;
  let staticReads = 0;
  let dynamicReads = 0;
  const backend: BlockScanStateReadBackend = {
    async readBatch(_lane, reads, control) {
      for (const read of reads) {
        if (read.id === "metadata") staticReads++;
        if (read.id.includes("state")) dynamicReads++;
      }
      return reads.map((read) => successfulRead(read, control.sourceGeneration));
    },
    async verifyCanonicalSource() {},
  };
  const capability: BlockScanStateCapability<
    { readonly hydrated: boolean },
    FakeSnapshot
  > = {
    stateKey: (edgeValue) => edgeValue.target.toLowerCase(),
    compileStaticSchema() {
      compiles++;
      return { hydrated: false };
    },
    buildStaticSchemaReads({ sourceBlock, sourceBlockHash }) {
      return [{
        id: "metadata",
        sourceBlock,
        sourceBlockHash,
        to: SWAP_POOL,
        data: "0x01",
        transport: "rpc-batch",
      }];
    },
    hydrateStaticSchema(_schema, results) {
      assert.equal(results.length, 1);
      return { hydrated: true };
    },
    buildCurrentBlockReads({ sourceBlock, sourceBlockHash, schema }) {
      assert.equal(schema.hydrated, true);
      return [{
        id: "state",
        sourceBlock,
        sourceBlockHash,
        to: SWAP_POOL,
        data: "0x02",
        transport: "rpc-batch",
      }];
    },
    decodeState(_schema, results) {
      assert.equal(results.length, 1);
      return { numerator: 2n, denominator: 1n };
    },
    deriveMids(snapshot, edges) {
      return new Map(edges.map((edgeValue) => [
        blockScanEdgeKey(edgeValue),
        mid(edgeValue, Number(snapshot.numerator) / Number(snapshot.denominator)),
      ]));
    },
    dependencies: (edges) => edges.map((edgeValue) => edgeValue.target),
  };
  const family = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability,
    ownsEdge: (edgeValue) => edgeValue.adapterId === "swap-action",
  });
  const coordinator = new BlockScanStateCoordinator(backend);
  for (const generation of [1, 2]) {
    const result = await coordinator.prepare({
      graph: graph(generation),
      families: [family],
      requiresPricing: (edgeValue) => edgeValue.adapterId === "swap-action",
      deadlineAtMs: Date.now() + 2_000,
    });
    assert.equal(result.status, "complete");
  }
  assert.equal(compiles, 1, "static schema compiles once per graph fingerprint");
  assert.equal(staticReads, 1, "static metadata is not reread every generation");
  assert.equal(dynamicReads, 2, "dynamic state is still current-N every generation");
}

async function casRejectedGenerationDoesNotPublishCompileCache(): Promise<void> {
  const calls = { compiles: 0, staticReads: 0, dynamicReads: 0, verifies: 0 };
  const backend: BlockScanStateReadBackend = {
    async readBatch(_lane, reads, control) {
      for (const read of reads) {
        if (read.id === "metadata") calls.staticReads++;
        if (read.id.includes("state")) calls.dynamicReads++;
      }
      return reads.map((read) =>
        successfulRead(read, control.sourceGeneration)
      );
    },
    async verifyCanonicalSource() {
      calls.verifies++;
      if (calls.verifies === 1) {
        throw new Error("injected publish-time source hash mismatch");
      }
    },
  };
  const coordinator = new BlockScanStateCoordinator(backend);
  const family = staticSchemaFixtureFamily(calls);
  const first = await coordinator.prepare({
    graph: graph(1, true, [swapForward, swapReverse]),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(first.status, "incomplete");
  assert.equal(coordinator.latestSnapshot(), null);
  assert.equal(first.coverage.resolvedStateKeys.length, 0);
  assert(
    first.issues.some((issue) =>
      issue.kind === "stale-generation" &&
      issue.message.includes("publish-time canonical CAS failed")
    ),
  );

  const second = await coordinator.prepare({
    graph: graph(2, true, [swapForward, swapReverse]),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(second.status, "complete");
  assert.equal(
    calls.compiles,
    1,
    "same-source retry may reuse the non-authoritative compile memo",
  );
  assert.equal(calls.staticReads, 1, "same-source static evidence is memoized");

  const third = await coordinator.prepare({
    graph: graph(3, true, [swapForward, swapReverse]),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(third.status, "complete");
  assert.equal(calls.compiles, 1, "the CAS-published schema is now reusable");
  assert.equal(calls.staticReads, 1, "published static metadata remains cached");
  assert.equal(calls.dynamicReads, 3, "dynamic state remains current each generation");
  assert.equal(
    calls.verifies,
    3,
    "canonical verification is exactly once per pricing generation",
  );
}

async function supersededGenerationDoesNotPublishCompileCache(): Promise<void> {
  const calls = { compiles: 0, staticReads: 0 };
  let firstCasStarted: (() => void) | undefined;
  const firstCasReady = new Promise<void>((resolve) => {
    firstCasStarted = resolve;
  });
  const backend: BlockScanStateReadBackend = {
    async readBatch(_lane, reads, control) {
      for (const read of reads) {
        if (read.id === "metadata") calls.staticReads++;
      }
      return reads.map((read) =>
        successfulRead(read, control.sourceGeneration)
      );
    },
    async verifyCanonicalSource(source, signal) {
      if (source.generation !== 1) return;
      firstCasStarted?.();
      await new Promise<void>((_resolve, reject) => {
        const rejectAborted = () =>
          reject(signal.reason ?? new Error("generation superseded"));
        if (signal.aborted) rejectAborted();
        else signal.addEventListener("abort", rejectAborted, { once: true });
      });
    },
  };
  const coordinator = new BlockScanStateCoordinator(backend);
  const family = staticSchemaFixtureFamily(calls);
  const firstPending = coordinator.prepare({
    graph: graph(1, true, [swapForward, swapReverse]),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
  });
  await firstCasReady;
  const secondPending = coordinator.prepare({
    graph: graph(2, true, [swapForward, swapReverse]),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
  });
  const [first, second] = await Promise.all([firstPending, secondPending]);
  assert.equal(first.status, "incomplete");
  assert(first.issues.some((issue) => issue.kind === "stale-generation"));
  assert.equal(second.status, "complete");
  assert.equal(coordinator.latestSnapshot()?.generation, 2);
  assert.equal(
    calls.compiles,
    1,
    "an identical same-source successor may reuse the non-authoritative compile memo",
  );
  assert.equal(calls.staticReads, 1, "same-source static evidence remains memoized");
}

async function successfulCompileStaysUnpublishedWithGeneration(): Promise<void> {
  const swapCalls = { schema: 0, reads: 0, derives: 0 };
  const protocolCalls = { schema: 0, reads: 0, derives: 0 };
  const registered: readonly RegisteredBlockScanStateFamily[] = [
    registerBlockScanStateFamily({
      familyId: "univ2-standard",
      lane: "swap",
      capability: fakeCapability("swap", swapCalls),
      ownsEdge: (edgeValue) => edgeValue.adapterId === "swap-action",
    }),
    registerBlockScanStateFamily({
      familyId: "protocol:fixture",
      lane: "protocol",
      capability: fakeCapability("protocol", protocolCalls),
      ownsEdge: (edgeValue) => edgeValue.adapterId === "protocol-action",
    }),
  ];
  let releaseProtocol: (() => void) | undefined;
  let firstProtocolRead = true;
  const backend: BlockScanStateReadBackend = {
    async readBatch(lane, reads, control) {
      if (lane === "swap") {
        return reads.map((read) =>
          successfulRead(read, control.sourceGeneration)
        );
      }
      if (!firstProtocolRead) {
        return reads.map((read) =>
          successfulRead(read, control.sourceGeneration)
        );
      }
      firstProtocolRead = false;
      return await new Promise<readonly StateReadResult[]>((resolve) => {
        releaseProtocol = () => resolve(
          reads.map((read) =>
            successfulRead(read, control.sourceGeneration)
          ),
        );
      });
    },
    async verifyCanonicalSource() {
      return;
    },
  };
  const coordinator = new BlockScanStateCoordinator(backend);
  const outer = new AbortController();
  const timer = setTimeout(
    () => outer.abort(new Error("fixture head supersede")),
    20,
  );
  const first = await coordinator.prepare({
    graph: graph(1),
    families: registered,
    deadlineAtMs: Date.now() + 2_000,
    signal: outer.signal,
  });
  clearTimeout(timer);
  assert.equal(first.status, "incomplete");
  assert.equal(coordinator.latestSnapshot(), null);
  assert.equal(
    swapCalls.schema + protocolCalls.schema,
    2,
    "both families compiled before the generation was superseded",
  );
  releaseProtocol?.();
  await new Promise<void>((resolve) => setImmediate(resolve));

  const second = await coordinator.prepare({
    graph: graph(2),
    families: registered,
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.notEqual(second.status, "incomplete");
  assert.equal(
    swapCalls.schema + protocolCalls.schema,
    2,
    "same-source compiles are memoized without becoming published previous",
  );
  assert.ok(second.coverage.resolvedStateKeys.length > 0);
}

async function immutableForkNeedsBackendAttestation(): Promise<void> {
  const calls = { schema: 0, reads: 0, derives: 0 };
  const capability = fakeCapability("swap", calls);
  const family = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability,
    ownsEdge: (edgeValue) => edgeValue.adapterId === "swap-action",
  });
  const makeBackend = (
    trusted: boolean,
  ): BlockScanStateReadBackend => ({
    async readBatch(_lane, reads, control) {
      return reads.map((read): StateReadResult => ({
        id: read.id,
        ok: true,
        sourceBlock: read.sourceBlock,
        sourceBlockHash: read.sourceBlockHash,
        provenance: {
          kind: "immutable-fork",
          source: {
            number: read.sourceBlock,
            hash: read.sourceBlockHash,
            generation: control.sourceGeneration,
          },
          forkId: "fixture-fork",
        },
        data: "0x01",
      }));
    },
    async verifyCanonicalSource() {
      return;
    },
    ...(trusted
      ? {
          verifyImmutableForkProvenance(provenance, source) {
            return (
              provenance.forkId === "fixture-fork" &&
              provenance.source.number === source.number &&
              provenance.source.hash === source.hash &&
              provenance.source.generation === source.generation
            );
          },
        }
      : {}),
  });
  const input = {
    graph: graph(1, true, [swapForward, swapReverse]),
    families: [family],
    requiresPricing: (edgeValue: TokenEdge) =>
      edgeValue.adapterId === "swap-action",
    deadlineAtMs: Date.now() + 2_000,
  };
  const untrusted = await new BlockScanStateCoordinator(
    makeBackend(false),
  ).prepare(input);
  assert.equal(untrusted.status, "degraded");
  assert(
    untrusted.issues.some((issue) =>
      issue.kind === "backend" &&
      issue.message.includes("not pinned")
    ),
  );
  const attested = await new BlockScanStateCoordinator(
    makeBackend(true),
  ).prepare({
    ...input,
    graph: graph(2, true, [swapForward, swapReverse]),
  });
  assert.equal(attested.status, "complete");
}

function purityHook(): void {
  const calls = { schema: 0, reads: 0, derives: 0 };
  const capability = fakeCapability("swap", calls);
  let ioCalls = 0;
  let poisoned = false;
  const result = assertPureSynchronousDeriveMids({
    capability,
    snapshot: { numerator: 2n, denominator: 1n },
    edges: [swapForward, swapReverse],
    harness: {
      withPoisonedIo(run) {
        poisoned = true;
        try {
          return run();
        } finally {
          poisoned = false;
        }
      },
      ioCalls: () => ioCalls,
    },
  });
  assert.equal(result.edgeKeys.length, 2);
  assert.match(result.outputHash, /^[0-9a-f]{64}$/);
  assert.equal(poisoned, false);

  const impure = {
    ...capability,
    deriveMids(snapshot: FakeSnapshot, edges: readonly TokenEdge[]) {
      if (poisoned) ioCalls++;
      return capability.deriveMids(snapshot, edges);
    },
  };
  assert.throws(
    () => assertPureSynchronousDeriveMids({
      capability: impure,
      snapshot: { numerator: 2n, denominator: 1n },
      edges: [swapForward],
      harness: {
        withPoisonedIo(run) {
          poisoned = true;
          try {
            return run();
          } finally {
            poisoned = false;
          }
        },
        ioCalls: () => ioCalls,
      },
    }),
    /attempted 2 I\/O operation/,
  );
}

function successfulRead(
  read: StateRead,
  generation: number,
): StateReadResult {
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
        generation,
      }),
      requireCanonical: true as const,
    }),
    data: "0x01",
  });
}

function protocolTouchGraph(generation: number) {
  const sourceBlock = SOURCE_BLOCK + generation;
  const sourceBlockHash = `0x${generation.toString(16).padStart(64, "0")}`;
  return createVerifiedGraphView({
    id: `protocol-touch-${generation}`,
    generation,
    sourceBlock,
    sourceBlockHash,
    completenessWatermark: sourceBlock,
    perSourceCoverage: [{
      familyId: "protocol:fixture",
      sourceId: "protocol-touch-fixture",
      sourceFingerprint: "protocol-touch-fixture-v1",
      completeThroughBlock: sourceBlock,
      completeThroughHash: sourceBlockHash,
    }],
    edges: [protocol],
  });
}

async function protocolActivityPlanDrivesDirtyDirectCarry(): Promise<void> {
  const backend = new AddressTouchShadowBackend();
  const family = registerBlockScanStateFamily({
    familyId: "protocol:fixture",
    lane: "protocol",
    ownsEdge: (edgeValue) => edgeValue.adapterId === "protocol-action",
    capability: {
      stateKey: (edgeValue) => edgeValue.target.toLowerCase(),
      compileStaticSchema: () => Object.freeze({}),
      buildCurrentBlockReads: ({ sourceBlock, sourceBlockHash, edges }) => [{
        id: "state",
        sourceBlock,
        sourceBlockHash,
        to: edges[0].target,
        data: "0x12345678",
        transport: "rpc-batch",
      }],
      decodeState: (_schema, results) => ({
        numerator: BigInt(results[0]?.ok ? results[0].data : "0x0"),
        denominator: 1n,
      }),
      deriveMids: (snapshot: FakeSnapshot, edges) => new Map(
        edges.map((edgeValue) => [
          blockScanEdgeKey(edgeValue),
          mid(edgeValue, Number(snapshot.numerator)),
        ]),
      ),
      dependencies: (edges) => edges.flatMap((edgeValue) => [
        edgeValue.target,
        edgeValue.tokenIn,
        edgeValue.tokenOut,
      ]),
    },
  });
  const coordinator = new BlockScanStateCoordinator(backend);
  const prepare = (generation: number) => coordinator.prepare({
    graph: protocolTouchGraph(generation),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
  });

  assert.equal((await prepare(1)).status, "complete");
  assert.equal(backend.readBatchCount, 1, "cold start direct-reads the protocol key");

  const untouched = await prepare(2);
  assert.equal(untouched.status, "complete");
  assert.equal(
    backend.readBatchCount,
    1,
    "an untouched protocol dependency carries through the unified activity plan",
  );
  assert.equal(
    untouched.snapshot.stateByStateKey.get(
      `protocol:fixture\u001f${PROTOCOL_POOL.toLowerCase()}`,
    )?.refreshMode,
    "carry-forward",
  );

  backend.touchedAddresses.add(PROTOCOL_POOL.toLowerCase());
  const touched = await prepare(3);
  assert.equal(touched.status, "complete");
  assert.equal(
    backend.readBatchCount,
    2,
    "a touched protocol dependency direct-reads current N",
  );
  assert.equal(
    touched.snapshot.stateByStateKey.get(
      `protocol:fixture\u001f${PROTOCOL_POOL.toLowerCase()}`,
    )?.refreshMode,
    "unproven-direct",
  );
}

async function protocolActivityFailureFailsClosedToDirect(): Promise<void> {
  const backend = new AddressTouchShadowBackend();
  const family = registerBlockScanStateFamily({
    familyId: "protocol:fixture",
    lane: "protocol",
    ownsEdge: (edgeValue) => edgeValue.adapterId === "protocol-action",
    capability: {
      stateKey: (edgeValue) => edgeValue.target.toLowerCase(),
      compileStaticSchema: () => Object.freeze({}),
      buildCurrentBlockReads: ({ sourceBlock, sourceBlockHash, edges }) => [{
        id: "state",
        sourceBlock,
        sourceBlockHash,
        to: edges[0].target,
        data: "0x12345678",
        transport: "rpc-batch",
      }],
      decodeState: (_schema, results) => ({
        numerator: BigInt(results[0]?.ok ? results[0].data : "0x0"),
        denominator: 1n,
      }),
      deriveMids: (snapshot: FakeSnapshot, edges) => new Map(
        edges.map((edgeValue) => [
          blockScanEdgeKey(edgeValue),
          mid(edgeValue, Number(snapshot.numerator)),
        ]),
      ),
      dependencies: (edges) => edges.flatMap((edgeValue) => [
        edgeValue.target,
        edgeValue.tokenIn,
        edgeValue.tokenOut,
      ]),
    },
  });
  const coordinator = new BlockScanStateCoordinator(backend);
  const prepare = (generation: number) => coordinator.prepare({
    graph: protocolTouchGraph(generation),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
  });

  assert.equal((await prepare(1)).status, "complete");
  assert.equal(backend.readBatchCount, 1);

  backend.value = 4n;
  const carried = await prepare(2);
  assert.equal(carried.status, "complete");
  assert.equal(backend.readBatchCount, 1, "untouched protocol dependency must carry");

  backend.touchedAddresses.add(PROTOCOL_POOL);
  backend.value = 5n;
  assert.equal((await prepare(3)).status, "complete");
  assert.equal(backend.readBatchCount, 2, "touched family must refresh directly");

  backend.touchedAddresses.clear();
  backend.activityFailure = true;
  backend.value = 6n;
  assert.equal((await prepare(4)).status, "complete");
  assert.equal(
    backend.readBatchCount,
    3,
    "activity proof failure must fail closed to direct current-block reads",
  );
}

function univ2Edge(
  pool: string,
  poolToken0: string,
  poolToken1: string,
  forward: boolean,
): TokenEdge {
  return {
    adapterId: "univ2-swap",
    target: pool,
    tokenIn: forward ? poolToken0 : poolToken1,
    tokenOut: forward ? poolToken1 : poolToken0,
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
    poolToken0,
    poolToken1,
    v2FeeBps: 30n,
  };
}

function univ2Graph(
  generation: number,
  edges: readonly TokenEdge[],
) {
  const sourceBlock = SOURCE_BLOCK + generation;
  return createVerifiedGraphView({
    id: `univ2-instance-graph-${generation}`,
    generation,
    sourceBlock,
    sourceBlockHash: `0x${generation.toString(16).padStart(64, "0")}`,
    completenessWatermark: sourceBlock,
    perSourceCoverage: [{
      familyId: "univ2-standard",
      sourceId: "univ2-instance-fixture",
      sourceFingerprint: "univ2-instance-fixture-v1",
      completeThroughBlock: sourceBlock,
      completeThroughHash: `0x${generation.toString(16).padStart(64, "0")}`,
    }],
    edges,
  });
}

function reservesData(
  reserve0: bigint,
  reserve1: bigint,
  blockTimestampLast: number,
): string {
  return `0x${reserve0.toString(16).padStart(64, "0")}` +
    `${reserve1.toString(16).padStart(64, "0")}` +
    `${blockTimestampLast.toString(16).padStart(64, "0")}`;
}

async function univ2InstanceParityWithFullCompile(): Promise<void> {
  const edges = Object.freeze([
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, true),
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, false),
    univ2Edge(SWAP_POOL_B, TOKEN_A, TOKEN_C, true),
    univ2Edge(SWAP_POOL_B, TOKEN_A, TOKEN_C, false),
  ]);
  const full = univ2BlockScanState.compileStaticSchema({
    edges,
    deadlineAtMs: Date.now() + 5_000,
    signal: new AbortController().signal,
  });
  const instances = new Map<string, unknown>();
  for (const pool of [SWAP_POOL, SWAP_POOL_B]) {
    const group = Object.freeze(
      edges.filter(
        (edgeValue) => edgeValue.target.toLowerCase() === pool.toLowerCase(),
      ),
    );
    const spec = Object.freeze({
      key: `univ2-standard\u001f${pool.toLowerCase()}`,
      familyId: "univ2-standard",
      stateKey: pool.toLowerCase(),
      edges: group,
      staticBindingFingerprint: stateSchemaFingerprint(group),
      snapshotCompatibilityFingerprint: stateSchemaFingerprint(group),
    });
    const compiled = univ2BlockScanState.compileStateInstance({
      spec,
      control: {
        deadlineAtMs: Date.now() + 5_000,
        signal: new AbortController().signal,
      },
      sourceBlock: SOURCE_BLOCK,
      sourceBlockHash: SOURCE_HASH,
    });
    instances.set(pool.toLowerCase(), compiled.opaque);
  }
  const assembled = univ2BlockScanState.assembleSchema(instances);
  assert.deepEqual(
    [...assembled.pools.keys()].sort(),
    [...full.pools.keys()].sort(),
  );
  for (const pool of assembled.pools.keys()) {
    assert.deepEqual(assembled.pools.get(pool), full.pools.get(pool));
  }
}

async function univ2InstanceModeRecompilesOnlyNewPool(): Promise<void> {
  const calls = { compiles: 0 };
  const family = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: {
      ...univ2BlockScanState,
      compileStateInstance(input: CompileStateInstanceInput) {
        calls.compiles++;
        return univ2BlockScanState.compileStateInstance!(input);
      },
    },
    ownsEdge: (edgeValue) => edgeValue.adapterId === "univ2-swap",
  });
  class ReservesBackend implements BlockScanStateReadBackend {
    async readBatch(
      _lane: BlockScanPricingLane,
      reads: readonly StateRead[],
      control: { readonly sourceGeneration: number },
    ): Promise<readonly StateReadResult[]> {
      const data = reservesData(1000n, 2000n, 0);
      return reads.map((read) =>
        Object.freeze({
          ...successfulRead(read, control.sourceGeneration),
          data,
        })
      );
    }

    async verifyCanonicalSource(): Promise<void> {
      return;
    }
  }
  const coordinator = new BlockScanStateCoordinator(new ReservesBackend());
  const graphA = univ2Graph(1, [
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, true),
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, false),
  ]);
  const first = await coordinator.prepare({
    graph: graphA,
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(first.status, "complete");
  assert.equal(calls.compiles, 1, "first generation compiles the only pool");

  const graphAB = univ2Graph(2, [
    ...graphA.edges,
    univ2Edge(SWAP_POOL_B, TOKEN_A, TOKEN_C, true),
    univ2Edge(SWAP_POOL_B, TOKEN_A, TOKEN_C, false),
  ]);
  const second = await coordinator.prepare({
    graph: graphAB,
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.notEqual(second.status, "incomplete");
  assert.equal(
    calls.compiles,
    2,
    "adding a pool must recompile only the new instance",
  );
}

async function rejectedInstanceGenerationDoesNotBecomePrevious(): Promise<void> {
  const previousSeen: boolean[] = [];
  const family = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: {
      ...univ2BlockScanState,
      compileStateInstance(input: CompileStateInstanceInput) {
        previousSeen.push(input.previous !== undefined);
        return univ2BlockScanState.compileStateInstance!(input);
      },
    },
    ownsEdge: (edgeValue) => edgeValue.adapterId === "univ2-swap",
  });
  let verifies = 0;
  const backend: BlockScanStateReadBackend = {
    async readBatch(_lane, reads, control) {
      const data = reservesData(1000n, 2000n, 0);
      return reads.map((read) => Object.freeze({
        ...successfulRead(read, control.sourceGeneration),
        data,
      }));
    },
    async verifyCanonicalSource() {
      verifies++;
      if (verifies === 1) throw new Error("fixture rejected source");
    },
  };
  const coordinator = new BlockScanStateCoordinator(backend);
  const edges = [
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, true),
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, false),
  ];
  const first = await coordinator.prepare({
    graph: univ2Graph(1, edges),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(first.status, "incomplete");

  const second = await coordinator.prepare({
    graph: univ2Graph(2, edges),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(second.status, "complete");
  assert.deepEqual(
    previousSeen,
    [false, false],
    "a pre-CAS instance must neither populate the published store nor be passed as previous",
  );

  const third = await coordinator.prepare({
    graph: univ2Graph(3, edges),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(third.status, "complete");
  assert.deepEqual(
    previousSeen,
    [false, false],
    "the descriptor published by generation 2 is reusable without recompilation",
  );
}

async function sharedBindingParticipatesInInstanceFingerprint(): Promise<void> {
  const calls = { compiles: 0 };
  const recorded: {
    binding?: FamilySharedBinding<unknown> | undefined;
  } = {};
  let bindingRevision = "v1";
  const family = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: {
      ...univ2BlockScanState,
      compileStateInstance(input: CompileStateInstanceInput) {
        calls.compiles++;
        recorded.binding = input.sharedBinding;
        return univ2BlockScanState.compileStateInstance!(input);
      },
      sharedBinding: () => Object.freeze({
        familyId: "univ2-standard",
        revision: bindingRevision,
        fingerprint: `fp-${bindingRevision}`,
        value: Object.freeze({ decimals: 6 }),
      }),
    },
    ownsEdge: (edgeValue) => edgeValue.adapterId === "univ2-swap",
  });
  class NoopBackend implements BlockScanStateReadBackend {
    async readBatch(
      _lane: BlockScanPricingLane,
      reads: readonly StateRead[],
      control: { readonly sourceGeneration: number },
    ): Promise<readonly StateReadResult[]> {
      const data = reservesData(1000n, 2000n, 0);
      return reads.map((read) =>
        Object.freeze({ ...successfulRead(read, control.sourceGeneration), data })
      );
    }
    async verifyCanonicalSource(): Promise<void> {
      return;
    }
  }
  const coordinator = new BlockScanStateCoordinator(new NoopBackend());
  const edges = [
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, true),
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, false),
  ];
  const first = await coordinator.prepare({
    graph: univ2Graph(1, edges),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(first.status, "complete");
  assert.equal(calls.compiles, 1);
  assert.equal(recorded.binding?.fingerprint, "fp-v1");

  const second = await coordinator.prepare({
    graph: univ2Graph(2, edges),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(second.status, "complete");
  assert.equal(
    calls.compiles,
    1,
    "an unchanged shared binding must not recompile the instance",
  );

  bindingRevision = "v2";
  const third = await coordinator.prepare({
    graph: univ2Graph(3, edges),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(third.status, "complete");
  assert.equal(
    calls.compiles,
    2,
    "a changed shared binding fingerprint must recompile the instance",
  );
  assert.equal(recorded.binding?.fingerprint, "fp-v2");
}

async function snapshotCompatibilityChangeForcesDirectRead(): Promise<void> {
  const calls = { compiles: 0 };
  let compatibility = "compat-a";
  let compatibilityRevision = "r1";
  const family = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: {
      ...univ2BlockScanState,
      compileStateInstance(input: CompileStateInstanceInput) {
        calls.compiles++;
        return univ2BlockScanState.compileStateInstance!(input);
      },
      snapshotCompatibilityFingerprint: () => compatibility,
      get snapshotCompatibilityRevision() {
        return compatibilityRevision;
      },
    },
    ownsEdge: (edgeValue) => edgeValue.adapterId === "univ2-swap",
  });
  class CountingBackend implements BlockScanStateReadBackend {
    physicalReads = 0;
    async readCanonicalBlockActivity(
      fromExclusive: BlockSource,
      through: BlockSource,
    ): Promise<{
      readonly fromExclusive: BlockSource;
      readonly through: BlockSource;
      readonly canonicalBlocks: readonly { readonly number: number; readonly hash: string }[];
      readonly events: readonly ChainLog[];
      readonly touchedAddresses: readonly string[];
      readonly transactionCount: number;
      readonly canonicalPathFingerprint: string;
      readonly rangeFingerprint: string;
    }> {
      return Object.freeze({
        fromExclusive,
        through,
        canonicalBlocks: Object.freeze([
          Object.freeze({ number: through.number, hash: through.hash }),
        ]),
        events: Object.freeze([]),
        touchedAddresses: Object.freeze([]),
        transactionCount: 0,
        canonicalPathFingerprint: deterministicHash({
          fromExclusive,
          through,
        }),
        rangeFingerprint: deterministicHash({
          fromExclusive,
          through,
          events: Object.freeze([]),
        }),
      });
    }
    async readBatch(
      _lane: BlockScanPricingLane,
      reads: readonly StateRead[],
      control: { readonly sourceGeneration: number },
    ): Promise<readonly StateReadResult[]> {
      this.physicalReads += reads.length;
      const data = reservesData(1000n, 2000n, 0);
      return reads.map((read) =>
        Object.freeze({ ...successfulRead(read, control.sourceGeneration), data })
      );
    }
    async verifyCanonicalSource(): Promise<void> {
      return;
    }
  }
  const backend = new CountingBackend();
  const coordinator = new BlockScanStateCoordinator(backend);
  const edges = [
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, true),
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, false),
  ];
  const first = await coordinator.prepare({
    graph: univ2Graph(1, edges),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(first.status, "complete");
  backend.physicalReads = 0;

  const unchanged = await coordinator.prepare({
    graph: univ2Graph(2, edges),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(unchanged.status, "complete");
  assert.equal(
    backend.physicalReads,
    0,
    "unchanged snapshot compatibility must carry",
  );

  compatibility = "compat-b";
  compatibilityRevision = "r2";
  backend.physicalReads = 0;
  const changed = await coordinator.prepare({
    graph: univ2Graph(3, edges),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(changed.status, "complete");
  assert.equal(
    backend.physicalReads,
    1,
    "a changed snapshot compatibility fingerprint must direct-read",
  );
}

async function alwaysDirectCarryPolicyNeverCarries(): Promise<void> {
  const family = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: {
      ...univ2BlockScanState,
      compileStateInstance(input: CompileStateInstanceInput) {
        const instance = univ2BlockScanState.compileStateInstance!(input);
        return Object.freeze({ ...instance, carryPolicy: "always-direct" });
      },
    },
    ownsEdge: (edgeValue) => edgeValue.adapterId === "univ2-swap",
  });
  class CountingBackend implements BlockScanStateReadBackend {
    physicalReads = 0;
    async readCanonicalBlockActivity(
      fromExclusive: BlockSource,
      through: BlockSource,
    ): Promise<{
      readonly fromExclusive: BlockSource;
      readonly through: BlockSource;
      readonly canonicalBlocks: readonly { readonly number: number; readonly hash: string }[];
      readonly events: readonly ChainLog[];
      readonly touchedAddresses: readonly string[];
      readonly transactionCount: number;
      readonly canonicalPathFingerprint: string;
      readonly rangeFingerprint: string;
    }> {
      return Object.freeze({
        fromExclusive,
        through,
        canonicalBlocks: Object.freeze([
          Object.freeze({ number: through.number, hash: through.hash }),
        ]),
        events: Object.freeze([]),
        touchedAddresses: Object.freeze([]),
        transactionCount: 0,
        canonicalPathFingerprint: deterministicHash({
          fromExclusive,
          through,
        }),
        rangeFingerprint: deterministicHash({
          fromExclusive,
          through,
          events: Object.freeze([]),
        }),
      });
    }
    async readBatch(
      _lane: BlockScanPricingLane,
      reads: readonly StateRead[],
      control: { readonly sourceGeneration: number },
    ): Promise<readonly StateReadResult[]> {
      this.physicalReads += reads.length;
      const data = reservesData(1000n, 2000n, 0);
      return reads.map((read) =>
        Object.freeze({ ...successfulRead(read, control.sourceGeneration), data })
      );
    }
    async verifyCanonicalSource(): Promise<void> {
      return;
    }
  }
  const backend = new CountingBackend();
  const coordinator = new BlockScanStateCoordinator(backend);
  const edges = [
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, true),
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, false),
  ];
  const first = await coordinator.prepare({
    graph: univ2Graph(1, edges),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(first.status, "complete");
  backend.physicalReads = 0;
  const second = await coordinator.prepare({
    graph: univ2Graph(2, edges),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(second.status, "complete");
  assert.equal(
    backend.physicalReads,
    1,
    "an always-direct carry policy must read current-N state every generation",
  );
}

async function scoreOnlyChangeDoesNotRecompileButRefreshesEdges(): Promise<void> {
  const calls = { compiles: 0 };
  const family = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: {
      ...univ2BlockScanState,
      compileStateInstance(input: CompileStateInstanceInput) {
        calls.compiles++;
        return univ2BlockScanState.compileStateInstance!(input);
      },
    },
    ownsEdge: (edgeValue) => edgeValue.adapterId === "univ2-swap",
  });
  class NoopBackend implements BlockScanStateReadBackend {
    async readBatch(
      _lane: BlockScanPricingLane,
      reads: readonly StateRead[],
      control: { readonly sourceGeneration: number },
    ): Promise<readonly StateReadResult[]> {
      const data = reservesData(1000n, 2000n, 0);
      return reads.map((read) =>
        Object.freeze({ ...successfulRead(read, control.sourceGeneration), data })
      );
    }
    async verifyCanonicalSource(): Promise<void> {
      return;
    }
  }
  const coordinator = new BlockScanStateCoordinator(new NoopBackend());
  const edges = [
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, true),
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, false),
  ];
  const first = await coordinator.prepare({
    graph: univ2Graph(1, edges),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(first.status, "complete");
  assert.equal(calls.compiles, 1);

  const scoredEdges = edges.map((edge) =>
    Object.freeze({ ...edge, score: 12345 }),
  );
  const second = await coordinator.prepare({
    graph: univ2Graph(2, scoredEdges),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(second.status, "complete");
  assert.equal(
    calls.compiles,
    1,
    "score-only changes must not recompile static instance descriptors",
  );
  assert(
    second.snapshot.graph.edges.every((edgeValue) => edgeValue.score === 12345),
    "score-only changes must still refresh the producer's edge content",
  );
}

async function removedPoolReaddNeverReusesOldBase(): Promise<void> {
  const family = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: univ2BlockScanState,
    ownsEdge: (edgeValue) => edgeValue.adapterId === "univ2-swap",
  });
  class CountingBackend implements BlockScanStateReadBackend {
    physicalReads = 0;
    readPoolKeys: string[] = [];
    async readCanonicalBlockActivity(
      fromExclusive: BlockSource,
      through: BlockSource,
    ): Promise<{
      readonly fromExclusive: BlockSource;
      readonly through: BlockSource;
      readonly canonicalBlocks: readonly { readonly number: number; readonly hash: string }[];
      readonly events: readonly ChainLog[];
      readonly touchedAddresses: readonly string[];
      readonly transactionCount: number;
      readonly canonicalPathFingerprint: string;
      readonly rangeFingerprint: string;
    }> {
      return Object.freeze({
        fromExclusive,
        through,
        canonicalBlocks: Object.freeze([
          Object.freeze({ number: through.number, hash: through.hash }),
        ]),
        events: Object.freeze([]),
        touchedAddresses: Object.freeze([]),
        transactionCount: 0,
        canonicalPathFingerprint: deterministicHash({
          fromExclusive,
          through,
        }),
        rangeFingerprint: deterministicHash({
          fromExclusive,
          through,
          events: Object.freeze([]),
        }),
      });
    }
    async readBatch(
      _lane: BlockScanPricingLane,
      reads: readonly StateRead[],
      control: { readonly sourceGeneration: number },
    ): Promise<readonly StateReadResult[]> {
      this.physicalReads += reads.length;
      this.readPoolKeys.push(...reads.map((read) => read.to.toLowerCase()));
      const data = reservesData(1000n, 2000n, 0);
      return reads.map((read) =>
        Object.freeze({ ...successfulRead(read, control.sourceGeneration), data })
      );
    }
    async verifyCanonicalSource(): Promise<void> {
      return;
    }
  }
  const backend = new CountingBackend();
  const coordinator = new BlockScanStateCoordinator(backend);
  const poolA = [
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, true),
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, false),
  ];
  const poolB = [
    univ2Edge(SWAP_POOL_B, TOKEN_A, TOKEN_C, true),
    univ2Edge(SWAP_POOL_B, TOKEN_A, TOKEN_C, false),
  ];
  const first = await coordinator.prepare({
    graph: univ2Graph(1, [...poolA, ...poolB]),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(first.status, "complete");
  backend.physicalReads = 0;
  const removed = await coordinator.prepare({
    graph: univ2Graph(2, poolA),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(removed.status, "complete");
  const reAdded = await coordinator.prepare({
    graph: univ2Graph(3, [...poolA, ...poolB]),
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(reAdded.status, "complete");
  assert(
    backend.readPoolKeys.includes(SWAP_POOL_B.toLowerCase()),
    "a removed-then-re-added pool must direct-read current N instead of resurrecting its old base",
  );
}

async function warmCacheRejectsFingerprintMismatchedEntries(): Promise<void> {
  const cachePath =
    `/tmp/blockscan-cache-fp-test-${Date.now()}-${Math.random()}.jsonl`;
  const familyR1 = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: {
      ...univ2BlockScanState,
    },
    strictDefinitionBoundaryHash: "test-r1",
    ownsEdge: (edgeValue) => edgeValue.adapterId === "univ2-swap",
  });
  const familyR2 = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: {
      ...univ2BlockScanState,
    },
    strictDefinitionBoundaryHash: "test-r2",
    ownsEdge: (edgeValue) => edgeValue.adapterId === "univ2-swap",
  });
  class CountingBackend implements BlockScanStateReadBackend {
    physicalReads = 0;
    async readBatch(
      _lane: BlockScanPricingLane,
      reads: readonly StateRead[],
      control: { readonly sourceGeneration: number },
    ): Promise<readonly StateReadResult[]> {
      this.physicalReads += reads.length;
      const data = reservesData(1000n, 2000n, 0);
      return reads.map((read) =>
        Object.freeze({ ...successfulRead(read, control.sourceGeneration), data })
      );
    }
    async verifyCanonicalSource(): Promise<void> {
      return;
    }
  }
  const edges = [
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, true),
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, false),
  ];
  const warmBackend = new CountingBackend();
  const warmer = new BlockScanStateCoordinator(warmBackend, { cachePath });
  const warm = await warmer.prepare({
    graph: univ2Graph(1, edges),
    families: [familyR1],
    deadlineAtMs: Date.now() + 5_000,
    cacheMode: "warm",
  });
  assert.equal(warm.status, "complete");
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (
      existsSync(cachePath) &&
      readFileSync(cachePath, "utf8").trim().length > 0
    ) {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert(existsSync(cachePath), "warm cache file must be written");

  const reuseBackend = new CountingBackend();
  const reuser = new BlockScanStateCoordinator(reuseBackend, { cachePath });
  const reused = await reuser.prepare({
    graph: univ2Graph(1, edges),
    families: [familyR1],
    deadlineAtMs: Date.now() + 5_000,
    cacheMode: "warm",
  });
  assert.equal(reused.status, "complete");
  assert.equal(
    reuseBackend.physicalReads,
    0,
    "an identical spec fingerprint must reuse the warm cache",
  );

  const mismatchBackend = new CountingBackend();
  const mismatch = new BlockScanStateCoordinator(mismatchBackend, { cachePath });
  const recompiled = await mismatch.prepare({
    graph: univ2Graph(1, edges),
    families: [familyR2],
    deadlineAtMs: Date.now() + 5_000,
    cacheMode: "warm",
  });
  assert.equal(recompiled.status, "complete");
  assert.equal(
    mismatchBackend.physicalReads,
    1,
    "a spec-fingerprint mismatch must reject the warm cache entry and re-read",
  );
  unlinkSync(cachePath);
}

async function schemaRevisionChangeForcesDirectRead(): Promise<void> {
  const compiles = { r1: 0, r2: 0 };
  const familyR1 = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: {
      ...univ2BlockScanState,
      compileStateInstance(input: CompileStateInstanceInput) {
        compiles.r1++;
        return univ2BlockScanState.compileStateInstance!(input);
      },
    },
    strictDefinitionBoundaryHash: "revision-v1",
    ownsEdge: (edgeValue) => edgeValue.adapterId === "univ2-swap",
  });
  const familyR2 = registerBlockScanStateFamily({
    familyId: "univ2-standard",
    lane: "swap",
    capability: {
      ...univ2BlockScanState,
      compileStateInstance(input: CompileStateInstanceInput) {
        compiles.r2++;
        return univ2BlockScanState.compileStateInstance!(input);
      },
    },
    strictDefinitionBoundaryHash: "revision-v2",
    ownsEdge: (edgeValue) => edgeValue.adapterId === "univ2-swap",
  });
  class CountingBackend implements BlockScanStateReadBackend {
    physicalReads = 0;
    async readCanonicalBlockActivity(
      fromExclusive: BlockSource,
      through: BlockSource,
    ): Promise<{
      readonly fromExclusive: BlockSource;
      readonly through: BlockSource;
      readonly canonicalBlocks: readonly { readonly number: number; readonly hash: string }[];
      readonly events: readonly ChainLog[];
      readonly touchedAddresses: readonly string[];
      readonly transactionCount: number;
      readonly canonicalPathFingerprint: string;
      readonly rangeFingerprint: string;
    }> {
      return Object.freeze({
        fromExclusive,
        through,
        canonicalBlocks: Object.freeze([
          Object.freeze({ number: through.number, hash: through.hash }),
        ]),
        events: Object.freeze([]),
        touchedAddresses: Object.freeze([]),
        transactionCount: 0,
        canonicalPathFingerprint: deterministicHash({
          fromExclusive,
          through,
        }),
        rangeFingerprint: deterministicHash({
          fromExclusive,
          through,
          events: Object.freeze([]),
        }),
      });
    }
    async readBatch(
      _lane: BlockScanPricingLane,
      reads: readonly StateRead[],
      control: { readonly sourceGeneration: number },
    ): Promise<readonly StateReadResult[]> {
      this.physicalReads += reads.length;
      const data = reservesData(1000n, 2000n, 0);
      return reads.map((read) =>
        Object.freeze({ ...successfulRead(read, control.sourceGeneration), data })
      );
    }
    async verifyCanonicalSource(): Promise<void> {
      return;
    }
  }
  const backend = new CountingBackend();
  const coordinator = new BlockScanStateCoordinator(backend);
  const edges = [
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, true),
    univ2Edge(SWAP_POOL, TOKEN_A, TOKEN_B, false),
  ];
  const first = await coordinator.prepare({
    graph: univ2Graph(1, edges),
    families: [familyR1],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(first.status, "complete");
  backend.physicalReads = 0;
  const second = await coordinator.prepare({
    graph: univ2Graph(2, edges),
    families: [familyR2],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(second.status, "complete");
  assert.equal(
    compiles.r2,
    1,
    "a schema-revision change must recompile the instance descriptor",
  );
  assert.equal(
    backend.physicalReads,
    1,
    "a schema-revision change must not carry the old decoded snapshot",
  );
}

function univ4Edge(
  currency0: string,
  currency1: string,
  forward: boolean,
): TokenEdge {
  const v4PoolKey = {
    currency0,
    currency1,
    fee: 3_000,
    tickSpacing: 60,
    hooks: "0x0000000000000000000000000000000000000000",
  };
  return {
    adapterId: "univ4-unlock",
    target: SINGLETON_MANAGER,
    tokenIn: forward ? currency0 : currency1,
    tokenOut: forward ? currency1 : currency0,
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
    v4PoolKey,
  };
}

function univ4Graph(
  generation: number,
  edges: readonly TokenEdge[],
) {
  const sourceBlock = SOURCE_BLOCK + generation;
  return createVerifiedGraphView({
    id: `univ4-instance-graph-${generation}`,
    generation,
    sourceBlock,
    sourceBlockHash: `0x${generation.toString(16).padStart(64, "0")}`,
    completenessWatermark: sourceBlock,
    perSourceCoverage: [{
      familyId: "univ4",
      sourceId: "univ4-instance-fixture",
      sourceFingerprint: "univ4-instance-fixture-v1",
      completeThroughBlock: sourceBlock,
      completeThroughHash: `0x${generation.toString(16).padStart(64, "0")}`,
    }],
    edges,
  });
}

async function univ4InstanceParityWithFullCompile(): Promise<void> {
  const edges = Object.freeze([
    univ4Edge(TOKEN_A, TOKEN_B, true),
    univ4Edge(TOKEN_A, TOKEN_B, false),
    univ4Edge(TOKEN_A, TOKEN_C, true),
    univ4Edge(TOKEN_A, TOKEN_C, false),
  ]);
  const full = univ4BlockScanState.compileStaticSchema({
    edges,
    deadlineAtMs: Date.now() + 5_000,
    signal: new AbortController().signal,
  });
  const instances = new Map<string, unknown>();
  const byPool = new Map<string, TokenEdge[]>();
  for (const edgeValue of edges) {
    const poolId = univ4BlockScanState.stateKey(edgeValue);
    const group = byPool.get(poolId) ?? [];
    group.push(edgeValue);
    byPool.set(poolId, group);
  }
  for (const [poolId, group] of byPool) {
    const spec = Object.freeze({
      key: `univ4\u001f${poolId}`,
      familyId: "univ4",
      stateKey: poolId,
      edges: Object.freeze(group),
      staticBindingFingerprint: stateSchemaFingerprint(group),
      snapshotCompatibilityFingerprint: stateSchemaFingerprint(group),
    });
    const compiled = univ4BlockScanState.compileStateInstance({
      spec,
      control: {
        deadlineAtMs: Date.now() + 5_000,
        signal: new AbortController().signal,
      },
      sourceBlock: SOURCE_BLOCK,
      sourceBlockHash: SOURCE_HASH,
    });
    instances.set(poolId, compiled.opaque);
  }
  const assembled = univ4BlockScanState.assembleSchema(instances);
  assert.deepEqual(
    [...assembled.pools.keys()].sort(),
    [...full.pools.keys()].sort(),
  );
  for (const poolId of assembled.pools.keys()) {
    assert.deepEqual(assembled.pools.get(poolId), full.pools.get(poolId));
  }
}

async function univ4InstanceModeRecompilesOnlyNewPool(): Promise<void> {
  const calls = { compiles: 0 };
  const family = registerBlockScanStateFamily({
    familyId: "univ4",
    lane: "swap",
    capability: {
      ...univ4BlockScanState,
      compileStateInstance(input: CompileStateInstanceInput) {
        calls.compiles++;
        return univ4BlockScanState.compileStateInstance!(input);
      },
    },
    ownsEdge: (edgeValue) => edgeValue.adapterId === "univ4-unlock",
  });
  class UniV4Backend implements BlockScanStateReadBackend {
    async readBatch(
      _lane: BlockScanPricingLane,
      reads: readonly StateRead[],
      control: { readonly sourceGeneration: number },
    ): Promise<readonly StateReadResult[]> {
      return reads.map((read) => {
        let data = "0x";
        if (read.id.includes("slot0:")) {
          data =
            `0x${(1n << 96n).toString(16).padStart(64, "0")}` +
            `${"0".padStart(64, "0")}` +
            `${"0".padStart(64, "0")}` +
            `${(3_000).toString(16).padStart(64, "0")}`;
        } else if (read.id.includes("liquidity:")) {
          data = `0x${(1_000n).toString(16).padStart(64, "0")}`;
        }
        return Object.freeze({
          ...successfulRead(read, control.sourceGeneration),
          data,
        });
      });
    }

    async verifyCanonicalSource(): Promise<void> {
      return;
    }
  }
  const coordinator = new BlockScanStateCoordinator(new UniV4Backend());
  const graphA = univ4Graph(1, [
    univ4Edge(TOKEN_A, TOKEN_B, true),
    univ4Edge(TOKEN_A, TOKEN_B, false),
  ]);
  const first = await coordinator.prepare({
    graph: graphA,
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(first.status, "complete");
  assert.equal(calls.compiles, 1, "first generation compiles the only pool");

  const graphAB = univ4Graph(2, [
    ...graphA.edges,
    univ4Edge(TOKEN_A, TOKEN_C, true),
    univ4Edge(TOKEN_A, TOKEN_C, false),
  ]);
  const second = await coordinator.prepare({
    graph: graphAB,
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(second.status, "complete");
  assert.equal(
    calls.compiles,
    2,
    "adding a pool must recompile only the new instance",
  );
}

function univ3Edge(
  pool: string,
  token0: string,
  token1: string,
  forward: boolean,
): TokenEdge {
  return {
    adapterId: "univ3-swap",
    target: pool,
    tokenIn: forward ? token0 : token1,
    tokenOut: forward ? token1 : token0,
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
    poolToken0: token0,
    poolToken1: token1,
    v3Fee: 3_000,
    v3TickSpacing: 60,
    factory: UNIV3_FACTORY,
  };
}

function univ3Graph(
  generation: number,
  edges: readonly TokenEdge[],
) {
  const sourceBlock = SOURCE_BLOCK + generation;
  return createVerifiedGraphView({
    id: `univ3-instance-graph-${generation}`,
    generation,
    sourceBlock,
    sourceBlockHash: `0x${generation.toString(16).padStart(64, "0")}`,
    completenessWatermark: sourceBlock,
    perSourceCoverage: [{
      familyId: "univ3-standard",
      sourceId: "univ3-instance-fixture",
      sourceFingerprint: "univ3-instance-fixture-v1",
      completeThroughBlock: sourceBlock,
      completeThroughHash: `0x${generation.toString(16).padStart(64, "0")}`,
    }],
    edges,
  });
}

function v3Slot0Data(): string {
  const word = (value: bigint | number | boolean): string =>
    BigInt(value).toString(16).padStart(64, "0");
  return `0x${word(1n << 96n)}${word(0)}${word(0)}${word(0)}${word(0)}` +
    `${word(0)}${word(1)}`;
}

function v3BindingData(pool: string): string {
  return `0x${pool.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

function univ3BindingResultFor(
  pool: string,
  generation: number,
  sourceBlock: number,
  sourceBlockHash: string,
): StateReadResult {
  return Object.freeze({
    id: `v3-factory-binding:${pool.toLowerCase()}`,
    ok: true as const,
    sourceBlock,
    sourceBlockHash,
    provenance: Object.freeze({
      kind: "eip1898" as const,
      source: Object.freeze({
        number: sourceBlock,
        hash: sourceBlockHash,
        generation,
      }),
      requireCanonical: true as const,
    }),
    data: v3BindingData(pool),
  });
}

async function univ3InstanceParityWithFullCompile(): Promise<void> {
  const sourceBlock = SOURCE_BLOCK + 1;
  const sourceBlockHash = `0x${"1".padStart(64, "0")}`;
  const edges = Object.freeze([
    univ3Edge(SWAP_POOL, TOKEN_A, TOKEN_B, true),
    univ3Edge(SWAP_POOL, TOKEN_A, TOKEN_B, false),
    univ3Edge(SWAP_POOL_B, TOKEN_A, TOKEN_C, true),
    univ3Edge(SWAP_POOL_B, TOKEN_A, TOKEN_C, false),
  ]);
  const full = univ3BlockScanState.compileStaticSchema({
    edges,
    deadlineAtMs: Date.now() + 5_000,
    signal: new AbortController().signal,
  });
  const staticReads = univ3BlockScanState.buildStaticSchemaReads!({
    sourceBlock,
    sourceBlockHash,
    schema: full,
    edges,
  });
  const staticResults = staticReads.map((read) => {
    const pool = read.id.replace("v3-factory-binding:", "");
    return univ3BindingResultFor(
      pool,
      1,
      sourceBlock,
      sourceBlockHash,
    );
  });
  const hydrated = univ3BlockScanState.hydrateStaticSchema!(
    full,
    staticResults,
  );

  const instances = new Map<string, unknown>();
  const byPool = new Map<string, TokenEdge[]>();
  for (const edgeValue of edges) {
    const pool = univ3BlockScanState.stateKey(edgeValue);
    const group = byPool.get(pool) ?? [];
    group.push(edgeValue);
    byPool.set(pool, group);
  }
  for (const [pool, group] of byPool) {
    const spec = Object.freeze({
      key: `univ3-standard\u001f${pool}`,
      familyId: "univ3-standard",
      stateKey: pool,
      edges: Object.freeze(group),
      staticBindingFingerprint: stateSchemaFingerprint(group),
      snapshotCompatibilityFingerprint: stateSchemaFingerprint(group),
    });
    const compiled = await univ3BlockScanState.compileStateInstance({
      spec,
      control: {
        deadlineAtMs: Date.now() + 5_000,
        signal: new AbortController().signal,
      },
      sourceBlock,
      sourceBlockHash,
      readStatic: async (reads) => {
        assert.equal(reads.length, 1);
        const read = reads[0];
        const pool = read.id.replace("v3-factory-binding:", "");
        return Object.freeze([
          univ3BindingResultFor(pool, 1, sourceBlock, sourceBlockHash),
        ]);
      },
    });
    instances.set(pool, compiled.opaque);
  }
  const assembled = univ3BlockScanState.assembleSchema(instances);
  assert.deepEqual(
    [...assembled.pools.keys()].sort(),
    [...hydrated.pools.keys()].sort(),
  );
  for (const pool of assembled.pools.keys()) {
    assert.deepEqual(assembled.pools.get(pool), hydrated.pools.get(pool));
  }
}

async function univ3InstanceModeRecompilesOnlyNewPool(): Promise<void> {
  const calls = { compiles: 0 };
  const family = registerBlockScanStateFamily({
    familyId: "univ3-standard",
    lane: "swap",
    capability: {
      ...univ3BlockScanState,
      compileStateInstance: async (input: CompileStateInstanceInput) => {
        calls.compiles++;
        return univ3BlockScanState.compileStateInstance!(input);
      },
    },
    ownsEdge: (edgeValue) => edgeValue.adapterId === "univ3-swap",
  });
  class UniV3Backend implements BlockScanStateReadBackend {
    async readBatch(
      _lane: BlockScanPricingLane,
      reads: readonly StateRead[],
      control: { readonly sourceGeneration: number },
    ): Promise<readonly StateReadResult[]> {
      return reads.map((read) => {
        let data = "0x";
        if (read.id.includes("slot0:")) {
          data = v3Slot0Data();
        } else if (read.id.includes("liquidity:")) {
          data = `0x${(1_000n).toString(16).padStart(64, "0")}`;
        } else if (read.id.includes("v3-factory-binding:")) {
          const pool = read.id.split("v3-factory-binding:")[1] ?? "";
          data = v3BindingData(pool);
        }
        return Object.freeze({
          ...successfulRead(read, control.sourceGeneration),
          data,
        });
      });
    }

    async verifyCanonicalSource(): Promise<void> {
      return;
    }
  }
  const coordinator = new BlockScanStateCoordinator(new UniV3Backend());
  const graphA = univ3Graph(1, [
    univ3Edge(SWAP_POOL, TOKEN_A, TOKEN_B, true),
    univ3Edge(SWAP_POOL, TOKEN_A, TOKEN_B, false),
  ]);
  const first = await coordinator.prepare({
    graph: graphA,
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(first.status, "complete");
  assert.equal(calls.compiles, 1, "first generation compiles the only pool");

  const graphAB = univ3Graph(2, [
    ...graphA.edges,
    univ3Edge(SWAP_POOL_B, TOKEN_A, TOKEN_C, true),
    univ3Edge(SWAP_POOL_B, TOKEN_A, TOKEN_C, false),
  ]);
  const second = await coordinator.prepare({
    graph: graphAB,
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(second.status, "complete");
  assert.equal(
    calls.compiles,
    2,
    "adding a pool must recompile only the new instance",
  );
}

function dodoEdge(
  pool: string,
  baseToken: string,
  quoteToken: string,
  forward: boolean,
): TokenEdge {
  return {
    adapterId: "dodo-v2-swap",
    target: pool,
    tokenIn: forward ? baseToken : quoteToken,
    tokenOut: forward ? quoteToken : baseToken,
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
    poolToken0: baseToken,
    poolToken1: quoteToken,
  };
}

function dodoGraph(
  generation: number,
  edges: readonly TokenEdge[],
) {
  const sourceBlock = SOURCE_BLOCK + generation;
  return createVerifiedGraphView({
    id: `dodo-instance-graph-${generation}`,
    generation,
    sourceBlock,
    sourceBlockHash: `0x${generation.toString(16).padStart(64, "0")}`,
    completenessWatermark: sourceBlock,
    perSourceCoverage: [{
      familyId: "custom-swap:dodo-v2",
      sourceId: "dodo-instance-fixture",
      sourceFingerprint: "dodo-instance-fixture-v1",
      completeThroughBlock: sourceBlock,
      completeThroughHash: `0x${generation.toString(16).padStart(64, "0")}`,
    }],
    edges,
  });
}

async function dodoInstanceParityWithFullCompile(): Promise<void> {
  const sourceBlock = SOURCE_BLOCK + 1;
  const sourceBlockHash = `0x${"1".padStart(64, "0")}`;
  const edges = Object.freeze([
    dodoEdge(SWAP_POOL, TOKEN_A, TOKEN_B, true),
    dodoEdge(SWAP_POOL, TOKEN_A, TOKEN_B, false),
    dodoEdge(SWAP_POOL_B, TOKEN_A, TOKEN_C, true),
    dodoEdge(SWAP_POOL_B, TOKEN_A, TOKEN_C, false),
  ]);
  const full = dodoV2BlockScanState.compileStaticSchema({
    edges,
    deadlineAtMs: Date.now() + 5_000,
    signal: new AbortController().signal,
  });
  const staticReads = dodoV2BlockScanState.buildStaticSchemaReads!({
    sourceBlock,
    sourceBlockHash,
    schema: full,
    edges,
  });
  const staticResults = staticReads.map((read) =>
    Object.freeze({
      ...successfulRead(read, 1),
      data: `0x${(18).toString(16).padStart(64, "0")}`,
    })
  );
  const hydrated = dodoV2BlockScanState.hydrateStaticSchema!(
    full,
    staticResults,
  );

  const instances = new Map<string, unknown>();
  const byPool = new Map<string, TokenEdge[]>();
  for (const edgeValue of edges) {
    const pool = dodoV2BlockScanState.stateKey(edgeValue);
    const group = byPool.get(pool) ?? [];
    group.push(edgeValue);
    byPool.set(pool, group);
  }
  for (const [pool, group] of byPool) {
    const spec = Object.freeze({
      key: `custom-swap:dodo-v2\u001f${pool}`,
      familyId: "custom-swap:dodo-v2",
      stateKey: pool,
      edges: Object.freeze(group),
      staticBindingFingerprint: stateSchemaFingerprint(group),
      snapshotCompatibilityFingerprint: stateSchemaFingerprint(group),
    });
    const compiled = await dodoV2BlockScanState.compileStateInstance({
      spec,
      control: {
        deadlineAtMs: Date.now() + 5_000,
        signal: new AbortController().signal,
      },
      sourceBlock,
      sourceBlockHash,
      readStatic: async (reads) =>
        Object.freeze(reads.map((read) =>
          Object.freeze({
            ...successfulRead(read, 1),
            data: `0x${(18).toString(16).padStart(64, "0")}`,
          })
        )),
    });
    instances.set(pool, compiled.opaque);
  }
  const assembled = dodoV2BlockScanState.assembleSchema(instances);
  assert.deepEqual(
    [...assembled.groups.keys()].sort(),
    [...hydrated.groups.keys()].sort(),
  );
  for (const pool of assembled.groups.keys()) {
    assert.deepEqual(assembled.groups.get(pool), hydrated.groups.get(pool));
  }
}

async function dodoInstanceModeRecompilesOnlyNewPool(): Promise<void> {
  const calls = { compiles: 0 };
  const family = registerBlockScanStateFamily({
    familyId: "custom-swap:dodo-v2",
    lane: "swap",
    capability: {
      ...dodoV2BlockScanState,
      compileStateInstance: async (input: CompileStateInstanceInput) => {
        calls.compiles++;
        return dodoV2BlockScanState.compileStateInstance!(input);
      },
    },
    ownsEdge: (edgeValue) => edgeValue.adapterId === "dodo-v2-swap",
  });
  class DodoBackend implements BlockScanStateReadBackend {
    async readBatch(
      _lane: BlockScanPricingLane,
      reads: readonly StateRead[],
      control: { readonly sourceGeneration: number },
    ): Promise<readonly StateReadResult[]> {
      return reads.map((read) => {
        const data = read.id.includes("dodo-static-decimals:")
          ? `0x${(18).toString(16).padStart(64, "0")}`
          : "0x";
        return Object.freeze({
          ...successfulRead(read, control.sourceGeneration),
          data,
        });
      });
    }

    async verifyCanonicalSource(): Promise<void> {
      return;
    }
  }
  const coordinator = new BlockScanStateCoordinator(new DodoBackend());
  const graphA = dodoGraph(1, [
    dodoEdge(SWAP_POOL, TOKEN_A, TOKEN_B, true),
    dodoEdge(SWAP_POOL, TOKEN_A, TOKEN_B, false),
  ]);
  await coordinator.prepare({
    graph: graphA,
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(calls.compiles, 1, "first generation compiles the only pool");

  const graphAB = dodoGraph(2, [
    ...graphA.edges,
    dodoEdge(SWAP_POOL_B, TOKEN_A, TOKEN_C, true),
    dodoEdge(SWAP_POOL_B, TOKEN_A, TOKEN_C, false),
  ]);
  await coordinator.prepare({
    graph: graphAB,
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(
    calls.compiles,
    2,
    "adding a pool must recompile only the new instance",
  );
}

function angstromEdge(
  pool: string,
  currency0: string,
  currency1: string,
  forward: boolean,
): TokenEdge {
  const v4PoolKey = {
    currency0,
    currency1,
    fee: 3_000,
    tickSpacing: 60,
    hooks: "0x0000000000000000000000000000000000000000",
  };
  return {
    adapterId: "angstrom-v4-swap",
    target: pool,
    tokenIn: forward ? currency0 : currency1,
    tokenOut: forward ? currency1 : currency0,
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
    v4PoolKey,
  };
}

function angstromGraph(
  generation: number,
  edges: readonly TokenEdge[],
) {
  const sourceBlock = SOURCE_BLOCK + generation;
  return createVerifiedGraphView({
    id: `angstrom-instance-graph-${generation}`,
    generation,
    sourceBlock,
    sourceBlockHash: `0x${generation.toString(16).padStart(64, "0")}`,
    completenessWatermark: sourceBlock,
    perSourceCoverage: [{
      familyId: "custom-swap:angstrom-v4",
      sourceId: "angstrom-instance-fixture",
      sourceFingerprint: "angstrom-instance-fixture-v1",
      completeThroughBlock: sourceBlock,
      completeThroughHash: `0x${generation.toString(16).padStart(64, "0")}`,
    }],
    edges,
  });
}

async function angstromInstanceParityWithFullCompile(): Promise<void> {
  const sourceBlock = SOURCE_BLOCK + 1;
  const sourceBlockHash = `0x${"1".padStart(64, "0")}`;
  const edges = Object.freeze([
    angstromEdge(SWAP_POOL, TOKEN_A, TOKEN_B, true),
    angstromEdge(SWAP_POOL, TOKEN_A, TOKEN_B, false),
    angstromEdge(SWAP_POOL_B, TOKEN_A, TOKEN_C, true),
    angstromEdge(SWAP_POOL_B, TOKEN_A, TOKEN_C, false),
  ]);
  const full = angstromSpotBlockScanState.compileStaticSchema({
    edges,
    deadlineAtMs: Date.now() + 5_000,
    signal: new AbortController().signal,
  });
  const instances = new Map<string, unknown>();
  const byPool = new Map<string, TokenEdge[]>();
  for (const edgeValue of edges) {
    const pool = angstromSpotBlockScanState.stateKey(edgeValue);
    const group = byPool.get(pool) ?? [];
    group.push(edgeValue);
    byPool.set(pool, group);
  }
  for (const [pool, group] of byPool) {
    const spec = Object.freeze({
      key: `custom-swap:angstrom-v4\u001f${pool}`,
      familyId: "custom-swap:angstrom-v4",
      stateKey: pool,
      edges: Object.freeze(group),
      staticBindingFingerprint: stateSchemaFingerprint(group),
      snapshotCompatibilityFingerprint: stateSchemaFingerprint(group),
    });
    const compiled = angstromSpotBlockScanState.compileStateInstance({
      spec,
      control: {
        deadlineAtMs: Date.now() + 5_000,
        signal: new AbortController().signal,
      },
      sourceBlock,
      sourceBlockHash,
    });
    assert.equal(compiled.familyId, "custom-swap:angstrom-v4");
    instances.set(pool, compiled.opaque);
  }
  const assembled = angstromSpotBlockScanState.assembleSchema(instances);
  assert.deepEqual(
    [...assembled.pools.keys()].sort(),
    [...full.pools.keys()].sort(),
  );
  for (const pool of assembled.pools.keys()) {
    assert.deepEqual(assembled.pools.get(pool), full.pools.get(pool));
  }
}

async function angstromInstanceModeRecompilesOnlyNewPool(): Promise<void> {
  const calls = { compiles: 0 };
  const family = registerBlockScanStateFamily({
    familyId: "custom-swap:angstrom-v4",
    lane: "swap",
    capability: {
      ...angstromSpotBlockScanState,
      compileStateInstance(input: CompileStateInstanceInput) {
        calls.compiles++;
        return angstromSpotBlockScanState.compileStateInstance(input);
      },
    },
    ownsEdge: (edgeValue) => edgeValue.adapterId === "angstrom-v4-swap",
  });
  class AngstromBackend implements BlockScanStateReadBackend {
    async readBatch(
      _lane: BlockScanPricingLane,
      reads: readonly StateRead[],
      control: { readonly sourceGeneration: number },
    ): Promise<readonly StateReadResult[]> {
      return reads.map((read) => {
        let data = "0x";
        if (read.id.includes("slot0:")) {
          data =
            `0x${(1n << 96n).toString(16).padStart(64, "0")}` +
            `${"0".padStart(64, "0")}` +
            `${"0".padStart(64, "0")}` +
            `${(3_000).toString(16).padStart(64, "0")}`;
        } else if (read.id.includes("liquidity:")) {
          data = `0x${(1_000n).toString(16).padStart(64, "0")}`;
        }
        return Object.freeze({
          ...successfulRead(read, control.sourceGeneration),
          data,
        });
      });
    }

    async verifyCanonicalSource(): Promise<void> {
      return;
    }
  }
  const coordinator = new BlockScanStateCoordinator(new AngstromBackend());
  const graphA = angstromGraph(1, [
    angstromEdge(SWAP_POOL, TOKEN_A, TOKEN_B, true),
    angstromEdge(SWAP_POOL, TOKEN_A, TOKEN_B, false),
  ]);
  const first = await coordinator.prepare({
    graph: graphA,
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.notEqual(first.status, "incomplete");
  assert.equal(calls.compiles, 1, "first generation compiles the only pool");

  const graphAB = angstromGraph(2, [
    ...graphA.edges,
    angstromEdge(SWAP_POOL_B, TOKEN_A, TOKEN_C, true),
    angstromEdge(SWAP_POOL_B, TOKEN_A, TOKEN_C, false),
  ]);
  const second = await coordinator.prepare({
    graph: graphAB,
    families: [family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.notEqual(second.status, "incomplete");
  assert.equal(
    calls.compiles,
    2,
    "adding a pool must recompile only the new instance",
  );
}

await phasedProofsSettleBeforeSiblingReads();
await activityRangeIsCappedToEightBlocks();
await headPassDoesNotSupersedeActiveBootstrap();
await completeAndDeterministic();
await simulationSemanticsParticipateInDedupIdentity();
await replayResetDropsOnlyDynamicPublication();
await failedFamilyPublishesHealthyFamiliesAsDegraded();
await graphIncompleteSwapFamilyPreservesHealthySibling();
await graphSourceHashMismatchBlocksOwningFamily();
await laggingSwapProofFailureDoesNotFallbackWholeFamily();
await hotRecoveryIsBoundedPerFamily();
await derivedSwapIncrementalCarriesUntouchedPools();
await singletonActivityIsResolvedCentrallyByPoolId();
await oneFailedStateKeyPreservesHealthySiblingInstance();
await incrementalRefreshIsStateKeyLocal();
await partialPublishedSnapshotDoesNotEraseRecoveryBases();
await persistentDecodeFailuresAreDeferredAndRetried();
await familyDeadlinePreservesProvenSiblingStateKey();
await generationAbortStillErasesFamilyPartial();
await familyLocalCompileDeadlineDoesNotCacheLateSchema();
await familyLocalReadDeadlineFencesLateBackendResult();
await explicitFamilySettleDeadlinePreservesGeneration();
await deadlineAndExternalAbort();
await generationFence();
await dependentReadClosureIsExplicit();
await staticSchemaReadsAreCachedAndDynamicReadsStayCurrent();
await casRejectedGenerationDoesNotPublishCompileCache();
await supersededGenerationDoesNotPublishCompileCache();
await successfulCompileStaysUnpublishedWithGeneration();
await immutableForkNeedsBackendAttestation();
await protocolActivityPlanDrivesDirtyDirectCarry();
await protocolActivityFailureFailsClosedToDirect();
await univ2InstanceParityWithFullCompile();
await univ2InstanceModeRecompilesOnlyNewPool();
await rejectedInstanceGenerationDoesNotBecomePrevious();
await sharedBindingParticipatesInInstanceFingerprint();
await snapshotCompatibilityChangeForcesDirectRead();
await alwaysDirectCarryPolicyNeverCarries();
await scoreOnlyChangeDoesNotRecompileButRefreshesEdges();
await removedPoolReaddNeverReusesOldBase();
await warmCacheRejectsFingerprintMismatchedEntries();
await schemaRevisionChangeForcesDirectRead();
await univ4InstanceParityWithFullCompile();
await univ4InstanceModeRecompilesOnlyNewPool();
await univ3InstanceParityWithFullCompile();
await univ3InstanceModeRecompilesOnlyNewPool();
await dodoInstanceParityWithFullCompile();
await dodoInstanceModeRecompilesOnlyNewPool();
await angstromInstanceParityWithFullCompile();
await angstromInstanceModeRecompilesOnlyNewPool();
purityHook();
console.log("blockscan-state-coordinator PASS");
