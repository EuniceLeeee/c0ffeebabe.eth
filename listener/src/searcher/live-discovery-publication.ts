import { createHash } from "node:crypto";
import type { PoolEntry, TokenEdge } from "./planner/token-graph.js";
import {
  cloneProtocolDiscoveryEvidenceCache,
  pruneProtocolDiscoveryAddressCache,
  pruneRecentProcessedProtocolTxs,
  reconcileProtocolDiscoveryEvidenceCache,
  recordProtocolRouteOwnership,
  type ProtocolDiscoveryEvidenceCache,
} from "./protocol-discovery-cache.js";
import type {
  ProtocolDiscoveryOwnership,
  ProtocolDiscoveryProjection,
  ProtocolDiscoveryResult,
} from "./protocol-instance-discovery.js";
import type { DexGraphCoverageState } from "./runtime-pool-refresh.js";
import type { StrategyViews } from "./strategy-views.js";
import type { DiscoveryBackfillStateDescriptor } from "./discovery-backfill-lane.js";
import type { LandedPoolDiscoveryCoverage } from "./venues/landed-pool-discovery.js";

const BLOCK_HASH_RE = /^0x[0-9a-f]{64}$/;

/**
 * Canonical-chain proof for one exact completeness cursor.
 *
 * `completeThroughBlock = -1` is the only uninitialized value and requires a
 * null hash. Every non-negative cursor is meaningless without its canonical
 * block hash.
 */
export interface DiscoveryCoverageAnchor {
  readonly completeThroughBlock: number;
  readonly completeThroughHash: string | null;
}

/**
 * One detached discovery publication. A producer prepares and validates this
 * value outside the hot mutation queue; the hot path swaps the whole value or
 * none of it.
 *
 * There is intentionally no `protocolGraphCompleteThrough` scalar. Protocol
 * completeness is the minimum of the exact family×source anchors below, so a
 * second mutable scalar cannot disagree with its proof set.
 */
export interface LiveDiscoveryPublicationState {
  readonly revision: number;

  readonly strategyViews: StrategyViews;
  readonly backrunGraph: readonly TokenEdge[];
  readonly blockscanGraph?: readonly TokenEdge[];
  readonly tokenIndex: ReadonlyMap<string, ReadonlySet<string>>;
  readonly poolAddressMap: ReadonlyMap<string, string>;
  readonly flashTokens: readonly string[];
  readonly knownPoolKeys: ReadonlySet<string>;
  readonly knownPoolAddresses: ReadonlySet<string>;

  readonly protocolOwnership: ProtocolDiscoveryOwnership;
  readonly protocolEvidenceCache: ProtocolDiscoveryEvidenceCache;

  readonly retryableDexGraphPools: ReadonlyMap<string, PoolEntry>;
  readonly retryableDexIdentityPools: ReadonlyMap<string, PoolEntry>;
  readonly dexGraphCoverage: DexGraphCoverageState;
  readonly dexSourceAnchor: DiscoveryCoverageAnchor;
  readonly dexGraphAnchor: DiscoveryCoverageAnchor;
  readonly landedCoverage: readonly LandedPoolDiscoveryCoverage[];

  /**
   * Keyed by discoveryFamilySourceKey(familyId, sourceId). The anchor, rather
   * than a bare block number, is the completeness authority.
   */
  readonly protocolFamilySourceCoverage: ReadonlyMap<
    string,
    DiscoveryCoverageAnchor
  >;
  /**
   * Persisted observed-source cursor, repeated here only as an explicit
   * canonical anchor. Validation requires it to equal the evidence-cache
   * runtime cursor and hash.
   */
  readonly protocolObservedCursor: DiscoveryCoverageAnchor;
}

/**
 * Clone every mutable container and nested value. The domain clone preserves
 * the protocol-cache schema; the second generic clone also detaches opaque
 * evidence values that the persistence-oriented domain clone intentionally
 * leaves shallow.
 */
