import { filterLiveProtocolRegistry } from "../main.js";
import { POOL_REGISTRY } from "../planner/token-graph.js";
import { PRODUCTION_ROUTE_ADAPTERS } from "../venues/production-registry.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const disabled = filterLiveProtocolRegistry(POOL_REGISTRY, false);
const gatedPoolAdapters = new Set(
  PRODUCTION_ROUTE_ADAPTERS.routeLegs.list()
    .filter((adapter) => adapter.requiresProtocolEdgesFlag)
    .flatMap((adapter) => adapter.poolAdapters),
);
assert(gatedPoolAdapters.size > 0, "production registry must declare gated protocol adapters");
for (const adapter of gatedPoolAdapters) {
  assert(!disabled.some((pool) => pool.adapter === adapter), `${adapter} must be disabled`);
}
assert(disabled.some((pool) => pool.adapter === "psm"), "grandfathered PSM must remain admitted");
assert(disabled.some((pool) => pool.adapter === "fluid-vault"), "grandfathered Fluid credit must remain admitted");
assert(gatedPoolAdapters.has("goldx"), "GoldX must be covered by descriptor metadata");

for (const pool of POOL_REGISTRY) {
  const descriptor = PRODUCTION_ROUTE_ADAPTERS.routeLegs.findForPool(pool.adapter);
  if (!descriptor) continue;
  assert(
    disabled.includes(pool) === !descriptor.requiresProtocolEdgesFlag,
    `${pool.adapter} filter disagrees with route descriptor`,
  );
}

const enabled = filterLiveProtocolRegistry(POOL_REGISTRY, true);
assert(enabled === POOL_REGISTRY, "enabled registry must preserve the production registry object");
assert(enabled.some((pool) => pool.adapter === "metronome-hgusdc"), "Metronome exit must be present when enabled");

console.log("protocol-edge-admission PASS");
