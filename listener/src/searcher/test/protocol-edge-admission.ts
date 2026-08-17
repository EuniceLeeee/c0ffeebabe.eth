import { filterLiveProtocolRegistry } from "../main.js";
import { POOL_REGISTRY } from "../planner/token-graph.js";
import { STRICT_PROJECTED_FAMILY_TEST_REGISTRY } from "./strict-family-test-compat.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const disabled = filterLiveProtocolRegistry(POOL_REGISTRY, false);
const gatedPoolAdapters = new Set(
  STRICT_PROJECTED_FAMILY_TEST_REGISTRY.routes().list()
    .filter((adapter) => adapter.requiresProtocolEdgesFlag)
    .flatMap((adapter) => adapter.poolAdapters),
);
assert(gatedPoolAdapters.size > 0, "production registry must declare gated protocol adapters");
for (const adapter of gatedPoolAdapters) {
  assert(!disabled.some((pool) => pool.adapter === adapter), `${adapter} must be disabled`);
}
// F8: no static protocol venues exist; PSM admission is strict-owned and
// never protocol-edge gated.
assert(!gatedPoolAdapters.has("psm"), "grandfathered PSM must remain admitted");
assert(
  STRICT_PROJECTED_FAMILY_TEST_REGISTRY.credits().some(
    (adapter) =>
      adapter.id === "credit:fluid" &&
      !adapter.requiresProtocolEdgesFlag,
  ),
  "Fluid credit lifecycle must remain independent of the protocol-edge flag",
);
assert(
  !POOL_REGISTRY.some((pool) => pool.adapter === "fluid-vault"),
  "Fluid credit must not retain a static executable row",
);
assert(gatedPoolAdapters.has("goldx"), "GoldX must be covered by descriptor metadata");

for (const pool of POOL_REGISTRY) {
  const descriptor = STRICT_PROJECTED_FAMILY_TEST_REGISTRY.routes().findForPool(pool.adapter);
  if (!descriptor) continue;
  assert(
    disabled.includes(pool) === !descriptor.requiresProtocolEdgesFlag,
    `${pool.adapter} filter disagrees with route descriptor`,
  );
}

const enabled = filterLiveProtocolRegistry(POOL_REGISTRY, true);
assert(enabled === POOL_REGISTRY, "enabled registry must preserve the production registry object");

console.log("protocol-edge-admission PASS");
