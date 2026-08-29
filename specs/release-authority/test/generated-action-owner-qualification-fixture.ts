import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { readGeneratedFamilyRuntimeFactoryMetadata } from "../../../packages/family-composition/src/internal/generated-runtime-composition.ts";
import { createReleaseFamilyRuntimeComposition } from "../../../generated/runtime-composition/index.ts";
import {
  ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
  sealEconomicSafetyActionOwnerProposalV1,
  sealEconomicSafetyActionOwnerQualificationCertificateV1,
  sealEconomicSafetyActionOwnerQualificationSetV1,
  sealGeneratedEconomicSafetyActionOwnerRegistryV1,
  sealSafetyProfileV1,
} from "../../economic-safety-profile/src/index.ts";

/** Runtime-composition test material derived from the current generated
 * Family metadata. It preserves the exact action-owner proposal denominator
 * used by catalog generation; only the qualification evidence is test-owned. */
export function generatedEconomicSafetyActionOwnerQualificationFixtureV1(
  scope: string,
) {
  const metadata = readGeneratedFamilyRuntimeFactoryMetadata(createReleaseFamilyRuntimeComposition);
  const proposals = metadata.families.flatMap(family => family.actionOwners.map(owner =>
    sealEconomicSafetyActionOwnerProposalV1({
      familyDefinitionHash: family.familyDefinitionHash,
      ownerId: owner.ownerId,
      ownerRef: owner.ownerRef,
      implementationHash: owner.implementationHash,
      schemaRef: owner.schemaHash,
      implementationClosureRoot: owner.closureRoot,
    }))).sort((left, right) => left.ownerRef.localeCompare(right.ownerRef));
  const registry = sealGeneratedEconomicSafetyActionOwnerRegistryV1(proposals);
  const certificates = proposals.map(proposal => {
    const h = (field: string): Hash => hashDomain("test/generated-economic-safety-action-owner-qualification/v1", {
      scope,
      ownerRef: proposal.ownerRef,
      field,
    });
    return sealEconomicSafetyActionOwnerQualificationCertificateV1({
      schemaVersion: 1,
      kind: "aloha.economic-safety-action-owner-qualification-certificate",
      familyDefinitionHash: proposal.familyDefinitionHash,
      ownerId: proposal.ownerId,
      ownerRef: proposal.ownerRef,
      proposedOwnerLeafDigest: proposal.proposalLeafDigest,
      implementationHash: proposal.implementationHash,
      schemaRef: proposal.schemaRef,
      implementationClosureRoot: proposal.implementationClosureRoot,
      claimSchemaRefs: [proposal.schemaRef],
      verifierProgramDigest: h("verifier-program"),
      qualificationSpecDigest: h("qualification-spec"),
      criticalMutationCorpusRoot: h("critical-mutation-corpus"),
      independentOracleCaseRoot: h("independent-oracle-cases"),
      executedPositiveCaseRoot: h("executed-positive-cases"),
      executedNegativeCaseRoot: h("executed-negative-cases"),
      executedInvalidCaseRoot: h("executed-invalid-cases"),
      qualificationAuthorityApprovalId: h("qualification-authority-approval"),
      qualificationAuthorityApprovalPayloadHash: h("qualification-authority-approval-payload"),
    });
  });
  const set = sealEconomicSafetyActionOwnerQualificationSetV1(certificates);
  const profile = sealSafetyProfileV1({
    profileRef: hashDomain("test/generated-economic-safety-profile/v1", scope),
    qualifiedOwnerSetRoot: set.root,
    requiredClaims: set.certificates.map(certificate => ({
      claimSchemaRef: certificate.schemaRef,
      ownerRef: certificate.ownerRef,
      qualificationLeafDigest: certificate.qualificationLeafDigest,
      revmObservationSchemaRef: ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
    })),
  });
  return Object.freeze({
    registry,
    certificates: set.certificates,
    root: set.root,
    profile,
    profileRoot: profile.profileCompositionRoot,
  });
}
