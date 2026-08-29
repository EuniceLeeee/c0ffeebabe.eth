import {
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  fullFamilySourcePlanIdentity,
  type SourceCoverageCertificateV1,
  type SourceCoverageEntryV1,
  type SourcePlanRefV1,
} from "../../../specs/full-family-facts/src/source-wire.ts";
import {
  sealFamilyEvidencePartition,
  sealFamilyOutcomePartition,
  sealFullFamilyFacts,
  sealFullFamilyMatrixEntry,
  type FamilyEvidenceItemV1,
  type FamilyEvidencePartitionV1,
  type FamilyOutcomePartitionV1,
  type FamilyReleaseSetDraftV1,
  type FullFamilyFactBundleV1,
  type FullFamilyMatrixEntryV1,
  type FullFamilyReadyRecordV1,
  type FullFamilySourceCoverageBindingV1,
} from "./schema.ts";
import {
  FULL_FAMILY_READY_ARTIFACT_CRITICAL_MUTATION_IDS,
  FULL_FAMILY_SEMANTIC_MUTATION_IDS,
  type FullFamilyReadyArtifactCriticalMutationId,
  type FullFamilySemanticMutationId,
} from "./spec.ts";

const MUTATION_HASH = hashDomain("aloha/full-family/critical-mutation/v1", "mutated");

function releaseDraft(input: FullFamilyFactBundleV1["releaseIntent"]): FamilyReleaseSetDraftV1 {
  return {
    sourceArtifactRefId: input.sourceArtifactRefId,
    sourceArtifactContentSha256: input.sourceArtifactContentSha256,
    contractRoot: input.contractRoot,
    entries: input.entries.map(({ familyId, familyDefinitionHash }) => ({ familyId, familyDefinitionHash })),
  };
}

function rebuild(
  input: FullFamilyFactBundleV1,
  families: readonly FullFamilyMatrixEntryV1[] = input.families,
  sets: Partial<Readonly<{
    runtime: FullFamilyFactBundleV1["runtime"];
    releaseIntent: FamilyReleaseSetDraftV1;
    definitionCatalog: FamilyReleaseSetDraftV1;
    runtimeComposition: FamilyReleaseSetDraftV1;
    sourceCoverage: FullFamilySourceCoverageBindingV1;
  }>> = {},
): FullFamilyFactBundleV1 {
  return sealFullFamilyFacts({
    runtime: sets.runtime ?? input.runtime,
    releaseIntent: sets.releaseIntent ?? releaseDraft(input.releaseIntent),
    definitionCatalog: sets.definitionCatalog ?? releaseDraft(input.definitionCatalog),
    runtimeComposition: sets.runtimeComposition ?? releaseDraft(input.runtimeComposition),
    sourceCoverage: sets.sourceCoverage ?? input.sourceCoverage,
    lineage: input.lineage,
    families,
  });
}

function zeroFamily(input: FullFamilyFactBundleV1): FullFamilyMatrixEntryV1 {
  const family = input.families.find(value => value.universeCandidates.items.length === 0);
  if (family === undefined) throw new Error("full-family mutation fixture requires one zero-candidate family");
  return family;
}

function coverageBinding(
  input: FullFamilyFactBundleV1,
  entries: readonly SourceCoverageEntryV1[],
): FullFamilySourceCoverageBindingV1 {
  const sortedEntries = [...entries].sort((left, right) => fullFamilySourcePlanIdentity(left).localeCompare(fullFamilySourcePlanIdentity(right)));
  const certificate: SourceCoverageCertificateV1 = {
    cutoff: input.sourceCoverage.artifact.cutoff,
    entries: sortedEntries,
    sourceCoverageRoot: hashDomain("aloha/source-coverage/v1", {
      cutoff: input.sourceCoverage.artifact.cutoff,
      entries: sortedEntries,
    }),
  };
  return {
    ...input.sourceCoverage,
    artifact: {
      ...input.sourceCoverage.artifact,
      sourceCoverage: certificate,
    },
  };
}

