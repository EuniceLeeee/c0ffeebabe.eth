import type { StateBackend } from "../../shared/state/state-backend.js";
import type { OrderflowEvent } from "../orderflow/manual-source.js";
import { detectPoolImpact } from "./pool-impact.js";
import { defaultTokenGraph, type TokenEdge, type TokenQueryBackend } from "../planner/token-graph.js";
import {
  matchOracleVictimEffect,
  oracleAffectedGraphEdges,
  type VictimEffect,
} from "./victim-effect.js";

export interface Opportunity {
  kind: "backrun-arb";
  victimTxHash: string;
  blockNumber: number;
  affectedPools: string[];
  affectedTokens: string[];
  startToken: string;
  profitToken: string;
  victimAmountIn: bigint;
  victimEffect: VictimEffect;
  targetNetProfit?: bigint;
  hints: Record<string, unknown>;
}

/** Doc alias for the backrun opportunity shape (D1 naming); identical to Opportunity. */
export type BackrunOpportunity = Opportunity;

/** Block-scan (standing-dislocation) opportunity — produced by the future block-scan scanner (BS-1).
 *  No victim: identity is (sourceBlock, cycle). Not yet unioned into Opportunity (the scanner + the
 *  processOpportunities block-scan arm will wire it at BS-1). */
export interface BlockScanOpportunity {
  kind: "block-scan-arb";
  sourceBlock: number;             // = competitor_execution_block − 1 (temporal rule)
  stateBlock: number;              // block whose end-state the cycle was reconstructed from
  cycleId: string;                 // ring identity within the block (start-token + sorted seed pools)
  cycleFingerprint: string;        // cycleFingerprint(sourceBlock, ring) — cross-block join key
  seedEdges: TokenEdge[];          // the pinned cycle edges the scanner found
  flashToken: string;              // pinned by the scanner; planner MUST NOT rotate
  searchSeed: { startToken: string; searchCenter: bigint; maxInput: bigint }; // sizing seed for solver search
  leavesStandingPosition: boolean; // DERIVED from seedEdges at construction; re-derived at submit
  affectedPools?: string[];
  affectedTokens?: string[];
}

export interface Detector {
  detect(event: OrderflowEvent, state: StateBackend): Promise<Opportunity[]>;
}

export class BackrunDetector implements Detector {
  private graph: TokenEdge[] | null = null;
  private poolAddrs: Map<string, string> | null = null;
  private tokenQuery: TokenQueryBackend | null = null;

  /** Inject a pre-built graph (from buildTokenGraph). Falls back to hardcoded default. */
  setGraph(graph: TokenEdge[]): void {
    this.graph = graph;
  }

  /** Inject a broader set of known pool addresses for detection matching.
   *  Map: lowercase pool address → adapter type (e.g. "univ2", "univ3", "curve").
   *  Includes factory-indexed pools that aren't in the routing graph. */
  setPoolAddressMap(addrs: Map<string, string>): void {
    this.poolAddrs = addrs;
  }

  /** Inject a backend for on-chain token0/token1 queries (swap-only hint enrichment). */
  setTokenQuery(backend: TokenQueryBackend): void {
    this.tokenQuery = backend;
  }

