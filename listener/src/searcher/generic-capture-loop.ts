import { buildTokenPaths, type TokenEdge } from "./planner/token-graph.js";

/**
 * Multi-hop closed-loop path assembly for capture cases (central tooling,
 * no protocol semantics). Production arbitrage borrows a borrowable start
 * token, swaps through the token graph, and repays the start token. The
 * single-leg capture model (borrow tokenIn -> one pool swap -> repay
 * tokenIn) cannot close: one swap's output is never its input token. A
 * capture case path is therefore a cycle that starts and ends at the same
 * borrowable start token and passes through the family's verification
 * pool.
 */
export interface CaptureLoopEdge {
  readonly pool: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly adapterId: string;
}

export interface CaptureLoopPath {
  readonly startToken: string;
  readonly edges: readonly CaptureLoopEdge[];
}

/**
 * Assemble the closed loop through the target pool. Uses the planner's
 * token-path search (pinned to the target pool so the cycle provably
 * passes through the family's verification point). Returns null when the
 * graph cannot close a cycle from the start token through the target.
 */
export function buildCaptureClosedLoop(input: {
  readonly edges: readonly TokenEdge[];
  readonly startToken: string;
  readonly targetPool: string;
}): CaptureLoopPath | null {
  const paths = buildTokenPaths(
    input.edges as TokenEdge[],
    input.startToken,
    input.startToken,
    {
      maxHops: 5,
      pinnedPools: new Set([input.targetPool.toLowerCase()]),
      maxPaths: 100,
    },
  );
  // The loop must pass through the family's verification pool. A cycle
  // that does not touch the target pool verifies nothing about this Family
  // (and an unrelated one-pool round trip is not a capture case), so no
  // fallback: no path through the target means no loop path.
  const through = paths.find((path) => path.edges.some((edge) =>
    edge.target.toLowerCase() === input.targetPool.toLowerCase()
  ));
  if (through === undefined || through.edges.length === 0) return null;
  return Object.freeze({
    startToken: input.startToken.toLowerCase(),
    edges: Object.freeze(through.edges.map((edge) => Object.freeze({
      pool: edge.target.toLowerCase(),
      tokenIn: edge.tokenIn.toLowerCase(),
      tokenOut: edge.tokenOut.toLowerCase(),
      adapterId: edge.adapterId,
    }))),
  });
}

/**
 * Build the token-edge index from pool-universe entries (universal field
 * names; no protocol semantics). One directed edge per token direction.
 */
export function edgesFromPoolEntries(
  pools: readonly {
    readonly address?: string;
    readonly token0?: string;
    readonly token1?: string;
    readonly currency0?: string;
    readonly currency1?: string;
    readonly adapter?: string;
  }[],
): readonly TokenEdge[] {
  const edges: TokenEdge[] = [];
  for (const pool of pools) {
    const address = pool.address;
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      continue;
    }
    const token0 = pool.token0 ?? pool.currency0;
    const token1 = pool.token1 ?? pool.currency1;
    if (
      typeof token0 !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(token0) ||
      typeof token1 !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(token1)
    ) {
      continue;
    }
    const adapterId = pool.adapter ?? "swap";
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();
    edges.push(Object.freeze({
      adapterId,
      target: address.toLowerCase(),
      tokenIn: t0,
      tokenOut: t1,
      slotKind: "swap" as const,
      edgeKind: "swap" as const,
      leavesStandingPosition: false,
    }));
    edges.push(Object.freeze({
      adapterId,
      target: address.toLowerCase(),
      tokenIn: t1,
      tokenOut: t0,
      slotKind: "swap" as const,
      edgeKind: "swap" as const,
      leavesStandingPosition: false,
    }));
  }
  return Object.freeze(edges);
}
