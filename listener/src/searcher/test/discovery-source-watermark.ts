import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  advanceDiscoveryFamilySourceWatermarks,
  createDiscoveryFamilySourceWatermarks,
  discoveryCursorForPersistence,
  discoveryFamilyCompleteThrough,
  discoveryGraphCompleteThrough,
  discoverySourceCompleteThrough,
  planContiguousDiscoveryChunk,
  planDiscoveryStartup,
  planLiveBackfillTargets,
  seedDiscoverySourceWatermark,
  type DiscoveryFamilySources,
} from "../discovery-source-watermark.js";
import {
  advanceProtocolObservedContiguousAuthority,
  createProtocolDiscoveryEvidenceCache,
  loadProtocolDiscoveryEvidenceCache,
  saveProtocolDiscoveryEvidenceCache,
  setProtocolObservedCursor,
} from "../protocol-discovery-cache.js";
import {
  ProtocolDiscoveryCoverageCoordinator,
  protocolDiscoveryRangeForLane,
} from "../protocol-discovery-coordinator.js";

const OBSERVED = "observed-interaction";
const DEX_DOMAIN = "dex-token-domain";
const EIGENPIE = "protocol:eigenpie";
const FLUID = "swap:fluid-dex";

restartGapNeverDropsBlocks();
cleanRecentWindowIsPositiveOnly();
registryChangeRecentWindowIsPositiveOnly();
cleanStartupCanBeginAuthoritativeBackfill();
registryChangeCanBeginAuthoritativeBackfill();
recentPositiveThenContiguousBackfill();
oneFamilySourceFailureDoesNotEraseSiblingProgress();
eigenpieObservedOnlyCannotBorrowSiblingCompleteness();
positiveOnlyScanAdvancesOnlyOperationalCursor();
operationalCursorOutrunsAuthorityAcrossRestart();
hotLaneNeverRunsProtocolDiscovery();
detachedDexBackfillCoversItsSourceHead();

console.log("discovery-source-watermark PASS (11/11)");

function restartGapNeverDropsBlocks(): void {
  const families: readonly DiscoveryFamilySources[] = [{
    familyId: EIGENPIE,
    sourceIds: [OBSERVED],
  }];
  const watermarks = createDiscoveryFamilySourceWatermarks(families);
  seedDiscoverySourceWatermark(watermarks, families, OBSERVED, 100_000);
  const startup = planDiscoveryStartup({
    targetBlock: 180_001,
    persistedCursor: 100_000,
    sourceRegistryChanged: false,
    recentBlocks: 300,
    maxCatchupBlocks: 50_000,
  });
  assert.equal(startup.mode, "contiguous");
  assert.deepEqual(startup.range, {
    fromBlock: 100_001,
    toBlock: 150_000,
  });
  assert.equal(
    discoveryCursorForPersistence(startup.mode, startup.range.toBlock),
    150_000,
  );
  const second = planContiguousDiscoveryChunk(
    startup.range.toBlock,
    180_001,
    50_000,
  );
  assert.deepEqual(second, {
    fromBlock: 150_001,
    toBlock: 180_001,
  });
  assert.equal(
    second!.fromBlock,
    startup.range.toBlock + 1,
    "restart catch-up chunks must be adjacent",
  );
  assert.ok(
    startup.range.toBlock - startup.range.fromBlock + 1 <= 50_000 &&
      second!.toBlock - second!.fromBlock + 1 <= 50_000,
    "each catch-up chunk must respect maxCatchup",
  );
  const firstAdvance = advanceDiscoveryFamilySourceWatermarks({
    current: watermarks,
    families,
    range: startup.range,
    familyComplete: new Map([[EIGENPIE, true]]),
    sourceComplete: new Map([[OBSERVED, true]]),
    sourceIssues: [],
    contiguousSourceIds: new Set([OBSERVED]),
  });
  const secondAdvance = advanceDiscoveryFamilySourceWatermarks({
    current: firstAdvance.watermarks,
    families,
    range: second!,
    familyComplete: new Map([[EIGENPIE, true]]),
    sourceComplete: new Map([[OBSERVED, true]]),
    sourceIssues: [],
    contiguousSourceIds: new Set([OBSERVED]),
  });
  assert.equal(
    discoveryFamilyCompleteThrough(families[0], firstAdvance.watermarks),
    150_000,
  );
  assert.equal(
    discoveryFamilyCompleteThrough(families[0], secondAdvance.watermarks),
    180_001,
    "only adjacent successful chunks may reach the restart target",
  );
}

