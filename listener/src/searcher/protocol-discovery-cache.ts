import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  mkdir as mkdirAsync,
  rename as renameAsync,
  writeFile as writeFileAsync,
} from "node:fs/promises";
import { dirname } from "node:path";
import { ethers } from "ethers";
import {
  advanceDiscoveryFamilySourceWatermarks,
  createDiscoveryFamilySourceWatermarks,
  discoveryGraphCompleteThrough,
  type DiscoveryFamilySources,
} from "./discovery-source-watermark.js";
import {
  protocolInstanceAddressKey,
  protocolInstanceKey,
} from "./protocol-instance-discovery.js";
import type {
  AttestedProtocolInstance,
  ProtocolCandidate,
} from "./venues/route-leg-adapter.js";

const SCHEMA_VERSION = 5;
const RETAINED_CANDIDATE_SCHEMA_VERSION = 4;
const BIGINT_TAG = "__mev_protocol_bigint__";
const BLOCK_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const CONTIGUOUS_AUTHORITY_PROFILE =
  "protocol-observed-contiguous-from-genesis-v1" as const;

export interface ProtocolObservedContiguousAuthority {
  readonly profile: typeof CONTIGUOUS_AUTHORITY_PROFILE;
  readonly fromBlock: 0;
  readonly completeThroughBlock: number;
  readonly completeThroughHash: string;
}

export interface ProtocolAddressCacheEntry {
  readonly adapterId: string;
  readonly address: string;
  readonly codeHash: string;
  readonly implementationWord: string;
  readonly matcherVersion: string;
  /** Null means the owning family did not opt into cross-block reuse. */
  readonly dependencyPolicyVersion: string | null;
  /** Current-block commitment produced by the family-owned cache contract. */
  readonly dependencyFingerprint: string | null;
  readonly checkedAtBlock: number;
  /** null is a cached semantic negative, not a source/RPC failure. */
  readonly candidate: ProtocolCandidate | null;
}

export interface ProtocolDiscoveryRuntimeState {
  /**
   * Highest completed positive-evidence window endpoint. It may advance after
   * a bounded cold-start scan and therefore is not, by itself, negative
   * completeness authority.
   */
  observedCursor: number | null;
  /** Canonical endpoint anchor; contiguous authority is recorded separately. */
  observedCursorHash: string | null;
  /** Hash of the observed family/topic/selector/matcher registry behind the cursor. */
  observedSourceFingerprint: string | null;
  /** Per-family matcher fingerprints for targeted ownership invalidation. */
  readonly discoverySourceFingerprints: Map<string, string>;
  /** Recently processed observed txs (lowercase txHash -> blockNumber). */
  readonly recentProcessedTxs: Map<string, number>;
  /**
   * Negative/completeness authority is stronger than an observed positive
   * cursor. It exists only when the exact family/source registry has advanced
   * contiguously from genesis through completeThroughBlock. The operational
   * observedCursor may be newer.
   */
  observedContiguousAuthority: ProtocolObservedContiguousAuthority | null;
}

/**
 * Persisted route ownership is a restart-survivable CANDIDATE record, never an
 * admission credential: edges are stripped on save and every loaded instance
 * re-enters the pass as a retained candidate that must pass identity+probe
 * before any edge is projected.
 */
export interface PersistedProtocolRouteOwnership {
  version: number;
  admissions: readonly {
    readonly adapterId: string;
    readonly instance: AttestedProtocolInstance;
  }[];
}

export interface ProtocolDiscoveryEvidenceCache {
  /** Decimal chain id. Persisted evidence is never portable across chains. */
  readonly chainId: string | null;
  readonly addressEntries: Map<string, ProtocolAddressCacheEntry>;
  readonly verifiedCandidates: Map<string, {
    readonly adapterId: string;
    readonly candidate: ProtocolCandidate;
  }>;
  readonly runtime: ProtocolDiscoveryRuntimeState;
  routeOwnership: PersistedProtocolRouteOwnership;
}

/**
 * A schema-4 snapshot predates hash-anchored source completeness. Its positive
 * route records are useful only as nominations for the next current-block
 * identity+probe pass; none of its address cache or cursor state is trusted.
 *
 * Keep this migration marker process-local. Saving always emits schema 5, and
 * a normal schema-5 load must retain its existing fingerprint invalidation
 * semantics.
 */
const retainedCandidateImports = new WeakSet<ProtocolDiscoveryEvidenceCache>();

export function createProtocolDiscoveryEvidenceCache(
  chainId?: bigint | number | string,
): ProtocolDiscoveryEvidenceCache {
  return {
    chainId: chainId === undefined ? null : requireChainId(chainId),
    addressEntries: new Map(),
    verifiedCandidates: new Map(),
    runtime: {
      observedCursor: null,
      observedCursorHash: null,
      observedSourceFingerprint: null,
      discoverySourceFingerprints: new Map(),
      recentProcessedTxs: new Map(),
      observedContiguousAuthority: null,
    },
    routeOwnership: { version: 0, admissions: [] },
  };
}

export function cloneProtocolDiscoveryEvidenceCache(
  source: ProtocolDiscoveryEvidenceCache,
): ProtocolDiscoveryEvidenceCache {
  const clone: ProtocolDiscoveryEvidenceCache = {
    chainId: source.chainId,
    addressEntries: new Map(
      [...source.addressEntries].map(([key, entry]) => [
        key,
        {
          ...entry,
          candidate: entry.candidate ? cloneCandidate(entry.candidate) : null,
        },
      ]),
    ),
    verifiedCandidates: new Map(
      [...source.verifiedCandidates].map(([key, entry]) => [
        key,
        { adapterId: entry.adapterId, candidate: cloneCandidate(entry.candidate) },
      ]),
    ),
    runtime: {
      observedCursor: source.runtime.observedCursor,
      observedCursorHash: source.runtime.observedCursorHash,
      observedSourceFingerprint: source.runtime.observedSourceFingerprint,
      discoverySourceFingerprints: new Map(source.runtime.discoverySourceFingerprints),
      recentProcessedTxs: new Map(source.runtime.recentProcessedTxs),
      observedContiguousAuthority:
        source.runtime.observedContiguousAuthority === null
          ? null
          : { ...source.runtime.observedContiguousAuthority },
    },
    routeOwnership: {
      version: source.routeOwnership.version,
      admissions: source.routeOwnership.admissions.map((entry) => ({
        adapterId: entry.adapterId,
        instance: cloneInstance(entry.instance),
      })),
    },
  };
  if (retainedCandidateImports.has(source)) retainedCandidateImports.add(clone);
  return clone;
}

