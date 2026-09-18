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

/** requestFingerprint binds the actual state program for this individual round. */
export type AdapterExactStateCacheAddress = AdapterExactQuoteCacheAddress & {
  readonly stateKey: string;
};

interface StateActivity {
  readonly source: CanonicalSource;
  readonly touchedStateKeys: ReadonlySet<string>;
  readonly complete: true;
  readonly parentHash?: string;
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
  readonly stateSize: number;
  readonly stateHits: number;
  readonly stateMisses: number;
  readonly stateStores: number;
  readonly stateEvictions: number;
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
  advanceState(source: CanonicalSource, activity?: StateActivity): void;
  resetState(): void;
  lookupState(
    address: AdapterExactStateCacheAddress,
  ): AdapterExactQuoteCacheHit | undefined;
  /** The caller authorizes returned ethcall state programs before storing. */
  storeState(
    address: AdapterExactStateCacheAddress,
    value: AdapterExactQuoteCacheValue,
  ): string | undefined;
  snapshot(): AdapterExactQuoteCacheSnapshot;
}

interface CacheEntry {
  readonly value: AdapterExactQuoteCacheValue;
}

interface StateCacheEntry extends CacheEntry {
  readonly stateKey: string;
  readonly resultFingerprints: readonly string[];
}

const DEFAULT_CAPACITY = 8_192;
const DEFAULT_STATE_CAPACITY = 32_768;
const runtimeIdentityTokens = new WeakMap<object, string>();
let nextRuntimeIdentityToken = 1;

