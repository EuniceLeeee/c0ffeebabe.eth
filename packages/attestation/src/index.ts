import { deepFreeze, hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { validateInstancePublication, type InstancePublicationV1 } from "../../catalog/src/index.ts";
import {
  runCandidateKey,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
} from "../../discovery/src/index.ts";

export interface OutcomeFailureV1 {
  readonly stage: "identity" | "materialization" | "projection" | "framework";
  readonly failureCode: string;
  readonly attemptCount: string;
  readonly candidateSnapshotHash: Hash;
  readonly evidenceRoot: Hash;
}

export interface RejectionProofBindingV1 {
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly cutoffHash: Hash;
  readonly cutoffStateRoot: Hash;
  readonly requestFingerprint: Hash;
  readonly authorityRoot: Hash;
  readonly proofHash: Hash;
}

export type CandidateFinalOutcomeV1 =
  | {
    readonly kind: "verified";
    readonly runCandidateKey: Hash;
    readonly familyCandidateKey: Hash;
    readonly instanceKey: string;
    readonly publication: InstancePublicationV1;
  }
  | {
    readonly kind: "chainProvenRejected";
    readonly runCandidateKey: Hash;
    readonly familyCandidateKey: Hash;
    readonly proof: RejectionProofBindingV1;
  }
  | {
    readonly kind: "retryable";
    readonly runCandidateKey: Hash;
    readonly familyCandidateKey: Hash;
    readonly failure: OutcomeFailureV1;
  }
  | {
    readonly kind: "invalidProgram";
    readonly runCandidateKey: Hash;
    readonly familyCandidateKey: Hash;
    readonly failure: OutcomeFailureV1;
  };

export interface IdentityVerifiedV1 {
  readonly kind: "identityVerified";
  readonly familyInstanceKey: string;
  readonly identityMemoHash: Hash;
  readonly descriptorHash: Hash;
  readonly evidenceRoot: Hash;
}

export type IdentityDecisionV1 =
  | IdentityVerifiedV1
  | Omit<Extract<CandidateFinalOutcomeV1, { readonly kind: "chainProvenRejected" }>, "runCandidateKey" | "familyCandidateKey">
  | Omit<Extract<CandidateFinalOutcomeV1, { readonly kind: "retryable" }>, "runCandidateKey" | "familyCandidateKey">
  | Omit<Extract<CandidateFinalOutcomeV1, { readonly kind: "invalidProgram" }>, "runCandidateKey" | "familyCandidateKey">;

export type InstanceDecisionV1 =
  | { readonly kind: "verified"; readonly publication: InstancePublicationV1 }
  | { readonly kind: "chainProvenRejected"; readonly proof: RejectionProofBindingV1 }
  | { readonly kind: "retryable"; readonly failure: OutcomeFailureV1 }
  | { readonly kind: "invalidProgram"; readonly failure: OutcomeFailureV1 };

export interface InstanceLifecycleSingleFlightPort {
  getOrBuild(key: Hash, build: () => Promise<InstanceDecisionV1>): Promise<InstanceDecisionV1>;
}

export interface AttestationProgramPort {
  attestIdentity(candidate: CandidateRecordV1, cutoff: CanonicalCutoffV1, signal: AbortSignal): Promise<IdentityDecisionV1>;
  materializeAndProject(
    candidate: CandidateRecordV1,
    identity: IdentityVerifiedV1,
    cutoff: CanonicalCutoffV1,
    signal: AbortSignal,
  ): Promise<InstanceDecisionV1>;
}

export interface AttestationPartitionV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly outcomes: readonly CandidateFinalOutcomeV1[];
  readonly accounting: {
    readonly pending: string;
    readonly verified: string;
    readonly chainProvenRejected: string;
    readonly retryable: string;
    readonly invalidProgram: string;
  };
  readonly exactOutcomePartitionRoot: Hash;
}

export interface StoredRetryableProbeV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidate: CandidateRecordV1;
  readonly before: Extract<CandidateFinalOutcomeV1, { readonly kind: "retryable" }>;
  readonly beforeOutcomeHash: Hash;
}

export interface ProbeStorePort {
  loadRetryable(runId: string, familyCandidateKey: Hash): Promise<StoredRetryableProbeV1>;
  listRetryableCandidateKeys(runId: string, failureCode: string): Promise<readonly Hash[]>;
  replaceRetryableCAS(
    runId: string,
    familyCandidateKey: Hash,
    expectedOutcomeHash: Hash,
    next: CandidateFinalOutcomeV1,
    nextOutcomeHash: Hash,
  ): Promise<void>;
}

