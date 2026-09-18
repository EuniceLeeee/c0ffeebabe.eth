import assert from "node:assert/strict";
import {
  assertIssuedAdapterFamilyExactQuoteCache,
  createAdapterFamilyExactQuoteCache,
  exactQuoteCacheKey,
  type AdapterExactQuoteCacheAddress,
  type AdapterExactQuoteCacheValue,
  type AdapterExactStateCacheAddress,
  type AdapterFamilyExactQuoteCache,
} from "../adapter-family-exact-quote-cache.js";
import {
  familyId,
  instanceKey,
  routeKey,
  type FamilyId,
  type InstanceKey,
  type RouteKey,
} from "../venues/adapter-family-identifiers.js";
import type {
  AdapterRequestResult,
  CanonicalSource,
} from "../venues/adapter-request-program.js";

const FAMILY = familyId("swap:exact-quote-cache-test");
const INSTANCE = instanceKey("pool:alpha");
const ROUTE = routeKey("route:alpha");
const EXECUTOR = `0x${"41".repeat(20)}`;
const CAPABILITY = "ab".repeat(32);
const COMPATIBILITY = "cd".repeat(32);
const ROUTE_BINDING = "ef".repeat(32);
const INSTANCE_FINGERPRINT = "01".repeat(32);
const METHOD_ORDER = "23".repeat(32);
const REQUEST = "45".repeat(32);
const RUNTIME_IDENTITY = Object.freeze({});
const OTHER_RUNTIME_IDENTITY = Object.freeze({});
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"51".repeat(32)}`,
  generation: 44,
});
const EMPTY_STATE_SNAPSHOT = {
  stateSize: 0,
  stateHits: 0,
  stateMisses: 0,
  stateStores: 0,
  stateEvictions: 0,
};
const STATE_KEY = "state:alpha";
type AdvanceActivity = NonNullable<
  Parameters<AdapterFamilyExactQuoteCache["advanceState"]>[1]
>;

function sourceAt(offset: number): CanonicalSource {
  return Object.freeze({
    number: SOURCE.number + offset,
    hash: offset === 0 ? SOURCE.hash : `0x${(0x60 + offset).toString(16).repeat(32)}`,
    generation: SOURCE.generation + offset,
  });
}

function stateAddress(
  overrides: Partial<AdapterExactStateCacheAddress> = {},
): AdapterExactStateCacheAddress {
  return { ...address(), stateKey: STATE_KEY, ...overrides };
}

function stateValue(
  source: CanonicalSource = SOURCE,
  data = "0x6000",
): AdapterExactQuoteCacheValue {
  return value({
    trustedResults: [{
      id: "state-read",
      ok: true,
      source,
      provenance: { kind: "ethcall-test", fingerprint: "original-provider-read" },
      completion: "returned",
      data,
    }],
  });
}

function activity(
  source: CanonicalSource,
  touchedStateKeys: readonly string[] = [],
  parentHash = SOURCE.hash,
) {
  return {
    source,
    touchedStateKeys: new Set(touchedStateKeys),
    complete: true as const,
    parentHash,
  };
}

interface AddressOverrides {
  readonly familyRuntimeIdentity?: object;
  readonly familyId?: FamilyId;
  readonly instanceKey?: InstanceKey;
  readonly routeKey?: RouteKey;
  readonly instanceFingerprint?: string;
  readonly routeBindingFingerprint?: string;
  readonly capabilityHash?: string;
  readonly compatibilityFingerprint?: string;
  readonly methodId?: string;
  readonly methodIndex?: number;
  readonly methodOrderFingerprint?: string;
  readonly requestFingerprint?: string;
  readonly amountIn?: bigint;
  readonly executor?: string;
  readonly source?: CanonicalSource;
}

function address(overrides: AddressOverrides = {}): AdapterExactQuoteCacheAddress {
  return {
    familyRuntimeIdentity:
      overrides.familyRuntimeIdentity ?? RUNTIME_IDENTITY,
    familyId: overrides.familyId ?? FAMILY,
    instanceKey: overrides.instanceKey ?? INSTANCE,
    routeKey: overrides.routeKey ?? ROUTE,
    instanceFingerprint: overrides.instanceFingerprint ?? INSTANCE_FINGERPRINT,
    routeBindingFingerprint:
      overrides.routeBindingFingerprint ?? ROUTE_BINDING,
    capabilityHash: overrides.capabilityHash ?? CAPABILITY,
    compatibilityFingerprint:
      overrides.compatibilityFingerprint ?? COMPATIBILITY,
    methodId: overrides.methodId ?? "quoteExact",
    methodIndex: overrides.methodIndex ?? 0,
    methodOrderFingerprint: overrides.methodOrderFingerprint ?? METHOD_ORDER,
    requestFingerprint: overrides.requestFingerprint ?? REQUEST,
    amountIn: overrides.amountIn ?? 1_000_000n,
    executor: overrides.executor ?? EXECUTOR,
    source: overrides.source ?? SOURCE,
  };
}

function value(
  overrides: Partial<AdapterExactQuoteCacheValue> = {},
): AdapterExactQuoteCacheValue {
  return {
    trustedResults: overrides.trustedResults ?? [Object.freeze({
      id: "quote",
      ok: true as const,
      source: SOURCE,
      provenance: Object.freeze({
        kind: "exact-cache-test",
        fingerprint: "result:quote",
      }),
      completion: "returned" as const,
      data: "0x6000",
    })],
    roundFingerprints: overrides.roundFingerprints ?? ["67".repeat(32)],
    evidenceRefs: overrides.evidenceRefs ?? ["evidence:quote"],
  };
}

function assertKeyChanges(
  keyWithOverride: (overrides: AddressOverrides) => string,
  override: AddressOverrides,
): void {
  assert.notEqual(
    keyWithOverride(override),
    keyWithOverride({}),
    "cache key must bind the changed address field",
  );
}

function testCacheKeyBindsEveryAddressField(): void {
  const keyWith = (overrides: AddressOverrides) =>
    exactQuoteCacheKey(address(overrides));
  const baseKey = keyWith({});
  assert.match(baseKey, /^adapter-exact-quote:/);

  assertKeyChanges(keyWith, { familyRuntimeIdentity: OTHER_RUNTIME_IDENTITY });
  assertKeyChanges(keyWith, { familyId: familyId("swap:other") });
  assertKeyChanges(keyWith, { instanceKey: instanceKey("pool:beta") });
  assertKeyChanges(keyWith, { routeKey: routeKey("route:beta") });
  assertKeyChanges(keyWith, { instanceFingerprint: "ab".repeat(32) });
  assertKeyChanges(keyWith, { routeBindingFingerprint: "ab".repeat(32) });
  assertKeyChanges(keyWith, { capabilityHash: "ef".repeat(32) });
  assertKeyChanges(keyWith, { compatibilityFingerprint: "ab".repeat(32) });
  assertKeyChanges(keyWith, { methodId: "otherMethod" });
  assertKeyChanges(keyWith, { methodIndex: 1 });
  assertKeyChanges(keyWith, { methodOrderFingerprint: "ab".repeat(32) });
  assertKeyChanges(keyWith, { requestFingerprint: "ab".repeat(32) });
  assertKeyChanges(keyWith, { amountIn: 2_000_000n });
  assertKeyChanges(keyWith, { executor: `0x${"42".repeat(20)}` });
  assertKeyChanges(keyWith, {
    source: Object.freeze({
      number: SOURCE.number + 1,
      hash: `0x${"52".repeat(32)}`,
      generation: SOURCE.generation + 1,
    }),
  });

  const sameHashNextGeneration = exactQuoteCacheKey(address({
    source: Object.freeze({
      number: SOURCE.number,
      hash: SOURCE.hash,
      generation: SOURCE.generation + 1,
    }),
  }));
  assert.equal(
    sameHashNextGeneration,
    baseKey,
    "generation is deliberately absent from the exact cache key",
  );
}

function testStoreLookupLruAndEviction(): void {
  const cache = createAdapterFamilyExactQuoteCache({ capacity: 2 });
  const keyA = cache.store(address(), value());
  const keyB = cache.store(address({ amountIn: 2_000_000n }), value());
  assert.equal(keyA, exactQuoteCacheKey(address()));
  assert.deepEqual(cache.snapshot(), {
    ...EMPTY_STATE_SNAPSHOT,
    size: 2,
    capacity: 2,
    hits: 0,
    misses: 0,
    stores: 2,
    evictions: 0,
  });

  const hitA = cache.lookup(address());
  assert(hitA);
  assert.equal(hitA.cacheKey, keyA);
  assert.deepEqual(hitA.roundFingerprints, ["67".repeat(32)]);
  assert(Object.isFrozen(hitA));
  assert(Object.isFrozen(hitA.evidenceRefs));

  cache.store(address({ amountIn: 3_000_000n }), value());
  assert.equal(cache.lookup(address({ amountIn: 2_000_000n })), undefined);
  assert(cache.lookup(address()));
  assert.deepEqual(cache.snapshot(), {
    ...EMPTY_STATE_SNAPSHOT,
    size: 2,
    capacity: 2,
    hits: 2,
    misses: 1,
    stores: 3,
    evictions: 1,
  });
  assert(Object.isFrozen(cache.snapshot()));
}

function testStoreRejectsUnboundOrInvalidValues(): void {
  const cache = createAdapterFamilyExactQuoteCache();
  const wrongSource = Object.freeze({
    ...SOURCE,
    hash: `0x${"52".repeat(32)}`,
  });
  assert.throws(() => cache.store(address(), value({
    trustedResults: [],
  })), /successful source-bound results/);
  assert.throws(() => cache.store(address(), value({
    trustedResults: [Object.freeze({
      id: "quote",
      ok: false as const,
      source: SOURCE,
      failure: "rpc" as const,
      provenance: Object.freeze({
        kind: "exact-cache-test",
        fingerprint: "result:quote",
      }),
      completion: "reverted" as const,
      data: "0x",
    })],
  })), /successful source-bound results/);
  assert.throws(() => cache.store(address(), value({
    trustedResults: [Object.freeze({
      id: "quote",
      ok: true as const,
      source: wrongSource,
      provenance: Object.freeze({
        kind: "exact-cache-test",
        fingerprint: "result:quote",
      }),
      completion: "returned" as const,
      data: "0x6000",
    })],
  })), /successful source-bound results/);
  assert.throws(() => cache.store(address(), value({
    roundFingerprints: [],
  })), /non-empty SHA-256/);
  assert.throws(() => cache.store(address(), value({
    roundFingerprints: ["not-a-sha"],
  })), /non-empty SHA-256/);
  assert.throws(() => cache.store(address(), value({
    evidenceRefs: "not-an-array",
  } as unknown as AdapterExactQuoteCacheValue)), /evidenceRefs must be an array/);
  assert.deepEqual(cache.snapshot(), {
    ...EMPTY_STATE_SNAPSHOT,
    size: 0,
    capacity: 8192,
    hits: 0,
    misses: 0,
    stores: 0,
    evictions: 0,
  });
}

function testCacheIdentityIsCentrallyIssued(): void {
  const cache = createAdapterFamilyExactQuoteCache();
  assertIssuedAdapterFamilyExactQuoteCache(cache);
  assert.throws(
    () => assertIssuedAdapterFamilyExactQuoteCache(Object.freeze({})),
    /centrally issued/,
  );
  assert.throws(
    () => exactQuoteCacheKey({
      ...address(),
      familyRuntimeIdentity: null,
    } as unknown as AdapterExactQuoteCacheAddress),
    /familyRuntimeIdentity must be an object/,
  );
}

function testCacheAndAddressBoundaries(): void {
  assert.throws(
    () => createAdapterFamilyExactQuoteCache({ capacity: 0 }),
    /capacity must be positive/,
  );
  assert.throws(
    () => createAdapterFamilyExactQuoteCache({ capacity: -1 }),
    /capacity must be positive/,
  );
  assert.throws(
    () => createAdapterFamilyExactQuoteCache({ capacity: 1.5 }),
    /capacity must be positive/,
  );
  assert.throws(
    () => exactQuoteCacheKey({
      ...address(),
      familyId: "",
    } as unknown as AdapterExactQuoteCacheAddress),
    /familyId must be canonical/,
  );
  assert.throws(
    () => exactQuoteCacheKey({
      ...address(),
      capabilityHash: "not-sha",
    } as unknown as AdapterExactQuoteCacheAddress),
    /capabilityHash must be SHA-256/,
  );
  assert.throws(
    () => exactQuoteCacheKey({
      ...address(),
      executor: "0x1234",
    } as unknown as AdapterExactQuoteCacheAddress),
    /executor must be an address/,
  );
}

function testStoreOverwriteAndExplicitEviction(): void {
  const overwrite = createAdapterFamilyExactQuoteCache({ capacity: 1 });
  overwrite.store(address(), value());
  const replacedKey = overwrite.store(
    address(),
    value({ roundFingerprints: ["89".repeat(32)] }),
  );
  assert.deepEqual(overwrite.snapshot(), {
    ...EMPTY_STATE_SNAPSHOT,
    size: 1,
    capacity: 1,
    hits: 0,
    misses: 0,
    stores: 2,
    evictions: 0,
  });
  const replaced = overwrite.lookup(address());
  assert(replaced);
  assert.equal(replaced.cacheKey, replacedKey);
  assert.deepEqual(replaced.roundFingerprints, ["89".repeat(32)]);

  const single = createAdapterFamilyExactQuoteCache({ capacity: 1 });
  single.store(address(), value());
  assert.equal(single.lookup(address({ amountIn: 2_000_000n })), undefined);
  assert.deepEqual(single.snapshot(), {
    ...EMPTY_STATE_SNAPSHOT,
    size: 1,
    capacity: 1,
    hits: 0,
    misses: 1,
    stores: 1,
    evictions: 0,
  });
}

function testZeroAmountKeyAndEvidenceRefNormalization(): void {
  const zeroKey = exactQuoteCacheKey(address({ amountIn: 0n }));
  assert.equal(
    exactQuoteCacheKey(address({ amountIn: 0n })),
    zeroKey,
    "zero amount must produce a stable key",
  );
  const cache = createAdapterFamilyExactQuoteCache({ capacity: 1 });
  cache.store(address(), value({
    evidenceRefs: ["z", "a", "b", "a"],
  }));
  const hit = cache.lookup(address());
  assert(hit);
  assert.deepEqual(hit.evidenceRefs, ["a", "b", "z"]);
  assert(Object.isFrozen(hit.trustedResults));
  assert(Object.isFrozen(hit.roundFingerprints));
  assert(Object.isFrozen(hit.evidenceRefs));
  assert.equal(createAdapterFamilyExactQuoteCache().snapshot().capacity, 8192);
}

function testStateReuseAcrossThreeBlocksAndAmounts(): void {
  const cache = createAdapterFamilyExactQuoteCache();
  const origin = stateValue();
  const originSnapshot = structuredClone(origin);
  const rounds = [REQUEST, "89".repeat(32)];
  cache.advanceState(SOURCE);
  const keys = rounds.map((requestFingerprint, index) => cache.storeState(
    stateAddress({ requestFingerprint }),
    { ...origin, roundFingerprints: [requestFingerprint], evidenceRefs: [`round:${index}`] },
  ));
  assert(keys.every((key) => key !== undefined));
  assert.notEqual(keys[0], keys[1], "each actual dependent round has a distinct key");
  for (let offset = 0; offset < 3; offset++) {
    const source = sourceAt(offset);
    if (offset > 0) cache.advanceState(source, activity(source, [], sourceAt(offset - 1).hash));
    for (const [index, requestFingerprint] of rounds.entries()) {
      const hit = cache.lookupState(stateAddress({
        source, requestFingerprint, amountIn: BigInt(offset + 2) * 1_000_000n,
      }));
      assert(hit);
      assert.equal(hit.cacheKey, keys[index]);
      assert.deepEqual(hit.roundFingerprints, [requestFingerprint]);
      assert.deepEqual(hit.evidenceRefs, [`round:${index}`]);
      const result = hit.trustedResults[0];
      assert(result.ok);
      assert.deepEqual(result.source, source);
      assert.equal(result.data, "0x6000");
      assert.equal(result.provenance.kind, "retained-local-state");
      assert.match(result.provenance.fingerprint, /^[a-f0-9]{64}$/);
      assert(Object.isFrozen(hit));
      assert(Object.isFrozen(hit.trustedResults));
      assert(Object.isFrozen(result));
      assert(Object.isFrozen(result.source));
      assert(Object.isFrozen(result.provenance));
    }
  }
  assert.deepEqual(origin, originSnapshot, "reuse never retags original receipts");
  assert.equal(cache.lookupState(stateAddress()), undefined, "old-source lookup is rejected");
  assert.equal(cache.snapshot().stateSize, 2);
  assert.equal(cache.snapshot().stateHits, 6);
  assert.equal(cache.snapshot().stateMisses, 1);
  assert.equal(cache.snapshot().stateStores, 2);
}

function testStateIdentityBindsEveryOtherAddressField(): void {
  const cache = createAdapterFamilyExactQuoteCache();
  cache.advanceState(SOURCE);
  const key = cache.storeState(stateAddress(), stateValue());
  assert(key);
  const changes: Partial<AdapterExactStateCacheAddress>[] = [
    { familyRuntimeIdentity: OTHER_RUNTIME_IDENTITY },
    { familyId: familyId("swap:other") },
    { instanceKey: instanceKey("pool:beta") },
    { routeKey: routeKey("route:beta") },
    { instanceFingerprint: "ab".repeat(32) },
    { routeBindingFingerprint: "ab".repeat(32) },
    { capabilityHash: "ef".repeat(32) },
    { compatibilityFingerprint: "ab".repeat(32) },
    { methodId: "otherMethod" },
    { methodIndex: 1 },
    { methodOrderFingerprint: "ab".repeat(32) },
    { requestFingerprint: "ab".repeat(32) },
    { executor: `0x${"42".repeat(20)}` },
    { stateKey: "state:beta" },
  ];
  for (const change of changes) {
    const changed = stateAddress(change);
    assert.equal(cache.lookupState(changed), undefined, `must bind ${Object.keys(change)[0]}`);
    assert.notEqual(cache.storeState(changed, stateValue()), key);
  }
  assert.equal(cache.lookupState(stateAddress({ amountIn: 0n }))?.cacheKey, key);
  assert.equal(cache.lookupState(stateAddress({
    capabilityHash: CAPABILITY.toUpperCase(),
    compatibilityFingerprint: COMPATIBILITY.toUpperCase(),
    routeBindingFingerprint: ROUTE_BINDING.toUpperCase(),
  }))?.cacheKey, key);
}

function testTouchedInvalidationAndSameSourceRetries(): void {
  const cache = createAdapterFamilyExactQuoteCache();
  const otherRound = stateAddress({ requestFingerprint: "89".repeat(32) });
  const otherState = stateAddress({ stateKey: "state:beta" });
  cache.advanceState(SOURCE);
  for (const target of [stateAddress(), otherRound, otherState]) {
    assert(cache.storeState(target, stateValue()));
  }
  const next = sourceAt(1);
  const touched = [STATE_KEY, "state:unseen"];
  cache.advanceState(next, activity(next, touched));
  assert.equal(cache.lookupState(stateAddress({ source: next })), undefined);
  assert.equal(cache.lookupState({ ...otherRound, source: next }), undefined);
  assert(cache.lookupState({ ...otherState, source: next }));
  assert.equal(cache.snapshot().stateSize, 1);
  assert(cache.storeState(stateAddress({ source: next }), stateValue(next, "0x6001")));
  const retry = { ...next, generation: next.generation + 1 };
  cache.advanceState(retry, activity(retry, [...touched].reverse()));
  cache.advanceState(retry, activity(next, touched));
  const refreshed = cache.lookupState(stateAddress({ source: retry }));
  assert(refreshed, "identical proof retries preserve refreshed touched entries");
  const result = refreshed.trustedResults[0];
  assert(result.ok);
  assert.equal(result.data, "0x6001");
  assert.deepEqual(result.source, retry);
  assert.equal(cache.snapshot().stateEvictions, 0, "invalidation is not capacity eviction");

  cache.advanceState(retry, activity(retry, [...touched, "state:beta"]));
  assert.equal(cache.snapshot().stateSize, 0, "conflicting same-block proof fails closed");
  assert(cache.storeState(stateAddress({ source: retry }), stateValue(retry)));
  cache.advanceState(retry);
  assert.equal(cache.snapshot().stateSize, 0, "removing an existing proof fails closed");
  assert(cache.storeState(stateAddress({ source: retry }), stateValue(retry)));
  cache.advanceState({ ...retry, generation: retry.generation + 1 });
  assert.equal(cache.snapshot().stateSize, 1, "same-block retries without a proof preserve fresh reads");
  cache.advanceState(retry, activity(retry));
  assert.equal(cache.snapshot().stateSize, 0, "new same-block proof cannot revive old reads");

  const conflicts: readonly AdvanceActivity[] = [
    activity(retry, [], retry.hash),
    activity({ ...retry, hash: SOURCE.hash }),
    activity({ ...retry, number: SOURCE.number }),
    { ...activity(retry), complete: false } as unknown as AdvanceActivity,
  ];
  for (const conflict of conflicts) {
    cache.advanceState(retry, activity(retry));
    assert(cache.storeState(stateAddress({ source: retry }), stateValue(retry)));
    cache.advanceState(retry, conflict);
    assert.equal(cache.snapshot().stateSize, 0, "all changed proof fields fail closed");
  }
}

function testStateContinuityFailuresClear(): void {
  const next = sourceAt(1);
  const reorg = { ...SOURCE, hash: `0x${"bb".repeat(32)}` };
  const cases: readonly [string, CanonicalSource, AdvanceActivity | undefined][] = [
    ["gap", sourceAt(2), activity(sourceAt(2))],
    ["same-height reorg", reorg, activity(reorg)],
    ["rewind", { ...SOURCE, number: SOURCE.number - 1 }, undefined],
    ["missing proof", next, undefined],
    ["wrong parent", next, activity(next, [], next.hash)],
    ["missing parent", next, { ...activity(next), parentHash: undefined }],
    ["incomplete proof", next, { ...activity(next), complete: false } as unknown as AdvanceActivity],
    ["wrong proof hash", next, activity({ ...next, hash: SOURCE.hash })],
    ["wrong proof number", next, activity({ ...next, number: SOURCE.number })],
  ];
  for (const [label, source, proof] of cases) {
    const cache = createAdapterFamilyExactQuoteCache();
    cache.advanceState(SOURCE);
    assert(cache.storeState(stateAddress(), stateValue()));
    cache.advanceState(source, proof);
    assert.equal(cache.snapshot().stateSize, 0, label);
    assert.equal(cache.lookupState(stateAddress({ source })), undefined, label);
    assert(cache.storeState(stateAddress({ source }), stateValue(source)), `${label}: establishes new source`);
    assert(cache.lookupState(stateAddress({ source })), label);
  }
}

async function testLateStoresAndReset(): Promise<void> {
  const cache = createAdapterFamilyExactQuoteCache();
  const initial = stateAddress();
  assert.equal(cache.storeState(initial, stateValue()), undefined, "must first establish a source");
  assert.equal(cache.lookupState(initial), undefined);
  cache.advanceState(SOURCE);
  const exactKey = cache.store(address(), value());
  assert(cache.storeState(initial, stateValue()));
  // Work already awaiting I/O must see the advance before its continuation runs.
  const lateStore = Promise.resolve().then(() => cache.storeState(initial, stateValue()));
  const next = sourceAt(1);
  cache.advanceState(next, activity(next));
  assert.equal(await lateStore, undefined);
  assert.equal(cache.snapshot().stateStores, 1);
  assert.equal(cache.storeState(stateAddress({ source: { ...next, hash: SOURCE.hash } }), stateValue()), undefined);
  assert.equal(cache.storeState(stateAddress({ source: { ...next, number: SOURCE.number } }), stateValue()), undefined);
  assert.equal(cache.lookupState(initial), undefined);
  cache.resetState();
  assert.equal(cache.snapshot().stateSize, 0);
  assert.equal(cache.storeState(stateAddress({ source: next }), stateValue(next)), undefined);
  assert.equal(cache.lookupState(stateAddress({ source: next })), undefined);
  assert.equal(cache.lookup(address())?.cacheKey, exactKey, "state lifecycle does not clear exact quotes");
  cache.advanceState(next, activity(next));
  assert.equal(cache.lookupState(stateAddress({ source: next })), undefined);
  assert(cache.storeState(stateAddress({ source: next }), stateValue(next)));
  const retry = { ...next, generation: next.generation + 1 };
  cache.advanceState(retry, activity(retry));
  assert.equal(cache.storeState(stateAddress({ source: next }), stateValue(next)), undefined);
  assert(cache.lookupState(stateAddress({ source: retry })));
}

function testStateRejectsInvalidResults(): void {
  const cache = createAdapterFamilyExactQuoteCache();
  cache.advanceState(SOURCE);
  const original = stateValue().trustedResults[0];
  assert(original.ok);
  const invalidResults: readonly (readonly AdapterRequestResult[])[] = [
    [],
    [{ id: original.id, ok: false, source: SOURCE, failure: "rpc" }],
    [{ ...original, completion: "reverted-as-declared" }],
    [{ ...original, effects: {} }],
    [{ ...original, source: { ...SOURCE, number: SOURCE.number + 1 } }],
    [{ ...original, source: { ...SOURCE, hash: sourceAt(1).hash } }],
    [{ ...original, source: { ...SOURCE, generation: SOURCE.generation + 1 } }],
    [original, { ...original, effects: { logs: [] } }],
  ];
  assert(cache.storeState(stateAddress(), stateValue()));
  for (const trustedResults of invalidResults) {
    assert.equal(cache.storeState(stateAddress(), value({ trustedResults })), undefined);
    assert.equal(cache.snapshot().stateStores, 1);
  }
  for (const roundFingerprints of [[], ["invalid"]]) {
    assert.equal(cache.storeState(stateAddress(), value({ roundFingerprints })), undefined);
  }
  assert.equal(cache.storeState(stateAddress(), {
    ...stateValue(), evidenceRefs: null,
  } as unknown as AdapterExactQuoteCacheValue), undefined);
  assert(cache.lookupState(stateAddress()), "rejected stores do not overwrite valid state");
}

function testStateCapacityLruAndIndexCleanup(): void {
  const cache = createAdapterFamilyExactQuoteCache({ capacity: 1, stateCapacity: 2 });
  cache.advanceState(SOURCE);
  const a = stateAddress();
  const b = stateAddress({ stateKey: "state:beta" });
  const c = stateAddress({ stateKey: "state:gamma" });
  cache.store(address(), value());
  cache.storeState(a, stateValue());
  cache.storeState(b, stateValue());
  assert(cache.lookupState(a));
  cache.storeState(c, stateValue());
  assert.equal(cache.lookupState(b), undefined);
  cache.storeState(a, { ...stateValue(SOURCE, "0x6001"), evidenceRefs: ["z", "a", "z"] });
  assert.deepEqual(cache.lookupState(a)?.evidenceRefs, ["a", "z"]);
  assert.deepEqual(cache.snapshot(), {
    size: 1, capacity: 1, hits: 0, misses: 0, stores: 1, evictions: 0,
    stateSize: 2, stateHits: 2, stateMisses: 1, stateStores: 4, stateEvictions: 1,
  });
  const next = sourceAt(1);
  cache.advanceState(next, activity(next, [b.stateKey]));
  assert.equal(cache.snapshot().stateSize, 2, "evicted index entries cannot invalidate live entries");
  const third = sourceAt(2);
  cache.advanceState(third, activity(third, [a.stateKey], next.hash));
  assert.equal(cache.lookupState({ ...a, source: third }), undefined);
  assert(cache.lookupState({ ...c, source: third }));
  assert(cache.storeState({ ...a, source: third }, stateValue(third)));
  cache.advanceState(sourceAt(3), activity(sourceAt(3), [a.stateKey], third.hash));
  assert.equal(cache.snapshot().stateSize, 1, "restored entries are indexed again");
}

function testDefaultStateCapacityAndBoundaries(): void {
  for (const stateCapacity of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => createAdapterFamilyExactQuoteCache({ stateCapacity }), /capacity must be positive/);
  }
  const cache = createAdapterFamilyExactQuoteCache();
  cache.advanceState(SOURCE);
  assert.throws(() => cache.lookupState(stateAddress({ stateKey: "" })), /stateKey must be canonical/);
  assert.throws(() => cache.storeState(stateAddress({ stateKey: " state " }), stateValue()), /stateKey must be canonical/);
  assert.throws(() => cache.advanceState({ ...SOURCE, number: -1 }), /source must be canonical/);
  const input = stateValue();
  for (let index = 0; index <= 32_768; index++) {
    assert(cache.storeState(stateAddress({ requestFingerprint: index.toString(16).padStart(64, "0") }), input));
  }
  assert.equal(cache.snapshot().stateSize, 32_768);
  assert.equal(cache.snapshot().stateEvictions, 1);
  assert.equal(cache.lookupState(stateAddress({ requestFingerprint: "0".repeat(64) })), undefined);
  cache.advanceState(sourceAt(1), activity(sourceAt(1), [STATE_KEY]));
  assert.equal(cache.snapshot().stateSize, 0, "all rounds for a touched state are invalidated");
}

function testStateProvenanceBindsOriginalReceiptAndNewSource(): void {
  const base = stateValue().trustedResults[0];
  assert(base.ok);
  const retained = (original: typeof base, intermediateLookup = false, target = sourceAt(2)) => {
    const cache = createAdapterFamilyExactQuoteCache();
    cache.advanceState(original.source);
    cache.storeState(stateAddress({ source: original.source }), value({ trustedResults: [original] }));
    cache.advanceState(sourceAt(1), activity(sourceAt(1), [], original.source.hash));
    if (intermediateLookup) assert(cache.lookupState(stateAddress({ source: sourceAt(1) })));
    cache.advanceState(target, activity(target, [], sourceAt(1).hash));
    const result = cache.lookupState(stateAddress({ source: target }))?.trustedResults[0];
    assert(result?.ok);
    return result.provenance.fingerprint;
  };
  const fingerprint = retained(base);
  assert.equal(retained(base, true), fingerprint, "intermediate lookups never replace original provenance");
  for (const original of [
    { ...base, id: "other-read" },
    { ...base, data: "0x6001" },
    { ...base, source: { ...SOURCE, hash: `0x${"bb".repeat(32)}` } },
    { ...base, source: { ...SOURCE, generation: SOURCE.generation + 1 } },
    { ...base, provenance: { ...base.provenance, kind: "other-transport" } },
    { ...base, provenance: { ...base.provenance, fingerprint: "other-receipt" } },
  ]) assert.notEqual(retained(original), fingerprint);
  assert.notEqual(retained(base, false, { ...sourceAt(2), hash: `0x${"bb".repeat(32)}` }), fingerprint);
  assert.notEqual(retained(base, false, { ...sourceAt(2), generation: SOURCE.generation + 10 }), fingerprint);

  const cache = createAdapterFamilyExactQuoteCache();
  const mutable = structuredClone(base);
  const mutableSource = { ...SOURCE };
  cache.advanceState(mutableSource);
  cache.storeState(stateAddress(), value({ trustedResults: [mutable] }));
  Object.assign(mutable, { data: "0xdead" });
  Object.assign(mutable.source, { hash: sourceAt(1).hash });
  Object.assign(mutable.provenance, { fingerprint: "mutated" });
  Object.assign(mutableSource, sourceAt(1));
  const result = cache.lookupState(stateAddress())?.trustedResults[0];
  assert(result?.ok);
  assert.equal(result.data, base.data, "caller mutation cannot rewrite stored receipts or current source");
  cache.advanceState(sourceAt(1), activity(sourceAt(1)));
  cache.advanceState(sourceAt(2), activity(sourceAt(2), [], sourceAt(1).hash));
  const later = cache.lookupState(stateAddress({ source: sourceAt(2) }))?.trustedResults[0];
  assert(later?.ok);
  assert.equal(later.provenance.fingerprint, fingerprint);
}

async function main(): Promise<void> {
  testCacheKeyBindsEveryAddressField();
  testStoreLookupLruAndEviction();
  testStoreRejectsUnboundOrInvalidValues();
  testCacheIdentityIsCentrallyIssued();
  testCacheAndAddressBoundaries();
  testStoreOverwriteAndExplicitEviction();
  testZeroAmountKeyAndEvidenceRefNormalization();
  testStateReuseAcrossThreeBlocksAndAmounts();
  testStateIdentityBindsEveryOtherAddressField();
  testTouchedInvalidationAndSameSourceRetries();
  testStateContinuityFailuresClear();
  await testLateStoresAndReset();
  testStateRejectsInvalidResults();
  testStateCapacityLruAndIndexCleanup();
  testDefaultStateCapacityAndBoundaries();
  testStateProvenanceBindsOriginalReceiptAndNewSource();
  console.log("adapter-family exact quote cache PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
