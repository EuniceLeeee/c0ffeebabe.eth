import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  hashCanonicalPartition,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { DURABLE_CONTENT_ENVELOPE_HASH_DOMAIN } from "../../../packages/durable-store/src/index.ts";
import {
  candidateEvidenceRoot,
  candidateSubjectHash,
  sealSourceCoverage,
  sourcePlanEvidenceRoot,
  sourcePlanExecutionRoot,
  sourcePlanIdentity,
  type SourceCompleteness,
  type SourceCoverageCertificateV1,
  type SourcePlanRefV1,
} from "../../../packages/discovery/src/index.ts";
import {
  ARTIFACT_BYTES_CHUNK_BYTE_LENGTH,
  createArtifactResolutionClaim,
  createObservedImmutableMirror,
  createResolverPolicy,
  createRetentionLeaseReceipt,
  decodeArtifactBytes,
  encodeArtifactBytes,
  type ArtifactResolutionClaimV1,
  type RetentionLeaseReceiptV1,
} from "../../../specs/artifact-resolution/src/index.ts";
import {
  createReadOnlyArtifactRef,
  type ReadOnlyArtifactRefV1,
  type SchemaRef,
} from "../../../specs/core-envelope/src/index.ts";
import {
  sealReleaseIntent,
} from "../../../specs/release-intent/src/index.ts";
import {
  sealInstancePublication,
} from "../../../packages/catalog/src/index.ts";
import {
  createSignedReleaseRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../../packages/runtime-authority/src/index.ts";
import {
  createFullFamilyFactLocator,
  decodeFullFamilyOutcomeArtifact,
  deriveFullFamilyOutcomeSummary,
  encodeFullFamilyArtifactRefIndexV1,
  encodeFullFamilyArtifactRefPageV1,
  encodeFullFamilyCandidateProofVerifierBinding,
  encodeFullFamilyEvidenceArtifact,
  encodeFullFamilyFactBundleStorageV1,
  encodeFullFamilyOutcomeArtifact,
  encodeFullFamilyReadyRecord,
  encodeFullFamilyReleaseProjectionArtifact,
  encodeFullFamilySourceCoverageArtifact,
  FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS,
  FULL_FAMILY_FACT_SCHEMA_MANIFEST,
  FULL_FAMILY_FACT_STORAGE_SCHEMA_MANIFEST,
  sealFullFamilyArtifactRefIndexV1,
  sealFullFamilyArtifactRefPageV1,
  sealFullFamilyFactBundleStorageV1,
  sealFamilyEvidencePartition,
  sealFamilyOutcomePartition,
  sealFullFamilyFacts,
  sealFullFamilyMatrixEntry,
  type FamilyEvidenceItemV1,
  type FamilyOutcomeItemV1,
  type FamilyReleaseSetDraftV1,
  type FullFamilyFactBundleV1,
  type FullFamilyPartitionRoleV1,
  type FullFamilyStoredPartitionBindingInputV1,
  type FullFamilyMatrixEntryV1,
  type FullFamilyCandidateProofVerifierBindingV1,
  type FullFamilyEvidenceArtifactV1,
  type FullFamilyOutcomeArtifactV1,
  type FullFamilyReleaseProjectionArtifactV1,
  type FullFamilySourceCoverageArtifactV1,
} from "../../full-family-facts/src/runtime.ts";
import {
  exactOutcomePartitionRootV1,
  type CandidateFinalOutcomeWireV1,
} from "../../../specs/candidate-final-outcome/src/index.ts";
import {
  candidatePartitionProofId,
  candidatePartitionProofPayloadHash,
  candidatePartitionProofSigningBytes,
  decodeCandidatePartitionProofV1,
  encodeCandidatePartitionProofV1,
  makeCandidatePartitionProofPayload,
  type CandidatePartitionProofPayloadV1,
  type CandidatePartitionProofV1,
  type CandidateRecordV1,
} from "../../../specs/candidate-partition-authority/src/index.ts";
import {
  encodeNominationClosureV1,
  nominationEvidenceRefHash,
  sealNominationClosureV1,
  sealQualifiedSourcePlanNominationReceiptV1,
} from "../../../specs/nomination-authority/src/index.ts";
import type { PredicateRuntimeFactsV1 } from "../src/predicate-composition.ts";
import {
  createFullFamilyPredicateEvaluatorForQualification,
  FULL_FAMILY_PREDICATE_EVALUATOR,
} from "../src/predicates/full-family.ts";
import { createSelectedPredicateAuthorityEntry } from "../src/index.ts";
import {
  buildFullFamilyQualificationCorpus,
  QUALIFICATION_FULL_FAMILY_RESOLVER_POLICY,
} from "../../full-family-facts/test/qualification-fixture.ts";
import {
  issueQualificationChainRejectedOutcome,
  issueQualificationVerifiedOutcome,
  type QualificationOutcomeAuthorityV1,
} from "../../full-family-facts/test/qualification-outcome-fixture.ts";
import {
  FULL_FAMILY_OUTCOME_ARTIFACT_CRITICAL_MUTATION_IDS,
  FULL_FAMILY_PREDICATE_SPEC,
  type FullFamilyOutcomeArtifactCriticalMutationId,
} from "../../full-family-facts/src/spec.ts";
import { createCommonEnvelopeRoleContractV1 } from "../../../specs/qualification/src/index.ts";

function h(label: string): Hash {
  return hashDomain("test/gate-core/full-family/v1", label);
}

function schemaRef(manifest: { readonly id: string; readonly version: string; readonly schemaHash: Hash }): SchemaRef {
  return Object.freeze({ id: manifest.id, version: manifest.version, schemaHash: manifest.schemaHash });
}

const cutoff = Object.freeze({
  chainId: "1",
  number: "100",
  hash: h("cutoff-hash"),
  stateRoot: h("cutoff-state-root"),
});
const FULL_FAMILY_INVOCATION_SEAL_ROLE_ID = createCommonEnvelopeRoleContractV1(
  FULL_FAMILY_PREDICATE_SPEC.predicateId,
).signedInvocationRoleId;

const proofKeys = generateKeyPairSync("ed25519");
const proofPublicKeyHex = `0x${proofKeys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}` as `0x${string}`;
const proofKeyId = hashDomain("test/gate-core/full-family/proof-key/v1", proofPublicKeyHex);
const candidateReleaseCommit = "a".repeat(40);
const nominationClosureKind = "aloha/nomination-closure/v1";
const candidatePartitionProofKind = "aloha/candidate-partition-proof/v2";

function issueCandidatePartitionProof(payload: CandidatePartitionProofPayloadV1): CandidatePartitionProofV1 {
  const payloadHash = candidatePartitionProofPayloadHash(payload);
  return decodeCandidatePartitionProofV1({
    ...payload,
    proofId: candidatePartitionProofId(payloadHash),
    payloadHash,
    signatureAlgorithm: "ed25519",
    signerKeyId: proofKeyId,
    signatureHex: `0x${sign(null, Buffer.from(candidatePartitionProofSigningBytes(payload, proofKeyId)), proofKeys.privateKey).toString("hex")}`,
  });
}

function durableContentHash(
  kind: string,
  bytes: Uint8Array,
  references: readonly Hash[] = [],
): Hash {
  return hashDomain(DURABLE_CONTENT_ENVELOPE_HASH_DOMAIN, {
    kind,
    payloadHash: sha256Hex(bytes),
    references: [...new Set(references)].sort(),
  });
}


const policy = createResolverPolicy({
  schemaVersion: 1,
  kind: "aloha.artifact-resolver-policy",
  allowedLocatorKind: "content-object",
  digestAlgorithm: "sha256",
  maxByteLength: "10000000",
  requireExactLengthMediaAndSchema: true,
  minimumRemainingStoreEpochs: "0",
  failureOutcome: "invalid",
});

interface StoredArtifactV1 {
  readonly bytes: Uint8Array;
  readonly ref: ReadOnlyArtifactRefV1;
  readonly claim: ArtifactResolutionClaimV1;
  readonly lease: RetentionLeaseReceiptV1;
}

function storeArtifact(
  bytes: Uint8Array,
  schema: SchemaRef | null = null,
  mediaType = "application/json",
): StoredArtifactV1 {
  const contentSha256 = sha256Hex(bytes);
  const storeIdentityHash = h("store");
  const lease = createRetentionLeaseReceipt({
    storeIdentityHash,
    objectKey: contentSha256,
    contentSha256,
    validFromStoreEpoch: "1",
    validThroughStoreEpoch: "100",
    issuerId: "full-family-test-issuer",
    issuerQualificationId: h("issuer-qualification"),
    qualificationRegistryRoot: h("qualification-registry"),
  });
  const ref = createReadOnlyArtifactRef({
    locator: { kind: "content-object", storeIdentityHash, objectKey: contentSha256 },
    immutableMirrorLocator: { kind: "content-object", storeIdentityHash, objectKey: contentSha256 },
    contentSha256,
    byteLength: String(bytes.byteLength),
    mediaType,
    schema,
    resolverPolicyHash: policy.policyHash,
    retentionLeaseReceiptId: lease.receiptId,
  });
  const mirror = createObservedImmutableMirror({
    storeIdentityHash,
    objectKey: contentSha256,
    bytes: encodeArtifactBytes(bytes),
    mediaType: ref.mediaType,
    schema: ref.schema,
  });
  const claim = createArtifactResolutionClaim({
    artifactRefId: ref.artifactRefId,
    resolverPolicyHash: policy.policyHash,
    observedMirror: mirror,
    outcome: "content-observed",
  });
  return Object.freeze({ bytes, ref, claim, lease });
}

class ArtifactSet {
  readonly artifacts: StoredArtifactV1[] = [];
  readonly nestedMutation: "none" | "payload" | "schema" | "media" | "source-schema";

  constructor(nestedMutation: "none" | "payload" | "schema" | "media" | "source-schema" = "none") {
    this.nestedMutation = nestedMutation;
  }

  addSemantic(bytes: Uint8Array, schema: SchemaRef): StoredArtifactV1 {
    const artifact = storeArtifact(
      this.nestedMutation === "payload"
        ? encodeCanonicalBytes({ forged: "self-consistent-but-semanticless", intendedPayloadHash: sha256Hex(bytes) })
        : bytes,
      this.nestedMutation === "schema" ? schemaRef(FULL_FAMILY_FACT_SCHEMA_MANIFEST) : schema,
      this.nestedMutation === "media" ? "application/octet-stream" : "application/json",
    );
    this.artifacts.push(artifact);
    return artifact;
  }

  addPhysical(bytes: Uint8Array, schema: SchemaRef): StoredArtifactV1 {
    const artifact = storeArtifact(bytes, schema);
    this.artifacts.push(artifact);
    return artifact;
  }
}

function storeBoundedBundle(bundle: FullFamilyFactBundleV1): Readonly<{
  readonly bundleArtifact: StoredArtifactV1;
  readonly storageArtifacts: readonly StoredArtifactV1[];
}> {
  const artifacts = new Map<Hash, StoredArtifactV1>();
  const add = (bytes: Uint8Array, schema: SchemaRef): StoredArtifactV1 => {
    const artifact = storeArtifact(bytes, schema);
    artifacts.set(artifact.ref.artifactRefId, artifact);
    return artifact;
  };
  const bindings: FullFamilyStoredPartitionBindingInputV1[] = [];
  for (const family of bundle.families) {
    const partitions = [
      ["source-plans", family.sourcePlans],
      ["universe-candidates", family.universeCandidates],
      ["outcomes", family.outcomes],
      ["instance-publications", family.instancePublications],
      ["projected-edges", family.projectedEdges],
      ["declared-coarse-capabilities", family.declaredCoarseCapabilities],
      ["coarse-rankable", family.coarseRankable],
      ["coarse-unavailable", family.coarseUnavailable],
      ["unranked-admissions", family.unrankedAdmissions],
      ["declared-exact-capabilities", family.declaredExactCapabilities],
      ["owned-actions", family.ownedActions],
    ] as const;
    for (const [role, partition] of partitions) {
      let nextPageRef: Readonly<{ readonly artifactRefId: Hash; readonly contentSha256: Hash }> | null = null;
      const pageCount = Math.ceil(partition.items.length / 128);
      for (let ordinal = pageCount - 1; ordinal >= 0; ordinal -= 1) {
        const page = sealFullFamilyArtifactRefPageV1({
          refs: partition.items.slice(ordinal * 128, (ordinal + 1) * 128).map(item => Object.freeze({
            artifactRefId: item.evidenceArtifactRefId,
            contentSha256: item.evidenceContentSha256,
          })),
          nextPageRef,
        });
        const artifact = add(
          encodeFullFamilyArtifactRefPageV1(page),
          schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.artifactRefPage),
        );
        nextPageRef = Object.freeze({
          artifactRefId: artifact.ref.artifactRefId,
          contentSha256: artifact.ref.contentSha256,
        });
      }
      const index = sealFullFamilyArtifactRefIndexV1({
        pageCount: String(pageCount),
        firstPageRef: nextPageRef,
      });
      const indexArtifact = add(
        encodeFullFamilyArtifactRefIndexV1(index),
        schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.artifactRefIndex),
      );
      bindings.push(Object.freeze({
        familyId: family.familyId,
        role: role as FullFamilyPartitionRoleV1,
        count: partition.count,
        root: partition.root,
        indexArtifactRefId: indexArtifact.ref.artifactRefId,
        indexContentSha256: indexArtifact.ref.contentSha256,
      }));
    }
  }
  const storage = sealFullFamilyFactBundleStorageV1(bundle, bindings);
  const bundleArtifact = add(
    encodeCanonicalBytes(storage),
    schemaRef(FULL_FAMILY_FACT_STORAGE_SCHEMA_MANIFEST),
  );
  return Object.freeze({ bundleArtifact, storageArtifacts: Object.freeze([...artifacts.values()]) });
}

