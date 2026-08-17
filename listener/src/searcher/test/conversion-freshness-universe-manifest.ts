import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  POOL_UNIVERSE_BUILD_MANIFEST_PROFILE,
} from "../pool-universe.js";
import {
  productionPoolUniverseSourceFingerprintsStrict,
} from "../strict-universe-source-fingerprints.js";

export function productionUniverseRegistrySourceFingerprints():
  readonly string[] {
  return productionPoolUniverseSourceFingerprintsStrict();
}

/**
 * A production-full freshness run may only consume a universe generated from
 * the complete registry-derived 30-day landed-flow source at the selected
 * N-1 block. The sidecar binds both build semantics and exact output bytes.
 */
export function validateConversionUniverseBuildManifest(input: {
  readonly manifestPath: string;
  readonly universePath: string;
  readonly universeSha256: string;
  readonly universePools: number;
  readonly expectedDiscoveryQueueExists: boolean;
  readonly expectedDiscoveryQueueSha256: string;
  readonly expectedSource: {
    readonly number: number;
    readonly hash: string;
    readonly stateRoot: string;
  };
}): string {
  const raw = readFileSync(input.manifestPath, "utf8");
  const value = JSON.parse(raw) as {
    readonly schemaVersion?: unknown;
    readonly profile?: unknown;
    readonly chainId?: unknown;
    readonly source?: {
      readonly number?: unknown;
      readonly hash?: unknown;
      readonly stateRoot?: unknown;
    };
    readonly inputs?: {
      readonly fromBlock?: unknown;
      readonly toBlock?: unknown;
      readonly lookbackBlocks?: unknown;
      readonly minSwaps?: unknown;
      readonly maxPools?: unknown;
      readonly topicScanMode?: unknown;
      readonly arbRelevance?: unknown;
      readonly relevanceOversample?: unknown;
      readonly v4BackfillLookbackBlocks?: unknown;
      readonly discoveryQueue?: {
        readonly profile?: unknown;
        readonly exists?: unknown;
        readonly contentSha256?: unknown;
        readonly entries?: unknown;
      };
    };
    readonly registry?: {
      readonly sourceFingerprints?: unknown;
    };
    readonly output?: {
      readonly contentSha256?: unknown;
      readonly pools?: unknown;
    };
  };
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.profile, POOL_UNIVERSE_BUILD_MANIFEST_PROFILE);
  assert.equal(value.chainId, 1);
  assert.equal(value.source?.number, input.expectedSource.number);
  assert.equal(
    String(value.source?.hash).toLowerCase(),
    input.expectedSource.hash.toLowerCase(),
  );
  assert.equal(
    String(value.source?.stateRoot).toLowerCase(),
    input.expectedSource.stateRoot.toLowerCase(),
  );
  assert.equal(value.inputs?.toBlock, input.expectedSource.number);
  assert.equal(value.inputs?.lookbackBlocks, 30 * 7_200);
  assert.equal(
    value.inputs?.fromBlock,
    Math.max(0, input.expectedSource.number - 30 * 7_200),
  );
  assert.equal(value.inputs?.minSwaps, 1);
  assert.equal(value.inputs?.maxPools, null);
  assert(
    value.inputs?.topicScanMode === "per-event" ||
      value.inputs?.topicScanMode === "union",
    "production-full universe has an unknown topic scan mode",
  );
  assert.equal(value.inputs?.arbRelevance, true);
  assert.equal(value.inputs?.relevanceOversample, 2);
  assert.equal(
    value.inputs?.v4BackfillLookbackBlocks,
    5_000_000,
    "production-full universe did not cover the full V4 initialization lifetime",
  );
  assert.equal(
    value.inputs?.discoveryQueue?.profile,
    "frozen-discovery-queue-v1",
  );
  assert.equal(
    value.inputs?.discoveryQueue?.exists,
    input.expectedDiscoveryQueueExists,
  );
  assert.equal(
    value.inputs?.discoveryQueue?.contentSha256,
    input.expectedDiscoveryQueueSha256,
  );
  assert(
    Number.isSafeInteger(value.inputs?.discoveryQueue?.entries) &&
      Number(value.inputs?.discoveryQueue?.entries) >= 0,
    "production-full universe discovery queue count",
  );
  assert.equal(value.output?.contentSha256, input.universeSha256);
  assert.equal(value.output?.pools, input.universePools);
  assert.deepEqual(
    value.registry?.sourceFingerprints,
    productionUniverseRegistrySourceFingerprints(),
    "production-full universe was built from a different family registry",
  );
  const universe = JSON.parse(readFileSync(input.universePath, "utf8")) as {
    readonly registry?: {
      readonly sourceFingerprints?: unknown;
    };
  };
  assert.deepEqual(
    universe.registry?.sourceFingerprints,
    productionUniverseRegistrySourceFingerprints(),
    "production-full universe payload was built from a different family registry",
  );
  return createHash("sha256").update(raw).digest("hex");
}
