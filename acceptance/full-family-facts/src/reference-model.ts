import {
  candidatePartitionKeysRoot,
} from "../../../specs/candidate-partition-authority/src/index.ts";
import {
  hashDomain,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeFullFamilyFacts,
  type FamilyEvidencePartitionV1,
  type FamilyOutcomePartitionV1,
  type FamilyReleaseSetV1,
  type FullFamilyFactBundleV1,
  type FullFamilyGeneratedRuntimeMetadataV1,
} from "./schema.ts";
import {
  sourcePlanIdentity,
  type SourcePlanRefV1,
} from "../../../packages/discovery/src/index.ts";

export type FullFamilyReferenceVerdict = "pass" | "fail" | "invalid";

export interface FullFamilyReferenceResultV1 {
  readonly verdict: FullFamilyReferenceVerdict;
  readonly reasons: readonly string[];
  readonly familyCount: string | null;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
}

function sameReleaseEntries(left: FamilyReleaseSetV1, right: FamilyReleaseSetV1): boolean {
  return left.entrySetRoot === right.entrySetRoot && left.count === right.count
    && left.entries.length === right.entries.length
    && left.entries.every((entry, index) => {
      const other = right.entries[index];
      return other !== undefined && entry.familyId === other.familyId
        && entry.familyDefinitionHash === other.familyDefinitionHash && entry.entryHash === other.entryHash;
    });
}

function familyBound(familyId: string, partitions: readonly (FamilyEvidencePartitionV1 | FamilyOutcomePartitionV1)[]): boolean {
  return partitions.every(partition => partition.items.every(item => item.familyId === familyId));
}

/** Qualification-only model. It deliberately does not import the live
 * predicate or its semantic validator. */
