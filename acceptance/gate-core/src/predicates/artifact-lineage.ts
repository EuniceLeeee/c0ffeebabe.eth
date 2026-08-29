import {
  ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  ARTIFACT_LINEAGE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  ARTIFACT_LINEAGE_PREDICATE_SPEC,
  decodeArtifactLineageFactBundle,
  evaluateArtifactLineagePredicate,
  type ArtifactLineageFactBundleV1,
} from "../../../artifact-lineage-facts/src/runtime.ts";
import { encodeCanonicalJson, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import { COMMON_ENVELOPE_ROLE_CONTRACT_VERSION } from "../../../../specs/qualification/src/index.ts";
import type { GateVerdict } from "../predicate-contract.ts";
import type {
  PredicateEvaluatorV1,
  PredicateIssueSinkV1,
  PredicateRuntimeFactsV1,
} from "../predicate-composition.ts";

/**
 * This descriptor is a qualified runtime fact, not an import of the oracle
 * implementation. The qualification-only package signs/records it; live
 * GateCore only compares the pinned digest and never executes the oracle.
 * The runtime-spec export will become the source of this value when the
 * artifact-lineage facts package is split into runtime and qualification
 * entrypoints.
 */
const ARTIFACT_LINEAGE_ADAPTER_VERSION = "artifact-lineage-gate-core-adapter-v1";

/** Plugin-owned identity used by the release generator; central composition
 * never infers an oracle from a family/predicate name. */
export const ARTIFACT_LINEAGE_PREDICATE_ADAPTER_VERSION = ARTIFACT_LINEAGE_ADAPTER_VERSION;

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return encodeCanonicalJson(left) === encodeCanonicalJson(right);
  } catch {
    return false;
  }
}

function evaluateLive(
  runtime: PredicateRuntimeFactsV1,
  issues: PredicateIssueSinkV1,
): GateVerdict {
  const live: ArtifactLineageFactBundleV1[] = [];
  for (const [index, value] of runtime.facts.entries()) {
    try {
      live.push(decodeArtifactLineageFactBundle(value as object));
    } catch {
      issues.add("predicate-observation-mismatch", `$.predicateFacts[${index}]`);
    }
  }
  if (live.length === 0 || live.length !== runtime.facts.length) {
    issues.add("predicate-observation-missing", "$.predicateFacts");
    return "invalid";
  }
  const refIds = new Set(runtime.refs.map((value) => value.artifactRefId));
  const resolutionClaimIds = new Set(runtime.claims.map((value) => value.claimId));
  const refsById = new Map(runtime.refs.map((value) => [value.artifactRefId, value]));
  const claimsById = new Map(runtime.claims.map((value) => [value.claimId, value]));
  const policiesByHash = new Map(runtime.policies.map((value) => [value.policyHash, value]));
  const leasesById = new Map(runtime.leases.map((value) => [value.receiptId, value]));
  const seenRefs = new Set<Hash>();
  const seenClaims = new Set<Hash>();
  const seenObservations = new Set<Hash>();
  const verdicts: GateVerdict[] = [];
  for (const [index, fact] of live.entries()) {
    const predicateResult = evaluateArtifactLineagePredicate(fact.claim, fact.observation, fact.rawFacts);
    verdicts.push(predicateResult.verdict);
    if (predicateResult.verdict === "invalid") issues.add("predicate-observation-mismatch", `$.predicateFacts[${index}]`);
    if (predicateResult.verdict === "fail") issues.add("predicate-failed", `$.predicateFacts[${index}]`);
    const artifactRefId = fact.claim.artifactRef.artifactRefId;
    const ref = refsById.get(artifactRefId);
    const resolutionClaim = claimsById.get(fact.claim.resolutionClaim.claimId);
    const policy = policiesByHash.get(fact.claim.resolverPolicy.policyHash);
    const lease = leasesById.get(fact.claim.retentionLease.receiptId);
    if (!refIds.has(artifactRefId) || ref === undefined || !sameJson(ref, fact.claim.artifactRef) || fact.observation.artifactRefId !== artifactRefId) {
      issues.add("artifact-ref-mismatch", `$.predicateFacts[${index}]`);
    }
    if (!resolutionClaimIds.has(fact.claim.resolutionClaim.claimId) || resolutionClaim === undefined || !sameJson(resolutionClaim, fact.claim.resolutionClaim)) {
      issues.add("artifact-claim-mismatch", `$.predicateFacts[${index}]`);
    }
    if (policy === undefined || !sameJson(policy, fact.claim.resolverPolicy)) {
      issues.add("resolver-policy-mismatch", `$.predicateFacts[${index}]`);
    }
    if (lease === undefined || !sameJson(lease, fact.claim.retentionLease)) {
      issues.add("retention-lease-mismatch", `$.predicateFacts[${index}]`);
    }
    if (seenRefs.has(artifactRefId) || seenClaims.has(fact.claim.claimId) || seenObservations.has(fact.observation.observationId)) {
      issues.add("predicate-observation-mismatch", `$.predicateFacts[${index}]`);
    }
    seenRefs.add(artifactRefId);
    seenClaims.add(fact.claim.claimId);
    seenObservations.add(fact.observation.observationId);
    const boundOuterObservation = runtime.observations.find((observation) =>
      observation.rawArtifactRefs.some((candidate) => candidate.artifactRefId === artifactRefId) &&
      observation.observedClaimIds.includes(fact.claim.resolutionClaim.claimId),
    );
    if (boundOuterObservation === undefined) {
      issues.add("observation-mismatch", `$.predicateFacts[${index}]`);
    }
  }
  if (seenRefs.size !== refIds.size || seenClaims.size !== runtime.claims.length) {
    issues.add("predicate-observation-missing", "$.predicateFacts");
  }
  if (verdicts.includes("invalid")) return "invalid";
  if (verdicts.includes("fail")) return "fail";
  return "pass";
}

export const ARTIFACT_LINEAGE_PREDICATE_EVALUATOR: PredicateEvaluatorV1 = Object.freeze({
  predicateId: ARTIFACT_LINEAGE_PREDICATE_SPEC.predicateId,
  commonEnvelopeRoleContractVersion: COMMON_ENVELOPE_ROLE_CONTRACT_VERSION,
  adapterVersion: ARTIFACT_LINEAGE_ADAPTER_VERSION,
  predicateSpec: ARTIFACT_LINEAGE_PREDICATE_SPEC,
  predicateProgramDescriptorDigest: ARTIFACT_LINEAGE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  oracleProgramDescriptorDigest: ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  evaluateLive,
});