function planForFamily(input: FullFamilyFactBundleV1, family: FullFamilyMatrixEntryV1): SourcePlanRefV1 {
  const entry = input.sourceCoverage.artifact.sourceCoverage.entries.find(value => value.familyDefinitionHash === family.familyDefinitionHash);
  if (entry === undefined) throw new Error("mutation fixture family has no source plan");
  return {
    ownerRef: entry.ownerRef,
    sourcePlanRef: entry.sourcePlanRef,
    familyDefinitionHash: entry.familyDefinitionHash,
    completeness: entry.completeness,
    historyStartBlock: entry.historyStartBlock,
  };
}

function coherentCompletenessDowngrade(
  input: FullFamilyFactBundleV1,
  completeness: "nomination-only" | "point-lookup",
): FullFamilyFactBundleV1 {
  const family = zeroFamily(input);
  const originalPlan = planForFamily(input, family);
  const nextPlan: SourcePlanRefV1 = { ...originalPlan, completeness, historyStartBlock: null };
  const entries = input.sourceCoverage.artifact.sourceCoverage.entries.map(entry => fullFamilySourcePlanIdentity(entry) === fullFamilySourcePlanIdentity(originalPlan)
    ? {
        ...entry,
        completeness,
        historyStartBlock: null,
        previousAppliedThrough: null,
        from: completeness === "point-lookup" ? input.runtime.readyCutoff.number : input.runtime.recentObservationStartBlock,
        contributesOmissionAuthority: false,
      }
    : entry);
  const sourceCoverage = coverageBinding(input, entries);
  const sourceCoverageRoot = sourceCoverage.artifact.sourceCoverage.sourceCoverageRoot;
  const families = input.families;
  return rebuild(input, families, {
    runtime: { ...input.runtime, sourceCoverageRoot },
    sourceCoverage,
  });
}

function firstFamily(input: FullFamilyFactBundleV1): FullFamilyMatrixEntryV1 {
  const family = input.families[0];
  if (family === undefined) throw new Error("full-family mutation fixture requires one family");
  return family;
}

function strictFamily(input: FullFamilyFactBundleV1): FullFamilyMatrixEntryV1 {
  const family = input.families.find(value => value.outcomes.items.some(outcome => outcome.outcome === "verified"));
  if (family === undefined) throw new Error("full-family mutation fixture requires one verified family");
  return family;
}

function rejectedFamily(input: FullFamilyFactBundleV1): FullFamilyMatrixEntryV1 {
  const family = input.families.find(value => value.outcomes.items.some(outcome => outcome.outcome === "chain-proven-rejected"));
  if (family === undefined) throw new Error("full-family mutation fixture requires one rejected family");
  return family;
}

function replaceFamily(
  input: FullFamilyFactBundleV1,
  current: FullFamilyMatrixEntryV1,
  next: FullFamilyMatrixEntryV1,
): FullFamilyFactBundleV1 {
  return rebuild(input, input.families.map(value => value.familyId === current.familyId ? next : value));
}

function matrixInput(
  family: FullFamilyMatrixEntryV1,
  patch: Partial<Omit<FullFamilyMatrixEntryV1, "entryHash">>,
): FullFamilyMatrixEntryV1 {
  return sealFullFamilyMatrixEntry({ ...family, ...patch });
}

type RootPartitionName =
  | "universeCandidates"
  | "outcomes"
  | "instancePublications"
  | "projectedEdges"
  | "declaredCoarseCapabilities"
  | "declaredExactCapabilities"
  | "ownedActions";

function rawPartitionRootMutation(input: FullFamilyFactBundleV1, name: RootPartitionName): unknown {
  const family = firstFamily(input);
  const partition = family[name] as FamilyEvidencePartitionV1 | FamilyOutcomePartitionV1;
  const nextFamily = { ...family, [name]: { ...partition, root: MUTATION_HASH } };
  return {
    ...input,
    families: input.families.map(value => value.familyId === family.familyId ? nextFamily : value),
  };
}

