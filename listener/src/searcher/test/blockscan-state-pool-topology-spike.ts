import assert from "node:assert/strict";
import {
  BlockScanStateCoordinator,
  type BlockScanStateReadBackend,
} from "../blockscan-state-coordinator.js";
import type { CanonicalBlockActivity } from "../blockscan-state-read-backend.js";
import type { TokenEdge } from "../planner/token-graph.js";
import {
  createVerifiedGraphView,
  deterministicHash,
  registerBlockScanStateFamily,
  stateSchemaFingerprint,
  type BlockSource,
  type CompileStateInstanceInput,
  type PoolTopologySpikeReceipt,
  type StateRead,
  type StateReadResult,
} from "../venues/blockscan-state-capability.js";
import { univ3BlockScanState } from "../venues/swaps/univ3-standard.js";

const FAMILY_ID = "univ3-standard";
const ADAPTER_ID = "univ3-swap";
const SOURCE_BLOCK = 25_700_000;
const FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const BASE_POOL_COUNT = 5_000;

interface Counters {
  readonly compiledKeys: string[];
  readonly staticReadIds: string[];
  readonly currentReadTargets: string[];
  familyWideCompilerInvocations: number;
  familyWideAssemblyInvocations: number;
  instanceAssemblyInvocations: number;
}

function address(index: number): string {
  return `0x${(0x3000_0000n + BigInt(index)).toString(16).padStart(40, "0")}`;
}

function token0Address(index: number): string {
  return `0x${(0x1000_0000n + BigInt(index)).toString(16).padStart(40, "0")}`;
}

function token1Address(index: number): string {
  return `0x${(0x2000_0000n + BigInt(index)).toString(16).padStart(40, "0")}`;
}

function edge(pool: string, index: number, forward: boolean): TokenEdge {
  const token0 = token0Address(index);
  const token1 = token1Address(index);
  return Object.freeze({
    adapterId: ADAPTER_ID,
    target: pool,
    tokenIn: forward ? token0 : token1,
    tokenOut: forward ? token1 : token0,
    slotKind: "swap" as const,
    edgeKind: "swap" as const,
    leavesStandingPosition: false,
    poolToken0: token0,
    poolToken1: token1,
    v3Fee: 3_000,
    v3TickSpacing: 60,
    factory: FACTORY,
  });
}

function edgesForPoolCount(count: number): readonly TokenEdge[] {
  const edges: TokenEdge[] = [];
  for (let index = 0; index < count; index++) {
    const pool = address(index);
    edges.push(edge(pool, index, true), edge(pool, index, false));
  }
  return Object.freeze(edges);
}

function graph(input: {
  readonly generation: number;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly edges: readonly TokenEdge[];
}) {
  return createVerifiedGraphView({
    id: `univ3-pool-spike-${input.generation}`,
    generation: input.generation,
    sourceBlock: input.sourceBlock,
    sourceBlockHash: input.sourceBlockHash,
    completenessWatermark: input.sourceBlock,
    perSourceCoverage: [{
      familyId: FAMILY_ID,
      sourceId: "univ3-pool-spike-fixture",
      sourceFingerprint: "univ3-pool-spike-fixture-v1",
      completeThroughBlock: input.sourceBlock,
      completeThroughHash: input.sourceBlockHash,
    }],
    edges: input.edges,
  });
}

function word(value: bigint | number | boolean): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

function slot0Data(): string {
  return `0x${word(1n << 96n)}${word(0)}${word(0)}${word(0)}${word(0)}` +
    `${word(0)}${word(1)}`;
}