export function cloneLiveDiscoveryPublicationState(
  source: LiveDiscoveryPublicationState,
): LiveDiscoveryPublicationState {
  assertLiveDiscoveryPublicationState(source);
  const cloned: LiveDiscoveryPublicationState = {
    revision: source.revision,
    strategyViews: deepClone(source.strategyViews),
    backrunGraph: deepClone(source.backrunGraph),
    ...(source.blockscanGraph === undefined
      ? {}
      : { blockscanGraph: deepClone(source.blockscanGraph) }),
    tokenIndex: deepClone(source.tokenIndex),
    poolAddressMap: deepClone(source.poolAddressMap),
    flashTokens: deepClone(source.flashTokens),
    knownPoolKeys: deepClone(source.knownPoolKeys),
    knownPoolAddresses: deepClone(source.knownPoolAddresses),
    protocolOwnership: deepClone(source.protocolOwnership),
    protocolEvidenceCache: deepClone(
      cloneProtocolDiscoveryEvidenceCache(source.protocolEvidenceCache),
    ),
    retryableDexGraphPools: deepClone(source.retryableDexGraphPools),
    retryableDexIdentityPools: deepClone(source.retryableDexIdentityPools),
    dexGraphCoverage: deepClone(source.dexGraphCoverage),
    dexSourceAnchor: deepClone(source.dexSourceAnchor),
    dexGraphAnchor: deepClone(source.dexGraphAnchor),
    landedCoverage: deepClone(source.landedCoverage),
    protocolFamilySourceCoverage: deepClone(
      source.protocolFamilySourceCoverage,
    ),
    protocolObservedCursor: deepClone(source.protocolObservedCursor),
  };
  assertLiveDiscoveryPublicationState(cloned);
  return cloned;
}

/**
 * Content-address the complete publication. Map and Set insertion order is
 * ignored; graph/view array order is retained; bigint is encoded losslessly.
 */
export function describeLiveDiscoveryPublicationState(
  state: LiveDiscoveryPublicationState,
): DiscoveryBackfillStateDescriptor {
  assertLiveDiscoveryPublicationState(state);
  const coverage = coveragePayload(state);
  return Object.freeze({
    revision: state.revision,
    baseFingerprint: canonicalSha256({
      strategyViews: state.strategyViews,
      backrunGraph: state.backrunGraph,
      blockscanGraph: state.blockscanGraph,
      tokenIndex: state.tokenIndex,
      poolAddressMap: state.poolAddressMap,
      flashTokens: state.flashTokens,
      knownPoolKeys: state.knownPoolKeys,
      knownPoolAddresses: state.knownPoolAddresses,
      protocolOwnership: state.protocolOwnership,
      protocolEvidenceCache: state.protocolEvidenceCache,
      retryableDexGraphPools: state.retryableDexGraphPools,
      retryableDexIdentityPools: state.retryableDexIdentityPools,
      coverage,
    }),
    coverageFingerprint: canonicalSha256(coverage),
    graphCompleteThrough:
      deriveLiveDiscoveryGraphCompleteThroughUnchecked(state),
  });
}

/**
 * The executable graph is complete only through the least-complete active
 * discovery proof. An empty protocol proof set means no protocol source is
 * active, so DEX coverage alone owns the result.
 */
export function deriveLiveDiscoveryGraphCompleteThrough(
  state: LiveDiscoveryPublicationState,
): number {
  assertLiveDiscoveryPublicationState(state);
  return deriveLiveDiscoveryGraphCompleteThroughUnchecked(state);
}

/**
 * Apply one fully prepared observed-transaction result to a detached aggregate
 * publication. The caller must CAS the complete base descriptor before
 * publishing the returned state.
 *
 * Receipt/trace/probe I/O is intentionally absent from this function. It
 * performs only deterministic reconciliation and projection so it is safe to
 * call before the short live publication boundary.
 */
