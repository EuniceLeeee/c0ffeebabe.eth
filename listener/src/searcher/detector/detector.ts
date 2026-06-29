import type { StateBackend } from "../../shared/state/state-backend.js";
import type { OrderflowEvent } from "../orderflow/manual-source.js";
import { detectPoolImpact } from "./pool-impact.js";
import { defaultTokenGraph, type TokenEdge, type TokenQueryBackend } from "../planner/token-graph.js";

export interface Opportunity {
  kind: "backrun-arb";
  victimTxHash: string;
  blockNumber: number;
  affectedPools: string[];
  affectedTokens: string[];
  startToken: string;
  profitToken: string;
  victimAmountIn: bigint;
  targetNetProfit?: bigint;
  hints: Record<string, unknown>;
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

  async detect(event: OrderflowEvent, _state: StateBackend): Promise<Opportunity[]> {
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
        targetNetProfit: event.minProfit,
        hints: { impact },
      });
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
