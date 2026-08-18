export interface ProductionRoutePoolFact {
  address: string;
  adapter: string;
}

export interface TraceActionMatcher {
  matchTrace(target: string, selector: string): boolean;
}

export interface ProductionRouteCallRegistry {
  readonly pools: readonly ProductionRoutePoolFact[];
  findRouteActionAdapter(edgeAdapterId: string): TraceActionMatcher | null;
  matchesProtocolCall(
    target: string,
    selector: string,
    pools?: readonly ProductionRoutePoolFact[],
  ): boolean;
}

interface RouteFamilyFact {
  readonly kind: string;
  readonly poolAdapters: readonly string[];
  readonly edgeAdapterIds: readonly string[];
}

let cachedRegistry: Promise<ProductionRouteCallRegistry | null> | null = null;

/**
 * Load the production pool/route/action facts only when a current-repository
 * analysis actually needs them. Some lifecycle gates replay historical
 * analysis-only worktrees without a listener tree, so eager imports here would
 * break those gates before they perform any transaction analysis.
 */
export function loadProductionRouteCallRegistry(): Promise<ProductionRouteCallRegistry | null> {
  cachedRegistry ??= loadRegistry();
  return cachedRegistry;
}

export async function requireProductionRouteCallRegistry(): Promise<ProductionRouteCallRegistry> {
  const registry = await loadProductionRouteCallRegistry();
  if (!registry) throw new Error("production route/action registry unavailable");
  return registry;
}

async function loadRegistry(): Promise<ProductionRouteCallRegistry | null> {
  try {
    await import("../../../listener/src/adapters/index.js");
    const [{ get: getActionAdapter }, production, tokenGraph] = await Promise.all([
      import("../../../listener/src/adapters/registry.js"),
      import("../../../listener/src/searcher/strict-production-family-declarations.js"),
      import("../../../listener/src/searcher/planner/token-graph.js"),
    ]);
    const routeFamilies = production.PRODUCTION_STRICT_FAMILY_DECLARATIONS;
    const routeFamilyByPoolAdapter = new Map(
      routeFamilies.routeFamilies.flatMap((family) =>
        family.poolAdapters.map((poolAdapter) => [String(poolAdapter), family] as const)
      ),
    );
    const pools: readonly ProductionRoutePoolFact[] = [];

    function findRouteActionAdapter(edgeAdapterId: string): TraceActionMatcher | null {
      const registered = routeFamilies.routeFamilies.some((family) =>
        family.edgeAdapterIds.includes(edgeAdapterId)
      );
      if (!registered) return null;
      try {
        return getActionAdapter(edgeAdapterId);
      } catch {
        return null;
      }
    }

    function matchesProtocolCall(
      target: string,
      selector: string,
      poolFacts: readonly ProductionRoutePoolFact[] = pools,
    ): boolean {
      const normalizedTarget = target.toLowerCase();
      const normalizedSelector = selector.slice(0, 10).toLowerCase();
      if (!/^0x[a-f0-9]{8}$/.test(normalizedSelector)) return false;

      // A runtime universe is primarily a discovered swap-pool snapshot and
      // can omit fixed protocol-conversion identities such as GOLDx. Preserve
      // those production registry facts while still admitting dynamic vaults
      // supplied by the attested universe.
      const matchesPool = (pool: ProductionRoutePoolFact): boolean => {
        if (pool.address.toLowerCase() !== normalizedTarget) return false;
        const route = routeFamilyByPoolAdapter.get(pool.adapter);
        if (route?.kind !== "protocol-conversion") return false;
        return route.edgeAdapterIds.some((edgeAdapterId) =>
          findRouteActionAdapter(edgeAdapterId)?.matchTrace(
            normalizedTarget,
            normalizedSelector,
          ) ?? false
        );
      };
      if (pools.some(matchesPool)) return true;
      return poolFacts !== pools && poolFacts.some(matchesPool);
    }

    return Object.freeze({ pools, findRouteActionAdapter, matchesProtocolCall });
  } catch {
    return null;
  }
}
