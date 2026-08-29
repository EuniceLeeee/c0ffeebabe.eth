import {
  assertExactKeys,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { monotonicNow } from "../../../packages/scheduler/src/index.ts";

export type SourceNumber = string;

/**
 * These shapes intentionally retain every provider/source/request field.  The
 * cache never derives a shorter key from a target, topic, or manager name.
 */
export interface SharedSourceKey {
  readonly chainId: string;
  readonly number: SourceNumber;
  readonly hash: string;
  readonly stateRoot: string;
}

export interface SharedProviderKey {
  readonly provider: string;
  readonly backendEpoch: string;
}

export interface SemanticWorkKey {
  readonly ownerRef: string;
  readonly provider: SharedProviderKey;
  readonly source: SharedSourceKey;
  readonly capabilityFingerprint: string;
  readonly target: CanonicalJson;
  readonly request: CanonicalJson;
  readonly window?: CanonicalJson;
  readonly lookback?: CanonicalJson;
  readonly chunk?: CanonicalJson;
  readonly manager?: CanonicalJson;
  readonly topic?: CanonicalJson;
  /** Additional opaque request dimensions are preserved by canonicalization. */
  readonly [field: string]: unknown;
}

export interface CanonicalWorkKey {
  readonly hash: Hash;
  readonly bytes: string;
  readonly value: CanonicalJson;
}

/**
 * Canonicalizes the complete semantic key.  No field is selected or omitted,
 * so source hash/number, provider epoch, manager/topic, lookback and chunk
 * changes all produce independent work.  The canonical codec also rejects
 * undefined values, accessors, proxies, and non-canonical numbers.
 */
export function canonicalizeWorkKey(value: unknown): CanonicalWorkKey {
  const bytes = encodeCanonicalJson(value);
  const parsed = JSON.parse(bytes) as CanonicalJson;
  return Object.freeze({
    hash: hashDomain("aloha/shared-work-key/v1", parsed),
    bytes,
    value: parsed,
  });
}

export function canonicalWorkKeyHash(value: unknown): Hash {
  return canonicalizeWorkKey(value).hash;
}

export function canonicalWorkKeyBytes(value: unknown): string {
  return canonicalizeWorkKey(value).bytes;
}

export function assertSemanticWorkKey(
  value: unknown,
): asserts value is SemanticWorkKey {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("semantic WorkKey must be an object");
  }
  const record = value as Record<string, unknown>;
  const required = [
    "ownerRef",
    "provider",
    "source",
    "capabilityFingerprint",
    "target",
    "request",
  ];
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      throw new TypeError(`semantic WorkKey is missing ${field}`);
    }
  }
  if (
    typeof record.capabilityFingerprint !== "string" ||
    record.capabilityFingerprint.length === 0
  ) {
    throw new TypeError(
      "semantic WorkKey capabilityFingerprint must be non-empty",
    );
  }
  if (typeof record.ownerRef !== "string" || record.ownerRef.length === 0) {
    throw new TypeError("semantic WorkKey ownerRef must be non-empty");
  }
  const provider = record.provider;
  const providerRecord = provider as Record<string, unknown>;
  if (
    provider === null ||
    typeof provider !== "object" ||
    Array.isArray(provider) ||
    typeof providerRecord.provider !== "string" ||
    providerRecord.provider.length === 0 ||
    typeof providerRecord.backendEpoch !== "string" ||
    providerRecord.backendEpoch.length === 0
  ) {
    throw new TypeError("semantic WorkKey provider identity is incomplete");
  }
  assertExactKeys(provider, ["provider", "backendEpoch"]);
  const source = record.source;
  if (
    source === null ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    !["chainId", "number", "hash", "stateRoot"].every(
      (field) =>
        typeof (source as Record<string, unknown>)[field] === "string" &&
        ((source as Record<string, unknown>)[field] as string).length > 0,
    )
  ) {
    throw new TypeError("semantic WorkKey source anchor is incomplete");
  }
  assertExactKeys(source, ["chainId", "number", "hash", "stateRoot"]);
  canonicalizeWorkKey(value);
}

export interface ConsumerLease {
  readonly id: string;
  /** Monotonic deadline, matching scheduler/performance clock semantics. */
  readonly deadlineAtMs?: number;
  readonly signal?: AbortSignal;
}