function evidence(
  store: ArtifactSet,
  familyId: string,
  label: string,
  subjectKey: Hash,
  readyRecordHash: Hash,
  role: FullFamilyEvidenceArtifactV1["role"] = label as FullFamilyEvidenceArtifactV1["role"],
): FamilyEvidenceItemV1 {
  const itemId = h(`${familyId}:${label}:item`);
  const payload: FullFamilyEvidenceArtifactV1 = {
    schemaVersion: 1,
    kind: "aloha.full-family-evidence-artifact",
    readyRecordHash,
    role,
    familyId,
    itemId,
    subjectKey,
  };
  const artifact = store.addSemantic(
    encodeFullFamilyEvidenceArtifact(payload),
    schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.evidence),
  );
  return {
    familyId,
    itemId,
    subjectKey,
    evidenceArtifactRefId: artifact.ref.artifactRefId,
    evidenceContentSha256: artifact.ref.contentSha256,
  };
}

function outcome(
  store: ArtifactSet,
  familyId: string,
  label: string,
  candidate: CandidateRecordV1,
  rawOutcome: CandidateFinalOutcomeWireV1,
  runId: string,
  candidatePartitionRoot: Hash,
  exactOutcomePartitionRoot: Hash,
  readyRecordHash: Hash,
): FamilyOutcomeItemV1 {
  const { candidateKey, instanceKey, outcome: value } = deriveFullFamilyOutcomeSummary(candidate, rawOutcome);
  const itemId = h(`${familyId}:${label}:item`);
  const payload: FullFamilyOutcomeArtifactV1 = {
    schemaVersion: 2,
    kind: "aloha.full-family-outcome-artifact",
    readyRecordHash,
    familyId,
    itemId,
    runId,
    cutoff,
    candidatePartitionRoot,
    exactOutcomePartitionRoot,
    candidate,
    rawOutcome,
    candidateKey,
    instanceKey,
    outcome: value,
  };
  const artifact = store.addSemantic(
    encodeFullFamilyOutcomeArtifact(payload),
    schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.outcome),
  );
  return {
    familyId,
    itemId,
    candidateKey,
    instanceKey,
    outcome: value,
    evidenceArtifactRefId: artifact.ref.artifactRefId,
    evidenceContentSha256: artifact.ref.contentSha256,
  };
}

function family(
  store: ArtifactSet,
  familyId: string,
  _status: "mixed",
  binding: Readonly<{
    readyRecordHash: Hash;
    evidenceReadyRecordHash: Hash;
    outcomeReadyRecordHash: Hash;
    candidatePartition: FullFamilyMatrixEntryV1["candidatePartition"];
    candidateRecords: readonly CandidateRecordV1[];
    rawOutcomeByCandidate: ReadonlyMap<Hash, CandidateFinalOutcomeWireV1>;
    runId: string;
    candidatePartitionRoot: Hash;
    exactOutcomePartitionRoot: Hash;
  }>,
  declaredPlan: SourcePlanRefV1,
): FullFamilyMatrixEntryV1 {
  const sourcePlanKey = sourcePlanIdentity(declaredPlan);
  const verifiedCandidateKey = hashDomain("aloha/family-candidate/v2", {
    familyDefinitionHash: declaredPlan.familyDefinitionHash,
    instanceNominationKey: `${familyId}:candidate-a`,
  });
  const rejectedCandidateKey = hashDomain("aloha/family-candidate/v2", {
    familyDefinitionHash: declaredPlan.familyDefinitionHash,
    instanceNominationKey: `${familyId}:candidate-b`,
  });
  const verifiedCandidate = binding.candidateRecords.find(candidate => candidate.familyCandidateKey === verifiedCandidateKey)!;
  const rejectedCandidate = binding.candidateRecords.find(candidate => candidate.familyCandidateKey === rejectedCandidateKey)!;
  const verifiedRawOutcome = binding.rawOutcomeByCandidate.get(verifiedCandidateKey)!;
  const rejectedRawOutcome = binding.rawOutcomeByCandidate.get(rejectedCandidateKey)!;
  const instanceKey = deriveFullFamilyOutcomeSummary(verifiedCandidate, verifiedRawOutcome).instanceKey!;
  const sourcePlans = sealFamilyEvidencePartition([
    evidence(store, familyId, "source-plan", sourcePlanKey, binding.evidenceReadyRecordHash),
  ]);
  const universeCandidates = sealFamilyEvidencePartition([
    evidence(store, familyId, "universe-candidate-a", verifiedCandidateKey, binding.evidenceReadyRecordHash, "universe-candidate"),
    evidence(store, familyId, "universe-candidate-b", rejectedCandidateKey, binding.evidenceReadyRecordHash, "universe-candidate"),
  ]);
  const outcomes = sealFamilyOutcomePartition([
    outcome(
      store,
      familyId,
      "outcome-a",
      verifiedCandidate,
      verifiedRawOutcome,
      binding.runId,
      binding.candidatePartitionRoot,
      binding.exactOutcomePartitionRoot,
      binding.outcomeReadyRecordHash,
    ),
    outcome(
      store,
      familyId,
      "outcome-b",
      rejectedCandidate,
      rejectedRawOutcome,
      binding.runId,
      binding.candidatePartitionRoot,
      binding.exactOutcomePartitionRoot,
      binding.outcomeReadyRecordHash,
    ),
  ]);
  const instancePublications = sealFamilyEvidencePartition([
    evidence(store, familyId, "instance-publication", instanceKey, binding.evidenceReadyRecordHash),
  ]);
  const projectedEdges = sealFamilyEvidencePartition([
    evidence(store, familyId, "projected-edge", instanceKey, binding.evidenceReadyRecordHash),
  ]);
  const edgeId = projectedEdges.items[0]?.itemId;
  return sealFullFamilyMatrixEntry({
    familyId,
    familyDefinitionHash: declaredPlan.familyDefinitionHash,
    sourcePlanRoot: h(`${familyId}:source-plan-root`),
    sourcePlans,
    candidatePartition: binding.candidatePartition,
    universeCandidates,
    outcomes,
    instancePublications,
    projectedEdges,
    declaredCoarseCapabilities: sealFamilyEvidencePartition([
      evidence(
        store,
        familyId,
        "declared-coarse-capability",
        h(`${familyId}:coarse-owner`),
        binding.evidenceReadyRecordHash,
      ),
    ]),
    coarseRankable: sealFamilyEvidencePartition(
      edgeId !== undefined
        ? [evidence(store, familyId, "coarse-rankable", edgeId, binding.evidenceReadyRecordHash)]
        : [],
    ),
    coarseUnavailable: sealFamilyEvidencePartition([]),
    unrankedAdmissions: sealFamilyEvidencePartition([]),
    declaredExactCapabilities: sealFamilyEvidencePartition([
      evidence(
        store,
        familyId,
        "declared-exact-capability",
        h(`${familyId}:exact-owner`),
        binding.evidenceReadyRecordHash,
      ),
    ]),
    ownedActions: sealFamilyEvidencePartition([
      evidence(
        store,
        familyId,
        "owned-action",
        h(`${familyId}:action-owner`),
        binding.evidenceReadyRecordHash,
      ),
    ]),
  });
}

function sourcePlan(familyId: string, completeness: SourceCompleteness): SourcePlanRefV1 {
  return Object.freeze({
    ownerRef: h(`${familyId}:source-owner`),
    sourcePlanRef: h(`${familyId}:source-plan`),
    familyDefinitionHash: h(`${familyId}:definition`),
    completeness,
    historyStartBlock: completeness === "contiguous-history" ? "1" : null,
  });
}

function releaseSet(
  artifact: StoredArtifactV1,
  contractRoot: Hash,
  families: readonly FullFamilyMatrixEntryV1[],
): FamilyReleaseSetDraftV1 {
  return {
    sourceArtifactRefId: artifact.ref.artifactRefId,
    sourceArtifactContentSha256: artifact.ref.contentSha256,
    contractRoot,
    entries: families.map(value => ({
      familyId: value.familyId,
      familyDefinitionHash: value.familyDefinitionHash,
    })),
  };
}

interface FixtureV1 {
  readonly bundle: FullFamilyFactBundleV1;
  readonly runtime: PredicateRuntimeFactsV1;
}