function cleanRecentWindowIsPositiveOnly(): void {
  const families: readonly DiscoveryFamilySources[] = [{
    familyId: EIGENPIE,
    sourceIds: [OBSERVED],
  }];
  const startup = planDiscoveryStartup({
    targetBlock: 1_000,
    persistedCursor: null,
    sourceRegistryChanged: false,
    recentBlocks: 300,
    maxCatchupBlocks: 50_000,
  });
  assert.equal(startup.mode, "positive-only");
  assert.deepEqual(startup.range, { fromBlock: 701, toBlock: 1_000 });
  assert.equal(
    discoveryCursorForPersistence(startup.mode, startup.range.toBlock),
    null,
    "a clean recent-window endpoint must not survive restart as an authoritative cursor",
  );
  const advanced = advanceDiscoveryFamilySourceWatermarks({
    current: createDiscoveryFamilySourceWatermarks(families),
    families,
    range: startup.range,
    familyComplete: new Map([[EIGENPIE, true]]),
    sourceComplete: new Map([[OBSERVED, true]]),
    sourceIssues: [],
    contiguousSourceIds: new Set([OBSERVED]),
    positiveOnlySourceIds: new Set([OBSERVED]),
  });
  assert.equal(
    discoveryGraphCompleteThrough(families, advanced.watermarks),
    -1,
    "a clean bounded window cannot manufacture historical completeness",
  );
}

function registryChangeRecentWindowIsPositiveOnly(): void {
  const startup = planDiscoveryStartup({
    targetBlock: 20_000,
    persistedCursor: 19_500,
    sourceRegistryChanged: true,
    recentBlocks: 300,
    maxCatchupBlocks: 50_000,
  });
  assert.equal(startup.mode, "positive-only");
  assert.deepEqual(
    startup.range,
    { fromBlock: 19_701, toBlock: 20_000 },
    "a changed registry must not reuse the old cursor as completeness proof",
  );
  assert.equal(
    discoveryCursorForPersistence(startup.mode, startup.range.toBlock),
    null,
    "registry-change positive-only progress must not be persisted as completeness",
  );
}

function cleanStartupCanBeginAuthoritativeBackfill(): void {
  const startup = planDiscoveryStartup({
    targetBlock: 1_000,
    persistedCursor: null,
    sourceRegistryChanged: false,
    recentBlocks: 300,
    maxCatchupBlocks: 400,
    bootstrapMode: "contiguous",
  });
  assert.equal(startup.mode, "contiguous");
  assert.equal(startup.cursorBefore, -1);
  assert.deepEqual(
    startup.range,
    { fromBlock: 0, toBlock: 399 },
    "strict bootstrap must start at block zero instead of manufacturing a recent cursor",
  );
}

function registryChangeCanBeginAuthoritativeBackfill(): void {
  const startup = planDiscoveryStartup({
    targetBlock: 20_000,
    persistedCursor: 19_500,
    sourceRegistryChanged: true,
    recentBlocks: 300,
    maxCatchupBlocks: 500,
    bootstrapMode: "contiguous",
  });
  assert.equal(startup.mode, "contiguous");
  assert.equal(startup.cursorBefore, -1);
  assert.deepEqual(
    startup.range,
    { fromBlock: 0, toBlock: 499 },
    "changed matcher semantics must rebuild authoritative history from block zero",
  );
}