export function consumerLease(
  id: string,
  options: Omit<ConsumerLease, "id"> = {},
): ConsumerLease {
  if (typeof id !== "string" || id.length === 0)
    throw new TypeError("consumer id must be non-empty");
  if (
    options.deadlineAtMs !== undefined &&
    !Number.isFinite(options.deadlineAtMs)
  ) {
    throw new TypeError("consumer deadline must be finite");
  }
  return Object.freeze({ id, ...options });
}

function assertConsumerLease(lease: ConsumerLease): void {
  if (!lease || typeof lease.id !== "string" || lease.id.length === 0)
    throw new TypeError("consumer id must be non-empty");
  if (lease.deadlineAtMs !== undefined && !Number.isFinite(lease.deadlineAtMs))
    throw new TypeError("consumer deadline must be finite");
  if (
    lease.signal !== undefined &&
    (typeof lease.signal.addEventListener !== "function" ||
      typeof lease.signal.removeEventListener !== "function")
  )
    throw new TypeError("consumer signal is invalid");
}

export type BuildFunction<V> = (signal: AbortSignal) => Promise<V> | V;
export type BatchBuildFunction<K, V> = (input: {
  readonly keys: readonly K[];
  readonly signal: AbortSignal;
}) => Promise<readonly V[]> | readonly V[];

export type SettledValidity<K, V> = (value: V, key: K) => boolean;

export interface SharedWorkCacheOptions<K, V> {
  readonly key?: (key: K) => CanonicalWorkKey;
  readonly validity?: SettledValidity<K, V>;
  readonly clock?: () => number;
}

export interface SharedWorkStats {
  readonly settledHits: number;
  readonly inFlightJoins: number;
  readonly physicalBuilds: number;
  readonly buildFailures: number;
  /** Physical results rejected by the validity predicate and never cached. */
  readonly invalidResults: number;
  readonly consumerAborts: number;
  readonly consumerDeadlines: number;
  readonly physicalAborts: number;
}

export type SharedWorkRejectCode =
  "abort" | "deadline" | "invalidated" | "build-failed";

/** A logical consumer rejection is explicit and does not claim physical settlement. */
export class SharedWorkRejected extends Error {
  readonly kind = "rejected" as const;
  readonly code: SharedWorkRejectCode;
  readonly retryClass = "retryable" as const;

  constructor(code: SharedWorkRejectCode, message: string) {
    super(message);
    this.name = "SharedWorkRejected";
    this.code = code;
  }
}

export interface SharedWorkOwnerSeed {
  readonly ownerRef: string;
}

interface SettledEntry<K, V> {
  readonly key: CanonicalWorkKey;
  readonly value: V;
  readonly valid: SettledValidity<K, V>;
}

interface InFlightEntry<K, V> {
  readonly key: CanonicalWorkKey;
  readonly controller: AbortController;
  readonly consumers: Map<symbol, ConsumerLease>;
  readonly rejectors: Map<symbol, (error: SharedWorkRejected) => void>;
  readonly promise: Promise<V>;
  readonly valid: SettledValidity<K, V>;
  readonly generation: number;
  settled: boolean;
  invalidated: boolean;
  readonly consumerGroup?: { count: number };
}

export interface SharedWorkCacheSnapshot {
  readonly settledEntries: number;
  readonly inFlightEntries: number;
  readonly consumers: number;
  readonly stats: SharedWorkStats;
}

/**
 * Source/program-keyed settled + inFlight cache.  A consumer timeout only
 * detaches that consumer; physical abort occurs after the last consumer leaves
 * and the in-flight promise is removed only if it is still the same promise.
 */
export class SharedWorkCache<K, V> {
  private readonly settled = new Map<Hash, SettledEntry<K, V>[]>();
  private readonly inFlight = new Map<Hash, InFlightEntry<K, V>[]>();
  private readonly keyCodec: (key: K) => CanonicalWorkKey;
  private readonly defaultValidity: SettledValidity<K, V>;
  private readonly clock: () => number;
  private readonly statState = {
    settledHits: 0,
    inFlightJoins: 0,
    physicalBuilds: 0,
    buildFailures: 0,
    invalidResults: 0,
    consumerAborts: 0,
    consumerDeadlines: 0,
    physicalAborts: 0,
  };
  private generation = 0;

