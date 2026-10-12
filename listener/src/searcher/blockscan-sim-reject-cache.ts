import type { SimulationResult } from "./simulator/botvm-simulator.js";
import type { TokenEdge } from "./planner/token-graph.js";

function poolKey(edge: TokenEdge): string {
  return edge.instanceKey ?? JSON.stringify([
    edge.adapterId, edge.target.toLowerCase(), edge.poolId?.toLowerCase() ?? null,
  ]);
}

export type PRevertAmount = { readonly amount: bigint; readonly p: bigint };

export function isPRevert(sim: SimulationResult, input: PRevertAmount): boolean {
  return input.p > 0n && input.amount === input.p && !sim.success &&
    sim.failure?.kind === "revert" && sim.failure.code === "TRANSACTION_REVERTED";
}

/** One live process only. No TTL, persistence, token blacklist or retry timer. */
export class BlockScanSimRejectCache {
  private readonly revertedRoutes = new Set<string>();
  private readonly revertedPools = new Set<string>();

  has(routeId: string): boolean { return this.revertedRoutes.has(routeId); }
  hasPool(edge: TokenEdge): boolean { return this.revertedPools.has(poolKey(edge)); }

  record(routeId: string, sim: SimulationResult, input: PRevertAmount): boolean {
    // Diagnostic text and `success=false` alone are not EVM revert evidence:
    // RPC failures and non-positive (but executed) results use them too.
    if (!isPRevert(sim, input)) return false;
    this.revertedRoutes.add(routeId);
    return true;
  }

  /** Caller supplies only the uniquely attributed failed hop. */
  recordPool(edge: TokenEdge, sim: SimulationResult, input: PRevertAmount): boolean {
    if (!isPRevert(sim, input)) return false;
    this.revertedPools.add(poolKey(edge));
    return true;
  }

  /** Isolated replay attempts start fresh, just as a new live process does. */
  clear(): void { this.revertedRoutes.clear(); this.revertedPools.clear(); }
}