function buildFixture(
  nestedMutation: "none" | "payload" | "schema" | "media" | "source-schema" = "none",
  lineageMutation: "none" | "foreign-evidence-ready" | "foreign-outcome-ready" | "foreign-candidate-root" = "none",
  coverageMutation: "none" | "foreign-cutoff" | "foreign-ready" = "none",
): FixtureV1 {
  const store = new ArtifactSet(nestedMutation);
  const familySpecs = Object.freeze([
    Object.freeze({ familyId: "alpha", status: "mixed" as const, completeness: "complete-snapshot" as const }),
  ]);
  const declaredSourcePlans = familySpecs.map(value => sourcePlan(value.familyId, value.completeness))
    .sort((left, right) => sourcePlanIdentity(left).localeCompare(sourcePlanIdentity(right)));
  const coverageCutoff = coverageMutation === "foreign-cutoff"
    ? Object.freeze({ ...cutoff, hash: h("foreign-coverage-cutoff-hash") })
    : cutoff;
  const sourceResults = declaredSourcePlans.map(plan => {
    const request = {
      kind: "family-source-plan-rpc" as const,
      version: 1 as const,
      method: "eth_call",
      params: [],
      target: null,
      manager: null,
      topic: null,
      lookback: null,
      chunk: null,
    };
    const physicalObservation = {
      kind: "family-source-plan-physical-observation" as const,
      version: 1 as const,
      requestId: h(`${plan.sourcePlanRef}:request`),
      releaseBindingId: h("release-binding"),
      releaseProvenanceHash: h("release-provenance"),
      sourceAuthorityRoot: h("source-authority"),
      sourceAnchorRoot: h("source-anchor"),
      provider: "qualification-provider",
      backendEpoch: "1",
      familyDefinitionHash: plan.familyDefinitionHash,
      plan,
      cutoff: coverageCutoff,
      requestSchemaHash: h(`${plan.sourcePlanRef}:request-schema`),
      request,
      response: { result: [] },
    };
    const physicalBytes = encodeCanonicalBytes(physicalObservation);
    const rawLocatorHash = sha256Hex(physicalBytes);
    const sourceEvidenceRef = {
      kind: "source-plan" as const,
      version: 1 as const,
      ownerRef: plan.ownerRef,
      sourcePlanRef: plan.sourcePlanRef,
      evidenceRef: h(`${plan.sourcePlanRef}:evidence-ref`),
      rawLocatorHash,
    };
    const evidence = {
      kind: "source-plan-evidence" as const,
      version: 1 as const,
      plan,
      cutoff: coverageCutoff,
      refs: [sourceEvidenceRef],
      rawLocatorHashes: [rawLocatorHash],
      evidenceRoot: sourcePlanEvidenceRoot({ plan, cutoff: coverageCutoff, refs: [sourceEvidenceRef], rawLocatorHashes: [rawLocatorHash] }),
    };
    const executionWithoutRoot = {
      kind: "source-plan-execution" as const,
      version: 1 as const,
      plan,
      cutoff: coverageCutoff,
      outcome: "complete" as const,
      from: plan.completeness === "contiguous-history" ? plan.historyStartBlock! : coverageCutoff.number,
      through: coverageCutoff.number,
      previousAppliedThrough: null,
      resultPartitionRoot: h(`${plan.sourcePlanRef}:result`),
      opaqueResult: { kind: "gate-core-source-result", sourcePlanRef: plan.sourcePlanRef },
      sourceEvidenceRefs: [sourceEvidenceRef],
      rawLocatorHashes: [rawLocatorHash],
      sourceEvidenceRoot: evidence.evidenceRoot,
    };
    return {
      execution: { ...executionWithoutRoot, executionRoot: sourcePlanExecutionRoot(executionWithoutRoot) },
      sourceEvidence: evidence,
      rawEvidenceLocators: [{ kind: "raw-evidence-locator" as const, version: 1 as const, rawLocatorHash, bytes: physicalBytes }],
    };
  });
  const coverage = sealSourceCoverage(coverageCutoff, declaredSourcePlans, sourceResults.map(result => result.execution));
  const releaseIntent = sealReleaseIntent(
    familySpecs.map((value, index) => ({
      familyId: value.familyId,
      manifestRoot: h(`${value.familyId}:manifest`),
      modulePath: `families/${value.familyId}/src/public.ts`,
      exportName: `FAMILY_${index}`,
    })),
    [],
  );
  const definitionCatalogRoot = h("definition-catalog-root");
  const runtimeCompositionRoot = h("runtime-composition-root");
  const projectionEntries = familySpecs.map(value => ({
    familyId: value.familyId,
    familyDefinitionHash: h(`${value.familyId}:definition`),
    entryHash: hashDomain("aloha/full-family/release-entry/v2", {
      familyId: value.familyId,
      familyDefinitionHash: h(`${value.familyId}:definition`),
    }),
  }));
  const projectionRoot = hashDomain("aloha/full-family/release-set/v2", projectionEntries);
  const generationId = h("generation");
  const generationRefreshPolicyHash = h("generation-refresh-policy");
  const sourceCoverageRoot = coverage.sourceCoverageRoot;
  const plan = declaredSourcePlans[0]!;
  const candidateRecords: CandidateRecordV1[] = ["candidate-a", "candidate-b"].map(label => {
    const evidenceRefs = [{
      kind: "source-plan" as const,
      version: 1 as const,
      ownerRef: plan.ownerRef,
      sourcePlanRef: plan.sourcePlanRef,
      evidenceRef: h(`alpha:${label}:nomination-evidence`),
      rawLocatorHash: h(`alpha:${label}:nomination-raw`),
    }];
    return Object.freeze({
      kind: "aloha.candidate-record" as const,
      version: "2" as const,
      familyId: "alpha",
      familyDefinitionHash: plan.familyDefinitionHash,
      instanceNominationKey: `alpha:${label}`,
      familyCandidateKey: hashDomain("aloha/family-candidate/v2", {
        familyDefinitionHash: plan.familyDefinitionHash,
        instanceNominationKey: `alpha:${label}`,
      }),
      candidateSubjectHash: candidateSubjectHash(plan.familyDefinitionHash, `alpha:${label}`),
      candidateEvidenceRoot: candidateEvidenceRoot(evidenceRefs),
      evidence: evidenceRefs,
    });
  }).sort((left, right) => left.familyCandidateKey.localeCompare(right.familyCandidateKey));
  const nominationReceipt = sealQualifiedSourcePlanNominationReceiptV1({
    cutoff: coverageCutoff,
    familyId: "alpha",
    familyDefinitionHash: plan.familyDefinitionHash,
    sourcePlanIdentity: sourcePlanIdentity(plan),
    sourcePlanLeafDigest: h("alpha:source-plan-leaf"),
    nominationProgramRoot: h("alpha:nomination-program"),
    nominationProgramProposalLeafDigest: h("alpha:nomination-proposal"),
    qualificationRoot: h("alpha:nomination-qualification"),
    denominator: {
      kind: "complete-source-result",
      persistedExecutionRoot: sourceResults[0]!.execution.executionRoot,
      resultPartitionRoot: sourceResults[0]!.execution.resultPartitionRoot,
    },
    claims: candidateRecords.map(candidate => ({
      sourcePlanIdentity: sourcePlanIdentity(plan),
      familyCandidateKey: candidate.familyCandidateKey,
      instanceNominationKey: candidate.instanceNominationKey,
      evidenceRefHash: nominationEvidenceRefHash(candidate.evidence[0]!),
    })),
  });
  const candidatePartitionRoot = hashCanonicalPartition("aloha/candidate-partition/v2", candidateRecords);
  const recentObservationRoot = h("recent-observation-root");
  const nominationClosure = sealNominationClosureV1({
    cutoff: coverageCutoff,
    recentObservationRoot,
    sourceExecutionSetRoot: h("source-execution-set-root"),
    sourceCoverageRoot,
    sourcePlanIdentities: [sourcePlanIdentity(plan)],
    receipts: [nominationReceipt],
    candidates: candidateRecords,
    candidatePartitionRoot,
  });
  const candidatePartitionStorageHash = h("candidate-partition-storage");
  const nominationClosureStorageHash = durableContentHash(
    nominationClosureKind,
    encodeNominationClosureV1(nominationClosure),
    [
      h("recent-observation-storage"),
      h("source-coverage-storage"),
      h("source-execution-set-storage"),
      h("source-plan-evidence-storage"),
      candidatePartitionStorageHash,
    ],
  );
  const runId = "full-family-qualification-run";
  const releaseBindingId = h("release-binding");
  const releaseProvenanceHash = h("release-provenance");
  const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(
    createSignedReleaseRuntimeAuthorityDescriptorV1({
      authorityClass: "signed-release",
      runtimeBindingId: releaseBindingId,
      releaseProvenanceHash,
      implementationCommit: candidateReleaseCommit,
    }),
  );
  const outcomeAuthority: QualificationOutcomeAuthorityV1 = Object.freeze({
    attestationAuthorityRoot: h("attestation-authority-root"),
    releaseAuthorityRoot: h("release-authority-root"),
    releaseProvenanceHash,
    frameworkAuthorityRoot: h("framework-authority-root"),
    executorAuthorityRoot: h("executor-authority-root"),
    attestationProofIssuerKeyId: h("attestation-proof-issuer-key"),
    workerEpoch: "1",
    executorSessionHash: h("executor-session"),
  });
  const verifiedCandidate = candidateRecords.find(candidate => candidate.instanceNominationKey === "alpha:candidate-a")!;
  const identityMemo = Object.freeze({ kind: "qualification-alpha-identity" });
  const verifiedPublication = sealInstancePublication({
    familyId: verifiedCandidate.familyId,
    familyDefinitionHash: verifiedCandidate.familyDefinitionHash,
    familyCandidateKey: verifiedCandidate.familyCandidateKey,
    instanceKey: "alpha:qualification-instance",
    cutoff,
    identityMemo,
    identityMemoHash: hashDomain("aloha/identity-memo/v1", identityMemo),
    descriptorHash: h("alpha:descriptor"),
    staticProjectionMemoHash: h("alpha:projection-memo"),
    requestedArtifactDependencyRoot: h("alpha:requested-artifact-dependencies"),
    validityDependencyRoot: h("alpha:validity-dependencies"),
    transitions: [],
    evidenceRoot: h("alpha:identity-evidence"),
  });
  const rawOutcomes = candidateRecords.map(candidate => candidate === verifiedCandidate
    ? issueQualificationVerifiedOutcome({
      runId,
      cutoff,
      candidatePartitionRoot,
      candidate,
      publication: verifiedPublication,
      authority: outcomeAuthority,
    })
    : issueQualificationChainRejectedOutcome({
      runId,
      cutoff,
      candidatePartitionRoot,
      candidate,
      authority: outcomeAuthority,
    }));
  const rawOutcomeByCandidate = new Map(rawOutcomes.map(outcome => [outcome.familyCandidateKey, outcome]));
  const exactOutcomePartitionRoot = exactOutcomePartitionRootV1({
    runId,
    cutoff,
    candidatePartitionRoot,
    attestationAuthorityRoot: outcomeAuthority.attestationAuthorityRoot,
    releaseAuthorityRoot: outcomeAuthority.releaseAuthorityRoot,
    releaseProvenanceHash: outcomeAuthority.releaseProvenanceHash,
    executorAuthorityRoot: outcomeAuthority.executorAuthorityRoot,
    outcomes: rawOutcomes,
  });
  const proofPayload = makeCandidatePartitionProofPayload({
    runId,
    cutoff: coverageCutoff,
    candidatePartitionRoot,
    candidatePartitionStorageHash,
    nominationClosureRoot: nominationClosure.root,
    nominationClosureStorageHash,
    candidates: candidateRecords,
    recentObservationRoot,
    sourceCoverageRoot,
    checkpointRevision: "1",
    releaseProvenanceHash,
    issuerKeyId: proofKeyId,
  });
  const proof = issueCandidatePartitionProof(proofPayload);
  const candidatePartitionProofStorageHash = durableContentHash(
    candidatePartitionProofKind,
    encodeCandidatePartitionProofV1(proof),
  );
  const verifierBinding: FullFamilyCandidateProofVerifierBindingV1 = {
    schemaVersion: 1,
    kind: "aloha.full-family-candidate-proof-verifier-binding",
    runtimeBindingId: releaseBindingId,
    releaseProvenanceHash,
    releaseAuthorityRoot: outcomeAuthority.releaseAuthorityRoot,
    candidateReleaseCommit,
    proofKeyId,
    proofPublicKeyHex,
  };
  const nominationClosureArtifact = store.addSemantic(
    encodeNominationClosureV1(nominationClosure),
    schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.nominationClosure),
  );
  const candidateProofArtifact = store.addSemantic(
    encodeCandidatePartitionProofV1(proof),
    schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.candidatePartitionProof),
  );
  const verifierBindingArtifact = store.addSemantic(
    encodeFullFamilyCandidateProofVerifierBinding(verifierBinding),
    schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.candidateProofVerifierBinding),
  );
  const instanceCatalogRoot = h("instance-catalog-root");
  const graphRoot = h("graph-root");
  const freshnessPayload = {
    cutoff,
    observedHead: { ...cutoff, parentHash: h("promotion-observed-parent") },
    observedAgeBlocks: "0",
    maxPromotionAgeBlocks: "1",
    generationRefreshPolicyHash,
    journalEpoch: "1",
    canonicalJournalRoot: h("canonical-journal-root"),
  };
  const promotionFreshness = {
    ...freshnessPayload,
    freshnessReceiptHash: hashDomain("aloha/promotion-freshness-receipt/v1", freshnessPayload),
  };
  const readyPayload = {
    generationId,
    parentGenerationId: null,
    generationRefreshPolicyHash,
    cutoff,
    recentObservationRange: { from: "51", to: "100" },
    definitionCatalogRoot,
    sourceCoverageRoot,
    candidatePartitionRoot,
    nominationClosureRoot: nominationClosure.root,
    nominationClosureStorageHash,
    candidatePartitionProofStorageHash,
    releaseProvenanceHash,
    exactOutcomePartitionRoot,
    verifiedMemoSetRoot: h("verified-memo-set"),
    instanceCatalogRoot,
    graphRoot,
    runtimeAuthority,
    edgeCount: "1",
    instanceCount: "1",
    promotionFreshness,
    promotedAtMonotonicNs: "10",
    promotionRevision: "1",
  };
  const ready = {
    ...readyPayload,
    readyRecordHash: hashDomain("aloha/ready-generation/v1", readyPayload),
  };
  const familyBinding = Object.freeze({
    readyRecordHash: ready.readyRecordHash,
    evidenceReadyRecordHash: lineageMutation === "foreign-evidence-ready"
      ? h("foreign-family-ready-record")
      : ready.readyRecordHash,
    outcomeReadyRecordHash: lineageMutation === "foreign-outcome-ready"
      ? h("foreign-family-outcome-ready-record")
      : ready.readyRecordHash,
    candidatePartition: nominationClosure.families[0]!,
    candidateRecords,
    rawOutcomeByCandidate,
    runId,
    candidatePartitionRoot,
    exactOutcomePartitionRoot,
  });
  const families = familySpecs.map(value => family(
    store,
    value.familyId,
    value.status,
    familyBinding,
    declaredSourcePlans.find(plan => plan.familyDefinitionHash === h(`${value.familyId}:definition`))!,
  ));
  const releaseIntentArtifact = storeArtifact(
    encodeCanonicalBytes(releaseIntent),
    schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.releaseIntent),
  );
  store.artifacts.push(releaseIntentArtifact);
  const definitionProjection: FullFamilyReleaseProjectionArtifactV1 = {
    schemaVersion: 1,
    kind: "aloha.full-family-release-projection-artifact",
    role: "definition-catalog",
    contractRoot: definitionCatalogRoot,
    count: String(projectionEntries.length),
    entrySetRoot: projectionRoot,
    entries: projectionEntries,
  };
  const runtimeProjection: FullFamilyReleaseProjectionArtifactV1 = {
    ...definitionProjection,
    role: "runtime-composition",
    contractRoot: runtimeCompositionRoot,
  };
  const definitionCatalogArtifact = store.addSemantic(
    encodeFullFamilyReleaseProjectionArtifact(definitionProjection),
    schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.releaseProjection),
  );
  const runtimeCompositionArtifact = store.addSemantic(
    encodeFullFamilyReleaseProjectionArtifact(runtimeProjection),
    schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.releaseProjection),
  );
  const readyArtifact = storeArtifact(
    encodeFullFamilyReadyRecord(ready),
    schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.readyRecord),
  );
  store.artifacts.push(readyArtifact);
  const sourceExecutionBindings = sourceResults.map(result => {
    const executionArtifact = store.addSemantic(
      encodeCanonicalBytes(result.execution),
      schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.sourceExecution),
    );
    const evidenceArtifact = store.addSemantic(
      encodeCanonicalBytes(result.sourceEvidence),
      schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.sourceEvidence),
    );
    const physicalObservations = result.rawEvidenceLocators.map(locator => {
      const artifact = store.addPhysical(
        locator.bytes,
        schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.sourcePhysicalObservation),
      );
      return {
        rawLocatorHash: locator.rawLocatorHash,
        artifactRefId: artifact.ref.artifactRefId,
        contentSha256: artifact.ref.contentSha256,
      };
    });
    return {
      ownerRef: result.execution.plan.ownerRef,
      sourcePlanRef: result.execution.plan.sourcePlanRef,
      familyDefinitionHash: result.execution.plan.familyDefinitionHash,
      executionRoot: result.execution.executionRoot,
      evidenceRoot: result.sourceEvidence.evidenceRoot,
      resultPartitionRoot: result.execution.resultPartitionRoot,
      executionArtifactRefId: executionArtifact.ref.artifactRefId,
      executionContentSha256: executionArtifact.ref.contentSha256,
      evidenceArtifactRefId: evidenceArtifact.ref.artifactRefId,
      evidenceContentSha256: evidenceArtifact.ref.contentSha256,
      physicalObservations,
    };
  }).sort((left, right) => hashDomain("aloha/source-plan-identity/v1", { ownerRef: left.ownerRef, sourcePlanRef: left.sourcePlanRef })
    .localeCompare(hashDomain("aloha/source-plan-identity/v1", { ownerRef: right.ownerRef, sourcePlanRef: right.sourcePlanRef })));
  const sourceCoveragePayload: FullFamilySourceCoverageArtifactV1 = {
    schemaVersion: 1,
    kind: "aloha.full-family-source-coverage-artifact",
    readyRecordHash: coverageMutation === "foreign-ready" ? h("foreign-coverage-ready") : ready.readyRecordHash,
    cutoff: coverageCutoff,
    executions: sourceExecutionBindings,
    sourceCoverage: coverage,
  };
  const sourceCoverageBytes = encodeFullFamilySourceCoverageArtifact(sourceCoveragePayload);
  const sourceCoverageArtifact = nestedMutation === "source-schema"
    ? storeArtifact(sourceCoverageBytes, schemaRef(FULL_FAMILY_FACT_SCHEMA_MANIFEST))
    : store.addSemantic(sourceCoverageBytes, schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.sourceCoverage));
  if (nestedMutation === "source-schema") store.artifacts.push(sourceCoverageArtifact);
  const releaseIntentSet = releaseSet(releaseIntentArtifact, releaseIntent.releaseIntentRoot, families);
  const definitionCatalogSet = releaseSet(definitionCatalogArtifact, definitionCatalogRoot, families);
  const runtimeCompositionSet = releaseSet(runtimeCompositionArtifact, runtimeCompositionRoot, families);
  const bundle = sealFullFamilyFacts({
    runtime: {
      generationId,
      releaseBindingId,
      readyCutoff: cutoff,
      readyCutoffRoot: hashDomain("aloha/full-family/ready-cutoff/v1", cutoff),
      actualCurrentSource: cutoff,
      actualCurrentSourceRoot: hashDomain("aloha/full-family/actual-current-source/v1", cutoff),
      recentObservationStartBlock: "51",
      recentObservationEndBlock: "100",
      recentObservationBlockCount: "50",
      releaseIntentRoot: releaseIntent.releaseIntentRoot,
      definitionCatalogRoot,
      generatedRuntimeDescriptorRoot: h("generated-runtime-descriptor-root"),
      runtimeCompositionRoot,
      sourceCoverageRoot,
      candidatePartitionRoot: lineageMutation === "foreign-candidate-root" ? h("foreign-family-candidate-partition-root") : candidatePartitionRoot,
      nominationClosureRoot: nominationClosure.root,
      nominationClosureStorageHash,
      candidatePartitionStorageHash,
      candidatePartitionProofStorageHash,
      releaseProvenanceHash,
      instanceCatalogRoot,
      graphRoot,
      readyRecordHash: ready.readyRecordHash,
      instanceCount: "1",
      edgeCount: "1",
      readyRecordArtifactRefId: readyArtifact.ref.artifactRefId,
      readyRecordContentSha256: readyArtifact.ref.contentSha256,
    },
    releaseIntent: releaseIntentSet,
    definitionCatalog: definitionCatalogSet,
    runtimeComposition: runtimeCompositionSet,
    sourceCoverage: {
      artifactRefId: sourceCoverageArtifact.ref.artifactRefId,
      contentSha256: sourceCoverageArtifact.ref.contentSha256,
      artifact: sourceCoveragePayload,
    },
    lineage: {
      nominationClosure: {
        artifactRefId: nominationClosureArtifact.ref.artifactRefId,
        contentSha256: nominationClosureArtifact.ref.contentSha256,
        storageHash: nominationClosureStorageHash,
        artifact: nominationClosure,
      },
      candidatePartitionProof: {
        artifactRefId: candidateProofArtifact.ref.artifactRefId,
        contentSha256: candidateProofArtifact.ref.contentSha256,
        storageHash: candidatePartitionProofStorageHash,
        artifact: proof,
      },
      candidateProofVerifierBinding: {
        artifactRefId: verifierBindingArtifact.ref.artifactRefId,
        contentSha256: verifierBindingArtifact.ref.contentSha256,
        artifact: verifierBinding,
      },
    },
    families,
  });
  const { bundleArtifact, storageArtifacts } = storeBoundedBundle(bundle);
  store.artifacts.push(...storageArtifacts);
  const refs = store.artifacts.map(artifact => artifact.ref);
  const claims = store.artifacts.map(artifact => artifact.claim);
  const leases = store.artifacts.map(artifact => artifact.lease);
  const observationId = h("observation");
  return {
    bundle,
    runtime: {
      facts: [createFullFamilyFactLocator({
        bundleArtifactRefId: bundleArtifact.ref.artifactRefId,
        bundleContentSha256: bundleArtifact.ref.contentSha256,
      })],
      refs,
      claims,
      policies: [policy],
      leases,
      observations: [{
        observationId,
        rawArtifactRefs: refs,
        observedClaimIds: claims.map(claim => claim.claimId),
      }],
      trustedObserverInvocation: {
        keyId: h("trusted-observer-key"),
        observerQualificationId: h("trusted-observer-qualification"),
        roleId: FULL_FAMILY_INVOCATION_SEAL_ROLE_ID,
        authenticatedArtifactRefIds: refs.map(ref => ref.artifactRefId).sort(),
        candidateReleaseCommit,
      },
    },
  };
}