function recentPositiveThenContiguousBackfill(): void {
  const families: readonly DiscoveryFamilySources[] = [{
    familyId: EIGENPIE,
    sourceIds: [OBSERVED],
  }];
  const watermarks = createDiscoveryFamilySourceWatermarks(families);
  const positive = planDiscoveryStartup({
    targetBlock: 1_000,
    persistedCursor: null,
    sourceRegistryChanged: false,
    recentBlocks: 100,
    maxCatchupBlocks: 250,
  });
  const positiveResult = advanceDiscoveryFamilySourceWatermarks({
    current: watermarks,
    families,
    range: positive.range,
    familyComplete: new Map([[EIGENPIE, true]]),
    sourceComplete: new Map([[OBSERVED, true]]),
    sourceIssues: [],
    contiguousSourceIds: new Set([OBSERVED]),
    positiveOnlySourceIds: new Set([OBSERVED]),
  });
  assert.equal(discoveryGraphCompleteThrough(families, positiveResult.watermarks), -1);
  const firstBackfill = planContiguousDiscoveryChunk(-1, 1_000, 250)!;
  assert.deepEqual(firstBackfill, { fromBlock: 0, toBlock: 249 });
  const authoritative = advanceDiscoveryFamilySourceWatermarks({
    current: positiveResult.watermarks,
    families,
    range: firstBackfill,
    familyComplete: new Map([[EIGENPIE, true]]),
    sourceComplete: new Map([[OBSERVED, true]]),
    sourceIssues: [],
    contiguousSourceIds: new Set([OBSERVED]),
  });
  assert.equal(
    discoveryGraphCompleteThrough(families, authoritative.watermarks),
    249,
    "a recent positive pass must not prevent later genesis-contiguous progress",
  );
}

function oneFamilySourceFailureDoesNotEraseSiblingProgress(): void {
  const family = {
    familyId: "protocol:multi-source",
    sourceIds: [DEX_DOMAIN, OBSERVED],
  } satisfies DiscoveryFamilySources;
  const advanced = advanceDiscoveryFamilySourceWatermarks({
    current: createDiscoveryFamilySourceWatermarks([family]),
    families: [family],
    range: { fromBlock: 0, toBlock: 99 },
    familyComplete: new Map([[family.familyId, false]]),
    familySourceComplete: new Map([
      [`${family.familyId}\u001f${DEX_DOMAIN}`, false],
      [`${family.familyId}\u001f${OBSERVED}`, true],
    ]),
    sourceComplete: new Map([
      [DEX_DOMAIN, false],
      [OBSERVED, true],
    ]),
    sourceIssues: [{
      sourceId: DEX_DOMAIN,
      impactedFamilyIds: [family.familyId],
      retryable: true,
    }],
    contiguousSourceIds: new Set([OBSERVED]),
  });
  assert.equal(
    advanced.watermarks.get(`${family.familyId}\u001f${OBSERVED}`),
    99,
    "an observed cursor must advance when only its address sibling failed",
  );
  assert.equal(
    advanced.watermarks.get(`${family.familyId}\u001f${DEX_DOMAIN}`),
    -1,
    "the failed address source must remain incomplete",
  );
}

function eigenpieObservedOnlyCannotBorrowSiblingCompleteness(): void {
  const families: readonly DiscoveryFamilySources[] = [
    { familyId: EIGENPIE, sourceIds: [OBSERVED] },
    { familyId: FLUID, sourceIds: [DEX_DOMAIN] },
  ];
  const watermarks = createDiscoveryFamilySourceWatermarks(families);
  seedDiscoverySourceWatermark(watermarks, families, DEX_DOMAIN, 9_999);
  assert.equal(
    discoveryFamilyCompleteThrough(families[1], watermarks),
    9_999,
    "the DEX-domain family has its own current source proof",
  );
  assert.equal(
    discoveryFamilyCompleteThrough(families[0], watermarks),
    -1,
    "Eigenpie observed-only must not inherit a sibling source watermark",
  );
  assert.equal(
    discoverySourceCompleteThrough(families, watermarks, OBSERVED, 9_999),
    -1,
    "the observed source cursor remains independently incomplete",
  );
  assert.equal(
    discoveryGraphCompleteThrough(families, watermarks),
    -1,
    "one current family number cannot make an observed-only family complete",
  );
}

