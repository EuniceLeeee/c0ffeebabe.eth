import { createHash } from "node:crypto";
import { ethers } from "ethers";
import {
  assertDurableVerifiedMemoFingerprint,
  canonicalJson,
  durableVerifiedMemoFingerprint,
  type DurableSourceChunkReceipt,
  type DurableSourceReceipt,
  type DurableVerifiedMemo,
  type LegacyDurableVerifiedMemo,
  type ReadyUniverseGeneration,
  type RetryableAttempt,
} from "./universe-rebuild-checkpoint.js";
import type { UniverseRebuildProbeWiring } from "./universe-rebuild-probe-cli.js";
import type { UniverseRebuildDependencies } from "./universe-rebuild-runner.js";
import type { CentralAdapterRuntime } from "./adapter-work-intent.js";
import { buildFamilyRouteGraphView } from "./adapter-family-graph-runtime.js";
import { executeFundingFamilyLiquidity } from "./adapter-funding-runtime.js";
import { reissuePreparedInstanceRouteHandles } from
  "./venues/adapter-family-runtime.js";
import { reissuePreparedInstanceAuthority } from
  "./venues/adapter-family-runtime.js";
import {
  prepareCreditFamilyRoutes,
  projectCreditRouteGraph,
} from "./adapter-credit-runtime.js";
import { attestPoolIdentitiesStrict } from "./strict-identity-attestation.js";
import { createMinimalIdentityRuntime } from "./strict-identity-attestation.js";
import { createStrictCentralAdapterRuntime } from
  "./strict-central-adapter-runtime.js";
import { RevmSimClient } from "./revm-sim-client.js";
import { createRevmStrictSimulationTransport } from
  "./revm-strict-simulation-transport.js";
import { PRODUCTION_STRICT_VERIFIED_ACTORS } from
  "./venues/production-verified-actors.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from
  "./venues/production-family-composition.js";
import { executeCatalogReverseBindings } from
  "./venues/capture-materialization.js";
import type {
  CaptureNominationInput,
  UnifiedObservation,
} from "./venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { FamilyCapabilityIdentitySet } from
  "./venues/family-capability-catalog.js";
import type { FamilyId } from "./venues/adapter-family-identifiers.js";

/**
 * Production wiring for the durable universe rebuild (audit §6/§9). The
 * attestation half reuses the strict identity attestation (catalog +
 * plugin lifecycle with collected publications); memo sealing and graph
 * building canonicalize the lifecycle output; rehydration rebuilds the
 * instance from the memo's canonical data without identity RPC. The
 * canonical head checks pin every operation to the run's fixed cutoff.
 */

function digest(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const DISCOVERY_RETRYABLE_FIELD = "__universeRebuildDiscoveryRetryable";

interface DiscoveryRetryableMarker {
  readonly stage: "nomination";
  readonly failureCode: "rpc" | "deadline" | "aborted" | "resource-limited";
  readonly reasonCode: string;
}

function discoveryRetryableMarker(
  candidate: Readonly<Record<string, unknown>>,
): DiscoveryRetryableMarker | null {
  const marker = candidate[DISCOVERY_RETRYABLE_FIELD];
  if (marker === null || typeof marker !== "object" || Array.isArray(marker)) {
    return null;
  }
  const item = marker as Readonly<Record<string, unknown>>;
  if (
    item.stage !== "nomination" ||
    !["rpc", "deadline", "aborted", "resource-limited"].includes(
      String(item.failureCode),
    ) ||
    typeof item.reasonCode !== "string" || item.reasonCode.length === 0
  ) {
    return null;
  }
  return Object.freeze({
    stage: "nomination",
    failureCode: item.failureCode as DiscoveryRetryableMarker["failureCode"],
    reasonCode: item.reasonCode,
  });
}

/**
 * Current chain authority for durable memo reuse. Family code changes are
 * covered by familyDefinitionHash; per-instance deployment/proxy changes are
 * covered by the source-pinned runtime code and EIP-1967 implementation word.
 */
export function memoAuthorityFingerprint(input: {
  readonly familyId: string;
  readonly address: string;
  readonly code: string;
  readonly implementationWord: string;
}): string {
  return digest("memo-authority-v1:" + canonicalJson({
    familyDefinitionHash: familyDefinitionHash(input.familyId),
    address: input.address.toLowerCase(),
    codeHash: ethers.keccak256(input.code),
    implementationWord: input.implementationWord.toLowerCase(),
  }));
}

/**
 * Memo-scoped chain authority: same structure as memoAuthorityFingerprint but
 * bound to the memo-scoped definition hash (identity/instance/routes/pricing).
 * Memos sealed before the hash split (full familyDefinitionHash scheme) match
 * memoAuthorityFingerprint; memos sealed after match this one. Revalidation
 * accepts either.
 */
export function memoAuthorityFingerprintMemoScope(input: {
  readonly familyId: string;
  readonly address: string;
  readonly code: string;
  readonly implementationWord: string;
}): string {
  return digest("memo-authority-v1:" + canonicalJson({
    familyDefinitionHash: familyMemoDefinitionHash(input.familyId),
    address: input.address.toLowerCase(),
    codeHash: ethers.keccak256(input.code),
    implementationWord: input.implementationWord.toLowerCase(),
  }));
}

export function hashFamilyCandidateKey(
  familyId: string,
  candidateIdentity: string,
): string {
  return digest("family-candidate-v1:" + familyId + "|" + candidateIdentity);
}

class ObservedSenderEvidenceMismatch extends Error {}

/**
 * Bind an observed-sender caller to the exact durable log evidence that
 * nominated the candidate.  This is deliberately Family-blind: any plugin
 * asking for an observed sender must carry the same canonical transaction +
 * log identity, and the central runtime never substitutes the executor.
 */
export function validateObservedSenderEvidence(input: {
  readonly candidate: Readonly<Record<string, unknown>>;
  readonly evidenceRef: {
    readonly blockNumber: number;
    readonly blockHash: string;
    readonly txHash?: string;
    readonly logIndex?: number;
  } | undefined;
  readonly canonicalBlockHash: string;
  readonly transaction: {
    readonly hash: string;
    readonly blockNumber: number | null;
    readonly blockHash: string | null;
  } | null;
  readonly receipt: {
    readonly blockNumber: number;
    readonly blockHash: string;
    readonly logs: readonly {
      readonly index: number;
      readonly address: string;
      readonly topics: readonly string[];
      readonly data: string;
      readonly transactionHash: string;
    }[];
  } | null;
  /** Candidates re-decoded by the catalog-issued plugin from the exact log. */
  readonly redecodedCandidates: readonly Readonly<Record<string, unknown>>[];
}): string | undefined {
  const actor = input.candidate.actor;
  if (actor === undefined) return undefined;
  if (typeof actor !== "string" || !ethers.isAddress(actor)) {
    throw new ObservedSenderEvidenceMismatch(
      "observed sender candidate actor is not an address",
    );
  }
  const evidence = input.evidenceRef;
  if (
    evidence === undefined ||
    evidence.txHash === undefined ||
    evidence.logIndex === undefined
  ) {
    throw new ObservedSenderEvidenceMismatch(
      "observed sender requires exact transaction/log evidence",
    );
  }
  const candidateBlockNumber = input.candidate.blockNumber;
  const candidateBlockHash = input.candidate.blockHash;
  const candidateTxHash = input.candidate.transactionHash;
  const candidateLogIndex = input.candidate.logIndex;
  if (
    candidateBlockNumber !== evidence.blockNumber ||
    typeof candidateBlockHash !== "string" ||
    candidateBlockHash.toLowerCase() !== evidence.blockHash.toLowerCase() ||
    typeof candidateTxHash !== "string" ||
    candidateTxHash.toLowerCase() !== evidence.txHash.toLowerCase() ||
    candidateLogIndex !== evidence.logIndex
  ) {
    throw new ObservedSenderEvidenceMismatch(
      "observed sender candidate/evidence identity mismatch",
    );
  }
  if (
    input.canonicalBlockHash.toLowerCase() !==
      evidence.blockHash.toLowerCase()
  ) {
    throw new Error("observed sender historical block is no longer canonical");
  }
  const tx = input.transaction;
  if (
    tx === null ||
    tx.hash.toLowerCase() !== evidence.txHash.toLowerCase() ||
    tx.blockNumber !== evidence.blockNumber ||
    tx.blockHash?.toLowerCase() !== evidence.blockHash.toLowerCase()
  ) {
    throw new ObservedSenderEvidenceMismatch(
      "observed sender transaction proof mismatch",
    );
  }
  const receipt = input.receipt;
  if (
    receipt === null ||
    receipt.blockNumber !== evidence.blockNumber ||
    receipt.blockHash.toLowerCase() !== evidence.blockHash.toLowerCase()
  ) {
    throw new ObservedSenderEvidenceMismatch(
      "observed sender receipt proof mismatch",
    );
  }
  const log = receipt.logs.find((item) => item.index === evidence.logIndex);
  if (
    log === undefined ||
    log.transactionHash.toLowerCase() !== evidence.txHash.toLowerCase()
  ) {
    throw new ObservedSenderEvidenceMismatch(
      "observed sender log proof mismatch",
    );
  }
  const familyCandidateKey = rebuildFamilyCandidateKey(input.candidate);
  const redecoded = input.redecodedCandidates.find((candidate) =>
    rebuildFamilyCandidateKey(candidate) === familyCandidateKey
  );
  if (
    redecoded === undefined ||
    typeof redecoded.actor !== "string" ||
    redecoded.actor.toLowerCase() !== actor.toLowerCase()
  ) {
    throw new ObservedSenderEvidenceMismatch(
      "observed sender plugin re-decode mismatch",
    );
  }
  return ethers.getAddress(actor).toLowerCase();
}

/** Opaque per-instance identity carried by a scan candidate. */
export function candidateInstanceIdentity(
  candidate: Readonly<Record<string, unknown>>,
): string {
  const pluginCandidateKey = candidate.pluginCandidateKey;
  if (
    typeof pluginCandidateKey === "string" &&
    pluginCandidateKey.trim().length > 0
  ) {
    return pluginCandidateKey.toLowerCase();
  }
  const poolId = candidate.poolId;
  if (typeof poolId === "string" && poolId.trim().length > 0) {
    return poolId.toLowerCase();
  }
  const address = candidate.address;
  if (typeof address === "string" && address.trim().length > 0) {
    return address.toLowerCase();
  }
  return digest("candidate:" + canonicalJson(candidate));
}

export function familyDefinitionHash(
  familyId: string,
): string {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
    .forStrictFamily(familyId as never);
  return digest("family-def-v1:" + canonicalJson({
    familyId,
    definitionBoundaryHash: family.definitionBoundaryHash,
    capabilities: family.applicableCapabilities.map((capability) => ({
      capability,
      contractVersion: family.hashes[capability].contractVersion,
      contentHash: family.hashes[capability].contentHash,
      semanticDependencies:
        family.hashes[capability].semanticDependencies,
    })),
  }));
}

/**
 * Capabilities that can change a Family's discovery/nomination/reverse-binding
 * surface — the only authority a source receipt may bind. pricing/exact/
 * execution changes must not force a historical window rescan.
 */
const DISCOVERY_DEFINITION_CAPABILITIES = Object.freeze([
  "capture",
  "discovery",
] as const);

/**
 * Capabilities that shape a verified static instance (identity proof,
 * materialization, routes/pricing projection) — the only authority a verified
 * memo may bind. Changing exact quoting or execution must not invalidate an
 * identity memo.
 */
const MEMO_DEFINITION_CAPABILITIES = Object.freeze([
  "identity",
  "instance",
  "routes",
  "pricing",
  "funding",
] as const);

function scopedFamilyDefinitionHash(
  seed: string,
  familyId: string,
  capabilities: readonly (keyof FamilyCapabilityIdentitySet)[],
): string {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
    .forStrictFamily(familyId as never);
  const applicable = new Set(family.applicableCapabilities);
  const bound = capabilities
    .filter((capability) => applicable.has(capability))
    .map((capability) => ({
      capability,
      contractVersion: family.hashes[capability].contractVersion,
      contentHash: family.hashes[capability].contentHash,
      semanticDependencies:
        family.hashes[capability].semanticDependencies,
    }));
  return digest(seed + ":" + canonicalJson({
    familyId,
    capabilities: bound,
  }));
}

/** Source-plan authority for one Family (discovery/nomination surface). */
export function familyDiscoveryDefinitionHash(familyId: string): string {
  return scopedFamilyDefinitionHash(
    "family-discovery-def-v1",
    familyId,
    DISCOVERY_DEFINITION_CAPABILITIES,
  );
}

/** Verified-memo authority for one Family (static instance surface). */
export function familyMemoDefinitionHash(familyId: string): string {
  return scopedFamilyDefinitionHash(
    "family-memo-def-v1",
    familyId,
    MEMO_DEFINITION_CAPABILITIES,
  );
}

function familyIdForCandidate(
  candidate: Readonly<Record<string, unknown>>,
): string {
  const adapter = candidate.adapter;
  if (typeof adapter === "string" && adapter.trim().length > 0) {
    try {
      return PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
        .ownerOfPoolAdapter(adapter);
    } catch {
      try {
        return PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
          .ownerOfAction(adapter);
      } catch {
        return "unknown-family";
      }
    }
  }
  return "unknown-family";
}

function classifyFailure(reason: string): RetryableAttempt["failureCode"] {
  const lower = reason.toLowerCase();
  if (lower.includes("deadline") || lower.includes("timeout")) {
    return "deadline";
  }
  if (lower.includes("aborted") || lower.includes("stopped")) {
    return "aborted";
  }
  if (lower.includes("resource") || lower.includes("limit")) {
    return "resource-limited";
  }
  return "rpc";
}

/**
 * Preserve the plugin-owned candidate payload when entering strict
 * attestation. The central layer normalizes only the address/known shell;
 * PoolKey, actor/token/amount and other Family fields remain opaque and are
 * consumed by that Family's nomination/materialization capability.
 */
export function attestationPoolFromCandidate(
  candidate: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> & {
  readonly address: string;
  readonly adapter?: string;
} {
  const address = String(candidate.address ?? "");
  return Object.freeze({
    ...candidate,
    address,
    ...(candidate.adapter === undefined
      ? {}
      : { adapter: String(candidate.adapter) }),
    ...(candidate.poolId === undefined
      ? {}
      : { poolId: String(candidate.poolId) }),
  });
}

export function isChainProvenTerminalReason(reason: string): boolean {
  const normalized = reason.trim().toLowerCase();
  return normalized === "no deployed code" ||
    normalized === "no_catalog_match" ||
    normalized === "no_matching_family" ||
    normalized.startsWith("identity_rejected:");
}

function providerAdapter(
  provider: ethers.JsonRpcProvider,
): {
  call(
    transaction: { readonly to: string; readonly data: string },
    blockTag?: number,
  ): Promise<string>;
  getCode(address: string, blockTag?: number): Promise<string>;
  getStorage(address: string, slot: string, blockTag?: number): Promise<string>;
  getLogs(filter: {
    readonly address?: string;
    readonly fromBlock?: number;
    readonly toBlock?: number;
    readonly topics?: readonly (string | null)[];
  }): Promise<readonly {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
    readonly transactionHash?: string;
  }[]>;
  getTransactionReceipt(transactionHash: string): Promise<{
    readonly blockNumber?: number;
    readonly logs: readonly {
      readonly address: string;
      readonly topics: readonly string[];
      readonly data: string;
      readonly transactionHash?: string;
    }[];
  } | null>;
  traceTransaction?(transactionHash: string): Promise<unknown>;
} {
  return {
    call: async (transaction, blockTag) =>
      provider.send("eth_call", [
        { to: transaction.to, data: transaction.data },
        // reth requires the tag as hex; the central runtime passes a
        // decimal block number.
        blockTag === undefined
          ? "latest"
          : typeof blockTag === "number"
            ? "0x" + blockTag.toString(16)
            : blockTag,
      ]) as Promise<string>,
    getCode: async (address, blockTag) =>
      provider.getCode(address, blockTag ?? "latest"),
    getStorage: async (address, slot, blockTag) =>
      provider.getStorage(address, slot, blockTag ?? "latest"),
    getLogs: async (filter) =>
      provider.getLogs({
        ...(filter.address === undefined ? {} : { address: filter.address }),
        ...(filter.fromBlock === undefined
          ? {}
          : { fromBlock: filter.fromBlock }),
        ...(filter.toBlock === undefined ? {} : { toBlock: filter.toBlock }),
        topics: (filter.topics ?? []).map((topic) =>
          topic === null ? [] : topic
        ),
      }) as unknown as Promise<readonly {
        readonly address: string;
        readonly topics: readonly string[];
        readonly data: string;
        readonly transactionHash?: string;
      }[]>,
    getTransactionReceipt: async (transactionHash) =>
      provider.getTransactionReceipt(transactionHash) as unknown as {
        readonly blockNumber?: number;
        readonly logs: readonly {
          readonly address: string;
          readonly topics: readonly string[];
          readonly data: string;
          readonly transactionHash?: string;
        }[];
      } | null,
    traceTransaction: async (transactionHash) =>
      provider.send("debug_traceTransaction", [
        transactionHash,
        Object.freeze({ tracer: "callTracer" }),
      ]),
  };
}

async function readBlockHash(
  provider: ethers.JsonRpcProvider,
  number: number,
): Promise<string> {
  const block = await provider.getBlock(number);
  if (block === null || block.hash === null) {
    throw new Error("canonical block unavailable: " + number);
  }
  return block.hash;
}

function canonicalCandidateSnapshot(
  candidate: Readonly<Record<string, unknown>>,
): unknown {
  // Keep the complete plugin-owned candidate. Event-dependent Families can
  // require fields beyond address/poolId (PoolKey, payout token, actor,
  // amounts, etc.); dropping them makes retained-memo reuse or a single-pool
  // retry impossible. The durable codec is JSON-safe; the snapshot is bound
  // into the verified memo or bounded retry entry, never a raw-tx inbox or a
  // second admission authority.
  return encodeDurableValue(candidate);
}

type DurableEncodedValue =
  | null | boolean | string | number
  | readonly DurableEncodedValue[]
  | { readonly [key: string]: DurableEncodedValue };

function isSealedReadonlyMap(
  value: object,
): value is ReadonlyMap<unknown, unknown> {
  const candidate = value as {
    readonly size?: unknown;
    readonly entries?: unknown;
    readonly get?: unknown;
    readonly has?: unknown;
    readonly [Symbol.iterator]?: unknown;
  };
  return Object.prototype.toString.call(value) ===
      "[object SealedReadonlyMap]" &&
    Number.isSafeInteger(candidate.size) && Number(candidate.size) >= 0 &&
    typeof candidate.entries === "function" &&
    typeof candidate.get === "function" &&
    typeof candidate.has === "function" &&
    typeof candidate[Symbol.iterator] === "function";
}

/** JSON-safe codec for memo data (bigints and Maps are explicit, never lost). */
function encodeDurableValue(
  value: unknown,
  seen: Set<object> = new Set<object>(),
): DurableEncodedValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("durable value number is not finite");
    return value;
  }
  if (typeof value === "bigint") {
    return Object.freeze({ $durableType: "bigint", value: value.toString() });
  }
  if (typeof value !== "object") {
    throw new Error("unsupported durable value type: " + typeof value);
  }
  if (seen.has(value)) throw new Error("durable value must not contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item) => encodeDurableValue(item, seen)));
    }
    if (value instanceof Map || isSealedReadonlyMap(value)) {
      const entries = [...value.entries()].map(([key, item]) => Object.freeze([
        encodeDurableValue(key, seen),
        encodeDurableValue(item, seen),
      ] as const));
      entries.sort((left, right) =>
        canonicalJson(left[0]).localeCompare(canonicalJson(right[0]))
      );
      return Object.freeze({
        $durableType: "map",
        entries: Object.freeze(entries),
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("durable value objects must be plain records");
    }
    const encoded: Record<string, DurableEncodedValue> = {};
    for (const key of Object.keys(value as object).sort()) {
      const item = (value as Record<string, unknown>)[key];
      // Match JSON object semantics for optional plugin fields. Production
      // PoolEntry candidates commonly materialize optional properties as own
      // keys whose value is undefined; omitting those keys is deterministic
      // and round-trips to the same effective candidate. Keep rejecting
      // undefined in arrays and Map entries, where omission would change
      // position/key identity and make the durable partition ambiguous.
      if (item === undefined) continue;
      encoded[key] = encodeDurableValue(item, seen);
    }
    return Object.freeze(encoded);
  } finally {
    seen.delete(value);
  }
}

function decodeDurableValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map(decodeDurableValue));
  }
  const record = value as Record<string, unknown>;
  if (record.$durableType === "bigint") return BigInt(String(record.value));
  if (record.$durableType === "map") {
    const entries = Array.isArray(record.entries) ? record.entries : [];
    return new Map(entries.map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new Error("durable map entry is invalid");
      }
      return [decodeDurableValue(entry[0]), decodeDurableValue(entry[1])];
    }));
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, decodeDurableValue(item)]),
  ));
}

