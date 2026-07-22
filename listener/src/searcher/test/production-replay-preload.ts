import { poolRegistryKey } from "../pool-universe.js";
import { POOL_REGISTRY } from "../planner/token-graph.js";
import { loadProductionReplayDiscoveredPools } from "./production-replay-artifact.js";

const artifactPath = process.env.PRODUCTION_REPLAY_DISCOVERY_ARTIFACT;
const artifactSha256 = process.env.PRODUCTION_REPLAY_DISCOVERY_SHA256;
if (!artifactPath || !artifactSha256) {
  throw new Error("production replay preload requires its wrapper-owned discovery artifact");
}

const discovered = loadProductionReplayDiscoveredPools(artifactPath, artifactSha256);
const existing = new Set(POOL_REGISTRY.map(poolRegistryKey));
for (const pool of discovered) {
  const key = poolRegistryKey(pool);
  if (existing.has(key)) {
    throw new Error(`production replay discovered pool collides with registry key ${key}`);
  }
  POOL_REGISTRY.push(pool);
  existing.add(key);
}
console.log(`PRODUCTION_REPLAY_PRELOAD=${JSON.stringify({ discoveredPools: discovered.length })}`);
