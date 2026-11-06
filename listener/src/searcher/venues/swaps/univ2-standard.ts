import { ethers } from "ethers";
import type { TokenEdge } from "../../planner/token-graph.js";
import type {
  BlockScanStateCapability,
  StateReadResult,
} from "../blockscan-state-capability.js";
import {
  blockScanEdgeKey,
  createMutationQueryDescriptor,
  deterministicHash,
  instanceFingerprint,
  schemaInputFingerprint,
  stateSchemaFingerprint,
  type CompiledStateInstance,
  type CompileStateInstanceInput,
  type StateInstanceSpec,
} from "../blockscan-state-capability.js";
import { UNIV2_SYNC_TOPIC } from "../landed-event-registry.js";
import {
  assertPoolGroup,
  canonicalPoolStateKey,
  currentBlockRead,
  directedPoolMid,
  midsForDirectedEdges,
  requireRead,
} from "./blockscan-state-shared.js";
import { UNIV2_PAIR_INTERFACE as pairIface } from "./univ2-abi.js";

interface UniV2PoolSchemaEntry {
  readonly token0: string;
  readonly token1: string;
  readonly feeBps: bigint;
}

/**
 * Shared per-pool compiler core: both the legacy full compile path and the
 * state-instance path call this, so full-vs-instance parity is structural.
 * All edges of one stateKey must agree on token order and fee.
 */
function compileUniV2PoolEntry(
  edges: readonly TokenEdge[],
): UniV2PoolSchemaEntry {
  const pool = canonicalPoolStateKey(edges[0]);
  const first = edges[0];
  if (!first.poolToken0 || !first.poolToken1) {
    throw new Error(`univ2 block-scan edge ${pool} is missing token order`);
  }
  const token0 = ethers.getAddress(first.poolToken0);
  const token1 = ethers.getAddress(first.poolToken1);
  if (first.v2FeeBps === undefined || first.v2FeeBps < 0n) {
    throw new Error(`univ2 block-scan edge ${pool} is missing quote fee`);
  }
  const feeBps = first.v2FeeBps;
  for (const edge of edges.slice(1)) {
    if (canonicalPoolStateKey(edge) !== pool) {
      throw new Error(`univ2 state group mixes pools for ${pool}`);
    }
    if (
      !edge.poolToken0 ||
      !edge.poolToken1 ||
      ethers.getAddress(edge.poolToken0) !== token0 ||
      ethers.getAddress(edge.poolToken1) !== token1 ||
      edge.v2FeeBps !== feeBps
    ) {
      throw new Error(`univ2 block-scan pool ${pool} has inconsistent metadata`);
    }
  }
  return Object.freeze({ token0, token1, feeBps });
}
const UNIV2_MUTATION_QUERY = createMutationQueryDescriptor({
  // Address filtering a production-sized pool universe exceeds common RPC
  // filter limits. Sync is pair-emitted and the pure classifier intersects it
  // with this family's admitted pool set.
  topics: [[UNIV2_SYNC_TOPIC]],
});
const UNIV2_CLASSIFIER_FINGERPRINT = deterministicHash({
  family: "univ2-standard",
  version: 1,
  semantics: "Sync mutates reserves",
});

interface UniV2StateSchema {
  readonly pools: ReadonlyMap<string, {
    readonly token0: string;
    readonly token1: string;
    readonly feeBps: bigint;
  }>;
}

interface UniV2CurrentState {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  readonly feeBps: bigint;
  readonly blockTimestampLast: number;
  readonly inactiveReason: string | null;
}

const UNIV2_EDGE_IDS = new Set(["univ2-swap"]);

