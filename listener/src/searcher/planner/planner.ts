import type { PlanNode } from "../../shared/types/plan.js";
import type { Opportunity } from "../detector/detector.js";
import type { PathTemplate } from "../templates/path-template.js";
import { passesConstraints } from "../templates/constraints.js";
import { buildTokenPaths, defaultTokenGraph, type TokenEdge, type TokenPath } from "./token-graph.js";

export interface CandidatePlan {
  templateName: string;
  root: PlanNode;
  opportunity: Opportunity;
  tokenPath: TokenPath;
}

export interface Planner {
  plan(opp: Opportunity, templates: PathTemplate[]): Promise<CandidatePlan[]>;
}

export class TemplatePlanner implements Planner {
  private graph: TokenEdge[] | null = null;

  /** Inject a pre-built graph (from buildTokenGraph). Falls back to hardcoded default. */
  setGraph(graph: TokenEdge[]): void {
    this.graph = graph;
  }

  async plan(opp: Opportunity, templates: PathTemplate[]): Promise<CandidatePlan[]> {
    const candidates: CandidatePlan[] = [];
    const baseGraph = this.graph ?? defaultTokenGraph();

    for (const template of templates) {
      const graph = baseGraph.filter((edge) =>
        template.slots.some((slot) => slot.adapters.includes(edge.adapterId)),
      );
      const paths = buildTokenPaths(graph, opp.startToken, opp.profitToken);

      for (const path of paths) {
        // No path-specific filters here — the only gates are structural
        // (token continuity, final-token == start-token, template constraints).
        // Solver picks profitable ones; non-profitable get rejected at simulate.
        if (!passesConstraints(path, template.constraints, opp.startToken, opp.profitToken)) {
          continue;
        }
        candidates.push({
          templateName: template.name,
          root: buildAbstractRoot(path, opp),
          opportunity: opp,
          tokenPath: path,
        });
      }
    }

    return candidates;
  }
}

function buildAbstractRoot(path: TokenPath, opp: Opportunity): PlanNode {
  return {
    adapterId: "morpho-flash",
    target: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
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