async function buildQualificationAdapterCorpus() {
  const fixture = await buildFullFamilyQualificationCorpus();
  const { bundleArtifact, storageArtifacts } = storeBoundedBundle(fixture.bundle);
  const refs = [...fixture.artifacts.map(artifact => artifact.ref), ...storageArtifacts.map(artifact => artifact.ref)];
  const claims = [...fixture.artifacts.map(artifact => artifact.claim), ...storageArtifacts.map(artifact => artifact.claim)];
  const leases = [...fixture.artifacts.map(artifact => artifact.lease), ...storageArtifacts.map(artifact => artifact.lease)];
  const verifier = fixture.bundle.lineage.candidateProofVerifierBinding;
  const runtime: PredicateRuntimeFactsV1 = {
    facts: [createFullFamilyFactLocator({
      bundleArtifactRefId: bundleArtifact.ref.artifactRefId,
      bundleContentSha256: bundleArtifact.ref.contentSha256,
    })],
    refs,
    claims,
    policies: [...new Map([QUALIFICATION_FULL_FAMILY_RESOLVER_POLICY, policy]
      .map(value => [value.policyHash, value] as const)).values()]
      .sort((left, right) => left.policyHash.localeCompare(right.policyHash)),
    leases,
    observations: [{
      observationId: h("qualification-observation"),
      rawArtifactRefs: refs,
      observedClaimIds: claims.map(claim => claim.claimId),
    }],
    trustedObserverInvocation: {
      keyId: h("qualification-observer-key"),
      observerQualificationId: h("qualification-observer-qualification"),
      roleId: FULL_FAMILY_INVOCATION_SEAL_ROLE_ID,
      authenticatedArtifactRefIds: refs.map(ref => ref.artifactRefId).sort(),
      candidateReleaseCommit: verifier.artifact.candidateReleaseCommit,
    },
    trustedPredicateAuthority: createSelectedPredicateAuthorityEntry(
      "aloha.full-family.facts",
      [{
        roleId: "candidate-partition-proof-verifier",
        artifactRefId: verifier.artifactRefId,
        contentSha256: verifier.contentSha256,
        schema: schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.candidateProofVerifierBinding),
      }],
    ),
  };
  return { fixture, runtime };
}

