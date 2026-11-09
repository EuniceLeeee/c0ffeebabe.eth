import { createRevmStrictSourceSimulation } from "./revm-strict-source-simulation.js";
import { NodeStrictClient } from "./simulator/node-strict-client.js";
import type { NodeFundingCache } from "./simulator/node-input-funding.js";
import type { RethTransportScheduler } from "./reth-transport-scheduler.js";

/** Keep the established source lease, request validation, receipt validation and
 * drain fences. The injected physical client is exclusively a node-RPC client;
 * the historical Revm* names below are compatibility types, not an engine path.
 */
export function createNodeStrictSourceSimulation(input:
  Omit<Parameters<typeof createRevmStrictSourceSimulation>[0], "createClient"> & {
    timeoutMs: number; scheduler?: Pick<RethTransportScheduler, "run">;
    allowExecutorCodeOverride?: boolean; lane?: "exact" | "discovery"; executor?: string; fundingCache?: NodeFundingCache;
  }) {
  return createRevmStrictSourceSimulation({ ...input, preserveExecutorCode: !input.allowExecutorCodeOverride,
    createClient: () => new NodeStrictClient({ timeoutMs: input.timeoutMs, scheduler: input.scheduler,
      executor: input.executor, executorRuntimeCode: input.executorRuntimeCode, allowExecutorCodeOverride: input.allowExecutorCodeOverride, lane: input.lane, fundingCache: input.fundingCache }) });
}