  constructor(options: SharedWorkCacheOptions<K, V> = {}) {
    this.keyCodec = options.key ?? ((key: K) => canonicalizeWorkKey(key));
    this.defaultValidity = options.validity ?? (() => true);
    this.clock = options.clock ?? monotonicNow;
  }

  getOrBuild(
    key: K,
    consumer: ConsumerLease,
    build: BuildFunction<V>,
  ): Promise<V>;
  getOrBuild(
    key: K,
    build: BuildFunction<V>,
    consumer?: ConsumerLease,
  ): Promise<V>;
  getOrBuild(
    key: K,
    consumerOrBuild: ConsumerLease | BuildFunction<V>,
    buildOrConsumer?: BuildFunction<V> | ConsumerLease,
  ): Promise<V> {
    const consumer =
      typeof consumerOrBuild === "function"
        ? (buildOrConsumer as ConsumerLease | undefined)
        : consumerOrBuild;
    const build =
      typeof consumerOrBuild === "function"
        ? consumerOrBuild
        : (buildOrConsumer as BuildFunction<V>);
    if (typeof build !== "function")
      throw new TypeError("build must be a function");
    const lease =
      consumer ?? consumerLease(`anonymous-${++anonymousConsumerSequence}`);
    assertConsumerLease(lease);
    const canonical = this.keyCodec(key);
    assertSemanticWorkKey(canonical.value);
    // Reject an already-finished logical consumer before touching either
    // settled or in-flight state.  Otherwise the cache would create a
    // physical Promise and only detach the consumer afterward, allowing a
    // builder to start work that has no remaining consumer.
    if (lease.signal?.aborted) {
      this.statState.consumerAborts += 1;
      return Promise.reject(new SharedWorkRejected("abort", "consumer aborted"));
    }
    if (lease.deadlineAtMs !== undefined && lease.deadlineAtMs <= this.clock()) {
      this.statState.consumerDeadlines += 1;
      return Promise.reject(new SharedWorkRejected("deadline", "consumer deadline elapsed"));
    }
    const validity = this.defaultValidity;
    const settled = this.findSettled(canonical);
    if (settled !== undefined) {
      let valid = false;
      try {
        valid = settled.valid(settled.value, key);
      } catch {
        // A validity observer is allowed to discover that a previously
        // settled result can no longer be trusted.  Remove it instead of
        // repeatedly retaining an entry whose observer itself is broken.
        this.removeSettledIfSame(settled);
      }
      if (valid) {
        this.statState.settledHits += 1;
        return this.resolveSettled(settled.value, lease);
      }
      if (!valid) this.removeSettledIfSame(settled);
    }

    let entry = this.findInFlight(canonical);
    if (entry === undefined) {
      const controller = new AbortController();
      // Start through a microtask so a synchronously-aborted consumer can
      // detach before user code receives a result, while preserving a single
      // physical build for all joins.
      const promise = Promise.resolve().then(() => build(controller.signal));
      entry = {
        key: canonical,
        controller,
        consumers: new Map(),
        rejectors: new Map(),
        promise,
        valid: validity,
        generation: this.generation,
        settled: false,
        invalidated: false,
      };
      this.statState.physicalBuilds += 1;
      this.addInFlight(entry);
      promise.then(
        (value) => {
          entry!.settled = true;
          let valid = false;
          try {
            valid = entry!.valid(value, key);
          } catch {
            // A malformed validity observer must not pin the physical entry
            // or turn a failed cache admission into a reusable result.
            this.statState.invalidResults += 1;
            this.removeInFlightIfSame(entry!);
            return;
          }
          if (!valid) this.statState.invalidResults += 1;
          if (entry!.generation === this.generation && !entry!.invalidated && valid) {
            this.settled.set(canonical.hash, [
              ...(this.settled.get(canonical.hash) ?? []).filter(
                (candidate) => candidate.key.bytes !== canonical.bytes,
              ),
              { key: canonical, value, valid: validity },
            ]);
          }
          this.removeInFlightIfSame(entry!);
        },
        () => {
          entry!.settled = true;
          this.statState.buildFailures += 1;
          // Failure never enters settled.  The identity check matters if a
          // retry has already installed a newer entry after a stale failure.
          this.removeInFlightIfSame(entry!);
        },
      );
    } else {
      this.statState.inFlightJoins += 1;
    }
    return this.attachConsumer(entry, lease);
  }

