import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBlockScanViewOverrides } from "../blockscan-view-overrides.js";
import { loadPinnedWarmPools } from "../pinned-warm-pools.js";
import { loadPoolUniverse } from "../pool-universe.js";
import {
  LEGACY_PRODUCTION_ROUTE_EDGES,
  PRODUCTION_ROUTE_ADAPTERS,
} from "../venues/production-registry.js";
import { PRODUCTION_POOL_ADAPTERS } from "../venues/pool-adapter-policy.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function address(index: number): string {
  return `0x${index.toString(16).padStart(40, "0")}`;
}

const expected = new Set([
  ...PRODUCTION_ROUTE_ADAPTERS.routeLegs.list().flatMap((adapter) => adapter.poolAdapters),
  ...LEGACY_PRODUCTION_ROUTE_EDGES.flatMap((descriptor) => descriptor.poolAdapters),
]);
assert(PRODUCTION_POOL_ADAPTERS.length === expected.size, "derived adapter set cardinality");
assert(
  PRODUCTION_POOL_ADAPTERS.every((adapter) => expected.has(adapter)),
  "file adapter policy must derive from route plus explicit legacy registries",
);

const dir = mkdtempSync(join(tmpdir(), "pool-adapter-policy-"));
try {
  const entries = PRODUCTION_POOL_ADAPTERS.map((adapter, index) => ({
    address: address(index + 1),
    adapter,
  }));

  const overridesPath = join(dir, "blockscan-view-overrides.json");
  writeFileSync(overridesPath, JSON.stringify(entries));
  const overrides = loadBlockScanViewOverrides(overridesPath);
  assert(overrides.length === expected.size, "blockscan overrides must accept every production adapter");
  assert(
    overrides.some((entry) => entry.adapter === "curve-underlying") &&
      overrides.some((entry) => entry.adapter === "balancer-v3"),
    "blockscan overrides must accept Curve underlying and Balancer V3",
  );

  const universePath = join(dir, "active-pools.json");
  writeFileSync(universePath, JSON.stringify({ pools: entries }));
  assert(
    loadPoolUniverse(universePath).length === expected.size,
    "pool universe must share the production adapter policy",
  );

  const pinnedPath = join(dir, "pinned-warm-pools.json");
  writeFileSync(pinnedPath, JSON.stringify({
    pools: entries.map((entry) => ({ ...entry, warmDirections: [] })),
  }));
  assert(
    loadPinnedWarmPools(pinnedPath).length === expected.size,
    "pinned warm pools must share the production adapter policy",
  );

  const invalidPath = join(dir, "invalid-overrides.json");
  writeFileSync(invalidPath, JSON.stringify([{ address: address(999), adapter: "synthetic" }]));
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert(loadBlockScanViewOverrides(invalidPath).length === 0, "unknown adapter must fail closed");
  } finally {
    console.warn = originalWarn;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`pool-adapter-policy PASS (${PRODUCTION_POOL_ADAPTERS.length} derived adapters)`);
