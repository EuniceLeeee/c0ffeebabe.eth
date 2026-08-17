import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  ProtocolDiscoveryOwnership,
  VerifiedProtocolAdmission,
} from "../protocol-instance-discovery.js";
import { protocolInstanceKey } from "../protocol-instance-discovery.js";
import {
  cachedProtocolCandidates,
  loadProtocolDiscoveryEvidenceCache,
  protocolObservedCursorAnchorMatches,
  type ProtocolDiscoveryEvidenceCache,
} from "../protocol-discovery-cache.js";
import type { ProtocolCandidate } from "../venues/route-leg-adapter.js";
import { STRICT_PROJECTED_FAMILY_TEST_REGISTRY } from "./strict-family-test-compat.js";

const PROTOCOL_DISCOVERY_CACHE_SCHEMA = 5;
const SHA256_RE = /^[0-9a-f]{64}$/;
const BLOCK_HASH_RE = /^0x[0-9a-f]{64}$/;

export interface TrustedHuntProtocolDiscoveryCache {
  readonly cache: ProtocolDiscoveryEvidenceCache;
  readonly ownership: ProtocolDiscoveryOwnership;
  readonly bootstrapCandidates: ReadonlyMap<
    string,
    readonly ProtocolCandidate[]
  >;
  readonly contentSha256: string;
  readonly cursor: number;
  readonly cursorHash: string;
  /**
   * A PATH+SHA cache is caller-supplied retained nomination data. Content
   * addressing cannot attest that its history was scanned contiguously.
   */
  readonly topologyProof: VerifiedRetainedTopologyProof | null;
}

export interface VerifiedRetainedTopologyProof {
  readonly cursor: number;
  readonly cursorHash: string;
  readonly contentSha256: string;
}

const verifiedRetainedTopologyProofs =
  new WeakSet<VerifiedRetainedTopologyProof>();

/**
 * No file-backed loader mints this process-local proof. A future trusted
 * runner may add a receipt-backed producer, but a caller-controlled path,
 * digest, authority field, or environment switch must never do so.
 */
export function isVerifiedRetainedTopologyProof(
  value: unknown,
): value is VerifiedRetainedTopologyProof {
  return typeof value === "object" &&
    value !== null &&
    verifiedRetainedTopologyProofs.has(
      value as VerifiedRetainedTopologyProof,
    );
}

/**
 * Strict trusted-harness loader.
 *
 * The ordinary runtime cache loader intentionally degrades malformed or legacy
 * files to an empty cache. A historical gate cannot do that: silently losing a
 * retained observed-only family produces a false "no instance" result. This
 * wrapper first binds the exact bytes and canonical positive cursor, then lets
 * the ordinary loader revive opaque evidence (including bigint samples).
 * The result is nominations-only: persisted ownership must pass the source-N
 * identity+probe pass again, and persisted contiguous authority is discarded.
 * A caller-supplied digest seals bytes; it does not prove who produced them or
 * that the claimed range was actually scanned.
 */
export async function loadTrustedHuntProtocolDiscoveryCache(input: {
  readonly path: string;
  readonly expectedSha256: string;
  readonly expectedChainId: bigint | number | string;
  readonly maxCursor: number;
  readonly expectedObservedSourceFingerprint: string;
  readonly expectedDiscoverySourceFingerprints: ReadonlyMap<string, string>;
  readonly readCanonicalBlockHash: (
    blockNumber: number,
  ) => Promise<string | null>;
}): Promise<TrustedHuntProtocolDiscoveryCache> {
  const expectedSha256 = input.expectedSha256.toLowerCase();
  if (!SHA256_RE.test(expectedSha256)) {
    throw new Error("hunt protocol discovery cache SHA-256 must be 64 lowercase hex characters");
  }
  if (!Number.isSafeInteger(input.maxCursor) || input.maxCursor < 0) {
    throw new Error("hunt protocol discovery cache max cursor is invalid");
  }
  const bytes = readFileSync(input.path, "utf8");
  const contentSha256 = sha256(bytes);
  if (contentSha256 !== expectedSha256) {
    throw new Error("hunt protocol discovery cache hash mismatch");
  }

  const raw = parseCacheEnvelope(bytes);
  const expectedChainId = normalizeChainId(input.expectedChainId);
  if (normalizeChainId(raw.chain_id) !== expectedChainId) {
    throw new Error("hunt protocol discovery cache chain mismatch");
  }
  const cursor = safeBlock(raw.observed_cursor, "observed_cursor");
  const cursorHash = blockHash(raw.observed_cursor_hash, "observed_cursor_hash");
  if (cursor > input.maxCursor) {
    throw new Error(
      `hunt protocol discovery cache cursor ${cursor} exceeds ${input.maxCursor}`,
    );
  }
  assertRegistryFingerprintBinding({
    raw,
    observed: input.expectedObservedSourceFingerprint,
    sources: input.expectedDiscoverySourceFingerprints,
  });

  const cache = loadProtocolDiscoveryEvidenceCache(
    input.path,
    input.expectedChainId,
  );
  assertLosslessLoad(raw, cache, cursor);
  if (!protocolObservedCursorAnchorMatches(cache, cursor, cursorHash)) {
    throw new Error("hunt protocol discovery cache cursor is unanchored");
  }
  const canonicalHash = await input.readCanonicalBlockHash(cursor);
  if (
    canonicalHash === null ||
    !BLOCK_HASH_RE.test(canonicalHash.toLowerCase()) ||
    canonicalHash.toLowerCase() !== cursorHash
  ) {
    throw new Error("hunt protocol discovery cache cursor is not canonical");
  }
  // The cursor remains useful for incremental positive-evidence ingestion, but
  // its file-backed authority can be self-authored and must not seed either
  // current-process completeness or a subsequently written cache.
  cache.runtime.observedContiguousAuthority = null;

  const admissions = new Map<string, VerifiedProtocolAdmission>();
  for (const admission of cache.routeOwnership.admissions) {
    assertRegisteredDiscoveryOwner(
      cache,
      admission.adapterId,
      admission.instance.pool.adapter,
    );
    if (admission.instance.ownerAdapterId !== admission.adapterId) {
      throw new Error(
        `hunt protocol discovery cache has invalid ownership for ${admission.adapterId}`,
      );
    }
    const key = protocolInstanceKey(
      admission.adapterId,
      admission.instance.pool,
    );
    if (admissions.has(key)) {
      throw new Error(`hunt protocol discovery cache repeats ownership ${key}`);
    }
    admissions.set(key, {
      adapterId: admission.adapterId,
      instance: admission.instance,
      // Persisted ownership deliberately strips executable output. The source-N
      // identity+probe pass is the only operation allowed to regenerate it.
      edges: [],
      claims: [],
    });
  }

  return Object.freeze({
    cache,
    ownership: Object.freeze({
      version: cache.routeOwnership.version,
      admissions,
    }),
    bootstrapCandidates: cachedProtocolCandidates(cache),
    contentSha256,
    cursor,
    cursorHash,
    topologyProof: null,
  });
}

