import { filterLiveProtocolRegistry } from "../main.js";
import { POOL_REGISTRY } from "../planner/token-graph.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const disabled = filterLiveProtocolRegistry(POOL_REGISTRY, false);
for (const adapter of ["wsteth", "erc4626", "metronome-synth", "metronome-hgusdc"]) {
  assert(!disabled.some((pool) => pool.adapter === adapter), `${adapter} must be disabled`);
}
assert(disabled.some((pool) => pool.adapter === "psm"), "grandfathered PSM must remain admitted");

const enabled = filterLiveProtocolRegistry(POOL_REGISTRY, true);
assert(enabled === POOL_REGISTRY, "enabled registry must preserve the production registry object");
assert(enabled.some((pool) => pool.adapter === "metronome-hgusdc"), "Metronome exit must be present when enabled");

console.log("protocol-edge-admission PASS");
