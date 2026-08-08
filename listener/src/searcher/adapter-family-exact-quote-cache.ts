import type {
  FamilyId,
  InstanceKey,
  RouteKey,
} from "./venues/adapter-family-identifiers.js";
import type {
  AdapterRequestResult,
  CanonicalSource,
} from "./venues/adapter-request-program.js";
import { hashCanonical } from "./venues/canonical-value.js";

export interface AdapterExactQuoteCacheAddress {
  /**
   * Process-local existential Family box identity. Capability hashes describe
   * code, but they do not authorize an opaque evidence value created by an
   * older runtime closure to cross a hot reload boundary.
   */
  readonly familyRuntimeIdentity: object;
  readonly familyId: FamilyId;
  readonly instanceKey: InstanceKey;
  readonly routeKey: RouteKey;
  readonly instanceFingerprint: string;
  readonly routeBindingFingerprint: string;
  readonly capabilityHash: string;
  readonly compatibilityFingerprint: string;
  readonly methodId: string;
  readonly methodIndex: number;
  readonly methodOrderFingerprint: string;
  readonly requestFingerprint: string;
  readonly amountIn: bigint;
  readonly executor: string;
  readonly source: CanonicalSource;
}

export interface AdapterExactQuoteCacheValue {
  readonly trustedResults: readonly AdapterRequestResult[];
  /** Initial program followed by each completed dependent program. */
  readonly roundFingerprints: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface AdapterExactQuoteCacheHit
  extends AdapterExactQuoteCacheValue {
  readonly cacheKey: string;
}

export interface AdapterExactQuoteCacheSnapshot {
  readonly size: number;
  readonly capacity: number;
  readonly hits: number;
  readonly misses: number;
  readonly stores: number;
  readonly evictions: number;
}

const exactQuoteCacheBrand: unique symbol = Symbol(
  "adapter-family-exact-quote-cache",
);
const issuedExactQuoteCaches = new WeakSet<object>();

export interface AdapterFamilyExactQuoteCache {
  readonly [exactQuoteCacheBrand]: true;
  lookup(
    address: AdapterExactQuoteCacheAddress,
  ): AdapterExactQuoteCacheHit | undefined;
  store(
    address: AdapterExactQuoteCacheAddress,
    value: AdapterExactQuoteCacheValue,
  ): string;
  snapshot(): AdapterExactQuoteCacheSnapshot;
}

interface CacheEntry {
  readonly value: AdapterExactQuoteCacheValue;
}

const DEFAULT_CAPACITY = 8_192;
const runtimeIdentityTokens = new WeakMap<object, string>();
let nextRuntimeIdentityToken = 1;

export function createAdapterFamilyExactQuoteCache(options: {
  readonly capacity?: number;
} = {}): AdapterFamilyExactQuoteCache {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new Error("Adapter exact quote cache capacity must be positive");
  }
  const entries = new Map<string, CacheEntry>();
  let hits = 0;
  let misses = 0;
  let stores = 0;
  let evictions = 0;

  const cache: AdapterFamilyExactQuoteCache = Object.freeze({
    [exactQuoteCacheBrand]: true as const,
    lookup(
      address: AdapterExactQuoteCacheAddress,
    ): AdapterExactQuoteCacheHit | undefined {
      const cacheKey = exactQuoteCacheKey(address);
      const entry = entries.get(cacheKey);
      if (entry === undefined) {
        misses++;
        return undefined;
      }
      entries.delete(cacheKey);
      entries.set(cacheKey, entry);
      hits++;
      return Object.freeze({
        cacheKey,
        trustedResults: entry.value.trustedResults,
        roundFingerprints: entry.value.roundFingerprints,
        evidenceRefs: Object.freeze([...entry.value.evidenceRefs]),
      });
    },
    store(
      address: AdapterExactQuoteCacheAddress,
      value: AdapterExactQuoteCacheValue,
    ): string {
      const cacheKey = exactQuoteCacheKey(address);
      if (
        !Array.isArray(value.trustedResults) ||
        value.trustedResults.length === 0 ||
        value.trustedResults.some((result) =>
          !result.ok ||
          result.source.number !== address.source.number ||
          result.source.generation !== address.source.generation ||
          result.source.hash.toLowerCase() !== address.source.hash.toLowerCase()
        )
      ) {
        throw new Error(
          "Adapter exact quote cache accepts only successful source-bound results",
        );
      }
      if (!Array.isArray(value.evidenceRefs)) {
        throw new Error("Adapter exact quote cache evidenceRefs must be an array");
      }
      if (
        !Array.isArray(value.roundFingerprints) ||
        value.roundFingerprints.length === 0 ||
        value.roundFingerprints.some((fingerprint) =>
          !/^[a-fA-F0-9]{64}$/.test(fingerprint)
        )
      ) {
        throw new Error(
          "Adapter exact quote cache roundFingerprints must be non-empty SHA-256 values",
        );
      }
      const evidenceRefs = Object.freeze([...new Set(value.evidenceRefs)].sort());
      const entry: CacheEntry = Object.freeze({
        value: Object.freeze({
          trustedResults: Object.freeze([...value.trustedResults]),
          roundFingerprints: Object.freeze([...value.roundFingerprints]),
          evidenceRefs,
        }),
      });
      if (entries.has(cacheKey)) entries.delete(cacheKey);
      while (entries.size >= capacity) {
        const oldest = entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        entries.delete(oldest);
        evictions++;
      }
      entries.set(cacheKey, entry);
      stores++;
      return cacheKey;
    },
    snapshot(): AdapterExactQuoteCacheSnapshot {
      return Object.freeze({
        size: entries.size,
        capacity,
        hits,
        misses,
        stores,
        evictions,
      });
    },
  });
  issuedExactQuoteCaches.add(cache);
  return cache;
}

