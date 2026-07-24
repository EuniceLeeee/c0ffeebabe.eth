import type { PoolEntry } from "../planner/token-graph.js";
import {
  poolRegistryKey,
  type PoolUniverseEntry,
} from "../pool-universe.js";
import type { IdentityAdmissionPolicy } from "./admission.js";
import {
  attestPoolIdentities,
  isRetryablePoolIdentityFailure,
  type IdentityCallBackend,
  type IdentityResolverRegistry,
  type RejectedPoolIdentity,
} from "./identity.js";
import type { SwapAdapter } from "./route-leg-adapter.js";

export interface RetainedSwapFamilyInventory {
  readonly pools: readonly PoolUniverseEntry[];
  readonly candidates: number;
  readonly rejected: readonly RejectedPoolIdentity[];
}

/**
 * Rolling Swap activity ranks pools; it must not erase topology that a
 * family already admitted. V2/V3 keep their mature factory/activity path.
 * Every other registered Swap family gets the same durable inventory rule
 * without a central family-id switch.
 *
 * Retained rows are re-attested at current N. A transport failure is not
 * negative identity evidence and therefore aborts publication; a completed
 * negative proof removes only that instance. Freshly observed rows always
 * replace retained rows with their current activity score.
 */
export async function retainVerifiedSwapFamilyInstances(input: {
  readonly families: readonly SwapAdapter[];
  readonly identityRegistry: IdentityResolverRegistry;
  readonly admissionPolicy: IdentityAdmissionPolicy;
  readonly backend: IdentityCallBackend;
  readonly priorPools: readonly PoolUniverseEntry[];
  readonly freshPools: readonly PoolEntry[];
}): Promise<RetainedSwapFamilyInventory> {
  const ownerByPoolAdapter = new Map<string, string>();
  for (const family of input.families) {
    if (family.matureDexUniverseDiscovery === true) continue;
    for (const poolAdapter of family.poolAdapters) {
      ownerByPoolAdapter.set(poolAdapter, family.id);
    }
  }

  const freshKeys = new Set(input.freshPools.map(poolRegistryKey));
  const candidates = input.priorPools.filter((pool) =>
    ownerByPoolAdapter.has(pool.adapter) &&
    !freshKeys.has(poolRegistryKey(pool))
  );
  const attested = await attestPoolIdentities(input.backend, candidates, {
    identityRegistry: input.identityRegistry,
    admissionPolicy: input.admissionPolicy,
  });
  const incomplete = attested.rejected.filter((item) =>
    isRetryablePoolIdentityFailure(item.reason)
  );
  if (incomplete.length > 0) {
    throw new Error(
      "swap family inventory identity reads incomplete: " +
        incomplete.map((item) =>
          `${item.adapter}:${item.address}:${item.reason}`
        ).join(", "),
    );
  }

  return Object.freeze({
    pools: Object.freeze(attested.accepted.map((pool) => Object.freeze({
      ...pool,
      score: 0,
      swapCount30d: 0,
      source: `retained-family-inventory:${ownerByPoolAdapter.get(pool.adapter)}`,
      topologyRetained: true as const,
    }))),
    candidates: candidates.length,
    rejected: Object.freeze(attested.rejected),
  });
}
