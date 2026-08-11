import assert from "node:assert/strict";
import {
  assertIssuedAdapterFamilyExactQuoteCache,
  createAdapterFamilyExactQuoteCache,
  exactQuoteCacheKey,
  type AdapterExactQuoteCacheAddress,
  type AdapterExactQuoteCacheValue,
} from "../adapter-family-exact-quote-cache.js";
import {
  familyId,
  instanceKey,
  routeKey,
  type FamilyId,
  type InstanceKey,
  type RouteKey,
} from "../venues/adapter-family-identifiers.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";

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

async function main(): Promise<void> {
  testCacheKeyBindsEveryAddressField();
  testStoreLookupLruAndEviction();
  testStoreRejectsUnboundOrInvalidValues();
  testCacheIdentityIsCentrallyIssued();
  testCacheAndAddressBoundaries();
  console.log("adapter-family exact quote cache PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
