import { filterLiveProtocolRegistry } from "../main.js";
import { POOL_REGISTRY } from "../planner/token-graph.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const disabled = filterLiveProtocolRegistry(POOL_REGISTRY, false);
const gatedPoolAdapters = new Set(
  PRODUCTION_ADAPTER_FAMILIES.routes().list()
    .filter((adapter) => adapter.requiresProtocolEdgesFlag)
    .flatMap((adapter) => adapter.poolAdapters),
);
assert(gatedPoolAdapters.size > 0, "production registry must declare gated protocol adapters");
for (const adapter of gatedPoolAdapters) {
  assert(!disabled.some((pool) => pool.adapter === adapter), `${adapter} must be disabled`);
}
assert(disabled.some((pool) => pool.adapter === "psm"), "grandfathered PSM must remain admitted");
assert(
  PRODUCTION_ADAPTER_FAMILIES.credits().some(
    (adapter) =>
      adapter.id === "credit:fluid" &&
      adapter.discovery !== undefined &&
      !adapter.requiresProtocolEdgesFlag,
  ),
  "Fluid credit discovery must remain independent of the protocol-edge flag",
);
assert(
  !POOL_REGISTRY.some((pool) => pool.adapter === "fluid-vault"),
  "Fluid credit must not retain a static executable row",
);
assert(gatedPoolAdapters.has("goldx"), "GoldX must be covered by descriptor metadata");

for (const pool of POOL_REGISTRY) {
  const descriptor = PRODUCTION_ADAPTER_FAMILIES.routes().findForPool(pool.adapter);
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