export function projectObservedProtocolPublication(input: {
  readonly base: LiveDiscoveryPublicationState;
  readonly projection: ProtocolDiscoveryProjection;
  readonly result: ProtocolDiscoveryResult;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly processedTxRetentionBlocks?: number;
}): LiveDiscoveryPublicationState {
  assertLiveDiscoveryPublicationState(input.base);
  if (
    input.projection.baseOwnershipVersion !==
      input.base.protocolOwnership.version
  ) {
    throw new Error(
      `stale observed protocol projection base=` +
        `${input.projection.baseOwnershipVersion} current=` +
        input.base.protocolOwnership.version,
    );
  }
  if (!Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0) {
    throw new Error(
      `invalid observed protocol block ${input.blockNumber}`,
    );
  }
  const txHash = input.txHash.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
    throw new Error("observed protocol tx hash must be 32 bytes");
  }
  const retention = input.processedTxRetentionBlocks ?? 100;
  if (!Number.isSafeInteger(retention) || retention < 1) {
    throw new Error(
      `invalid observed protocol tx retention ${retention}`,
    );
  }

  const nextCache = cloneProtocolDiscoveryEvidenceCache(
    input.base.protocolEvidenceCache,
  );
  pruneRecentProcessedProtocolTxs(
    nextCache,
    input.blockNumber,
    retention,
  );
  reconcileProtocolDiscoveryEvidenceCache(nextCache, input.result);
  recordProtocolRouteOwnership(nextCache, input.projection.ownership);
  pruneProtocolDiscoveryAddressCache(nextCache, {
    currentBlock: input.blockNumber,
  });
  if (input.result.evaluationComplete) {
    nextCache.runtime.recentProcessedTxs.set(
      txHash,
      input.blockNumber,
    );
  }

  return cloneLiveDiscoveryPublicationState({
    revision: input.base.revision + 1,
    strategyViews: input.projection.strategyViews,
    backrunGraph: input.projection.backrunGraph,
    ...(input.projection.blockscanGraph === undefined
      ? {}
      : { blockscanGraph: input.projection.blockscanGraph }),
    tokenIndex: input.projection.tokenIndex,
    poolAddressMap: input.projection.poolAddressMap,
    flashTokens: input.projection.flashTokens,
    knownPoolKeys: input.projection.knownPoolKeys,
    knownPoolAddresses: input.projection.knownPoolAddresses,
    protocolOwnership: input.projection.ownership,
    protocolEvidenceCache: nextCache,
    retryableDexGraphPools: input.base.retryableDexGraphPools,
    retryableDexIdentityPools:
      input.base.retryableDexIdentityPools,
    dexGraphCoverage: input.base.dexGraphCoverage,
    dexSourceAnchor: input.base.dexSourceAnchor,
    dexGraphAnchor: input.base.dexGraphAnchor,
    landedCoverage: input.base.landedCoverage,
    protocolFamilySourceCoverage:
      input.base.protocolFamilySourceCoverage,
    protocolObservedCursor: input.base.protocolObservedCursor,
  });
}

export function assertLiveDiscoveryPublicationState(
  state: LiveDiscoveryPublicationState,
): void {
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new Error(
      `invalid live discovery publication revision ${state.revision}`,
    );
  }
  assertArray(state.strategyViews.backrun, "strategyViews.backrun");
  assertArray(state.strategyViews.blockscan, "strategyViews.blockscan");
  assertArray(state.backrunGraph, "backrunGraph");
  if (state.blockscanGraph !== undefined) {
    assertArray(state.blockscanGraph, "blockscanGraph");
  }
  assertStringSetMap(state.tokenIndex, "tokenIndex");
  assertStringMap(state.poolAddressMap, "poolAddressMap");
  assertArray(state.flashTokens, "flashTokens");
  assertStringSet(state.knownPoolKeys, "knownPoolKeys");
  assertStringSet(state.knownPoolAddresses, "knownPoolAddresses");
  assertPoolMap(state.retryableDexGraphPools, "retryableDexGraphPools");
  assertPoolMap(
    state.retryableDexIdentityPools,
    "retryableDexIdentityPools",
  );

  const { sourceCompleteThrough, graphCompleteThrough } =
    state.dexGraphCoverage;
  assertCursor(sourceCompleteThrough, "DEX source coverage");
  assertCursor(graphCompleteThrough, "DEX graph coverage");
  if (graphCompleteThrough > sourceCompleteThrough) {
    throw new Error(
      `DEX graph coverage ${graphCompleteThrough} exceeds source coverage ` +
        sourceCompleteThrough,
    );
  }
  assertCoverageAnchor(state.dexSourceAnchor, "DEX source anchor");
  assertCoverageAnchor(state.dexGraphAnchor, "DEX graph anchor");
  if (state.dexSourceAnchor.completeThroughBlock !== sourceCompleteThrough) {
    throw new Error(
      "DEX source anchor does not match sourceCompleteThrough",
    );
  }
  if (state.dexGraphAnchor.completeThroughBlock !== graphCompleteThrough) {
    throw new Error(
      "DEX graph anchor does not match graphCompleteThrough",
    );
  }

  if (!Array.isArray(state.landedCoverage)) {
    throw new Error("landedCoverage must be an array");
  }
  if (!(state.protocolFamilySourceCoverage instanceof Map)) {
    throw new Error("protocolFamilySourceCoverage must be a Map");
  }
  for (const [key, anchor] of state.protocolFamilySourceCoverage) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error(
        "protocolFamilySourceCoverage contains an empty/non-string key",
      );
    }
    assertCoverageAnchor(
      anchor,
      `protocol family/source anchor ${key}`,
    );
  }
  assertCoverageAnchor(
    state.protocolObservedCursor,
    "protocol observed cursor",
  );

  const cachedCursor =
    state.protocolEvidenceCache.runtime.observedCursor ?? -1;
  const cachedHash =
    state.protocolEvidenceCache.runtime.observedCursorHash;
  if (
    cachedCursor !== state.protocolObservedCursor.completeThroughBlock ||
    cachedHash !== state.protocolObservedCursor.completeThroughHash
  ) {
    throw new Error(
      "protocol observed cursor does not match evidence-cache runtime anchor",
    );
  }
  if (
    state.protocolOwnership.version !==
      state.protocolEvidenceCache.routeOwnership.version
  ) {
    throw new Error(
      "protocol ownership version does not match evidence-cache ownership",
    );
  }
}

