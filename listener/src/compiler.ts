/**
 * Plan Compiler — walks ResolvedPlanNode tree (post-order DFS),
 * delegates opcode encoding to adapters.
 *
 * ~25 lines of logic. All protocol-specific knowledge lives in adapters.
 *
 * Guard placement: guards are ordinary child nodes (adapterId = "assert-balance").
 * The solver/planner places them in the correct position (pre-repay inside flash callback).
 * The compiler doesn't care about guard semantics — it just does DFS.
 */

import * as registry from "./adapters/registry.js";
import { concatBytes } from "./encoder.js";
import type { ResolvedPlanNode } from "./types.js";

/**
 * Compile a resolved plan tree into a BotVM opcode script.
 *
 * @param root - The plan tree root (all amounts must be concrete bigint).
 * @param executor - BotVM address (used as recipient in adapter encoding).
 * @returns Packed opcode bytes ready for BotVM.execute().
 */
export function compilePlan(
  root: ResolvedPlanNode,
  executor: string,
): Uint8Array {
  return compileNode(root, executor);
}

function compileNode(
  node: ResolvedPlanNode,
  executor: string,
): Uint8Array {
  if (node.adapterId === "skip") return new Uint8Array(0);
  const adapter = registry.get(node.adapterId);

  // Leaf: no children, encode directly
  if (!adapter.isWrapper || node.children.length === 0) {
    try {
      return adapter.encode(node, executor, new Uint8Array(0));
    } catch (e: any) {
      throw new Error(`adapter ${node.adapterId} target=${node.target?.slice(0,12)} failed: ${e.message}`);
    }
  }

  // Wrapper: compile all children bottom-up → innerScript, then wrap
  const parts: Uint8Array[] = [];
  for (const child of node.children) {
    if (child.adapterId === "skip") continue; // skip undecodable nodes
    parts.push(compileNode(child, executor));
  }
  const innerScript = concatBytes(...parts);

  try {
    return adapter.encode(node, executor, innerScript);
  } catch (e: any) {
    throw new Error(`adapter ${node.adapterId} target=${node.target?.slice(0,12)} wrapper failed: ${e.message}`);
  }
}
