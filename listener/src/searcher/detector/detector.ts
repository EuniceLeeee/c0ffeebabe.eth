import type { StateBackend } from "../../shared/state/state-backend.js";
import type { OrderflowEvent } from "../orderflow/manual-source.js";
import {
  detectPoolImpactTransition,
  mutationOnlyTransitionDiagnostic,
} from "./pool-impact.js";
import type { TokenEdge, TokenQueryBackend } from "../planner/token-graph.js";
import {
  matchOracleVictimEffect,
  oracleAffectedGraphEdges,
  type OracleVictimDescriptor,
  type VictimEffect,
} from "./victim-effect.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";

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

  constructor(
    private readonly oracleVictims: readonly OracleVictimDescriptor[] =
      PRODUCTION_ADAPTER_FAMILIES.oracleVictims(),
  ) {}

  /** Inject a verified pre-built graph (from buildTokenGraph). */
  setGraph(graph: TokenEdge[]): void {
    this.graph = graph;
  }

  /**
   * Inject the broader discovery view carried by the live detector context.
   * This map is not an identity/admission credential: actionable swap impacts
   * are restricted to family-verified graph edges.
   */
  setPoolAddressMap(addrs: Map<string, string>): void {
    this.poolAddrs = addrs;
  }

  /** Inject a backend for family-owned receipt-state enrichment. */
  setTokenQuery(backend: TokenQueryBackend): void {
    this.tokenQuery = backend;
  }

  async detect(event: OrderflowEvent, state: StateBackend): Promise<Opportunity[]> {
    const graph = this.graph;
    if (!graph) {
      throw new Error("backrun detector graph is not initialized");
    }
    const transition = await detectPoolImpactTransition(
      event,
      graph,
      this.poolAddrs,
      this.tokenQuery,
    );
    const reportedUnresolved = event.victimState === "must-overlay"
      ? transition.unresolved
      : transition.unresolved.filter((item) =>
          item.reason !== "receipt-fragment" &&
          item.reason !== "source-generation-unbound"
        );
    if (reportedUnresolved.length > 0) {
      console.log(
        `[searcher/detector] victim transition unresolved generation=${transition.sourceGeneration.id.slice(0, 10)} ` +
          reportedUnresolved
            .slice(0, 4)
            .map((item) => `${item.reason}:${item.pool ?? "unknown"}`)
            .join(","),
      );
    }
    const impacts = event.victimState === "must-overlay" &&
        !transition.hashOnlyReplayable
      ? []
      : transition.impacts;
    const mutationOnly = mutationOnlyTransitionDiagnostic(transition);
    if (mutationOnly) {
      console.log(
        `[searcher/detector] ${mutationOnly.reason} ` +
          mutationOnly.mutations
            .slice(0, 4)
            .map((mutation) =>
              `${mutation.familyId}:${mutation.poolIdentity}:${mutation.reason}`
            )
            .join(","),
      );
    }

    // Build set of tokens that exist in the routing graph
    const graphTokens = new Set(
      graph.flatMap((e) => [e.tokenIn.toLowerCase(), e.tokenOut.toLowerCase()]),
    );

    const routeRegistry = PRODUCTION_ADAPTER_FAMILIES.routes();
    const mutationEdges = graph.filter((edge) => {
      const owner = routeRegistry.findForEdge(edge.adapterId);
      if (!owner) return false;
      return transition.mutations.some((mutation) =>
        owner.id === mutation.familyId &&
        (
          edge.poolId?.toLowerCase() === mutation.poolIdentity.toLowerCase() ||
          edge.target.toLowerCase() === mutation.poolIdentity.toLowerCase()
        )
      );
    });
    const transitionPools = uniqueAddresses([
      ...transition.impacts.map((impact) => impact.poolId ?? impact.pool),
      ...transition.mutations.map((mutation) => mutation.poolIdentity),
    ]);
    const transitionTokens = uniqueAddresses(
      [
        ...transition.impacts.flatMap((impact) => [
          impact.tokenIn,
          impact.tokenOut,
        ]),
        ...mutationEdges.flatMap((edge) => [edge.tokenIn, edge.tokenOut]),
      ],
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
        affectedPools: transitionPools,
        affectedTokens: transitionTokens,
        startToken,
        profitToken: startToken,
        victimAmountIn: impact.amountIn,
        victimEffect: { kind: "swap", impact, transition },
        targetNetProfit: event.minProfit,
        hints: { impact, victimTransition: transition },
      });
    }

    const oracleEffect = await matchOracleVictimEffect(
      event.to,
      event.input,
      graph,
      this.tokenQuery,
      Math.max(0, event.blockNumber - 1),
      state,
      this.oracleVictims,
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