function operationalCursorOutrunsAuthorityAcrossRestart(): void {
  const cache = createProtocolDiscoveryEvidenceCache(1);
  const authorityHash = `0x${"11".repeat(32)}`;
  const operationalHash = `0x${"22".repeat(32)}`;
  const families: readonly DiscoveryFamilySources[] = [{
    familyId: EIGENPIE,
    sourceIds: [OBSERVED],
  }];
  const authority = advanceProtocolObservedContiguousAuthority({
    cache,
    families,
    familySourceCoverage: [{
      familyId: EIGENPIE,
      sourceId: OBSERVED,
      complete: true,
    }],
    fromBlock: 0,
    toBlock: 10,
    toBlockHash: authorityHash,
    contiguousSourceIds: new Set([OBSERVED]),
  });
  assert.equal(authority?.completeThroughBlock, 10);

  setProtocolObservedCursor(cache, 20, operationalHash);
  assert.equal(
    cache.runtime.observedCursor,
    20,
    "a bounded positive pass must advance operational ingestion",
  );
  assert.equal(
    cache.runtime.observedContiguousAuthority?.completeThroughBlock,
    10,
    "newer positive evidence must not erase older contiguous authority",
  );

  const root = mkdtempSync(resolve(tmpdir(), "protocol-cursor-contract-"));
  const path = resolve(root, "cache.json");
  try {
    saveProtocolDiscoveryEvidenceCache(path, cache);
    const loaded = loadProtocolDiscoveryEvidenceCache(path, 1);
    assert.equal(loaded.runtime.observedCursor, 20);
    assert.equal(loaded.runtime.observedCursorHash, operationalHash);
    assert.equal(
      loaded.runtime.observedContiguousAuthority?.completeThroughBlock,
      10,
      "restart must preserve the independent, older authority watermark",
    );
    assert.equal(
      loaded.runtime.observedContiguousAuthority?.completeThroughHash,
      authorityHash,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function positiveOnlyScanAdvancesOnlyOperationalCursor(): void {
  const fixture = {
    familyId: EIGENPIE,
    sourceIds: [OBSERVED],
  };
  const coordinator = new ProtocolDiscoveryCoverageCoordinator([fixture]);
  const watermarks = coordinator.snapshot();
  assert.equal(coordinator.graphCompleteThrough(watermarks), -1);
  assert.equal(
    coordinator.nextObservedCursor({
      currentCursor: -1,
      range: { fromBlock: 701, toBlock: 1_000 },
      watermarks,
      positiveOnlyObserved: true,
      eventSourceComplete: false,
    }),
    1_000,
    "bounded startup scans advance hot-ingestion progress",
  );
  assert.equal(
    coordinator.graphCompleteThrough(watermarks),
    -1,
    "bounded startup scans do not manufacture negative completeness",
  );
  assert.equal(
    coordinator.nextObservedCursor({
      currentCursor: 1_000,
      range: { fromBlock: 1_001, toBlock: 1_001 },
      watermarks,
      positiveOnlyObserved: false,
      eventSourceComplete: true,
    }),
    1_001,
    "a hot scan advances ingestion even while historical authority remains behind",
  );
  assert.equal(
    coordinator.nextObservedCursor({
      currentCursor: 1_001,
      range: { fromBlock: 0, toBlock: 99 },
      watermarks,
      positiveOnlyObserved: false,
      eventSourceComplete: true,
    }),
    1_001,
    "background backfill must never rewind the newer hot-ingestion cursor",
  );
  assert.equal(
    coordinator.nextObservedCursor({
      currentCursor: 1_001,
      range: { fromBlock: 1_002, toBlock: 1_003 },
      watermarks,
      positiveOnlyObserved: false,
      eventSourceComplete: false,
    }),
    1_001,
    "retryable incremental trace failures must retain the failed range",
  );
}

function hotLaneNeverRunsProtocolDiscovery(): void {
  assert.equal(
    protocolDiscoveryRangeForLane({
      mode: "hot",
      observedRange: { fromBlock: 10, toBlock: 11 },
      addressOnlyRetryRange: { fromBlock: 11, toBlock: 11 },
    }),
    null,
    "current-head DEX passes must never inherit protocol receipt/trace work",
  );
  assert.deepEqual(
    protocolDiscoveryRangeForLane({
      mode: "backfill",
      observedRange: { fromBlock: 10, toBlock: 11 },
      addressOnlyRetryRange: { fromBlock: 11, toBlock: 11 },
    }),
    { fromBlock: 10, toBlock: 11 },
    "background discovery retains the pending observed range",
  );
}

function detachedDexBackfillCoversItsSourceHead(): void {
  assert.deepEqual(
    planLiveBackfillTargets(1_001),
    {
      dexThrough: 1_001,
      protocolThrough: 1_000,
    },
    "H-prepared DEX state must satisfy H+1 predecessor admission",
  );
  assert.deepEqual(
    planLiveBackfillTargets(0),
    {
      dexThrough: 0,
      protocolThrough: 0,
    },
    "genesis targets must remain non-negative",
  );
}
