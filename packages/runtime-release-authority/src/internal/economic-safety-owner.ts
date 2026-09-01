import {
  createEconomicSafetyQualifiedEvaluatorV1,
  economicSafetyObjectivePolicyRootV1,
  ECONOMIC_SAFETY_EVALUATOR_EXPORT_IDENTITY_HASH_V1,
  type EconomicSafetyActionOwnerPolicyV1,
  type EconomicSafetyActionOwnerVerifierBindingV1,
  type EconomicSafetyExecutorQualificationV1,
  type EconomicSafetyFinalizationServiceV1,
  type EconomicSafetyObjectiveTemplateV1,
  type EconomicSafetyValuationOwnerDescriptorV1,
} from "../../../economics-safety/src/index.ts";
import { issueEconomicSafetyFinalizationServiceV1 } from "../../../economics-safety/src/internal/owner.ts";
import {
  readGeneratedFamilyRuntimeFactoryMetadata,
  type GeneratedFamilyRuntimeFactoryV1,
} from "../../../family-composition/src/internal/generated-runtime-composition.ts";
import type { FamilyRuntimeCompositionV1 } from "../../../family-composition/src/index.ts";
import type { ActionOwnerRef } from "../../../family-sdk/runtime-refs/index.ts";
import {
  decodeRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
  type RuntimeAuthorityDescriptorV1,
} from "../../../runtime-authority/src/index.ts";
import { hashDomain, type Hash } from "../../../canonical-codec/src/index.ts";
import {
  ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
  sealSafetyProfileV1,
  type SafetyProfileV1,
} from "../../../../specs/economic-safety-profile/src/index.ts";
import { readGeneratedEconomicValuationOwnerProposalRegistryV1 } from "../../../../generated/valuation-owner-registry/index.ts";
import { createNativeEquivalentValuationOwnerV1 } from "../../../../valuation-owners/native-equivalent/src/runtime.ts";

export interface EconomicSafetyRuntimeInputV1 {
  readonly runtimeAuthority: RuntimeAuthorityDescriptorV1;
  readonly familyRuntimeFactory: GeneratedFamilyRuntimeFactoryV1;
  readonly familyRuntimeComposition: FamilyRuntimeCompositionV1;
  readonly objectiveTemplates: readonly EconomicSafetyObjectiveTemplateV1[];
  readonly executorQualification: EconomicSafetyExecutorQualificationV1;
  readonly assertCurrent: () => void;
}

function runtimeActionOwners(input: EconomicSafetyRuntimeInputV1): Readonly<{
  readonly policies: readonly EconomicSafetyActionOwnerPolicyV1[];
  readonly verifiers: readonly EconomicSafetyActionOwnerVerifierBindingV1[];
  readonly safetyProfile: SafetyProfileV1;
}> {
  const metadata = readGeneratedFamilyRuntimeFactoryMetadata(input.familyRuntimeFactory);
  const rows = metadata.families.flatMap(family => family.actionOwners.map(owner => ({ family, owner })))
    .sort((left, right) => left.owner.ownerRef.localeCompare(right.owner.ownerRef));
  if (rows.length === 0) throw new TypeError("runtime has no generated action owners");
  const verifiers = rows.flatMap(({ family, owner }) => {
    const port = input.familyRuntimeComposition.resolveActionOwner(
      family.familyDefinitionHash,
      owner.ownerRef as ActionOwnerRef,
    ) as Readonly<{
      readonly decode?: (value: unknown) => unknown;
      readonly verifyObligations?: (value: unknown) => unknown;
    }>;
    if (typeof port?.decode !== "function" || typeof port.verifyObligations !== "function") {
      return [];
    }
    const qualificationLeafDigest = hashDomain("aloha/runtime/action-owner-membership/v1", {
      runtimeAuthority: input.runtimeAuthority.authorityBindingHash,
      familyDefinitionHash: family.familyDefinitionHash,
      ownerId: owner.ownerId,
      ownerRef: owner.ownerRef,
      implementationHash: owner.implementationHash,
      schemaRef: owner.schemaHash,
      implementationClosureRoot: owner.closureRoot,
    });
    const verifierHash = hashDomain("aloha/runtime/action-owner-verifier/v1", {
      implementationHash: owner.implementationHash,
      schemaRef: owner.schemaHash,
      implementationClosureRoot: owner.closureRoot,
    });
    return [Object.freeze({
      familyDefinitionHash: family.familyDefinitionHash,
      ownerId: owner.ownerId,
      ownerRef: owner.ownerRef,
      implementationHash: owner.implementationHash,
      schemaRef: owner.schemaHash,
      implementationClosureRoot: owner.closureRoot,
      claimSchemaRefs: Object.freeze([owner.schemaHash]),
      qualificationLeafDigest,
      verifierHash,
      verify: (value: unknown) => port.decode!.call(port, value),
      verifyObligations: (value: unknown) => port.verifyObligations!.call(port, value),
    })];
  });
  if (verifiers.length === 0) throw new TypeError("runtime has no verifiable action owners");
  const policies = Object.freeze(verifiers.map(({ verify: _verify, verifyObligations: _verifyObligations, ...policy }) => {
    void _verify;
    void _verifyObligations;
    return Object.freeze(policy);
  }));
  const qualifiedOwnerSetRoot = hashDomain(
    "aloha/runtime/action-owner-set/v1",
    policies.map(owner => owner.qualificationLeafDigest),
  );
  const safetyProfile = sealSafetyProfileV1({
    profileRef: hashDomain("aloha/runtime/economic-safety-profile/v1", {
      runtimeAuthority: input.runtimeAuthority.authorityBindingHash,
      qualifiedOwnerSetRoot,
    }),
    qualifiedOwnerSetRoot,
    requiredClaims: policies.map(owner => Object.freeze({
      claimSchemaRef: owner.schemaRef,
      ownerRef: owner.ownerRef,
      qualificationLeafDigest: owner.qualificationLeafDigest,
      revmObservationSchemaRef: ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
    })),
  });
  return Object.freeze({ policies, verifiers: Object.freeze(verifiers), safetyProfile });
}