  async detect(event: OrderflowEvent, state: StateBackend): Promise<Opportunity[]> {
    const graph = this.graph ?? defaultTokenGraph();
    const impacts = await detectPoolImpact(event, graph, this.poolAddrs, this.tokenQuery);

    // Build set of tokens that exist in the routing graph
    const graphTokens = new Set(
      graph.flatMap((e) => [e.tokenIn.toLowerCase(), e.tokenOut.toLowerCase()]),
    );

    const opportunities: Opportunity[] = [];
    for (const impact of impacts) {
      // Pick startToken: prefer an impact token that's in the routing graph
      // so the planner can actually build a cycle through it.
      // Fall back to the lend edge's tokenIn (wstUSR) if both are missing.
      const startToken = pickStartToken(impact, graphTokens, graph);
      if (startToken === null) continue;
      opportunities.push({
        kind: "backrun-arb" as const,
        victimTxHash: event.txHash,
        blockNumber: event.blockNumber,
        affectedPools: [impact.pool],
        affectedTokens: uniqueAddresses([impact.tokenIn, impact.tokenOut]),
        startToken,
        profitToken: startToken,
        victimAmountIn: impact.amountIn,
        victimEffect: { kind: "swap", impact },
        targetNetProfit: event.minProfit,
        hints: { impact },
      });
    }

    const oracleEffect = await matchOracleVictimEffect(
      event.to,
      event.input,
      graph,
      this.tokenQuery,
      Math.max(0, event.blockNumber - 1),
      state,
    );
    if (oracleEffect) {
      const affectedEdges = oracleAffectedGraphEdges(graph, oracleEffect);
      const affectedTokens = uniqueAddresses(
        affectedEdges.flatMap((edge) => [edge.tokenIn, edge.tokenOut]),
      );
      const affectedPools = uniqueAddresses(
        affectedEdges.map((edge) => edge.poolId ?? edge.target),
      );
      for (const startToken of connectedComponentSeeds(affectedEdges)) {
        opportunities.push({
          kind: "backrun-arb",
          victimTxHash: event.txHash,
          blockNumber: event.blockNumber,
          affectedPools,
          affectedTokens,
          startToken,
          profitToken: startToken,
          victimAmountIn: 0n,
          victimEffect: oracleEffect,
          targetNetProfit: event.minProfit,
          hints: { oracleDescriptorId: oracleEffect.descriptorId },
        });
      }
    }
    return opportunities;
  }
}

import type { PoolImpact } from "./pool-impact.js";

/**
 * Pick the best startToken for a backrun arb opportunity.
 *
 * Priority:
 *  1. If an impact token is the lend edge's tokenIn (wstUSR) → use it (known flash source)
 *  2. If an impact token exists in the routing graph → use it (planner can route from it)
 *  3. Fall back to lend edge tokenIn, then impact.tokenIn
 */
function pickStartToken(
  impact: PoolImpact,
  graphTokens: Set<string>,
  graph: TokenEdge[],
): string | null {
  const lend = graph.find((edge) => edge.slotKind === "lend");
  const lendToken = lend?.tokenIn?.toLowerCase();

  // Priority 1: impact token matches lend token
  if (lendToken) {
    if (impact.tokenIn.toLowerCase() === lendToken) return impact.tokenIn;
    if (impact.tokenOut.toLowerCase() === lendToken) return impact.tokenOut;
  }

  // Priority 2: impact token is in routing graph (flash-loanable or routable)
  if (graphTokens.has(impact.tokenOut.toLowerCase())) return impact.tokenOut;
  if (graphTokens.has(impact.tokenIn.toLowerCase())) return impact.tokenIn;

  // Priority 3: fallback
  return lend?.tokenIn ?? impact.tokenIn;
}

function uniqueAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  return addresses.filter((address) => {
    const key = address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function connectedComponentSeeds(edges: TokenEdge[]): string[] {
  const byToken = new Map<string, { address: string; neighbors: Set<string> }>();
  const ensure = (address: string): { address: string; neighbors: Set<string> } => {
    const key = address.toLowerCase();
    const existing = byToken.get(key);
    if (existing) return existing;
    const created = { address, neighbors: new Set<string>() };
    byToken.set(key, created);
    return created;
  };
  for (const edge of edges) {
    const from = ensure(edge.tokenIn);
    const to = ensure(edge.tokenOut);
    from.neighbors.add(edge.tokenOut.toLowerCase());
    to.neighbors.add(edge.tokenIn.toLowerCase());
  }

  const seeds: string[] = [];
  const visited = new Set<string>();
  for (const [key, node] of byToken) {
    if (visited.has(key)) continue;
    seeds.push(node.address);
    const pending = [key];
    visited.add(key);
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const neighbor of byToken.get(current)?.neighbors ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
  }
  return seeds;
}