export function assertIssuedAdapterFamilyExactQuoteCache(
  value: unknown,
): asserts value is AdapterFamilyExactQuoteCache {
  if (
    value === null || typeof value !== "object" ||
    (value as Partial<AdapterFamilyExactQuoteCache>)[exactQuoteCacheBrand] !==
      true ||
    !issuedExactQuoteCaches.has(value)
  ) {
    throw new Error("Adapter exact quote cache must be centrally issued");
  }
}

export function exactQuoteCacheKey(
  address: AdapterExactQuoteCacheAddress,
): string {
  assertAddress(address);
  return `adapter-exact-quote:${hashCanonical({
    namespace: "adapter-family-exact-quote-v2",
    familyRuntimeIdentity: runtimeIdentityToken(address.familyRuntimeIdentity),
    familyId: address.familyId,
    instanceKey: address.instanceKey,
    routeKey: address.routeKey,
    instanceFingerprint: address.instanceFingerprint.toLowerCase(),
    routeBindingFingerprint: address.routeBindingFingerprint.toLowerCase(),
    capabilityHash: address.capabilityHash.toLowerCase(),
    compatibilityFingerprint: address.compatibilityFingerprint.toLowerCase(),
    methodId: address.methodId,
    methodIndex: address.methodIndex,
    methodOrderFingerprint: address.methodOrderFingerprint.toLowerCase(),
    requestFingerprint: address.requestFingerprint.toLowerCase(),
    amountIn: address.amountIn,
    executor: address.executor.toLowerCase(),
    // Exact results are never carried across block hashes without a separate
    // mutation proof. Generation is deliberately absent so duplicate work for
    // the same physical source can be reused after a safe retry.
    source: {
      number: address.source.number,
      hash: address.source.hash.toLowerCase(),
    },
  })}`;
}

function assertAddress(address: AdapterExactQuoteCacheAddress): void {
  if (
    address.familyRuntimeIdentity === null ||
    (typeof address.familyRuntimeIdentity !== "object" &&
      typeof address.familyRuntimeIdentity !== "function")
  ) {
    throw new Error(
      "Adapter exact quote cache familyRuntimeIdentity must be an object",
    );
  }
  for (const [label, value] of [
    ["familyId", address.familyId],
    ["instanceKey", address.instanceKey],
    ["routeKey", address.routeKey],
    ["methodId", address.methodId],
  ] as const) {
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
      throw new Error(`Adapter exact quote cache ${label} must be canonical`);
    }
  }
  for (const [label, value] of [
    ["instanceFingerprint", address.instanceFingerprint],
    ["routeBindingFingerprint", address.routeBindingFingerprint],
    ["capabilityHash", address.capabilityHash],
    ["compatibilityFingerprint", address.compatibilityFingerprint],
    ["methodOrderFingerprint", address.methodOrderFingerprint],
    ["requestFingerprint", address.requestFingerprint],
  ] as const) {
    if (!/^[a-fA-F0-9]{64}$/.test(value)) {
      throw new Error(`Adapter exact quote cache ${label} must be SHA-256`);
    }
  }
  if (typeof address.amountIn !== "bigint" || address.amountIn < 0n) {
    throw new Error("Adapter exact quote cache amountIn must be non-negative");
  }
  if (!Number.isSafeInteger(address.methodIndex) || address.methodIndex < 0) {
    throw new Error(
      "Adapter exact quote cache methodIndex must be a non-negative safe integer",
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address.executor)) {
    throw new Error("Adapter exact quote cache executor must be an address");
  }
  if (
    !Number.isSafeInteger(address.source.number) || address.source.number < 0 ||
    !Number.isSafeInteger(address.source.generation) ||
    address.source.generation < 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(address.source.hash)
  ) {
    throw new Error("Adapter exact quote cache source must be canonical");
  }
}

function runtimeIdentityToken(identity: object): string {
  const existing = runtimeIdentityTokens.get(identity);
  if (existing !== undefined) return existing;
  const issued = `family-runtime-${nextRuntimeIdentityToken++}`;
  runtimeIdentityTokens.set(identity, issued);
  return issued;
}