function replaceBundle(runtime: PredicateRuntimeFactsV1, bundle: FullFamilyFactBundleV1): PredicateRuntimeFactsV1 {
  const oldLocator = runtime.facts[0] as { readonly bundleArtifactRefId: Hash };
  const oldRef = runtime.refs.find(ref => ref.artifactRefId === oldLocator.bundleArtifactRefId);
  assert.ok(oldRef !== undefined);
  const storageSchemaIds = new Set<string>([
    FULL_FAMILY_FACT_STORAGE_SCHEMA_MANIFEST.id,
    FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.artifactRefIndex.id,
    FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.artifactRefPage.id,
  ]);
  const removedRefIds = new Set(runtime.refs
    .filter(ref => ref.schema !== null && storageSchemaIds.has(ref.schema.id))
    .map(ref => ref.artifactRefId));
  const removedClaimIds = new Set<string>(runtime.claims
    .filter(claim => removedRefIds.has(claim.artifactRefId))
    .map(claim => claim.claimId));
  const removedLeaseIds = new Set(runtime.refs
    .filter(ref => removedRefIds.has(ref.artifactRefId))
    .map(ref => ref.retentionLeaseReceiptId));
  const { bundleArtifact: replacement, storageArtifacts } = storeBoundedBundle(bundle);
  return {
    facts: [createFullFamilyFactLocator({
      bundleArtifactRefId: replacement.ref.artifactRefId,
      bundleContentSha256: replacement.ref.contentSha256,
    })],
    refs: [...runtime.refs.filter(ref => !removedRefIds.has(ref.artifactRefId)), ...storageArtifacts.map(artifact => artifact.ref)],
    claims: [...runtime.claims.filter(claim => !removedRefIds.has(claim.artifactRefId)), ...storageArtifacts.map(artifact => artifact.claim)],
    policies: runtime.policies,
    leases: [...runtime.leases.filter(lease => !removedLeaseIds.has(lease.receiptId)), ...storageArtifacts.map(artifact => artifact.lease)],
    observations: runtime.observations.map(observation => ({
      ...observation,
      rawArtifactRefs: [...observation.rawArtifactRefs.filter(ref => !removedRefIds.has(ref.artifactRefId)), ...storageArtifacts.map(artifact => artifact.ref)],
      observedClaimIds: [...observation.observedClaimIds.filter(id => !removedClaimIds.has(id)), ...storageArtifacts.map(artifact => artifact.claim.claimId)],
    })),
    trustedObserverInvocation: runtime.trustedObserverInvocation,
    trustedPredicateAuthority: runtime.trustedPredicateAuthority,
  };
}

function replaceObservedArtifact(
  runtime: PredicateRuntimeFactsV1,
  artifactRefId: Hash,
  replacement: StoredArtifactV1,
): PredicateRuntimeFactsV1 {
  const oldRef = runtime.refs.find(ref => ref.artifactRefId === artifactRefId)!;
  const oldClaim = runtime.claims.find(claim => claim.artifactRefId === artifactRefId)!;
  return {
    ...runtime,
    refs: [...runtime.refs.filter(ref => ref.artifactRefId !== artifactRefId), replacement.ref],
    claims: [...runtime.claims.filter(claim => claim.artifactRefId !== artifactRefId), replacement.claim],
    leases: [...runtime.leases.filter(lease => lease.receiptId !== oldRef.retentionLeaseReceiptId), replacement.lease],
    observations: runtime.observations.map(observation => ({
      ...observation,
      rawArtifactRefs: [...observation.rawArtifactRefs.filter(ref => ref.artifactRefId !== artifactRefId), replacement.ref],
      observedClaimIds: [...observation.observedClaimIds.filter(id => id !== oldClaim.claimId), replacement.claim.claimId],
    })),
  };
}

function replaceBundleAndAuthenticate(
  runtime: PredicateRuntimeFactsV1,
  bundle: FullFamilyFactBundleV1,
): PredicateRuntimeFactsV1 {
  const replaced = replaceBundle(runtime, bundle);
  const observer = replaced.trustedObserverInvocation;
  const currentRefIds = new Set(runtime.refs.map(ref => ref.artifactRefId));
  const replacedRefIds = new Set(replaced.refs.map(ref => ref.artifactRefId));
  return {
    ...replaced,
    trustedObserverInvocation: observer == null
      ? null
      : {
        ...observer,
        authenticatedArtifactRefIds: [...new Set(observer.authenticatedArtifactRefIds
          .filter(refId => replacedRefIds.has(refId))
          .concat(replaced.refs.filter(ref => !currentRefIds.has(ref.artifactRefId)).map(ref => ref.artifactRefId)))].sort(),
      },
  };
}

function outcomeArtifact(
  fixture: FixtureV1,
  outcomeValue: FamilyOutcomeItemV1["outcome"],
): Readonly<{ readonly item: FamilyOutcomeItemV1; readonly artifact: FullFamilyOutcomeArtifactV1 }> {
  const item = fixture.bundle.families[0]!.outcomes.items.find(value => value.outcome === outcomeValue)!;
  const claim = fixture.runtime.claims.find(value => value.artifactRefId === item.evidenceArtifactRefId)!;
  assert.ok(claim.observedMirror !== null);
  return Object.freeze({ item, artifact: decodeFullFamilyOutcomeArtifact(decodeArtifactBytes(claim.observedMirror.bytes)) });
}

function replaceOutcomeArtifact(
  fixture: FixtureV1,
  current: FamilyOutcomeItemV1,
  rawArtifact: unknown,
): PredicateRuntimeFactsV1 {
  const replacement = storeArtifact(
    encodeCanonicalBytes(rawArtifact),
    schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.outcome),
  );
  const updatedItem: FamilyOutcomeItemV1 = Object.freeze({
    ...current,
    evidenceArtifactRefId: replacement.ref.artifactRefId,
    evidenceContentSha256: replacement.ref.contentSha256,
  });
  const oldFamily = fixture.bundle.families[0]!;
  const updatedFamily = sealFullFamilyMatrixEntry({
    ...oldFamily,
    outcomes: sealFamilyOutcomePartition(oldFamily.outcomes.items.map(item => item.itemId === current.itemId ? updatedItem : item)),
  });
  const draft = (set: FullFamilyFactBundleV1["releaseIntent"]): FamilyReleaseSetDraftV1 => ({
    sourceArtifactRefId: set.sourceArtifactRefId,
    sourceArtifactContentSha256: set.sourceArtifactContentSha256,
    contractRoot: set.contractRoot,
    entries: set.entries.map(({ familyId, familyDefinitionHash }) => ({ familyId, familyDefinitionHash })),
  });
  const bundle = sealFullFamilyFacts({
    runtime: fixture.bundle.runtime,
    releaseIntent: draft(fixture.bundle.releaseIntent),
    definitionCatalog: draft(fixture.bundle.definitionCatalog),
    runtimeComposition: draft(fixture.bundle.runtimeComposition),
    sourceCoverage: fixture.bundle.sourceCoverage,
    lineage: fixture.bundle.lineage,
    families: [updatedFamily],
  });
  const withOutcome = replaceObservedArtifact(fixture.runtime, current.evidenceArtifactRefId, replacement);
  const observer = withOutcome.trustedObserverInvocation;
  const authenticated: PredicateRuntimeFactsV1 = observer == null
    ? withOutcome
    : {
      ...withOutcome,
      trustedObserverInvocation: {
        ...observer,
        authenticatedArtifactRefIds: [...new Set(observer.authenticatedArtifactRefIds
          .filter(refId => refId !== current.evidenceArtifactRefId)
          .concat(replacement.ref.artifactRefId))].sort(),
      },
    };
  return replaceBundleAndAuthenticate(authenticated, bundle);
}

