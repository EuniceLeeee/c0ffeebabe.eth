import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BlockScanSimRejectCache, isPRevert } from "./blockscan-sim-reject-cache.js";
import { blockScanRouteId } from "./blockscan-route-identity.js";
import type { TokenEdge } from "./planner/token-graph.js";
import type { SimulationResult } from "./simulator/botvm-simulator.js";
import { directRevertedRuntimeHop, type DirectRevertEvidence } from "./simulator/direct-revert-hop.js";
import type { ResolvedPlan } from "./solver/solver.js";

export function poolRevertFilterEnabled(value: string | undefined): boolean {
  if (value !== undefined && value !== "0" && value !== "1") {
    throw new Error("SEARCHER_BLOCKSCAN_POOL_REVERT_FILTER must be 0 or 1");
  }
  return value === "1";
}

/** One run owns its cache and evidence directory; files are never loaded as policy.
 * Missing/ambiguous hop evidence or failed writes leave only the route rejected.
 * Every authenticated failed hop is eligible, without a failure-reason allowlist. */
export class BlockScanPoolRevertAttributor {
  private directory: string | undefined;
  private count = 0;
  private bytes = 0;

  constructor(private readonly cache: BlockScanSimRejectCache,
    private readonly evidenceRoot = resolve("logs")) {}

  async record(input: {
    source: DirectRevertEvidence["executionInput"]["source"];
    edges: readonly TokenEdge[];
    p: bigint;
    trials: readonly { plan: ResolvedPlan; sim: SimulationResult }[];
    signal: AbortSignal;
    deadlineAtMs: number;
  }): Promise<string | null> {
    try {
      const open = () => !input.signal.aborted && Date.now() < input.deadlineAtMs;
      if (!open() || input.trials.length === 0 || !input.trials.every(({ plan, sim }) =>
        isPRevert(sim, { amount: plan.flashAmount, p: input.p }))) return null;
      let hop: number | null = null;
      const evidence: (DirectRevertEvidence & { attribution: NonNullable<ReturnType<typeof directRevertedRuntimeHop>> })[] = [];
      for (const { plan, sim } of input.trials) {
        const saved = sim.revertEvidence;
        if (!open() || !saved || saved.executionInput.source.number !== input.source.number ||
            saved.executionInput.source.hash.toLowerCase() !== input.source.hash.toLowerCase() ||
            saved.executionInput.source.generation !== input.source.generation ||
            saved.executionInput.calldata.toLowerCase() !== sim.calldata.toLowerCase()) return null;
        const next = directRevertedRuntimeHop(plan, input.edges, saved);
        if (next === null || (hop !== null && next.hopIndex !== hop)) return null;
        hop = next.hopIndex;
        evidence.push({ ...saved, attribution: next });
      }
      const edge = hop === null ? undefined : input.edges[hop];
      if (!edge || this.cache.hasPool(edge) || !open()) return null;
      const routeId = blockScanRouteId(input.edges);
      const body = JSON.stringify({ schemaVersion: 2, policy: "p-revert-failed-hop-any-cause",
        attributionSource: "original-sim", source: input.source, routeId,
        p: input.p, hopIndex: hop, edge,
        trials: input.trials.map(({ plan }, index) => ({ plan, ...evidence[index] })),
      }, (_key, value) => typeof value === "bigint" ? value.toString() : value) + "\n";
      const size = Buffer.byteLength(body);
      // Bounded optional evidence. Once full, keep rejecting exact routes only.
      if (size > 8 * 1024 * 1024 || this.bytes + size > 64 * 1024 * 1024) return null;
      if (!this.directory) {
        mkdirSync(this.evidenceRoot, { recursive: true });
        this.directory = mkdtempSync(join(this.evidenceRoot, "blockscan-pool-revert-"));
      }
      const path = join(this.directory, `${++this.count}.json`);
      writeFileSync(path, body, { flag: "wx", mode: 0o600 });
      this.bytes += size;
      const trial = input.trials[0]!;
      if (!this.cache.recordPool(edge, trial.sim, { amount: trial.plan.flashAmount, p: input.p })) return null;
      console.log(`[searcher/blockscan-pool-revert] ${JSON.stringify({
        sourceBlock: input.source.number, routeId, hopIndex: hop, target: edge.target,
        policy: "p-revert-failed-hop-any-cause", callTargets: evidence.map(e => e.attribution.callTarget),
        instanceKey: edge.instanceKey ?? null, evidencePath: path,
      })}`);
      return path;
    } catch {
      return null;
    }
  }
}