export function replaceProtocolDiscoveryEvidenceCache(
  target: ProtocolDiscoveryEvidenceCache,
  source: ProtocolDiscoveryEvidenceCache,
): void {
  if (target.chainId !== source.chainId) {
    throw new Error("cannot publish a protocol discovery cache from another chain");
  }
  target.addressEntries.clear();
  for (const [key, entry] of source.addressEntries) {
    target.addressEntries.set(key, {
      ...entry,
      candidate: entry.candidate ? cloneCandidate(entry.candidate) : null,
    });
  }
  target.verifiedCandidates.clear();
  for (const [key, entry] of source.verifiedCandidates) {
    target.verifiedCandidates.set(key, {
      adapterId: entry.adapterId,
      candidate: cloneCandidate(entry.candidate),
    });
  }
  target.runtime.observedCursor = source.runtime.observedCursor;
  target.runtime.observedCursorHash = source.runtime.observedCursorHash;
  target.runtime.observedSourceFingerprint = source.runtime.observedSourceFingerprint;
  target.runtime.discoverySourceFingerprints.clear();
  for (const [key, value] of source.runtime.discoverySourceFingerprints) {
    target.runtime.discoverySourceFingerprints.set(key, value);
  }
  target.runtime.recentProcessedTxs.clear();
  for (const [key, value] of source.runtime.recentProcessedTxs) {
    target.runtime.recentProcessedTxs.set(key, value);
  }
  target.runtime.observedContiguousAuthority =
    source.runtime.observedContiguousAuthority === null
      ? null
      : { ...source.runtime.observedContiguousAuthority };
  target.routeOwnership = {
    version: source.routeOwnership.version,
    admissions: source.routeOwnership.admissions.map((entry) => ({
      adapterId: entry.adapterId,
      instance: cloneInstance(entry.instance),
    })),
  };
  if (retainedCandidateImports.has(source)) retainedCandidateImports.add(target);
  else retainedCandidateImports.delete(target);
}

export function protocolAddressCacheKey(adapterId: string, address: string): string {
  return `${adapterId}|${ethers.getAddress(address).toLowerCase()}`;
}

export function cachedProtocolCandidates(
  cache: ProtocolDiscoveryEvidenceCache,
): ReadonlyMap<string, readonly ProtocolCandidate[]> {
  const result = new Map<string, ProtocolCandidate[]>();
  for (const { adapterId, candidate } of cache.verifiedCandidates.values()) {
    const candidates = result.get(adapterId) ?? [];
    candidates.push(cloneCandidate(candidate));
    result.set(adapterId, candidates);
  }
  for (const candidates of result.values()) {
    candidates.sort((a, b) => a.pool.address.localeCompare(b.pool.address));
  }
  return result;
}

export function recordVerifiedProtocolCandidates(
  cache: ProtocolDiscoveryEvidenceCache,
  admissions: readonly {
    readonly adapterId: string;
    readonly instance: AttestedProtocolInstance;
  }[],
): void {
  for (const admission of admissions) {
    const address = ethers.getAddress(admission.instance.pool.address);
    const pool = { ...admission.instance.pool, address };
    // Instance-aware key: two logical instances at one address persist as two
    // verified candidates instead of overwriting each other.
    cache.verifiedCandidates.set(protocolInstanceKey(admission.adapterId, pool), {
      adapterId: admission.adapterId,
      candidate: {
        pool,
        source: "persisted-verified-evidence",
        ...(admission.instance.selectors[0] === undefined
          ? {}
          : { selector: admission.instance.selectors[0] }),
        evidence: [...admission.instance.evidence],
      },
    });
  }
}

export function reconcileProtocolDiscoveryEvidenceCache(
  cache: ProtocolDiscoveryEvidenceCache,
  result: {
    readonly evaluatedInstanceKeys: ReadonlySet<string>;
    readonly wouldAdmit: readonly {
      readonly adapterId: string;
      readonly instance: AttestedProtocolInstance;
    }[];
  },
): void {
  const admitted = new Set(
    result.wouldAdmit.map((item) => protocolInstanceKey(item.adapterId, item.instance.pool)),
  );
  for (const key of result.evaluatedInstanceKeys) {
    if (admitted.has(key)) continue;
    cache.verifiedCandidates.delete(key);
    // Address evidence is keyed per address; strip any logical-instance suffix.
    const addressKey = protocolInstanceAddressKey(key);
    const addressEntry = cache.addressEntries.get(addressKey);
    // A failed current-state identity/probe invalidates positive evidence so a
    // proxy implementation change is re-matched even when runtime code is stable.
    if (addressEntry?.candidate) cache.addressEntries.delete(addressKey);
  }
  recordVerifiedProtocolCandidates(cache, result.wouldAdmit);
}

export interface ProtocolAddressCachePruneResult {
  readonly before: number;
  readonly after: number;
  readonly expiredNegatives: number;
  readonly capacityEvictions: number;
  readonly protectedOverflow: number;
}

/**
 * Address evidence is a probe optimization, never admission authority. Bound
 * semantic negatives by age and the complete cache by size so a long-running
 * discovery process cannot grow one family×address record forever.
 */
