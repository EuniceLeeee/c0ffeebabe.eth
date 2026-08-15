import type { TokenEdge } from "./planner/token-graph.js";

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
 * Assemble the closed loop through the target pool. The walk is constrained
 * so the returned cycle provably passes through the family's verification
 * pool: paths that return to the start token before touching the target are
 * not cycles for this Family. Branching is bounded per token (pinned target
 * edges always kept) and the shortest through-target cycle wins; the walk
 * stops as soon as one is found. Returns null when the graph cannot close a
 * cycle from the start token through the target.
 */
export function buildCaptureClosedLoop(input: {
  readonly edges: readonly TokenEdge[];
  readonly startToken: string;
  readonly targetPool: string;
}): CaptureLoopPath | null {
  const start = input.startToken.toLowerCase();
  const target = input.targetPool.toLowerCase();
  const maxHops = 5;
  const maxPoolsPerToken = 20;
  const outByToken = new Map<string, TokenEdge[]>();
  for (const edge of input.edges) {
    const key = edge.tokenIn.toLowerCase();
    const bucket = outByToken.get(key);
    if (bucket === undefined) outByToken.set(key, [edge]);
    else bucket.push(edge);
  }
  // Per-token branching bound: pinned (target) edges always survive; the
  // rest keep the top-N by score so the walk stays bounded on hub tokens.
  for (const [key, bucket] of outByToken) {
    if (bucket.length <= maxPoolsPerToken) continue;
    const pinned = bucket.filter((edge) => edge.target.toLowerCase() === target);
    const rest = bucket
      .filter((edge) => edge.target.toLowerCase() !== target)
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, Math.max(0, maxPoolsPerToken - pinned.length));
    outByToken.set(key, [...pinned, ...rest]);
  }
  const walk = (
    token: string,
    path: TokenEdge[],
    seenTarget: boolean,
  ): TokenEdge[] | null => {
    if (path.length > 0 && token === start) {
      return seenTarget ? path : null;
    }
    if (path.length >= maxHops) return null;
    // A repeated token (pool input) cannot close a simple cycle; this also
    // keeps the DFS finite.
    if (path.some((used) => used.target.toLowerCase() === token)) return null;
    const outs = outByToken.get(token);
    if (outs === undefined) return null;
    for (const edge of outs) {
      if (path.some((used) =>
        used.target.toLowerCase() === edge.target.toLowerCase() &&
        used.tokenIn.toLowerCase() === edge.tokenIn.toLowerCase() &&
        used.tokenOut.toLowerCase() === edge.tokenOut.toLowerCase()
      )) continue;
      const found = walk(
        edge.tokenOut.toLowerCase(),
        [...path, edge],
        seenTarget || edge.target.toLowerCase() === target,
      );
      if (found !== null) return found;
    }
    return null;
  };
  const result = walk(start, [], false);
  if (result === null) return null;
  return Object.freeze({
    startToken: start,
    edges: Object.freeze(result.map((edge) => Object.freeze({
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
