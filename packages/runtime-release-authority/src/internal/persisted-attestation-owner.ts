import type { Hash } from "../../../../packages/canonical-codec/src/index.ts";
import { encodeCanonicalJson } from "../../../../packages/canonical-codec/src/index.ts";
import {
  sealInstanceCatalog,
  type InstanceCatalogV1,
} from "../../../../packages/catalog/src/index.ts";
import type {
  AttestationFinalSessionResultV1,
  AttestationIdentitySessionResultV1,
  AttestationRunSessionV1,
  AttestationServiceV1,
  AttestationPartitionCapabilityV1,
  AttestationWriterCapabilityV1,
} from "../../../../packages/attestation/src/index.ts";
import { assertIssuedAttestationService } from "../../../../packages/attestation/src/internal/validation-authority-verifier.ts";
import type {
  AttestationResumeCapabilitiesV1,
  OutcomeWriterOptions,
} from "../../../../packages/checkpoint/src/index.ts";
import { assertIssuedCheckpointStore } from "../../../../packages/checkpoint/src/index.ts";
import type { CandidatePartitionReaderPortV1 } from "../../../../specs/candidate-partition-authority/src/index.ts";
import type { SealedRunCapabilityV1, SealedRunReaderPortV1 } from "../../../../packages/sealed-run-runtime/src/contract.ts";
import type {
  InProgressBuilderRunV1,
  PersistedAttestationPort,
} from "../../../../packages/generation-builder/src/index.ts";
import type { RuntimeAuthorityV1 } from "../index.ts";
import {
  assertActiveRuntimeAuthorityState,
} from "./state.ts";
import { projectRuntimeAuthorityDescriptorV1 } from "../../../../packages/runtime-authority/src/index.ts";

export interface PersistedAttestationCheckpointPortV1 {
  readonly candidatePartitionReader: CandidatePartitionReaderPortV1;
  readonly sealedRunReader: SealedRunReaderPortV1;
  loadRun(runId: string): Promise<InProgressBuilderRunV1>;
  loadAttestationResumeCapabilities(runId: string): Promise<AttestationResumeCapabilitiesV1>;
  createOutcomeWriter(runId: string, options: OutcomeWriterOptions): {
    enqueue(capability: import("../../../../packages/attestation/src/index.ts").AttestationPersistenceCapabilityV1): Promise<void>;
    flush(): Promise<void>;
    closeAfterAllProducersAndFlush(): Promise<void>;
  };
  _replaceRetryableOutcomeForOwner(
    runId: string,
    familyCandidateKey: Hash,
    writerCapability: AttestationWriterCapabilityV1,
    persistenceCapability: import("../../../../packages/attestation/src/index.ts").AttestationPersistenceCapabilityV1,
  ): Promise<void>;
  sealAttestationPartition(runId: string, partition: import("../../../../packages/attestation/src/index.ts").AttestationPartitionCapabilityV1): Promise<SealedRunCapabilityV1>;
}

export interface PersistedAttestationOwnerOptionsV1 {
  /** The bounded logical concurrency is a scheduler policy, not a Family branch. */
  readonly identityConcurrency?: number;
  readonly materializationConcurrency?: number;
  readonly writer?: Omit<OutcomeWriterOptions, "writerCapability">;
}

export class PersistedAttestationIncompleteError extends Error {
  readonly runId: string;
  readonly unresolved: readonly {
    readonly familyCandidateKey: Hash;
    readonly kind: "retryable" | "invalidProgram";
    readonly failureCode: string;
  }[];

  constructor(
    runId: string,
    unresolved: readonly PersistedAttestationIncompleteError["unresolved"][number][],
  ) {
    super(`attestation run ${runId} remains incomplete`);
    this.name = "PersistedAttestationIncompleteError";
    this.runId = runId;
    this.unresolved = Object.freeze([...unresolved]);
  }
}

interface IdentityVerifiedResultV1 {
  readonly kind: "identityVerified";
  readonly result: Extract<AttestationIdentitySessionResultV1, { readonly kind: "identityVerified" }>;
}

