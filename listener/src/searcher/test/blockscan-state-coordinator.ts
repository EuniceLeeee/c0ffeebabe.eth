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
  createVerifiedGraphView,
  registerBlockScanStateFamily,
  type BlockScanPricingLane,
  type BlockScanStateCapability,
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
const SWAP_POOL = "0x0000000000000000000000000000000000000011";
const SWAP_POOL_B = "0x0000000000000000000000000000000000000033";
const PROTOCOL_POOL = "0x0000000000000000000000000000000000000022";

interface FakeSnapshot {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const swapForward = edge("swap-action", SWAP_POOL, TOKEN_A, TOKEN_B);
const swapReverse = edge("swap-action", SWAP_POOL, TOKEN_B, TOKEN_A);
const swapBForward = edge("swap-action", SWAP_POOL_B, TOKEN_A, TOKEN_C);
const swapBReverse = edge("swap-action", SWAP_POOL_B, TOKEN_C, TOKEN_A);
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
    result.familyTelemetry?.map(({ wallMs: _wallMs, ...telemetry }) => telemetry),
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
    result.familyTelemetry?.map(({ wallMs: _wallMs, ...telemetry }) => telemetry),
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

  const graphIncomplete = await new BlockScanStateCoordinator(backend).prepare({
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
    ["univ2-standard"],
    "a complete sibling family must remain usable",
  );
  assert.deepEqual(
    graphIncomplete.snapshot.incompleteFamilyIds,
    ["protocol:fixture"],
    "the graph issue must remain owned by its family",
  );
  assert.equal(
    graphIncomplete.snapshot.mids.size,
    2,
    "an incomplete family must contribute no priced edges",
  );
  assert.deepEqual(
    graphIncomplete.familyTelemetry?.map(
      ({ wallMs: _wallMs, ...telemetry }) => telemetry,
    ),
    [
      {
        familyId: "protocol:fixture",
        lane: "protocol",
        uniqueStateKeys: 1,
        reads: 0,
        batches: 0,
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
    "graph-incomplete families are visible even though their lane never ran",
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
    result.familyTelemetry?.map(({ wallMs: _wallMs, ...telemetry }) => telemetry),
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
      completedRound <= (overflow ? 3 : 2)
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
      assert.equal(results.length, 4);
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
    ],
    "four executed read rounds must be followed by an empty closure probe",
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
await oneFailedStateKeyPreservesHealthySiblingInstance();
await familyLocalCompileDeadlineDoesNotCacheLateSchema();
await familyLocalReadDeadlineFencesLateBackendResult();
await deadlineAndExternalAbort();
await generationFence();
await dependentReadClosureIsExplicit();
await staticSchemaReadsAreCachedAndDynamicReadsStayCurrent();
await immutableForkNeedsBackendAttestation();
purityHook();
console.log("blockscan-state-coordinator PASS");