  /**
   * Batch physical work still enters the same per-key inFlight/settled maps.
   * A batch builder is allowed to return one result per unique key, but each
   * consumer remains independently cancellable and can only observe its key.
   */
  getOrBuildBatch(
    entries: readonly { readonly key: K; readonly consumer: ConsumerLease }[],
    build: BatchBuildFunction<K, V>,
  ): Promise<readonly V[]> {
    if (entries.length === 0) return Promise.resolve([]);
    const canonicalEntries = entries.map((entry) => {
      assertConsumerLease(entry.consumer);
      const canonical = this.keyCodec(entry.key);
      assertSemanticWorkKey(canonical.value);
      return Object.freeze({ ...entry, canonical });
    });
    const missing = new Map<
      string,
      { readonly key: K; readonly canonical: CanonicalWorkKey }
    >();
    const results: Array<Promise<V>> = [];
    for (const entry of canonicalEntries) {
      if (entry.consumer.signal?.aborted) {
        this.statState.consumerAborts += 1;
        results.push(Promise.reject(new SharedWorkRejected("abort", "consumer aborted")));
        continue;
      }
      if (entry.consumer.deadlineAtMs !== undefined && entry.consumer.deadlineAtMs <= this.clock()) {
        this.statState.consumerDeadlines += 1;
        results.push(Promise.reject(new SharedWorkRejected("deadline", "consumer deadline elapsed")));
        continue;
      }
      const settled = this.findSettled(entry.canonical);
      if (settled !== undefined) {
        let valid = false;
        try {
          valid = settled.valid(settled.value, entry.key);
        } catch {
          this.removeSettledIfSame(settled);
        }
        if (valid) {
          this.statState.settledHits += 1;
          results.push(this.resolveSettled(settled.value, entry.consumer));
          continue;
        }
        if (!valid) this.removeSettledIfSame(settled);
      }
      const existing = this.findInFlight(entry.canonical);
      if (existing !== undefined) {
        this.statState.inFlightJoins += 1;
        results.push(this.attachConsumer(existing, entry.consumer));
        continue;
      }
      missing.set(entry.canonical.bytes, {
        key: entry.key,
        canonical: entry.canonical,
      });
      results.push(Promise.resolve(undefined as unknown as V));
    }
    if (missing.size === 0) return Promise.all(results);
    const controller = new AbortController();
    const missingItems = [...missing.values()];
    const batchPromise = Promise.resolve().then(() =>
      build({
        keys: missingItems.map((item) => item.key),
        signal: controller.signal,
      }),
    );
    const consumerGroup = { count: 0 };
    const created = missingItems.map((item, index) => {
      const promise = batchPromise.then((values) => {
        if (!Array.isArray(values) || values.length !== missingItems.length)
          throw new TypeError("shared-work batch result count mismatch");
        return values[index] as V;
      });
      const entry: InFlightEntry<K, V> = {
        key: item.canonical,
        controller,
        consumers: new Map(),
        rejectors: new Map(),
        promise,
        valid: this.defaultValidity,
        generation: this.generation,
        settled: false,
        invalidated: false,
        consumerGroup,
      };
      this.addInFlight(entry);
      promise.then(
        (value) => {
          entry.settled = true;
          let valid = false;
          try {
            valid = entry.valid(value, item.key);
          } catch {
            this.statState.invalidResults += 1;
            this.removeInFlightIfSame(entry);
            return;
          }
          if (!valid) this.statState.invalidResults += 1;
          if (entry.generation === this.generation && !entry.invalidated && valid) {
            this.settled.set(entry.key.hash, [
              ...(this.settled.get(entry.key.hash) ?? []).filter(
                (candidate) => candidate.key.bytes !== entry.key.bytes,
              ),
              { key: entry.key, value, valid: entry.valid },
            ]);
          }
          this.removeInFlightIfSame(entry);
        },
        () => {
          entry.settled = true;
          this.statState.buildFailures += 1;
          this.removeInFlightIfSame(entry);
        },
      );
      return entry;
    });
    const createdByBytes = new Map(
      created.map((entry) => [entry.key.bytes, entry]),
    );
    let resultIndex = 0;
    for (const entry of canonicalEntries) {
      if (
        results[resultIndex]!.then !== undefined &&
        missing.has(entry.canonical.bytes)
      ) {
        results[resultIndex] = this.attachConsumer(
          createdByBytes.get(entry.canonical.bytes)!,
          entry.consumer,
        );
      }
      resultIndex += 1;
    }
    this.statState.physicalBuilds += 1;
    return Promise.all(results);
  }

