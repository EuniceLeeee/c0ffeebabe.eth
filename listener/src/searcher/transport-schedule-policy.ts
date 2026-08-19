/**
 * Architecture-neutral step scheduling policy.
 *
 * The scheduler itself (RethTransportScheduler) is a pure permit arbiter: it
 * knows nothing about reth, families, coordinators or runtimes — only lane
 * names and a producer reserve. This module owns the only "scheduling
 * semantics" that exist in the searcher: which AdapterWorkStage belongs to
 * which lane. Every runtime (legacy RethAdapterWorkRuntime, the strict
 * current-source runtime, any future runtime) consumes this same mapping, so
 * the scheduling policy survives architecture changes untouched.
 */
import type { AdapterWorkStage } from "./adapter-work-intent.js";
import type { RethTransportLane } from "./reth-transport-scheduler.js";

/**
 * Stage → transport lane. Producer lanes may use the full scheduler capacity;
 * exact and discovery share the residual after the producer reserve, so
 * exact traffic can never starve the N-1 producer.
 */
export const STAGE_TRANSPORT_LANES: Readonly<
  Record<AdapterWorkStage, RethTransportLane>
> = Object.freeze({
  identity: "discovery",
  "instance-static": "discovery",
  "pricing-static": "producer-bulk",
  "pricing-current": "producer-bulk",
  "runtime-evidence": "producer-critical",
  "exact-refine": "exact",
});

export function rethLaneForAdapterStage(
  stage: AdapterWorkStage,
): RethTransportLane {
  return STAGE_TRANSPORT_LANES[stage];
}