export function pruneProtocolDiscoveryAddressCache(
  cache: ProtocolDiscoveryEvidenceCache,
  input: {
    readonly currentBlock: number;
    readonly maxEntries?: number;
    readonly negativeTtlBlocks?: number;
    readonly sweepIntervalBlocks?: number;
  },
): ProtocolAddressCachePruneResult {
  if (!Number.isSafeInteger(input.currentBlock) || input.currentBlock < 0) {
    throw new Error(`invalid protocol address-cache block ${input.currentBlock}`);
  }
  const maxEntries = input.maxEntries ?? 100_000;
  const negativeTtlBlocks = input.negativeTtlBlocks ?? 7_200;
  const sweepIntervalBlocks = input.sweepIntervalBlocks ?? 256;
  for (const [label, value] of [
    ["max entries", maxEntries],
    ["negative TTL", negativeTtlBlocks],
    ["sweep interval", sweepIntervalBlocks],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`invalid protocol address-cache ${label} ${value}`);
    }
  }

  const before = cache.addressEntries.size;
  let expiredNegatives = 0;
  let capacityEvictions = 0;
  const protectedKeys = new Set(
    cache.routeOwnership.admissions.map((entry) =>
      protocolAddressCacheKey(
        entry.adapterId,
        entry.instance.pool.address,
      )
    ),
  );
  const sweepExpired =
    before > maxEntries ||
    input.currentBlock % sweepIntervalBlocks === 0;
  if (sweepExpired) {
    const oldestAllowed = Math.max(
      0,
      input.currentBlock - negativeTtlBlocks,
    );
    for (const [key, entry] of cache.addressEntries) {
      if (
        !protectedKeys.has(key) &&
        entry.candidate === null &&
        entry.checkedAtBlock < oldestAllowed
      ) {
        cache.addressEntries.delete(key);
        expiredNegatives++;
      }
    }
  }

  const protectedOverflow = Math.max(
    0,
    protectedKeys.size - maxEntries,
  );
  const targetSize = Math.max(maxEntries, protectedKeys.size);
  if (cache.addressEntries.size > targetSize) {
    const evictionOrder = [...cache.addressEntries.entries()]
      .filter(([key]) => !protectedKeys.has(key))
      .sort(
      ([keyA, a], [keyB, b]) =>
        Number(a.candidate !== null) - Number(b.candidate !== null) ||
        a.checkedAtBlock - b.checkedAtBlock ||
        keyA.localeCompare(keyB),
      );
    for (const [key] of evictionOrder) {
      if (cache.addressEntries.size <= targetSize) break;
      if (cache.addressEntries.delete(key)) capacityEvictions++;
    }
  }

  return Object.freeze({
    before,
    after: cache.addressEntries.size,
    expiredNegatives,
    capacityEvictions,
    protectedOverflow,
  });
}

