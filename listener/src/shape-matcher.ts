/**
 * PathShape Matcher — matches NormalizedCallNode tree to known shapes.
 *
 * Shape = predefined action topology (Flash→Lend→Swap→Repay).
 * Not hardcoded per-tx. Doesn't care about tokens or protocol choice.
 * Prevents combinatorial explosion in plan search.
 *
 * Key rule: operates on call SUBTREE, not flat list.
 * V3/V4/UniV2 swaps may be nested deeper inside callback wrappers.
 */

import { collectBotVmDirectCalls } from "./classifier.js";
import { ActionKind } from "./types.js";
import type { NormalizedCallNode } from "./types.js";

export interface ShapeMatchResult {
  shapeName: string;
  flash: NormalizedCallNode;
  lends: NormalizedCallNode[];
  swaps: NormalizedCallNode[];
  approves: NormalizedCallNode[];
  transfers: NormalizedCallNode[];
  wraps: NormalizedCallNode[];
  unsupportedCalls: NormalizedCallNode[];
  skipReason?: string;
}

/**
 * Match the call tree against known shapes.
 * Returns match result or null (with skip reason for unsupported).
 */
export function matchShape(
  root: NormalizedCallNode,
  botVmAddress: string,
): ShapeMatchResult | null {
  // Find the flash loan node (BotVM's first call should be to Morpho/Balancer)
  const flash = findFlashLoan(root);
  if (!flash) return null;

  // Collect all BotVM direct calls inside the flash callback subtree
  const directCalls = collectBotVmDirectCalls(flash, botVmAddress);

  const lends: NormalizedCallNode[] = [];
  const swaps: NormalizedCallNode[] = [];
  const approves: NormalizedCallNode[] = [];
  const transfers: NormalizedCallNode[] = [];
  const wraps: NormalizedCallNode[] = [];
  const unsupported: NormalizedCallNode[] = [];

  for (const call of directCalls) {
    switch (call.kind) {
      case ActionKind.Lend:
        // Check for unsupported FluidDex callback swap (dexCallback has no bytes payload).
        if (call.protocol === "fluid-dex-callback-swap") {
          unsupported.push(call);
        } else {
          lends.push(call);
        }
        break;
      case ActionKind.Swap:
        swaps.push(call);
        break;
      case ActionKind.Approve:
        approves.push(call);
        break;
      case ActionKind.Transfer:
        transfers.push(call);
        break;
      case ActionKind.Wrap:
        wraps.push(call);
        break;
      default:
        // unknown or other
        break;
    }
  }

  // If unsupported calls exist (e.g. fluid-dex-callback-swap), report explicitly.
  // Don't silently return null — caller needs to see the real skip reason.
  if (unsupported.length > 0) {
    return {
      shapeName: "flash-lend-swap-repay",
      flash,
      lends,
      swaps,
      approves,
      transfers,
      wraps,
      unsupportedCalls: unsupported,
      skipReason:
        `unsupported calls: ${unsupported.map((c) => c.protocol + ":" + c.selector).join(", ")}`,
    };
  }

  // Check if shape matches: Flash → Lend+ → Swap+
  if (lends.length === 0 || swaps.length === 0) return null;

  return {
    shapeName: "flash-lend-swap-repay",
    flash,
    lends,
    swaps,
    approves,
    transfers,
    wraps,
    unsupportedCalls: unsupported,
  };
}

function findFlashLoan(root: NormalizedCallNode): NormalizedCallNode | null {
  if (root.kind === ActionKind.FlashLoan) return root;
  for (const child of root.children) {
    const found = findFlashLoan(child);
    if (found) return found;
  }
  return null;
}
