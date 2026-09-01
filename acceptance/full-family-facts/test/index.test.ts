import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  buildFullFamilyQualificationCorpus,
  QUALIFICATION_OBSERVED_HEAD,
} from "./qualification-fixture.ts";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  decodeCanonicalJson,
  hashCanonicalPartition,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { assertAssetReferenceMatchesV1 } from "../../../packages/asset-ref/src/index.ts";
import { DURABLE_CONTENT_ENVELOPE_HASH_DOMAIN } from "../../../packages/durable-store/src/index.ts";
import {
  sourcePlanEvidenceRoot,
  sourcePlanExecutionRoot,
  sourcePlanIdentity,
  type SourceCompleteness,
  type SourceCoverageCertificateV1,
  type SourcePlanRefV1,
} from "../../../packages/discovery/src/index.ts";
import {
  decodeFullFamilyFacts,
  decodeFullFamilyActionOwnerArtifact,
  decodeFullFamilyReadyRecord,
  encodeFullFamilyActionOwnerArtifact,
  encodeFullFamilyFacts,
  evaluateFullFamilyPredicate,
  fullFamilyGeneratedDenominatorRoot,
  fullFamilyQualificationLeafDigest,
  sealFamilyEvidencePartition,
  sealFamilyOutcomePartition,
  sealFullFamilyFacts,
  sealFullFamilyMatrixEntry,
  type FamilyEvidenceItemV1,
  type FamilyOutcomeItemV1,
  type FamilyReleaseSetDraftV1,
  type FullFamilyFactBundleV1,
  type FullFamilyMatrixEntryV1,
  type FullFamilySourceCoverageBindingV1,
  type FullFamilyGeneratedRuntimeMetadataV1,
} from "../src/runtime.ts";
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
import { evaluateFullFamilyReferenceModel } from "../src/reference-model.ts";
import {
  runFullFamilyReadyArtifactMutationRegistry,
  runFullFamilySemanticMutationRegistry,
} from "../src/mutations.ts";
import {
  FULL_FAMILY_CRITICAL_MUTATION_IDS,
  FULL_FAMILY_OUTCOME_ARTIFACT_CRITICAL_MUTATION_IDS,
  FULL_FAMILY_READY_ARTIFACT_CRITICAL_MUTATION_IDS,
  FULL_FAMILY_SEMANTIC_MUTATION_IDS,
} from "../src/spec.ts";

const cutoff = Object.freeze({
  chainId: "1",
  number: "100",
  hash: hashDomain("test/full-family/cutoff-hash/v1", "100"),
  stateRoot: hashDomain("test/full-family/state-root/v1", "100"),
});

const proofKeys = generateKeyPairSync("ed25519");
const proofPublicKeyHex = `0x${proofKeys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}` as `0x${string}`;
const proofKeyId = hashDomain("test/full-family/proof-key/v1", proofPublicKeyHex);
const candidateReleaseCommit = "a".repeat(40);
const nominationClosureKind = "aloha/nomination-closure/v1";
const candidatePartitionProofKind = "aloha/candidate-partition-proof/v2";

test("owned-action facts are exact generated owner declarations, not live action execution", () => {
  const owner = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.full-family-action-owner-artifact" as const,
    familyId: "family-alpha",
    familyDefinitionHash: hashDomain("test/full-family/action-owner/definition/v1", "alpha"),
    actionOwnerRef: hashDomain("test/full-family/action-owner/ref/v1", "alpha"),
  });
  assert.deepEqual(decodeFullFamilyActionOwnerArtifact(decodeCanonicalJson(encodeFullFamilyActionOwnerArtifact(owner))), owner);
  assert.throws(
    () => decodeFullFamilyActionOwnerArtifact({ ...owner, actionHash: hashDomain("test/full-family/action/v1", "forged") }),
    /unknown field/,
  );
});

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

function h(label: string): Hash {
  return hashDomain("test/full-family/fact/v1", label);
}