export function loadProtocolDiscoveryEvidenceCache(
  path: string,
  expectedChainId: bigint | number | string,
): ProtocolDiscoveryEvidenceCache {
  const chainId = requireChainId(expectedChainId);
  const empty = (): ProtocolDiscoveryEvidenceCache => createProtocolDiscoveryEvidenceCache(chainId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"), bigintReviver);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code !== "ENOENT") {
      console.warn(
        `[protocol-discovery-cache] ignored unreadable cache ${path}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return empty();
  }
  if (!parsed || typeof parsed !== "object") return empty();
  const snapshot = parsed as {
    schema_version?: unknown;
    chain_id?: unknown;
    address_entries?: unknown;
    verified_candidates?: unknown;
    observed_cursor?: unknown;
    observed_cursor_hash?: unknown;
    observed_source_fingerprint?: unknown;
    discovery_source_fingerprints?: unknown;
    recent_processed_txs?: unknown;
    route_ownership?: unknown;
    observed_contiguous_authority?: unknown;
  };
  const retainedCandidateImport =
    snapshot.schema_version === RETAINED_CANDIDATE_SCHEMA_VERSION;
  if (
    snapshot.schema_version !== SCHEMA_VERSION &&
    !retainedCandidateImport
  ) {
    console.warn(`[protocol-discovery-cache] ignored unsupported schema in ${path}`);
    return empty();
  }
  const snapshotChainId = normalizeChainId(snapshot.chain_id);
  if (snapshotChainId !== chainId) {
    console.warn(
      `[protocol-discovery-cache] ignored chain-mismatched cache ${path}: ` +
        `expected=${chainId} actual=${snapshotChainId ?? "missing"}`,
    );
    return empty();
  }
  const cache = createProtocolDiscoveryEvidenceCache(chainId);
  if (retainedCandidateImport) {
    const verifiedCandidates = normalizeRetainedCandidateImport(
      snapshot.verified_candidates,
    );
    const routeOwnership = normalizeRetainedRouteOwnership(
      snapshot.route_ownership,
    );
    if (!verifiedCandidates || !routeOwnership) {
      console.warn(
        `[protocol-discovery-cache] ignored malformed schema-4 retained candidates in ${path}`,
      );
      return empty();
    }
    for (const [key, entry] of verifiedCandidates) {
      cache.verifiedCandidates.set(key, entry);
    }
    cache.routeOwnership = routeOwnership;
    retainedCandidateImports.add(cache);
    console.warn(
      `[protocol-discovery-cache] imported schema-4 route records as ` +
        `untrusted retained candidates; current-block re-attestation required`,
    );
    return cache;
  }
  if (Array.isArray(snapshot.address_entries)) {
    for (const raw of snapshot.address_entries) {
      const entry = normalizeAddressEntry(raw);
      if (!entry) continue;
      cache.addressEntries.set(protocolAddressCacheKey(entry.adapterId, entry.address), entry);
    }
  }
  if (Array.isArray(snapshot.verified_candidates)) {
    for (const raw of snapshot.verified_candidates) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as { adapterId?: unknown; candidate?: unknown };
      if (typeof item.adapterId !== "string") continue;
      const candidate = normalizeCandidate(item.candidate);
      if (!candidate) continue;
      cache.verifiedCandidates.set(
        protocolInstanceKey(item.adapterId, candidate.pool),
        { adapterId: item.adapterId, candidate },
      );
    }
  }
  if (
    Number.isSafeInteger(snapshot.observed_cursor) &&
    Number(snapshot.observed_cursor) >= 0 &&
    typeof snapshot.observed_cursor_hash === "string" &&
    BLOCK_HASH_RE.test(snapshot.observed_cursor_hash)
  ) {
    cache.runtime.observedCursor = Number(snapshot.observed_cursor);
    cache.runtime.observedCursorHash = snapshot.observed_cursor_hash.toLowerCase();
  }
  cache.runtime.observedContiguousAuthority =
    normalizeObservedContiguousAuthority(
      snapshot.observed_contiguous_authority,
      cache.runtime.observedCursor,
      cache.runtime.observedCursorHash,
    );
  if (
    typeof snapshot.observed_source_fingerprint === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(snapshot.observed_source_fingerprint)
  ) {
    cache.runtime.observedSourceFingerprint = snapshot.observed_source_fingerprint.toLowerCase();
  }
  if (Array.isArray(snapshot.discovery_source_fingerprints)) {
    for (const raw of snapshot.discovery_source_fingerprints) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as { adapterId?: unknown; fingerprint?: unknown };
      if (
        typeof item.adapterId !== "string" || item.adapterId.length === 0 ||
        typeof item.fingerprint !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(item.fingerprint)
      ) continue;
      cache.runtime.discoverySourceFingerprints.set(
        item.adapterId,
        item.fingerprint.toLowerCase(),
      );
    }
  }
  if (Array.isArray(snapshot.recent_processed_txs)) {
    for (const raw of snapshot.recent_processed_txs) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as { txHash?: unknown; blockNumber?: unknown };
      if (
        typeof item.txHash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(item.txHash) ||
        !Number.isSafeInteger(item.blockNumber) ||
        Number(item.blockNumber) < 0
      ) continue;
      cache.runtime.recentProcessedTxs.set(item.txHash.toLowerCase(), Number(item.blockNumber));
    }
  }
  cache.routeOwnership = normalizeRouteOwnership(snapshot.route_ownership);
  return cache;
}

export function saveProtocolDiscoveryEvidenceCache(
  path: string,
  cache: ProtocolDiscoveryEvidenceCache,
): void {
  console.log(
    `[searcher/live] protocol cache save: ` +
      `cursor=${cache.runtime.observedCursor} ` +
      `authority=${cache.runtime.observedContiguousAuthority
        ?.completeThroughBlock ?? null}`,
  );
  const serialized = serializeProtocolDiscoveryEvidenceCache(cache);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, serialized, { mode: 0o600 });
  renameSync(temporary, path);
}

export async function saveProtocolDiscoveryEvidenceCacheAsync(
  path: string,
  cache: ProtocolDiscoveryEvidenceCache,
): Promise<void> {
  const serialized = serializeProtocolDiscoveryEvidenceCache(cache);
  await mkdirAsync(dirname(path), { recursive: true });
  const temporary =
    `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFileAsync(temporary, serialized, { mode: 0o600 });
  await renameAsync(temporary, path);
}

function serializeProtocolDiscoveryEvidenceCache(
  cache: ProtocolDiscoveryEvidenceCache,
): string {
  if (!cache.chainId) throw new Error("protocol discovery cache requires a chain id before save");
  if (
    (cache.runtime.observedCursor === null) !==
      (cache.runtime.observedCursorHash === null) ||
    (
      cache.runtime.observedCursor !== null &&
      !protocolObservedCursorAnchorMatches(
        cache,
        cache.runtime.observedCursor,
        cache.runtime.observedCursorHash!,
      )
    )
  ) {
    throw new Error("protocol discovery cache refuses an unanchored observed cursor");
  }
  if (
    cache.runtime.observedContiguousAuthority !== null &&
    normalizeObservedContiguousAuthority(
      cache.runtime.observedContiguousAuthority,
      cache.runtime.observedCursor,
      cache.runtime.observedCursorHash,
    ) === null
  ) {
    throw new Error(
      "protocol discovery cache refuses malformed contiguous authority",
    );
  }
  const snapshot = {
    schema_version: SCHEMA_VERSION,
    chain_id: cache.chainId,
    generated_at: new Date().toISOString(),
    address_entries: [...cache.addressEntries.values()]
      .sort((a, b) => protocolAddressCacheKey(a.adapterId, a.address)
        .localeCompare(protocolAddressCacheKey(b.adapterId, b.address)))
      .map((entry) => ({ ...entry, candidate: entry.candidate && cloneCandidate(entry.candidate) })),
    verified_candidates: [...cache.verifiedCandidates.values()]
      .sort((a, b) => protocolInstanceKey(a.adapterId, a.candidate.pool)
        .localeCompare(protocolInstanceKey(b.adapterId, b.candidate.pool)))
      .map((entry) => ({ adapterId: entry.adapterId, candidate: cloneCandidate(entry.candidate) })),
    observed_cursor: cache.runtime.observedCursor,
    observed_cursor_hash: cache.runtime.observedCursorHash,
    observed_source_fingerprint: cache.runtime.observedSourceFingerprint,
    discovery_source_fingerprints: [...cache.runtime.discoverySourceFingerprints]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([adapterId, fingerprint]) => ({ adapterId, fingerprint })),
    recent_processed_txs: [...cache.runtime.recentProcessedTxs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([txHash, blockNumber]) => ({ txHash, blockNumber })),
    observed_contiguous_authority:
      cache.runtime.observedContiguousAuthority === null
        ? null
        : { ...cache.runtime.observedContiguousAuthority },
    route_ownership: {
      version: cache.routeOwnership.version,
      admissions: [...cache.routeOwnership.admissions]
        .sort((a, b) => protocolAddressCacheKey(a.adapterId, a.instance.pool.address)
          .localeCompare(protocolAddressCacheKey(b.adapterId, b.instance.pool.address)))
        .map((entry) => ({ adapterId: entry.adapterId, instance: cloneInstance(entry.instance) })),
    },
  };
  return `${JSON.stringify(snapshot, bigintReplacer, 2)}\n`;
}

function normalizeRetainedCandidateImport(
  value: unknown,
): Map<string, {
  readonly adapterId: string;
  readonly candidate: ProtocolCandidate;
}> | null {
  if (!Array.isArray(value)) return null;
  const candidates = new Map<string, {
    readonly adapterId: string;
    readonly candidate: ProtocolCandidate;
  }>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as { adapterId?: unknown; candidate?: unknown };
    if (typeof item.adapterId !== "string" || item.adapterId.length === 0) {
      return null;
    }
    const candidate = normalizeCandidate(item.candidate);
    if (!candidate) return null;
    const key = protocolInstanceKey(item.adapterId, candidate.pool);
    if (candidates.has(key)) return null;
    candidates.set(key, { adapterId: item.adapterId, candidate });
  }
  return candidates;
}

