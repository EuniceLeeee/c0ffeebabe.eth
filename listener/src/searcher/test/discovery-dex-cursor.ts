import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoveryBackfillEnabledFromEnv,
  discoveryHotDexEnabledFromEnv,
  isDexDiscoveryCursor,
  loadDexDiscoveryCursor,
  resolveInitialDexSourceCompleteThrough,
  resolveStartupDexDiscoveryScan,
  saveDexDiscoveryCursorAsync,
  type DexDiscoveryCursor,
} from "../discovery-dex-cursor.js";

async function seedRoundtrip(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "dex-cursor-"));
  try {
    const path = join(dir, "cursor.json");
    const cursor: DexDiscoveryCursor = {
      schemaVersion: 1,
      sourceCompleteThrough: 100,
      graphCompleteThrough: 95,
      sourceHash: "0xabc",
      appliedHash: "0xdef",
    };
    await saveDexDiscoveryCursorAsync(path, cursor);
    const loaded = await loadDexDiscoveryCursor(path);
    assert.deepEqual(loaded, cursor);
    assert.equal(isDexDiscoveryCursor(loaded), true);

    assert.equal(await loadDexDiscoveryCursor(join(dir, "missing.json")), null);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "bad.json"), "{not json");
    assert.equal(await loadDexDiscoveryCursor(join(dir, "bad.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedPolicy(): void {
  const base = {
    universeRegistryMatches: false,
    universeToBlock: 90 as number | null,
    startupLandedDiscoveryFloor: 80,
    discoveryToBlock: 150,
  };
  assert.equal(
    resolveInitialDexSourceCompleteThrough({
      ...base,
      universeRegistryMatches: true,
      universeToBlock: 150,
      trustedThrough: 150,
    }),
    150,
    "matching universe cutoff is trusted only through trustedThrough",
  );
  assert.equal(
    resolveInitialDexSourceCompleteThrough({
      ...base,
      universeRegistryMatches: true,
      universeToBlock: 70,
      trustedThrough: 100,
    }),
    100,
    "stale matching universe prefers trusted (universe+cursor) max",
  );
  assert.equal(
    resolveInitialDexSourceCompleteThrough({
      ...base,
      trustedThrough: 100,
    }),
    100,
    "registry mismatch resumes from max(universe.toBlock, persisted cursor)",
  );
  assert.equal(
    resolveInitialDexSourceCompleteThrough({
      ...base,
      trustedThrough: 90,
    }),
    90,
    "registry mismatch with no cursor resumes from universe.toBlock, not fromBlock-1",
  );
  assert.equal(
    resolveInitialDexSourceCompleteThrough({
      ...base,
      universeToBlock: null,
      trustedThrough: -1,
    }),
    -1,
    "no anchors falls back to bootstrap (-1), never a deep fromBlock-1 re-scan",
  );
}

function schemaValidation(): void {
  assert.equal(isDexDiscoveryCursor({
    schemaVersion: 1,
    sourceCompleteThrough: 100,
    graphCompleteThrough: 100,
    sourceHash: "0xabc",
    appliedHash: "0xdef",
  }), true);
  assert.equal(isDexDiscoveryCursor({
    schemaVersion: 1,
    sourceCompleteThrough: 100,
    graphCompleteThrough: -1,
    sourceHash: "0xabc",
    appliedHash: 123,
  }), false);
  assert.equal(isDexDiscoveryCursor({
    schemaVersion: 2,
    sourceCompleteThrough: 100,
    graphCompleteThrough: 100,
    sourceHash: "0xabc",
  }), false);
  assert.equal(isDexDiscoveryCursor({
    schemaVersion: 1,
    sourceCompleteThrough: -2,
    graphCompleteThrough: 100,
    sourceHash: "0xabc",
  }), false);
  assert.equal(isDexDiscoveryCursor(null), false);
}

function startupScanRange(): void {
  const fullGap = resolveStartupDexDiscoveryScan({
    sourceCompleteThrough: 100,
    discoveryToBlock: 150,
    fallbackBlocksBack: 300,
    fallbackFactoryBlocksBack: 50000,
  });
  assert.deepEqual(fullGap, {
    fromBlock: 100,
    toBlock: 150,
    scanBlocksBack: 50,
    factoryBlocksBack: 50,
    fullGap: true,
  });
  const fallback = resolveStartupDexDiscoveryScan({
    sourceCompleteThrough: -1,
    discoveryToBlock: 150,
    fallbackBlocksBack: 300,
    fallbackFactoryBlocksBack: 50000,
  });
  assert.deepEqual(fallback, {
    fromBlock: 0,
    toBlock: 150,
    scanBlocksBack: 150,
    factoryBlocksBack: 50000,
    fullGap: false,
  });
  const alreadyCaughtUp = resolveStartupDexDiscoveryScan({
    sourceCompleteThrough: 150,
    discoveryToBlock: 150,
    fallbackBlocksBack: 300,
    fallbackFactoryBlocksBack: 50000,
  });
  assert.deepEqual(alreadyCaughtUp, {
    fromBlock: 150,
    toBlock: 150,
    scanBlocksBack: 0,
    factoryBlocksBack: 0,
    fullGap: true,
  });
}

function freezeSwitches(): void {
  assert.equal(discoveryBackfillEnabledFromEnv({}), false);
  assert.equal(discoveryBackfillEnabledFromEnv({ SEARCHER_DISCOVERY_BACKFILL_ENABLED: "0" }), false);
  assert.equal(discoveryBackfillEnabledFromEnv({ SEARCHER_DISCOVERY_BACKFILL_ENABLED: "1" }), true);
  assert.equal(discoveryHotDexEnabledFromEnv({}), false);
  assert.equal(discoveryHotDexEnabledFromEnv({ SEARCHER_DISCOVERY_HOT_DEX_ENABLED: "0" }), false);
  assert.equal(discoveryHotDexEnabledFromEnv({ SEARCHER_DISCOVERY_HOT_DEX_ENABLED: "1" }), true);
}

await seedRoundtrip();
seedPolicy();
schemaValidation();
startupScanRange();
freezeSwitches();
console.log("[discovery-dex-cursor] persistence + seed policy + freeze switches PASS");
