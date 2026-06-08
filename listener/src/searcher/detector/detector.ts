import type { StateBackend } from "../../shared/state/state-backend.js";
import type { OrderflowEvent } from "../orderflow/manual-source.js";
import { detectPoolImpact } from "./pool-impact.js";
import { defaultTokenGraph, type TokenEdge } from "../planner/token-graph.js";

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

  /** Inject a pre-built graph (from buildTokenGraph). Falls back to hardcoded default. */
  setGraph(graph: TokenEdge[]): void {
    this.graph = graph;
  }

  async detect(event: OrderflowEvent, _state: StateBackend): Promise<Opportunity[]> {
    const graph = this.graph ?? defaultTokenGraph();
    const startToken = graphStartToken(graph);
    const impacts = detectPoolImpact(event, graph);
    return impacts.map((impact) => ({
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
    }));
  }
}

function graphStartToken(graph: TokenEdge[]): string {
  const lend = graph.find((edge) => edge.slotKind === "lend");
  if (!lend) throw new Error("token graph has no lend edge to infer start token");
  return lend.tokenIn;
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
