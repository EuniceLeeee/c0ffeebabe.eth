import type { SimulationResult } from "./simulator/botvm-simulator.js";

/** One live process only. No TTL, persistence, token blacklist or retry timer. */
export class BlockScanSimRejectCache {
  private readonly revertedRoutes = new Set<string>();

  has(routeId: string): boolean { return this.revertedRoutes.has(routeId); }

  record(routeId: string, sim: SimulationResult): boolean {
    // Diagnostic text and `success=false` alone are not EVM revert evidence:
    // RPC failures and non-positive (but executed) results use them too.
    if (sim.success || sim.failure?.kind !== "revert" ||
      sim.failure.code !== "TRANSACTION_REVERTED") return false;
    this.revertedRoutes.add(routeId);
    return true;
  }

  /** Isolated replay attempts start fresh, just as a new live process does. */
  clear(): void { this.revertedRoutes.clear(); }
}
