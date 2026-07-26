import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createProtocolDiscoveryEvidenceCache,
  loadProtocolDiscoveryEvidenceCache,
  protocolAddressCacheKey,
  pruneProtocolDiscoveryAddressCache,
  reconcileProtocolDiscoveryEvidenceCache,
  recordProtocolRouteOwnership,
  saveProtocolDiscoveryEvidenceCache,
  type ProtocolAddressCacheEntry,
} from "../protocol-discovery-cache.js";
import type {
  AttestedProtocolInstance,
  ProtocolCandidate,
} from "../venues/route-leg-adapter.js";

const ADAPTER_ID = "protocol:erc4626";
const ZERO_HASH = `0x${"00".repeat(32)}`;

oldNegativesAndInactivePositivesAreEvictedFirst();
activeOwnershipSurvivesCapacityAndRestart();
newAdmissionIsProtectedBeforeStartupPrune();

console.log("protocol-discovery-cache-pruning PASS (3/3)");

function oldNegativesAndInactivePositivesAreEvictedFirst(): void {
  const cache = createProtocolDiscoveryEvidenceCache(1);
  put(cache, 1, 10, null);
  put(cache, 2, 95, null);
  put(cache, 3, 20, candidate(3));
  put(cache, 4, 30, candidate(4));
  const result = pruneProtocolDiscoveryAddressCache(cache, {
    currentBlock: 100,
    maxEntries: 2,
    negativeTtlBlocks: 20,
    sweepIntervalBlocks: 1,
  });
  assert.equal(result.expiredNegatives, 1);
  assert.equal(result.capacityEvictions, 1);
  assert.equal(cache.addressEntries.has(key(1)), false);
  assert.equal(
    cache.addressEntries.has(key(2)),
    false,
    "a remaining semantic negative must be evicted before positives",
  );
  assert.equal(cache.addressEntries.has(key(3)), true);
  assert.equal(cache.addressEntries.has(key(4)), true);
}

function activeOwnershipSurvivesCapacityAndRestart(): void {
  const cache = createProtocolDiscoveryEvidenceCache(1);
  const active = [instance(11), instance(12), instance(13)];
  for (const [index, value] of active.entries()) {
    put(cache, 11 + index, index, candidate(11 + index));
  }
  put(cache, 21, 90, null);
  put(cache, 22, 91, candidate(22));
  recordProtocolRouteOwnership(cache, {
    version: 1,
    admissions: new Map(active.map((value) => [
      value.pool.address,
      { adapterId: ADAPTER_ID, instance: value },
    ])),
  });
  const result = pruneProtocolDiscoveryAddressCache(cache, {
    currentBlock: 100,
    maxEntries: 2,
    negativeTtlBlocks: 1_000,
    sweepIntervalBlocks: 1,
  });
  assert.equal(result.protectedOverflow, 1);
  assert.equal(result.after, 3);
  for (const value of active) {
    assert.equal(
      cache.addressEntries.has(
        protocolAddressCacheKey(ADAPTER_ID, value.pool.address),
      ),
      true,
      "an admitted instance must never be evicted by the optimization cap",
    );
  }
  assert.equal(cache.addressEntries.has(key(21)), false);
  assert.equal(cache.addressEntries.has(key(22)), false);

  const root = mkdtempSync(resolve(tmpdir(), "protocol-cache-prune-"));
  const path = resolve(root, "cache.json");
  try {
    saveProtocolDiscoveryEvidenceCache(path, cache);
    const loaded = loadProtocolDiscoveryEvidenceCache(path, 1);
    assert.equal(loaded.routeOwnership.admissions.length, active.length);
    for (const value of active) {
      assert.equal(
        loaded.addressEntries.has(
          protocolAddressCacheKey(ADAPTER_ID, value.pool.address),
        ),
        true,
        "save/load must retain the same active protected set",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function newAdmissionIsProtectedBeforeStartupPrune(): void {
  const cache = createProtocolDiscoveryEvidenceCache(1);
  const newlyAdmitted = instance(32);
  put(cache, 32, 1, candidate(32));
  put(cache, 31, 90, candidate(31));

  reconcileProtocolDiscoveryEvidenceCache(cache, {
    evaluatedInstanceKeys: new Set(),
    wouldAdmit: [{
      adapterId: ADAPTER_ID,
      instance: newlyAdmitted,
    }],
  });
  recordProtocolRouteOwnership(cache, {
    version: 1,
    admissions: new Map([[
      newlyAdmitted.pool.address,
      { adapterId: ADAPTER_ID, instance: newlyAdmitted },
    ]]),
  });
  pruneProtocolDiscoveryAddressCache(cache, {
    currentBlock: 100,
    maxEntries: 1,
    negativeTtlBlocks: 1_000,
    sweepIntervalBlocks: 1,
  });

  assert.equal(
    cache.addressEntries.has(key(32)),
    true,
    "startup prune must run after ownership records the new admission",
  );
  assert.equal(cache.addressEntries.has(key(31)), false);
}

function put(
  cache: ReturnType<typeof createProtocolDiscoveryEvidenceCache>,
  suffix: number,
  checkedAtBlock: number,
  value: ProtocolCandidate | null,
): void {
  const address = addressFor(suffix);
  const entry: ProtocolAddressCacheEntry = {
    adapterId: ADAPTER_ID,
    address,
    codeHash: ZERO_HASH,
    implementationWord: ZERO_HASH,
    matcherVersion: "fixture-v1",
    dependencyPolicyVersion: "fixture-dependency-v1",
    dependencyFingerprint: ZERO_HASH,
    checkedAtBlock,
    candidate: value,
  };
  cache.addressEntries.set(key(suffix), entry);
}

function key(suffix: number): string {
  return protocolAddressCacheKey(ADAPTER_ID, addressFor(suffix));
}

function candidate(suffix: number): ProtocolCandidate {
  return {
    pool: instance(suffix).pool,
    source: "cache-pruning-fixture",
    evidence: [],
  };
}

function instance(suffix: number): AttestedProtocolInstance {
  return {
    pool: {
      address: addressFor(suffix),
      adapter: "erc4626",
      fixedTokenIn: addressFor(101),
      fixedTokenOut: addressFor(102),
      fixedSlotKind: "protocol",
      fixedProtocolAction: "wrap",
      identitySource: "erc4626-standard",
    },
    sources: ["dex-token-domain"],
    selectors: [],
    evidence: [],
    ownerAdapterId: ADAPTER_ID,
  };
}

function addressFor(suffix: number): string {
  return `0x${suffix.toString(16).padStart(40, "0")}`;
}