function qualificationMetadata(bundle: FullFamilyFactBundleV1) {
  return {
    releaseIntentRoot: bundle.runtime.releaseIntentRoot,
    definitionCatalogRoot: bundle.runtime.definitionCatalogRoot,
    descriptorRoot: bundle.runtime.generatedRuntimeDescriptorRoot,
    families: bundle.families.map(family => ({
      familyId: family.familyId,
      familyDefinitionHash: family.familyDefinitionHash,
      sourcePlanRoot: family.sourcePlanRoot,
      sourcePlanRefs: bundle.sourceCoverage.artifact.sourceCoverage.entries
        .filter(entry => entry.familyDefinitionHash === family.familyDefinitionHash)
        .map(entry => ({
          ownerRef: entry.ownerRef,
          sourcePlanRef: entry.sourcePlanRef,
          familyDefinitionHash: entry.familyDefinitionHash,
          completeness: entry.completeness,
          historyStartBlock: entry.historyStartBlock,
        })),
    })),
  } as const;
}

function evaluate(runtime: PredicateRuntimeFactsV1, bundle?: FullFamilyFactBundleV1) {
  const reasons: { code: string; path: string }[] = [];
  const subject = bundle ?? buildFixture().bundle;
  const evaluator = createFullFamilyPredicateEvaluatorForQualification(qualificationMetadata(subject));
  const verdict = evaluator.evaluateLive(runtime, {
    add: (code, path) => reasons.push({ code, path }),
  });
  return { verdict, reasons };
}

test("full-family adapter accepts one exact content-addressed family matrix", () => {
  const fixture = buildFixture();
  const result = evaluate(fixture.runtime, fixture.bundle);
  assert.equal(result.verdict, "pass", JSON.stringify(result.reasons));
  assert.equal(fixture.bundle.families.length, 1);
  assert.deepEqual(fixture.bundle.families[0]!.outcomes.items.map(item => item.outcome).sort(), ["chain-proven-rejected", "verified"]);
  assert.equal(evaluate({ ...fixture.runtime, facts: [fixture.bundle] }, fixture.bundle).verdict, "invalid");
});

test("full-family adapter verifies the candidate proof with real Ed25519", () => {
  const fixture = buildFixture();
  const current = fixture.bundle.lineage.candidatePartitionProof;
  const signature = current.artifact.signatureHex;
  const tamperedProof = decodeCandidatePartitionProofV1({
    ...current.artifact,
    signatureHex: `${signature.slice(0, -2)}${signature.endsWith("00") ? "01" : "00"}`,
  });
  const replacement = storeArtifact(
    encodeCandidatePartitionProofV1(tamperedProof),
    schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.candidatePartitionProof),
  );
  const withProof = replaceObservedArtifact(fixture.runtime, current.artifactRefId, replacement);
  const bundle = {
    ...fixture.bundle,
    lineage: {
      ...fixture.bundle.lineage,
      candidatePartitionProof: {
        ...current,
        artifactRefId: replacement.ref.artifactRefId,
        contentSha256: replacement.ref.contentSha256,
        artifact: tamperedProof,
      },
    },
  } as FullFamilyFactBundleV1;
  const result = evaluate(replaceBundle(withProof, bundle), fixture.bundle);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some(reason => reason.path === "$.lineage.candidatePartitionProof.signatureHex"));
});

test("coherent A-only summary re-root cannot erase immutable nominated candidate B", () => {
  const fixture = buildFixture();
  const family = fixture.bundle.families[0]!;
  const verified = family.outcomes.items.find(item => item.outcome === "verified")!;
  const universeCandidates = sealFamilyEvidencePartition(
    family.universeCandidates.items.filter(item => item.subjectKey === verified.candidateKey),
  );
  const outcomes = sealFamilyOutcomePartition([verified]);
  const nextFamily = sealFullFamilyMatrixEntry({
    ...family,
    universeCandidates,
    outcomes,
  });
  const draft = (set: FullFamilyFactBundleV1["releaseIntent"]): FamilyReleaseSetDraftV1 => ({
    sourceArtifactRefId: set.sourceArtifactRefId,
    sourceArtifactContentSha256: set.sourceArtifactContentSha256,
    contractRoot: set.contractRoot,
    entries: set.entries.map(({ familyId, familyDefinitionHash }) => ({ familyId, familyDefinitionHash })),
  });
  const reRooted = sealFullFamilyFacts({
    runtime: fixture.bundle.runtime,
    releaseIntent: draft(fixture.bundle.releaseIntent),
    definitionCatalog: draft(fixture.bundle.definitionCatalog),
    runtimeComposition: draft(fixture.bundle.runtimeComposition),
    sourceCoverage: fixture.bundle.sourceCoverage,
    lineage: fixture.bundle.lineage,
    families: [nextFamily],
  });
  const result = evaluate(replaceBundle(fixture.runtime, reRooted), fixture.bundle);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some(reason => reason.code === "schema-invalid" || reason.code === "predicate-observation-mismatch"));
});

test("candidate verifier binding must be inside GateCore's signed observer subject-ref closure", () => {
  const fixture = buildFixture();
  const runtime = {
    ...fixture.runtime,
    trustedObserverInvocation: {
      ...fixture.runtime.trustedObserverInvocation!,
      authenticatedArtifactRefIds: fixture.runtime.trustedObserverInvocation!.authenticatedArtifactRefIds
        .filter(refId => refId !== fixture.bundle.lineage.candidateProofVerifierBinding.artifactRefId),
    },
  };
  const result = evaluate(runtime, fixture.bundle);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some(reason => reason.path.endsWith("signedObserverClosure")));
});

test("candidate verifier binding joins GateCore's verified release commit", () => {
  const fixture = buildFixture();
  const result = evaluate({
    ...fixture.runtime,
    trustedObserverInvocation: {
      ...fixture.runtime.trustedObserverInvocation!,
      candidateReleaseCommit: "b".repeat(40),
    },
  }, fixture.bundle);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some(reason => reason.path.endsWith("candidateReleaseCommit")));
});

test("full-family raw outcome mutations remain invalid after content re-addressing", async t => {
  const fixture = buildFixture();
  const rejected = outcomeArtifact(fixture, "chain-proven-rejected");
  const verified = outcomeArtifact(fixture, "verified");
  const mutate = (base: FullFamilyOutcomeArtifactV1): Record<string, unknown> =>
    structuredClone(base) as unknown as Record<string, unknown>;
  const raw = (artifact: Record<string, unknown>): Record<string, unknown> => artifact.rawOutcome as Record<string, unknown>;
  const rejectionEvidence = (artifact: Record<string, unknown>): Record<string, unknown> =>
    raw(artifact).rejectionEvidence as Record<string, unknown>;
  const cases: readonly Readonly<{
    readonly id: FullFamilyOutcomeArtifactCriticalMutationId;
    readonly name: string;
    readonly item: FamilyOutcomeItemV1;
    readonly artifact: FullFamilyOutcomeArtifactV1;
    readonly apply: (artifact: Record<string, unknown>) => void;
  }>[] = [
    {
      id: "outcome-summary-raw-mismatch",
      name: "summary/raw mismatch",
      item: rejected.item,
      artifact: rejected.artifact,
      apply: artifact => { artifact.outcome = "verified"; },
    },
    {
      id: "outcome-raw-extra-field",
      name: "raw extra field",
      item: rejected.item,
      artifact: rejected.artifact,
      apply: artifact => { raw(artifact).unexpected = "forged"; },
    },
    {
      id: "outcome-rejection-evidence-child-omission",
      name: "deleted rejection evidence child",
      item: rejected.item,
      artifact: rejected.artifact,
      apply: artifact => { rejectionEvidence(artifact).transportFacts = []; },
    },
    {
      id: "outcome-rejection-evidence-child-splice",
      name: "changed rejection evidence child",
      item: rejected.item,
      artifact: rejected.artifact,
      apply: artifact => {
        const evidence = rejectionEvidence(artifact);
        const facts = evidence.transportFacts as Record<string, unknown>[];
        facts[0] = { ...facts[0], ordinal: "1" };
      },
    },
    {
      id: "outcome-rejection-proof-splice",
      name: "rejection proof splice",
      item: rejected.item,
      artifact: rejected.artifact,
      apply: artifact => {
        const proof = raw(artifact).proof as Record<string, unknown>;
        proof.proofHash = h("spliced-rejection-proof");
      },
    },
    {
      id: "outcome-candidate-substitution",
      name: "raw candidate substitution",
      item: rejected.item,
      artifact: rejected.artifact,
      apply: artifact => { artifact.candidate = verified.artifact.candidate; },
    },
    {
      id: "outcome-cross-run",
      name: "cross run",
      item: rejected.item,
      artifact: rejected.artifact,
      apply: artifact => { artifact.runId = "foreign-run"; },
    },
    {
      id: "outcome-cross-cutoff",
      name: "cross cutoff",
      item: rejected.item,
      artifact: rejected.artifact,
      apply: artifact => { artifact.cutoff = { ...cutoff, hash: h("foreign-outcome-cutoff") }; },
    },
    {
      id: "outcome-cross-candidate",
      name: "cross candidate",
      item: rejected.item,
      artifact: rejected.artifact,
      apply: artifact => { raw(artifact).familyCandidateKey = verified.artifact.candidateKey; },
    },
    {
      id: "outcome-candidate-partition-root-splice",
      name: "candidate partition root splice",
      item: rejected.item,
      artifact: rejected.artifact,
      apply: artifact => { artifact.candidatePartitionRoot = h("foreign-candidate-partition"); },
    },
    {
      id: "outcome-exact-partition-root-splice",
      name: "exact outcome set root mismatch",
      item: rejected.item,
      artifact: rejected.artifact,
      apply: artifact => { artifact.exactOutcomePartitionRoot = h("foreign-exact-outcome-partition"); },
    },
    {
      id: "outcome-release-provenance-splice",
      name: "release provenance splice",
      item: rejected.item,
      artifact: rejected.artifact,
      apply: artifact => { raw(artifact).releaseProvenanceHash = h("foreign-release-provenance"); },
    },
    {
      id: "outcome-release-authority-splice",
      name: "release authority splice",
      item: rejected.item,
      artifact: rejected.artifact,
      apply: artifact => { raw(artifact).releaseAuthorityRoot = h("foreign-release-authority"); },
    },
    {
      id: "outcome-executor-authority-splice",
      name: "executor authority splice",
      item: rejected.item,
      artifact: rejected.artifact,
      apply: artifact => { raw(artifact).executorAuthorityRoot = h("foreign-executor-authority"); },
    },
  ];
  assert.deepEqual(
    [...cases.map(mutation => mutation.id), "outcome-observer-closure-omission"].sort(),
    FULL_FAMILY_OUTCOME_ARTIFACT_CRITICAL_MUTATION_IDS,
  );
  for (const mutation of cases) {
    await t.test(mutation.name, () => {
      const artifact = mutate(mutation.artifact);
      mutation.apply(artifact);
      const runtime = replaceOutcomeArtifact(fixture, mutation.item, artifact);
      const result = evaluate(runtime, fixture.bundle);
      assert.equal(result.verdict, "invalid", JSON.stringify(result.reasons));
    });
  }
});