function runtimeValuationOwners(): Readonly<{
  readonly descriptors: readonly EconomicSafetyValuationOwnerDescriptorV1[];
  readonly bindings: readonly ReturnType<typeof createNativeEquivalentValuationOwnerV1>[];
}> {
  const registry = readGeneratedEconomicValuationOwnerProposalRegistryV1();
  if (registry.entries.length !== 1) {
    throw new TypeError("runtime requires one generated native valuation owner");
  }
  const entry = registry.entries[0]!;
  const qualifiedValuationOwnerSetRoot = hashDomain(
    "aloha/runtime/valuation-owner-set/v1",
    registry.entries.map(owner => owner.qualificationLeafDigest),
  );
  const binding = createNativeEquivalentValuationOwnerV1({
    supportedAssetRefs: entry.supportedAssetRefs,
    implementationClosureRoot: entry.implementationClosureRoot,
    qualificationLeafDigest: entry.qualificationLeafDigest,
    valuationOwnerRegistryRoot: registry.valuationOwnerRegistryRoot,
    qualifiedValuationOwnerSetRoot,
  });
  const { observeCurrentSource: _observeCurrentSource, ...descriptor } = binding;
  void _observeCurrentSource;
  return Object.freeze({
    descriptors: Object.freeze([Object.freeze(descriptor)]),
    bindings: Object.freeze([binding]),
  });
}

/** Single economics owner backed by generated runtime declarations
 * and their real package-owned verifier ports. */
export function issueEconomicSafetyRuntimeServiceV1(
  rawInput: EconomicSafetyRuntimeInputV1,
): EconomicSafetyFinalizationServiceV1 {
  if (rawInput === null || typeof rawInput !== "object" || typeof rawInput.assertCurrent !== "function") {
    throw new TypeError("runtime economic safety input is invalid");
  }
  const input = Object.freeze({
    ...rawInput,
    runtimeAuthority: decodeRuntimeAuthorityDescriptorV1(rawInput.runtimeAuthority),
  });
  input.assertCurrent();
  const action = runtimeActionOwners(input);
  const valuation = runtimeValuationOwners();
  for (const template of input.objectiveTemplates) {
    const matching = valuation.descriptors.filter(owner => owner.ownerRef === template.valuationOwnerRef
      && owner.supportedAssetRefs.includes(template.profitAsset.assetRef));
    if (matching.length !== 1) {
      throw new TypeError("runtime valuation owner does not cover the objective asset");
    }
  }
  const policyRoot = economicSafetyObjectivePolicyRootV1(
    input.objectiveTemplates,
    action.policies,
    valuation.descriptors,
    input.executorQualification,
    action.safetyProfile,
  );
  const authorityRoot: Hash = hashDomain("aloha/runtime/economic-safety-authority/v1", {
    runtimeAuthority: input.runtimeAuthority.authorityBindingHash,
    policyRoot,
  });
  const implementationHash: Hash = hashDomain("aloha/runtime/economic-safety-implementation/v1", {
    evaluatorExportIdentityHash: ECONOMIC_SAFETY_EVALUATOR_EXPORT_IDENTITY_HASH_V1,
    policyRoot,
  });
  const service = issueEconomicSafetyFinalizationServiceV1({
    authorityRoot,
    implementationHash,
    runtimeAuthority: projectRuntimeAuthorityDescriptorV1(input.runtimeAuthority),
    evaluator: createEconomicSafetyQualifiedEvaluatorV1(
      input.objectiveTemplates,
      action.verifiers,
      valuation.bindings,
      input.executorQualification,
      action.safetyProfile,
    ),
  });
  input.assertCurrent();
  return service;
}
