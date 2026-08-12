import assert from "node:assert/strict";
import {
  deriveLiveDiscoveryCheckpointInventory,
} from "../live-discovery-checkpoint-inventory.js";
import {
  createProtocolDiscoveryEvidenceCache,
} from "../protocol-discovery-cache.js";
import type { LiveDiscoveryPublicationState } from
  "../live-discovery-publication.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";
import { WSTETH_FAMILY_ID } from
  "../venues/protocols/wsteth-family/manifest.js";
import { ASTRA_MULTITOKEN_FAMILY_ID } from
  "../venues/protocols/astra-multitoken-family/manifest.js";
import { UNIV2_FAMILY_ID } from
  "../venues/swaps/univ2-family/manifest.js";

const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"51".repeat(32)}`,
  generation: 44,
});
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const ASTRA_POOL = `0x${"61".repeat(20)}`;

function fixturePublication(input: {
  readonly staleEventCoverage?: boolean;
} = {}): LiveDiscoveryPublicationState {
  const cache = createProtocolDiscoveryEvidenceCache(1n);
  cache.addressEntries.set(WSTETH.toLowerCase(), Object.freeze({
    adapterId: "wsteth-adapter",
    address: WSTETH.toLowerCase(),
    codeHash: `0x${"1".repeat(64)}`,
    implementationWord: `0x${"0".repeat(64)}`,
    matcherVersion: "fixture-v1",
    dependencyPolicyVersion: null,
    dependencyFingerprint: null,
    checkedAtBlock: SOURCE.number,
    candidate: Object.freeze({
      pool: Object.freeze({}) as never,
      source: "fixture",
    }),
  }));
  cache.addressEntries.set(ASTRA_POOL.toLowerCase(), Object.freeze({
    adapterId: "astra-adapter",
    address: ASTRA_POOL.toLowerCase(),
    codeHash: `0x${"2".repeat(64)}`,
    implementationWord: `0x${"0".repeat(64)}`,
    matcherVersion: "fixture-v1",
    dependencyPolicyVersion: null,
    dependencyFingerprint: null,
    checkedAtBlock: SOURCE.number,
    candidate: null,
  }));
  const coverageBlock = input.staleEventCoverage
    ? SOURCE.number - 1
    : SOURCE.number;
  return Object.freeze({
    protocolEvidenceCache: cache,
    protocolFamilySourceCoverage: new Map([
      [
        `protocol:wsteth\u001fobserved-call`,
        Object.freeze({
          completeThroughBlock: coverageBlock,
          completeThroughHash: SOURCE.hash,
        }),
      ],
    ]),
    dexSourceAnchor: Object.freeze({
      completeThroughBlock: coverageBlock,
      completeThroughHash: SOURCE.hash,
    }),
    protocolObservedCursor: Object.freeze({
      completeThroughBlock: coverageBlock,
      completeThroughHash: SOURCE.hash,
    }),
  }) as unknown as LiveDiscoveryPublicationState;
}

function main(): void {
  const derived = deriveLiveDiscoveryCheckpointInventory({
    publication: fixturePublication(),
    source: SOURCE,
    catalog,
    familyIdForAdapter: (adapterId) => {
      if (adapterId === "wsteth-adapter") return WSTETH_FAMILY_ID;
      if (adapterId === "astra-adapter") return ASTRA_MULTITOKEN_FAMILY_ID;
      return null;
    },
  });
  const wstethInventory = derived.inventoryFamilies.find(
    (family) => family.familyId === WSTETH_FAMILY_ID,
  )!;
  assert.equal(wstethInventory.incumbents.length, 1);
  const surface = wstethInventory.incumbents[0]!.currentSurface;
  assert.equal(surface.kind, "address-surface");
  assert.equal(surface.address, WSTETH.toLowerCase());
  assert.equal(surface.codeHash, `0x${"1".repeat(64)}`);
  assert.equal(
    wstethInventory.incumbents[0]!.inventoryKey,
    WSTETH.toLowerCase(),
  );
  const astraInventory = derived.inventoryFamilies.find(
    (family) => family.familyId === ASTRA_MULTITOKEN_FAMILY_ID,
  )!;
  assert.equal(
    astraInventory.incumbents.length,
    0,
    "activity families stay empty until call/log evidence is retained",
  );
  const wstethObserved = derived.watermarks.find((row) =>
    row.familyId === WSTETH_FAMILY_ID && row.sourceId === "observed-call"
  )!;
  assert.equal(wstethObserved.coverageAuthority, "contiguous-history");
  assert.equal(wstethObserved.completeThroughBlock, SOURCE.number);
  const wstethSurface = derived.watermarks.find((row) =>
    row.familyId === WSTETH_FAMILY_ID && row.sourceId === "address-surface"
  )!;
  assert.equal(wstethSurface.coverageAuthority, "append-only");
  const univ2Factory = derived.watermarks.find((row) =>
    row.familyId === UNIV2_FAMILY_ID && row.sourceId === "factory-log"
  )!;
  assert.equal(univ2Factory.coverageAuthority, "contiguous-history");

  const stale = deriveLiveDiscoveryCheckpointInventory({
    publication: fixturePublication({ staleEventCoverage: true }),
    source: SOURCE,
    catalog,
    familyIdForAdapter: () => null,
  });
  const staleObserved = stale.watermarks.find((row) =>
    row.familyId === WSTETH_FAMILY_ID && row.sourceId === "observed-call"
  )!;
  assert.equal(
    staleObserved.coverageAuthority,
    "append-only",
    "stale event coverage cannot mint contiguous-history authority",
  );
  console.log("adapter-family-live-discovery-inventory PASS");
}

main();
