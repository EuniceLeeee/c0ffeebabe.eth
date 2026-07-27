import assert from "node:assert/strict";
import {
  BlockScanStateCoordinator,
  type BlockScanFamilyTelemetry,
  type BlockScanStateReadBackend,
} from "../blockscan-state-coordinator.js";
import type { TokenEdge } from "../planner/token-graph.js";
import {
  assertPureSynchronousDeriveMids,
  blockScanEdgeKey,
  createMutationQueryDescriptor,
  createVerifiedGraphView,
  deterministicHash,
  registerBlockScanStateFamily,
  type BlockSource,
  type BlockScanPricingLane,
  type BlockScanStateCapability,
  type CanonicalMutationRange,
  type ChainLog,
  type MutationQueryDescriptor,
  type RegisteredBlockScanStateFamily,
  type StateRead,
  type StateReadResult,
} from "../venues/blockscan-state-capability.js";
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
  readonly mutationTargets = new Set<string>();
  rangeFailure = false;

  async readBatch(
    _lane: BlockScanPricingLane,
    reads: readonly StateRead[],
    control: {
      sourceGeneration: number;
    },
  ): Promise<readonly StateReadResult[]> {
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
  });
  assert.equal(result.status, "degraded");
  if (result.status !== "degraded") {
    throw new Error("expected family-local swap graph degradation");
  }
  assert.deepEqual(result.snapshot.resolvedFamilyIds, ["protocol:fixture"]);
  assert.deepEqual(result.snapshot.incompleteFamilyIds, ["univ2-standard"]);
  assert.equal(result.snapshot.mids.size, 1);
  assert(
    readTargets.every((target) => target === PROTOCOL_POOL.toLowerCase()),
    "an incomplete swap family must issue no state reads while a healthy sibling remains current-N",
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
    "classified-direct",
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
    [SWAP_POOL, SWAP_POOL_B, SWAP_POOL_C]
      .map((value) => value.toLowerCase())
      .sort(),
    "an unknown classifier read key forces full-family direct reads",
  );
  assert.deepEqual(
    [...buildTargets].sort(),
    [SWAP_POOL, SWAP_POOL_B, SWAP_POOL_C]
      .map((value) => value.toLowerCase())
      .sort(),
  );
  assert.equal(
    familyTelemetry(classifierMismatch).fullFallbackReason,
    "mutation-classifier-read-set-mismatch",
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
      fallback: familyTelemetry(fullFallback).fullFallbackReason,
    },
    {
      carry: 0,
      direct: 3,
      missing: 0,
      fallback: "mutation-range-failed",
    },
  );
  assert.equal(
    familyTelemetry(fullFallback).fullFallbackDetail,
    "range:unknown",
    "range fallback preserves a sanitized failure class without raw backend text",
  );
  assert(
    (familyTelemetry(fullFallback).incrementalDescriptorMs ?? -1) >= 0 &&
      (familyTelemetry(fullFallback).incrementalRangeMs ?? -1) >= 0 &&
      (familyTelemetry(fullFallback).incrementalClassifierMs ?? -1) >= 0,
    "incremental phase telemetry must be monotonic and non-negative",
  );
}

async function emptyPublishedSnapshotDoesNotEraseRecoveryBase(): Promise<void> {
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
      graph: incrementalGraph(generation, [swapForward, swapReverse]),
      families: [family],
      deadlineAtMs: Date.now() + 2_000,
    });

  const base = await prepare(1);
  assert.equal(base.status, "complete");
  if (base.status !== "complete") throw new Error("expected recovery base");
  assert.equal(base.snapshot.stateByStateKey.size, 1);

  backend.mutationTargets.add(SWAP_POOL.toLowerCase());
  backend.failTargets.add(SWAP_POOL.toLowerCase());
  const empty = await prepare(2);
  assert.equal(empty.status, "degraded");
  if (empty.status !== "degraded") throw new Error("expected empty degradation");
  assert.equal(
    empty.snapshot.stateByStateKey.size,
    0,
    "the current PricingView must not publish the stale base",
  );
  assert.equal(coordinator.latestSnapshot(), empty.snapshot);

  backend.mutationTargets.clear();
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
    "a complete quiet proof must recover without a direct-N read",
  );
  assert.deepEqual(
    backend.rangeSources,
    [{
      number: SOURCE_BLOCK + 1,
      hash: `0x${"1".padStart(64, "0")}`,
      generation: 1,
    }],
    "recovery must prove the full gap from the last good source, not the empty N shell",
  );
  const state = recovered.snapshot.stateByStateKey.get(
    `univ2-standard\u001f${SWAP_POOL.toLowerCase()}`,
  );
  assert.equal(state?.source.number, SOURCE_BLOCK + 3);
  assert.equal(state?.refreshMode, "carry-forward");
  const freshness = state?.freshnessByReadKey.get("state");
  assert.equal(freshness?.kind, "carry-forward");
  if (freshness?.kind === "carry-forward") {
    assert.equal(freshness.previousSource.number, SOURCE_BLOCK + 1);
    assert.equal(freshness.completeThroughBlock, SOURCE_BLOCK + 3);
  }
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

async function publishCasFailureDoesNotCommitStaticSchema(): Promise<void> {
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
    2,
    "a generation rejected by canonical CAS may not populate schema cache",
  );
  assert.equal(calls.staticReads, 2, "orphan-fork static metadata must be reread");

  const third = await coordinator.prepare({
    graph: graph(3, true, [swapForward, swapReverse]),
    families: [family],
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(third.status, "complete");
  assert.equal(calls.compiles, 2, "a published canonical schema remains reusable");
  assert.equal(calls.staticReads, 2, "published static metadata remains cached");
  assert.equal(calls.dynamicReads, 3, "dynamic state remains current each generation");
  assert.equal(
    calls.verifies,
    3,
    "canonical verification is exactly once per pricing generation",
  );
}

async function supersededGenerationCannotDonateStaticSchema(): Promise<void> {
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
    2,
    "a superseded generation may not donate its staged schema",
  );
  assert.equal(calls.staticReads, 2, "successor rereads its own static metadata");
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

await completeAndDeterministic();
await replayResetDropsOnlyDynamicPublication();
await failedFamilyPublishesHealthyFamiliesAsDegraded();
await graphIncompleteSwapFamilyPreservesHealthySibling();
await oneFailedStateKeyPreservesHealthySiblingInstance();
await incrementalRefreshIsStateKeyLocal();
await emptyPublishedSnapshotDoesNotEraseRecoveryBase();
await familyLocalCompileDeadlineDoesNotCacheLateSchema();
await familyLocalReadDeadlineFencesLateBackendResult();
await explicitFamilySettleDeadlinePreservesGeneration();
await deadlineAndExternalAbort();
await generationFence();
await dependentReadClosureIsExplicit();
await staticSchemaReadsAreCachedAndDynamicReadsStayCurrent();
await publishCasFailureDoesNotCommitStaticSchema();
await supersededGenerationCannotDonateStaticSchema();
await immutableForkNeedsBackendAttestation();
purityHook();
console.log("blockscan-state-coordinator PASS");