function coveragePayload(state: LiveDiscoveryPublicationState): object {
  return {
    dexGraphCoverage: state.dexGraphCoverage,
    dexSourceAnchor: state.dexSourceAnchor,
    dexGraphAnchor: state.dexGraphAnchor,
    landedCoverage: state.landedCoverage,
    protocolFamilySourceCoverage: state.protocolFamilySourceCoverage,
    protocolObservedCursor: state.protocolObservedCursor,
  };
}

function deriveLiveDiscoveryGraphCompleteThroughUnchecked(
  state: LiveDiscoveryPublicationState,
): number {
  let completeThrough = state.dexGraphCoverage.graphCompleteThrough;
  for (const anchor of state.protocolFamilySourceCoverage.values()) {
    completeThrough = Math.min(
      completeThrough,
      anchor.completeThroughBlock,
    );
  }
  return completeThrough;
}

function assertCoverageAnchor(
  anchor: DiscoveryCoverageAnchor,
  label: string,
): void {
  assertCursor(anchor.completeThroughBlock, `${label} block`);
  if (anchor.completeThroughBlock === -1) {
    if (anchor.completeThroughHash !== null) {
      throw new Error(`${label} hash must be null at cursor -1`);
    }
    return;
  }
  if (
    typeof anchor.completeThroughHash !== "string" ||
    !BLOCK_HASH_RE.test(anchor.completeThroughHash)
  ) {
    throw new Error(`${label} requires a lowercase canonical block hash`);
  }
}

function assertCursor(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < -1) {
    throw new Error(`invalid ${label} ${value}`);
  }
}

function assertArray(
  value: readonly unknown[],
  label: string,
): void {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
}

function assertStringSet(
  value: ReadonlySet<string>,
  label: string,
): void {
  if (!(value instanceof Set)) throw new Error(`${label} must be a Set`);
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`${label} contains a non-string value`);
    }
  }
}

function assertStringSetMap(
  value: ReadonlyMap<string, ReadonlySet<string>>,
  label: string,
): void {
  if (!(value instanceof Map)) throw new Error(`${label} must be a Map`);
  for (const [key, peers] of value) {
    if (typeof key !== "string") {
      throw new Error(`${label} contains a non-string key`);
    }
    assertStringSet(peers, `${label}[${key}]`);
  }
}

function assertStringMap(
  value: ReadonlyMap<string, string>,
  label: string,
): void {
  if (!(value instanceof Map)) throw new Error(`${label} must be a Map`);
  for (const [key, item] of value) {
    if (typeof key !== "string" || typeof item !== "string") {
      throw new Error(`${label} must contain only string pairs`);
    }
  }
}

function assertPoolMap(
  value: ReadonlyMap<string, PoolEntry>,
  label: string,
): void {
  if (!(value instanceof Map)) throw new Error(`${label} must be a Map`);
  for (const [key, pool] of value) {
    if (
      typeof key !== "string" ||
      typeof pool !== "object" ||
      pool === null
    ) {
      throw new Error(`${label} contains an invalid pool entry`);
    }
  }
}

function canonicalSha256(value: unknown): string {
  const encoded = canonicalEncode(value, new Set());
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}

