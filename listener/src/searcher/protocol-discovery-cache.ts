import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ethers } from "ethers";
import type {
  AttestedProtocolInstance,
  ProtocolCandidate,
} from "./venues/route-leg-adapter.js";

const SCHEMA_VERSION = 4;
const BIGINT_TAG = "__mev_protocol_bigint__";

export interface ProtocolAddressCacheEntry {
  readonly adapterId: string;
  readonly address: string;
  readonly codeHash: string;
  readonly implementationWord: string;
  readonly matcherVersion: string;
  readonly checkedAtBlock: number;
  /** null is a cached semantic negative, not a source/RPC failure. */
  readonly candidate: ProtocolCandidate | null;
}

export interface ProtocolDiscoveryRuntimeState {
  /** Highest block whose protocol event window fully completed. null = never scanned. */
  observedCursor: number | null;
  /** Recently processed observed txs (lowercase txHash -> blockNumber). */
  readonly recentProcessedTxs: Map<string, number>;
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

export function createProtocolDiscoveryEvidenceCache(
  chainId?: bigint | number | string,
): ProtocolDiscoveryEvidenceCache {
  return {
    chainId: chainId === undefined ? null : requireChainId(chainId),
    addressEntries: new Map(),
    verifiedCandidates: new Map(),
    runtime: { observedCursor: null, recentProcessedTxs: new Map() },
    routeOwnership: { version: 0, admissions: [] },
  };
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
    cache.verifiedCandidates.set(protocolAddressCacheKey(admission.adapterId, address), {
      adapterId: admission.adapterId,
      candidate: {
        pool: { ...admission.instance.pool, address },
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
    result.wouldAdmit.map((item) => protocolAddressCacheKey(
      item.adapterId,
      item.instance.pool.address,
    )),
  );
  for (const key of result.evaluatedInstanceKeys) {
    if (admitted.has(key)) continue;
    cache.verifiedCandidates.delete(key);
    const addressEntry = cache.addressEntries.get(key);
    // A failed current-state identity/probe invalidates positive evidence so a
    // proxy implementation change is re-matched even when runtime code is stable.
    if (addressEntry?.candidate) cache.addressEntries.delete(key);
  }
  recordVerifiedProtocolCandidates(cache, result.wouldAdmit);
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
    recent_processed_txs?: unknown;
    route_ownership?: unknown;
  };
  if (snapshot.schema_version !== SCHEMA_VERSION) {
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
        protocolAddressCacheKey(item.adapterId, candidate.pool.address),
        { adapterId: item.adapterId, candidate },
      );
    }
  }
  if (
    Number.isSafeInteger(snapshot.observed_cursor) &&
    Number(snapshot.observed_cursor) >= 0
  ) {
    cache.runtime.observedCursor = Number(snapshot.observed_cursor);
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
  if (!cache.chainId) throw new Error("protocol discovery cache requires a chain id before save");
  const snapshot = {
    schema_version: SCHEMA_VERSION,
    chain_id: cache.chainId,
    generated_at: new Date().toISOString(),
    address_entries: [...cache.addressEntries.values()]
      .sort((a, b) => protocolAddressCacheKey(a.adapterId, a.address)
        .localeCompare(protocolAddressCacheKey(b.adapterId, b.address)))
      .map((entry) => ({ ...entry, candidate: entry.candidate && cloneCandidate(entry.candidate) })),
    verified_candidates: [...cache.verifiedCandidates.values()]
      .sort((a, b) => protocolAddressCacheKey(a.adapterId, a.candidate.pool.address)
        .localeCompare(protocolAddressCacheKey(b.adapterId, b.candidate.pool.address)))
      .map((entry) => ({ adapterId: entry.adapterId, candidate: cloneCandidate(entry.candidate) })),
    observed_cursor: cache.runtime.observedCursor,
    recent_processed_txs: [...cache.runtime.recentProcessedTxs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([txHash, blockNumber]) => ({ txHash, blockNumber })),
    route_ownership: {
      version: cache.routeOwnership.version,
      admissions: [...cache.routeOwnership.admissions]
        .sort((a, b) => protocolAddressCacheKey(a.adapterId, a.instance.pool.address)
          .localeCompare(protocolAddressCacheKey(b.adapterId, b.instance.pool.address)))
        .map((entry) => ({ adapterId: entry.adapterId, instance: cloneInstance(entry.instance) })),
    },
  };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(snapshot, bigintReplacer, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function normalizeAddressEntry(value: unknown): ProtocolAddressCacheEntry | null {
  if (!value || typeof value !== "object") return null;
  const item = value as {
    adapterId?: unknown;
    address?: unknown;
    codeHash?: unknown;
    implementationWord?: unknown;
    matcherVersion?: unknown;
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
  return {
    adapterId: item.adapterId,
    address,
    codeHash: item.codeHash.toLowerCase(),
    implementationWord: item.implementationWord.toLowerCase(),
    matcherVersion: item.matcherVersion,
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
