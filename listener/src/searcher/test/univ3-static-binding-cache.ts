import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import type {
  CompiledBlockScanStateFamily,
  StateRead,
  StateReadFailure,
  StateReadSuccess,
} from "../venues/blockscan-state-capability.js";
import { registerBlockScanStateFamily } from "../venues/blockscan-state-capability.js";
import { univ3BlockScanState } from "../venues/swaps/univ3-standard.js";

const SOURCE_BLOCK = 25_000_000;
const SOURCE_HASH = `0x${"ab".repeat(32)}`;
const FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const OTHER_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
const TOKEN0 = address(1);
const TOKEN1 = address(2);
const TOKEN2 = address(3);
const TOKEN3 = address(4);
const BASE_POOL_COUNT = 3_238;
const taxonomy = deriveEdgeTaxonomy("swap");
const factoryIface = new ethers.Interface([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
]);

const basePools = Array.from(
  { length: BASE_POOL_COUNT },
  (_, index) => address(10_000 + index),
);
const baseEdges = Object.freeze(basePools.flatMap((pool) => edges(pool)));

const registered = registerBlockScanStateFamily({
  familyId: "univ3-standard",
  lane: "swap",
  capability: univ3BlockScanState,
  ownsEdge: () => true,
});

const first = await compile(baseEdges, undefined, (read) =>
  success(read, poolFromRead(read))
);
assert.equal(
  first.reads.length,
  BASE_POOL_COUNT,
  "cold schema must reverse-verify every unique pool exactly once",
);

const addedPool = address(20_000);
const extendedEdges = Object.freeze([...baseEdges, ...edges(addedPool)]);
const extended = await compile(
  extendedEdges,
  first.compiled,
  (read) => success(read, poolFromRead(read)),
);
assert.deepEqual(
  extended.reads.map((read) => read.id),
  [`v3-factory-binding:${addedPool.toLowerCase()}`],
  "adding one pool must not reread 3,238 verified factory bindings",
);
const stable = await compile(
  extendedEdges,
  extended.compiled,
  (read) => success(read, poolFromRead(read)),
);
assert.equal(
  stable.reads.length,
  0,
  "the newly verified pool must join the published schema extension",
);

const cachedPool = basePools[0];
assert.equal(
  (await compile(
    edges(cachedPool, { fee: 500 }),
    extended.compiled,
    (read) => success(read, poolFromRead(read)),
  )).reads.length,
  1,
  "fee is part of the verified metadata key",
);
assert.equal(
  (await compile(
    edges(cachedPool, { factory: OTHER_FACTORY }),
    extended.compiled,
    (read) => success(read, poolFromRead(read)),
  )).reads.length,
  1,
  "factory is part of the verified metadata key",
);
assert.equal(
  (await compile(
    edges(cachedPool, { token0: TOKEN2 }),
    extended.compiled,
    (read) => success(read, poolFromRead(read)),
  )).reads.length,
  1,
  "token0 is part of the verified metadata key",
);
assert.equal(
  (await compile(
    edges(cachedPool, { token1: TOKEN3 }),
    extended.compiled,
    (read) => success(read, poolFromRead(read)),
  )).reads.length,
  1,
  "token1 is part of the verified metadata key",
);

const rejectedPool = address(30_000);
const rejectedEdges = edges(rejectedPool);
const rejected = await compile(
  rejectedEdges,
  extended.compiled,
  (read) => success(read, address(30_001)),
);
assert.equal(rejected.reads.length, 1);
assert.equal(
  (await compile(
    rejectedEdges,
    rejected.compiled,
    (read) => success(read, rejectedPool),
  )).reads.length,
  1,
  "a reverse-binding mismatch must not extend the positive schema",
);

const failedPool = address(31_000);
const failedEdges = edges(failedPool);
const failed = await compile(
  failedEdges,
  extended.compiled,
  failure,
);
assert.equal(failed.reads.length, 1);
assert.equal(
  (await compile(
    failedEdges,
    failed.compiled,
    (read) => success(read, failedPool),
  )).reads.length,
  1,
  "a transport failure must not extend the positive schema",
);

console.log(
  "[univ3-static-binding-cache] 3,238 verified + one incremental read; failures retry: PASS",
);

async function compile(
  edgesInput: readonly TokenEdge[],
  previous: CompiledBlockScanStateFamily | undefined,
  resultFor: (
    read: StateRead,
  ) => StateReadSuccess | StateReadFailure,
): Promise<{
  readonly compiled: CompiledBlockScanStateFamily;
  readonly reads: readonly StateRead[];
}> {
  let reads: readonly StateRead[] = [];
  const input = {
    edges: edgesInput,
    deadlineAtMs: Date.now() + 10_000,
    signal: new AbortController().signal,
    sourceBlock: SOURCE_BLOCK,
    sourceBlockHash: SOURCE_HASH,
    async readStatic(pending: readonly StateRead[]) {
      reads = pending;
      return pending.map(resultFor);
    },
  };
  const compiled = previous
    ? await previous.recompile!(input)
    : await registered.compile(input);
  return { compiled, reads };
}

function edges(
  pool: string,
  overrides: {
    readonly factory?: string;
    readonly token0?: string;
    readonly token1?: string;
    readonly fee?: number;
  } = {},
): readonly TokenEdge[] {
  const token0 = overrides.token0 ?? TOKEN0;
  const token1 = overrides.token1 ?? TOKEN1;
  const shared = {
    adapterId: "univ3-swap",
    target: pool,
    slotKind: "swap" as const,
    poolToken0: token0,
    poolToken1: token1,
    v3Fee: overrides.fee ?? 3_000,
    v3TickSpacing: 60,
    factory: overrides.factory ?? FACTORY,
    ...taxonomy,
  };
  return Object.freeze([
    Object.freeze({ ...shared, tokenIn: token0, tokenOut: token1 }),
    Object.freeze({ ...shared, tokenIn: token1, tokenOut: token0 }),
  ]);
}

function success(
  read: StateRead,
  boundPool: string,
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
        generation: 1,
      }),
      requireCanonical: true as const,
    }),
    data: factoryIface.encodeFunctionResult("getPool", [boundPool]),
  });
}

function failure(
  read: StateRead,
): StateReadFailure {
  return Object.freeze({
    id: read.id,
    ok: false,
    sourceBlock: read.sourceBlock,
    sourceBlockHash: read.sourceBlockHash,
    kind: "rpc",
    error: "injected transport failure",
  });
}

function poolFromRead(
  read: StateRead,
): string {
  return ethers.getAddress(read.id.slice("v3-factory-binding:".length));
}

function address(value: number): string {
  return ethers.getAddress(`0x${value.toString(16).padStart(40, "0")}`);
}
