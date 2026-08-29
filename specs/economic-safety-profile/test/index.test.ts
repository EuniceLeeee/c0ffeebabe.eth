import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
  assertSafetyProfileQualificationMembershipV1,
  joinGeneratedEconomicSafetyProfileV1,
  sealEconomicSafetyActionOwnerProposalV1,
  sealEconomicSafetyActionOwnerQualificationCertificateV1,
  sealEconomicSafetyActionOwnerQualificationSetV1,
  sealGeneratedEconomicSafetyActionOwnerRegistryV1,
  sealSafetyProfileV1,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/economic-safety-profile/v1", value);

function fixture() {
  const proposal = sealEconomicSafetyActionOwnerProposalV1({
    familyDefinitionHash: h("family"),
    ownerId: "test.action",
    ownerRef: h("owner"),
    implementationHash: h("implementation"),
    schemaRef: h("claim-schema"),
    implementationClosureRoot: h("closure"),
  });
  const registry = sealGeneratedEconomicSafetyActionOwnerRegistryV1([proposal]);
  const certificate = sealEconomicSafetyActionOwnerQualificationCertificateV1({
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
    verifierProgramDigest: h("verifier"),
    qualificationSpecDigest: h("spec"),
    criticalMutationCorpusRoot: h("mutations"),
    independentOracleCaseRoot: h("oracle"),
    executedPositiveCaseRoot: h("positive"),
    executedNegativeCaseRoot: h("negative"),
    executedInvalidCaseRoot: h("invalid"),
    qualificationAuthorityApprovalId: h("approval"),
    qualificationAuthorityApprovalPayloadHash: h("approval-payload"),
  });
  const set = sealEconomicSafetyActionOwnerQualificationSetV1([certificate]);
  const profile = sealSafetyProfileV1({
    profileRef: h("profile"),
    qualifiedOwnerSetRoot: set.root,
    requiredClaims: [{
      claimSchemaRef: proposal.schemaRef,
      ownerRef: proposal.ownerRef,
      qualificationLeafDigest: certificate.qualificationLeafDigest,
      revmObservationSchemaRef: ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
    }],
  });
  return { proposal, registry, certificate, set, profile };
}

test("generated proposal, external certificate and SafetyProfile exact-join", () => {
  const value = fixture();
  assertSafetyProfileQualificationMembershipV1(value.profile, value.set.certificates);
  assert.equal(joinGeneratedEconomicSafetyProfileV1(
    value.registry,
    value.set.certificates,
    value.set.root,
    value.profile,
    value.profile.profileCompositionRoot,
  ).profileRoot, value.profile.profileCompositionRoot);
  assert.ok(value.registry.actionOwnerRegistryRoot.startsWith("0x"));
});

test("jointly re-rooted profile cannot substitute an unqualified owner", () => {
  const value = fixture();
  const foreign = sealEconomicSafetyActionOwnerQualificationCertificateV1({
    ...value.certificate,
    ownerRef: h("foreign-owner"),
    proposedOwnerLeafDigest: h("foreign-proposal"),
  });
  const set = sealEconomicSafetyActionOwnerQualificationSetV1([foreign]);
  const profile = sealSafetyProfileV1({
    profileRef: value.profile.profileRef,
    qualifiedOwnerSetRoot: set.root,
    requiredClaims: [{
      ...value.profile.requiredClaims[0]!,
      ownerRef: foreign.ownerRef,
      qualificationLeafDigest: foreign.qualificationLeafDigest,
    }],
  });
  assert.throws(
    () => assertSafetyProfileQualificationMembershipV1(profile, value.set.certificates),
    /qualified owner set root mismatch/,
  );
});

test("unrelated owner addition preserves the existing proposal leaf", () => {
  const value = fixture();
  const second = sealEconomicSafetyActionOwnerProposalV1({
    familyDefinitionHash: h("family-2"),
    ownerId: "test.action-2",
    ownerRef: h("owner-2"),
    implementationHash: h("implementation-2"),
    schemaRef: h("claim-schema-2"),
    implementationClosureRoot: h("closure-2"),
  });
  const ordered = [value.proposal, second].sort((left, right) => left.ownerRef.localeCompare(right.ownerRef));
  const expanded = sealGeneratedEconomicSafetyActionOwnerRegistryV1(ordered);
  assert.equal(
    value.proposal.proposalLeafDigest,
    expanded.entries.find(entry => entry.ownerRef === value.proposal.ownerRef)!.proposalLeafDigest,
  );
  assert.notEqual(value.registry.actionOwnerRegistryRoot, expanded.actionOwnerRegistryRoot);
});
