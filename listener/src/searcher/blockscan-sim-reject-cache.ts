import assert from "node:assert/strict";
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

export interface SimRejectContinuation {
  readonly version: 1;
  readonly routes: readonly string[];
  readonly pools: readonly string[];
}

/** One logical live round. Only explicit continuation restores its denials;
 * a fresh round still starts empty. No token blacklist or retry timer. */
export class BlockScanSimRejectCache {
  private readonly revertedRoutes = new Set<string>();
  private readonly revertedPools = new Set<string>();
  private changes: { reset: boolean; routes: string[]; pools: string[] } = { reset: false, routes: [], pools: [] };

  takeContinuationDelta() {
    const changes = this.changes;
    this.changes = { reset: false, routes: [], pools: [] };
    return changes;
  }

  has(routeId: string): boolean { return this.revertedRoutes.has(routeId); }
  hasPool(edge: TokenEdge): boolean { return this.revertedPools.has(poolKey(edge)); }

  exportContinuation(): SimRejectContinuation {
    return { version: 1, routes: [...this.revertedRoutes], pools: [...this.revertedPools] };
  }

  restoreContinuation(state: SimRejectContinuation, edges: readonly TokenEdge[]): void {
    assert(this.revertedRoutes.size === 0 && this.revertedPools.size === 0 && state.version === 1 &&
      Array.isArray(state.routes) && Array.isArray(state.pools), "sim rejection continuation requires an empty cache");
    const knownPools = new Set(edges.map(poolKey));
    assert(state.routes.every(id => typeof id === "string" && id.length > 0) &&
      state.pools.every(id => typeof id === "string" && knownPools.has(id)) &&
      new Set(state.routes).size === state.routes.length && new Set(state.pools).size === state.pools.length,
    "sim rejection continuation differs from Ready");
    for (const id of state.routes) this.revertedRoutes.add(id);
    for (const id of state.pools) this.revertedPools.add(id);
  }

  record(routeId: string, sim: SimulationResult, input: PRevertAmount): boolean {
    // Diagnostic text and `success=false` alone are not EVM revert evidence:
    // RPC failures and non-positive (but executed) results use them too.
    if (!isPRevert(sim, input)) return false;
    if (!this.revertedRoutes.has(routeId)) this.changes.routes.push(routeId);
    this.revertedRoutes.add(routeId);
    return true;
  }

  /** Caller supplies only the uniquely attributed failed hop. */
  recordPool(edge: TokenEdge, sim: SimulationResult, input: PRevertAmount): boolean {
    if (!isPRevert(sim, input)) return false;
    const key = poolKey(edge);
    if (!this.revertedPools.has(key)) this.changes.pools.push(key);
    this.revertedPools.add(key);
    return true;
  }

  /** Isolated replay attempts and explicitly new live rounds start fresh. */
  clear(): void {
    this.revertedRoutes.clear(); this.revertedPools.clear();
    this.changes = { reset: true, routes: [], pools: [] };
  }
}