export interface ProbeReceiptV1 {
  readonly runId: string;
  readonly familyCandidateKey: Hash;
  readonly cutoff: CanonicalCutoffV1;
  readonly beforeOutcomeHash: Hash;
  readonly afterOutcomeHash: Hash;
  readonly beforeKind: "retryable";
  readonly afterKind: CandidateFinalOutcomeV1["kind"];
  readonly candidateSnapshotHash: Hash;
  readonly evidenceRoot: Hash;
  readonly probeReceiptHash: Hash;
}

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const outcomeFor = (
  runId: string,
  candidate: CandidateRecordV1,
  cutoff: CanonicalCutoffV1,
  decision: Exclude<IdentityDecisionV1, IdentityVerifiedV1> | InstanceDecisionV1,
): CandidateFinalOutcomeV1 => {
  const key = runCandidateKey(runId, candidate.familyCandidateKey);
  switch (decision.kind) {
    case "verified":
      return deepFreeze({
        kind: "verified",
        runCandidateKey: key,
        familyCandidateKey: candidate.familyCandidateKey,
        instanceKey: decision.publication.instanceKey,
        publication: decision.publication,
      });
    case "chainProvenRejected":
      if (
        decision.proof.familyDefinitionHash !== candidate.familyDefinitionHash
        || decision.proof.familyCandidateKey !== candidate.familyCandidateKey
        || decision.proof.cutoffHash !== cutoff.hash
        || decision.proof.cutoffStateRoot !== cutoff.stateRoot
        || decision.proof.requestFingerprint.length === 0
        || decision.proof.authorityRoot.length === 0
        || decision.proof.proofHash.length === 0
      ) throw new Error("rejection-proof-candidate-mismatch");
      return deepFreeze({ kind: decision.kind, runCandidateKey: key, familyCandidateKey: candidate.familyCandidateKey, proof: decision.proof });
    case "retryable":
    case "invalidProgram":
      if (
        decision.failure.failureCode.length === 0
        || !/^[1-9][0-9]*$/.test(decision.failure.attemptCount)
        || decision.failure.candidateSnapshotHash !== candidate.candidateSnapshotHash
        || decision.failure.evidenceRoot.length === 0
      ) throw new Error("failure-lineage-mismatch");
      return deepFreeze({ kind: decision.kind, runCandidateKey: key, familyCandidateKey: candidate.familyCandidateKey, failure: decision.failure });
  }
};

const frameworkFailure = (
  runId: string,
  candidate: CandidateRecordV1,
  cutoff: CanonicalCutoffV1,
  stage: OutcomeFailureV1["stage"],
): CandidateFinalOutcomeV1 => outcomeFor(runId, candidate, cutoff, {
  kind: "invalidProgram",
  failure: {
    stage,
    failureCode: "plugin-program-threw",
    attemptCount: "1",
    candidateSnapshotHash: candidate.candidateSnapshotHash,
    evidenceRoot: hashDomain("aloha/candidate-evidence-set/v1", candidate.evidence),
  },
});

function validateVerifiedPublication(
  candidate: CandidateRecordV1,
  identity: IdentityVerifiedV1,
  cutoff: CanonicalCutoffV1,
  publication: InstancePublicationV1,
): void {
  validateInstancePublication(publication);
  if (
    publication.familyId !== candidate.familyId
    || publication.familyDefinitionHash !== candidate.familyDefinitionHash
    || publication.familyCandidateKey !== candidate.familyCandidateKey
    || publication.instanceKey !== identity.familyInstanceKey
    || publication.identityMemoHash !== identity.identityMemoHash
    || publication.descriptorHash !== identity.descriptorHash
    || publication.cutoff.chainId !== cutoff.chainId
    || publication.cutoff.number !== cutoff.number
    || publication.cutoff.hash !== cutoff.hash
    || publication.cutoff.stateRoot !== cutoff.stateRoot
  ) throw new Error("publication-lineage-mismatch");
}

