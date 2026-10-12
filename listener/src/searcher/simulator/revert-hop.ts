import { Interface } from "ethers";
import { runtimeProgramMatchesCall } from "./runtime-program-match.js";
import type { ResolvedPlan } from "../solver/solver.js";
import type { TokenEdge } from "../planner/token-graph.js";

export interface RevertCallFrame {
  readonly type?: string;
  readonly from?: string;
  readonly to?: string;
  readonly input?: string;
  readonly output?: string;
  readonly error?: string;
  readonly gasUsed?: string;
  readonly calls?: readonly RevertCallFrame[];
}

export interface RevertTraceEvidence {
  readonly trace: RevertCallFrame;
  readonly executionInput: {
    readonly source: { readonly number: number; readonly hash: string; readonly generation: number };
    readonly executor: string;
    readonly owner: string;
    readonly calldata: string;
  };
}

const ERROR = new Interface(["error Error(string)"]);

/** Attribute a failed runtime-amount hop only when the same failed call frame
 * uniquely matches one Family-emitted leg and its execution target. */
export function revertedRuntimeHop(
  plan: ResolvedPlan,
  edges: readonly TokenEdge[],
  trace: RevertCallFrame,
  executor: string,
): number | null {
  try {
    if (!trace.error) return null;
    let flow: ResolvedPlan["root"] | undefined;
    let flows = 0;
    const visit = (node: ResolvedPlan["root"]): void => {
      if (node.adapterId === "runtime-amount-flow") {
        flow = node;
        flows++;
      }
      node.children.forEach(visit);
    };
    visit(plan.root);
    if (flows !== 1 || !flow || typeof flow.params.legs !== "string" || flow.amount !== plan.flashAmount) return null;
    const legs = JSON.parse(flow.params.legs) as { tokenIn: string; tokenOut: string; program: string }[];
    if (!Array.isArray(legs) || legs.length === 0 || legs.length !== edges.length ||
        legs.some((leg, i) => leg.tokenIn.toLowerCase() !== edges[i]!.tokenIn.toLowerCase() ||
          leg.tokenOut.toLowerCase() !== edges[i]!.tokenOut.toLowerCase())) return null;

    let frame: RevertCallFrame | undefined = trace;
    let executionFrame: RevertCallFrame | undefined;
    while (frame?.error) {
      if (frame.to?.toLowerCase() === executor.toLowerCase()) executionFrame = frame;
      frame = frame.calls?.at(-1);
    }
    if (!executionFrame) return null;
    const revert = ERROR.parseError(executionFrame.output ?? "0x");
    if (revert?.args[0] !== "runtime external call") return null;
    const failed = executionFrame.calls?.at(-1);
    if (failed?.error !== "execution reverted" || failed.from?.toLowerCase() !== executor.toLowerCase()) return null;
    const matches = legs.flatMap((leg, i) =>
      failed.to?.toLowerCase() === edges[i]!.target.toLowerCase() &&
        runtimeProgramMatchesCall(leg.program, failed) ? [i] : []);
    return matches.length === 1 ? matches[0]! : null;
  } catch {
    return null;
  }
}
