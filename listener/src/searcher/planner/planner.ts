import type { PlanNode } from "../../shared/types/plan.js";
import type { Opportunity } from "../detector/detector.js";
import type { PathTemplate } from "../templates/path-template.js";
import { passesConstraints } from "../templates/constraints.js";
import { buildTokenPaths, type TokenEdge, type TokenPath } from "./token-graph.js";

export interface CandidatePlan {
  templateName: string;
  root: PlanNode;
  opportunity: Opportunity;
  tokenPath: TokenPath;
  flashAdapterId: string;
}

export interface Planner {
  plan(opp: Opportunity, templates: PathTemplate[]): Promise<CandidatePlan[]>;
}

export class TemplatePlanner implements Planner {
  private graph: TokenEdge[] | null = null;
  private maxCandidates = 20;
  private maxHops = 8;
  private maxPoolsPerToken = Infinity;

  /** Inject a pre-built graph (from buildTokenGraph). Falls back to hardcoded default. */
  setGraph(graph: TokenEdge[]): void {
    this.graph = graph;
  }

  /** Cap the number of candidate plans returned per opportunity. */
  setMaxCandidates(n: number): void {
    this.maxCandidates = n;
  }

  /** Cap DFS depth (hops). Live should use a small value (e.g. 3); AC-3 keeps 8. */
  setMaxHops(n: number): void {
    this.maxHops = n;
  }

  /** Cap outgoing edges explored per token (top-N by score; pinned exempt). */
  setMaxPoolsPerToken(n: number): void {
    this.maxPoolsPerToken = n;
  }

  async plan(opp: Opportunity, templates: PathTemplate[]): Promise<CandidatePlan[]> {
    const candidates: CandidatePlan[] = [];
    const baseGraph = this.graph ?? [];
    if (baseGraph.length === 0) {
      console.warn("[planner] empty graph — no candidates will be generated; call setGraph()");
    }
    const impact = impactFromOpportunity(opp);
    const debug: string[] = [];

    for (const template of templates) {
      const flashSlot = template.slots.find((s) => s.kind === "flash");
      const flashAdapters = flashSlot?.adapters ?? ["morpho-flash"];

      // Full graph (template-adapter-filtered only). Relevance to the victim
      // impact is enforced at the PATH level by focusPathsOnImpact below — NOT by
      // culling edges here. Edge-level culling dropped mid-route legs
      // (e.g. USDC→DAI→USDT→sUSDS) that long arb loops require, which silently
      // disabled the flash-lend-swap-repay template.
      const graph = baseGraph.filter((edge) =>
        template.slots.some((slot) => slot.adapters.includes(edge.adapterId)),
      );
      // Pin the victim pool so top-N pruning never drops the edge the backrun
      // must reverse through (it may have a low activity score yet be essential).
      const pinnedPools = impact ? new Set([impact.pool.toLowerCase()]) : undefined;
      const rawPaths = buildTokenPaths(graph, opp.startToken, opp.profitToken, {
        maxHops: this.maxHops,
        maxPoolsPerToken: this.maxPoolsPerToken,
        pinnedPools,
      });
      const paths = focusPathsOnImpact(rawPaths, impact);

      let constraintPass = 0;
      for (const path of paths) {
        if (!passesConstraints(path, template.constraints, opp.startToken, opp.profitToken)) {
          continue;
        }
        constraintPass++;
        for (const flashId of flashAdapters) {
          candidates.push({
            templateName: template.name,
            root: buildAbstractRoot(path, opp, flashId),
            opportunity: opp,
            tokenPath: path,
            flashAdapterId: flashId,
          });
          if (candidates.length >= this.maxCandidates) break;
        }
        if (candidates.length >= this.maxCandidates) break;
      }
      if (candidates.length >= this.maxCandidates) break;
      debug.push(
        `${template.name}: edges=${graph.length}/${baseGraph.length} raw=${rawPaths.length} ` +
          `focused=${paths.length} constraintPass=${constraintPass}`,
      );
    }

    if (candidates.length === 0 && baseGraph.length > 0) {
      console.log(
        `[planner] 0 candidates start=${opp.startToken} profit=${opp.profitToken} ` +
          `impact=${impact ? `${impact.pool} ${impact.tokenIn}->${impact.tokenOut}` : "none"} | ` +
          debug.join(" | "),
      );
    }

    return candidates;
  }
}

const FLASH_TARGETS: Record<string, string> = {
  "morpho-flash": "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  "balancer-flash": "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
};

function buildAbstractRoot(path: TokenPath, opp: Opportunity, flashAdapterId: string): PlanNode {
  const flashTarget = FLASH_TARGETS[flashAdapterId];
  if (!flashTarget) throw new Error(`unknown flash adapter: ${flashAdapterId}`);
  return {
    adapterId: flashAdapterId,
    target: flashTarget,
    tokenIn: opp.startToken,
    tokenOut: opp.startToken,
    amount: { kind: "balance-bps", token: opp.startToken, account: "executor", bps: 0 },
    params: {
      mode: "mode-b",
      route: path.edges.map((edge) => ({
        adapterId: edge.adapterId,
        target: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
      })),
    },
    children: [],
  };
}

interface OpportunityImpact {
  pool: string;
  tokenIn: string;
  tokenOut: string;
}

function impactFromOpportunity(opp: Opportunity): OpportunityImpact | null {
  const impact = opp.hints.impact;
  if (!impact || typeof impact !== "object") return null;
  const maybe = impact as Partial<OpportunityImpact>;
  if (
    typeof maybe.pool !== "string" ||
    typeof maybe.tokenIn !== "string" ||
    typeof maybe.tokenOut !== "string"
  ) {
    return null;
  }
  return {
    pool: maybe.pool,
    tokenIn: maybe.tokenIn,
    tokenOut: maybe.tokenOut,
  };
}

function focusPathsOnImpact(paths: TokenPath[], impact: OpportunityImpact | null): TokenPath[] {
  if (!impact) return paths;

  // Best: reverse the impact through the SAME pool
  const samePoolReverse = paths.filter((path) =>
    path.edges.some((edge) =>
      sameAddress(edge.target, impact.pool) &&
      sameAddress(edge.tokenIn, impact.tokenOut) &&
      sameAddress(edge.tokenOut, impact.tokenIn),
    ),
  );
  if (samePoolReverse.length > 0) return samePoolReverse;

  // Good: reverse the impact direction through ANY pool (cross-venue arb).
  // Victim pushes tokenIn→tokenOut; arb reverses tokenOut→tokenIn on a
  // different venue. Common for V3↔V4 or V3↔Curve price divergence.
  const crossVenueReverse = paths.filter((path) =>
    path.edges.some((edge) =>
      sameAddress(edge.tokenIn, impact.tokenOut) &&
      sameAddress(edge.tokenOut, impact.tokenIn),
    ),
  );
  if (crossVenueReverse.length > 0) return crossVenueReverse;

  // Fallback: same pool, any direction
  return paths.filter((path) =>
    path.edges.some((edge) => sameAddress(edge.target, impact.pool)),
  );
}


function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