function nominationCandidateKey(familyId: string): Hash {
  return hashDomain("aloha/family-candidate/v2", {
    familyDefinitionHash: h(`${familyId}:definition`),
    instanceNominationKey: `${familyId}:nomination`,
  });
}

function evidence(familyId: string, label: string, subjectKey: Hash): FamilyEvidenceItemV1 {
  return Object.freeze({
    familyId,
    itemId: h(`${familyId}:${label}:item`),
    subjectKey,
    evidenceArtifactRefId: h(`${familyId}:${label}:artifact-ref`),
    evidenceContentSha256: h(`${familyId}:${label}:content`),
  });
}

function outcome(
  familyId: string,
  label: string,
  candidateKey: Hash,
  instanceKey: Hash | null,
  value: FamilyOutcomeItemV1["outcome"],
): FamilyOutcomeItemV1 {
  return Object.freeze({
    familyId,
    itemId: h(`${familyId}:${label}:item`),
    candidateKey,
    instanceKey,
    outcome: value,
    evidenceArtifactRefId: h(`${familyId}:${label}:artifact-ref`),
    evidenceContentSha256: h(`${familyId}:${label}:content`),
  });
}

type PassingFamilyStatus = "strict-attested-published" | "exact-zero-candidate" | "chain-proven-rejected";

interface FamilyRuntimeBindingFixtureV1 {
  readonly candidatePartition: FullFamilyMatrixEntryV1["candidatePartition"];
}