function normalizeObservedContiguousAuthority(
  value: unknown,
  cursor: number | null,
  cursorHash: string | null,
): ProtocolObservedContiguousAuthority | null {
  if (!value || typeof value !== "object") return null;
  const item = value as {
    profile?: unknown;
    fromBlock?: unknown;
    completeThroughBlock?: unknown;
    completeThroughHash?: unknown;
  };
  if (
    item.profile !== CONTIGUOUS_AUTHORITY_PROFILE ||
    item.fromBlock !== 0 ||
    !Number.isSafeInteger(item.completeThroughBlock) ||
    Number(item.completeThroughBlock) < 0 ||
    typeof item.completeThroughHash !== "string" ||
    !BLOCK_HASH_RE.test(item.completeThroughHash) ||
    cursor === null ||
    cursorHash === null ||
    Number(item.completeThroughBlock) > cursor ||
    (
      Number(item.completeThroughBlock) === cursor &&
      cursorHash !== item.completeThroughHash.toLowerCase()
    )
  ) {
    return null;
  }
  return {
    profile: CONTIGUOUS_AUTHORITY_PROFILE,
    fromBlock: 0,
    completeThroughBlock: Number(item.completeThroughBlock),
    completeThroughHash: item.completeThroughHash.toLowerCase(),
  };
}

function normalizeRetainedRouteOwnership(
  value: unknown,
): PersistedProtocolRouteOwnership | null {
  if (!value || typeof value !== "object") return null;
  const item = value as { version?: unknown; admissions?: unknown };
  if (
    !Number.isSafeInteger(item.version) ||
    Number(item.version) < 0 ||
    !Array.isArray(item.admissions)
  ) return null;
  const admissions: PersistedProtocolRouteOwnership["admissions"][number][] = [];
  const keys = new Set<string>();
  for (const raw of item.admissions) {
    if (!raw || typeof raw !== "object") return null;
    const entry = raw as { adapterId?: unknown; instance?: unknown };
    if (typeof entry.adapterId !== "string" || entry.adapterId.length === 0) {
      return null;
    }
    const instance = normalizeInstance(entry.instance);
    if (!instance) return null;
    const key = protocolInstanceKey(entry.adapterId, instance.pool);
    if (keys.has(key)) return null;
    keys.add(key);
    admissions.push({ adapterId: entry.adapterId, instance });
  }
  return { version: Number(item.version), admissions };
}

function normalizeAddressEntry(value: unknown): ProtocolAddressCacheEntry | null {
  if (!value || typeof value !== "object") return null;
  const item = value as {
    adapterId?: unknown;
    address?: unknown;
    codeHash?: unknown;
    implementationWord?: unknown;
    matcherVersion?: unknown;
    dependencyPolicyVersion?: unknown;
    dependencyFingerprint?: unknown;
    checkedAtBlock?: unknown;
    candidate?: unknown;
  };
  if (
    typeof item.adapterId !== "string" ||
    typeof item.address !== "string" ||
    typeof item.codeHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(item.codeHash) ||
    typeof item.implementationWord !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(item.implementationWord) ||
    typeof item.matcherVersion !== "string" ||
    item.matcherVersion.length === 0 ||
    !Number.isSafeInteger(item.checkedAtBlock) ||
    Number(item.checkedAtBlock) < 0
  ) return null;
  let address: string;
  try {
    address = ethers.getAddress(item.address);
  } catch {
    return null;
  }
  const candidate = item.candidate === null ? null : normalizeCandidate(item.candidate);
  if (item.candidate !== null && !candidate) return null;
  if (candidate && candidate.pool.address.toLowerCase() !== address.toLowerCase()) return null;
  const dependencyPolicyVersion =
    typeof item.dependencyPolicyVersion === "string" &&
      item.dependencyPolicyVersion.length > 0
      ? item.dependencyPolicyVersion
      : null;
  const dependencyFingerprint =
    typeof item.dependencyFingerprint === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(item.dependencyFingerprint)
      ? item.dependencyFingerprint.toLowerCase()
      : null;
  return {
    adapterId: item.adapterId,
    address,
    codeHash: item.codeHash.toLowerCase(),
    implementationWord: item.implementationWord.toLowerCase(),
    matcherVersion: item.matcherVersion,
    dependencyPolicyVersion,
    dependencyFingerprint,
    checkedAtBlock: Number(item.checkedAtBlock),
    candidate,
  };
}

