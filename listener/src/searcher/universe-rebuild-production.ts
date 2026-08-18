import { createHash } from "node:crypto";
import { ethers } from "ethers";
import {
  canonicalJson,
  type DurableSourceChunkReceipt,
  type DurableSourceReceipt,
  type DurableVerifiedMemo,
  type ReadyUniverseGeneration,
  type RetryableAttempt,
} from "./universe-rebuild-checkpoint.js";
import type { UniverseRebuildProbeWiring } from "./universe-rebuild-probe-cli.js";
import type { UniverseRebuildDependencies } from "./universe-rebuild-runner.js";
import type { CentralAdapterRuntime } from "./adapter-work-intent.js";
import { buildFamilyRouteGraphView } from "./adapter-family-graph-runtime.js";
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
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";

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
  // amounts, etc.); dropping them makes a single-pool retry impossible. The
  // durable codec is JSON-safe and this snapshot lives only in the current
  // in-progress run, not in a permanent raw-transaction inbox.
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
    familyDefinitionHash: familyDefinitionHash(input.familyId),
    validity: Object.freeze({
      policy: "immutable-code",
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
    memoFingerprint: "",
  });
  return Object.freeze({
    ...memo,
    memoFingerprint: digest(
      "memo-v1:" + canonicalJson({
        familyCandidateKey: memo.familyCandidateKey,
        familyInstanceKey: memo.familyInstanceKey,
        candidateFingerprint: memo.candidateFingerprint,
        familyDefinitionHash: memo.familyDefinitionHash,
        validity: memo.validity,
        verifiedIdentity: memo.verifiedIdentity,
        compiledDescriptor: memo.compiledDescriptor,
        staticProjection: memo.staticProjection,
        evidenceFingerprint: memo.evidenceFingerprint,
      }),
    ),
  });
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
  const revmClient = revmBin !== undefined && revmBin.trim() !== "" &&
      executor !== undefined && executor.trim() !== ""
    ? new RevmSimClient({
        executablePath: revmBin,
        timeoutMs: Number(process.env.SEARCHER_REVM_TIMEOUT_MS ?? "60000"),
      })
    : null;
  const runtimeByCutoff = new Map<string, CentralAdapterRuntime>();
  const runtimeFor = (
    cutoff: CanonicalSource,
    observedSender?: string,
  ): CentralAdapterRuntime => {
    const cutoffKey = cutoff.number + ":" + cutoff.hash.toLowerCase() + ":" +
      cutoff.generation + ":" + (observedSender?.toLowerCase() ?? "none");
    const incumbent = runtimeByCutoff.get(cutoffKey);
    if (incumbent !== undefined) return incumbent;
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
    runtimeByCutoff.set(cutoffKey, runtime);
    return runtime;
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
        result = await attestPoolIdentitiesStrict({
          catalog,
          provider: strictProvider,
          runtime: runtimeFor(attestInput.cutoff, observedSender),
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
      const candidate = sealInput.candidate as Readonly<Record<string, unknown>>;
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
 * strict-catalog Swap window, dedupe by full log identity into family-aware
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

export function strictCatalogSourceCoverageKeys(): {
  readonly startup: readonly string[];
  readonly events: readonly string[];
} {
  const startup: string[] = [];
  const events: string[] = [];
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
      events.push(familyId + "|event:" + pattern.id);
    }
  }
  return Object.freeze({
    startup: Object.freeze([...new Set(startup)].sort()),
    events: Object.freeze([...new Set(events)].sort()),
  });
}

/** Source scan chunk policy; bound into the event plan fingerprint. */
export const SOURCE_SCAN_BATCH_BLOCKS = 1_000;
export const SOURCE_MIN_CHUNK_BLOCKS = 64;

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
 * Plan identity of the catalog event scan source. Binds the exact topic
 * union, the covered event keys and the family code identity, plus the
 * chunk policy the scanner promises. topic/emitter/decoder changes all
 * move the fingerprint, so a durable event receipt sealed by an older
 * source plan can never be accepted by a newer catalog.
 */
export function catalogEventSourcePlanFingerprint(input: {
  readonly topics: readonly string[];
  readonly coverageKeys: readonly string[];
  readonly familyDefinitionHashes: readonly string[];
}): string {
  return digest("source-plan-v1:" + canonicalJson({
    sourceKind: "catalog-event-union",
    topics: input.topics,
    coverageKeys: input.coverageKeys,
    familyDefinitionHashes: input.familyDefinitionHashes,
    initialChunkBlocks: SOURCE_SCAN_BATCH_BLOCKS,
    minimumChunkBlocks: SOURCE_MIN_CHUNK_BLOCKS,
  }));
}

/** Current expected plan fingerprints for both required sources. */
export function expectedSourcePlanFingerprints(): {
  readonly startup: string;
  readonly events: string;
} {
  const coverageKeys = strictCatalogSourceCoverageKeys();
  const familyDefinitionHashes = strictFamilyDefinitionHashes();
  return Object.freeze({
    startup: startupSourcePlanFingerprint({
      coverageKeys: coverageKeys.startup,
      familyDefinitionHashes,
    }),
    events: catalogEventSourcePlanFingerprint({
      topics: strictCatalogLogTopics(),
      coverageKeys: coverageKeys.events,
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
 * Pre-partition alias key. A retained shared-manager row historically names
 * only poolId while a catalog event candidate names manager + poolId through
 * pluginCandidateKey. Both represent the same Family instance nomination.
 * The generic address+opaque-poolId pair collapses that alias before any
 * lifecycle work without changing the durable key of an incumbent run.
 */
export function rebuildFamilyInstanceDedupeKey(
  candidate: Readonly<Record<string, unknown>>,
): string {
  const familyId = typeof candidate.familyId === "string"
    ? candidate.familyId
    : "unknown-family";
  const address = candidate.address;
  const poolId = candidate.poolId;
  const identity = typeof address === "string" && address.trim().length > 0 &&
      typeof poolId === "string" && poolId.trim().length > 0
    ? address.toLowerCase() + "\u001f" + poolId.toLowerCase()
    : candidateInstanceIdentity(candidate);
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

export function canReuseMemo(input: {
  readonly memo: DurableVerifiedMemo;
  readonly candidate: Readonly<Record<string, unknown>>;
  readonly cutoff: CanonicalSource;
  readonly familyId: string;
  readonly currentAuthorityFingerprint: string;
}): boolean {
  if (
    input.memo.familyId !== input.familyId ||
    input.memo.candidateFingerprint !== candidateFingerprint(input.candidate) ||
    input.memo.familyDefinitionHash !== familyDefinitionHash(input.familyId) ||
    input.memo.validity.authorityFingerprint !==
      input.currentAuthorityFingerprint
  ) {
    return false;
  }
  if (input.memo.validity.policy !== "immutable-code") {
    return false;
  }
  if (input.memo.validity.proofSource.number > input.cutoff.number) return false;
  return input.memo.validity.proofSource.number !== input.cutoff.number ||
    input.memo.validity.proofSource.hash.toLowerCase() ===
      input.cutoff.hash.toLowerCase();
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
  const topics = strictCatalogLogTopics();
  const sourceCoverageKeys = strictCatalogSourceCoverageKeys();
  // reth caps eth_getLogs at 20000 results; the strict-topic union is
  // high-volume, so start small and halve on the max-results error. The
  // chunk policy is a plan-bound constant (SOURCE_SCAN_BATCH_BLOCKS /
  // SOURCE_MIN_CHUNK_BLOCKS): changing it moves the event plan fingerprint
  // and fails closed on resume.
  const probe = createProbeWiring({ rpcUrl });

  const wiring: UniverseRebuildDependencies = {
    encodeCandidateSnapshot: (candidate) =>
      encodeDurableValue(candidate),
    decodeCandidateSnapshot: (snapshot) =>
      decodeDurableValue(snapshot),
    requiredSourceCoverageKeys: () => Object.freeze([
      ...sourceCoverageKeys.startup,
      ...sourceCoverageKeys.events,
    ]),
    // Current source-plan identity. Every durable receipt sealed by this
    // wiring carries queryFingerprint == plan fingerprint; resume rejects
    // receipts sealed by any other code version (audit P0-STOP-1).
    expectedSourcePlanFingerprints: () => expectedSourcePlanFingerprints(),
    freezeCanonicalHead: async () => {
      const block = await provider.getBlock("latest");
      if (block === null || block.hash === null) {
        throw new Error("canonical head unavailable");
      }
      return Object.freeze({
        number: block.number,
        hash: block.hash.toLowerCase(),
        generation: block.number,
      });
    },
    scanSwapWindow: async (scanInput) => {
      const logs: RebuildScanObservation[] = [];
      const eventChunks: DurableSourceChunkReceipt[] = [];
      for (
        let start = scanInput.fromBlock;
        start <= scanInput.cutoff.number;
        start += SOURCE_SCAN_BATCH_BLOCKS
      ) {
        const end = Math.min(
          scanInput.cutoff.number,
          start + SOURCE_SCAN_BATCH_BLOCKS - 1,
        );
        const topicFilter: Array<null | string | Array<string>> =
          topics.length === 1 ? [topics[0]] : [[...topics]];
        // reth's eth_getLogs caps at 20000 results: halve the slice on the
        // max-results error and retry the same range; a hard floor keeps
        // progress fail-closed.
        let batchSize = SOURCE_SCAN_BATCH_BLOCKS;
        let from = start;
        while (from <= end) {
          const to = Math.min(end, from + batchSize - 1);
          try {
            const batch = await provider.getLogs({
              topics: topicFilter,
              fromBlock: from,
              toBlock: to,
            });
            const normalizedBatch = batch.map((log) => Object.freeze({
              address: log.address.toLowerCase(),
              topics: Object.freeze([...log.topics].map((topic) =>
                topic.toLowerCase()
              )),
              data: log.data.toLowerCase(),
              transactionHash: log.transactionHash?.toLowerCase() ?? null,
              blockNumber: log.blockNumber,
              blockHash: log.blockHash?.toLowerCase() ?? null,
              logIndex: log.index ?? null,
            }));
            eventChunks.push(Object.freeze({
              fromBlock: from,
              toBlock: to,
              resultCount: normalizedBatch.length,
              resultHash: digest(
                "source-chunk-v1:" + canonicalJson(normalizedBatch),
              ),
            }));
            for (const log of batch) {
              logs.push(Object.freeze({
                address: log.address.toLowerCase(),
                topics: Object.freeze([...log.topics]),
                data: log.data,
                ...(log.transactionHash === undefined
                  ? {}
                  : { transactionHash: log.transactionHash.toLowerCase() }),
                blockNumber: log.blockNumber,
                ...(log.blockHash === undefined
                  ? {}
                  : { blockHash: log.blockHash.toLowerCase() }),
                ...(log.index === undefined ? {} : { logIndex: log.index }),
              }));
            }
            from = to + 1;
            batchSize = SOURCE_SCAN_BATCH_BLOCKS;
          } catch (error) {
            if (batchSize <= SOURCE_MIN_CHUNK_BLOCKS) {
              throw new Error(
                "swap window scan failed at " + from + "-" + to + ": " +
                  (error instanceof Error ? error.message : String(error)),
              );
            }
            batchSize = Math.floor(batchSize / 2);
          }
        }
      }
      const observations = Object.freeze([
        ...(input?.startupCandidates ?? []).map((candidate) => Object.freeze({
          kind: "startup-candidate",
          candidate,
        })),
        ...logs,
      ]);
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
        familyDefinitionHashes: strictFamilyDefinitionHashes(),
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
      if (sourceCoverageKeys.events.length > 0) {
        // Same source-plan identity the runner compares on resume: binds
        // topic union, coverage keys, family code identity and chunk policy.
        const eventQueryFingerprint = catalogEventSourcePlanFingerprint({
          topics,
          coverageKeys: sourceCoverageKeys.events,
          familyDefinitionHashes: strictFamilyDefinitionHashes(),
        });
        const eventObservationHash = digest(
          "catalog-event-observations-v1:" + canonicalJson(logs),
        );
        receipts.push(Object.freeze({
          sourceKey: digest("source-key-v1:" + canonicalJson({
            sourceKind: "catalog-event-union",
            providerIdentity,
            queryFingerprint: eventQueryFingerprint,
            fromBlock: scanInput.fromBlock,
            toBlock: scanInput.cutoff.number,
            cutoffHash: scanInput.cutoff.hash,
          })),
          sourceKind: "catalog-event-union" as const,
          providerIdentity,
          queryFingerprint: eventQueryFingerprint,
          fromBlock: scanInput.fromBlock,
          toBlock: scanInput.cutoff.number,
          cutoffNumber: scanInput.cutoff.number,
          cutoffHash: scanInput.cutoff.hash,
          coverageKeys: sourceCoverageKeys.events,
          completedChunks: Object.freeze(eventChunks),
          observationSetHash: eventObservationHash,
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
      // Candidate dedupe is per pool (familyCandidateKey), NOT per log: a
      // two-day window holds hundreds of Swap logs per pool, and the run
      // attests one Family+Instance once. Full log identity dedupe (audit
      // P0.6) still governs the observation feed; here the newest log per
      // pool becomes the representative candidate + evidence ref.
      const seenLogs = new Set<string>();
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
    findReusableMemo: async (memoInput) => {
      const candidate = memoInput.candidate as
        Readonly<Record<string, unknown>>;
      const familyId = typeof candidate.familyId === "string"
        ? candidate.familyId
        : "unknown-family";
      const candidateKey = rebuildFamilyCandidateKey(candidate);
      const memo = memoInput.checkpoint.verifiedMemos[candidateKey];
      if (memo === undefined) return null;
      const run = memoInput.checkpoint.inProgressRun;
      const oldOutcome = run?.outcomesByCandidateKey[candidateKey];
      const sameFixedRun = run !== null && run !== undefined &&
        run.cutoff.number === memoInput.cutoff.number &&
        run.cutoff.hash.toLowerCase() === memoInput.cutoff.hash.toLowerCase() &&
        run.cutoff.generation === memoInput.cutoff.generation;
      if (
        sameFixedRun &&
        oldOutcome?.status === "verified" &&
        oldOutcome.memoFingerprint === memo.memoFingerprint &&
        memo.validity.proofSource.number === memoInput.cutoff.number &&
        memo.validity.proofSource.hash.toLowerCase() ===
          memoInput.cutoff.hash.toLowerCase() &&
        canReuseMemo({
          memo,
          candidate,
          cutoff: memoInput.cutoff,
          familyId,
          // The run's canonical hash is asserted once before resume. At the
          // same historical source, the already sealed code/implementation
          // authority cannot change; only candidate/Family hashes need the
          // pure canReuseMemo recheck here.
          currentAuthorityFingerprint: memo.validity.authorityFingerprint,
        })
      ) {
        return memo;
      }
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
      const currentAuthorityFingerprint = memoAuthorityFingerprint({
        familyId,
        address,
        code,
        implementationWord,
      });
      if (!canReuseMemo({
        memo,
        candidate,
        cutoff: memoInput.cutoff,
        familyId,
        currentAuthorityFingerprint,
      })) return null;
      const proofHash = await readBlockHash(
        provider,
        memo.validity.proofSource.number,
      );
      return proofHash.toLowerCase() ===
          memo.validity.proofSource.hash.toLowerCase()
        ? memo
        : null;
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
      const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
        .forStrictFamily(rehydrateInput.memo.familyId as never);
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
