import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  candidatePartitionRoot,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
} from "../../discovery/src/index.ts";
import {
  createUnsignedDryRunRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
  type RuntimeAuthorityProjectionV1,
} from "../../runtime-authority/src/index.ts";
import {
  CandidatePartitionCapabilityRegistryV1,
  type CandidatePartitionRawEvidenceSourceV1,
} from "../../checkpoint/src/candidate-partition.ts";
import {
  candidatePartitionKeysRoot,
  createCandidatePartitionCommitmentV1,
  type CandidatePartitionCapabilityV1,
  type CandidatePartitionCommitmentV1,
  type CandidatePartitionReaderPortV1,
} from "../../../specs/candidate-partition-authority/src/index.ts";

export interface TestAttestationRuntimeV1 {
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly workerEpoch: string;
  readonly executorSessionHash: Hash;
}

export interface CandidatePartitionFixtureV1 {
  readonly capability: CandidatePartitionCapabilityV1;
  readonly reader: CandidatePartitionReaderPortV1;
  readonly binding: CandidatePartitionCommitmentV1;
}

export function releaseApproval(
  frameworkSeed: Hash,
  executorSeed: Hash,
  workerEpoch = "epoch-1",
  executorSessionHash: Hash = hashDomain("test/executor-session", executorSeed),
): TestAttestationRuntimeV1 {
  const descriptor = createUnsignedDryRunRuntimeAuthorityDescriptorV1({
    authorityClass: "dry-run",
    runtimeBindingId: hashDomain("test/unsigned-runtime-binding", {
      frameworkSeed,
      executorSeed,
      workerEpoch,
      executorSessionHash,
    }),
    implementationCommit: "a".repeat(40),
  });
  return Object.freeze({
    runtimeAuthority: projectRuntimeAuthorityDescriptorV1(descriptor),
    workerEpoch,
    executorSessionHash,
  });
}

export function issueCandidatePartitionFixture(
  runtime: TestAttestationRuntimeV1,
  registry: CandidatePartitionCapabilityRegistryV1,
  candidates: readonly CandidateRecordV1[],
  cutoff: CanonicalCutoffV1,
  runId = "run-a",
  checkpointRevision = "1",
  rawEvidence: CandidatePartitionRawEvidenceSourceV1 = Object.freeze({
    read(): Uint8Array { throw new TypeError("test candidate raw evidence is unavailable"); },
  }),
): CandidatePartitionFixtureV1 {
  const binding = createCandidatePartitionCommitmentV1({
    kind: "aloha.candidate-partition-commitment",
    version: "1",
    authorityClass: "dry-run",
    runtimeAuthority: runtime.runtimeAuthority,
    runId,
    cutoff,
    candidatePartitionRoot: candidatePartitionRoot(candidates),
    candidatePartitionStorageHash: hashDomain("test/candidate-partition-storage", `${runId}:${checkpointRevision}`),
    nominationClosureRoot: hashDomain("test/nomination-closure", `${runId}:${checkpointRevision}`),
    nominationClosureStorageHash: hashDomain("test/nomination-closure-storage", `${runId}:${checkpointRevision}`),
    recordCount: String(candidates.length),
    candidateKeysRoot: candidatePartitionKeysRoot(candidates.map(candidate => candidate.familyCandidateKey)),
    recentObservationRoot: hashDomain("test/candidate-partition-observation", `${runId}:${checkpointRevision}`),
    sourceCoverageRoot: hashDomain("test/candidate-partition-coverage", `${runId}:${checkpointRevision}`),
    checkpointRevision,
  });
  const capability = registry.registerVerifiedCommitment(binding, candidates, rawEvidence);
  return Object.freeze({ capability, reader: registry.reader, binding });
}