  invalidate(key: K): boolean {
    const canonical = this.keyCodec(key);
    assertSemanticWorkKey(canonical.value);
    const entries = this.settled.get(canonical.hash);
    if (!entries) return false;
    const retained = entries.filter(
      (entry) => entry.key.bytes !== canonical.bytes,
    );
    if (retained.length === 0) this.settled.delete(canonical.hash);
    else this.settled.set(canonical.hash, retained);
    return retained.length !== entries.length;
  }

  /** Seed a verified result produced by an owner-controlled batch operation. */
  seed(key: K, value: V, owner: SharedWorkOwnerSeed): void {
    const canonical = this.keyCodec(key);
    assertSemanticWorkKey(canonical.value);
    assertSeedOwner(canonical, owner);
    const valid = this.defaultValidity;
    if (!valid(value, key))
      throw new TypeError("cannot seed an invalid shared-work result");
    this.settled.set(canonical.hash, [
      ...(this.settled.get(canonical.hash) ?? []).filter(
        (entry) => entry.key.bytes !== canonical.bytes,
      ),
      { key: canonical, value, valid },
    ]);
  }

  clear(): void {
    this.settled.clear();
    this.generation += 1;
    for (const entries of this.inFlight.values()) {
      for (const entry of entries) {
        entry.invalidated = true;
        for (const reject of entry.rejectors.values())
          reject(
            new SharedWorkRejected(
              "invalidated",
              "shared work was invalidated",
            ),
          );
        if (!entry.settled && !entry.controller.signal.aborted) {
          this.statState.physicalAborts += 1;
          entry.controller.abort("cache-cleared");
        }
      }
    }
    // Keep physical entries until their promises settle, but do not let a new
    // consumer join an invalidated generation.  The old physical operation is
    // still retained solely for lifecycle/permit accounting.
  }

  snapshot(): SharedWorkCacheSnapshot {
    let inFlightEntries = 0;
    let consumers = 0;
    for (const entries of this.inFlight.values()) {
      inFlightEntries += entries.length;
      for (const entry of entries) consumers += entry.consumers.size;
    }
    let settledEntries = 0;
    for (const entries of this.settled.values())
      settledEntries += entries.length;
    return Object.freeze({
      settledEntries,
      inFlightEntries,
      consumers,
      stats: Object.freeze({ ...this.statState }),
    });
  }

  private findSettled(
    canonical: CanonicalWorkKey,
  ): SettledEntry<K, V> | undefined {
    return this.settled
      .get(canonical.hash)
      ?.find((entry) => entry.key.bytes === canonical.bytes);
  }

  private findInFlight(
    canonical: CanonicalWorkKey,
  ): InFlightEntry<K, V> | undefined {
    return this.inFlight
      .get(canonical.hash)
      ?.find(
        (entry) => entry.key.bytes === canonical.bytes && !entry.invalidated,
      );
  }

  private addInFlight(entry: InFlightEntry<K, V>): void {
    this.inFlight.set(entry.key.hash, [
      ...(this.inFlight.get(entry.key.hash) ?? []),
      entry,
    ]);
  }

  private removeInFlightIfSame(entry: InFlightEntry<K, V>): void {
    const entries = this.inFlight.get(entry.key.hash);
    if (!entries) return;
    const retained = entries.filter((candidate) => candidate !== entry);
    if (retained.length === 0) this.inFlight.delete(entry.key.hash);
    else this.inFlight.set(entry.key.hash, retained);
  }

  private removeSettledIfSame(entry: SettledEntry<K, V>): void {
    const entries = this.settled.get(entry.key.hash);
    if (!entries) return;
    const retained = entries.filter((candidate) => candidate !== entry);
    if (retained.length === 0) this.settled.delete(entry.key.hash);
    else this.settled.set(entry.key.hash, retained);
  }