export async function attestFixedCutoffPartition(
  runId: string,
  cutoff: CanonicalCutoffV1,
  candidates: readonly CandidateRecordV1[],
  programs: AttestationProgramPort,
  instanceLifecycle: InstanceLifecycleSingleFlightPort,
  signal: AbortSignal,
): Promise<AttestationPartitionV1> {
  const candidateKeys = candidates.map(candidate => candidate.familyCandidateKey);
  if (new Set(candidateKeys).size !== candidateKeys.length) throw new Error("duplicate-candidate-key");
  const outcomes = new Map<Hash, CandidateFinalOutcomeV1>();
  const identified: Array<{ candidate: CandidateRecordV1; identity: IdentityVerifiedV1 }> = [];

  for (const candidate of [...candidates].sort((left, right) => compareText(left.familyCandidateKey, right.familyCandidateKey))) {
    if (signal.aborted) throw signal.reason;
    try {
      const decision = await programs.attestIdentity(candidate, cutoff, signal);
      if (decision.kind === "identityVerified") identified.push({ candidate, identity: decision });
      else outcomes.set(candidate.familyCandidateKey, outcomeFor(runId, candidate, cutoff, decision));
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      outcomes.set(candidate.familyCandidateKey, frameworkFailure(runId, candidate, cutoff, "identity"));
    }
  }

  const groups = new Map<string, Array<{ candidate: CandidateRecordV1; identity: IdentityVerifiedV1 }>>();
  for (const item of identified) {
    const key = `${item.candidate.familyDefinitionHash}:${item.identity.familyInstanceKey}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.length !== 1) {
      const evidenceRoot = hashDomain("aloha/nomination-key-collision/v1", group.map(item => ({
        familyCandidateKey: item.candidate.familyCandidateKey,
        familyInstanceKey: item.identity.familyInstanceKey,
      })).sort((left, right) => compareText(left.familyCandidateKey, right.familyCandidateKey)));
      for (const item of group) {
        outcomes.set(item.candidate.familyCandidateKey, outcomeFor(runId, item.candidate, cutoff, {
          kind: "invalidProgram",
          failure: {
            stage: "identity",
            failureCode: "nomination-key-collision",
            attemptCount: "1",
            candidateSnapshotHash: item.candidate.candidateSnapshotHash,
            evidenceRoot,
          },
        }));
      }
      continue;
    }

    const item = group[0]!;
    const instanceWorkKey = hashDomain("aloha/instance-lifecycle-work/v1", {
      runId,
      familyDefinitionHash: item.candidate.familyDefinitionHash,
      familyInstanceKey: item.identity.familyInstanceKey,
      cutoff,
    });
    try {
      const decision = await instanceLifecycle.getOrBuild(
        instanceWorkKey,
        () => programs.materializeAndProject(item.candidate, item.identity, cutoff, signal),
      );
      if (decision.kind === "verified") {
        validateVerifiedPublication(item.candidate, item.identity, cutoff, decision.publication);
      }
      outcomes.set(item.candidate.familyCandidateKey, outcomeFor(runId, item.candidate, cutoff, decision));
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      outcomes.set(item.candidate.familyCandidateKey, frameworkFailure(runId, item.candidate, cutoff, "framework"));
    }
  }

  if (outcomes.size !== candidates.length) throw new Error("attestation-partition-incomplete");
  const sorted = [...outcomes.values()].sort((left, right) => compareText(left.familyCandidateKey, right.familyCandidateKey));
  const accounting = {
    pending: "0",
    verified: String(sorted.filter(value => value.kind === "verified").length),
    chainProvenRejected: String(sorted.filter(value => value.kind === "chainProvenRejected").length),
    retryable: String(sorted.filter(value => value.kind === "retryable").length),
    invalidProgram: String(sorted.filter(value => value.kind === "invalidProgram").length),
  };
  return deepFreeze({
    runId,
    cutoff: deepFreeze({ ...cutoff }),
    outcomes: sorted,
    accounting,
    exactOutcomePartitionRoot: hashDomain("aloha/exact-outcome-partition/v1", {
      runId,
      cutoff,
      outcomes: sorted,
    }),
  });
}

export function assertPromotablePartition(
  partition: AttestationPartitionV1,
  expectedCandidateKeys: readonly Hash[],
): void {
  if (new Set(expectedCandidateKeys).size !== expectedCandidateKeys.length) {
    throw new Error("duplicate-expected-candidate-key");
  }
  const actual = partition.outcomes.map(outcome => outcome.familyCandidateKey).sort(compareText);
  const expected = [...expectedCandidateKeys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("candidate-outcome-partition-mismatch");
  }
  if (partition.accounting.pending !== "0") throw new Error("pending-outcomes");
  if (partition.accounting.retryable !== "0") throw new Error("retryable-outcomes");
  if (partition.accounting.invalidProgram !== "0") throw new Error("invalid-program-outcomes");
  for (const outcome of partition.outcomes) {
    if (outcome.runCandidateKey !== runCandidateKey(partition.runId, outcome.familyCandidateKey)) {
      throw new Error("run-candidate-key-mismatch");
    }
  }
  const expectedAccounting = {
    pending: "0",
    verified: String(partition.outcomes.filter(value => value.kind === "verified").length),
    chainProvenRejected: String(partition.outcomes.filter(value => value.kind === "chainProvenRejected").length),
    retryable: String(partition.outcomes.filter(value => value.kind === "retryable").length),
    invalidProgram: String(partition.outcomes.filter(value => value.kind === "invalidProgram").length),
  };
  for (const key of Object.keys(expectedAccounting) as Array<keyof typeof expectedAccounting>) {
    if (partition.accounting[key] !== expectedAccounting[key]) throw new Error("outcome-accounting-mismatch");
  }
  const recomputedRoot = hashDomain("aloha/exact-outcome-partition/v1", {
    runId: partition.runId,
    cutoff: partition.cutoff,
    outcomes: [...partition.outcomes].sort((left, right) => compareText(left.familyCandidateKey, right.familyCandidateKey)),
  });
  if (recomputedRoot !== partition.exactOutcomePartitionRoot) throw new Error("outcome-partition-root-mismatch");
  const terminal = BigInt(expectedAccounting.verified) + BigInt(expectedAccounting.chainProvenRejected);
  if (terminal !== BigInt(expected.length)) throw new Error("terminal-accounting-mismatch");
}

export async function probeRetryableCandidate(
  runId: string,
  familyCandidateKey: Hash,
  store: ProbeStorePort,
  canonical: { assertStillCanonical(cutoff: CanonicalCutoffV1): Promise<void> },
  programs: AttestationProgramPort,
  instanceLifecycle: InstanceLifecycleSingleFlightPort,
  signal: AbortSignal,
): Promise<ProbeReceiptV1> {
  const stored = await store.loadRetryable(runId, familyCandidateKey);
  if (
    stored.runId !== runId
    || stored.candidate.familyCandidateKey !== familyCandidateKey
    || stored.before.familyCandidateKey !== familyCandidateKey
    || stored.before.runCandidateKey !== runCandidateKey(runId, familyCandidateKey)
    || stored.before.failure.candidateSnapshotHash !== stored.candidate.candidateSnapshotHash
  ) throw new Error("probe-stored-lineage-mismatch");
  await canonical.assertStillCanonical(stored.cutoff);
  const partition = await attestFixedCutoffPartition(
    runId,
    stored.cutoff,
    [stored.candidate],
    programs,
    instanceLifecycle,
    signal,
  );
  const after = partition.outcomes[0];
  if (!after) throw new Error("probe-outcome-missing");
  const afterOutcomeHash = hashDomain("aloha/run-outcome/v1", after);
  await store.replaceRetryableCAS(
    runId,
    familyCandidateKey,
    stored.beforeOutcomeHash,
    after,
    afterOutcomeHash,
  );
  const body = {
    runId,
    familyCandidateKey,
    cutoff: stored.cutoff,
    beforeOutcomeHash: stored.beforeOutcomeHash,
    afterOutcomeHash,
    beforeKind: "retryable" as const,
    afterKind: after.kind,
    candidateSnapshotHash: stored.candidate.candidateSnapshotHash,
    evidenceRoot: stored.before.failure.evidenceRoot,
  };
  return deepFreeze({ ...body, probeReceiptHash: hashDomain("aloha/single-instance-probe-receipt/v1", body) });
}

export async function probeRetryableCategory(
  runId: string,
  failureCode: string,
  store: ProbeStorePort,
  canonical: { assertStillCanonical(cutoff: CanonicalCutoffV1): Promise<void> },
  programs: AttestationProgramPort,
  instanceLifecycle: InstanceLifecycleSingleFlightPort,
  signal: AbortSignal,
): Promise<readonly ProbeReceiptV1[]> {
  if (failureCode.length === 0) throw new TypeError("failureCode is empty");
  const keys = [...await store.listRetryableCandidateKeys(runId, failureCode)].sort(compareText);
  if (new Set(keys).size !== keys.length) throw new Error("duplicate-probe-candidate-key");
  const receipts: ProbeReceiptV1[] = [];
  for (const key of keys) {
    receipts.push(await probeRetryableCandidate(
      runId, key, store, canonical, programs, instanceLifecycle, signal,
    ));
  }
  return deepFreeze(receipts);
}