test("full-family outcome must remain inside the authenticated qualified-observer closure", () => {
  const fixture = buildFixture();
  const rejected = outcomeArtifact(fixture, "chain-proven-rejected");
  const observer = fixture.runtime.trustedObserverInvocation!;
  const result = evaluate({
    ...fixture.runtime,
    trustedObserverInvocation: {
      ...observer,
      authenticatedArtifactRefIds: observer.authenticatedArtifactRefIds
        .filter(refId => refId !== rejected.item.evidenceArtifactRefId),
    },
  }, fixture.bundle);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some(reason => reason.path.endsWith("checkpointReadVerifiedObserverClosure")));
});

test("qualification full-family adapter rejects a fixture denominator despite self-consistent artifacts", () => {
  const fixture = buildFixture();
  const reasons: { code: string; path: string }[] = [];
  assert.equal(FULL_FAMILY_PREDICATE_EVALUATOR.evaluateLive(fixture.runtime, {
    add: (code, path) => reasons.push({ code, path }),
  }), "invalid");
  assert.ok(reasons.some(reason => reason.code === "schema-invalid"
    || reason.code === "registry-mismatch"
    || reason.code === "predicate-observation-mismatch"));
});

test("qualification full-family adapter accepts corpus-derived Catalog, Graph, coarse and action artifacts", async () => {
  const { fixture, runtime } = await buildQualificationAdapterCorpus();
  const reasons: { code: string; path: string }[] = [];
  assert.equal(FULL_FAMILY_PREDICATE_EVALUATOR.evaluateLive(runtime, {
    add: (code, path) => reasons.push({ code, path }),
  }), "pass", JSON.stringify(reasons));
  assert.equal(fixture.bundle.runtime.graphRoot, fixture.graphRoot);
  const bundleRefId = (runtime.facts[0] as { readonly bundleArtifactRefId: Hash }).bundleArtifactRefId;
  const chunkedBundleClaim = runtime.claims.find(claim => claim.artifactRefId === bundleRefId);
  assert.ok(chunkedBundleClaim?.observedMirror);
  assert.ok(Number(chunkedBundleClaim.observedMirror.bytes.byteLength) <= ARTIFACT_BYTES_CHUNK_BYTE_LENGTH);
  assert.equal(chunkedBundleClaim.observedMirror.bytes.chunks.length, 1);
  assert.notDeepEqual(fixture.bundle.runtime.readyCutoff, fixture.bundle.runtime.actualCurrentSource);
  assert.deepEqual(
    fixture.bundle.families.find(family => family.familyId === "univ2-standard")!
      .coarseRankable.items.map(item => item.itemId).sort(),
    [...fixture.coarseArtifactHashes].sort(),
  );
});

test("production full-family adapter rejects an exact-addressed runtime metadata object with extra keys", async () => {
  const { fixture, runtime } = await buildQualificationAdapterCorpus();
  const current = fixture.artifacts.find(artifact => artifact.schemaKey === "runtimeComposition")!;
  const decoded = decodeCanonicalJson(current.bytes) as Record<string, unknown>;
  const replacement = storeArtifact(
    encodeCanonicalBytes({ ...decoded, producerVerdict: "pass" }),
    schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.runtimeComposition),
  );
  const draft = (set: FullFamilyFactBundleV1["releaseIntent"], source = {
    artifactRefId: set.sourceArtifactRefId,
    contentSha256: set.sourceArtifactContentSha256,
  }): FamilyReleaseSetDraftV1 => ({
    sourceArtifactRefId: source.artifactRefId,
    sourceArtifactContentSha256: source.contentSha256,
    contractRoot: set.contractRoot,
    entries: set.entries.map(({ familyId, familyDefinitionHash }) => ({ familyId, familyDefinitionHash })),
  });
  const bundle = sealFullFamilyFacts({
    runtime: fixture.bundle.runtime,
    releaseIntent: draft(fixture.bundle.releaseIntent),
    definitionCatalog: draft(fixture.bundle.definitionCatalog),
    runtimeComposition: draft(fixture.bundle.runtimeComposition, replacement.ref),
    sourceCoverage: fixture.bundle.sourceCoverage,
    lineage: fixture.bundle.lineage,
    families: fixture.bundle.families,
  });
  const replaced = replaceObservedArtifact(runtime, current.artifactRefId, replacement);
  const observer = replaced.trustedObserverInvocation!;
  const authenticated = {
    ...replaced,
    trustedObserverInvocation: {
      ...observer,
      authenticatedArtifactRefIds: observer.authenticatedArtifactRefIds
        .filter(refId => refId !== current.artifactRefId)
        .concat(replacement.ref.artifactRefId)
        .sort(),
    },
  };
  const reasons: { code: string; path: string }[] = [];
  const verdict = FULL_FAMILY_PREDICATE_EVALUATOR.evaluateLive(
    replaceBundleAndAuthenticate(authenticated, bundle),
    { add: (code, path) => reasons.push({ code, path }) },
  );
  assert.equal(verdict, "invalid");
  assert.ok(reasons.some(reason => reason.code === "registry-mismatch"
    && reason.path === "$.runtimeComposition.sourceArtifact"), JSON.stringify(reasons));

  const missingReasons: { code: string; path: string }[] = [];
  const missing = {
    ...runtime,
    refs: runtime.refs.filter(ref => ref.artifactRefId !== current.artifactRefId),
    claims: runtime.claims.filter(claim => claim.artifactRefId !== current.artifactRefId),
    leases: runtime.leases.filter(lease => lease.receiptId !== current.ref.retentionLeaseReceiptId),
  };
  assert.equal(FULL_FAMILY_PREDICATE_EVALUATOR.evaluateLive(missing, {
    add: (code, path) => missingReasons.push({ code, path }),
  }), "invalid");
  assert.ok(missingReasons.some(reason => reason.code === "artifact-ref-mismatch"), JSON.stringify(missingReasons));
});

test("production full-family adapter rejects a coherent cross-run actual current source", async () => {
  const { fixture, runtime } = await buildQualificationAdapterCorpus();
  const actualCurrentSource = Object.freeze({
    ...fixture.bundle.runtime.actualCurrentSource,
    number: "102",
    hash: h("foreign-actual-current-source"),
    stateRoot: h("foreign-actual-current-state-root"),
  });
  const draft = (set: FullFamilyFactBundleV1["releaseIntent"]): FamilyReleaseSetDraftV1 => ({
    sourceArtifactRefId: set.sourceArtifactRefId,
    sourceArtifactContentSha256: set.sourceArtifactContentSha256,
    contractRoot: set.contractRoot,
    entries: set.entries.map(({ familyId, familyDefinitionHash }) => ({ familyId, familyDefinitionHash })),
  });
  const mutated = sealFullFamilyFacts({
    runtime: {
      ...fixture.bundle.runtime,
      actualCurrentSource,
      actualCurrentSourceRoot: hashDomain("aloha/full-family/actual-current-source/v1", actualCurrentSource),
    },
    releaseIntent: draft(fixture.bundle.releaseIntent),
    definitionCatalog: draft(fixture.bundle.definitionCatalog),
    runtimeComposition: draft(fixture.bundle.runtimeComposition),
    sourceCoverage: fixture.bundle.sourceCoverage,
    lineage: fixture.bundle.lineage,
    families: fixture.bundle.families,
  });
  const attacked = replaceBundleAndAuthenticate(runtime, mutated);
  const reasons: { code: string; path: string }[] = [];
  assert.equal(FULL_FAMILY_PREDICATE_EVALUATOR.evaluateLive(attacked, {
    add: (code, path) => reasons.push({ code, path }),
  }), "invalid");
  assert.ok(reasons.some(reason =>
    reason.code === "predicate-observation-mismatch" && reason.path.endsWith(".coarse"),
  ), JSON.stringify(reasons));
});

test("externally pinned candidate-proof authority rejects a coherent attacker key rotation and re-sign", async () => {
  const { fixture, runtime } = await buildQualificationAdapterCorpus();
  const foreignKeys = generateKeyPairSync("ed25519");
  const foreignPublicKeyHex = `0x${foreignKeys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}` as `0x${string}`;
  const foreignKeyId = hashDomain("test/gate-core/full-family/foreign-proof-key/v1", foreignPublicKeyHex);
  const currentProof = fixture.bundle.lineage.candidatePartitionProof.artifact;
  const foreignPayload: CandidatePartitionProofPayloadV1 = {
    schemaVersion: currentProof.schemaVersion,
    kind: currentProof.kind,
    runId: currentProof.runId,
    cutoff: currentProof.cutoff,
    candidatePartitionRoot: currentProof.candidatePartitionRoot,
    candidatePartitionStorageHash: currentProof.candidatePartitionStorageHash,
    nominationClosureRoot: currentProof.nominationClosureRoot,
    nominationClosureStorageHash: currentProof.nominationClosureStorageHash,
    recordCount: currentProof.recordCount,
    candidateKeysRoot: currentProof.candidateKeysRoot,
    recentObservationRoot: currentProof.recentObservationRoot,
    sourceCoverageRoot: currentProof.sourceCoverageRoot,
    checkpointRevision: currentProof.checkpointRevision,
    releaseProvenanceHash: currentProof.releaseProvenanceHash,
    issuerKeyId: foreignKeyId,
    proofVersion: currentProof.proofVersion,
  };
  const payloadHash = candidatePartitionProofPayloadHash(foreignPayload);
  const foreignProof = decodeCandidatePartitionProofV1({
    ...foreignPayload,
    proofId: candidatePartitionProofId(payloadHash),
    payloadHash,
    signatureAlgorithm: "ed25519",
    signerKeyId: foreignKeyId,
    signatureHex: `0x${sign(null, Buffer.from(candidatePartitionProofSigningBytes(foreignPayload, foreignKeyId)), foreignKeys.privateKey).toString("hex")}`,
  });
  const currentVerifier = fixture.bundle.lineage.candidateProofVerifierBinding.artifact;
  const foreignVerifier: FullFamilyCandidateProofVerifierBindingV1 = {
    ...currentVerifier,
    releaseAuthorityRoot: h("attacker-release-authority-root"),
    proofKeyId: foreignKeyId,
    proofPublicKeyHex: foreignPublicKeyHex,
  };
  const proofArtifact = storeArtifact(
    encodeCandidatePartitionProofV1(foreignProof),
    schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.candidatePartitionProof),
  );
  const verifierArtifact = storeArtifact(
    encodeFullFamilyCandidateProofVerifierBinding(foreignVerifier),
    schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.candidateProofVerifierBinding),
  );
  let attackedRuntime = replaceObservedArtifact(
    runtime,
    fixture.bundle.lineage.candidatePartitionProof.artifactRefId,
    proofArtifact,
  );
  attackedRuntime = replaceObservedArtifact(
    attackedRuntime,
    fixture.bundle.lineage.candidateProofVerifierBinding.artifactRefId,
    verifierArtifact,
  );
  attackedRuntime = {
    ...attackedRuntime,
    trustedObserverInvocation: {
      ...attackedRuntime.trustedObserverInvocation!,
      authenticatedArtifactRefIds: attackedRuntime.refs.map(ref => ref.artifactRefId).sort(),
    },
  };
  const attackedBundle = {
    ...fixture.bundle,
    lineage: {
      ...fixture.bundle.lineage,
      candidatePartitionProof: {
        ...fixture.bundle.lineage.candidatePartitionProof,
        artifactRefId: proofArtifact.ref.artifactRefId,
        contentSha256: proofArtifact.ref.contentSha256,
        artifact: foreignProof,
      },
      candidateProofVerifierBinding: {
        artifactRefId: verifierArtifact.ref.artifactRefId,
        contentSha256: verifierArtifact.ref.contentSha256,
        artifact: foreignVerifier,
      },
    },
  } as FullFamilyFactBundleV1;
  attackedRuntime = replaceBundle(attackedRuntime, attackedBundle);
  const reasons: { code: string; path: string }[] = [];
  assert.equal(FULL_FAMILY_PREDICATE_EVALUATOR.evaluateLive(attackedRuntime, {
    add: (code, path) => reasons.push({ code, path }),
  }), "invalid");
  assert.ok(reasons.some(reason => reason.path.endsWith("releaseAuthorityPin")), JSON.stringify(reasons));
});