function sealMemoFromPublication(input: {
  readonly candidate: Readonly<Record<string, unknown>>;
  readonly familyId: string;
  readonly familyInstanceKey: string;
  readonly instanceKey: string;
  readonly verifiedIdentity: unknown;
  readonly compiledDescriptor: unknown;
  readonly staticProjection: unknown;
  readonly evidenceFingerprint: string;
  readonly proofSource: CanonicalSource;
  readonly candidateFingerprint: string;
  readonly authorityFingerprint: string;
  readonly validityPolicy?: DurableVerifiedMemo["validity"]["policy"];
}): DurableVerifiedMemo {
  const familyCandidateKey = hashFamilyCandidateKey(
    input.familyId,
    candidateInstanceIdentity(input.candidate),
  );
  const memo = Object.freeze({
    familyCandidateKey,
    familyInstanceKey: input.familyInstanceKey,
    familyId: input.familyId,
    candidateKey: candidateInstanceIdentity(input.candidate),
    instanceKey: input.instanceKey,
    candidateFingerprint: input.candidateFingerprint,
    familyDefinitionHash: familyMemoDefinitionHash(input.familyId),
    validity: Object.freeze({
      policy: input.validityPolicy ?? "immutable-code",
      authorityFingerprint: input.authorityFingerprint,
      proofSource: Object.freeze({
        number: input.proofSource.number,
        hash: input.proofSource.hash,
      }),
    }),
    verifiedIdentity: encodeDurableValue(input.verifiedIdentity),
    compiledDescriptor: encodeDurableValue(input.compiledDescriptor),
    staticProjection: encodeDurableValue(input.staticProjection),
    evidenceFingerprint: input.evidenceFingerprint,
    candidateSnapshot: canonicalCandidateSnapshot(input.candidate),
    memoFingerprint: "",
  });
  return Object.freeze({
    ...memo,
    memoFingerprint: durableVerifiedMemoFingerprint(memo),
  });
}

