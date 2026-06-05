import type { TemplateConstraint } from "./path-template.js";
import type { TokenPath } from "../planner/token-graph.js";

export function passesConstraints(
  path: TokenPath,
  constraints: TemplateConstraint[],
  startToken: string,
  profitToken: string,
): boolean {
  for (const constraint of constraints) {
    if (constraint.type === "token-continuity" && !pathHasContinuity(path)) {
      return false;
    }
    if (
      constraint.type === "final-token-equals-start-token" &&
      (path.edges[0]?.tokenIn.toLowerCase() !== startToken.toLowerCase() ||
        path.edges[path.edges.length - 1]?.tokenOut.toLowerCase() !== profitToken.toLowerCase())
    ) {
      return false;
    }
  }
  return true;
}

function pathHasContinuity(path: TokenPath): boolean {
  for (let i = 1; i < path.edges.length; i++) {
    if (path.edges[i - 1].tokenOut.toLowerCase() !== path.edges[i].tokenIn.toLowerCase()) {
      return false;
    }
  }
  return true;
}