  private attachConsumer(
    entry: InFlightEntry<K, V>,
    lease: ConsumerLease,
  ): Promise<V> {
    const token = Symbol(lease.id);
    entry.consumers.set(token, lease);
    if (entry.consumerGroup) entry.consumerGroup.count += 1;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const detach = (): void => {
      entry.consumers.delete(token);
      entry.rejectors.delete(token);
      if (entry.consumerGroup) entry.consumerGroup.count -= 1;
      const remaining = entry.consumerGroup?.count ?? entry.consumers.size;
      if (
        remaining === 0 &&
        !entry.settled &&
        !entry.controller.signal.aborted
      ) {
        // A physical request that no longer has a consumer is no longer a
        // valid join target.  Mark it before aborting so a new logical read
        // creates fresh physical work instead of joining an already-aborted
        // promise during the abort/settle race.
        entry.invalidated = true;
        this.statState.physicalAborts += 1;
        entry.controller.abort("last-consumer-left");
      }
    };
    const settle = (
      resolve: (value: V | PromiseLike<V>) => void,
      reject: (reason?: unknown) => void,
      value?: V,
      error?: unknown,
    ): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort && lease.signal)
        lease.signal.removeEventListener("abort", onAbort);
      detach();
      if (error !== undefined) reject(error);
      else resolve(value as V);
    };
    return new Promise<V>((resolve, reject) => {
      const rejectFor = (code: "abort" | "deadline", reason: unknown): void => {
        if (code === "abort") this.statState.consumerAborts += 1;
        else this.statState.consumerDeadlines += 1;
        const error =
          reason instanceof SharedWorkRejected
            ? reason
            : new SharedWorkRejected(
                code,
                code === "abort"
                  ? "consumer aborted"
                  : "consumer deadline elapsed",
              );
        settle(resolve, reject, undefined, error);
      };
      entry.rejectors.set(token, (error) =>
        settle(resolve, reject, undefined, error),
      );
      onAbort = (): void => rejectFor("abort", lease.signal?.reason);
      if (lease.signal) {
        if (lease.signal.aborted) {
          rejectFor("abort", lease.signal.reason);
          return;
        }
        lease.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (
        lease.deadlineAtMs !== undefined &&
        lease.deadlineAtMs <= this.clock()
      ) {
        rejectFor("deadline", undefined);
        return;
      }
      if (lease.deadlineAtMs !== undefined) {
        timer = setTimeout(
          () => rejectFor("deadline", undefined),
          Math.max(0, lease.deadlineAtMs! - this.clock()),
        );
      }
      entry.promise.then(
        (value) => settle(resolve, reject, value),
        (error: unknown) =>
          settle(
            resolve,
            reject,
            undefined,
            error instanceof SharedWorkRejected ||
              (error instanceof Error && "retryClass" in error)
              ? error
              : new SharedWorkRejected(
                  "build-failed",
                  error instanceof Error ? error.message : String(error),
                ),
          ),
      );
    });
  }

  private resolveSettled(value: V, lease: ConsumerLease): Promise<V> {
    if (lease.signal?.aborted) {
      this.statState.consumerAborts += 1;
      return Promise.reject(
        new SharedWorkRejected("abort", "consumer aborted"),
      );
    }
    if (
      lease.deadlineAtMs !== undefined &&
      lease.deadlineAtMs <= this.clock()
    ) {
      this.statState.consumerDeadlines += 1;
      return Promise.reject(
        new SharedWorkRejected("deadline", "consumer deadline elapsed"),
      );
    }
    return Promise.resolve(value);
  }
}

function assertSeedOwner(
  canonical: CanonicalWorkKey,
  owner: SharedWorkOwnerSeed,
): void {
  if (
    !owner ||
    typeof owner.ownerRef !== "string" ||
    owner.ownerRef.length === 0
  ) {
    throw new TypeError("shared-work seed ownerRef must be non-empty");
  }
  const value = canonical.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("shared-work seed key must expose ownerRef");
  }
  const keyOwner = (value as Record<string, unknown>).ownerRef;
  if (keyOwner !== owner.ownerRef)
    throw new TypeError("shared-work seed ownerRef does not bind key");
}

let anonymousConsumerSequence = 0;

export const SharedInFlightCache = SharedWorkCache;
export const SharedInFlightWorkCache = SharedWorkCache;
export const createSharedWorkCache = <K, V>(
  options: SharedWorkCacheOptions<K, V> = {},
): SharedWorkCache<K, V> => new SharedWorkCache(options);
export const hashSemanticWorkKey = canonicalWorkKeyHash;