function bindingData(pool: string): string {
  return `0x${pool.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

function successfulRead(
  read: StateRead,
  source: BlockSource,
  data: string,
): StateReadResult {
  return Object.freeze({
    id: read.id,
    ok: true as const,
    sourceBlock: source.number,
    sourceBlockHash: source.hash,
    provenance: Object.freeze({
      kind: "eip1898" as const,
      source,
      requireCanonical: true as const,
    }),
    data,
  });
}

class SpikeBackend implements BlockScanStateReadBackend {
  readonly rejectedGenerations = new Set<number>();

  constructor(private readonly counters: Counters) {}

  async readCanonicalBlockActivity(
    fromExclusive: BlockSource,
    through: BlockSource,
  ): Promise<CanonicalBlockActivity> {
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
    _lane: "swap" | "protocol",
    reads: readonly StateRead[],
    control: {
      readonly sourceBlock: number;
      readonly sourceBlockHash: string;
      readonly sourceGeneration: number;
    },
  ): Promise<readonly StateReadResult[]> {
    const source = Object.freeze({
      number: control.sourceBlock,
      hash: control.sourceBlockHash,
      generation: control.sourceGeneration,
    });
    return Object.freeze(reads.map((read) => {
      if (read.id.startsWith("v3-factory-binding:")) {
        this.counters.staticReadIds.push(read.id);
        const pool = read.id.slice("v3-factory-binding:".length);
        return successfulRead(read, source, bindingData(pool));
      }
      this.counters.currentReadTargets.push(read.to.toLowerCase());
      if (read.id.includes("slot0:")) {
        return successfulRead(read, source, slot0Data());
      }
      if (read.id.includes("liquidity:")) {
        return successfulRead(read, source, `0x${word(1_000n)}`);
      }
      throw new Error(`unexpected pool-spike read ${read.id}`);
    }));
  }

  async verifyCanonicalSource(source: BlockSource): Promise<void> {
    if (this.rejectedGenerations.delete(source.generation)) {
      throw new Error("fixture rejected source at publication CAS");
    }
  }
}

function fixture(failCompilePool?: string) {
  const counters: Counters = {
    compiledKeys: [],
    staticReadIds: [],
    currentReadTargets: [],
    familyWideCompilerInvocations: 0,
    familyWideAssemblyInvocations: 0,
    instanceAssemblyInvocations: 0,
  };
  const family = registerBlockScanStateFamily({
    familyId: FAMILY_ID,
    lane: "swap",
    capability: {
      ...univ3BlockScanState,
      compileStaticSchema(input) {
        counters.familyWideCompilerInvocations++;
        return univ3BlockScanState.compileStaticSchema(input);
      },
      async compileStateInstance(input: CompileStateInstanceInput) {
        counters.compiledKeys.push(input.spec.key);
        if (input.spec.stateKey === failCompilePool) {
          throw new Error("fixture rejected one instance compiler");
        }
        return univ3BlockScanState.compileStateInstance!(input);
      },
      assembleSchema(entries: ReadonlyMap<string, unknown>) {
        if (entries.size > 1) counters.familyWideAssemblyInvocations++;
        else counters.instanceAssemblyInvocations++;
        return univ3BlockScanState.assembleSchema(entries);
      },
    },
    ownsEdge: (candidate) => candidate.adapterId === ADAPTER_ID,
  });
  const backend = new SpikeBackend(counters);
  const coordinator = new BlockScanStateCoordinator(backend, {
    familyTimeoutMs: 60_000,
  });
  return { counters, family, backend, coordinator };
}

function receiptFor(
  result: Awaited<ReturnType<BlockScanStateCoordinator["prepare"]>>,
): PoolTopologySpikeReceipt {
  assert.notEqual(result.status, "incomplete");
  if (result.status === "incomplete") throw new Error("missing snapshot");
  const receipt = result.snapshot.poolTopologySpikeReceipts?.find(
    (candidate) => candidate.familyId === FAMILY_ID,
  );
  assert(receipt, "state-instance generation must publish its topology receipt");
  return receipt;
}

function assertCommonSpikeReceipt(
  receipt: PoolTopologySpikeReceipt,
  addedCompilerInvocations: number,
): void {
  assert.equal(receipt.beforeStateInstanceCount, BASE_POOL_COUNT);
  assert.equal(receipt.afterStateInstanceCount, BASE_POOL_COUNT + 1);
  assert.deepEqual(receipt.addedStateInstanceKeys, [
    `${FAMILY_ID}\u001f${address(BASE_POOL_COUNT)}`,
  ]);
  assert.deepEqual(receipt.changedStateInstanceKeys, []);
  assert.equal(receipt.addedCompilerInvocations, addedCompilerInvocations);
  assert(receipt.addedCompilerInvocations <= 1);
  assert.equal(receipt.changedCompilerInvocations, 0);
  assert.equal(receipt.siblingCompilerInvocations, 0);
  assert.equal(receipt.siblingStaticRequestCount, 0);
  assert.equal(receipt.familyWideCompilerInvocations, 0);
  assert.equal(receipt.familyWideAssemblyInvocations, 0);
}

async function publishBaseline(
  instance: ReturnType<typeof fixture>,
  baselineEdges: readonly TokenEdge[],
): Promise<void> {
  const baselineHash = `0x${"a1".repeat(32)}`;
  const result = await instance.coordinator.prepare({
    graph: graph({
      generation: 1,
      sourceBlock: SOURCE_BLOCK,
      sourceBlockHash: baselineHash,
      edges: baselineEdges,
    }),
    families: [instance.family],
    deadlineAtMs: Date.now() + 120_000,
  });
  assert.equal(
    result.status,
    "complete",
    JSON.stringify(result.issues.slice(0, 5)),
  );
  assert.equal(instance.counters.compiledKeys.length, BASE_POOL_COUNT);
  assert.equal(instance.counters.staticReadIds.length, BASE_POOL_COUNT);
  assert.equal(instance.counters.familyWideCompilerInvocations, 0);
  assert.equal(instance.counters.familyWideAssemblyInvocations, 0);
  assert.equal(instance.counters.instanceAssemblyInvocations, BASE_POOL_COUNT);
  instance.counters.compiledKeys.length = 0;
  instance.counters.staticReadIds.length = 0;
  instance.counters.currentReadTargets.length = 0;
}

async function coldMemoCompilesOnlyAddedPool(): Promise<void> {
  const instance = fixture();
  const baselineEdges = edgesForPoolCount(BASE_POOL_COUNT);
  await publishBaseline(instance, baselineEdges);
  const addedPool = address(BASE_POOL_COUNT);
  const result = await instance.coordinator.prepare({
    graph: graph({
      generation: 2,
      sourceBlock: SOURCE_BLOCK + 1,
      sourceBlockHash: `0x${"b2".repeat(32)}`,
      edges: Object.freeze([
        ...baselineEdges,
        edge(addedPool, BASE_POOL_COUNT, true),
        edge(addedPool, BASE_POOL_COUNT, false),
      ]),
    }),
    families: [instance.family],
    deadlineAtMs: Date.now() + 120_000,
  });
  assert.equal(result.status, "complete");
  assertCommonSpikeReceipt(receiptFor(result), 1);
  assert.deepEqual(instance.counters.compiledKeys, [
    `${FAMILY_ID}\u001f${addedPool}`,
  ]);
  assert.deepEqual(instance.counters.staticReadIds, [
    `v3-factory-binding:${addedPool}`,
  ]);
  assert(
    instance.counters.currentReadTargets.every(
      (target) => target === addedPool,
    ),
    "the complete activity proof must keep unchanged sibling current reads at zero",
  );
  assert.equal(instance.counters.familyWideCompilerInvocations, 0);
  assert.equal(instance.counters.familyWideAssemblyInvocations, 0);
  assert.equal(instance.counters.instanceAssemblyInvocations, BASE_POOL_COUNT + 1);
}

async function contentAddressedMemoHitSkipsAddedCompiler(): Promise<void> {
  const instance = fixture();
  const baselineEdges = edgesForPoolCount(BASE_POOL_COUNT);
  await publishBaseline(instance, baselineEdges);
  const addedPool = address(BASE_POOL_COUNT);
  const expandedEdges = Object.freeze([
    ...baselineEdges,
    edge(addedPool, BASE_POOL_COUNT, true),
    edge(addedPool, BASE_POOL_COUNT, false),
  ]);
  const sourceBlockHash = `0x${"c3".repeat(32)}`;
  instance.backend.rejectedGenerations.add(2);
  const rejected = await instance.coordinator.prepare({
    graph: graph({
      generation: 2,
      sourceBlock: SOURCE_BLOCK + 1,
      sourceBlockHash,
      edges: expandedEdges,
    }),
    families: [instance.family],
    deadlineAtMs: Date.now() + 120_000,
  });
  assert.equal(rejected.status, "incomplete");
  assert.deepEqual(instance.counters.compiledKeys, [
    `${FAMILY_ID}\u001f${addedPool}`,
  ]);
  assert.deepEqual(instance.counters.staticReadIds, [
    `v3-factory-binding:${addedPool}`,
  ]);

  instance.counters.compiledKeys.length = 0;
  instance.counters.staticReadIds.length = 0;
  instance.counters.currentReadTargets.length = 0;
  const retried = await instance.coordinator.prepare({
    graph: graph({
      generation: 3,
      sourceBlock: SOURCE_BLOCK + 1,
      sourceBlockHash,
      edges: expandedEdges,
    }),
    families: [instance.family],
    deadlineAtMs: Date.now() + 120_000,
  });
  assert.equal(retried.status, "complete");
  assertCommonSpikeReceipt(receiptFor(retried), 0);
  assert.deepEqual(instance.counters.compiledKeys, []);
  assert.deepEqual(instance.counters.staticReadIds, []);
  assert.equal(instance.counters.familyWideCompilerInvocations, 0);
  assert.equal(instance.counters.familyWideAssemblyInvocations, 0);
  assert.equal(
    instance.counters.instanceAssemblyInvocations,
    BASE_POOL_COUNT + 1,
    "memo reuse must reuse the materialized instance descriptor, not hide a second assembly",
  );
}

async function equivalentDescriptorReusesContentAddressedRuntime(): Promise<void> {
  const instance = fixture();
  const pool = address(0);
  const group = Object.freeze([
    edge(pool, 0, true),
    edge(pool, 0, false),
  ]);
  const stateKey = `${FAMILY_ID}\u001f${pool}`;
  const source = Object.freeze({
    number: SOURCE_BLOCK,
    hash: `0x${"d4".repeat(32)}`,
    generation: 1,
  });
  const compiled = await instance.family.compileStateInstance({
    spec: Object.freeze({
      key: stateKey,
      familyId: FAMILY_ID,
      stateKey: pool,
      edges: group,
      staticBindingFingerprint: stateSchemaFingerprint(group),
      snapshotCompatibilityFingerprint: stateSchemaFingerprint(group),
    }),
    control: {
      deadlineAtMs: Date.now() + 5_000,
      signal: new AbortController().signal,
    },
    sourceBlock: source.number,
    sourceBlockHash: source.hash,
    readStatic: async (reads) => Object.freeze(reads.map((read) =>
      successfulRead(read, source, bindingData(pool))
    )),
  });
  const structurallyEquivalent = Object.freeze({ ...compiled });
  const runtime = instance.family.composeCompiledFamily({
    familyId: FAMILY_ID,
    lane: "swap",
    instances: new Map([[stateKey, structurallyEquivalent]]),
    edgeFingerprint: stateSchemaFingerprint(group),
    control: {
      deadlineAtMs: Date.now() + 5_000,
      signal: new AbortController().signal,
    },
  });
  assert.equal(
    runtime.buildCurrentBlockReads({
      sourceBlock: source.number,
      sourceBlockHash: source.hash,
      edges: group,
    }).length,
    2,
    "runtime composition must resolve a structurally equivalent descriptor by content address",
  );
  assert.equal(instance.counters.familyWideAssemblyInvocations, 0);
  assert.equal(instance.counters.instanceAssemblyInvocations, 1);
}

async function oneCompilerFailureDoesNotFallbackOrDropSibling(): Promise<void> {
  const failedPool = address(1);
  const instance = fixture(failedPool);
  const result = await instance.coordinator.prepare({
    graph: graph({
      generation: 1,
      sourceBlock: SOURCE_BLOCK,
      sourceBlockHash: `0x${"e5".repeat(32)}`,
      edges: edgesForPoolCount(2),
    }),
    families: [instance.family],
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.equal(result.status, "degraded");
  assert.equal(result.snapshot.mids.size, 2);
  assert(
    [...result.snapshot.mids.values()].every(
      (value) => value.pool.toLowerCase() === address(0),
    ),
  );
  assert(
    result.issues.some((issue) =>
      issue.stateKey === `${FAMILY_ID}\u001f${failedPool}` &&
      issue.message.includes("fixture rejected one instance compiler")
    ),
  );
  assert.equal(instance.counters.familyWideCompilerInvocations, 0);
  assert.equal(instance.counters.familyWideAssemblyInvocations, 0);
  assert.equal(instance.counters.instanceAssemblyInvocations, 1);
}

await equivalentDescriptorReusesContentAddressedRuntime();
await oneCompilerFailureDoesNotFallbackOrDropSibling();
await coldMemoCompilesOnlyAddedPool();
await contentAddressedMemoHitSkipsAddedCompiler();
console.log("blockscan-state-pool-topology-spike PASS");