function positiveConcurrency(value: number | undefined, fallback: number, context: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${context} must be a positive integer`);
  return resolved;
}

export async function mapLimitReaped<T, R>(
  values: readonly T[],
  limit: number,
  run: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  let stopped = false;
  let failed = false;
  let primaryError: unknown;
  const worker = async (): Promise<void> => {
    while (!stopped) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      try {
        results[index] = await run(values[index]!);
      } catch (error) {
        stopped = true;
        if (!failed) {
          failed = true;
          primaryError = error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(values.length, 1)) }, () => worker()));
  if (failed) throw primaryError;
  return results;
}

function sameJsonSafe(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function groupKey(
  result: Extract<AttestationIdentitySessionResultV1, { readonly kind: "identityVerified" }>,
): string {
  return `${result.candidate.familyDefinitionHash}:${result.identity.familyInstanceKey}`;
}

function unresolvedOutcome(
  result: AttestationFinalSessionResultV1,
): PersistedAttestationIncompleteError["unresolved"][number] | null {
  if (result.outcome.kind !== "retryable" && result.outcome.kind !== "invalidProgram") return null;
  return {
    familyCandidateKey: result.outcome.familyCandidateKey,
    kind: result.outcome.kind,
    failureCode: result.outcome.failure.failureCode,
  };
}

/**
 * Release-owned durable attestation choreography. It knows only generic
 * identity/materialization ports and opaque checkpoint capabilities; Family
 * semantics remain inside the constructor-bound AttestationService.
 */
class PersistedAttestationOwnerV1 implements PersistedAttestationPort {
  readonly #attestation: AttestationServiceV1;
  readonly #checkpoint: PersistedAttestationCheckpointPortV1;
  readonly #options: Required<Pick<PersistedAttestationOwnerOptionsV1, "identityConcurrency" | "materializationConcurrency">> & {
    readonly writer: Omit<OutcomeWriterOptions, "writerCapability">;
  };

  constructor(
    attestation: AttestationServiceV1,
    checkpoint: PersistedAttestationCheckpointPortV1,
    options: PersistedAttestationOwnerOptionsV1 = {},
  ) {
    if (attestation === null || typeof attestation !== "object") throw new TypeError("attestation owner service is required");
    if (checkpoint === null || typeof checkpoint !== "object") throw new TypeError("attestation owner checkpoint is required");
    this.#attestation = attestation;
    this.#checkpoint = checkpoint;
    this.#options = {
      identityConcurrency: positiveConcurrency(options.identityConcurrency, 24, "identityConcurrency"),
      materializationConcurrency: positiveConcurrency(options.materializationConcurrency, 24, "materializationConcurrency"),
      writer: Object.freeze({ ...(options.writer ?? {}) }),
    };
  }

  async attestAndPersistDifference(
    run: InProgressBuilderRunV1,
    signal: AbortSignal,
  ): Promise<{ readonly sealedRun: SealedRunCapabilityV1; readonly sealedRunBinding: import("../../../../packages/sealed-run-runtime/src/contract.ts").SealedRunBindingV1; readonly instanceCatalog: InstanceCatalogV1 }> {
    if (run === null || typeof run !== "object") throw new TypeError("attestation owner run is required");
    if (!(signal instanceof AbortSignal)) throw new TypeError("attestation owner signal is required");
    const exactRun = await this.#checkpoint.loadRun(run.runId);
    if (
      exactRun.runId !== run.runId
      || exactRun.candidatePartitionBinding.runId !== run.runId
      || !sameJsonSafe(exactRun.candidatePartitionBinding, run.candidatePartitionBinding)
      || !sameJsonSafe(exactRun.cutoff, run.cutoff)
    ) throw new TypeError("attestation owner run is not the checkpoint active run");

    const resume = await this.#checkpoint.loadAttestationResumeCapabilities(run.runId);
    let resumeClaimClosed = false;
    const abortResumeClaim = (): void => {
      if (resumeClaimClosed) return;
      try {
        resume.claim.abort();
      } catch {
        // Preserve the operation's primary failure. The claim is best-effort
        // cleanup after a session/IO error and can be revalidated on retry.
      }
      resumeClaimClosed = true;
    };
    try {
      const session = this.#attestation.openRunSession({
        candidatePartition: run.candidatePartition,
        identityResumeCapabilities: resume.identity,
        outcomeResumeCapabilities: resume.final,
        verifiedMemoReuseCapabilities: resume.memoReuse,
      });
      const candidateKeys = [...this.#checkpoint.candidatePartitionReader.listKeys(run.candidatePartition)];
      if (candidateKeys.length === 0) throw new TypeError("attestation owner candidate partition is empty");
      const writer = this.#checkpoint.createOutcomeWriter(run.runId, {
        writerCapability: session.writerCapability,
        ...(this.#options.writer as Omit<OutcomeWriterOptions, "writerCapability">),
      });
      const finalByKey = new Map<Hash, AttestationFinalSessionResultV1>();
      const continuations: IdentityVerifiedResultV1[] = [];
      const retryableKeys = new Set(resume.retryable);
      const retryableResults: AttestationFinalSessionResultV1[] = [];
      let primaryError: unknown = null;
      try {
        const identityResults = await mapLimitReaped(candidateKeys, this.#options.identityConcurrency, async key => {
          if (signal.aborted) throw signal.reason;
          return session.resolveIdentityOrReuseProofOnce(key, signal);
        });
        for (const result of identityResults) {
          if (result.kind === "identityVerified") {
            if (result.durability === "new" && !retryableKeys.has(result.candidate.familyCandidateKey)) {
              await writer.enqueue(result.persistenceCapability);
            }
            continuations.push({ kind: "identityVerified", result });
          } else {
            if (result.durability === "new" && !retryableKeys.has(result.outcome.familyCandidateKey)) {
              await writer.enqueue(result.persistenceCapability);
            }
            if (retryableKeys.has(result.outcome.familyCandidateKey)) retryableResults.push(result);
            finalByKey.set(result.outcome.familyCandidateKey, result);
          }
        }
        // A materialization must never run while its identity partial is merely
        // in the writer mailbox. This flush is the crash boundary between the
        // two phases.
        await writer.flush();

        const groups = new Map<string, IdentityVerifiedResultV1[]>();
        for (const item of continuations) {
          const key = groupKey(item.result);
          const group = groups.get(key);
          if (group) group.push(item);
          else groups.set(key, [item]);
        }
        const groupValues = [...groups.values()];
        const materialized = await mapLimitReaped(groupValues, this.#options.materializationConcurrency, async group => {
          if (signal.aborted) throw signal.reason;
          if (group.length > 1) {
            return session.issueNominationKeyCollision(group.map(item => item.result.continuation));
          }
          return [await session.materializeAndProjectOnce(group[0]!.result.continuation, signal)];
        });
        for (const results of materialized) {
          for (const result of results) {
            if (result.durability === "new" && !retryableKeys.has(result.outcome.familyCandidateKey)) {
              await writer.enqueue(result.persistenceCapability);
            }
            if (retryableKeys.has(result.outcome.familyCandidateKey)) retryableResults.push(result);
            finalByKey.set(result.outcome.familyCandidateKey, result);
          }
        }
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        // The writer owns the durable transaction and always gets a chance to
        // drain capabilities already accepted by the mailbox. If the work
        // already failed, do not replace that primary error with cleanup.
        try {
          await writer.closeAfterAllProducersAndFlush();
        } catch (closeError) {
          if (primaryError === null) throw closeError;
          throw new AggregateError([primaryError, closeError], "attestation owner work and writer close both failed");
        }
      }

      for (const result of retryableResults) {
        if (result.outcome.kind === "invalidProgram") continue;
        await this.#checkpoint._replaceRetryableOutcomeForOwner(
          run.runId,
          result.outcome.familyCandidateKey,
          session.writerCapability,
          result.persistenceCapability,
        );
      }

      if (finalByKey.size !== candidateKeys.length) {
        throw new TypeError("attestation owner did not produce one final result per candidate");
      }
      const unresolved = [...finalByKey.values()]
        .map(unresolvedOutcome)
        .filter((value): value is PersistedAttestationIncompleteError["unresolved"][number] => value !== null)
        .sort((left, right) => left.familyCandidateKey.localeCompare(right.familyCandidateKey));
      if (unresolved.length > 0) throw new PersistedAttestationIncompleteError(run.runId, unresolved);

      const outcomeHashes = [...finalByKey.values()]
        .sort((left, right) => left.outcome.familyCandidateKey.localeCompare(right.outcome.familyCandidateKey))
        .map(result => result.persistenceCapability.outcomeHash);
      const partition = session.sealExactPartition(outcomeHashes);
      const verifiedPublications = [...finalByKey.values()]
        .filter((result): result is AttestationFinalSessionResultV1 & { readonly outcome: Extract<AttestationFinalSessionResultV1["outcome"], { readonly kind: "verified" }> } => result.outcome.kind === "verified")
        .map(result => result.outcome.publication);
      const instanceCatalog = sealInstanceCatalog(run.cutoff, verifiedPublications);
      const sealedRun = await this.#checkpoint.sealAttestationPartition(run.runId, partition);
      const sealedRunBinding = this.#checkpoint.sealedRunReader.binding(sealedRun);
      resume.claim.commit();
      resumeClaimClosed = true;
      return Object.freeze({ sealedRun, sealedRunBinding, instanceCatalog });
    } catch (error) {
      abortResumeClaim();
      throw error;
    }
  }
}

interface RuntimePersistedAttestationPortStateV1 {
  readonly authority: RuntimeAuthorityV1;
  readonly implementation: PersistedAttestationOwnerV1;
  readonly version: bigint;
  readonly authorityBindingHash: Hash;
}

const runtimePersistedAttestationPortStates = new WeakMap<object, RuntimePersistedAttestationPortStateV1>();

function assertPersistedAttestationPortCurrent(
  state: RuntimePersistedAttestationPortStateV1,
): void {
  const current = assertActiveRuntimeAuthorityState(state.authority);
  if (
    current.version !== state.version
    || current.descriptor.authorityBindingHash !== state.authorityBindingHash
    || state.implementation === null
  ) throw new TypeError("persisted attestation port is stale after runtime rotation");
}

/**
 * Issue the only production PersistedAttestationPort. The caller supplies an
 * already-created engine/checkpoint object only at this private release join;
 * the returned public port contains neither object nor authority fields and a
 * structural clone cannot pass the owner registry.
 */
export function issueRuntimePersistedAttestationPort(
  authorityValue: unknown,
  attestationValue: unknown,
  checkpointValue: unknown,
  options?: PersistedAttestationOwnerOptionsV1,
): PersistedAttestationPort {
  const authority = authorityValue as RuntimeAuthorityV1;
  const runtime = assertActiveRuntimeAuthorityState(authority);
  const attestation = assertIssuedAttestationService(attestationValue);
  const checkpoint = assertIssuedCheckpointStore(checkpointValue);
  const validation = attestation.validationAuthority;
  const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(runtime.descriptor);
  if (encodeCanonicalJson(validation.runtimeAuthority) !== encodeCanonicalJson(runtimeAuthority)) {
    throw new TypeError("attestation service is not bound to the current runtime");
  }
  const checkpointPort: PersistedAttestationCheckpointPortV1 = Object.freeze({
    candidatePartitionReader: checkpoint.candidatePartitionReader,
    sealedRunReader: checkpoint.sealedRunReader,
    loadRun: (runId: string) => checkpoint.loadRun(runId),
    loadAttestationResumeCapabilities: (runId: string) => checkpoint.loadAttestationResumeCapabilities(runId),
    createOutcomeWriter: (runId: string, writerOptions: OutcomeWriterOptions) => checkpoint.createOutcomeWriter(runId, writerOptions),
    sealAttestationPartition: (runId: string, partition: AttestationPartitionCapabilityV1) => checkpoint.sealAttestationPartition(runId, partition),
    _replaceRetryableOutcomeForOwner: (
      runId: string,
      familyCandidateKey: Hash,
      writerCapability: AttestationWriterCapabilityV1,
      persistenceCapability: import("../../../../packages/attestation/src/index.ts").AttestationPersistenceCapabilityV1,
    ) => checkpoint._replaceRetryableOutcomeForOwner(runId, familyCandidateKey, writerCapability, persistenceCapability),
  });
  const implementation = new PersistedAttestationOwnerV1(attestation, checkpointPort, options);
  const state: RuntimePersistedAttestationPortStateV1 = {
    authority,
    implementation,
    version: runtime.version,
    authorityBindingHash: runtime.descriptor.authorityBindingHash,
  };
  const port: PersistedAttestationPort = Object.freeze({
    attestAndPersistDifference(run: InProgressBuilderRunV1, signal: AbortSignal) {
      assertPersistedAttestationPortCurrent(state);
      return implementation.attestAndPersistDifference(run, signal);
    },
  });
  runtimePersistedAttestationPortStates.set(port, state);
  return port;
}

export function assertIssuedRuntimePersistedAttestationPort(
  value: unknown,
  authorityValue: unknown,
): PersistedAttestationPort {
  if (value === null || typeof value !== "object") throw new TypeError("persisted attestation port is not issued");
  const state = runtimePersistedAttestationPortStates.get(value);
  if (!state || state.authority !== authorityValue) throw new TypeError("persisted attestation port is not issued");
  assertPersistedAttestationPortCurrent(state);
  return value as PersistedAttestationPort;
}