function normalizeCandidate(value: unknown): ProtocolCandidate | null {
  if (!value || typeof value !== "object") return null;
  const item = value as {
    pool?: unknown;
    source?: unknown;
    selector?: unknown;
    evidence?: unknown;
  };
  if (!item.pool || typeof item.pool !== "object" || typeof item.source !== "string") return null;
  const pool = item.pool as Record<string, unknown>;
  if (typeof pool.address !== "string" || typeof pool.adapter !== "string") return null;
  let address: string;
  try {
    address = ethers.getAddress(pool.address);
  } catch {
    return null;
  }
  if (item.selector !== undefined && (
    typeof item.selector !== "string" || !/^0x[0-9a-fA-F]{8}$/.test(item.selector)
  )) return null;
  if (item.evidence !== undefined && !Array.isArray(item.evidence)) return null;
  return {
    pool: { ...pool, address } as ProtocolCandidate["pool"],
    source: item.source,
    ...(typeof item.selector === "string" ? { selector: item.selector.toLowerCase() } : {}),
    evidence: Array.isArray(item.evidence) ? [...item.evidence] : [],
  };
}

function cloneCandidate(candidate: ProtocolCandidate): ProtocolCandidate {
  return {
    pool: { ...candidate.pool },
    source: candidate.source,
    ...(candidate.selector === undefined ? {} : { selector: candidate.selector }),
    evidence: [...(candidate.evidence ?? [])],
  };
}

function cloneInstance(instance: AttestedProtocolInstance): AttestedProtocolInstance {
  return {
    pool: { ...instance.pool },
    sources: [...instance.sources],
    selectors: [...instance.selectors],
    evidence: [...instance.evidence],
    ...(instance.ownerAdapterId === undefined ? {} : { ownerAdapterId: instance.ownerAdapterId }),
  };
}

function normalizeRouteOwnership(value: unknown): PersistedProtocolRouteOwnership {
  const emptyOwnership: PersistedProtocolRouteOwnership = { version: 0, admissions: [] };
  if (!value || typeof value !== "object") return emptyOwnership;
  const item = value as { version?: unknown; admissions?: unknown };
  if (!Number.isSafeInteger(item.version) || Number(item.version) < 0) return emptyOwnership;
  const admissions: PersistedProtocolRouteOwnership["admissions"][number][] = [];
  if (Array.isArray(item.admissions)) {
    for (const raw of item.admissions) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as { adapterId?: unknown; instance?: unknown };
      if (typeof entry.adapterId !== "string") continue;
      const instance = normalizeInstance(entry.instance);
      if (!instance) continue;
      admissions.push({ adapterId: entry.adapterId, instance });
    }
  }
  return { version: Number(item.version), admissions };
}

function normalizeInstance(value: unknown): AttestedProtocolInstance | null {
  if (!value || typeof value !== "object") return null;
  const item = value as {
    pool?: unknown;
    sources?: unknown;
    selectors?: unknown;
    evidence?: unknown;
    ownerAdapterId?: unknown;
  };
  if (!item.pool || typeof item.pool !== "object") return null;
  const pool = item.pool as Record<string, unknown>;
  if (typeof pool.address !== "string" || typeof pool.adapter !== "string") return null;
  let address: string;
  try {
    address = ethers.getAddress(pool.address);
  } catch {
    return null;
  }
  const sources = Array.isArray(item.sources)
    ? item.sources.filter((source): source is string => typeof source === "string")
    : [];
  const selectors = Array.isArray(item.selectors)
    ? item.selectors.filter((selector): selector is string =>
      typeof selector === "string" && /^0x[0-9a-fA-F]{8}$/.test(selector))
    : [];
  return {
    pool: { ...pool, address } as AttestedProtocolInstance["pool"],
    sources,
    selectors: selectors.map((selector) => selector.toLowerCase()),
    evidence: Array.isArray(item.evidence) ? [...item.evidence] : [],
    ...(typeof item.ownerAdapterId === "string" ? { ownerAdapterId: item.ownerAdapterId } : {}),
  };
}

/**
 * Snapshot in-memory route ownership into the persisted cache. Edges never
 * persist: a reloaded instance is only a retained candidate for re-attestation.
 */
export function recordProtocolRouteOwnership(
  cache: ProtocolDiscoveryEvidenceCache,
  ownership: {
    readonly version: number;
    readonly admissions: ReadonlyMap<string, {
      readonly adapterId: string;
      readonly instance: AttestedProtocolInstance;
    }>;
  },
): void {
  cache.routeOwnership = {
    version: ownership.version,
    admissions: [...ownership.admissions.values()].map((item) => ({
      adapterId: item.adapterId,
      instance: cloneInstance(item.instance),
    })),
  };
}

export function pruneRecentProcessedProtocolTxs(
  cache: ProtocolDiscoveryEvidenceCache,
  currentBlock: number,
  maxAgeBlocks: number,
): void {
  for (const [txHash, block] of cache.runtime.recentProcessedTxs) {
    if (currentBlock - block >= maxAgeBlocks) cache.runtime.recentProcessedTxs.delete(txHash);
  }
}

/**
 * Reconcile the registry behind the shared observed cursor. Matcher evidence
 * is meaningful only for the exact family fingerprint that produced it, so a
 * An observed matcher/event-surface change rewinds the shared cursor.
 * Address-only matcher changes invalidate only their family evidence and leave
 * the independent observed-history cursor intact. Ownership is invalidated
 * only for families that were added, removed or changed.
 */