function releaseWithChangedDefinition(input: FullFamilyFactBundleV1["definitionCatalog"]): FamilyReleaseSetDraftV1 {
  const draft = releaseDraft(input);
  return {
    ...draft,
    entries: draft.entries.map((entry, index) => index === 0
      ? { ...entry, familyDefinitionHash: MUTATION_HASH }
      : entry),
  };
}

const definitions: Record<FullFamilySemanticMutationId, (input: FullFamilyFactBundleV1) => unknown> = {
  "missing-family": input => rebuild(input, input.families.slice(1)),
  "duplicate-family": input => ({ ...input, families: [...input.families, firstFamily(input)] }),
  "unknown-family": input => {
    const family = firstFamily(input);
    return replaceFamily(input, family, matrixInput(family, { familyId: "family.unknown" }));
  },
  "source-plan-partition-omission": input => {
    const family = firstFamily(input);
    const sourcePlans = sealFamilyEvidencePartition([]);
    return replaceFamily(input, family, matrixInput(family, { sourcePlans }));
  },
  "source-coverage-nomination-only-downgrade": input => coherentCompletenessDowngrade(input, "nomination-only"),
  "source-coverage-point-lookup-downgrade": input => coherentCompletenessDowngrade(input, "point-lookup"),
  "source-coverage-omission-bit-forgery": input => {
    const family = zeroFamily(input);
    const plan = planForFamily(input, family);
    const entries = input.sourceCoverage.artifact.sourceCoverage.entries.map(entry => fullFamilySourcePlanIdentity(entry) === fullFamilySourcePlanIdentity(plan)
      ? { ...entry, contributesOmissionAuthority: false }
      : entry);
    return { ...input, sourceCoverage: coverageBinding(input, entries) };
  },
  "source-coverage-declared-entry-splice": input => {
    const family = zeroFamily(input);
    const originalPlan = planForFamily(input, family);
    const executions = input.sourceCoverage.artifact.executions.map(execution => fullFamilySourcePlanIdentity(originalPlan) === hashDomain("aloha/source-plan-identity/v1", { ownerRef: execution.ownerRef, sourcePlanRef: execution.sourcePlanRef })
      ? { ...execution, sourcePlanRef: MUTATION_HASH }
      : execution);
    return { ...input, sourceCoverage: { ...input.sourceCoverage, artifact: { ...input.sourceCoverage.artifact, executions } } };
  },
  "source-coverage-entry-omission": input => {
    const family = zeroFamily(input);
    const plan = planForFamily(input, family);
    const entries = input.sourceCoverage.artifact.sourceCoverage.entries.filter(entry => fullFamilySourcePlanIdentity(entry) !== fullFamilySourcePlanIdentity(plan));
    return { ...input, sourceCoverage: coverageBinding(input, entries) };
  },
  "source-coverage-mixed-authority": input => {
    const family = zeroFamily(input);
    const nominationPlan: SourcePlanRefV1 = {
      ownerRef: hashDomain("aloha/full-family/mixed-source-owner/v1", family.familyId),
      sourcePlanRef: hashDomain("aloha/full-family/mixed-source-plan/v1", family.familyId),
      familyDefinitionHash: family.familyDefinitionHash,
      completeness: "nomination-only",
      historyStartBlock: null,
    };
    const nominationEntry: SourceCoverageEntryV1 = {
      ownerRef: nominationPlan.ownerRef,
      sourcePlanRef: nominationPlan.sourcePlanRef,
      familyDefinitionHash: nominationPlan.familyDefinitionHash,
      completeness: nominationPlan.completeness,
      historyStartBlock: null,
      previousAppliedThrough: null,
      cutoffHash: input.runtime.readyCutoff.hash,
      from: input.runtime.recentObservationStartBlock,
      appliedThrough: input.runtime.readyCutoff.number,
      resultPartitionRoot: hashDomain("aloha/full-family/mixed-result/v1", family.familyId),
      executionRoot: hashDomain("aloha/full-family/mixed-execution/v1", family.familyId),
      contributesOmissionAuthority: false,
    };
    const entries = [...input.sourceCoverage.artifact.sourceCoverage.entries, nominationEntry];
    const sourceCoverage = coverageBinding(input, entries);
    const sourceCoverageRoot = sourceCoverage.artifact.sourceCoverage.sourceCoverageRoot;
    const sourcePlans = sealFamilyEvidencePartition([...family.sourcePlans.items, {
      familyId: family.familyId,
      itemId: hashDomain("aloha/full-family/mixed-source-item/v1", family.familyId),
      subjectKey: fullFamilySourcePlanIdentity(nominationPlan),
      evidenceArtifactRefId: hashDomain("aloha/full-family/mixed-source-ref/v1", family.familyId),
      evidenceContentSha256: hashDomain("aloha/full-family/mixed-source-content/v1", family.familyId),
    }]);
    const families = input.families.map(value => value.familyId === family.familyId
      ? matrixInput(value, { sourcePlans })
      : value);
    return rebuild(input, families, {
      runtime: { ...input.runtime, sourceCoverageRoot },
      sourceCoverage,
    });
  },
  "source-coverage-self-consistent-complete-forgery": input => {
    const family = zeroFamily(input);
    const plan = planForFamily(input, family);
    const entries = input.sourceCoverage.artifact.sourceCoverage.entries.map(entry => fullFamilySourcePlanIdentity(entry) === fullFamilySourcePlanIdentity(plan)
      ? {
          ...entry,
          completeness: "complete-snapshot" as const,
          historyStartBlock: null,
          previousAppliedThrough: null,
          from: input.runtime.readyCutoff.number,
          appliedThrough: input.runtime.readyCutoff.number,
          contributesOmissionAuthority: true,
        }
      : entry);
    const sourceCoverage = coverageBinding(input, entries);
    const sourceCoverageRoot = sourceCoverage.artifact.sourceCoverage.sourceCoverageRoot;
    return rebuild(input, input.families, { runtime: { ...input.runtime, sourceCoverageRoot }, sourceCoverage });
  },
  "source-execution-omission": input => ({
    ...input,
    sourceCoverage: {
      ...input.sourceCoverage,
      artifact: { ...input.sourceCoverage.artifact, executions: input.sourceCoverage.artifact.executions.slice(1) },
    },
  }),
  "source-evidence-omission": input => {
    const execution = input.sourceCoverage.artifact.executions[0]!;
    return {
      ...input,
      sourceCoverage: {
        ...input.sourceCoverage,
        artifact: {
          ...input.sourceCoverage.artifact,
          executions: [{ ...execution, evidenceArtifactRefId: MUTATION_HASH }, ...input.sourceCoverage.artifact.executions.slice(1)],
        },
      },
    };
  },
  "source-physical-ref-splice": input => {
    const execution = input.sourceCoverage.artifact.executions[0]!;
    return {
      ...input,
      sourceCoverage: {
        ...input.sourceCoverage,
        artifact: {
          ...input.sourceCoverage.artifact,
          executions: [{
            ...execution,
            physicalObservations: [{ rawLocatorHash: MUTATION_HASH, artifactRefId: MUTATION_HASH, contentSha256: MUTATION_HASH }],
          }, ...input.sourceCoverage.artifact.executions.slice(1)],
        },
      },
    };
  },
  "source-execution-root-readdress": input => {
    const execution = input.sourceCoverage.artifact.executions[0]!;
    return {
      ...input,
      sourceCoverage: {
        ...input.sourceCoverage,
        artifact: {
          ...input.sourceCoverage.artifact,
          executions: [{ ...execution, executionRoot: MUTATION_HASH }, ...input.sourceCoverage.artifact.executions.slice(1)],
        },
      },
    };
  },
  "generated-declared-plan-omission": input => {
    const family = firstFamily(input);
    return replaceFamily(input, family, matrixInput(family, { sourcePlans: sealFamilyEvidencePartition([]) }));
  },
  "generated-point-plan-retyped-complete": input => {
    const family = zeroFamily(input);
    const plan = planForFamily(input, family);
    const entries = input.sourceCoverage.artifact.sourceCoverage.entries.map(entry => fullFamilySourcePlanIdentity(entry) === fullFamilySourcePlanIdentity(plan)
      ? {
          ...entry,
          completeness: "point-lookup" as const,
          historyStartBlock: null,
          previousAppliedThrough: null,
          from: input.runtime.readyCutoff.number,
          appliedThrough: input.runtime.readyCutoff.number,
          contributesOmissionAuthority: true,
        }
      : entry);
    const sourceCoverage = coverageBinding(input, entries);
    const sourceCoverageRoot = sourceCoverage.artifact.sourceCoverage.sourceCoverageRoot;
    return rebuild(input, input.families, { runtime: { ...input.runtime, sourceCoverageRoot }, sourceCoverage });
  },
  "generated-definition-hash-splice": input => {
    const family = firstFamily(input);
    const plan = planForFamily(input, family);
    const entries = input.sourceCoverage.artifact.sourceCoverage.entries.map(entry => fullFamilySourcePlanIdentity(entry) === fullFamilySourcePlanIdentity(plan)
      ? { ...entry, familyDefinitionHash: MUTATION_HASH }
      : entry);
    const sourceCoverageBase = coverageBinding(input, entries);
    const sourceCoverageRoot = sourceCoverageBase.artifact.sourceCoverage.sourceCoverageRoot;
    const sourceCoverage: FullFamilySourceCoverageBindingV1 = {
      ...sourceCoverageBase,
      artifact: {
        ...sourceCoverageBase.artifact,
        executions: sourceCoverageBase.artifact.executions.map(execution => execution.familyDefinitionHash === family.familyDefinitionHash
        ? { ...execution, familyDefinitionHash: MUTATION_HASH }
        : execution),
      },
    };
    const families = input.families.map(value => value.familyId === family.familyId
      ? matrixInput(value, { familyDefinitionHash: MUTATION_HASH })
      : value);
    const changedSet = (set: FullFamilyFactBundleV1["releaseIntent"]): FamilyReleaseSetDraftV1 => ({
      ...releaseDraft(set),
      entries: set.entries.map(entry => entry.familyId === family.familyId
        ? { familyId: entry.familyId, familyDefinitionHash: MUTATION_HASH }
        : { familyId: entry.familyId, familyDefinitionHash: entry.familyDefinitionHash }),
    });
    return rebuild(input, families, {
      runtime: { ...input.runtime, sourceCoverageRoot },
      sourceCoverage,
      releaseIntent: changedSet(input.releaseIntent),
      definitionCatalog: changedSet(input.definitionCatalog),
      runtimeComposition: changedSet(input.runtimeComposition),
    });
  },
  "generated-denominator-root-splice": input => rebuild(input, input.families, {
    runtime: { ...input.runtime, generatedRuntimeDescriptorRoot: MUTATION_HASH },
  }),
  "candidate-partition-retryable": input => {
    const family = firstFamily(input);
    const outcomes = sealFamilyOutcomePartition(family.outcomes.items.map((item, index) => index === 0
      ? { ...item, instanceKey: null, outcome: "retryable" as const }
      : item));
    return replaceFamily(input, family, matrixInput(family, { outcomes }));
  },
  "candidate-partition-invalid-program": input => {
    const family = firstFamily(input);
    const outcomes = sealFamilyOutcomePartition(family.outcomes.items.map((item, index) => index === 0
      ? { ...item, instanceKey: null, outcome: "invalid-program" as const }
      : item));
    return replaceFamily(input, family, matrixInput(family, { outcomes }));
  },
  "candidate-ready-record-splice": input => ({ ...input, runtime: { ...input.runtime, readyRecordHash: MUTATION_HASH } }),
  "candidate-partition-root-splice": input => ({ ...input, runtime: { ...input.runtime, candidatePartitionRoot: MUTATION_HASH } }),
  // The pure predicate can prove that verifier fields join the runtime and
  // proof, but it cannot know which verifier bytes the external release
  // authority selected. GateCore must reject this otherwise valid-looking
  // splice against the selected-predicate authority artifact pin.
  "candidate-proof-verifier-authority-splice": input => ({
    ...input,
    lineage: {
      ...input.lineage,
      candidateProofVerifierBinding: {
        ...input.lineage.candidateProofVerifierBinding,
        artifact: {
          ...input.lineage.candidateProofVerifierBinding.artifact,
          releaseAuthorityRoot: MUTATION_HASH,
        },
      },
    },
  }),
  "candidate-source-coverage-root-splice": input => ({ ...input, runtime: { ...input.runtime, sourceCoverageRoot: MUTATION_HASH } }),
  "candidate-root-splice": input => rawPartitionRootMutation(input, "universeCandidates"),
  "candidate-omission": input => {
    const family = strictFamily(input);
    const universeCandidates = sealFamilyEvidencePartition([]);
    return replaceFamily(input, family, matrixInput(family, {
      universeCandidates,
      outcomes: sealFamilyOutcomePartition([]),
      instancePublications: sealFamilyEvidencePartition([]),
      projectedEdges: sealFamilyEvidencePartition([]),
      coarseRankable: sealFamilyEvidencePartition([]),
      coarseUnavailable: sealFamilyEvidencePartition([]),
      unrankedAdmissions: sealFamilyEvidencePartition([]),
    }));
  },
  "outcome-omission": input => {
    const family = strictFamily(input);
    return replaceFamily(input, family, matrixInput(family, { outcomes: sealFamilyOutcomePartition([]) }));
  },
  "outcome-root-splice": input => rawPartitionRootMutation(input, "outcomes"),
  "instance-root-splice": input => rawPartitionRootMutation(input, "instancePublications"),
  "edge-root-splice": input => rawPartitionRootMutation(input, "projectedEdges"),
  "coarse-capability-root-splice": input => rawPartitionRootMutation(input, "declaredCoarseCapabilities"),
  "coarse-denominator-omission": input => {
    const family = strictFamily(input);
    return replaceFamily(input, family, matrixInput(family, { coarseRankable: sealFamilyEvidencePartition([]) }));
  },
  "exact-capability-root-splice": input => rawPartitionRootMutation(input, "declaredExactCapabilities"),
  "action-owner-root-splice": input => rawPartitionRootMutation(input, "ownedActions"),
  "cross-family-item": input => {
    const family = strictFamily(input);
    const items = family.universeCandidates.items.map((item, index) => index === 0
      ? { ...item, familyId: "family.other" }
      : item) as readonly FamilyEvidenceItemV1[];
    const universeCandidates = sealFamilyEvidencePartition(items);
    return replaceFamily(input, family, matrixInput(family, { universeCandidates }));
  },
  "release-intent-catalog-mismatch": input => rebuild(input, input.families, {
    definitionCatalog: releaseWithChangedDefinition(input.definitionCatalog),
  }),
  "release-intent-runtime-mismatch": input => rebuild(input, input.families, {
    runtimeComposition: releaseWithChangedDefinition(input.runtimeComposition),
  }),
  // These are valid-looking semantic splices. The pure predicate has no
  // artifact bytes; GateCore must reject them against the observed ready
  // record and content-addressed bundle.
  "runtime-ready-root-splice": input => ({ ...input, runtime: { ...input.runtime, readyRecordHash: MUTATION_HASH } }),
  "runtime-graph-root-splice": input => ({ ...input, runtime: { ...input.runtime, graphRoot: MUTATION_HASH } }),
  "actual-current-source-root-splice": input => ({
    ...input,
    runtime: { ...input.runtime, actualCurrentSourceRoot: MUTATION_HASH },
  }),
  "actual-current-source-cross-run": input => {
    const actualCurrentSource = {
      ...input.runtime.actualCurrentSource,
      number: (BigInt(input.runtime.actualCurrentSource.number) + 1n).toString(),
      hash: hashDomain("aloha/full-family/mutation-current-source/v1", "hash"),
      stateRoot: hashDomain("aloha/full-family/mutation-current-source/v1", "state-root"),
    };
    return rebuild(input, input.families, {
      runtime: {
        ...input.runtime,
        actualCurrentSource,
        actualCurrentSourceRoot: hashDomain("aloha/full-family/actual-current-source/v1", actualCurrentSource),
      },
    });
  },
  "recent-observation-range-49": input => ({
    ...input,
    runtime: { ...input.runtime, recentObservationStartBlock: (BigInt(input.runtime.readyCutoff.number) - 48n).toString() },
  }),
  "recent-observation-range-51": input => ({
    ...input,
    runtime: { ...input.runtime, recentObservationStartBlock: (BigInt(input.runtime.readyCutoff.number) - 50n).toString() },
  }),
  "unproven-rejection": input => {
    const family = rejectedFamily(input);
    const outcomes = sealFamilyOutcomePartition(family.outcomes.items.map((outcome, index) => index === 0
      ? { ...outcome, outcome: "unproven-rejected" as const }
      : outcome));
    return replaceFamily(input, family, matrixInput(family, { outcomes }));
  },
  "strict-publication-omission": input => {
    const family = strictFamily(input);
    return replaceFamily(input, family, matrixInput(family, { instancePublications: sealFamilyEvidencePartition([]) }));
  },
  "evidence-artifact-ref-splice": input => {
    const family = strictFamily(input);
    const item = family.sourcePlans.items[0];
    if (item === undefined) throw new Error("mutation fixture requires source-plan evidence");
    const sourcePlans = {
      ...family.sourcePlans,
      items: [{ ...item, evidenceArtifactRefId: MUTATION_HASH }, ...family.sourcePlans.items.slice(1)],
    };
    return {
      ...input,
      families: input.families.map(value => value.familyId === family.familyId ? { ...family, sourcePlans } : value),
    };
  },
  "producer-verdict-injection": input => ({ ...input, producerVerdict: "pass" }),
};