function parseCacheEnvelope(bytes: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error("hunt protocol discovery cache is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("hunt protocol discovery cache must be an object");
  }
  if (parsed.schema_version !== PROTOCOL_DISCOVERY_CACHE_SCHEMA) {
    throw new Error("hunt protocol discovery cache must use schema 5");
  }
  if (!isRecord(parsed.route_ownership)) {
    throw new Error("hunt protocol discovery cache omits route ownership");
  }
  const routeOwnership = parsed.route_ownership;
  if (
    !Number.isSafeInteger(routeOwnership.version) ||
    Number(routeOwnership.version) < 0 ||
    !Array.isArray(routeOwnership.admissions)
  ) {
    throw new Error("hunt protocol discovery cache route ownership is malformed");
  }
  for (const [index, rawAdmission] of routeOwnership.admissions.entries()) {
    assertRawOwnershipAdmission(rawAdmission, index);
  }
  for (const field of [
    "address_entries",
    "verified_candidates",
    "discovery_source_fingerprints",
    "recent_processed_txs",
  ]) {
    if (!Array.isArray(parsed[field])) {
      throw new Error(`hunt protocol discovery cache omits ${field}`);
    }
  }
  return parsed;
}

function assertRawOwnershipAdmission(value: unknown, index: number): void {
  if (!isRecord(value) || typeof value.adapterId !== "string") {
    throw new Error(
      `hunt protocol discovery cache ownership ${index} is malformed`,
    );
  }
  const instance = value.instance;
  if (
    !isRecord(instance) ||
    !isRecord(instance.pool) ||
    typeof instance.pool.address !== "string" ||
    typeof instance.pool.adapter !== "string" ||
    typeof instance.pool.identitySource !== "string" ||
    instance.ownerAdapterId !== value.adapterId ||
    !Array.isArray(instance.sources) ||
    instance.sources.some((source) =>
      typeof source !== "string" || source.length === 0
    ) ||
    !Array.isArray(instance.selectors) ||
    instance.selectors.some((selector) =>
      typeof selector !== "string" || !/^0x[0-9a-fA-F]{8}$/.test(selector)
    ) ||
    !Array.isArray(instance.evidence)
  ) {
    throw new Error(
      `hunt protocol discovery cache ownership ${index} is not lossless`,
    );
  }
}

function assertRegistryFingerprintBinding(input: {
  readonly raw: Record<string, unknown>;
  readonly observed: string;
  readonly sources: ReadonlyMap<string, string>;
}): void {
  const observed = blockHash(
    input.raw.observed_source_fingerprint,
    "observed_source_fingerprint",
  );
  if (observed !== blockHash(input.observed, "expected observed fingerprint")) {
    throw new Error("hunt protocol discovery cache observed registry fingerprint mismatch");
  }
  const rawSources = input.raw.discovery_source_fingerprints;
  if (!Array.isArray(rawSources)) {
    throw new Error("hunt protocol discovery cache omits family registry fingerprints");
  }
  const actual = new Map<string, string>();
  for (const [index, value] of rawSources.entries()) {
    if (!isRecord(value) || typeof value.adapterId !== "string") {
      throw new Error(
        `hunt protocol discovery cache family fingerprint ${index} is malformed`,
      );
    }
    if (actual.has(value.adapterId)) {
      throw new Error(
        `hunt protocol discovery cache repeats family fingerprint ${value.adapterId}`,
      );
    }
    actual.set(
      value.adapterId,
      blockHash(value.fingerprint, `family fingerprint ${value.adapterId}`),
    );
  }
  const expected = new Map(
    [...input.sources].map(([adapterId, fingerprint]) => [
      adapterId,
      blockHash(fingerprint, `expected family fingerprint ${adapterId}`),
    ]),
  );
  if (!mapsEqual(actual, expected)) {
    throw new Error("hunt protocol discovery cache family registry fingerprint mismatch");
  }
}