export function createAdapterFamilyExactQuoteCache(options: {
  readonly capacity?: number;
  readonly stateCapacity?: number;
} = {}): AdapterFamilyExactQuoteCache {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new Error("Adapter exact quote cache capacity must be positive");
  }
  const stateCapacity = options.stateCapacity ?? DEFAULT_STATE_CAPACITY;
  if (!Number.isSafeInteger(stateCapacity) || stateCapacity <= 0) {
    throw new Error("Adapter exact state cache capacity must be positive");
  }
  const entries = new Map<string, CacheEntry>();
  const stateEntries = new Map<string, StateCacheEntry>();
  const stateKeyIndex = new Map<string, Set<string>>();
  let stateSource: CanonicalSource | undefined;
  let stateActivityFingerprint: string | undefined;
  let hits = 0;
  let misses = 0;
  let stores = 0;
  let evictions = 0;
  let stateHits = 0;
  let stateMisses = 0;
  let stateStores = 0;
  let stateEvictions = 0;

  function clearStateEntries(): void {
    stateEntries.clear();
    stateKeyIndex.clear();
  }

  function deleteStateEntry(cacheKey: string): void {
    const entry = stateEntries.get(cacheKey);
    if (entry === undefined) return;
    stateEntries.delete(cacheKey);
    const indexed = stateKeyIndex.get(entry.stateKey);
    indexed?.delete(cacheKey);
    if (indexed?.size === 0) stateKeyIndex.delete(entry.stateKey);
  }

  function isCurrentStateSource(source: CanonicalSource): boolean {
    // Retry generations can reuse entries, but superseded work cannot publish.
    return stateSource !== undefined &&
      samePhysicalSource(source, stateSource) &&
      source.generation === stateSource.generation;
  }

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
    advanceState(source: CanonicalSource, activity?: StateActivity): void {
      assertCanonicalSource(source);
      const previous = stateSource;
      const previousProof = stateActivityFingerprint;
      // Publish the new source synchronously, before the caller starts any I/O.
      stateSource = Object.freeze({ ...source });
      stateActivityFingerprint = undefined;
      let proof: string | undefined;
      try {
        proof = activity === undefined ? undefined : hashCanonical({
          source: {
            number: activity.source.number,
            hash: activity.source.hash.toLowerCase(),
          },
          complete: activity.complete,
          touchedStateKeys: [...activity.touchedStateKeys].sort(),
          parentHash: activity.parentHash?.toLowerCase() ?? null,
        });
      } catch (error) {
        clearStateEntries();
        throw error;
      }
      stateActivityFingerprint = proof;
      if (previous !== undefined && samePhysicalSource(previous, source)) {
        // A retry must not invalidate entries already refreshed in this block.
        // Changed (including newly missing) activity cannot preserve that proof.
        if (proof !== previousProof) clearStateEntries();
        return;
      }
      if (
        previous === undefined || source.number !== previous.number + 1 ||
        activity?.complete !== true ||
        !samePhysicalSource(activity.source, source) ||
        activity.parentHash?.toLowerCase() !== previous.hash.toLowerCase()
      ) {
        clearStateEntries();
        return;
      }
      for (const stateKey of activity.touchedStateKeys) {
        const indexed = stateKeyIndex.get(stateKey);
        if (indexed === undefined) continue;
        for (const cacheKey of indexed) deleteStateEntry(cacheKey);
      }
    },
    resetState(): void {
      clearStateEntries();
      stateSource = undefined;
      stateActivityFingerprint = undefined;
    },
    lookupState(
      address: AdapterExactStateCacheAddress,
    ): AdapterExactQuoteCacheHit | undefined {
      const cacheKey = exactStateCacheKey(address);
      const entry = isCurrentStateSource(address.source)
        ? stateEntries.get(cacheKey)
        : undefined;
      if (entry === undefined) {
        stateMisses++;
        return undefined;
      }
      stateEntries.delete(cacheKey);
      stateEntries.set(cacheKey, entry);
      stateHits++;
      const source = Object.freeze({ ...address.source });
      return Object.freeze({
        cacheKey,
        trustedResults: Object.freeze(entry.value.trustedResults.map(
          (result, index) => Object.freeze({
            ...result,
            source,
            provenance: Object.freeze({
              kind: "retained-local-state",
              fingerprint: hashCanonical({
                namespace: "adapter-family-retained-local-state-v1",
                cacheKey,
                originalResult: entry.resultFingerprints[index],
                source: { ...source, hash: source.hash.toLowerCase() },
              }),
            }),
          }),
        )),
        roundFingerprints: entry.value.roundFingerprints,
        evidenceRefs: Object.freeze([...entry.value.evidenceRefs]),
      });
    },
    storeState(
      address: AdapterExactStateCacheAddress,
      value: AdapterExactQuoteCacheValue,
    ): string | undefined {
      const cacheKey = exactStateCacheKey(address);
      if (
        !isCurrentStateSource(address.source) ||
        !Array.isArray(value.trustedResults) ||
        value.trustedResults.length === 0 ||
        value.trustedResults.some((result) =>
          !result.ok || result.completion !== "returned" ||
          result.effects !== undefined ||
          !samePhysicalSource(result.source, address.source) ||
          result.source.generation !== address.source.generation
        ) ||
        !Array.isArray(value.evidenceRefs) ||
        !Array.isArray(value.roundFingerprints) ||
        value.roundFingerprints.length === 0 ||
        value.roundFingerprints.some((fingerprint) =>
          !/^[a-fA-F0-9]{64}$/.test(fingerprint)
        )
      ) return undefined;
      const trustedResults = Object.freeze(value.trustedResults.map((result) => {
        if (!result.ok) throw new Error("Unreachable failed state result");
        // Keep the original read source and provenance, independent of callers.
        return Object.freeze({
          ...result,
          source: Object.freeze({ ...result.source }),
          provenance: Object.freeze({ ...result.provenance }),
        });
      }));
      const entry: StateCacheEntry = Object.freeze({
        stateKey: address.stateKey,
        resultFingerprints: Object.freeze(trustedResults.map((result) =>
          hashCanonical({
            id: result.id,
            ok: result.ok,
            source: { ...result.source, hash: result.source.hash.toLowerCase() },
            provenance: { ...result.provenance },
            completion: result.completion,
            data: result.data.toLowerCase(),
          })
        )),
        value: Object.freeze({
          trustedResults,
          roundFingerprints: Object.freeze([...value.roundFingerprints]),
          evidenceRefs: Object.freeze([...new Set(value.evidenceRefs)].sort()),
        }),
      });
      deleteStateEntry(cacheKey);
      while (stateEntries.size >= stateCapacity) {
        const oldest = stateEntries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        deleteStateEntry(oldest);
        stateEvictions++;
      }
      stateEntries.set(cacheKey, entry);
      let indexed = stateKeyIndex.get(address.stateKey);
      if (indexed === undefined) {
        indexed = new Set<string>();
        stateKeyIndex.set(address.stateKey, indexed);
      }
      indexed.add(cacheKey);
      stateStores++;
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
        stateSize: stateEntries.size,
        stateHits,
        stateMisses,
        stateStores,
        stateEvictions,
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
    ...quoteCacheIdentity(address),
    amountIn: address.amountIn,
    // Exact results are never carried across block hashes without a separate
    // mutation proof. Generation is deliberately absent so duplicate work for
    // the same physical source can be reused after a safe retry.
    source: {
      number: address.source.number,
      hash: address.source.hash.toLowerCase(),
    },
  })}`;
}

function exactStateCacheKey(address: AdapterExactStateCacheAddress): string {
  assertAddress(address);
  if (
    typeof address.stateKey !== "string" || address.stateKey.length === 0 ||
    address.stateKey.trim() !== address.stateKey
  ) {
    throw new Error("Adapter exact state cache stateKey must be canonical");
  }
  return `adapter-exact-state:${hashCanonical({
    namespace: "adapter-family-exact-state-v1",
    ...quoteCacheIdentity(address),
    stateKey: address.stateKey,
  })}`;
}

function quoteCacheIdentity(address: AdapterExactQuoteCacheAddress) {
  return {
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
    executor: address.executor.toLowerCase(),
  };
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
  assertCanonicalSource(address.source);
}

function assertCanonicalSource(source: CanonicalSource): void {
  if (
    !Number.isSafeInteger(source.number) || source.number < 0 ||
    !Number.isSafeInteger(source.generation) || source.generation < 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(source.hash)
  ) {
    throw new Error("Adapter exact quote cache source must be canonical");
  }
}

function samePhysicalSource(left: CanonicalSource, right: CanonicalSource): boolean {
  return left.number === right.number &&
    left.hash.toLowerCase() === right.hash.toLowerCase();
}

function runtimeIdentityToken(identity: object): string {
  const existing = runtimeIdentityTokens.get(identity);
  if (existing !== undefined) return existing;
  const issued = `family-runtime-${nextRuntimeIdentityToken++}`;
  runtimeIdentityTokens.set(identity, issued);
  return issued;
}