function family(
  familyId: string,
  status: PassingFamilyStatus,
  binding: FamilyRuntimeBindingFixtureV1,
  declaredPlans: readonly SourcePlanRefV1[],
): FullFamilyMatrixEntryV1 {
  const definitionHash = h(`${familyId}:definition`);
  const candidateKey = nominationCandidateKey(familyId);
  const instanceKey = h(`${familyId}:instance`);
  const edgeId = h(`${familyId}:edge`);
  const sourcePlans = sealFamilyEvidencePartition(declaredPlans.map((declaredPlan, index) => (
    evidence(familyId, `source-plan:${index}`, sourcePlanIdentity(declaredPlan))
  )));
  const universeCandidates = sealFamilyEvidencePartition(
    status === "exact-zero-candidate" ? [] : [evidence(familyId, "candidate", candidateKey)],
  );
  const outcomes = sealFamilyOutcomePartition(status === "exact-zero-candidate"
    ? []
    : [outcome(
      familyId,
      "outcome",
      candidateKey,
      status === "strict-attested-published" ? instanceKey : null,
      status === "strict-attested-published" ? "verified" : "chain-proven-rejected",
    )]);
  const published = status === "strict-attested-published";
  const instancePublications = sealFamilyEvidencePartition(
    published ? [evidence(familyId, "instance-publication", instanceKey)] : [],
  );
  const projectedEdges = sealFamilyEvidencePartition(
    published ? [evidence(familyId, "projected-edge", instanceKey)] : [],
  );
  const edgeKey = projectedEdges.items[0]?.itemId ?? edgeId;
  const declaredCoarseCapabilities = sealFamilyEvidencePartition([
    evidence(familyId, "declared-coarse-capability", h(`${familyId}:coarse-owner`)),
  ]);
  const coarseRankable = sealFamilyEvidencePartition(
    published ? [evidence(familyId, "coarse-rankable", edgeKey)] : [],
  );
  const declaredExactCapabilities = sealFamilyEvidencePartition([
    evidence(familyId, "declared-exact-capability", h(`${familyId}:exact-owner`)),
  ]);
  const ownedActions = sealFamilyEvidencePartition([
    evidence(familyId, "owned-action", h(`${familyId}:action-owner`)),
  ]);
  return sealFullFamilyMatrixEntry({
    familyId,
    familyDefinitionHash: definitionHash,
    sourcePlanRoot: h(`${familyId}:source-plan-root`),
    sourcePlans,
    candidatePartition: binding.candidatePartition,
    universeCandidates,
    outcomes,
    instancePublications,
    projectedEdges,
    declaredCoarseCapabilities,
    coarseRankable,
    coarseUnavailable: sealFamilyEvidencePartition([]),
    unrankedAdmissions: sealFamilyEvidencePartition([]),
    declaredExactCapabilities,
    ownedActions,
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

function sourceCoverageBinding(readyRecordHash: Hash, plans: readonly SourcePlanRefV1[]): FullFamilySourceCoverageBindingV1 {
  const declaredSourcePlans = [...plans].sort((left, right) => sourcePlanIdentity(left).localeCompare(sourcePlanIdentity(right)));
  const executionResults = declaredSourcePlans.map(plan => {
    const evidenceWithoutRoot = {
      kind: "source-plan-evidence" as const,
      version: 1 as const,
      plan,
      cutoff,
      refs: [],
      rawLocatorHashes: [],
    };
    const evidenceRoot = sourcePlanEvidenceRoot(evidenceWithoutRoot);
    const resultPartitionRoot = h(`${plan.sourcePlanRef}:result`);
    const executionWithoutRoot = {
      kind: "source-plan-execution" as const,
      version: 1 as const,
      plan,
      cutoff,
      outcome: "complete" as const,
      from: plan.completeness === "contiguous-history" ? plan.historyStartBlock! : cutoff.number,
      through: cutoff.number,
      previousAppliedThrough: null,
      resultPartitionRoot,
      opaqueResult: { kind: "test-source-result", sourcePlanRef: plan.sourcePlanRef },
      sourceEvidenceRefs: [],
      rawLocatorHashes: [],
      sourceEvidenceRoot: evidenceRoot,
    };
    return {
      plan,
      resultPartitionRoot,
      evidenceRoot,
      executionRoot: sourcePlanExecutionRoot(executionWithoutRoot),
    };
  });
  const entries = executionResults.map(({ plan, resultPartitionRoot, executionRoot }) => ({
    ownerRef: plan.ownerRef,
    sourcePlanRef: plan.sourcePlanRef,
    familyDefinitionHash: plan.familyDefinitionHash,
    completeness: plan.completeness,
    historyStartBlock: plan.historyStartBlock,
    previousAppliedThrough: null,
    cutoffHash: cutoff.hash,
    from: plan.completeness === "contiguous-history" ? plan.historyStartBlock! : cutoff.number,
    appliedThrough: cutoff.number,
    resultPartitionRoot,
    executionRoot,
    contributesOmissionAuthority: plan.completeness === "complete-snapshot" || plan.completeness === "contiguous-history",
  }));
  const sourceCoverage: SourceCoverageCertificateV1 = Object.freeze({
    cutoff,
    entries,
    sourceCoverageRoot: hashDomain("aloha/source-coverage/v1", { cutoff, entries }),
  });
  return Object.freeze({
    artifactRefId: h("source-coverage:artifact-ref"),
    contentSha256: h("source-coverage:content"),
    artifact: Object.freeze({
      schemaVersion: 1,
      kind: "aloha.full-family-source-coverage-artifact",
      readyRecordHash,
      cutoff,
      executions: executionResults.map(({ plan, executionRoot, evidenceRoot, resultPartitionRoot }) => ({
        ownerRef: plan.ownerRef,
        sourcePlanRef: plan.sourcePlanRef,
        familyDefinitionHash: plan.familyDefinitionHash,
        executionRoot,
        evidenceRoot,
        resultPartitionRoot,
        executionArtifactRefId: h(`${plan.sourcePlanRef}:execution-ref`),
        executionContentSha256: h(`${plan.sourcePlanRef}:execution-content`),
        evidenceArtifactRefId: h(`${plan.sourcePlanRef}:evidence-ref`),
        evidenceContentSha256: h(`${plan.sourcePlanRef}:evidence-content`),
        physicalObservations: [],
      })),
      sourceCoverage,
    }),
  });
}

function releaseSet(label: string, families: readonly FullFamilyMatrixEntryV1[]): FamilyReleaseSetDraftV1 {
  return {
    sourceArtifactRefId: h(`${label}:artifact-ref`),
    sourceArtifactContentSha256: h(`${label}:content`),
    contractRoot: h(`${label}:contract-root`),
    entries: families.map(value => ({
      familyId: value.familyId,
      familyDefinitionHash: value.familyDefinitionHash,
    })),
  };
}

function buildBundle(
  zeroFamilyAdditionalPlans: readonly ("nomination-only" | "point-lookup")[] = [],
): { readonly bundle: FullFamilyFactBundleV1; readonly generatedRuntime: FullFamilyGeneratedRuntimeMetadataV1 } {
  const readyRecordHash = h("runtime:ready-record-hash");
  const alphaPlan = sourcePlan("family.alpha", "complete-snapshot");
  const betaPlan = sourcePlan("family.beta", "contiguous-history");
  const betaAdditionalPlans = zeroFamilyAdditionalPlans.map((completeness, index) => Object.freeze({
    ...sourcePlan("family.beta", completeness),
    ownerRef: h(`family.beta:${completeness}:${index}:source-owner`),
    sourcePlanRef: h(`family.beta:${completeness}:${index}:source-plan`),
  }));
  const gammaPlan = sourcePlan("family.gamma", "complete-snapshot");
  const plans = [alphaPlan, betaPlan, ...betaAdditionalPlans, gammaPlan];
  const sourceCoverage = sourceCoverageBinding(readyRecordHash, plans);
  const candidatePlans = new Map([["family.alpha", alphaPlan], ["family.gamma", gammaPlan]]);
  const candidates: CandidateRecordV1[] = [...candidatePlans].map(([familyId, plan]) => {
    const evidence = [{
      kind: "source-plan" as const,
      version: 1 as const,
      ownerRef: plan.ownerRef,
      sourcePlanRef: plan.sourcePlanRef,
      evidenceRef: h(`${familyId}:nomination-evidence`),
      rawLocatorHash: h(`${familyId}:nomination-raw`),
    }];
    return Object.freeze({
      kind: "aloha.candidate-record" as const,
      version: "2" as const,
      familyId,
      familyDefinitionHash: plan.familyDefinitionHash,
      instanceNominationKey: `${familyId}:nomination`,
      familyCandidateKey: nominationCandidateKey(familyId),
      candidateSubjectHash: h(`${familyId}:candidate-subject`),
      candidateEvidenceRoot: hashCanonicalPartition("aloha/candidate-evidence/v2", evidence),
      evidence,
    });
  });
  const receipts = plans.map(plan => {
    const familyId = plan.familyDefinitionHash === alphaPlan.familyDefinitionHash
      ? "family.alpha"
      : plan.familyDefinitionHash === betaPlan.familyDefinitionHash ? "family.beta" : "family.gamma";
    const candidate = candidates.find(value => value.familyId === familyId);
    const claims = candidate === undefined ? [] : candidate.evidence.map(evidenceRef => ({
      sourcePlanIdentity: sourcePlanIdentity(plan),
      familyCandidateKey: candidate.familyCandidateKey,
      instanceNominationKey: candidate.instanceNominationKey,
      evidenceRefHash: nominationEvidenceRefHash(evidenceRef),
    }));
    const execution = sourceCoverage.artifact.executions.find(value => value.sourcePlanRef === plan.sourcePlanRef)!;
    return sealQualifiedSourcePlanNominationReceiptV1({
      cutoff,
      familyId,
      familyDefinitionHash: plan.familyDefinitionHash,
      sourcePlanIdentity: sourcePlanIdentity(plan),
      sourcePlanLeafDigest: h(`${plan.sourcePlanRef}:leaf`),
      nominationProgramRoot: h(`${plan.sourcePlanRef}:nomination-program`),
      nominationProgramProposalLeafDigest: h(`${plan.sourcePlanRef}:nomination-proposal`),
      qualificationRoot: h(`${plan.sourcePlanRef}:qualification`),
      denominator: { kind: "complete-source-result", persistedExecutionRoot: execution.executionRoot, resultPartitionRoot: execution.resultPartitionRoot },
      claims,
    });
  });
  candidates.sort((left, right) => left.familyCandidateKey.localeCompare(right.familyCandidateKey));
  const candidatePartitionRoot = hashCanonicalPartition("aloha/candidate-partition/v2", candidates);
  const recentObservationRoot = h("runtime:recent-observation-root");
  const nominationClosure = sealNominationClosureV1({
    cutoff,
    recentObservationRoot,
    sourceExecutionSetRoot: h("runtime:source-execution-set-root"),
    sourceCoverageRoot: sourceCoverage.artifact.sourceCoverage.sourceCoverageRoot,
    sourcePlanIdentities: plans.map(sourcePlanIdentity),
    receipts,
    candidates,
    candidatePartitionRoot,
  });
  const candidatePartitionStorageHash = h("runtime:candidate-partition-storage");
  const nominationClosureStorageHash = durableContentHash(
    nominationClosureKind,
    encodeNominationClosureV1(nominationClosure),
    [
      h("runtime:recent-observation-storage"),
      h("runtime:source-coverage-storage"),
      h("runtime:source-execution-set-storage"),
      h("runtime:source-plan-evidence-storage"),
      candidatePartitionStorageHash,
    ],
  );
  const releaseBindingId = h("runtime:release-binding");
  const releaseProvenanceHash = h("runtime:release-provenance");
  const proofPayload = makeCandidatePartitionProofPayload({
    runId: "qualification-run",
    cutoff,
    candidatePartitionRoot,
    candidatePartitionStorageHash,
    nominationClosureRoot: nominationClosure.root,
    nominationClosureStorageHash,
    candidates,
    recentObservationRoot,
    sourceCoverageRoot: sourceCoverage.artifact.sourceCoverage.sourceCoverageRoot,
    checkpointRevision: "1",
    releaseProvenanceHash,
    issuerKeyId: proofKeyId,
  });
  const proof = issueCandidatePartitionProof(proofPayload);
  const candidatePartitionProofStorageHash = durableContentHash(
    candidatePartitionProofKind,
    encodeCandidatePartitionProofV1(proof),
  );
  const verifierBinding = {
    schemaVersion: 1 as const,
    kind: "aloha.full-family-candidate-proof-verifier-binding" as const,
    runtimeBindingId: releaseBindingId,
    releaseProvenanceHash,
    releaseAuthorityRoot: h("runtime:release-authority"),
    candidateReleaseCommit,
    proofKeyId,
    proofPublicKeyHex,
  };
  const partitionByFamily = new Map(nominationClosure.families.map(value => [value.familyId, value]));
  const bindingFor = (familyId: string) => Object.freeze({ candidatePartition: partitionByFamily.get(familyId)! });
  const families = [
    family("family.alpha", "strict-attested-published", bindingFor("family.alpha"), [alphaPlan]),
    family("family.beta", "exact-zero-candidate", bindingFor("family.beta"), [betaPlan, ...betaAdditionalPlans]),
    family("family.gamma", "chain-proven-rejected", bindingFor("family.gamma"), [gammaPlan]),
  ];
  const releaseIntent = releaseSet("release-intent", families);
  const definitionCatalog = releaseSet("definition-catalog", families);
  const runtimeComposition = releaseSet("runtime-composition", families);
  const generatedRuntime: FullFamilyGeneratedRuntimeMetadataV1 = Object.freeze({
    releaseIntentRoot: releaseIntent.contractRoot,
    definitionCatalogRoot: definitionCatalog.contractRoot,
    descriptorRoot: h("runtime:generated-descriptor-root"),
    families: families.map(value => Object.freeze({
      familyId: value.familyId,
      familyDefinitionHash: value.familyDefinitionHash,
      sourcePlanRoot: value.sourcePlanRoot,
      sourcePlanRefs: Object.freeze(value.familyId === "family.alpha"
        ? [alphaPlan]
        : value.familyId === "family.beta"
          ? [betaPlan, ...betaAdditionalPlans]
          : [gammaPlan]),
    })),
  });
  const bundle = sealFullFamilyFacts({
    runtime: {
      generationId: h("runtime:generation-100"),
      releaseBindingId,
      readyCutoff: cutoff,
      readyCutoffRoot: hashDomain("aloha/full-family/ready-cutoff/v1", cutoff),
      actualCurrentSource: cutoff,
      actualCurrentSourceRoot: hashDomain("aloha/full-family/actual-current-source/v1", cutoff),
      recentObservationStartBlock: "51",
      recentObservationEndBlock: "100",
      recentObservationBlockCount: "50",
      releaseIntentRoot: releaseIntent.contractRoot,
      definitionCatalogRoot: definitionCatalog.contractRoot,
      generatedRuntimeDescriptorRoot: generatedRuntime.descriptorRoot,
      runtimeCompositionRoot: runtimeComposition.contractRoot,
      sourceCoverageRoot: sourceCoverage.artifact.sourceCoverage.sourceCoverageRoot,
      candidatePartitionRoot,
      nominationClosureRoot: nominationClosure.root,
      nominationClosureStorageHash,
      candidatePartitionStorageHash,
      candidatePartitionProofStorageHash,
      releaseProvenanceHash,
      instanceCatalogRoot: h("runtime:instance-catalog-root"),
      graphRoot: h("runtime:graph-root"),
      readyRecordHash,
      instanceCount: "1",
      edgeCount: "1",
      readyRecordArtifactRefId: h("runtime:ready-record-ref"),
      readyRecordContentSha256: h("runtime:ready-record-content"),
    },
    releaseIntent,
    definitionCatalog,
    runtimeComposition,
    sourceCoverage,
    lineage: {
      nominationClosure: { artifactRefId: h("nomination-closure:ref"), contentSha256: h("nomination-closure:content"), storageHash: nominationClosureStorageHash, artifact: nominationClosure },
      candidatePartitionProof: { artifactRefId: h("candidate-proof:ref"), contentSha256: h("candidate-proof:content"), storageHash: candidatePartitionProofStorageHash, artifact: proof },
      candidateProofVerifierBinding: { artifactRefId: h("candidate-proof-verifier:ref"), contentSha256: h("candidate-proof-verifier:content"), artifact: verifierBinding },
    },
    families,
  });
  return { bundle, generatedRuntime };
}

test("complete family denominator derives strict, zero-candidate and chain-rejected statuses", () => {
  const { bundle, generatedRuntime } = buildBundle();
  const live = evaluateFullFamilyPredicate([bundle], generatedRuntime);
  const oracle = evaluateFullFamilyReferenceModel([bundle], generatedRuntime);
  assert.equal(live.verdict, "pass");
  assert.equal(oracle.verdict, "pass");
  assert.equal(live.familyCount, "3");
  assert.deepEqual(live.statuses, [
    { familyId: "family.alpha", status: "strict-attested-published" },
    { familyId: "family.beta", status: "exact-zero-candidate" },
    { familyId: "family.gamma", status: "chain-proven-rejected" },
  ]);
  assert.equal(bundle.families[1]!.universeCandidates.count, "0");
  assert.equal(bundle.families[1]!.outcomes.count, "0");
  assert.deepEqual(
    generatedRuntime.families.flatMap(family => family.sourcePlanRefs).map(plan => plan.completeness).sort(),
    ["complete-snapshot", "complete-snapshot", "contiguous-history"],
  );
  assert.ok(bundle.sourceCoverage.artifact.sourceCoverage.entries.every(entry => entry.contributesOmissionAuthority));
  assert.deepEqual(encodeFullFamilyFacts(decodeFullFamilyFacts(encodeFullFamilyFacts(bundle))), encodeFullFamilyFacts(bundle));
});

test("qualification corpus builds the exact catalog, Graph, coarse and action fact denominator", async () => {
  const fixture = await buildFullFamilyQualificationCorpus();
  const live = evaluateFullFamilyPredicate(fixture.bundle, fixture.generatedRuntime);
  const oracle = evaluateFullFamilyReferenceModel(fixture.bundle, fixture.generatedRuntime);
  assert.equal(live.verdict, "pass", JSON.stringify(live.reasons));
  assert.equal(oracle.verdict, "pass", JSON.stringify(oracle.reasons));
  assert.equal(fixture.bundle.runtime.instanceCatalogRoot, fixture.instanceCatalogRoot);
  assert.equal(fixture.bundle.runtime.graphRoot, fixture.graphRoot);
  assert.ok(fixture.assetPorts.length > 0);
  for (const [index, port] of fixture.assetPorts.entries()) {
    assert.deepEqual(
      assertAssetReferenceMatchesV1(port.assetIdentity, port.assetRef, `qualification.assetPorts[${index}]`),
      { identity: port.assetIdentity, assetRef: port.assetRef },
    );
    assert.equal(port.assetIdentity.chainId, QUALIFICATION_OBSERVED_HEAD.chainId);
  }
  assert.equal(fixture.coarseArtifactHashes.length, 2);
  assert.ok(fixture.actionOwnerRef.startsWith("0x"));
  assert.ok(fixture.artifacts.every(artifact => artifact.contentSha256 === sha256Hex(artifact.bytes)));
});

test("promotion freshness preserves an exact five-field canonical observed head", async () => {
  const fixture = await buildFullFamilyQualificationCorpus();
  const readyArtifact = fixture.artifacts.find(artifact => artifact.schemaKey === "readyRecord");
  assert.ok(readyArtifact !== undefined);
  const ready = decodeFullFamilyReadyRecord(readyArtifact.bytes);
  assert.deepEqual(ready.promotionFreshness.observedHead, QUALIFICATION_OBSERVED_HEAD);
  const mutations = runFullFamilyReadyArtifactMutationRegistry(ready);
  assert.deepEqual(mutations.map(mutation => mutation.id), FULL_FAMILY_READY_ARTIFACT_CRITICAL_MUTATION_IDS);
  for (const mutation of mutations) {
    assert.throws(() => decodeFullFamilyReadyRecord(mutation.mutated as object), mutation.id);
  }
  const { runtimeAuthority: _runtimeAuthority, ...withoutRuntimeAuthority } = ready;
  assert.throws(
    () => decodeFullFamilyReadyRecord(withoutRuntimeAuthority),
    /runtimeAuthority|missing field/,
  );
  assert.throws(
    () => decodeFullFamilyReadyRecord({
      ...ready,
      runtimeAuthority: {
        ...ready.runtimeAuthority,
        authorityBindingHash: hashDomain("test/full-family/wrong-ready-runtime-authority/v1", 1),
      },
    }),
    /ready record hash mismatch/,
  );
});

test("nomination-only and point-lookup plans neither authorize nor veto exact zero", () => {
  const { bundle, generatedRuntime } = buildBundle(["nomination-only", "point-lookup"]);
  const live = evaluateFullFamilyPredicate([bundle], generatedRuntime);
  const oracle = evaluateFullFamilyReferenceModel([bundle], generatedRuntime);
  assert.equal(live.verdict, "pass");
  assert.equal(oracle.verdict, "pass");
  assert.deepEqual(live.statuses.find(value => value.familyId === "family.beta"), {
    familyId: "family.beta",
    status: "exact-zero-candidate",
  });
  const betaPlans = generatedRuntime.families.find(value => value.familyId === "family.beta")!.sourcePlanRefs;
  assert.deepEqual(betaPlans.map(value => value.completeness).sort(), [
    "contiguous-history",
    "nomination-only",
    "point-lookup",
  ]);
});

test("pure predicate and independent model agree on every semantic mutation", () => {
  const { bundle, generatedRuntime } = buildBundle();
  const runs = runFullFamilySemanticMutationRegistry(bundle);
  assert.deepEqual(runs.map(run => run.id), FULL_FAMILY_SEMANTIC_MUTATION_IDS);
  assert.deepEqual(
    [
      ...FULL_FAMILY_SEMANTIC_MUTATION_IDS,
      ...FULL_FAMILY_READY_ARTIFACT_CRITICAL_MUTATION_IDS,
      ...FULL_FAMILY_OUTCOME_ARTIFACT_CRITICAL_MUTATION_IDS,
    ].sort(),
    FULL_FAMILY_CRITICAL_MUTATION_IDS,
  );
  const artifactBoundOnly = new Set([
    "candidate-proof-verifier-authority-splice",
    "actual-current-source-cross-run",
    "runtime-graph-root-splice",
    "source-evidence-omission",
    "source-physical-ref-splice",
  ]);
  const omissionAuthorityMutations = new Set([
    "source-coverage-nomination-only-downgrade",
    "source-coverage-point-lookup-downgrade",
    "source-coverage-omission-bit-forgery",
    "source-coverage-declared-entry-splice",
    "source-coverage-entry-omission",
    "source-coverage-mixed-authority",
  ]);
  for (const run of runs) {
    const live = evaluateFullFamilyPredicate(run.mutated, generatedRuntime);
    const oracle = evaluateFullFamilyReferenceModel(run.mutated, generatedRuntime);
    assert.equal(live.verdict, oracle.verdict, run.id);
    if (artifactBoundOnly.has(run.id)) {
      assert.equal(live.verdict, "pass", `${run.id} must reach GateCore artifact binding`);
    } else {
      assert.notEqual(live.verdict, "pass", run.id);
    }
    if (omissionAuthorityMutations.has(run.id)) assert.equal(live.verdict, "invalid", run.id);
  }
  const omission = runs.find(run => run.id === "candidate-omission")!;
  const omissionBundle = decodeFullFamilyFacts(omission.mutated as object);
  const omittedFamily = omissionBundle.families.find(family => family.familyId === "family.alpha")!;
  assert.equal(omittedFamily.universeCandidates.count, "0");
  assert.equal(omittedFamily.outcomes.count, "0");
  assert.equal(omittedFamily.instancePublications.count, "0");
  assert.equal(omittedFamily.projectedEdges.count, "0");
  assert.equal(omittedFamily.candidatePartition.candidateCount, "1", "immutable nomination closure keeps the unforgeable denominator");
  assert.equal(evaluateFullFamilyPredicate(omissionBundle, generatedRuntime).verdict, "invalid");
});

test("caller verdict is data, not authority", () => {
  const { bundle, generatedRuntime } = buildBundle();
  assert.equal(evaluateFullFamilyPredicate({ ...bundle, producerVerdict: "pass" }, generatedRuntime).verdict, "invalid");
});

test("independent full-family model uses the frozen source-plan wire contract", () => {
  const source = readFileSync(new URL("../src/reference-model.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /packages\/discovery/);
  assert.match(source, /specs\/full-family-facts\/src\/source-wire/);
});

test("an unrelated generated Family changes only the aggregate denominator root", () => {
  const { generatedRuntime } = buildBundle();
  const existingLeaves = new Map(generatedRuntime.families.map(family => [family.familyId, fullFamilyQualificationLeafDigest(family)]));
  const unrelatedPlan = sourcePlan("family.unrelated", "point-lookup");
  const unrelated = Object.freeze({
    familyId: "family.unrelated",
    familyDefinitionHash: unrelatedPlan.familyDefinitionHash,
    sourcePlanRoot: h("family.unrelated:source-plan-root"),
    sourcePlanRefs: Object.freeze([unrelatedPlan]),
  });
  const after = Object.freeze({
    ...generatedRuntime,
    descriptorRoot: h("runtime:generated-descriptor-root:with-unrelated"),
    families: Object.freeze([...generatedRuntime.families, unrelated].sort((left, right) => left.familyId.localeCompare(right.familyId))),
  });
  assert.notEqual(fullFamilyGeneratedDenominatorRoot(after), fullFamilyGeneratedDenominatorRoot(generatedRuntime));
  for (const family of generatedRuntime.families) {
    assert.equal(fullFamilyQualificationLeafDigest(family), existingLeaves.get(family.familyId));
  }
});