/**
 * JSON cannot represent bigint/Map/Set and silently discards undefined. This
 * encoder is deliberately typed and self-delimiting so those values all enter
 * the fingerprint without depending on insertion order.
 */
function canonicalEncode(
  value: unknown,
  ancestors: Set<object>,
): string {
  if (value === null) return "null;";
  if (value === undefined) return "undefined;";
  switch (typeof value) {
    case "boolean":
      return value ? "bool:1;" : "bool:0;";
    case "string":
      return `string:${JSON.stringify(value)};`;
    case "bigint":
      return `bigint:${value.toString(10)};`;
    case "number":
      if (Number.isNaN(value)) return "number:nan;";
      if (value === Number.POSITIVE_INFINITY) return "number:+inf;";
      if (value === Number.NEGATIVE_INFINITY) return "number:-inf;";
      if (Object.is(value, -0)) return "number:-0;";
      return `number:${value};`;
    case "symbol":
    case "function":
      throw new Error(
        `unsupported value in discovery publication fingerprint: ` +
          typeof value,
      );
    case "object":
      break;
  }

  if (ancestors.has(value)) {
    throw new Error("cyclic discovery publication state is not supported");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index++) {
        entries.push(
          index in value
            ? canonicalEncode(value[index], ancestors)
            : "array-hole;",
        );
      }
      return `array:${value.length}:[${entries.join("")}]`;
    }
    if (value instanceof Map) {
      const entries = [...value].map(([key, item]) => {
        const encodedKey = canonicalEncode(key, ancestors);
        const encodedValue = canonicalEncode(item, ancestors);
        return `${encodedKey}=>${encodedValue}`;
      }).sort();
      return `map:${entries.length}:{${entries.join("")}}`;
    }
    if (value instanceof Set) {
      const entries = [...value]
        .map((item) => canonicalEncode(item, ancestors))
        .sort();
      return `set:${entries.length}:{${entries.join("")}}`;
    }
    if (value instanceof Date) {
      return `date:${value.toISOString()};`;
    }
    if (value instanceof Uint8Array) {
      return `bytes:${Buffer.from(value).toString("hex")};`;
    }
    if (value instanceof RegExp) {
      return `regexp:${JSON.stringify(value.source)}:${value.flags};`;
    }

    const enumerableSymbols = Object.getOwnPropertySymbols(value).filter(
      (key) => Object.prototype.propertyIsEnumerable.call(value, key),
    );
    if (enumerableSymbols.length > 0) {
      throw new Error(
        "symbol-keyed discovery publication state is not supported",
      );
    }
    const prototype = Object.getPrototypeOf(value) as {
      constructor?: { name?: string };
    } | null;
    const constructorName = prototype?.constructor?.name ?? "null";
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort()
      .map((key) =>
        `${JSON.stringify(key)}=>${canonicalEncode(object[key], ancestors)}`
      );
    return (
      `object:${JSON.stringify(constructorName)}:${entries.length}:` +
      `{${entries.join("")}}`
    );
  } finally {
    ancestors.delete(value);
  }
}

function deepClone<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return value;
  }
  if (typeof value === "function") {
    throw new Error("function-valued discovery publication state is unsupported");
  }
  const existing = seen.get(value);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(value)) {
    const result: unknown[] = new Array(value.length);
    seen.set(value, result);
    for (let index = 0; index < value.length; index++) {
      if (index in value) result[index] = deepClone(value[index], seen);
    }
    return result as T;
  }
  if (value instanceof Map) {
    const result = new Map<unknown, unknown>();
    seen.set(value, result);
    for (const [key, item] of value) {
      result.set(deepClone(key, seen), deepClone(item, seen));
    }
    return result as T;
  }
  if (value instanceof Set) {
    const result = new Set<unknown>();
    seen.set(value, result);
    for (const item of value) result.add(deepClone(item, seen));
    return result as T;
  }
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof Uint8Array) {
    return new Uint8Array(value) as T;
  }
  if (value instanceof RegExp) {
    return new RegExp(value.source, value.flags) as T;
  }

  const result = Object.create(
    Object.getPrototypeOf(value),
  ) as Record<PropertyKey, unknown>;
  seen.set(value, result);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if ("value" in descriptor) {
      descriptor.value = deepClone(descriptor.value, seen);
    }
    Object.defineProperty(result, key, descriptor);
  }
  return result as T;
}