function uniqueCandidateValues(
  values: readonly (string | undefined)[],
): readonly (string | undefined)[] {
  const seen = new Set<string>();
  const result: (string | undefined)[] = [];
  for (const value of values) {
    const key = value === undefined ? "<undefined>" : "string:" + value;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return Object.freeze(result);
}

function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/**
 * Reconstruct the deployed pre-snapshot memo's canonical candidate without a
 * Family switch. Candidate spellings come from chain-verified memo data and
 * adapter labels come only from the loaded plugin manifest. Both the durable
 * FamilyCandidateKey and the original candidate fingerprint must match.
 */
export function upgradeLegacyVerifiedMemo(
  memo: LegacyDurableVerifiedMemo,
): DurableVerifiedMemo {
  assertDurableVerifiedMemoFingerprint(memo);
  const descriptorValue = decodeDurableValue(memo.compiledDescriptor);
  const identityValue = decodeDurableValue(memo.verifiedIdentity);
  const descriptor = typeof descriptorValue === "object" &&
      descriptorValue !== null && !Array.isArray(descriptorValue)
    ? descriptorValue as Readonly<Record<string, unknown>>
    : Object.freeze({}) as Readonly<Record<string, unknown>>;
  const identity = typeof identityValue === "object" &&
      identityValue !== null && !Array.isArray(identityValue)
    ? identityValue as Readonly<Record<string, unknown>>
    : Object.freeze({}) as Readonly<Record<string, unknown>>;
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
    .forStrictFamily(memo.familyId as never);

  // Candidate envelope fields are the only central shape interpreted here.
  // Protocol descriptor fields stay opaque: the chain-verified identity owns
  // the subject, while the generated manifest owns every adapter spelling.
  const rawAddress = stringField(identity, "subject") ??
    stringField(descriptor, "address");
  const addresses = uniqueCandidateValues(
    rawAddress === undefined ? [] : [rawAddress, rawAddress.toLowerCase()],
  ).filter((value): value is string => value !== undefined);
  const rawPoolId = stringField(descriptor, "poolId");
  const poolIds = uniqueCandidateValues([
    undefined,
    ...(rawPoolId === undefined
      ? []
      : [rawPoolId, rawPoolId.toLowerCase()]),
  ]);
  const manifest = family.plugin.manifest;
  const adapters = uniqueCandidateValues([
    undefined,
    ...(manifest.poolAdapterIds ?? []),
    ...manifest.ownedActionAdapterIds,
    memo.familyId,
  ]);
  const pluginCandidateKeys = uniqueCandidateValues([
    undefined,
    memo.candidateKey,
    memo.candidateKey.toLowerCase(),
  ]);
  const payload = { ...descriptor } as Record<string, unknown>;
  delete payload.address;
  delete payload.familyId;
  delete payload.poolId;
  delete payload.adapter;
  delete payload.pluginCandidateKey;

  for (const address of addresses) {
    for (const poolId of poolIds) {
      for (const adapter of adapters) {
        for (const pluginCandidateKey of pluginCandidateKeys) {
          const candidate = Object.freeze({
            ...payload,
            address,
            familyId: memo.familyId,
            ...(poolId === undefined ? {} : { poolId }),
            ...(adapter === undefined ? {} : { adapter }),
            ...(pluginCandidateKey === undefined
              ? {}
              : { pluginCandidateKey }),
          });
          if (
            rebuildFamilyCandidateKey(candidate) === memo.familyCandidateKey &&
            candidateFingerprint(candidate) === memo.candidateFingerprint
          ) {
            const upgraded = Object.freeze({
              ...memo,
              candidateSnapshot: canonicalCandidateSnapshot(candidate),
              memoFingerprint: "",
            });
            return Object.freeze({
              ...upgraded,
              memoFingerprint: durableVerifiedMemoFingerprint(upgraded),
            });
          }
        }
      }
    }
  }
  throw new Error(
    "universe rebuild: cannot reconstruct legacy verified memo candidate " +
      memo.familyCandidateKey + " family=" + memo.familyId,
  );
}

export function createProbeWiring(
  input?: { readonly rpcUrl?: string },
): UniverseRebuildProbeWiring {
  const rpcUrl = input?.rpcUrl ??
    process.env.SEARCHER_LIVE_RPC_URL ??
    process.env.MAINNET_RPC_URL;
  if (rpcUrl === undefined || rpcUrl.trim().length === 0) {
    throw new Error(
      "universe rebuild production wiring requires SEARCHER_LIVE_RPC_URL " +
        "or MAINNET_RPC_URL",
    );
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const strictProvider = providerAdapter(provider);
  // Simulation-dependent families (erc4626/silo/fluid-vault/self-burn) keep
  // their identity fail-closed under the minimal runtime; when the revm
  // simulator binary + executor are available (production), use the full
  // runtime so those families can verify.
  const revmBin = process.env.SEARCHER_REVM_SIM_BIN;
  const executor = process.env.BOTVM_ADDRESS;
  // NOTE: the revm-sim daemon serves requests single-threaded over stdin; one
  // slow request (archive prestateTracer can exceed the HTTP timeout) blocks
  // every queued request. The probe runs concurrent workers, so sharing one
  // daemon across workers deadlocks them. Each runtime gets its own
  // RevmSimClient (its own daemon process): per-key isolation means one slow
  // key can never block siblings.
  interface ProbeRuntimeHandle {
    readonly runtime: CentralAdapterRuntime;
    dispose(): void;
  }
  const runtimeFor = (
    cutoff: CanonicalSource,
    observedSender?: string,
  ): ProbeRuntimeHandle => {
    const revmClient = revmBin !== undefined && revmBin.trim() !== "" &&
        executor !== undefined && executor.trim() !== ""
      ? new RevmSimClient({
          executablePath: revmBin,
          timeoutMs: Number(process.env.SEARCHER_REVM_TIMEOUT_MS ?? "60000"),
        })
      : null;
    const runtime = revmClient === null || executor === undefined
      ? createMinimalIdentityRuntime(strictProvider)
      : createStrictCentralAdapterRuntime({
          provider: strictProvider as never,
          generationFence: Object.freeze({
            assertCurrent(generation: number, source: CanonicalSource) {
              if (
                generation !== cutoff.generation ||
                source.number !== cutoff.number ||
                source.hash.toLowerCase() !== cutoff.hash.toLowerCase() ||
                source.generation !== cutoff.generation
              ) {
                throw new Error(
                  "rebuild lifecycle escaped the fixed canonical cutoff",
                );
              }
            },
          }),
          verifiedActors: PRODUCTION_STRICT_VERIFIED_ACTORS,
          ...(observedSender === undefined ? {} : { observedSender }),
          simulator: createRevmStrictSimulationTransport({
            client: revmClient,
            executor,
            ...(observedSender === undefined ? {} : { observedSender }),
            verifiedActors: PRODUCTION_STRICT_VERIFIED_ACTORS,
          }),
        });
    return Object.freeze({
      runtime,
      dispose(): void {
        revmClient?.stop();
      },
    });
  };
  const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;

  type AttestOnce = NonNullable<UniverseRebuildProbeWiring["attestFamilyInstanceOnce"]>;
  type VerifiedReturn = Awaited<ReturnType<AttestOnce>> extends infer U ?
    (U extends { readonly status: "verified" } ? U : never) : never;
  type TerminalReturn = Awaited<ReturnType<AttestOnce>> extends infer U ?
    (U extends { readonly status: "terminal-rejected" } ? U : never) : never;
  type RetryableReturn = Awaited<ReturnType<AttestOnce>> extends infer U ?
    (U extends { readonly status: "retryable" } ? U : never) : never;
  const terminalRejected = (reasonCode: string, binding: TerminalReturn["binding"]): TerminalReturn =>
    Object.freeze({
      status: "terminal-rejected",
      reasonCode,
      binding: Object.freeze(binding),
    }) as TerminalReturn;
  const retryable = (input2: {
    readonly candidate: Readonly<Record<string, unknown>>;
    readonly reasonCode: string;
    readonly stage: RetryableAttempt["stage"];
    readonly failureCode: RetryableAttempt["failureCode"];
    readonly evidenceRef?: {
      readonly blockNumber: number;
      readonly blockHash: string;
      readonly txHash?: string;
      readonly logIndex?: number;
    };
  }): RetryableReturn => Object.freeze({
    status: "retryable",
    stage: input2.stage,
    failureCode: input2.failureCode,
    reasonCode: input2.reasonCode,
    candidateSnapshot: canonicalCandidateSnapshot(input2.candidate),
    ...(input2.evidenceRef === undefined
      ? {}
      : { evidenceRef: Object.freeze(input2.evidenceRef) }),
  }) as RetryableReturn;
  const verified = (result: unknown): VerifiedReturn =>
    Object.freeze({ status: "verified", result }) as VerifiedReturn;

  return Object.freeze({
    attestFamilyInstanceOnce: async (
      attestInput: Parameters<AttestOnce>[0],
    ): Promise<Awaited<ReturnType<AttestOnce>>> => {
      const candidate = attestInput.candidate as Readonly<Record<string, unknown>>;
      const candidateFamilyId = typeof candidate.familyId === "string"
        ? candidate.familyId
        : familyIdForCandidate(candidate);
      const candidateFamily = catalog.forStrictFamily(candidateFamilyId as never);
      if (candidateFamily.plugin.manifest.domain === "funding") {
        const asset = candidate.asset;
        if (typeof asset !== "string" || !ethers.isAddress(asset)) {
          return terminalRejected("invalid_funding_asset", {
            familyDefinitionHash: familyDefinitionHash(candidateFamilyId),
            requestFingerprint: "",
            trustedResultsFingerprint: "",
            authorityFingerprint: "",
            candidateFingerprint: candidateFingerprint(candidate),
            cutoff: Object.freeze({
              number: attestInput.cutoff.number,
              hash: attestInput.cutoff.hash,
            }),
          });
        }
        const runtimeHandle = runtimeFor(attestInput.cutoff);
        try {
          const funding = await executeFundingFamilyLiquidity({
            family: candidateFamily,
            assets: Object.freeze([ethers.getAddress(asset)]),
            source: attestInput.cutoff,
            generation: attestInput.cutoff.generation,
            runtime: runtimeHandle.runtime,
            publisher: Object.freeze({ publish() {} }),
          });
          const outcome = funding.outcomes[0];
          const positiveOffer = funding.offers.find((offer) =>
            offer.asset.toLowerCase() ===
              ethers.getAddress(asset).toLowerCase() &&
            offer.maxBorrow > 0n
          );
          if (
            outcome === undefined ||
            outcome.status !== "verified" ||
            positiveOffer === undefined
          ) {
            const reason = outcome === undefined
              ? "funding attestation produced no outcome"
              : outcome.status !== "verified"
              ? outcome.reasonCode
              : "funding attestation found no positive current liquidity";
            return retryable({
              candidate,
              reasonCode: reason,
              stage: "funding",
              failureCode: classifyFailure(reason),
              ...(attestInput.evidenceRef === undefined
                ? {}
                : { evidenceRef: attestInput.evidenceRef }),
            });
          }
          return verified(Object.freeze({
            domain: "funding" as const,
            familyId: candidateFamilyId,
            asset: ethers.getAddress(asset),
            fundingId: positiveOffer.fundingId,
            evidenceRefs: positiveOffer.evidenceRefs,
            authorityFingerprint: digest(
              "funding-attestation-v1:" + canonicalJson({
                familyId: candidateFamilyId,
                asset: ethers.getAddress(asset).toLowerCase(),
                source: attestInput.cutoff,
                evidenceRefs: positiveOffer.evidenceRefs,
              }),
            ),
            candidate: canonicalCandidateSnapshot(candidate),
          }));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return retryable({
            candidate,
            reasonCode: reason.slice(0, 200),
            stage: "funding",
            failureCode: classifyFailure(reason),
            ...(attestInput.evidenceRef === undefined
              ? {}
              : { evidenceRef: attestInput.evidenceRef }),
          });
        } finally {
          runtimeHandle.dispose();
        }
      }
      const pool = attestationPoolFromCandidate(candidate);
      if (!ethers.isAddress(pool.address)) {
        return terminalRejected("invalid_candidate_address", {
          familyDefinitionHash: familyDefinitionHash(familyIdForCandidate(candidate)),
          requestFingerprint: "",
          trustedResultsFingerprint: "",
          authorityFingerprint: "",
          candidateFingerprint: candidateFingerprint(candidate),
          cutoff: Object.freeze({
            number: attestInput.cutoff.number,
            hash: attestInput.cutoff.hash,
          }),
        });
      }
      let result: Awaited<ReturnType<typeof attestPoolIdentitiesStrict>>;
      let authorityFingerprint: string;
      let observedSender: string | undefined;
      let runtimeHandle: ProbeRuntimeHandle | undefined;
      try {
        if (candidate.actor !== undefined) {
          const evidence = attestInput.evidenceRef;
          if (
            evidence === undefined ||
            evidence.txHash === undefined ||
            evidence.logIndex === undefined
          ) {
            throw new ObservedSenderEvidenceMismatch(
              "observed sender requires exact transaction/log evidence",
            );
          }
          const [canonicalBlockHash, transaction, receipt] = await Promise.all([
            readBlockHash(provider, evidence.blockNumber),
            provider.getTransaction(evidence.txHash),
            provider.getTransactionReceipt(evidence.txHash),
          ]);
          const receiptLog = receipt?.logs.find((log) =>
            log.index === evidence.logIndex
          );
          const redecodedCandidates = receiptLog === undefined
            ? Object.freeze([])
            : candidatesFromLog(Object.freeze({
                address: receiptLog.address,
                topics: Object.freeze([...receiptLog.topics]),
                data: receiptLog.data,
                transactionHash: receiptLog.transactionHash,
                blockNumber: receipt?.blockNumber,
                blockHash: receipt?.blockHash,
                logIndex: receiptLog.index,
              }));
          observedSender = validateObservedSenderEvidence({
            candidate,
            evidenceRef: evidence,
            canonicalBlockHash,
            transaction: transaction === null ? null : Object.freeze({
              hash: transaction.hash,
              blockNumber: transaction.blockNumber,
              blockHash: transaction.blockHash,
            }),
            receipt: receipt === null ? null : Object.freeze({
              blockNumber: receipt.blockNumber,
              blockHash: receipt.blockHash,
              logs: Object.freeze(receipt.logs.map((log) => Object.freeze({
                index: log.index,
                address: log.address,
                topics: Object.freeze([...log.topics]),
                data: log.data,
                transactionHash: log.transactionHash,
              }))),
            }),
            redecodedCandidates,
          });
        }
        const [code, implementationWord] = await Promise.all([
          strictProvider.getCode(pool.address, attestInput.cutoff.number),
          strictProvider.getStorage(
            pool.address,
            EIP1967_IMPLEMENTATION_SLOT,
            attestInput.cutoff.number,
          ),
        ]);
        authorityFingerprint = memoAuthorityFingerprint({
          familyId: String(candidate.familyId ?? familyIdForCandidate(candidate)),
          address: pool.address,
          code,
          implementationWord,
        });
        runtimeHandle = runtimeFor(attestInput.cutoff, observedSender);
        result = await attestPoolIdentitiesStrict({
          catalog,
          provider: strictProvider,
          runtime: runtimeHandle.runtime,
          source: attestInput.cutoff,
          pools: Object.freeze([pool]),
          channelOrder: "reverse-binding-first",
        });
      } catch (error) {
        if (error instanceof ObservedSenderEvidenceMismatch) {
          return terminalRejected(
            "observed_sender_evidence_mismatch:" + error.message,
            {
              familyDefinitionHash: familyDefinitionHash(familyIdForCandidate(candidate)),
              requestFingerprint: "",
              trustedResultsFingerprint: "",
              authorityFingerprint: "",
              candidateFingerprint: candidateFingerprint(candidate),
              cutoff: Object.freeze({
                number: attestInput.cutoff.number,
                hash: attestInput.cutoff.hash,
              }),
            },
          );
        }
        return retryable({
          candidate,
          reasonCode: error instanceof Error
            ? error.message.slice(0, 200)
            : "unknown",
          stage: "identity",
          failureCode: classifyFailure(
            error instanceof Error ? error.message : String(error),
          ),
          ...(attestInput.evidenceRef === undefined
            ? {}
            : { evidenceRef: attestInput.evidenceRef }),
        });
      } finally {
        runtimeHandle?.dispose();
      }
      const accepted = result.accepted[0];
      if (accepted === undefined) {
        const reason = result.rejected[0]?.reason ?? "identity_unverified";
        if (!isChainProvenTerminalReason(reason)) {
          return retryable({
            candidate,
            reasonCode: reason,
            stage: "identity",
            failureCode: classifyFailure(reason),
            ...(attestInput.evidenceRef === undefined
              ? {}
              : { evidenceRef: attestInput.evidenceRef }),
          });
        }
        return terminalRejected(reason, {
          familyDefinitionHash: familyDefinitionHash(familyIdForCandidate(candidate)),
          requestFingerprint: "",
          trustedResultsFingerprint: "",
          authorityFingerprint,
          candidateFingerprint: candidateFingerprint(candidate),
          cutoff: Object.freeze({
            number: attestInput.cutoff.number,
            hash: attestInput.cutoff.hash,
          }),
        });
      }
      const publication = result.publications[0] ?? null;
      const instance = publication?.instances[0] ?? null;
      if (instance === null) {
        // Identity alone is not a verified universe instance. A missing
        // materialization/projection must remain durable-retryable and block
        // ready; otherwise the cursor could advance while the Graph silently
        // omits an identity-accepted pool.
        return retryable({
          candidate,
          reasonCode: "strict lifecycle produced no materialized instance",
          stage: publication === null ? "materialization" : "projection",
          failureCode: "resource-limited",
          ...(attestInput.evidenceRef === undefined
            ? {}
            : { evidenceRef: attestInput.evidenceRef }),
        });
      }
      return verified(Object.freeze({
        accepted,
        publication,
        instance,
        authorityFingerprint,
        candidate: canonicalCandidateSnapshot(candidate),
      }));
    },
    sealDurableVerifiedMemo: (
      sealInput: Parameters<NonNullable<
        UniverseRebuildProbeWiring["sealDurableVerifiedMemo"]
      >>[0],
    ) => {
      const candidate = sealInput.candidate as Readonly<Record<string, unknown>>;
      const domainResult = sealInput.result as {
        readonly domain?: unknown;
        readonly familyId?: unknown;
        readonly asset?: unknown;
        readonly fundingId?: unknown;
        readonly evidenceRefs?: readonly string[];
        readonly authorityFingerprint?: unknown;
      };
      if (domainResult.domain === "funding") {
        const familyId = String(domainResult.familyId ?? "");
        const asset = ethers.getAddress(String(domainResult.asset ?? ""));
        const instanceKey = String(
          domainResult.fundingId ?? familyId + "\u001f" + asset.toLowerCase(),
        );
        const familyInstanceKey = digest(
          "family-instance-v1:" + familyId + "|" + instanceKey,
        );
        const evidenceRefs = Object.freeze([
          ...(domainResult.evidenceRefs ?? []),
        ]);
        return sealMemoFromPublication({
          candidate,
          familyId,
          familyInstanceKey,
          instanceKey,
          verifiedIdentity: Object.freeze({
            domain: "funding",
            familyId,
            asset,
            source: Object.freeze(sealInput.proofSource),
          }),
          compiledDescriptor: Object.freeze({
            domain: "funding",
            asset,
          }),
          staticProjection: Object.freeze({
            format: "prepared-funding-token-v1",
            domain: "funding",
            asset,
            evidenceRefs,
          }),
          evidenceFingerprint: digest(
            "evidence:" + canonicalJson(evidenceRefs),
          ),
          proofSource: sealInput.proofSource,
          candidateFingerprint: candidateFingerprint(candidate),
          authorityFingerprint: String(
            domainResult.authorityFingerprint ?? "",
          ),
          validityPolicy: "dependency-proof",
        });
      }
      const result = sealInput.result as {
        readonly accepted: {
          readonly familyId: string;
          readonly lineageId: string;
          readonly subject: string;
        };
        readonly authorityFingerprint: string;
        readonly instance?: {
          readonly instanceKey: string;
          readonly descriptor?: unknown;
          readonly evidenceRefs?: readonly string[];
          readonly routes?: readonly unknown[];
          readonly pricingInstances?: readonly {
            readonly routes?: readonly unknown[];
          }[];
          readonly staticBindingFingerprint?: string;
          readonly staticEvidenceFingerprint?: string;
        } | null;
      };
      const familyId = result.accepted.familyId;
      const instanceKey = result.instance?.instanceKey ??
        digest("instance:" + familyId + "|" + candidateInstanceIdentity(candidate));
      const familyInstanceKey = digest(
        "family-instance-v1:" + familyId + "|" + instanceKey,
      );
      return sealMemoFromPublication({
        candidate,
        familyId,
        familyInstanceKey,
        instanceKey,
        verifiedIdentity: Object.freeze({
          familyId,
          lineageId: result.accepted.lineageId,
          subject: result.accepted.subject,
          source: Object.freeze(sealInput.proofSource),
        }),
        compiledDescriptor: result.instance?.descriptor ?? null,
        staticProjection: result.instance === null || result.instance === undefined
          ? null
          : Object.freeze({
              format: "prepared-family-instance-v1",
              routes: result.instance.routes ?? Object.freeze([]),
              pricingInstances:
                result.instance.pricingInstances ?? Object.freeze([]),
              staticBindingFingerprint:
                result.instance.staticBindingFingerprint ?? "",
              staticEvidenceFingerprint:
                result.instance.staticEvidenceFingerprint ?? "",
              evidenceRefs: result.instance.evidenceRefs ?? Object.freeze([]),
            }),
        evidenceFingerprint: digest(
          "evidence:" + canonicalJson(
            result.instance?.evidenceRefs ?? [],
          ),
        ),
        proofSource: sealInput.proofSource,
        candidateFingerprint: candidateFingerprint(candidate),
        authorityFingerprint: result.authorityFingerprint,
      });
    },
    assertCanonicalHead: async (cutoff: CanonicalSource) => {
      const hash = await readBlockHash(provider, cutoff.number);
      if (hash.toLowerCase() !== cutoff.hash.toLowerCase()) {
        throw new Error(
          "canonical head hash mismatch at " + cutoff.number,
        );
      }
    },
    decodeCandidateSnapshot: (snapshot: unknown) =>
      decodeDurableValue(snapshot),
  });
}

/**
 * Full rebuild wiring (audit §5): freeze the canonical head, scan the
 * strict-catalog activity window, dedupe by full observation identity into family-aware
 * candidates, reuse verified memos across windows, rehydrate instances from
 * memos, aggregate once per family and build the canonical graph snapshot.
 * All reads are pinned to the run cutoff hash.
 */

export interface RebuildScanObservation {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly transactionHash?: string;
  readonly blockNumber?: number;
  readonly blockHash?: string;
  readonly logIndex?: number;
}

export interface RebuildCallObservation {
  readonly kind: "call";
  readonly target: string;
  readonly data: string;
  readonly sender?: string;
  readonly transactionHash: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly traceAddress: readonly number[];
}

interface StrictCatalogCallPattern {
  readonly familyId: string;
  readonly id: string;
  readonly selector: string;
  readonly candidateAddress: Readonly<
    | { readonly from: "call-target" }
    | { readonly from: "argument"; readonly index: number }
  >;
}

export function strictCatalogLogTopics(): readonly string[] {
  const topics = new Set<string>();
  for (const family of PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
    .listAll()) {
    const discovery = "discovery" in family.plugin
      ? family.plugin.discovery
      : null;
    for (const pattern of discovery?.logPatterns ?? []) {
      topics.add(pattern.topic.toLowerCase());
    }
  }
  return [...topics].sort();
}

export function strictCatalogCallPatterns(): readonly StrictCatalogCallPattern[] {
  const patterns: StrictCatalogCallPattern[] = [];
  for (const family of PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
    .listAll()) {
    if (!("discovery" in family.plugin)) continue;
    for (const pattern of family.plugin.discovery.callPatterns ?? []) {
      patterns.push(Object.freeze({
        familyId: family.plugin.manifest.familyId,
        id: pattern.id,
        selector: pattern.selector.toLowerCase(),
        candidateAddress: Object.freeze({ ...pattern.candidateAddress }),
      }));
    }
  }
  return Object.freeze(patterns.sort((left, right) =>
    (left.familyId + "\u0000" + left.id + "\u0000" + left.selector)
      .localeCompare(right.familyId + "\u0000" + right.id + "\u0000" + right.selector)
  ));
}

export function strictCatalogSourceCoverageKeys(): {
  readonly startup: readonly string[];
  readonly activity: readonly string[];
} {
  const startup: string[] = [];
  const activity: string[] = [];
  for (const family of PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
    .listAll()) {
    const familyId = family.plugin.manifest.familyId;
    // This key proves that the exact startup nomination partition for the
    // Family was consumed and attested at the cutoff. It is not an
    // enumerator/omission grant: retained pool files remain nomination-only,
    // and a missing row may be reported only as "no candidate in the exact
    // partition", never as proof that no chain instance exists.
    startup.push(familyId + "|startup-universe");
    const discovery = "discovery" in family.plugin
      ? family.plugin.discovery
      : null;
    for (const pattern of discovery?.logPatterns ?? []) {
      activity.push(familyId + "|event:" + pattern.id);
    }
    for (const pattern of discovery?.callPatterns ?? []) {
      activity.push(familyId + "|call:" + pattern.id);
    }
  }
  return Object.freeze({
    startup: Object.freeze([...new Set(startup)].sort()),
    activity: Object.freeze([...new Set(activity)].sort()),
  });
}

/** The sole catalog-issued historical activity plan consumed by the scanner. */
export function strictCatalogActivityPlan(): Readonly<{
  readonly logTopics: readonly string[];
  readonly callPatterns: readonly StrictCatalogCallPattern[];
  readonly coverageKeys: readonly string[];
}> {
  return Object.freeze({
    logTopics: strictCatalogLogTopics(),
    callPatterns: strictCatalogCallPatterns(),
    coverageKeys: strictCatalogSourceCoverageKeys().activity,
  });
}

/** Physical read policy bound into the unified activity-plan fingerprint. */
export const SOURCE_SCAN_BATCH_BLOCKS = 500;
export const SOURCE_MIN_CHUNK_BLOCKS = 64;
export const SOURCE_SCAN_CONCURRENCY = 4;
export const SOURCE_TRACE_SCAN_CONCURRENCY = 16;
export const SOURCE_TRACE_SCAN_MAX_ATTEMPTS = 3;
export const REVERSE_BINDING_CONCURRENCY = 24;

/**
 * Ordered current-code identity of every strict family. Any capability
 * content hash change (identity/discovery/capture/...), pattern declaration
 * change or decoder change alters these hashes, so a plan fingerprint bound
 * to them fails closed on resume whenever the sealing code differs from the
 * current catalog.
 */
export function strictFamilyDefinitionHashes(): readonly string[] {
  return PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
    .listAll()
    .map((family) => family.plugin.manifest.familyId)
    .sort()
    .map((familyId) => familyDefinitionHash(familyId));
}

/**
 * Source-plan authority across all Families: only discovery-surface hashes.
 * pricing/exact/execution-only deploys keep the plan fingerprints stable, so
 * an incumbent fixed run resumes without a historical rescan.
 */
export function strictFamilyDiscoveryDefinitionHashes(): readonly string[] {
  return PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
    .listAll()
    .map((family) => family.plugin.manifest.familyId)
    .sort()
    .map((familyId) => familyDiscoveryDefinitionHash(familyId));
}

/**
 * Plan identity of the startup nomination source. Binds code identity only:
 * coverage keys + current family definitions. The input snapshot itself is
 * bound by the receipt's observationSetHash; a startup-universe key proves
 * the nomination partition was consumed and attested, never that no chain
 * instance exists outside it (enumerator/omission authority is absent).
 */
export function startupSourcePlanFingerprint(input: {
  readonly coverageKeys: readonly string[];
  readonly familyDefinitionHashes: readonly string[];
}): string {
  return digest("source-plan-v1:" + canonicalJson({
    sourceKind: "startup-candidate-union",
    coverageKeys: input.coverageKeys,
    familyDefinitionHashes: input.familyDefinitionHashes,
  }));
}

/**
 * One source-plan identity for the complete catalog activity scan. Logs and
 * calls may use different RPC transports, but they share one range, one
 * candidate feed and one atomic completion receipt. A change to either
 * Family-declared surface moves this fingerprint and forces a same-range
 * rescan before the run may publish Ready.
 */
export function catalogActivitySourcePlanFingerprint(input: {
  readonly topics: readonly string[];
  readonly callPatterns: readonly StrictCatalogCallPattern[];
  readonly coverageKeys: readonly string[];
  readonly familyDefinitionHashes: readonly string[];
}): string {
  return digest("source-plan-v1:" + canonicalJson({
    sourceKind: "catalog-activity-union",
    topics: input.topics,
    callPatterns: input.callPatterns,
    coverageKeys: input.coverageKeys,
    familyDefinitionHashes: input.familyDefinitionHashes,
    logReadMethod: "eth_getLogs",
    initialLogChunkBlocks: SOURCE_SCAN_BATCH_BLOCKS,
    minimumLogChunkBlocks: SOURCE_MIN_CHUNK_BLOCKS,
    maxConcurrentLogChunks: SOURCE_SCAN_CONCURRENCY,
    traceMethods: ["trace_block", "debug_traceBlockByNumber"],
    traceRpcBatchMaxCount: 1,
    maxConcurrentTraceBlocks: SOURCE_TRACE_SCAN_CONCURRENCY,
    maxTraceAttemptsPerBlock: SOURCE_TRACE_SCAN_MAX_ATTEMPTS,
  }));
}

/** Current expected plan fingerprints for nomination and unified activity. */
export function expectedSourcePlanFingerprints(): {
  readonly startup: string;
  readonly activity: string;
} {
  const coverageKeys = strictCatalogSourceCoverageKeys();
  const activityPlan = strictCatalogActivityPlan();
  const familyDefinitionHashes = strictFamilyDiscoveryDefinitionHashes();
  return Object.freeze({
    startup: startupSourcePlanFingerprint({
      coverageKeys: coverageKeys.startup,
      familyDefinitionHashes,
    }),
    activity: catalogActivitySourcePlanFingerprint({
      topics: activityPlan.logTopics,
      callPatterns: activityPlan.callPatterns,
      coverageKeys: activityPlan.coverageKeys,
      familyDefinitionHashes,
    }),
  });
}

export function familyForObservation(
  observation: {
    readonly address: string;
    readonly topics?: readonly string[];
    readonly data: string;
  },
): string | null {
  const matches = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.matches(
    Object.freeze({
      kind: "log",
      source: Object.freeze({ number: 0, hash: "", generation: 0 }),
      address: observation.address.toLowerCase(),
      topics: Object.freeze([...(observation.topics ?? [])]),
      data: observation.data,
    }) as never,
  );
  return matches[0]?.familyId ?? null;
}

function candidateForFamilyObservation(
  log: RebuildScanObservation,
  familyId: string,
  patternId: string,
): Readonly<Record<string, unknown>> | null {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
    .forStrictFamily(familyId as never);
  const discovery = "discovery" in family.plugin
    ? family.plugin.discovery
    : undefined;
  if (discovery === undefined) return null;
  const pattern = discovery?.logPatterns?.find((item) => item.id === patternId);
  const emitter = pattern?.emitter;
  const observation = Object.freeze({
    kind: "log",
    source: Object.freeze({
      number: log.blockNumber ?? 0,
      hash: log.blockHash ?? "0x" + "00".repeat(32),
      generation: log.blockNumber ?? 0,
    }),
    address: log.address.toLowerCase(),
    topics: Object.freeze([...(log.topics ?? [])]),
    data: log.data,
    ...(log.transactionHash === undefined
      ? {}
      : { transactionHash: log.transactionHash }),
  });
  const decoded = discovery.decodeCandidate({
    observation: observation as never,
    matchedPatternId: patternId,
  });
  // Mutation-only logs (for example a V4 Swap carrying poolId but no
  // PoolKey) are deliberately not nominations. They can update an already
  // explicit universe instance, but cannot create one from partial data.
  if (decoded === null) return null;
  const decodedRecord = typeof decoded === "object" && decoded !== null
    ? decoded as Readonly<Record<string, unknown>>
    : Object.freeze({ opaqueCandidate: decoded });
  const pluginCandidateKey = discovery.candidateKey(decoded as never);
  let address = /^0x[0-9a-fA-F]{40}$/.test(pluginCandidateKey)
    ? pluginCandidateKey.toLowerCase()
    : log.address.toLowerCase();
  if (
    emitter?.mode === "singleton-indexed-address"
  ) {
    const indexed = log.topics[emitter.topicIndex];
    if (indexed !== undefined && /^0x[0-9a-fA-F]{64}$/.test(indexed)) {
      address = ("0x" + indexed.slice(-40)).toLowerCase();
    }
  } else if (emitter?.mode === "singleton-indexed-bytes32") {
    address = emitter.address.toLowerCase();
  }
  return Object.freeze({
    ...decodedRecord,
    address,
    pluginCandidateKey,
    familyId,
    adapter: adapterLabelForFamily(familyId),
    ...(log.transactionHash === undefined
      ? {}
      : { transactionHash: log.transactionHash.toLowerCase() }),
    ...(log.blockNumber === undefined ? {} : { blockNumber: log.blockNumber }),
    ...(log.blockHash === undefined
      ? {}
      : { blockHash: log.blockHash.toLowerCase() }),
    ...(log.logIndex === undefined ? {} : { logIndex: log.logIndex }),
  });
}

export function candidatesFromLog(
  log: RebuildScanObservation,
): readonly Readonly<Record<string, unknown>>[] {
  const matches = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.matches(
    Object.freeze({
      kind: "log",
      source: Object.freeze({
        number: log.blockNumber ?? 0,
        hash: log.blockHash ?? "0x" + "00".repeat(32),
        generation: log.blockNumber ?? 0,
      }),
      address: log.address.toLowerCase(),
      topics: Object.freeze([...(log.topics ?? [])]),
      data: log.data,
      ...(log.transactionHash === undefined
        ? {}
        : { transactionHash: log.transactionHash }),
    }) as never,
  );
  return Object.freeze(matches.flatMap((match) => {
    const candidate = candidateForFamilyObservation(
      log,
      match.familyId,
      match.patternId,
    );
    return candidate === null ? [] : [candidate];
  }));
}

/** Full log identity dedupe (block + txHash + logIndex + address + topics). */
export function fullLogIdentityKey(log: RebuildScanObservation): string {
  return "log:" + (log.blockNumber ?? "?") + ":" +
    (log.blockHash?.toLowerCase() ?? "") + ":" +
    (log.transactionHash ?? "") + ":" +
    (log.logIndex ?? "?") + ":" +
    log.address.toLowerCase() + ":" +
    (log.topics ?? []).map((topic) => topic.toLowerCase()).join(",");
}

export function candidateFromLog(
  log: RebuildScanObservation,
): Readonly<Record<string, unknown>> {
  return candidatesFromLog(log)[0] ?? Object.freeze({
    address: log.address.toLowerCase(),
    familyId: "unknown-family",
  });
}

function candidateForFamilyCallObservation(
  call: RebuildCallObservation,
  familyId: string,
  patternId: string,
): Readonly<Record<string, unknown>> | null {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
    .forStrictFamily(familyId as never);
  if (!("discovery" in family.plugin)) return null;
  const discovery = family.plugin.discovery;
  const decoded = discovery.decodeCandidate({
    observation: Object.freeze({
      kind: "call" as const,
      source: Object.freeze({
        number: call.blockNumber,
        hash: call.blockHash,
        generation: call.blockNumber,
      }),
      target: call.target,
      data: call.data,
      ...(call.sender === undefined ? {} : { sender: call.sender }),
      transactionHash: call.transactionHash,
    }) as never,
    matchedPatternId: patternId,
  });
  if (decoded === null) return null;
  const decodedRecord = typeof decoded === "object" && decoded !== null
    ? decoded as Readonly<Record<string, unknown>>
    : Object.freeze({ opaqueCandidate: decoded });
  return Object.freeze({
    ...decodedRecord,
    address: call.target.toLowerCase(),
    pluginCandidateKey: discovery.candidateKey(decoded as never),
    familyId,
    adapter: adapterLabelForFamily(familyId),
    transactionHash: call.transactionHash.toLowerCase(),
    blockNumber: call.blockNumber,
    blockHash: call.blockHash.toLowerCase(),
  });
}

export function candidatesFromCall(
  call: RebuildCallObservation,
): readonly Readonly<Record<string, unknown>>[] {
  const matches = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.matches(
    Object.freeze({
      kind: "call" as const,
      source: Object.freeze({
        number: call.blockNumber,
        hash: call.blockHash,
        generation: call.blockNumber,
      }),
      target: call.target,
      data: call.data,
      ...(call.sender === undefined ? {} : { sender: call.sender }),
      transactionHash: call.transactionHash,
    }) as never,
  );
  return Object.freeze(matches.flatMap((match) => {
    const candidate = candidateForFamilyCallObservation(
      call,
      match.familyId,
      match.patternId,
    );
    return candidate === null ? [] : [candidate];
  }));
}

export function fullCallIdentityKey(call: RebuildCallObservation): string {
  return "call:" + call.blockNumber + ":" + call.blockHash.toLowerCase() +
    ":" + call.transactionHash.toLowerCase() + ":" +
    call.traceAddress.join(".") + ":" + call.target.toLowerCase() + ":" +
    call.data.slice(0, 10).toLowerCase();
}

function adapterLabelForFamily(familyId: string | null): string | undefined {
  if (familyId === null) return undefined;
  try {
    const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
      .forStrictFamily(familyId as never);
    return family.plugin.manifest.poolAdapterIds?.[0] ??
      family.plugin.manifest.ownedActionAdapterIds[0];
  } catch {
    return undefined;
  }
}

export function rebuildFamilyCandidateKey(
  candidate: Readonly<Record<string, unknown>>,
): string {
  const familyId = typeof candidate.familyId === "string"
    ? candidate.familyId
    : "unknown-family";
  return hashFamilyCandidateKey(familyId, candidateInstanceIdentity(candidate));
}

/**
 * Pre-partition alias key. A Family may expose several evidence spellings for
 * one instance; its plugin-owned instanceNominationKey collapses them before
 * lifecycle work. Families without that capability retain their ordinary
 * candidate identity. The central layer never interprets protocol fields.
 */
export function rebuildFamilyInstanceDedupeKey(
  candidate: Readonly<Record<string, unknown>>,
): string {
  const familyId = typeof candidate.familyId === "string"
    ? candidate.familyId
    : "unknown-family";
  let identity = candidateInstanceIdentity(candidate);
  try {
    const family = (() => {
      try {
        return PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
          .forStrictFamily(familyId as never);
      } catch {
        return PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
          .forStrictFamily(familyIdForCandidate(candidate) as never);
      }
    })();
    if (
      "discovery" in family.plugin &&
      family.plugin.discovery.instanceNominationKey !== undefined
    ) {
      identity = family.plugin.discovery.instanceNominationKey(candidate);
    }
  } catch {
    // Unknown/synthetic candidates keep the generic candidate identity.
  }
  return hashFamilyCandidateKey(familyId, identity);
}

function preferCandidateRepresentative(
  incumbent: Readonly<Record<string, unknown>>,
  candidate: Readonly<Record<string, unknown>>,
): boolean {
  const incumbentBlock = Number.isSafeInteger(incumbent.blockNumber)
    ? Number(incumbent.blockNumber)
    : -1;
  const candidateBlock = Number.isSafeInteger(candidate.blockNumber)
    ? Number(candidate.blockNumber)
    : -1;
  if (candidateBlock !== incumbentBlock) return candidateBlock > incumbentBlock;
  const evidenceScore = (value: Readonly<Record<string, unknown>>): number =>
    Number(typeof value.transactionHash === "string") +
    Number(typeof value.blockHash === "string") +
    Number(Number.isSafeInteger(value.logIndex)) +
    Number(typeof value.pluginCandidateKey === "string");
  const incumbentEvidence = evidenceScore(incumbent);
  const candidateEvidence = evidenceScore(candidate);
  if (candidateEvidence !== incumbentEvidence) {
    return candidateEvidence > incumbentEvidence;
  }
  return candidateFingerprint(candidate).localeCompare(
    candidateFingerprint(incumbent),
  ) < 0;
}

export function candidateFingerprint(
  candidate: Readonly<Record<string, unknown>>,
): string {
  return digest("candidate-fp-v1:" + canonicalJson({
    address: candidate.address,
    ...(candidate.poolId === undefined ? {} : { poolId: candidate.poolId }),
    ...(candidate.adapter === undefined ? {} : { adapter: candidate.adapter }),
    ...(candidate.familyId === undefined
      ? {}
      : { familyId: candidate.familyId }),
    ...(candidate.pluginCandidateKey === undefined
      ? {}
      : { pluginCandidateKey: candidate.pluginCandidateKey }),
  }));
}

/**
 * Pure local memo binding check (no RPC): Family id, candidate fingerprint,
 * memo-scoped (or legacy full-scope) definition hash, proof policy and the
 * proof-source bound. Any mismatch makes the memo unusable without touching
 * the chain; the authority/proof revalidation only runs when this passes.
 */
export function memoCheapBindingValid(input: {
  readonly memo: DurableVerifiedMemo;
  readonly candidate: Readonly<Record<string, unknown>>;
  readonly cutoff: CanonicalSource;
  readonly familyId: string;
}): boolean {
  if (input.memo.familyId !== input.familyId) return false;
  if (input.memo.candidateFingerprint !== candidateFingerprint(input.candidate)) {
    return false;
  }
  // Memos sealed before the discovery/memo hash split carry the full
  // familyDefinitionHash; memos sealed after carry the memo-scoped hash.
  // Accept either: the full-scheme branch stays conservative (any capability
  // change invalidates such a memo), the memo-scoped branch is the narrow
  // authority (exact/execution changes do not invalidate identity memos).
  const definitionMatches =
    input.memo.familyDefinitionHash === familyDefinitionHash(input.familyId) ||
    input.memo.familyDefinitionHash === familyMemoDefinitionHash(input.familyId);
  if (!definitionMatches) return false;
  if (input.memo.validity.policy !== "immutable-code") return false;
  if (input.memo.validity.proofSource.number > input.cutoff.number) return false;
  return input.memo.validity.proofSource.number !== input.cutoff.number ||
    input.memo.validity.proofSource.hash.toLowerCase() ===
      input.cutoff.hash.toLowerCase();
}

export function canReuseMemo(input: {
  readonly memo: DurableVerifiedMemo;
  readonly candidate: Readonly<Record<string, unknown>>;
  readonly cutoff: CanonicalSource;
  readonly familyId: string;
  readonly currentAuthorityFingerprint: string;
}): boolean {
  if (!memoCheapBindingValid(input)) return false;
  return input.memo.validity.authorityFingerprint ===
    input.currentAuthorityFingerprint;
}

type CatalogCallTraceMethod =
  | "trace_block"
  | "debug_traceBlockByNumber";

async function selectCatalogCallTraceMethod(
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
): Promise<CatalogCallTraceMethod> {
  const failures: string[] = [];
  for (const method of [
    "trace_block",
    "debug_traceBlockByNumber",
  ] as const) {
    try {
      const raw = await requestCallTraceBlock(provider, method, blockNumber);
      if (!Array.isArray(raw)) {
        throw new Error("returned a non-array result");
      }
      return method;
    } catch (error) {
      failures.push(
        method + ":" + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  throw new Error(
    "catalog observed-call scan requires trace_block or " +
      "debug_traceBlockByNumber: " + failures.join(" | "),
  );
}

async function requestCallTraceBlock(
  provider: ethers.JsonRpcProvider,
  method: CatalogCallTraceMethod,
  blockNumber: number,
): Promise<unknown> {
  const tag = ethers.toQuantity(blockNumber);
  return method === "trace_block"
    ? provider.send(method, [tag])
    : provider.send(method, [tag, Object.freeze({ tracer: "callTracer" })]);
}

async function requestCallTraceBlockWithRetry(
  provider: ethers.JsonRpcProvider,
  method: CatalogCallTraceMethod,
  blockNumber: number,
): Promise<unknown> {
  let lastCode = "unknown";
  for (
    let attempt = 1;
    attempt <= SOURCE_TRACE_SCAN_MAX_ATTEMPTS;
    attempt++
  ) {
    try {
      return await requestCallTraceBlock(provider, method, blockNumber);
    } catch (error) {
      lastCode = catalogTraceErrorCode(error);
      if (attempt === SOURCE_TRACE_SCAN_MAX_ATTEMPTS) break;
      console.log(
        "[universe-rebuild/activity-scan] transport=trace retry block=" +
          blockNumber + " attempt=" + (attempt + 1) + "/" +
          SOURCE_TRACE_SCAN_MAX_ATTEMPTS + " code=" + lastCode,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw new Error(
    "catalog call trace failed method=" + method + " block=" + blockNumber +
      " attempts=" + SOURCE_TRACE_SCAN_MAX_ATTEMPTS + " code=" + lastCode,
  );
}

function catalogTraceErrorCode(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") {
      return String(code).slice(0, 40);
    }
  }
  return "unknown";
}

/** Physical trace reader used only inside the unified activity scan. */
async function readDeclaredCallActivity(input: {
  readonly provider: ethers.JsonRpcProvider;
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly selectors: ReadonlySet<string>;
  readonly logs: readonly RebuildScanObservation[];
}): Promise<{
  readonly calls: readonly RebuildCallObservation[];
  readonly method: CatalogCallTraceMethod;
  readonly observedCallCount: number;
  readonly observationSetHash: string;
  readonly completedChunks: readonly DurableSourceChunkReceipt[];
}> {
  const method = await selectCatalogCallTraceMethod(
    input.provider,
    input.toBlock,
  );
  console.log(
    "[universe-rebuild/activity-scan] transport=trace method=" + method +
      " range=" +
      input.fromBlock + "-" + input.toBlock,
  );
  const digestState = beginCatalogActivityDigest({
    fromBlock: input.fromBlock,
    toBlock: input.toBlock,
    logs: input.logs,
  });
  const representativeByCandidate = new Map<string, {
    readonly call: RebuildCallObservation;
    readonly candidate: Readonly<Record<string, unknown>>;
  }>();
  const totalBlocks = input.toBlock - input.fromBlock + 1;
  let completedBlocks = 0;
  let observedCallCount = 0;
  let chunkIndex = 0;
  for (
    let chunkFrom = input.fromBlock;
    chunkFrom <= input.toBlock;
    chunkFrom += SOURCE_SCAN_BATCH_BLOCKS
  ) {
    const chunkTo = Math.min(
      input.toBlock,
      chunkFrom + SOURCE_SCAN_BATCH_BLOCKS - 1,
    );
    const chunkStartedAtMs = Date.now();
    for (
      let groupFrom = chunkFrom;
      groupFrom <= chunkTo;
      groupFrom += SOURCE_TRACE_SCAN_CONCURRENCY
    ) {
      const groupTo = Math.min(
        chunkTo,
        groupFrom + SOURCE_TRACE_SCAN_CONCURRENCY - 1,
      );
      const group = await Promise.all(Array.from(
        { length: groupTo - groupFrom + 1 },
        async (_value, index) => {
          const blockNumber = groupFrom + index;
          const raw = await requestCallTraceBlockWithRetry(
            input.provider,
            method,
            blockNumber,
          );
          return callsFromTraceBlock({
            provider: input.provider,
            method,
            raw,
            blockNumber,
            selectors: input.selectors,
          });
        },
      ));
      for (const blockCalls of group) {
        const orderedCalls = [...blockCalls].sort(compareRebuildCalls);
        for (const call of orderedCalls) {
          appendCatalogActivityCall(digestState, chunkIndex, call);
          observedCallCount++;
          for (const candidate of candidatesFromCall(call)) {
            const key = rebuildFamilyInstanceDedupeKey(candidate);
            const incumbent = representativeByCandidate.get(key);
            if (
              incumbent === undefined ||
              preferCandidateRepresentative(incumbent.candidate, candidate)
            ) {
              representativeByCandidate.set(key, Object.freeze({
                call,
                candidate,
              }));
            }
          }
        }
      }
    }
    completedBlocks += chunkTo - chunkFrom + 1;
    console.log(
      "[universe-rebuild/activity-scan] transport=trace completed=" +
        completedBlocks + "/" +
        totalBlocks + " observedCalls=" + observedCallCount +
        " retainedCandidates=" + representativeByCandidate.size +
        " elapsedMs=" +
        (Date.now() - chunkStartedAtMs),
    );
    chunkIndex++;
  }
  const retainedCalls = new Map<string, RebuildCallObservation>();
  for (const { call } of representativeByCandidate.values()) {
    retainedCalls.set(fullCallIdentityKey(call), call);
  }
  const calls = [...retainedCalls.values()].sort(compareRebuildCalls);
  const digests = finishCatalogActivityDigest(digestState);
  return Object.freeze({
    calls: Object.freeze(calls),
    method,
    observedCallCount,
    observationSetHash: digests.observationSetHash,
    completedChunks: digests.completedChunks,
  });
}

async function callsFromTraceBlock(input: {
  readonly provider: ethers.JsonRpcProvider;
  readonly method: CatalogCallTraceMethod;
  readonly raw: unknown;
  readonly blockNumber: number;
  readonly selectors: ReadonlySet<string>;
}): Promise<readonly RebuildCallObservation[]> {
  if (!Array.isArray(input.raw)) {
    throw new Error(
      input.method + " returned a non-array at block " + input.blockNumber,
    );
  }
  if (input.method === "trace_block") {
    return callsFromParityTrace(input.raw, input.blockNumber, input.selectors);
  }
  const pending: Omit<RebuildCallObservation, "blockHash">[] = [];
  for (const rawTransaction of input.raw) {
    if (
      rawTransaction === null || typeof rawTransaction !== "object" ||
      Array.isArray(rawTransaction)
    ) throw new Error("catalog debug trace contains a malformed transaction");
    const transaction = rawTransaction as Readonly<Record<string, unknown>>;
    if (transaction.error !== undefined && transaction.error !== null) {
      throw new Error("catalog debug trace transaction failed");
    }
    const txHash = string32(transaction.txHash ?? transaction.transactionHash);
    if (txHash === null) {
      throw new Error("catalog debug trace transaction hash is missing");
    }
    collectDebugCallFrames({
      raw: transaction.result,
      txHash,
      blockNumber: input.blockNumber,
      selectors: input.selectors,
      traceAddress: Object.freeze([]),
      out: pending,
    });
  }
  if (pending.length === 0) return Object.freeze([]);
  const block = await input.provider.getBlock(input.blockNumber);
  if (block === null || block.hash === null || block.number !== input.blockNumber) {
    throw new Error(
      "catalog call scan cannot bind block hash " + input.blockNumber,
    );
  }
  const blockHash = block.hash.toLowerCase();
  return Object.freeze(pending.map((call) => Object.freeze({
    ...call,
    blockHash,
  })));
}

function callsFromParityTrace(
  raw: readonly unknown[],
  expectedBlockNumber: number,
  selectors: ReadonlySet<string>,
): readonly RebuildCallObservation[] {
  const calls: RebuildCallObservation[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Readonly<Record<string, unknown>>;
    if (record.type !== "call") continue;
    const action = record.action;
    if (action === null || typeof action !== "object" || Array.isArray(action)) {
      continue;
    }
    const call = action as Readonly<Record<string, unknown>>;
    const callType = typeof call.callType === "string"
      ? call.callType.toLowerCase()
      : "call";
    if (callType === "delegatecall" || callType === "callcode") continue;
    const target = address(call.to);
    const data = callData(call.input);
    const transactionHash = string32(record.transactionHash);
    const blockHash = string32(record.blockHash);
    const blockNumber = rpcNumber(record.blockNumber);
    if (
      target === null || data === null ||
      !selectors.has(data.slice(0, 10).toLowerCase()) ||
      transactionHash === null || blockHash === null ||
      blockNumber !== expectedBlockNumber
    ) continue;
    calls.push(Object.freeze({
      kind: "call" as const,
      target,
      data,
      ...(address(call.from) === null ? {} : { sender: address(call.from)! }),
      transactionHash,
      blockNumber,
      blockHash,
      traceAddress: traceAddress(record.traceAddress),
    }));
  }
  return Object.freeze(calls);
}

function collectDebugCallFrames(input: {
  readonly raw: unknown;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly selectors: ReadonlySet<string>;
  readonly traceAddress: readonly number[];
  readonly out: Omit<RebuildCallObservation, "blockHash">[];
}): void {
  if (input.raw === null || typeof input.raw !== "object" ||
      Array.isArray(input.raw)) {
    throw new Error("catalog debug trace contains a malformed call frame");
  }
  const frame = input.raw as Readonly<Record<string, unknown>>;
  const target = address(frame.to);
  const data = callData(frame.input);
  const callType = typeof frame.type === "string"
    ? frame.type.toLowerCase()
    : "call";
  if (
    target === null &&
    (frame.to !== undefined || (callType !== "create" && callType !== "create2"))
  ) {
    throw new Error("catalog debug trace contains a malformed call target");
  }
  if (frame.input !== undefined && !ethers.isHexString(frame.input)) {
    throw new Error("catalog debug trace contains malformed call data");
  }
  if (
    target !== null && data !== null &&
    callType !== "delegatecall" && callType !== "callcode" &&
    input.selectors.has(data.slice(0, 10).toLowerCase())
  ) {
    const sender = address(frame.from);
    input.out.push(Object.freeze({
      kind: "call" as const,
      target,
      data,
      ...(sender === null ? {} : { sender }),
      transactionHash: input.txHash,
      blockNumber: input.blockNumber,
      traceAddress: Object.freeze([...input.traceAddress]),
    }));
  }
  if (frame.calls === undefined) return;
  if (!Array.isArray(frame.calls)) {
    throw new Error("catalog debug trace contains malformed nested calls");
  }
  frame.calls.forEach((child, index) => collectDebugCallFrames({
    ...input,
    raw: child,
    traceAddress: Object.freeze([...input.traceAddress, index]),
  }));
}

function address(value: unknown): string | null {
  return typeof value === "string" && ethers.isAddress(value)
    ? ethers.getAddress(value).toLowerCase()
    : null;
}

function callData(value: unknown): string | null {
  return typeof value === "string" && ethers.isHexString(value) &&
      value.length >= 10
    ? value.toLowerCase()
    : null;
}

function string32(value: unknown): string | null {
  return typeof value === "string" && ethers.isHexString(value, 32)
    ? value.toLowerCase()
    : null;
}

function rpcNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    return null;
  }
  const parsed = Number(BigInt(value));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function traceAddress(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  if (value.some((item) => !Number.isSafeInteger(item) || Number(item) < 0)) {
    return Object.freeze([]);
  }
  return Object.freeze(value.map(Number));
}

function compareRebuildCalls(
  left: RebuildCallObservation,
  right: RebuildCallObservation,
): number {
  return left.blockNumber - right.blockNumber ||
    left.transactionHash.localeCompare(right.transactionHash) ||
    left.traceAddress.join(".").localeCompare(right.traceAddress.join(".")) ||
    left.target.localeCompare(right.target) ||
    left.data.localeCompare(right.data);
}

function normalizedActivityLog(
  log: RebuildScanObservation,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    kind: "log",
    address: log.address.toLowerCase(),
    topics: Object.freeze(log.topics.map((topic) => topic.toLowerCase())),
    data: log.data.toLowerCase(),
    transactionHash: log.transactionHash?.toLowerCase() ?? null,
    blockNumber: log.blockNumber ?? null,
    blockHash: log.blockHash?.toLowerCase() ?? null,
    logIndex: log.logIndex ?? null,
  });
}

function updateActivityDigest(
  hash: ReturnType<typeof createHash>,
  observation: RebuildScanObservation | RebuildCallObservation,
): void {
  const call = (observation as { readonly kind?: unknown }).kind === "call";
  hash.update(canonicalJson(
    call
      ? observation as RebuildCallObservation
      : normalizedActivityLog(observation as RebuildScanObservation),
  ));
  hash.update(String.fromCharCode(0));
}

interface CatalogActivityChunkDigestState {
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly hash: ReturnType<typeof createHash>;
  resultCount: number;
}

interface CatalogActivityDigestState {
  readonly observationHash: ReturnType<typeof createHash>;
  readonly chunks: readonly CatalogActivityChunkDigestState[];
}

function beginCatalogActivityDigest(input: {
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly logs: readonly RebuildScanObservation[];
}): CatalogActivityDigestState {
  const observationHash = createHash("sha256");
  observationHash.update("catalog-activity-observations-v1:");
  for (const log of input.logs) updateActivityDigest(observationHash, log);

  const chunks: CatalogActivityChunkDigestState[] = [];
  let logIndex = 0;
  for (
    let fromBlock = input.fromBlock;
    fromBlock <= input.toBlock;
    fromBlock += SOURCE_SCAN_BATCH_BLOCKS
  ) {
    const toBlock = Math.min(
      input.toBlock,
      fromBlock + SOURCE_SCAN_BATCH_BLOCKS - 1,
    );
    const hash = createHash("sha256");
    hash.update("catalog-activity-chunk-v1:");
    let resultCount = 0;
    while (logIndex < input.logs.length) {
      const log = input.logs[logIndex];
      if (!Number.isSafeInteger(log.blockNumber)) {
        throw new Error("catalog activity log has no canonical block number");
      }
      if (log.blockNumber! > toBlock) break;
      if (log.blockNumber! < fromBlock) {
        throw new Error("catalog activity logs are outside ordered scan range");
      }
      updateActivityDigest(hash, log);
      resultCount++;
      logIndex++;
    }
    chunks.push({ fromBlock, toBlock, hash, resultCount });
  }
  if (logIndex !== input.logs.length) {
    throw new Error("catalog activity logs escaped the scan range");
  }
  return { observationHash, chunks };
}

function appendCatalogActivityCall(
  state: CatalogActivityDigestState,
  chunkIndex: number,
  call: RebuildCallObservation,
): void {
  const chunk = state.chunks[chunkIndex];
  if (
    chunk === undefined || call.blockNumber < chunk.fromBlock ||
    call.blockNumber > chunk.toBlock
  ) {
    throw new Error("catalog activity call escaped the scan range");
  }
  updateActivityDigest(state.observationHash, call);
  updateActivityDigest(chunk.hash, call);
  chunk.resultCount++;
}

function finishCatalogActivityDigest(
  state: CatalogActivityDigestState,
): Readonly<{
  readonly observationSetHash: string;
  readonly completedChunks: readonly DurableSourceChunkReceipt[];
}> {
  return Object.freeze({
    observationSetHash: state.observationHash.digest("hex"),
    completedChunks: Object.freeze(state.chunks.map((chunk) => Object.freeze({
      fromBlock: chunk.fromBlock,
      toBlock: chunk.toBlock,
      resultCount: chunk.resultCount,
      resultHash: chunk.hash.digest("hex"),
    }))),
  });
}

function catalogActivityObservationHash(
  logs: readonly RebuildScanObservation[],
  calls: readonly RebuildCallObservation[],
): string {
  const hash = createHash("sha256");
  hash.update("catalog-activity-observations-v1:");
  for (const log of logs) updateActivityDigest(hash, log);
  for (const call of calls) updateActivityDigest(hash, call);
  return hash.digest("hex");
}

function catalogActivityChunks(input: {
  readonly ranges: readonly {
    readonly fromBlock: number;
    readonly toBlock: number;
  }[];
  readonly logs: readonly RebuildScanObservation[];
  readonly calls: readonly RebuildCallObservation[];
}): readonly DurableSourceChunkReceipt[] {
  let logIndex = 0;
  let callIndex = 0;
  const chunks: DurableSourceChunkReceipt[] = [];
  for (const range of input.ranges) {
    const hash = createHash("sha256");
    hash.update("catalog-activity-chunk-v1:");
    let resultCount = 0;
    while (logIndex < input.logs.length) {
      const log = input.logs[logIndex];
      if (!Number.isSafeInteger(log.blockNumber)) {
        throw new Error("catalog activity log has no canonical block number");
      }
      if (log.blockNumber! > range.toBlock) break;
      if (log.blockNumber! < range.fromBlock) {
        throw new Error("catalog activity logs are outside ordered scan range");
      }
      updateActivityDigest(hash, log);
      resultCount++;
      logIndex++;
    }
    while (callIndex < input.calls.length) {
      const call = input.calls[callIndex];
      if (call.blockNumber > range.toBlock) break;
      if (call.blockNumber < range.fromBlock) {
        throw new Error("catalog activity calls are outside ordered scan range");
      }
      updateActivityDigest(hash, call);
      resultCount++;
      callIndex++;
    }
    chunks.push(Object.freeze({
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
      resultCount,
      resultHash: hash.digest("hex"),
    }));
  }
  if (logIndex !== input.logs.length || callIndex !== input.calls.length) {
    throw new Error("catalog activity observations escaped the scan range");
  }
  return Object.freeze(chunks);
}

export function createRebuildWiring(input?: {
  readonly rpcUrl?: string;
  readonly startupCandidates?: readonly Readonly<Record<string, unknown>>[];
}): UniverseRebuildDependencies {
  const rpcUrl = input?.rpcUrl ??
    process.env.SEARCHER_LIVE_RPC_URL ??
    process.env.MAINNET_RPC_URL;
  if (rpcUrl === undefined || rpcUrl.trim().length === 0) {
    throw new Error(
      "universe rebuild production wiring requires SEARCHER_LIVE_RPC_URL " +
        "or MAINNET_RPC_URL",
    );
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  // A trace response is already large. Ethers batches concurrent send()
  // calls by default, which couples sixteen block traces to one HTTP timeout.
  // Keep concurrency, but transport each block independently so one long tail
  // retries only that block.
  const traceProvider = new ethers.JsonRpcProvider(
    rpcUrl,
    ethers.Network.from(1),
    {
      staticNetwork: ethers.Network.from(1),
      batchMaxCount: 1,
    },
  );
  // Cross-run memo revalidation usually checks tens of thousands of
  // instances sealed at one shared proof source. The proof-source block hash
  // is a property of the fixed canonical chain, not of an individual
  // instance, so read it once per (current cutoff, proof block) instead of
  // issuing the same RPC once per memo. Including the current cutoff in the
  // key prevents a later rebuild from inheriting a value across a reorg; the
  // final cutoff assertion still fences the whole promotion atomically.
  const proofHashByFixedRun = new Map<string, Promise<string>>();
  const readMemoProofHash = (
    proofNumber: number,
    cutoff: CanonicalSource,
  ): Promise<string> => {
    const key = cutoff.number + ":" + cutoff.hash.toLowerCase() + ":" +
      proofNumber;
    const incumbent = proofHashByFixedRun.get(key);
    if (incumbent !== undefined) return incumbent;
    let pending: Promise<string>;
    pending = readBlockHash(provider, proofNumber).catch((error) => {
      if (proofHashByFixedRun.get(key) === pending) {
        proofHashByFixedRun.delete(key);
      }
      throw error;
    });
    proofHashByFixedRun.set(key, pending);
    return pending;
  };
  const activityPlan = strictCatalogActivityPlan();
  const topics = activityPlan.logTopics;
  const callPatterns = activityPlan.callPatterns;
  const callSelectors = new Set(callPatterns.map((pattern) => pattern.selector));
  const sourceCoverageKeys = strictCatalogSourceCoverageKeys();
  // reth caps eth_getLogs at 20000 results; the strict-topic union is
  // high-volume, so start small and halve on the max-results error. The
  // chunk policy is a plan-bound constant (SOURCE_SCAN_BATCH_BLOCKS /
  // SOURCE_MIN_CHUNK_BLOCKS): changing it moves the event plan fingerprint
  // and fails closed on resume. Call tracing is another physical transport
  // inside this same catalog activity plan, not a second discovery source.
  const probe = createProbeWiring({ rpcUrl });

  const wiring: UniverseRebuildDependencies = {
    encodeCandidateSnapshot: (candidate) =>
      encodeDurableValue(candidate),
    decodeCandidateSnapshot: (snapshot) =>
      decodeDurableValue(snapshot),
    upgradeLegacyVerifiedMemo,
    requiredSourceCoverageKeys: () => Object.freeze([
      ...sourceCoverageKeys.startup,
      ...activityPlan.coverageKeys,
    ]),
    // Current source-plan identity. Every durable receipt sealed by this
    // wiring carries queryFingerprint == plan fingerprint; resume rejects
    // receipts sealed by any other code version (audit P0-STOP-1).
    expectedSourcePlanFingerprints: () => expectedSourcePlanFingerprints(),
    freezeCanonicalHead: async (requestedBlock) => {
      const block = await provider.getBlock(requestedBlock ?? "latest");
      if (block === null || block.hash === null) {
        throw new Error(
          requestedBlock === undefined
            ? "canonical head unavailable"
            : "canonical cutoff unavailable: " + requestedBlock,
        );
      }
      return Object.freeze({
        number: block.number,
        hash: block.hash.toLowerCase(),
        generation: block.number,
      });
    },
    scanSwapWindow: async (scanInput) => {
      const logs: RebuildScanObservation[] = [];
      const totalBlocks = scanInput.cutoff.number - scanInput.fromBlock + 1;
      let completedBlocks = 0;
      const ranges: Array<{ readonly fromBlock: number; readonly toBlock: number }> = [];
      for (
        let start = scanInput.fromBlock;
        start <= scanInput.cutoff.number;
        start += SOURCE_SCAN_BATCH_BLOCKS
      ) {
        ranges.push(Object.freeze({
          fromBlock: start,
          toBlock: Math.min(
            scanInput.cutoff.number,
            start + SOURCE_SCAN_BATCH_BLOCKS - 1,
          ),
        }));
      }
      const topicFilter: Array<null | string | Array<string>> =
        topics.length === 1 ? [topics[0]] : [[...topics]];
      if (topics.length > 0) {
        // Keep at most four provider reads in flight, then merge completed
        // slices in block order. Parallel completion can never reorder the
        // unified activity digest.
        for (
          let groupStart = 0;
          groupStart < ranges.length;
          groupStart += SOURCE_SCAN_CONCURRENCY
        ) {
          const slices = await Promise.all(
            ranges.slice(groupStart, groupStart + SOURCE_SCAN_CONCURRENCY).map(
              async (range, groupIndex) => {
              const slice = groupStart + groupIndex + 1;
              const sliceLogs: RebuildScanObservation[] = [];
              let batchSize = range.toBlock - range.fromBlock + 1;
              let from = range.fromBlock;
              let attempt = 0;
              while (from <= range.toBlock) {
                const to = Math.min(
                  range.toBlock,
                  from + batchSize - 1,
                );
                attempt++;
                const requestStartedAtMs = Date.now();
                console.log(
                  "[universe-rebuild/scan] request slice=" + slice +
                    "/" + ranges.length +
                    " attempt=" + attempt +
                    " range=" + from + "-" + to +
                    " span=" + (to - from + 1),
                );
                try {
                  const batch = await provider.getLogs({
                    topics: topicFilter,
                    fromBlock: from,
                    toBlock: to,
                  });
                  for (const log of batch) {
                    sliceLogs.push(Object.freeze({
                      address: log.address.toLowerCase(),
                      topics: Object.freeze([...log.topics]),
                      data: log.data,
                      ...(log.transactionHash === undefined
                        ? {}
                        : {
                            transactionHash:
                              log.transactionHash.toLowerCase(),
                          }),
                      blockNumber: log.blockNumber,
                      ...(log.blockHash === undefined
                        ? {}
                        : { blockHash: log.blockHash.toLowerCase() }),
                      ...(log.index === undefined
                        ? {}
                        : { logIndex: log.index }),
                    }));
                  }
                  console.log(
                    "[universe-rebuild/scan] completed slice=" + slice +
                      "/" + ranges.length +
                      " attempt=" + attempt +
                      " range=" + from + "-" + to +
                      " logs=" + batch.length +
                      " elapsedMs=" + (Date.now() - requestStartedAtMs) +
                      " sliceLogs=" + sliceLogs.length,
                  );
                  from = to + 1;
                  batchSize = Math.min(
                    SOURCE_SCAN_BATCH_BLOCKS,
                    range.toBlock - from + 1,
                  );
                } catch (error) {
                  if (batchSize <= SOURCE_MIN_CHUNK_BLOCKS) {
                    throw new Error(
                      "swap window scan failed at " + from + "-" + to +
                        ": " + (error instanceof Error
                          ? error.message
                          : String(error)),
                    );
                  }
                  const nextBatchSize = Math.floor(batchSize / 2);
                  console.log(
                    "[universe-rebuild/scan] split slice=" + slice +
                      "/" + ranges.length +
                      " attempt=" + attempt +
                      " range=" + from + "-" + to +
                      " elapsedMs=" + (Date.now() - requestStartedAtMs) +
                      " nextSpan=" + nextBatchSize +
                      " reason=" + (error instanceof Error
                        ? error.message
                        : String(error)).slice(0, 240),
                  );
                  batchSize = nextBatchSize;
                }
              }
              return Object.freeze({
                range,
                logs: Object.freeze(sliceLogs),
              });
              },
            ),
          );
          for (const slice of slices) {
            for (const log of slice.logs) logs.push(log);
            completedBlocks += slice.range.toBlock - slice.range.fromBlock + 1;
          }
          console.log(
            "[universe-rebuild/scan] mergedSlices=" +
              Math.min(groupStart + slices.length, ranges.length) +
              "/" + ranges.length +
              " completedBlocks=" + completedBlocks + "/" + totalBlocks +
              " cumulativeLogs=" + logs.length,
          );
        }
      }
      const callScan = callPatterns.length === 0
        ? null
        : await readDeclaredCallActivity({
            provider: traceProvider,
            fromBlock: scanInput.fromBlock,
            toBlock: scanInput.cutoff.number,
            selectors: callSelectors,
            logs,
          });
      const mutableObservations: unknown[] = [];
      for (const candidate of input?.startupCandidates ?? []) {
        mutableObservations.push(Object.freeze({
          kind: "startup-candidate",
          candidate,
        }));
      }
      for (const log of logs) mutableObservations.push(log);
      for (const call of callScan?.calls ?? []) {
        mutableObservations.push(call);
      }
      const observations = Object.freeze(mutableObservations);
      const providerIdentity = digest("provider-v1:" + rpcUrl.trim());
      const startupSnapshot = Object.freeze(
        (input?.startupCandidates ?? []).map((candidate) =>
          encodeDurableValue(candidate)
        ),
      );
      // The plan fingerprint binds the current source implementation
      // (coverage keys + family code identity); the input snapshot itself is
      // bound by observationSetHash below. Resume compares queryFingerprint
      // against the current plan and fails closed on any code drift.
      const startupQueryFingerprint = startupSourcePlanFingerprint({
        coverageKeys: sourceCoverageKeys.startup,
        familyDefinitionHashes: strictFamilyDiscoveryDefinitionHashes(),
      });
      const startupObservationHash = digest(
        "startup-candidate-observations-v1:" + canonicalJson(startupSnapshot),
      );
      const receipts: DurableSourceReceipt[] = [Object.freeze({
        sourceKey: digest("source-key-v1:" + canonicalJson({
          sourceKind: "startup-candidate-union",
          providerIdentity: "startup-input-snapshot",
          queryFingerprint: startupQueryFingerprint,
          fromBlock: scanInput.fromBlock,
          toBlock: scanInput.cutoff.number,
          cutoffHash: scanInput.cutoff.hash,
        })),
        sourceKind: "startup-candidate-union" as const,
        providerIdentity: "startup-input-snapshot",
        queryFingerprint: startupQueryFingerprint,
        fromBlock: scanInput.fromBlock,
        toBlock: scanInput.cutoff.number,
        cutoffNumber: scanInput.cutoff.number,
        cutoffHash: scanInput.cutoff.hash,
        coverageKeys: sourceCoverageKeys.startup,
        completedChunks: Object.freeze([Object.freeze({
          fromBlock: scanInput.fromBlock,
          toBlock: scanInput.cutoff.number,
          resultCount: startupSnapshot.length,
          resultHash: startupObservationHash,
        })]),
        observationSetHash: startupObservationHash,
        observedThrough: Object.freeze({
          number: scanInput.cutoff.number,
          hash: scanInput.cutoff.hash,
        }),
        appliedThrough: Object.freeze({
          number: scanInput.cutoff.number,
          hash: scanInput.cutoff.hash,
        }),
        retryableCount: 0 as const,
        status: "complete" as const,
      })];
      if (activityPlan.coverageKeys.length > 0) {
        // One source plan and one receipt cover every Family-declared log and
        // call pattern over this exact range. Neither physical transport can
        // independently grant source coverage.
        const activityQueryFingerprint = catalogActivitySourcePlanFingerprint({
          topics,
          callPatterns,
          coverageKeys: activityPlan.coverageKeys,
          familyDefinitionHashes: strictFamilyDiscoveryDefinitionHashes(),
        });
        const calls = callScan?.calls ?? Object.freeze([]);
        const activityObservationHash = callScan?.observationSetHash ??
          catalogActivityObservationHash(logs, calls);
        receipts.push(Object.freeze({
          sourceKey: digest("source-key-v1:" + canonicalJson({
            sourceKind: "catalog-activity-union",
            providerIdentity,
            queryFingerprint: activityQueryFingerprint,
            fromBlock: scanInput.fromBlock,
            toBlock: scanInput.cutoff.number,
            cutoffHash: scanInput.cutoff.hash,
          })),
          sourceKind: "catalog-activity-union" as const,
          providerIdentity,
          queryFingerprint: activityQueryFingerprint,
          fromBlock: scanInput.fromBlock,
          toBlock: scanInput.cutoff.number,
          cutoffNumber: scanInput.cutoff.number,
          cutoffHash: scanInput.cutoff.hash,
          coverageKeys: activityPlan.coverageKeys,
          completedChunks: callScan?.completedChunks ??
            catalogActivityChunks({ ranges, logs, calls }),
          observationSetHash: activityObservationHash,
          observedThrough: Object.freeze({
            number: scanInput.cutoff.number,
            hash: scanInput.cutoff.hash,
          }),
          appliedThrough: Object.freeze({
            number: scanInput.cutoff.number,
            hash: scanInput.cutoff.hash,
          }),
          retryableCount: 0 as const,
          status: "complete" as const,
        }));
      }
      return Object.freeze({
        observations,
        sourceReceipts: Object.freeze(receipts),
      });
    },
    familyCandidateKey: (candidate) =>
      rebuildFamilyCandidateKey(
        candidate as Readonly<Record<string, unknown>>,
      ),
    dedupeFamilyCandidates: (observations) => {
      // Candidate dedupe is per pool (familyCandidateKey), NOT per log: the
      // fixed activity window may hold multiple Swap logs per pool, and the run
      // attests one Family+Instance once. Full log identity dedupe (audit
      // P0.6) still governs the observation feed; here the newest log per
      // pool becomes the representative candidate + evidence ref.
      const seenLogs = new Set<string>();
      const seenCalls = new Set<string>();
      const byKey = new Map<string, Readonly<Record<string, unknown>>>();
      for (const observation of observations) {
        if (
          typeof observation === "object" && observation !== null &&
          (observation as { kind?: unknown }).kind === "startup-candidate"
        ) {
          const raw = (observation as { candidate: Readonly<Record<string, unknown>> })
            .candidate;
          const familyId = typeof raw.familyId === "string"
            ? raw.familyId
            : familyIdForCandidate(raw);
          const candidate = Object.freeze({ ...raw, familyId });
          const key = rebuildFamilyInstanceDedupeKey(candidate);
          const existing = byKey.get(key);
          if (
            existing === undefined ||
            preferCandidateRepresentative(existing, candidate)
          ) {
            byKey.set(key, candidate);
          }
          continue;
        }
        if (
          typeof observation === "object" && observation !== null &&
          (observation as { kind?: unknown }).kind === "call"
        ) {
          const call = observation as RebuildCallObservation;
          const callKey = fullCallIdentityKey(call);
          if (seenCalls.has(callKey)) continue;
          seenCalls.add(callKey);
          for (const candidate of candidatesFromCall(call)) {
            const key = rebuildFamilyInstanceDedupeKey(candidate);
            const existing = byKey.get(key);
            if (
              existing === undefined ||
              preferCandidateRepresentative(existing, candidate)
            ) {
              byKey.set(key, candidate);
            }
          }
          continue;
        }
        const log = observation as RebuildScanObservation;
        const logKey = fullLogIdentityKey(log);
        if (seenLogs.has(logKey)) continue;
        seenLogs.add(logKey);
        for (const candidate of candidatesFromLog(log)) {
          const key = rebuildFamilyInstanceDedupeKey(candidate);
          const existing = byKey.get(key);
          if (
            existing === undefined ||
            preferCandidateRepresentative(existing, candidate)
          ) {
            byKey.set(key, candidate);
          }
        }
      }
      return Object.freeze([...byKey.values()]);
    },
    reverseBindOpaqueCandidates: async (reverseInput) => {
      // Retain-channel driver (central; no protocol semantics here). Opaque
      // nominations are derived purely from plugin-declared semantics: a log
      // pattern whose emitter mode "singleton-indexed-bytes32" declares that
      // the singleton carries the child's opaque id at topics[topicIndex],
      // for a Family that declares a reverseBinding implementation. Each
      // Family's reverseBinding re-materializes a real observation from chain
      // truth (no recent activity needed); verified observations re-enter
      // through the same catalog matching + decodeCandidate admission the
      // scan channel uses.
      const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
      const materializationKey = (
        familyId: string,
        candidate: Readonly<Record<string, unknown>>,
      ): string | null => {
        let family;
        try {
          family = catalog.forStrictFamily(familyId as never);
        } catch {
          return null;
        }
        if (!("discovery" in family.plugin)) return null;
        const discovery = family.plugin.discovery;
        if (discovery.reverseBinding?.kind !== "implementation") return null;
        if (discovery.instanceNominationKey === undefined) return null;
        try {
          const localKey = discovery.instanceNominationKey(candidate);
          return typeof localKey === "string" && localKey.trim().length > 0
            ? familyId + "\u001f" + localKey
            : null;
        } catch {
          return null;
        }
      };
      const knownMaterializations = new Set<string>();
      for (const raw of reverseInput.knownCandidates) {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          continue;
        }
        const candidate = raw as Readonly<Record<string, unknown>>;
        const familyId = typeof candidate.familyId === "string"
          ? candidate.familyId
          : familyIdForCandidate(candidate);
        const key = materializationKey(familyId, candidate);
        if (key !== null) knownMaterializations.add(key);
      }
      const nominations: {
        readonly familyId: FamilyId;
        readonly nomination: CaptureNominationInput;
        readonly retryableCandidate: Readonly<Record<string, unknown>>;
      }[] = [];
      const seen = new Set<string>();
      for (const raw of reverseInput.observations) {
        if (
          typeof raw === "object" && raw !== null &&
          ((raw as { kind?: unknown }).kind === "startup-candidate" ||
            (raw as { kind?: unknown }).kind === "call")
        ) {
          continue;
        }
        const log = raw as RebuildScanObservation;
        const matches = catalog.matches(Object.freeze({
          kind: "log",
          source: Object.freeze({
            number: log.blockNumber ?? 0,
            hash: log.blockHash ?? "0x" + "00".repeat(32),
            generation: log.blockNumber ?? 0,
          }),
          address: log.address.toLowerCase(),
          topics: Object.freeze([...(log.topics ?? [])]),
          data: log.data,
        }) as never);
        for (const match of matches) {
          const family = catalog.forStrictFamily(match.familyId);
          const plugin = family.plugin;
          if (!("discovery" in plugin)) continue;
          const discovery = plugin.discovery;
          if (discovery.reverseBinding?.kind !== "implementation") continue;
          const pattern = discovery.logPatterns?.find(
            (item) => item.id === match.patternId,
          );
          if (pattern?.emitter?.mode !== "singleton-indexed-bytes32") {
            continue;
          }
          const poolId = log.topics[pattern.emitter.topicIndex]?.toLowerCase();
          if (
            poolId === undefined ||
            !/^0x[0-9a-fA-F]{64}$/.test(poolId)
          ) {
            continue;
          }
          const key = materializationKey(match.familyId, Object.freeze({
            familyId: match.familyId,
            address: log.address.toLowerCase(),
            poolId,
          }));
          if (key === null || knownMaterializations.has(key) || seen.has(key)) {
            continue;
          }
          seen.add(key);
          const nomination = Object.freeze({
            address: log.address.toLowerCase(),
            opaque: Object.freeze({
              adapter: match.familyId,
              poolId,
            }),
            evidence: Object.freeze({
              ...(log.transactionHash === undefined
                ? {}
                : { transactionHash: log.transactionHash.toLowerCase() }),
              ...(log.blockNumber === undefined
                ? {}
                : { blockNumber: log.blockNumber }),
              ...(log.blockHash === undefined
                ? {}
                : { blockHash: log.blockHash.toLowerCase() }),
              ...(log.logIndex === undefined
                ? {}
                : { logIndex: log.logIndex }),
            }),
          });
          nominations.push(Object.freeze({
            familyId: match.familyId,
            nomination,
            retryableCandidate: Object.freeze({
              familyId: match.familyId,
              address: log.address.toLowerCase(),
              poolId,
              pluginCandidateKey: key.slice(match.familyId.length + 1),
              adapter: adapterLabelForFamily(match.familyId),
              ...(log.transactionHash === undefined
                ? {}
                : { transactionHash: log.transactionHash.toLowerCase() }),
              ...(log.blockNumber === undefined
                ? {}
                : { blockNumber: log.blockNumber }),
              ...(log.blockHash === undefined
                ? {}
                : { blockHash: log.blockHash.toLowerCase() }),
              ...(log.logIndex === undefined ? {} : { logIndex: log.logIndex }),
              [DISCOVERY_RETRYABLE_FIELD]: Object.freeze({
                stage: "nomination" as const,
                failureCode: "rpc" as const,
                reasonCode: "reverse-binding-unresolved",
              }),
            }),
          }));
        }
      }
      if (nominations.length === 0) return Object.freeze([]);
      // executeCatalogReverseBindings admits ONE verified observation per
      // Family and early-stops (its contract is one candidate at a time, the
      // retained attestation feeds per-candidate nominations). Feeding the
      // whole set in one call would admit a single pool per Family and drop
      // every other nomination. Drive the one-candidate calls through one
      // global bounded queue: no Family partitioning, deterministic output
      // order, and no serial RPC tail across thousands of opaque pools.
      const verified: UnifiedObservation[] = [];
      const providerFacade = providerAdapter(provider);
      const resolved = new Array<readonly UnifiedObservation[]>(
        nominations.length,
      );
      const unresolved = new Array<Readonly<Record<string, unknown>> | null>(
        nominations.length,
      ).fill(null);
      let nextNomination = 0;
      let completedNominations = 0;
      console.log(
        "[universe-rebuild/reverse-binding] start nominations=" +
          nominations.length + " concurrency=" + REVERSE_BINDING_CONCURRENCY,
      );
      await Promise.all(Array.from(
        {
          length: Math.min(
            REVERSE_BINDING_CONCURRENCY,
            nominations.length,
          ),
        },
        async () => {
          while (true) {
            const index = nextNomination++;
            if (index >= nominations.length) return;
            const item = nominations[index];
            try {
              let outcomeStatus: "verified" | "unsupported" | "failed" |
                undefined;
              let outcomeReason = "reverse-binding-unresolved";
              resolved[index] = await executeCatalogReverseBindings({
                catalog,
                source: reverseInput.cutoff,
                nominations: Object.freeze([item.nomination]),
                provider: providerFacade,
                onlyFamilyId: item.familyId,
                onOutcome: ({ outcome }) => {
                  outcomeStatus = outcome?.status;
                  if (
                    outcome !== undefined &&
                    outcome.status !== "verified"
                  ) outcomeReason = outcome.reason;
                },
              });
              if (
                resolved[index].length === 0 &&
                (outcomeStatus === "failed" || outcomeStatus === undefined)
              ) {
                unresolved[index] = Object.freeze({
                  ...item.retryableCandidate,
                  [DISCOVERY_RETRYABLE_FIELD]: Object.freeze({
                    stage: "nomination" as const,
                    failureCode: "rpc" as const,
                    reasonCode: outcomeReason,
                  }),
                });
              }
            } catch (error) {
              unresolved[index] = Object.freeze({
                ...item.retryableCandidate,
                [DISCOVERY_RETRYABLE_FIELD]: Object.freeze({
                  stage: "nomination" as const,
                  failureCode: "rpc" as const,
                  reasonCode: "reverse-binding-rpc:" +
                    (error instanceof Error
                      ? error.message.slice(0, 120)
                      : "unknown"),
                }),
              });
              resolved[index] = Object.freeze([]);
            }
            completedNominations++;
            if (
              completedNominations === 1 ||
              completedNominations % 100 === 0 ||
              completedNominations === nominations.length
            ) {
              console.log(
                "[universe-rebuild/reverse-binding] progress processed=" +
                  completedNominations + "/" + nominations.length +
                  " pending=" +
                  (nominations.length - completedNominations),
              );
            }
          }
        },
      ));
      for (const observations of resolved) {
        for (const observation of observations) verified.push(observation);
      }
      const byKey = new Map<string, Readonly<Record<string, unknown>>>();
      for (const observation of verified) {
        for (const match of catalog.matches(observation)) {
          const family = catalog.forStrictFamily(match.familyId);
          const plugin = family.plugin;
          if (!("discovery" in plugin)) continue;
          const discovery = plugin.discovery;
          const decoded = discovery.decodeCandidate({
            observation: observation as never,
            matchedPatternId: match.patternId,
          });
          if (decoded === null) continue;
          const decodedRecord = typeof decoded === "object" && decoded !== null
            ? decoded as Readonly<Record<string, unknown>>
            : Object.freeze({ opaqueCandidate: decoded });
          const observationAddress = observation.kind === "call"
            ? observation.target.toLowerCase()
            : observation.kind === "factory-log"
              ? observation.factory.toLowerCase()
              : observation.address.toLowerCase();
          const candidate = Object.freeze({
            ...decodedRecord,
            address: observationAddress,
            pluginCandidateKey: discovery.candidateKey(decoded as never),
            familyId: match.familyId,
            adapter: adapterLabelForFamily(match.familyId),
          });
          const candidateKey = rebuildFamilyInstanceDedupeKey(candidate);
          const existing = byKey.get(candidateKey);
          if (
            existing === undefined ||
            preferCandidateRepresentative(existing, candidate)
          ) {
            byKey.set(candidateKey, candidate);
          }
        }
      }
      for (const candidate of unresolved) {
        if (candidate === null) continue;
        const candidateKey = rebuildFamilyInstanceDedupeKey(candidate);
        if (!byKey.has(candidateKey)) byKey.set(candidateKey, candidate);
      }
      return Object.freeze([...byKey.values()]);
    },
    candidateEvidenceRef: (candidate) => {
      const item = candidate as Readonly<Record<string, unknown>>;
      if (
        !Number.isSafeInteger(item.blockNumber) ||
        typeof item.blockHash !== "string"
      ) return undefined;
      return Object.freeze({
        blockNumber: Number(item.blockNumber),
        blockHash: item.blockHash,
        ...(typeof item.transactionHash !== "string"
          ? {}
          : { txHash: item.transactionHash }),
        ...(Number.isSafeInteger(item.logIndex)
          ? { logIndex: Number(item.logIndex) }
          : {}),
      });
    },
    preAttestationRetryable: (candidate) => {
      const item = candidate as Readonly<Record<string, unknown>>;
      const marker = discoveryRetryableMarker(item);
      if (marker === null) return null;
      return Object.freeze({
        status: "retryable" as const,
        candidateSnapshot: Object.freeze({ ...item }),
        stage: marker.stage,
        failureCode: marker.failureCode,
        reasonCode: marker.reasonCode,
      });
    },
    isReadyMemoDefinitionCurrent: (memo) =>
      memo.familyDefinitionHash === familyDefinitionHash(memo.familyId) ||
      memo.familyDefinitionHash === familyMemoDefinitionHash(memo.familyId),
    findReusableMemo: async (memoInput) => {
      const candidate = memoInput.candidate as
        Readonly<Record<string, unknown>>;
      const familyId = typeof candidate.familyId === "string"
        ? candidate.familyId
        : "unknown-family";
      const candidateKey = rebuildFamilyCandidateKey(candidate);
      const memo = memoInput.checkpoint.verifiedMemos[candidateKey];
      if (memo === undefined) return null;
      // Phase 1 — pure local binding check (Family, candidate fingerprint,
      // memo definition, policy, proof-source bound): no RPC at all. A
      // changed Family definition, candidate shape or policy short-circuits
      // here, so the old authority RPCs are never wasted.
      if (!memoCheapBindingValid({
        memo,
        candidate,
        cutoff: memoInput.cutoff,
        familyId,
      })) return null;
      const proofSourceIsCutoff =
        memo.validity.proofSource.number === memoInput.cutoff.number &&
        memo.validity.proofSource.hash.toLowerCase() ===
          memoInput.cutoff.hash.toLowerCase();
      if (
        proofSourceIsCutoff &&
        canReuseMemo({
          memo,
          candidate,
          cutoff: memoInput.cutoff,
          familyId,
          // The memo already proves this exact block hash. A completed run
          // may start another target-blind replay at the same historical
          // cutoff with no old in-progress outcome to consult; re-reading
          // every account at the identical state is redundant. The runner's
          // final canonical fence still prevents publication across a reorg.
          currentAuthorityFingerprint: memo.validity.authorityFingerprint,
        })
      ) {
        return memo;
      }
      // Phase 2 — chain authority revalidation (only reached when the local
      // binding passed): re-read code/implementation at the cutoff and accept
      // either the current memo-scoped authority or the legacy full-scope
      // authority (memos sealed before the hash split).
      const address = String(candidate.address ?? "");
      if (!ethers.isAddress(address)) return null;
      const [code, implementationWord] = await Promise.all([
        provider.getCode(address, memoInput.cutoff.number),
        provider.getStorage(
          address,
          EIP1967_IMPLEMENTATION_SLOT,
          memoInput.cutoff.number,
        ),
      ]);
      const authority = memoAuthorityFingerprint({
        familyId,
        address,
        code,
        implementationWord,
      });
      const authorityMemoScope = memoAuthorityFingerprintMemoScope({
        familyId,
        address,
        code,
        implementationWord,
      });
      if (
        memo.validity.authorityFingerprint !== authority &&
        memo.validity.authorityFingerprint !== authorityMemoScope
      ) {
        return null;
      }
      if (!canReuseMemo({
        memo,
        candidate,
        cutoff: memoInput.cutoff,
        familyId,
        currentAuthorityFingerprint: memo.validity.authorityFingerprint,
      })) return null;
      const proofHash = await readMemoProofHash(
        memo.validity.proofSource.number,
        memoInput.cutoff,
      );
      if (
        proofHash.toLowerCase() !==
          memo.validity.proofSource.hash.toLowerCase()
      ) return null;
      return memo;
    },
    attestFamilyInstanceOnce: probe.attestFamilyInstanceOnce,
    sealDurableVerifiedMemo: probe.sealDurableVerifiedMemo,
    rehydrateVerifiedInstance: (rehydrateInput) => {
      // Rebuild the prepared instance from the memo's canonical data and
      // re-issue the process-local route handles at the memo's proof source
      // (audit §9: handles are never serialized; the central rehydrator
      // re-issues them bound to the exact stored route descriptors). The
      // instance's routes/pricing come from the memo's static projection.
      const projection = decodeDurableValue(
        rehydrateInput.memo.staticProjection,
      ) as {
        readonly routes?: readonly unknown[];
        readonly pricingInstances?: readonly unknown[];
        readonly staticBindingFingerprint?: string;
        readonly staticEvidenceFingerprint?: string;
        readonly evidenceRefs?: readonly string[];
      };
      const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
        .forStrictFamily(rehydrateInput.memo.familyId as never);
      if (family.plugin.manifest.domain === "funding") {
        const descriptor = decodeDurableValue(
          rehydrateInput.memo.compiledDescriptor,
        ) as { readonly asset?: unknown } | null;
        const asset = ethers.getAddress(String(descriptor?.asset ?? ""));
        return Object.freeze({
          domain: "funding" as const,
          familyId: rehydrateInput.memo.familyId,
          instanceKey: rehydrateInput.memo.instanceKey,
          asset,
          evidenceRefs: Object.freeze(projection?.evidenceRefs ?? []),
        });
      }
      const routes = projection?.routes ?? [];
      const instance = Object.freeze({
        familyId: rehydrateInput.memo.familyId,
        lineageId: String(
          (rehydrateInput.memo.verifiedIdentity as { lineageId?: unknown })
            .lineageId ?? rehydrateInput.memo.familyId,
        ),
        candidateKey: rehydrateInput.memo.candidateKey,
        instanceKey: rehydrateInput.memo.instanceKey,
        descriptor: decodeDurableValue(
          rehydrateInput.memo.compiledDescriptor,
        ) ?? null,
        routes: Object.freeze(routes),
        routeHandles: Object.freeze([]),
        pricingInstances: Object.freeze(projection?.pricingInstances ?? []),
        staticBindingFingerprint: projection?.staticBindingFingerprint ?? "",
        staticEvidenceFingerprint: projection?.staticEvidenceFingerprint ??
          rehydrateInput.memo.evidenceFingerprint,
        evidenceRefs: Object.freeze(projection?.evidenceRefs ?? []),
      }) as never;
      const rehydrated = family.plugin.manifest.domain === "credit"
        ? reissuePreparedInstanceAuthority({
            family,
            instance: instance as never,
            source: Object.freeze({ ...rehydrateInput.cutoff }),
            generation: rehydrateInput.cutoff.generation,
          })
        : reissuePreparedInstanceRouteHandles({
            family: family as never,
            instance: instance as never,
            // Proof provenance remains in the memo; process-local authority is
            // re-issued for the new ready run's canonical source/generation.
            source: Object.freeze({ ...rehydrateInput.cutoff }),
            generation: rehydrateInput.cutoff.generation,
          });
      // Return the exact centrally-issued instance.  Wrapping/spreading it
      // after handle issuance would create an unissued look-alike that the
      // catalog/exact boundary must reject.
      return rehydrated;
    },
    aggregateOnceByFamily: (instances) => {
      const byFamily = new Map<string, unknown[]>();
      for (const instance of instances) {
        const familyId = String(
          (instance as { familyId?: unknown }).familyId ?? "",
        );
        if (familyId.length === 0) continue;
        const siblings = byFamily.get(familyId);
        if (siblings === undefined) byFamily.set(familyId, [instance]);
        else siblings.push(instance);
      }
      return Object.freeze([...byFamily.entries()].map(([familyId, familyInstances]) =>
        Object.freeze({
          familyId,
          instances: Object.freeze([...familyInstances].sort((left, right) =>
            String((left as { instanceKey?: unknown }).instanceKey ?? "")
              .localeCompare(String(
                (right as { instanceKey?: unknown }).instanceKey ?? "",
              ))
          )),
        })
      ));
    },
    buildGraphSnapshot: (publications, cutoff) => {
      const edges: unknown[] = [];
      for (const publication of publications) {
        const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
          .forStrictFamily(publication.familyId as never);
        if (family.plugin.manifest.domain === "funding") {
          continue;
        }
        if (family.plugin.manifest.domain === "credit") {
          for (const rawInstance of publication.instances) {
            const instance = rawInstance as never;
            const credit = prepareCreditFamilyRoutes({
              family,
              instance,
              source: cutoff,
              generation: cutoff.generation,
            });
            edges.push(...credit.routes.map((route) =>
              projectCreditRouteGraph({ family, route }).edge
            ));
          }
          continue;
        }
        for (const rawInstance of publication.instances) {
          const instance = rawInstance as {
            readonly descriptor: unknown;
            readonly routes: readonly unknown[];
            readonly routeHandles: readonly unknown[];
          };
          const view = buildFamilyRouteGraphView({
            routes: Object.freeze(instance.routes.map((route, index) => ({
              family: family as never,
              descriptor: instance.descriptor as never,
              route: route as never,
              handle: instance.routeHandles[index] as never,
            }))),
          });
          edges.push(...view.edges);
        }
      }
      return Object.freeze({
        format: "strict-rebuild-graph-v1",
        edges: Object.freeze(edges),
      });
    },
    buildCoverage: (coverageInput) => {
      const rows: ReadyUniverseGeneration["sourceCoverage"][number][] = [];
      for (const receipt of coverageInput.sourceReceipts) {
        if (
          receipt.status !== "complete" ||
          receipt.retryableCount !== 0 ||
          receipt.appliedThrough.number !== coverageInput.cutoff.number ||
          receipt.appliedThrough.hash.toLowerCase() !==
            coverageInput.cutoff.hash.toLowerCase()
        ) {
          throw new Error("source receipt is incomplete at ready cutoff");
        }
        for (const coverageKey of receipt.coverageKeys) {
          const separator = coverageKey.indexOf("|");
          if (separator <= 0 || separator === coverageKey.length - 1) {
            throw new Error("source receipt coverage key is invalid");
          }
          rows.push(Object.freeze({
            familyId: coverageKey.slice(0, separator),
            sourceId: coverageKey.slice(separator + 1),
            completeThroughBlock: receipt.appliedThrough.number,
            completeThroughHash: receipt.appliedThrough.hash,
          }));
        }
      }
      return Object.freeze(rows.sort((left, right) =>
        (left.familyId + "|" + left.sourceId).localeCompare(
          right.familyId + "|" + right.sourceId,
        )
      ));
    },
    assertCanonicalHead: probe.assertCanonicalHead,
  };
  return Object.freeze(wiring);
}