export function evaluateFullFamilyReferenceModel(
  value: unknown,
  generatedRuntime: FullFamilyGeneratedRuntimeMetadataV1,
): FullFamilyReferenceResultV1 {
  let bundle: FullFamilyFactBundleV1;
  try {
    const raw = Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value;
    bundle = decodeFullFamilyFacts(raw as object);
  } catch {
    return Object.freeze({ verdict: "invalid", reasons: Object.freeze(["malformed-fact"]), familyCount: null });
  }
  const invalid = (why: string): FullFamilyReferenceResultV1 => Object.freeze({ verdict: "invalid", reasons: Object.freeze([why]), familyCount: bundle.familyMatrixCount });
  const failed = (why: string): FullFamilyReferenceResultV1 => Object.freeze({ verdict: "fail", reasons: Object.freeze([why]), familyCount: bundle.familyMatrixCount });
  if (bundle.runtime.releaseIntentRoot !== generatedRuntime.releaseIntentRoot
    || bundle.runtime.definitionCatalogRoot !== generatedRuntime.definitionCatalogRoot
    || bundle.runtime.generatedRuntimeDescriptorRoot !== generatedRuntime.descriptorRoot) return invalid("generated-runtime-root-mismatch");
  if (!sameReleaseEntries(bundle.releaseIntent, bundle.definitionCatalog) || !sameReleaseEntries(bundle.releaseIntent, bundle.runtimeComposition)) return invalid("release-set-mismatch");
  if (bundle.releaseIntent.contractRoot !== bundle.runtime.releaseIntentRoot || bundle.definitionCatalog.contractRoot !== bundle.runtime.definitionCatalogRoot || bundle.runtimeComposition.contractRoot !== bundle.runtime.runtimeCompositionRoot) return invalid("runtime-root-mismatch");
  if (BigInt(bundle.runtime.recentObservationEndBlock) !== BigInt(bundle.runtime.readyCutoff.number) || BigInt(bundle.runtime.recentObservationEndBlock) - BigInt(bundle.runtime.recentObservationStartBlock) !== 49n) return invalid("recent-observation-range");
  const coverage = bundle.sourceCoverage.artifact;
  if (coverage.readyRecordHash !== bundle.runtime.readyRecordHash
    || coverage.cutoff.chainId !== bundle.runtime.readyCutoff.chainId
    || coverage.cutoff.number !== bundle.runtime.readyCutoff.number
    || coverage.cutoff.hash !== bundle.runtime.readyCutoff.hash
    || coverage.cutoff.stateRoot !== bundle.runtime.readyCutoff.stateRoot
    || coverage.sourceCoverage.sourceCoverageRoot !== bundle.runtime.sourceCoverageRoot) return invalid("source-coverage-runtime-binding");
  const closure = bundle.lineage.nominationClosure.artifact;
  const proof = bundle.lineage.candidatePartitionProof.artifact;
  const verifierBinding = bundle.lineage.candidateProofVerifierBinding.artifact;
  const nominatedKeys = closure.families.flatMap(family => family.familyCandidateKeys).sort();
  if (closure.root !== bundle.runtime.nominationClosureRoot
    || bundle.lineage.nominationClosure.storageHash !== bundle.runtime.nominationClosureStorageHash
    || closure.candidatePartitionRoot !== bundle.runtime.candidatePartitionRoot
    || closure.sourceCoverageRoot !== bundle.runtime.sourceCoverageRoot
    || proof.candidatePartitionRoot !== bundle.runtime.candidatePartitionRoot
    || proof.candidatePartitionStorageHash !== bundle.runtime.candidatePartitionStorageHash
    || proof.nominationClosureRoot !== bundle.runtime.nominationClosureRoot
    || proof.nominationClosureStorageHash !== bundle.runtime.nominationClosureStorageHash
    || bundle.lineage.candidatePartitionProof.storageHash !== bundle.runtime.candidatePartitionProofStorageHash
    || proof.recordCount !== String(nominatedKeys.length)
    || proof.candidateKeysRoot !== candidatePartitionKeysRoot(nominatedKeys)
    || proof.sourceCoverageRoot !== bundle.runtime.sourceCoverageRoot
    || proof.releaseProvenanceHash !== bundle.runtime.releaseProvenanceHash
    || verifierBinding.runtimeBindingId !== bundle.runtime.releaseBindingId
    || verifierBinding.releaseProvenanceHash !== bundle.runtime.releaseProvenanceHash
    || verifierBinding.proofKeyId !== proof.issuerKeyId) return invalid("lineage-runtime-binding");
  const release = new Map(bundle.releaseIntent.entries.map(entry => [entry.familyId, entry]));
  if (release.size !== bundle.families.length) return invalid("family-denominator");
  if (new Set(bundle.releaseIntent.entries.map(entry => entry.familyDefinitionHash)).size !== bundle.releaseIntent.entries.length) return invalid("duplicate-family-definition");
  if (generatedRuntime.families.length !== release.size) return invalid("generated-family-denominator");
  const plansByFamily = new Map<string, SourcePlanRefV1[]>();
  for (const generatedFamily of generatedRuntime.families) {
    if (release.get(generatedFamily.familyId)?.familyDefinitionHash !== generatedFamily.familyDefinitionHash) return invalid("generated-family-definition");
    plansByFamily.set(generatedFamily.familyId, [...generatedFamily.sourcePlanRefs]);
  }
  const executionByPlan = new Map(coverage.executions.map(binding => [hashDomain("aloha/source-plan-identity/v1", {
    ownerRef: binding.ownerRef,
    sourcePlanRef: binding.sourcePlanRef,
  }), binding]));
  if (executionByPlan.size !== coverage.executions.length) return invalid("source-execution-duplicate");
  const coverageEntries = new Map(coverage.sourceCoverage.entries.map(entry => [sourcePlanIdentity(entry), entry]));
  const allCandidateKeys: string[] = [];
  const allInstanceKeys: string[] = [];
  const allEdgeIds: string[] = [];
  let instanceCount = 0n;
  let edgeCount = 0n;
  for (const family of bundle.families) {
    if (release.get(family.familyId)?.familyDefinitionHash !== family.familyDefinitionHash) return invalid("family-definition");
    const generatedFamily = generatedRuntime.families.find(value => value.familyId === family.familyId);
    if (generatedFamily === undefined || generatedFamily.sourcePlanRoot !== family.sourcePlanRoot) return invalid("generated-source-plan-root");
    const partitions = [family.sourcePlans, family.universeCandidates, family.outcomes, family.instancePublications, family.projectedEdges, family.declaredCoarseCapabilities, family.coarseRankable, family.coarseUnavailable, family.unrankedAdmissions, family.declaredExactCapabilities, family.ownedActions];
    if (!familyBound(family.familyId, partitions)) return invalid("cross-family-evidence");
    const familyPlans = plansByFamily.get(family.familyId) ?? [];
    if (familyPlans.length === 0) return invalid("source-plan-empty");
    const declaredPlanIds = new Set(familyPlans.map(sourcePlanIdentity));
    const observedPlanIds = new Set(family.sourcePlans.items.map(item => item.subjectKey));
    if (observedPlanIds.size !== family.sourcePlans.items.length || !sameSet(declaredPlanIds, observedPlanIds)) return invalid("source-plan-partition");
    for (const plan of familyPlans) {
      const execution = executionByPlan.get(sourcePlanIdentity(plan));
      const coverageEntry = coverageEntries.get(sourcePlanIdentity(plan));
      if (execution === undefined || coverageEntry === undefined
        || coverageEntry.ownerRef !== plan.ownerRef
        || coverageEntry.sourcePlanRef !== plan.sourcePlanRef
        || coverageEntry.familyDefinitionHash !== plan.familyDefinitionHash
        || coverageEntry.completeness !== plan.completeness
        || coverageEntry.historyStartBlock !== plan.historyStartBlock
        || execution.executionRoot !== coverageEntry.executionRoot
        || execution.resultPartitionRoot !== coverageEntry.resultPartitionRoot) return invalid("source-execution-coverage-binding");
    }
    const partition = family.candidatePartition;
    const closurePartition = closure.families.find(value => value.familyId === family.familyId);
    if (closurePartition === undefined
      || JSON.stringify(partition) !== JSON.stringify(closurePartition)
      || partition.familyDefinitionHash !== family.familyDefinitionHash
      || partition.candidateCount !== family.universeCandidates.count
      || !sameSet(new Set(partition.familyCandidateKeys), new Set(family.universeCandidates.items.map(item => item.subjectKey)))) return invalid("candidate-partition");
    const candidates = new Set(family.universeCandidates.items.map(item => item.subjectKey));
    const outcomes = new Set(family.outcomes.items.map(item => item.candidateKey));
    if (candidates.size !== family.universeCandidates.items.length || !sameSet(candidates, outcomes)) return invalid("candidate-outcome-denominator");
    const verifiedInstances = new Set<string>();
    for (const outcome of family.outcomes.items) {
      if (outcome.outcome === "verified") {
        if (outcome.instanceKey === null) return invalid("verified-instance-binding");
        verifiedInstances.add(outcome.instanceKey);
      } else if (outcome.instanceKey !== null) return invalid("nonverified-instance-binding");
    }
    const publications = new Set(family.instancePublications.items.map(item => item.subjectKey));
    if (!sameSet(verifiedInstances, publications)) return invalid("publication-denominator");
    const edgeIds = new Set(family.projectedEdges.items.map(item => item.itemId));
    const edgeInstances = new Set(family.projectedEdges.items.map(item => item.subjectKey));
    if ([...edgeInstances].some(key => !publications.has(key)) || [...publications].some(key => !edgeInstances.has(key))) return invalid("edge-instance-denominator");
    const rankable = new Set(family.coarseRankable.items.map(item => item.subjectKey));
    const unavailable = new Set(family.coarseUnavailable.items.map(item => item.subjectKey));
    if ([...rankable].some(key => unavailable.has(key)) || !sameSet(edgeIds, new Set([...rankable, ...unavailable]))) return invalid("coarse-denominator");
    if (!sameSet(unavailable, new Set(family.unrankedAdmissions.items.map(item => item.subjectKey)))) return invalid("unranked-denominator");
    allCandidateKeys.push(...candidates);
    allInstanceKeys.push(...publications);
    allEdgeIds.push(...edgeIds);
    instanceCount += BigInt(family.instancePublications.count);
    edgeCount += BigInt(family.projectedEdges.count);
    if (family.outcomes.items.some(item => item.outcome === "retryable")) return invalid("retryable");
    if (family.outcomes.items.some(item => item.outcome === "invalid-program")) return invalid("invalid-program");
    if (family.universeCandidates.items.length === 0) {
      const authoritativePlans = familyPlans.filter(plan => (
        plan.completeness === "complete-snapshot" || plan.completeness === "contiguous-history"
      ));
      if (authoritativePlans.length === 0
        || authoritativePlans.some(plan => coverageEntries.get(sourcePlanIdentity(plan))?.contributesOmissionAuthority !== true)) {
        return invalid("source-coverage-omission-authority");
      }
    }
    if (family.outcomes.items.some(item => item.outcome === "unproven-rejected")) return failed("unproven-rejection");
    if (verifiedInstances.size > 0 && (family.instancePublications.items.length === 0 || family.projectedEdges.items.length === 0 || family.declaredCoarseCapabilities.items.length === 0 || family.declaredExactCapabilities.items.length === 0 || family.ownedActions.items.length === 0)) return failed("strict-publication-incomplete");
    if (verifiedInstances.size === 0 && family.universeCandidates.items.length > 0 && !family.outcomes.items.every(item => item.outcome === "chain-proven-rejected")) return failed("candidate-not-closed");
  }
  if (new Set(allCandidateKeys).size !== allCandidateKeys.length || new Set(allInstanceKeys).size !== allInstanceKeys.length || new Set(allEdgeIds).size !== allEdgeIds.length) return invalid("cross-family-identity-duplicate");
  if (instanceCount.toString() !== bundle.runtime.instanceCount || edgeCount.toString() !== bundle.runtime.edgeCount) return invalid("ready-count-mismatch");
  return Object.freeze({ verdict: "pass", reasons: Object.freeze([]), familyCount: bundle.familyMatrixCount });
}