export function updateProtocolObservedSourceFingerprint(
  cache: ProtocolDiscoveryEvidenceCache,
  fingerprint: string,
  sourceFingerprints?: ReadonlyMap<string, string>,
): boolean {
  if (!/^0x[0-9a-fA-F]{64}$/.test(fingerprint)) {
    throw new Error("protocol observed-source fingerprint must be 32 bytes");
  }
  const normalized = fingerprint.toLowerCase();
  const normalizedSources = sourceFingerprints === undefined
    ? null
    : new Map([...sourceFingerprints].map(([adapterId, value]) => {
      if (!adapterId || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("protocol discovery family fingerprint must be 32 bytes");
      }
      return [adapterId, value.toLowerCase()] as const;
    }));
  if (retainedCandidateImports.has(cache) && normalizedSources !== null) {
    // Schema 4 had no hash-anchored registry/cursor authority. Bind the empty
    // runtime state to the current registry, retain only families that still
    // exist, and let the ordinary startup pass re-attest every nomination.
    // Nothing here creates an edge or an address-cache hit.
    cache.runtime.observedSourceFingerprint = normalized;
    cache.runtime.discoverySourceFingerprints.clear();
    for (const [adapterId, value] of normalizedSources) {
      cache.runtime.discoverySourceFingerprints.set(adapterId, value);
    }
    setProtocolObservedCursor(cache, null, null);
    cache.runtime.recentProcessedTxs.clear();
    for (const [key, value] of cache.verifiedCandidates) {
      if (!normalizedSources.has(value.adapterId)) {
        cache.verifiedCandidates.delete(key);
      }
    }
    cache.routeOwnership = {
      version: cache.routeOwnership.version,
      admissions: cache.routeOwnership.admissions.filter(
        ({ adapterId }) => normalizedSources.has(adapterId),
      ),
    };
    retainedCandidateImports.delete(cache);
    return true;
  }
  const observedSourceChanged =
    cache.runtime.observedSourceFingerprint !== normalized;
  const sourcesUnchanged = normalizedSources === null || mapsEqual(
    cache.runtime.discoverySourceFingerprints,
    normalizedSources,
  );
  if (!observedSourceChanged && sourcesUnchanged) return false;

  const changedAdapters = new Set<string>();
  if (normalizedSources === null) {
    for (const { adapterId } of cache.verifiedCandidates.values()) changedAdapters.add(adapterId);
    for (const { adapterId } of cache.routeOwnership.admissions) changedAdapters.add(adapterId);
  } else {
    for (const adapterId of new Set([
      ...cache.runtime.discoverySourceFingerprints.keys(),
      ...normalizedSources.keys(),
    ])) {
      if (
        cache.runtime.discoverySourceFingerprints.get(adapterId) !== normalizedSources.get(adapterId)
      ) changedAdapters.add(adapterId);
    }
  }
  cache.runtime.observedSourceFingerprint = normalized;
  if (observedSourceChanged) {
    setProtocolObservedCursor(cache, null, null);
    cache.runtime.recentProcessedTxs.clear();
  }
  for (const [key, value] of cache.verifiedCandidates) {
    if (changedAdapters.has(value.adapterId)) cache.verifiedCandidates.delete(key);
  }
  cache.routeOwnership = {
    version: cache.routeOwnership.version,
    admissions: cache.routeOwnership.admissions.filter(
      ({ adapterId }) => !changedAdapters.has(adapterId),
    ),
  };
  if (normalizedSources !== null) {
    cache.runtime.discoverySourceFingerprints.clear();
    for (const [adapterId, value] of normalizedSources) {
      cache.runtime.discoverySourceFingerprints.set(adapterId, value);
    }
  }
  return observedSourceChanged;
}

/**
 * Publish or clear the restart-survivable observed scan cursor. The pair says
 * where incremental ingestion resumes; negative/completeness authority is the
 * independent, possibly older observedContiguousAuthority watermark.
 */
export function setProtocolObservedCursor(
  cache: ProtocolDiscoveryEvidenceCache,
  blockNumber: number | null,
  blockHash: string | null,
): void {
  if (blockNumber === null || blockHash === null) {
    if (blockNumber !== null || blockHash !== null) {
      throw new Error("protocol observed cursor number/hash must be set or cleared together");
    }
    cache.runtime.observedCursor = null;
    cache.runtime.observedCursorHash = null;
    cache.runtime.observedContiguousAuthority = null;
    return;
  }
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error(`invalid protocol observed cursor ${blockNumber}`);
  }
  if (!BLOCK_HASH_RE.test(blockHash)) {
    throw new Error("protocol observed cursor hash must be 32 bytes");
  }
  const normalizedHash = blockHash.toLowerCase();
  const authority = cache.runtime.observedContiguousAuthority;
  const preservesAuthority =
    authority !== null &&
    (
      authority.completeThroughBlock < blockNumber ||
      (
        authority.completeThroughBlock === blockNumber &&
        authority.completeThroughHash === normalizedHash
      )
    );
  cache.runtime.observedCursor = blockNumber;
  cache.runtime.observedCursorHash = normalizedHash;
  if (!preservesAuthority) {
    cache.runtime.observedContiguousAuthority = null;
  }
}

/**
 * Advance the stronger negative/completeness watermark through one verified
 * family-source pass. A bounded positive scan may still move observedCursor,
 * but it cannot create this authority unless every contiguous source covered
 * block 0 with no gap.
 */