export interface FullFamilyMutationDefinitionV1 {
  readonly id: FullFamilySemanticMutationId;
  readonly apply: (input: FullFamilyFactBundleV1) => unknown;
}

export interface FullFamilyMutationRunV1 {
  readonly id: FullFamilySemanticMutationId;
  readonly mutated: unknown;
}

export const FULL_FAMILY_SEMANTIC_MUTATION_REGISTRY: readonly FullFamilyMutationDefinitionV1[] = Object.freeze(
  FULL_FAMILY_SEMANTIC_MUTATION_IDS.map(id => Object.freeze({ id, apply: definitions[id] })),
);

export function runFullFamilySemanticMutationRegistry(input: FullFamilyFactBundleV1): readonly FullFamilyMutationRunV1[] {
  return Object.freeze(FULL_FAMILY_SEMANTIC_MUTATION_REGISTRY.map(definition => Object.freeze({
    id: definition.id,
    mutated: definition.apply(input),
  })));
}

export interface FullFamilyReadyArtifactMutationRunV1 {
  readonly id: FullFamilyReadyArtifactCriticalMutationId;
  readonly mutated: unknown;
}

export function runFullFamilyReadyArtifactMutationRegistry(
  input: FullFamilyReadyRecordV1,
): readonly FullFamilyReadyArtifactMutationRunV1[] {
  const { parentHash: _omitted, ...observedHeadWithoutParentHash } = input.promotionFreshness.observedHead;
  return Object.freeze(FULL_FAMILY_READY_ARTIFACT_CRITICAL_MUTATION_IDS.map(id => Object.freeze({
    id,
    mutated: {
      ...input,
      promotionFreshness: {
        ...input.promotionFreshness,
        observedHead: observedHeadWithoutParentHash,
      },
    },
  })));
}
