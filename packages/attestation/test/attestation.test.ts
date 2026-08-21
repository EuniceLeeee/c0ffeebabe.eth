import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { sealInstancePublication } from "../../catalog/src/index.ts";
import { mergeAndDedupeNominations, type CandidateRecordV1 } from "../../discovery/src/index.ts";
import {
  assertPromotablePartition,
  attestFixedCutoffPartition,
  probeRetryableCandidate,
  type AttestationProgramPort,
  type IdentityVerifiedV1,
  type InstanceDecisionV1,
  type InstanceLifecycleSingleFlightPort,
  type ProbeStorePort,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/attestation", value);
const cutoff = { chainId: "1", number: "10", hash: h("block"), stateRoot: h("state") };

const candidate = (nominationKey: string): CandidateRecordV1 => mergeAndDedupeNominations([{
  familyId: "family-a",
  familyDefinitionHash: h("definition"),
  instanceNominationKey: nominationKey,
  candidateSnapshotHash: h(`snapshot:${nominationKey}`),
  evidence: {
    blockNumber: "10",
    blockHash: cutoff.hash,
    txHash: h(`tx:${nominationKey}`),
    logIndex: "0",
    address: "0xabc",
    topic: h("topic"),
    rawLocatorHash: h(`raw:${nominationKey}`),
  },
}])[0]!;

const publication = (value: CandidateRecordV1, identity: IdentityVerifiedV1) => sealInstancePublication({
  familyId: value.familyId,
  familyDefinitionHash: value.familyDefinitionHash,
  familyCandidateKey: value.familyCandidateKey,
  instanceKey: identity.familyInstanceKey,
  cutoff,
  identityMemoHash: identity.identityMemoHash,
  descriptorHash: identity.descriptorHash,
  staticProjectionMemoHash: h("projection-memo"),
  requestedArtifactDependencyRoot: h("dependencies"),
  validityDependencyRoot: h("validity"),
  transitions: [{
    inputAssetPorts: [{ assetRef: h("in"), portRef: h("in-port"), ordinal: "0" }],
    outputAssetPorts: [{ assetRef: h("out"), portRef: h("out-port"), ordinal: "0" }],
    opaqueTransitionRef: h("transition"),
    constraintRefs: [],
    staticProjectionHash: h("projection"),
  }],
  evidenceRoot: identity.evidenceRoot,
});

class SingleFlight implements InstanceLifecycleSingleFlightPort {
  readonly calls = new Map<Hash, number>();
  readonly values = new Map<Hash, Promise<InstanceDecisionV1>>();
  getOrBuild(key: Hash, build: () => Promise<InstanceDecisionV1>): Promise<InstanceDecisionV1> {
    const existing = this.values.get(key);
    if (existing) return existing;
    this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
    const value = build().finally(() => this.values.delete(key));
    this.values.set(key, value);
    return value;
  }
}

test("identity and instance lifecycle execute exactly once per candidate/instance", async () => {
  const candidates = [candidate("a"), candidate("b")];
  let identityCalls = 0;
  let lifecycleCalls = 0;
  const programs: AttestationProgramPort = {
    async attestIdentity(value) {
      identityCalls += 1;
      return {
        kind: "identityVerified",
        familyInstanceKey: `instance:${value.instanceNominationKey}`,
        identityMemoHash: h(`identity:${value.instanceNominationKey}`),
        descriptorHash: h("descriptor"),
        evidenceRoot: h(`evidence:${value.instanceNominationKey}`),
      };
    },
    async materializeAndProject(value, identity) {
      lifecycleCalls += 1;
      return { kind: "verified", publication: publication(value, identity) };
    },
  };
  const partition = await attestFixedCutoffPartition(
    "run-a", cutoff, candidates, programs, new SingleFlight(), new AbortController().signal,
  );
  assert.equal(identityCalls, 2);
  assert.equal(lifecycleCalls, 2);
  assertPromotablePartition(partition, candidates.map(value => value.familyCandidateKey));
});

test("two nomination keys resolving to one instance are invalid, never silently merged", async () => {
  const candidates = [candidate("a"), candidate("b")];
  let lifecycleCalls = 0;
  const partition = await attestFixedCutoffPartition("run-a", cutoff, candidates, {
    async attestIdentity() {
      return { kind: "identityVerified", familyInstanceKey: "same", identityMemoHash: h("identity"), descriptorHash: h("descriptor"), evidenceRoot: h("evidence") };
    },
    async materializeAndProject() {
      lifecycleCalls += 1;
      throw new Error("must not run");
    },
  }, new SingleFlight(), new AbortController().signal);
  assert.equal(lifecycleCalls, 0);
  assert.deepEqual(partition.outcomes.map(value => value.kind), ["invalidProgram", "invalidProgram"]);
  assert.throws(() => assertPromotablePartition(partition, candidates.map(value => value.familyCandidateKey)), /invalid-program/);
});

test("retryable remains retryable and is not inferred as chain rejection", async () => {
  const value = candidate("a");
  const partition = await attestFixedCutoffPartition("run-a", cutoff, [value], {
    async attestIdentity(candidateValue) {
      return {
        kind: "retryable",
        failure: {
          stage: "identity",
          failureCode: "rpc-deadline",
          attemptCount: "3",
          candidateSnapshotHash: candidateValue.candidateSnapshotHash,
          evidenceRoot: h("evidence"),
        },
      };
    },
    async materializeAndProject() { throw new Error("unused"); },
  }, new SingleFlight(), new AbortController().signal);
  assert.equal(partition.outcomes[0]?.kind, "retryable");
  assert.equal(partition.accounting.chainProvenRejected, "0");
});

test("a plugin rejection with stale cutoff binding becomes invalidProgram, never terminal", async () => {
  const value = candidate("a");
  const partition = await attestFixedCutoffPartition("run-a", cutoff, [value], {
    async attestIdentity() {
      return {
        kind: "chainProvenRejected",
        proof: {
          familyDefinitionHash: value.familyDefinitionHash,
          familyCandidateKey: value.familyCandidateKey,
          cutoffHash: h("stale-block"),
          cutoffStateRoot: cutoff.stateRoot,
          requestFingerprint: h("request"),
          authorityRoot: h("authority"),
          proofHash: h("proof"),
        },
      };
    },
    async materializeAndProject() { throw new Error("unused"); },
  }, new SingleFlight(), new AbortController().signal);
  assert.equal(partition.outcomes[0]?.kind, "invalidProgram");
  assert.equal(partition.accounting.chainProvenRejected, "0");
});

test("single-candidate probe reuses the original cutoff and replaces only retryable by CAS", async () => {
  const value = candidate("a");
  const before = {
    kind: "retryable" as const,
    runCandidateKey: hashDomain("aloha/run-candidate/v1", { runId: "run-a", familyCandidateKey: value.familyCandidateKey }),
    familyCandidateKey: value.familyCandidateKey,
    failure: {
      stage: "identity" as const,
      failureCode: "rpc-deadline",
      attemptCount: "2",
      candidateSnapshotHash: value.candidateSnapshotHash,
      evidenceRoot: h("evidence"),
    },
  };
  const beforeOutcomeHash = hashDomain("aloha/run-outcome/v1", before);
  let replaced: { expected: Hash; nextKind: string } | null = null;
  const store: ProbeStorePort = {
    async loadRetryable() { return { runId: "run-a", cutoff, candidate: value, before, beforeOutcomeHash }; },
    async listRetryableCandidateKeys() { return [value.familyCandidateKey]; },
    async replaceRetryableCAS(_runId, _key, expected, next) { replaced = { expected, nextKind: next.kind }; },
  };
  let canonicalChecks = 0;
  const receipt = await probeRetryableCandidate(
    "run-a",
    value.familyCandidateKey,
    store,
    { async assertStillCanonical(valueCutoff) { canonicalChecks += 1; assert.deepEqual(valueCutoff, cutoff); } },
    {
      async attestIdentity() {
        return { kind: "identityVerified", familyInstanceKey: "instance:a", identityMemoHash: h("identity"), descriptorHash: h("descriptor"), evidenceRoot: h("evidence") };
      },
      async materializeAndProject(candidateValue, identity) {
        return { kind: "verified", publication: publication(candidateValue, identity) };
      },
    },
    new SingleFlight(),
    new AbortController().signal,
  );
  assert.equal(canonicalChecks, 1);
  assert.deepEqual(replaced, { expected: beforeOutcomeHash, nextKind: "verified" });
  assert.equal(receipt.beforeKind, "retryable");
  assert.equal(receipt.afterKind, "verified");
});