export function advanceProtocolObservedContiguousAuthority(input: {
  readonly cache: ProtocolDiscoveryEvidenceCache;
  readonly families: readonly DiscoveryFamilySources[];
  readonly familySourceCoverage: readonly {
    readonly familyId: string;
    readonly sourceId: string;
    readonly complete: boolean;
  }[];
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly toBlockHash: string;
  readonly contiguousSourceIds: ReadonlySet<string>;
}): ProtocolObservedContiguousAuthority | null {
  if (
    !Number.isSafeInteger(input.fromBlock) ||
    input.fromBlock < 0 ||
    !Number.isSafeInteger(input.toBlock) ||
    input.toBlock < input.fromBlock ||
    !BLOCK_HASH_RE.test(input.toBlockHash)
  ) {
    throw new Error("invalid protocol observed completeness range");
  }
  const watermarks = createDiscoveryFamilySourceWatermarks(input.families);
  const prior = input.cache.runtime.observedContiguousAuthority;
  if (prior !== null) {
    for (const key of watermarks.keys()) {
      watermarks.set(key, prior.completeThroughBlock);
    }
  } else {
    /*
     * No prior authority: a clean scanned window becomes the first authority.
     * Seed each family×source watermark to fromBlock-1 so the contiguous
     * advance over the scanned range succeeds. Without this, positive-only
     * startup (or the first live block) can never advance observed-only
     * families past watermark -1/0 and their source stays incomplete forever.
     */
    for (const key of watermarks.keys()) {
      watermarks.set(key, Math.max(-1, input.fromBlock - 1));
    }
  }
  const expectedCoverageKeys = new Set(
    input.families.flatMap((family) =>
      [...new Set(family.sourceIds)].map(
        (sourceId) => `${family.familyId}\u001f${sourceId}`,
      )
    ),
  );
  const actualCoverageKeys = input.familySourceCoverage.map(
    (coverage) => `${coverage.familyId}\u001f${coverage.sourceId}`,
  );
  if (
    new Set(actualCoverageKeys).size !== actualCoverageKeys.length ||
    actualCoverageKeys.some((key) => !expectedCoverageKeys.has(key)) ||
    expectedCoverageKeys.size !== actualCoverageKeys.length
  ) {
    throw new Error(
      "protocol observed completeness coverage does not match the registry",
    );
  }
  if (input.familySourceCoverage.some((coverage) => !coverage.complete)) {
    return null;
  }
  const familySourceComplete = new Map(
    input.familySourceCoverage.map((coverage) => [
      `${coverage.familyId}\u001f${coverage.sourceId}`,
      coverage.complete,
    ]),
  );
  const familyComplete = new Map(
    input.families.map((family) => [
      family.familyId,
      [...new Set(family.sourceIds)].every(
        (sourceId) =>
          familySourceComplete.get(
            `${family.familyId}\u001f${sourceId}`,
          ) === true,
      ),
    ]),
  );
  const sourceComplete = new Map<string, boolean>();
  for (const sourceId of new Set(input.families.flatMap(
    (family) => [...family.sourceIds],
  ))) {
    sourceComplete.set(
      sourceId,
      input.families
        .filter((family) => family.sourceIds.includes(sourceId))
        .every(
          (family) =>
            familySourceComplete.get(
              `${family.familyId}\u001f${sourceId}`,
            ) === true,
        ),
    );
  }
  const advanced = advanceDiscoveryFamilySourceWatermarks({
    current: watermarks,
    families: input.families,
    range: {
      fromBlock: input.fromBlock,
      toBlock: input.toBlock,
    },
    familyComplete,
    familySourceComplete,
    sourceComplete,
    sourceIssues: [],
    contiguousSourceIds: input.contiguousSourceIds,
  });
  const completeThrough = discoveryGraphCompleteThrough(
    input.families,
    advanced.watermarks,
  );
  if (
    input.cache.runtime.observedCursor === null ||
    input.cache.runtime.observedCursor < input.toBlock
  ) {
    setProtocolObservedCursor(
      input.cache,
      input.toBlock,
      input.toBlockHash,
    );
  }
  if (completeThrough !== input.toBlock) {
    console.log(
      `[searcher/live] protocol observed authority NOT advanced: ` +
        `completeThrough=${completeThrough} toBlock=${input.toBlock} ` +
        `fromBlock=${input.fromBlock} ` +
        `families=${JSON.stringify(input.families)} ` +
        `coverage=${JSON.stringify(input.familySourceCoverage)}`,
    );
    return null;
  }
  const authority: ProtocolObservedContiguousAuthority = {
    profile: CONTIGUOUS_AUTHORITY_PROFILE,
    fromBlock: 0,
    completeThroughBlock: input.toBlock,
    completeThroughHash: input.toBlockHash.toLowerCase(),
  };
  input.cache.runtime.observedContiguousAuthority = authority;
  return authority;
}

export function protocolObservedCursorAnchorMatches(
  cache: ProtocolDiscoveryEvidenceCache,
  blockNumber: number,
  canonicalBlockHash: string,
): boolean {
  return Number.isSafeInteger(blockNumber) &&
    blockNumber >= 0 &&
    BLOCK_HASH_RE.test(canonicalBlockHash) &&
    cache.runtime.observedCursor === blockNumber &&
    cache.runtime.observedCursorHash === canonicalBlockHash.toLowerCase();
}

/**
 * A cursor reorg invalidates observed-source candidates as well as the numeric
 * watermark. Address-domain families are rediscovered from current state;
 * observed-only families remain unavailable until canonical history is
 * backfilled again.
 */
export function invalidateProtocolObservedHistory(
  cache: ProtocolDiscoveryEvidenceCache,
  observedFamilyIds: ReadonlySet<string>,
): void {
  setProtocolObservedCursor(cache, null, null);
  cache.runtime.recentProcessedTxs.clear();
  for (const [key, value] of cache.verifiedCandidates) {
    if (observedFamilyIds.has(value.adapterId)) {
      cache.verifiedCandidates.delete(key);
    }
  }
  cache.routeOwnership = {
    version: cache.routeOwnership.version,
    admissions: cache.routeOwnership.admissions.filter(
      ({ adapterId }) => !observedFamilyIds.has(adapterId),
    ),
  };
}

function mapsEqual(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { [BIGINT_TAG]: value.toString() } : value;
}

function bigintReviver(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const tagged = value as Record<string, unknown>;
  if (
    Object.keys(tagged).length === 1 &&
    typeof tagged[BIGINT_TAG] === "string" &&
    /^-?\d+$/.test(tagged[BIGINT_TAG])
  ) return BigInt(tagged[BIGINT_TAG]);
  return value;
}

function normalizeChainId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    return null;
  }
  try {
    const chainId = BigInt(value);
    return chainId >= 0n ? chainId.toString() : null;
  } catch {
    return null;
  }
}

function requireChainId(value: bigint | number | string): string {
  const chainId = normalizeChainId(value);
  if (chainId === null) throw new Error(`invalid protocol discovery cache chain id: ${String(value)}`);
  return chainId;
}
