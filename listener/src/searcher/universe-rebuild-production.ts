import { createHash } from "node:crypto";
import { ethers } from "ethers";
import {
  canonicalJson,
  type DurableVerifiedMemo,
  type RetryableAttempt,
} from "./universe-rebuild-checkpoint.js";
import type { UniverseRebuildProbeWiring } from "./universe-rebuild-probe-cli.js";
import { attestPoolIdentitiesStrict } from "./strict-identity-attestation.js";
import { createMinimalIdentityRuntime } from "./strict-identity-attestation.js";
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
  const plugin = family.plugin;
  const surface = "discovery" in plugin
    ? plugin.discovery
    : undefined;
  return digest("family-def-v1:" + canonicalJson({
    familyId,
    manifest: plugin.manifest,
    addressSurfaces: surface?.addressSurfaces ?? [],
    identityVariants: "identity" in plugin
      ? (plugin.identity as unknown as { variants?: unknown[] }).variants ?? []
      : [],
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

function isRetryableReason(reason: string): boolean {
  const lower = reason.toLowerCase();
  return (
    lower.includes("rpc") ||
    lower.includes("unresolved") ||
    lower.includes("deadline") ||
    lower.includes("timeout") ||
    lower.includes("aborted") ||
    lower.includes("resource") ||
    lower.includes("ecdsa") ||
    lower.includes("network")
  );
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
        blockTag ?? "latest",
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
  });
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
      authorityFingerprint: familyDefinitionHash(input.familyId),
      proofSource: Object.freeze({
        number: input.proofSource.number,
        hash: input.proofSource.hash,
      }),
    }),
    verifiedIdentity: input.verifiedIdentity,
    compiledDescriptor: input.compiledDescriptor,
    staticProjection: input.staticProjection,
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
  const runtime = createMinimalIdentityRuntime(strictProvider);
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
      try {
        result = await attestPoolIdentitiesStrict({
          catalog,
          provider: strictProvider,
          runtime,
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
        if (isRetryableReason(reason)) {
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
        readonly instance?: {
          readonly instanceKey: string;
          readonly descriptor?: unknown;
          readonly evidenceRefs?: readonly string[];
          readonly pricingInstances?: readonly {
            readonly routes?: readonly unknown[];
          }[];
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
        staticProjection: result.instance?.pricingInstances ?? null,
        evidenceFingerprint: digest(
          "evidence:" + canonicalJson(
            result.instance?.evidenceRefs ?? [],
          ),
        ),
        proofSource: sealInput.proofSource,
        candidateFingerprint: digest(
          "candidate:" + canonicalJson(canonicalCandidateSnapshot(candidate)),
        ),
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