function assertLosslessLoad(
  raw: Record<string, unknown>,
  cache: ProtocolDiscoveryEvidenceCache,
  cursor: number,
): void {
  const routeOwnership = raw.route_ownership as Record<string, unknown>;
  const rawAdmissions = routeOwnership.admissions as unknown[];
  const rawAddressEntries = raw.address_entries as unknown[];
  const rawCandidates = raw.verified_candidates as unknown[];
  const rawRecentTxs = raw.recent_processed_txs as unknown[];
  if (
    cache.routeOwnership.admissions.length !== rawAdmissions.length ||
    cache.addressEntries.size !== rawAddressEntries.length ||
    cache.verifiedCandidates.size !== rawCandidates.length ||
    cache.runtime.recentProcessedTxs.size !== rawRecentTxs.length
  ) {
    throw new Error("hunt protocol discovery cache could not be loaded losslessly");
  }

  const ownershipKeys = new Set<string>();
  for (const admission of cache.routeOwnership.admissions) {
    const key = protocolInstanceKey(admission.adapterId, admission.instance.pool);
    if (ownershipKeys.has(key)) {
      throw new Error(`hunt protocol discovery cache repeats ownership ${key}`);
    }
    ownershipKeys.add(key);
    assertNoFutureEvidence(admission.instance.evidence, cursor, key);
  }
  const candidateKeys = new Set(cache.verifiedCandidates.keys());
  for (const key of ownershipKeys) {
    if (!candidateKeys.has(key)) {
      throw new Error(
        "hunt protocol discovery cache ownership lacks its verified candidate",
      );
    }
  }
  for (const [key, { adapterId, candidate }] of cache.verifiedCandidates) {
    assertRegisteredDiscoveryOwner(
      cache,
      adapterId,
      candidate.pool.adapter,
    );
    assertNoFutureEvidence(candidate.evidence ?? [], cursor, key);
  }
  for (const entry of cache.addressEntries.values()) {
    assertRegisteredDiscoveryOwner(
      cache,
      entry.adapterId,
      entry.candidate?.pool.adapter,
    );
    if (entry.checkedAtBlock > cursor) {
      throw new Error("hunt protocol discovery cache contains post-cursor address evidence");
    }
    assertNoFutureEvidence(
      entry.candidate?.evidence ?? [],
      cursor,
      `${entry.adapterId}|${entry.address}`,
    );
  }
  for (const block of cache.runtime.recentProcessedTxs.values()) {
    if (block > cursor) {
      throw new Error("hunt protocol discovery cache contains post-cursor transaction evidence");
    }
  }
}

function assertRegisteredDiscoveryOwner(
  cache: ProtocolDiscoveryEvidenceCache,
  adapterId: string,
  poolAdapter?: string,
): void {
  const family = STRICT_PROJECTED_FAMILY_TEST_REGISTRY.routes().list().find(
    (candidate) => candidate.id === adapterId,
  );
  if (
    !family?.discovery ||
    (poolAdapter !== undefined &&
      !family.poolAdapters.some((candidate) => candidate === poolAdapter)) ||
    !cache.runtime.discoverySourceFingerprints.has(adapterId)
  ) {
    throw new Error(
      `hunt protocol discovery cache contains unregistered owner ${adapterId}`,
    );
  }
}

function assertNoFutureEvidence(
  value: unknown,
  cursor: number,
  label: string,
): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoFutureEvidence(item, cursor, label);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (
      key === "blockNumber" &&
      typeof item === "number" &&
      Number.isSafeInteger(item) &&
      item > cursor
    ) {
      throw new Error(
        `hunt protocol discovery cache ${label} contains post-cursor evidence`,
      );
    }
    assertNoFutureEvidence(item, cursor, label);
  }
}

function safeBlock(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`hunt protocol discovery cache ${field} is invalid`);
  }
  return Number(value);
}

function blockHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !BLOCK_HASH_RE.test(value.toLowerCase())) {
    throw new Error(`hunt protocol discovery cache ${field} must be 32 bytes`);
  }
  return value.toLowerCase();
}

function normalizeChainId(value: unknown): string {
  try {
    const chainId = BigInt(value as string | number | bigint);
    if (chainId < 0n) throw new Error();
    return chainId.toString();
  } catch {
    throw new Error("hunt protocol discovery cache chain id is invalid");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mapsEqual(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
