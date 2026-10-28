import assert from "node:assert/strict";
import type { BlockScanSimRejectCache } from "./blockscan-sim-reject-cache.js";
import type { TokenEdge } from "./planner/token-graph.js";
import { blockScanEdgeKey } from "./venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "./venues/route-instance-identity.js";

export function startupRevertFilterEnabled(value?: string): boolean {
  assert(value === undefined || value === "0" || value === "1", "SEARCHER_BLOCKSCAN_STARTUP_REVERT_FILTER must be 0 or 1");
  return value === "1";
}

/** Shared live/CLI wiring, not a second rejection rule. Only explicitly
 * attributed target-leg reverts enter the existing run-local sim pool cache. */
export function applyStartupTargetFilters(input: {
  enabled: boolean; rows: Iterable<Readonly<Record<string, unknown>>>; edges: readonly TokenEdge[];
  cache: BlockScanSimRejectCache; record: (event: Record<string, unknown>) => void;
}): number {
  if (!input.enabled) return 0;
  const graph = new Map(input.edges.map(edge => [blockScanEdgeKey(edge), edge]));
  let added = 0;
  for (const row of input.rows) {
    if (row.status !== "revert" || row.failureStage !== "target" || row.targetAttempted !== true) continue;
    const edge = graph.get(String(row.edgeId));
    assert(edge && edgeInstanceKey(edge) === row.instanceKey, "startup target no longer matches graph instance");
    assert(row.failedEdgeId === row.edgeId && Array.isArray(row.prefixEdges) &&
      row.failedHop === row.prefixEdges.length, "startup target attribution is not explicit");
    const amount = BigInt(String(row.expectedAmountIn));
    assert(amount > 0n && typeof row.revertDataHash === "string" && /^0x[0-9a-f]{64}$/.test(row.revertDataHash));
    if (input.cache.hasPool(edge)) continue;
    input.record({ origin: "startup-target-revert", filterApplied: true, edgeId: row.edgeId,
      instanceKey: row.instanceKey, sourceBlock: row.sourceBlock, sourceBlockHash: row.sourceBlockHash,
      scriptHash: row.scriptHash, revertDataHash: row.revertDataHash,
      sampledAmountIn: row.expectedAmountIn, policy: "run-local-pool; shared-with-search-sim" });
    assert(input.cache.recordPool(edge, { success: false, profitToken: edge.tokenOut,
      netProfit: 0n, grossProfit: 0n, gasUsed: BigInt(String(row.gasUsed)), calldata: "0x",
      failure: { kind: "revert", code: "TRANSACTION_REVERTED", cause: new Error("saved startup target revert") },
    }, { amount, p: amount }));
    added++;
  }
  return added;
}