test("full-family adapter rejects self-consistent canonical JSON that does not carry the nested fact semantics", () => {
  const forged = buildFixture("payload");
  const result = evaluate(forged.runtime);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some(reason => reason.code === "schema-invalid"));
});

test("full-family adapter rejects self-consistent nested artifacts with the wrong schema or media type", () => {
  assert.equal(evaluate(buildFixture("schema").runtime).verdict, "invalid");
  assert.equal(evaluate(buildFixture("media").runtime).verdict, "invalid");
});

test("full-family adapter resolves and binds the source-coverage ref, content and schema", () => {
  const fixture = buildFixture();
  const foreignRefBundle = {
    ...fixture.bundle,
    sourceCoverage: { ...fixture.bundle.sourceCoverage, artifactRefId: h("foreign-source-coverage-ref") },
  } as FullFamilyFactBundleV1;
  assert.equal(evaluate(replaceBundle(fixture.runtime, foreignRefBundle)).verdict, "invalid");
  const foreignContentBundle = {
    ...fixture.bundle,
    sourceCoverage: { ...fixture.bundle.sourceCoverage, contentSha256: h("foreign-source-coverage-content") },
  } as FullFamilyFactBundleV1;
  assert.equal(evaluate(replaceBundle(fixture.runtime, foreignContentBundle)).verdict, "invalid");
  assert.equal(evaluate(buildFixture("source-schema").runtime).verdict, "invalid");
});

test("full-family adapter rejects source coverage from a foreign cutoff or ReadyGeneration", () => {
  assert.equal(evaluate(buildFixture("none", "none", "foreign-cutoff").runtime).verdict, "invalid");
  assert.equal(evaluate(buildFixture("none", "none", "foreign-ready").runtime).verdict, "invalid");
});

test("full-family adapter rejects re-addressed evidence from a foreign ReadyGeneration", () => {
  const result = evaluate(buildFixture("none", "foreign-evidence-ready").runtime);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some(reason => reason.code === "predicate-observation-mismatch"));
});

test("full-family adapter rejects a re-addressed outcome from a foreign ReadyGeneration", () => {
  const result = evaluate(buildFixture("none", "foreign-outcome-ready").runtime);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some(reason => reason.code === "predicate-observation-mismatch"));
});

test("full-family adapter rejects a self-consistent foreign candidate partition root", () => {
  const result = evaluate(buildFixture("none", "foreign-candidate-root").runtime);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some(reason => reason.code === "predicate-observation-mismatch"));
});

test("full-family adapter rejects missing evidence and a ready/Graph splice in a newly addressed bundle", () => {
  const fixture = buildFixture();
  const evidenceRef = fixture.runtime.refs.find(ref =>
    ref.artifactRefId !== (fixture.runtime.facts[0] as { readonly bundleArtifactRefId: Hash }).bundleArtifactRefId
    && ref.artifactRefId !== fixture.bundle.runtime.readyRecordArtifactRefId);
  assert.ok(evidenceRef !== undefined);
  const missing = evaluate({
    ...fixture.runtime,
    refs: fixture.runtime.refs.filter(ref => ref.artifactRefId !== evidenceRef.artifactRefId),
    claims: fixture.runtime.claims.filter(claim => claim.artifactRefId !== evidenceRef.artifactRefId),
    leases: fixture.runtime.leases.filter(lease => lease.receiptId !== evidenceRef.retentionLeaseReceiptId),
  });
  assert.equal(missing.verdict, "invalid");
  const splicedBundle = {
    ...fixture.bundle,
    runtime: { ...fixture.bundle.runtime, graphRoot: h("spliced-graph-root") },
  } as FullFamilyFactBundleV1;
  const spliced = evaluate(replaceBundle(fixture.runtime, splicedBundle));
  assert.equal(spliced.verdict, "invalid");
  assert.ok(spliced.reasons.some(reason => reason.path === "$.runtime.readyRecord"));
});

test("full-family adapter rejects a promotion head that omits parentHash", () => {
  const fixture = buildFixture();
  const readyRefId = fixture.bundle.runtime.readyRecordArtifactRefId;
  const readyClaim = fixture.runtime.claims.find(claim => claim.artifactRefId === readyRefId);
  assert.ok(readyClaim?.observedMirror !== null && readyClaim?.observedMirror !== undefined);
  const rawReady = decodeCanonicalJson(decodeArtifactBytes(readyClaim.observedMirror.bytes)) as {
    readonly promotionFreshness: {
      readonly observedHead: {
        readonly chainId: string;
        readonly number: string;
        readonly hash: Hash;
        readonly parentHash: Hash;
        readonly stateRoot: Hash;
      };
    };
  } & Record<string, unknown>;
  const { parentHash: _omitted, ...observedHeadWithoutParentHash } = rawReady.promotionFreshness.observedHead;
  const replacement = storeArtifact(encodeCanonicalBytes({
    ...rawReady,
    promotionFreshness: {
      ...rawReady.promotionFreshness,
      observedHead: observedHeadWithoutParentHash,
    },
  }), schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.readyRecord));
  const withReady = replaceObservedArtifact(fixture.runtime, readyRefId, replacement);
  const bundle = {
    ...fixture.bundle,
    runtime: {
      ...fixture.bundle.runtime,
      readyRecordArtifactRefId: replacement.ref.artifactRefId,
      readyRecordContentSha256: replacement.ref.contentSha256,
    },
  } as FullFamilyFactBundleV1;
  const result = evaluate(replaceBundle(withReady, bundle), bundle);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some(reason => reason.code === "schema-invalid" && reason.path === "$.runtime.readyRecord"));
});

test("full-family adapter requires exact ref, claim, policy, lease and observation closure", () => {
  const fixture = buildFixture();
  assert.equal(evaluate({ ...fixture.runtime, claims: fixture.runtime.claims.slice(1) }).verdict, "invalid");
  assert.equal(evaluate({ ...fixture.runtime, policies: [] }).verdict, "invalid");
  assert.equal(evaluate({ ...fixture.runtime, leases: fixture.runtime.leases.slice(1) }).verdict, "invalid");
  assert.equal(evaluate({ ...fixture.runtime, observations: [] }).verdict, "invalid");
});

test("full-family adapter requires execution, evidence, and owner-recorded physical artifacts", () => {
  const fixture = buildFixture();
  const binding = fixture.bundle.sourceCoverage.artifact.executions[0]!;
  for (const artifactRefId of [
    binding.executionArtifactRefId,
    binding.evidenceArtifactRefId,
    binding.physicalObservations[0]!.artifactRefId,
  ]) {
    const ref = fixture.runtime.refs.find(value => value.artifactRefId === artifactRefId)!;
    assert.equal(evaluate({
      ...fixture.runtime,
      refs: fixture.runtime.refs.filter(value => value.artifactRefId !== artifactRefId),
      claims: fixture.runtime.claims.filter(value => value.artifactRefId !== artifactRefId),
      leases: fixture.runtime.leases.filter(value => value.receiptId !== ref.retentionLeaseReceiptId),
    }, fixture.bundle).verdict, "invalid");
  }
});

test("full-family adapter rejects generated denominator and re-addressed execution-root splices", () => {
  const fixture = buildFixture();
  const denominatorSplice = {
    ...fixture.bundle,
    runtime: { ...fixture.bundle.runtime, generatedRuntimeDescriptorRoot: h("foreign-generated-descriptor") },
  } as FullFamilyFactBundleV1;
  assert.equal(evaluate(replaceBundle(fixture.runtime, denominatorSplice), fixture.bundle).verdict, "invalid");
  const first = fixture.bundle.sourceCoverage.artifact.executions[0]!;
  const executionSplice = {
    ...fixture.bundle,
    sourceCoverage: {
      ...fixture.bundle.sourceCoverage,
      artifact: {
        ...fixture.bundle.sourceCoverage.artifact,
        executions: [{ ...first, executionRoot: h("readdressed-execution-root") }, ...fixture.bundle.sourceCoverage.artifact.executions.slice(1)],
      },
    },
  } as FullFamilyFactBundleV1;
  const replacementCoverage = storeArtifact(
    encodeFullFamilySourceCoverageArtifact(executionSplice.sourceCoverage.artifact),
    schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.sourceCoverage),
  );
  const readdressedExecutionSplice = {
    ...executionSplice,
    sourceCoverage: {
      artifactRefId: replacementCoverage.ref.artifactRefId,
      contentSha256: replacementCoverage.ref.contentSha256,
      artifact: executionSplice.sourceCoverage.artifact,
    },
  } as FullFamilyFactBundleV1;
  const withCoverage = replaceObservedArtifact(
    fixture.runtime,
    fixture.bundle.sourceCoverage.artifactRefId,
    replacementCoverage,
  );
  assert.equal(evaluate(replaceBundle(withCoverage, readdressedExecutionSplice), fixture.bundle).verdict, "invalid");
});

test("full-family adapter rejects a coherently re-addressed physical observation splice", () => {
  const fixture = buildFixture();
  const execution = fixture.bundle.sourceCoverage.artifact.executions[0]!;
  const physical = execution.physicalObservations[0]!;
  const claim = fixture.runtime.claims.find(value => value.artifactRefId === physical.artifactRefId)!;
  const decoded = decodeCanonicalJson(decodeArtifactBytes(claim.observedMirror!.bytes));
  const replacement = storeArtifact(
    encodeCanonicalBytes({ ...(decoded as object), releaseBindingId: h("spliced-release-binding") }),
    schemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.sourcePhysicalObservation),
  );
  const withPhysical = replaceObservedArtifact(fixture.runtime, physical.artifactRefId, replacement);
  const splicedBundle = {
    ...fixture.bundle,
    sourceCoverage: {
      ...fixture.bundle.sourceCoverage,
      artifact: {
        ...fixture.bundle.sourceCoverage.artifact,
        executions: [{
          ...execution,
          physicalObservations: [{
            rawLocatorHash: replacement.ref.contentSha256,
            artifactRefId: replacement.ref.artifactRefId,
            contentSha256: replacement.ref.contentSha256,
          }],
        }, ...fixture.bundle.sourceCoverage.artifact.executions.slice(1)],
      },
    },
  } as FullFamilyFactBundleV1;
  assert.equal(evaluate(replaceBundle(withPhysical, splicedBundle), fixture.bundle).verdict, "invalid");
});