export const univ2BlockScanState = Object.freeze({
  schemaMode: "state-instance-v1",
  stateKey: canonicalPoolStateKey,

  compileStaticSchema({ edges }) {
    const pools = new Map<string, UniV2PoolSchemaEntry>();
    const byPool = new Map<string, TokenEdge[]>();
    for (const edge of edges) {
      const pool = canonicalPoolStateKey(edge);
      const group = byPool.get(pool) ?? [];
      group.push(edge);
      byPool.set(pool, group);
    }
    for (const [pool, groupEdges] of byPool) {
      pools.set(pool, compileUniV2PoolEntry(groupEdges));
    }
    return Object.freeze({ pools });
  },

  compileStateInstance(input: CompileStateInstanceInput): CompiledStateInstance {
    const spec = input.spec as StateInstanceSpec;
    if (spec.edges.length === 0) {
      throw new Error(`univ2 instance ${spec.key} has no edges`);
    }
    const staticBindingFingerprint = stateSchemaFingerprint(spec.edges);
    const sharedFingerprint = "";
    const schemaInput = schemaInputFingerprint({
      key: spec.key,
      staticBindingFingerprint,
      sharedFingerprint,
    });
    return Object.freeze({
      familyId: "univ2-standard",
      stateKey: spec.stateKey,
      specFingerprint: schemaInput,
      instanceFingerprint: instanceFingerprint({
        key: spec.key,
        schemaInput,
        staticEvidence: "",
      }),
      staticEvidenceFingerprint: "",
      carryPolicy: "activity-proof",
      opaque: compileUniV2PoolEntry(spec.edges),
    });
  },

  assembleSchema(entries: ReadonlyMap<string, unknown>) {
    const pools = new Map<string, UniV2PoolSchemaEntry>();
    for (const [stateKey, opaque] of entries) {
      pools.set(stateKey, opaque as UniV2PoolSchemaEntry);
    }
    return Object.freeze({ pools });
  },

  buildCurrentBlockReads({ sourceBlock, sourceBlockHash, edges }) {
    const pool = assertPoolGroup(edges, UNIV2_EDGE_IDS);
    return Object.freeze([
      currentBlockRead({
        id: `reserves:${pool}`,
        sourceBlock,
        sourceBlockHash,
        to: pool,
        data: pairIface.encodeFunctionData("getReserves"),
      }),
    ]);
  },

  decodeState(schema, results) {
    const pool = statePoolFromResults(results, "reserves:");
    const metadata = schema.pools.get(pool);
    if (!metadata) throw new Error(`univ2 block-scan schema missing ${pool}`);
    const reserves = pairIface.decodeFunctionResult(
      "getReserves",
      requireRead(results, `reserves:${pool}`).data,
    );
    const reserve0 = BigInt(reserves[0]);
    const reserve1 = BigInt(reserves[1]);
    return Object.freeze({
      pool,
      token0: metadata.token0,
      token1: metadata.token1,
      reserve0,
      reserve1,
      feeBps: metadata.feeBps,
      blockTimestampLast: Number(reserves[2]),
      inactiveReason:
        reserve0 === 0n || reserve1 === 0n
          ? `univ2 pool ${pool} has zero reserve at the current source`
          : null,
    });
  },

  deriveMids(snapshot, edges) {
    if (snapshot.inactiveReason) {
      for (const edge of edges) {
        if (canonicalPoolStateKey(edge) !== snapshot.pool) {
          throw new Error(
            `univ2 snapshot ${snapshot.pool} used for ${edge.target}`,
          );
        }
      }
      return new Map();
    }
    return midsForDirectedEdges(edges, (edge) => {
      if (canonicalPoolStateKey(edge) !== snapshot.pool) {
        throw new Error(`univ2 snapshot ${snapshot.pool} used for ${edge.target}`);
      }
      const tokenIn = edge.tokenIn.toLowerCase();
      const tokenOut = edge.tokenOut.toLowerCase();
      const zeroForOne =
        tokenIn === snapshot.token0.toLowerCase() &&
        tokenOut === snapshot.token1.toLowerCase();
      const oneForZero =
        tokenIn === snapshot.token1.toLowerCase() &&
        tokenOut === snapshot.token0.toLowerCase();
      if (!zeroForOne && !oneForZero) {
        throw new Error(`univ2 edge does not match pool ${snapshot.pool}`);
      }
      return directedPoolMid({
        kind: "v2",
        edge,
        reserveIn: zeroForOne ? snapshot.reserve0 : snapshot.reserve1,
        reserveOut: zeroForOne ? snapshot.reserve1 : snapshot.reserve0,
        feeBps: Number(snapshot.feeBps),
      });
    });
  },

  behaviorProvenUnavailableEdges(snapshot, edges) {
    if (!snapshot.inactiveReason) return new Map();
    const unavailable = new Map<string, string>();
    for (const edge of edges) {
      if (canonicalPoolStateKey(edge) !== snapshot.pool) {
        throw new Error(
          `univ2 snapshot ${snapshot.pool} used for ${edge.target}`,
        );
      }
      unavailable.set(blockScanEdgeKey(edge), snapshot.inactiveReason);
    }
    return unavailable;
  },

  projectBackrunState(snapshot, source) {
    return Object.freeze({
      kind: "v2" as const,
      state: Object.freeze({
        pool: snapshot.pool,
        token0: snapshot.token0,
        token1: snapshot.token1,
        reserve0: snapshot.reserve0,
        reserve1: snapshot.reserve1,
        feeBps: snapshot.feeBps,
        blockTimestampLast: snapshot.blockTimestampLast,
        blockNumber: source.number,
      }),
    });
  },

  dependencies(edges) {
    const pool = assertPoolGroup(edges, UNIV2_EDGE_IDS);
    return Object.freeze([
      pool,
      ...new Set(edges.flatMap((edge) => [edge.tokenIn, edge.tokenOut])),
    ]);
  },

  incremental: {
    mutationQueryDescriptor() {
      return UNIV2_MUTATION_QUERY;
    },

    classifyMutations({ schema, range }) {
      const changed = new Map<string, ReadonlySet<string>>();
      for (const event of range.events) {
        if (event.topics[0]?.toLowerCase() !== UNIV2_SYNC_TOPIC) {
          throw new Error("univ2 mutation range contains a non-Sync event");
        }
        const pool = event.address.toLowerCase();
        if (!schema.pools.has(pool)) continue;
        changed.set(pool, new Set([`reserves:${pool}`]));
      }
      return Object.freeze({
        mutationRangeFingerprint: range.rangeFingerprint,
        classifierFingerprint: UNIV2_CLASSIFIER_FINGERPRINT,
        changedReadKeysByStateKey: changed,
      });
    },
  },
} satisfies BlockScanStateCapability<UniV2StateSchema, UniV2CurrentState>);

function statePoolFromResults(
  results: readonly StateReadResult[],
  prefix: string,
): string {
  const read = results.find((candidate) => candidate.id.startsWith(prefix));
  if (!read) throw new Error(`missing block-scan read prefix ${prefix}`);
  return read.id.slice(prefix.length);
}
