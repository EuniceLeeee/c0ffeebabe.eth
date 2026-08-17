import { createHash } from "node:crypto";
import { ethers } from "ethers";
import {
  canonicalJson,
  type DurableVerifiedMemo,
  type ReadyUniverseGeneration,
  type RetryableAttempt,
} from "./universe-rebuild-checkpoint.js";
import type { UniverseRebuildProbeWiring } from "./universe-rebuild-probe-cli.js";
import type { UniverseRebuildDependencies } from "./universe-rebuild-runner.js";
import { buildFamilyRouteGraphView } from "./adapter-family-graph-runtime.js";
import { reissuePreparedInstanceRouteHandles } from
  "./venues/adapter-family-runtime.js";
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
  return Object.freeze({
    address: candidate.address,
    ...(candidate.poolId === undefined
      ? {}
      : { poolId: candidate.poolId }),
    ...(candidate.adapter === undefined ? {} : { adapter: candidate.adapter }),
    ...(candidate.token0 === undefined ? {} : { token0: candidate.token0 }),
    ...(candidate.token1 === undefined ? {} : { token1: candidate.token1 }),
    ...(candidate.blockNumber === undefined
      ? {}
      : { blockNumber: candidate.blockNumber }),
    ...(candidate.blockHash === undefined ? {} : { blockHash: candidate.blockHash }),
    ...(candidate.transactionHash === undefined
      ? {}
      : { transactionHash: candidate.transactionHash }),
    ...(candidate.logIndex === undefined ? {} : { logIndex: candidate.logIndex }),
  });
}

type DurableEncodedValue =
  | null | boolean | string | number
  | readonly DurableEncodedValue[]
  | { readonly [key: string]: DurableEncodedValue };

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
    if (value instanceof Map) {
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
      encoded[key] = encodeDurableValue(
        (value as Record<string, unknown>)[key],
        seen,
      );
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
  const runtimeFor = (cutoff: CanonicalSource) =>
    revmClient === null || executor === undefined
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
          simulator: createRevmStrictSimulationTransport({
            client: revmClient,
            executor,
            verifiedActors: PRODUCTION_STRICT_VERIFIED_ACTORS,
          }),
        });
  const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;

  type AttestOnce = NonNullable<UniverseRebuildProbeWiring["attestFamilyInstanceOnce"]>;
  type VerifiedReturn = Awaited<ReturnType<AttestOnce>> extends infer U ?
    (U extends { readonly status: "verified" } ? U : never) : never;
  type TerminalReturn = Awaited<ReturnType<AttestOnce>> extends infer U ?
    (U extends { readonly status: "terminal-rejected" } ? U : never) : never;
  type RetryableReturn = Awaited<ReturnType<AttestOnce>> extends infer U ?
    (U extends { readonly status: "retryable" } ? U : never) : never;
  const terminalRejected = (reasonCode: string): TerminalReturn =>
    Object.freeze({ status: "terminal-rejected", reasonCode }) as TerminalReturn;
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
      const pool = Object.freeze({
        address: String(candidate.address ?? ""),
        ...(candidate.adapter === undefined
          ? {}
          : { adapter: String(candidate.adapter) }),
        ...(candidate.poolId === undefined
          ? {}
          : { poolId: String(candidate.poolId) }),
      });
      if (!ethers.isAddress(pool.address)) {
        return terminalRejected("invalid_candidate_address");
      }
      let result: Awaited<ReturnType<typeof attestPoolIdentitiesStrict>>;
      let authorityFingerprint: string;
      try {
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
          runtime: runtimeFor(attestInput.cutoff),
          source: attestInput.cutoff,
          pools: Object.freeze([pool]),
          channelOrder: "reverse-binding-first",
        });
      } catch (error) {
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
        return terminalRejected(reason);
      }
      const publication = result.publications[0] ?? null;
      const instance = publication?.instances[0] ?? null;
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
        "instance:" + familyId + "|" + candidateInstanceIdentity(candidate),
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
        candidateFingerprint: digest(
          "candidate:" + canonicalJson(canonicalCandidateSnapshot(candidate)),
        ),
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
    decodeCandidateSnapshot: (snapshot: unknown) => snapshot,
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
  // reth caps eth_getLogs at 20000 results; the strict-topic union is
  // high-volume, so start small and halve on the max-results error.
  const scanBatch = 1_000;
  const probe = createProbeWiring({ rpcUrl });

  const wiring: UniverseRebuildDependencies = {
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
      for (
        let start = scanInput.fromBlock;
        start <= scanInput.cutoff.number;
        start += scanBatch
      ) {
        const end = Math.min(scanInput.cutoff.number, start + scanBatch - 1);
        const topicFilter: Array<null | string | Array<string>> =
          topics.length === 1 ? [topics[0]] : [[...topics]];
        // reth's eth_getLogs caps at 20000 results: halve the slice on the
        // max-results error and retry the same range; a hard floor keeps
        // progress fail-closed.
        let batchSize = scanBatch;
        let from = start;
        while (from <= end) {
          const to = Math.min(end, from + batchSize - 1);
          try {
            const batch = await provider.getLogs({
              topics: topicFilter,
              fromBlock: from,
              toBlock: to,
            });
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
            batchSize = scanBatch;
          } catch (error) {
            if (batchSize <= 64) {
              throw new Error(
                "swap window scan failed at " + from + "-" + to + ": " +
                  (error instanceof Error ? error.message : String(error)),
              );
            }
            batchSize = Math.floor(batchSize / 2);
          }
        }
      }
      return Object.freeze([
        ...(input?.startupCandidates ?? []).map((candidate) => Object.freeze({
          kind: "startup-candidate",
          candidate,
        })),
        ...logs,
      ]);
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
          byKey.set(rebuildFamilyCandidateKey(candidate), candidate);
          continue;
        }
        const log = observation as RebuildScanObservation;
        const logKey = fullLogIdentityKey(log);
        if (seenLogs.has(logKey)) continue;
        seenLogs.add(logKey);
        for (const candidate of candidatesFromLog(log)) {
          const key = rebuildFamilyCandidateKey(candidate);
          const existing = byKey.get(key);
          if (
            existing === undefined ||
            Number(candidate.blockNumber ?? 0) >
              Number(existing.blockNumber ?? 0)
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
      const memo = memoInput.checkpoint.verifiedMemos[
        rebuildFamilyCandidateKey(candidate)
      ];
      if (memo === undefined) return null;
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
      const rehydrated = reissuePreparedInstanceRouteHandles({
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
    buildGraphSnapshot: (publications) => {
      const edges: unknown[] = [];
      for (const publication of publications) {
        const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
          .forStrictFamily(publication.familyId as never);
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
      for (const family of
        PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.listAll()) {
        rows.push(Object.freeze({
          familyId: family.plugin.manifest.familyId,
          sourceId: "startup-universe",
          completeThroughBlock: coverageInput.cutoff.number,
          completeThroughHash: coverageInput.cutoff.hash,
        }));
        const discovery = "discovery" in family.plugin
          ? family.plugin.discovery
          : null;
        for (const pattern of discovery?.logPatterns ?? []) {
          rows.push(Object.freeze({
            familyId: family.plugin.manifest.familyId,
            sourceId: "event:" + pattern.id,
            completeThroughBlock: coverageInput.cutoff.number,
            completeThroughHash: coverageInput.cutoff.hash,
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
