import type {
  EconomicSafetyFinalizationServiceV1,
  EconomicSafetyQualifiedEvaluatorV1,
  EconomicSafetyObjectiveTemplateV1,
  EconomicSafetyActionOwnerPolicyV1,
  EconomicSafetyActionOwnerVerifierBindingV1,
  EconomicSafetyValuationOwnerDescriptorV1,
} from "../../../economics-safety/src/index.ts";
import type { SafetyProfileV1 } from "../../../../specs/economic-safety-profile/src/index.ts";
import {
  createEconomicSafetyQualifiedEvaluatorV1,
  decodeEconomicSafetyObjectiveTemplatesV1,
  economicSafetyObjectivePolicyRootV1,
  ECONOMIC_SAFETY_EVALUATOR_EXPORT_IDENTITY_HASH_V1,
  type EconomicSafetyExecutorQualificationV1,
} from "../../../economics-safety/src/evaluator.ts";
import { readGeneratedEconomicValuationOwnerRegistryV1 } from "../../../../generated/valuation-owner-registry/index.ts";
import { readGeneratedEconomicSafetyProfileV1 } from "../../../../generated/safety-profile/index.ts";
import { readGeneratedFamilyRuntimeFactoryMetadata } from "../../../family-composition/src/internal/generated-runtime-composition.ts";
import { createReleaseFamilyRuntimeComposition } from "../../../../generated/runtime-composition/index.ts";
import type { FamilyRuntimeCompositionV1 } from "../../../family-composition/src/index.ts";
import type { ActionOwnerRef } from "../../../family-sdk/runtime-refs/index.ts";
import { issueEconomicSafetyFinalizationServiceV1 } from "../../../economics-safety/src/internal/owner.ts";
import { hashDomain, type Hash } from "../../../canonical-codec/src/index.ts";
import { runtimeReleaseBindingProvenanceHash } from "../../../../specs/release-authority/src/index.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import { assertActiveRuntimeReleaseAuthorityState } from "./state.ts";
import { projectRuntimeAuthorityDescriptorV1 } from "../../../runtime-authority/src/index.ts";

export type RuntimeReleaseEconomicSafetyEvaluatorCapabilityV1 = object;

interface EvaluatorStateV1 {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly authorityVersion: bigint;
  readonly implementationHash: Hash;
  readonly policyRoot: Hash;
  readonly evaluatorExportIdentityHash: Hash;
  readonly templates: readonly EconomicSafetyObjectiveTemplateV1[];
  readonly actionOwners: readonly EconomicSafetyActionOwnerPolicyV1[];
  readonly valuationOwners: readonly EconomicSafetyValuationOwnerDescriptorV1[];
  readonly executorQualification: EconomicSafetyExecutorQualificationV1;
  readonly safetyProfile: SafetyProfileV1;
}

const evaluators = new WeakMap<object, EvaluatorStateV1>();
const evaluatorVersionByAuthority = new WeakMap<object, bigint>();
const consumedEvaluators = new WeakSet<object>();
const serviceVersionByAuthority = new WeakMap<object, bigint>();
const serviceBindings = new WeakMap<object, Readonly<{
  authority: RuntimeReleaseAuthorityV1;
  authorityVersion: bigint;
  authorityRoot: Hash;
  implementationHash: Hash;
  policyRoot: Hash;
  evaluatorExportIdentityHash: Hash;
  templates: readonly EconomicSafetyObjectiveTemplateV1[];
  actionOwners: readonly EconomicSafetyActionOwnerPolicyV1[];
  valuationOwners: readonly EconomicSafetyValuationOwnerDescriptorV1[];
  executorQualification: EconomicSafetyExecutorQualificationV1;
  safetyProfile: SafetyProfileV1;
  runtimeBindingId: Hash;
  candidateReleaseCommit: string;
  releaseProvenanceHash: Hash;
  available: boolean;
}>>();

function generatedValuationOwners(binding: ReturnType<typeof assertActiveRuntimeReleaseAuthorityState>["binding"]) {
  const generated = readGeneratedEconomicValuationOwnerRegistryV1(
    binding.valuationOwnerQualificationCertificates,
    binding.qualifiedValuationOwnerSetRoot,
  );
  if (
    generated.registry.valuationOwnerRegistryRoot !== binding.valuationOwnerRegistryRoot
    || generated.qualifiedValuationOwnerSetRoot !== binding.qualifiedValuationOwnerSetRoot
  ) throw new TypeError("runtime-release valuation-owner registry does not exact-match the signed release binding");
  if (generated.registry.entries.length !== generated.owners.length) {
    throw new TypeError("runtime-release valuation-owner registry/binding cardinality mismatch");
  }
  const descriptors = generated.registry.entries.map((entry, index) => {
    const owner = generated.owners[index];
    if (
      owner === undefined
      || owner.ownerRef !== entry.ownerRef
      || owner.supportedAssetRefs.length !== entry.supportedAssetRefs.length
      || owner.supportedAssetRefs.some((assetRef, assetIndex) => assetRef !== entry.supportedAssetRefs[assetIndex])
      || owner.implementationHash !== entry.implementationHash
      || owner.factSchemaRef !== entry.factSchemaRef
      || owner.implementationClosureRoot !== entry.implementationClosureRoot
      || owner.qualificationLeafDigest !== entry.qualificationLeafDigest
      || owner.valuationOwnerRegistryRoot !== generated.registry.valuationOwnerRegistryRoot
      || owner.qualifiedValuationOwnerSetRoot !== generated.qualifiedValuationOwnerSetRoot
    ) throw new TypeError(`runtime-release valuation-owner binding mismatch ${entry.ownerRef}`);
    return Object.freeze({
      ownerRef: owner.ownerRef,
      supportedAssetRefs: owner.supportedAssetRefs,
      implementationHash: owner.implementationHash,
      factSchemaRef: owner.factSchemaRef,
      implementationClosureRoot: owner.implementationClosureRoot,
      qualificationLeafDigest: owner.qualificationLeafDigest,
      valuationOwnerRegistryRoot: owner.valuationOwnerRegistryRoot,
      qualifiedValuationOwnerSetRoot: owner.qualifiedValuationOwnerSetRoot,
    });
  });
  return Object.freeze({ ...generated, descriptors: Object.freeze(descriptors) });
}

function generatedActionOwners(
  binding: ReturnType<typeof assertActiveRuntimeReleaseAuthorityState>["binding"],
  generated: ReturnType<typeof readGeneratedFamilyRuntimeFactoryMetadata>,
) {
  const qualified = readGeneratedEconomicSafetyProfileV1(
    binding.actionOwnerQualificationCertificates,
    binding.qualifiedActionOwnerSetRoot,
    binding.safetyProfile,
    binding.safetyProfileRoot,
  );
  if (qualified.registry.actionOwnerRegistryRoot !== binding.actionOwnerRegistryRoot
    || qualified.qualifiedOwnerSetRoot !== binding.qualifiedActionOwnerSetRoot
    || qualified.profileRoot !== binding.safetyProfileRoot) {
    throw new TypeError("runtime-release action-owner registry/profile does not exact-match the signed release binding");
  }
  const runtimeOwners = generated.families.flatMap(family => family.actionOwners.map(owner => ({ family, owner })));
  const policies = qualified.registry.entries.map((proposal, index) => {
    const certificate = qualified.certificates[index];
    const runtime = runtimeOwners.find(entry => entry.family.familyDefinitionHash === proposal.familyDefinitionHash
      && entry.owner.ownerRef === proposal.ownerRef && entry.owner.ownerId === proposal.ownerId);
    if (certificate === undefined || runtime === undefined
      || certificate.proposedOwnerLeafDigest !== proposal.proposalLeafDigest
      || certificate.implementationHash !== proposal.implementationHash
      || certificate.schemaRef !== proposal.schemaRef
      || certificate.implementationClosureRoot !== proposal.implementationClosureRoot
      || runtime.owner.implementationHash !== proposal.implementationHash
      || runtime.owner.schemaHash !== proposal.schemaRef
      || runtime.owner.closureRoot !== proposal.implementationClosureRoot) {
      throw new TypeError(`runtime-release action-owner proposal/qualification/runtime splice ${proposal.ownerRef}`);
    }
    return Object.freeze({
      familyDefinitionHash: proposal.familyDefinitionHash,
      ownerId: proposal.ownerId,
      ownerRef: proposal.ownerRef,
      implementationHash: proposal.implementationHash,
      schemaRef: proposal.schemaRef,
      implementationClosureRoot: proposal.implementationClosureRoot,
      claimSchemaRefs: certificate.claimSchemaRefs,
      qualificationLeafDigest: certificate.qualificationLeafDigest,
      verifierHash: certificate.verifierProgramDigest,
    });
  });
  if (policies.length !== runtimeOwners.length) {
    throw new TypeError("runtime-release action-owner generated runtime/qualification denominator mismatch");
  }
  return Object.freeze({ policies: Object.freeze(policies), safetyProfile: qualified.profile });
}

/** Deployment-packaging seam. Raw evaluator functions never enter bootstrap. */
export function issueRuntimeReleaseEconomicSafetyEvaluatorCapabilityV1(
  authority: RuntimeReleaseAuthorityV1,
  policyBytes: Uint8Array,
): RuntimeReleaseEconomicSafetyEvaluatorCapabilityV1 {
  const state = assertActiveRuntimeReleaseAuthorityState(authority);
  if (evaluatorVersionByAuthority.get(authority) === state.version) {
    throw new TypeError("runtime-release economics/safety evaluator authority was already issued for this release");
  }
  const templates = decodeEconomicSafetyObjectiveTemplatesV1(policyBytes);
  const generated = readGeneratedFamilyRuntimeFactoryMetadata(createReleaseFamilyRuntimeComposition);
  const actionOwnerQualification = generatedActionOwners(state.binding, generated);
  const actionOwners = actionOwnerQualification.policies;
  const valuation = generatedValuationOwners(state.binding);
  const valuationOwners = valuation.descriptors;
  for (const template of templates) {
    const owners = valuationOwners.filter(owner => owner.ownerRef === template.valuationOwnerRef);
    if (owners.length !== 1 || !owners[0]!.supportedAssetRefs.includes(template.profitAsset.assetRef)) {
      throw new TypeError("runtime-release valuation owner does not uniquely cover the selected profit asset");
    }
  }
  const executorQualification = Object.freeze({
    executorKind: state.binding.selectedExecutor.executorKind,
    engineBuildFingerprint: state.binding.selectedExecutor.engineBuildFingerprint,
    executableFingerprint: state.binding.selectedExecutor.executableFingerprint,
    qualifiedExecutorRegistryRoot: state.binding.qualifiedExecutorRegistryRoot,
    selectedExecutorLeafHash: state.binding.selectedExecutorLeafHash,
    releaseRoleManifestRoot: state.binding.selectedExecutor.releaseRoleManifestRoot,
  });
  const releaseProvenanceHash = runtimeReleaseBindingProvenanceHash(state.binding);
  const policyRoot = economicSafetyObjectivePolicyRootV1(
    templates, actionOwners, valuationOwners, executorQualification, actionOwnerQualification.safetyProfile,
  );
  const implementationHash = hashDomain("aloha/runtime-release-economic-evaluator-implementation/v1", {
    runtimeBindingId: state.binding.bindingId,
    candidateReleaseCommit: state.binding.candidateReleaseCommit,
    releaseProvenanceHash,
    signedSearcherRuntimeClosureDigest: state.binding.searcherRuntime.implementationClosureDigest,
    evaluatorExportIdentityHash: ECONOMIC_SAFETY_EVALUATOR_EXPORT_IDENTITY_HASH_V1,
    policyRoot,
  });
  const capability = Object.freeze(Object.create(null)) as RuntimeReleaseEconomicSafetyEvaluatorCapabilityV1;
  evaluators.set(capability, {
    authority,
    authorityVersion: state.version,
    implementationHash,
    policyRoot,
    evaluatorExportIdentityHash: ECONOMIC_SAFETY_EVALUATOR_EXPORT_IDENTITY_HASH_V1,
    templates,
    actionOwners,
    valuationOwners,
    executorQualification,
    safetyProfile: actionOwnerQualification.safetyProfile,
  });
  evaluatorVersionByAuthority.set(authority, state.version);
  return capability;
}

function evaluatorFor(
  authority: RuntimeReleaseAuthorityV1,
  capability: RuntimeReleaseEconomicSafetyEvaluatorCapabilityV1 | undefined,
  composition: FamilyRuntimeCompositionV1 | undefined,
): Readonly<{
  evaluator: EconomicSafetyQualifiedEvaluatorV1;
  implementationHash: Hash;
  policyRoot: Hash;
  evaluatorExportIdentityHash: Hash;
  templates: readonly EconomicSafetyObjectiveTemplateV1[];
  actionOwners: readonly EconomicSafetyActionOwnerPolicyV1[];
  valuationOwners: readonly EconomicSafetyValuationOwnerDescriptorV1[];
  executorQualification: EconomicSafetyExecutorQualificationV1;
  safetyProfile: SafetyProfileV1;
  available: boolean;
}> {
  const current = assertActiveRuntimeReleaseAuthorityState(authority);
  const currentExecutorQualification = Object.freeze({
    executorKind: current.binding.selectedExecutor.executorKind,
    engineBuildFingerprint: current.binding.selectedExecutor.engineBuildFingerprint,
    executableFingerprint: current.binding.selectedExecutor.executableFingerprint,
    qualifiedExecutorRegistryRoot: current.binding.qualifiedExecutorRegistryRoot,
    selectedExecutorLeafHash: current.binding.selectedExecutorLeafHash,
    releaseRoleManifestRoot: current.binding.selectedExecutor.releaseRoleManifestRoot,
  });
  const valuation = generatedValuationOwners(current.binding);
  const generated = readGeneratedFamilyRuntimeFactoryMetadata(createReleaseFamilyRuntimeComposition);
  const actionOwnerQualification = generatedActionOwners(current.binding, generated);
  if (capability === undefined) {
    return Object.freeze({
      evaluator: Object.freeze({ async evaluate(): Promise<never> { throw new TypeError("runtime-release economics/safety evaluator authority is unavailable"); } }),
      implementationHash: hashDomain("aloha/runtime-release-economic-evaluator-unavailable/v1", null),
      policyRoot: hashDomain("aloha/runtime-release-economic-evaluator-policy-unavailable/v1", null),
      evaluatorExportIdentityHash: ECONOMIC_SAFETY_EVALUATOR_EXPORT_IDENTITY_HASH_V1,
      templates: Object.freeze([]),
      actionOwners: Object.freeze([]),
      valuationOwners: valuation.descriptors,
      executorQualification: currentExecutorQualification,
      safetyProfile: actionOwnerQualification.safetyProfile,
      available: false,
    });
  }
  if (capability === null || typeof capability !== "object") throw new TypeError("runtime-release economics/safety evaluator capability is invalid");
  const issued = evaluators.get(capability);
  if (issued === undefined || issued.authority !== authority || issued.authorityVersion !== current.version) {
    throw new TypeError("runtime-release economics/safety evaluator capability is not issued for this release");
  }
  if (consumedEvaluators.has(capability)) {
    throw new TypeError("runtime-release economics/safety evaluator capability was already consumed");
  }
  if (composition === undefined) {
    throw new TypeError("runtime-release economics/safety generated Family composition is required");
  }
  const verifierBindings = Object.freeze(issued.actionOwners.map(owner => {
    const port = composition.resolveActionOwner(owner.familyDefinitionHash, owner.ownerRef as ActionOwnerRef) as {
      readonly decode?: (value: unknown) => unknown;
      readonly verifyObligations?: (value: unknown) => unknown;
    };
    const decode = port?.decode;
    const obligationVerifier = port?.verifyObligations;
    const verify = typeof decode === "function"
      ? (payload: unknown) => decode.call(port, payload)
      : (_payload: unknown): never => { throw new TypeError(`economic safety package-owned action verifier is unavailable for ${owner.ownerId}`); };
    const verifyObligations = typeof obligationVerifier === "function"
      ? (payload: unknown) => obligationVerifier.call(port, payload)
      : (_payload: unknown): never => { throw new TypeError(`economic safety package-owned obligation verifier is unavailable for ${owner.ownerId}`); };
    return Object.freeze({ ...owner, verify, verifyObligations }) satisfies EconomicSafetyActionOwnerVerifierBindingV1;
  }));
  consumedEvaluators.add(capability);
  return Object.freeze({
    evaluator: createEconomicSafetyQualifiedEvaluatorV1(
      issued.templates,
      verifierBindings,
      valuation.owners,
      issued.executorQualification,
      issued.safetyProfile,
    ),
    implementationHash: issued.implementationHash,
    policyRoot: issued.policyRoot,
    evaluatorExportIdentityHash: issued.evaluatorExportIdentityHash,
    templates: issued.templates,
    actionOwners: issued.actionOwners,
    valuationOwners: issued.valuationOwners,
    executorQualification: issued.executorQualification,
    safetyProfile: issued.safetyProfile,
    available: true,
  });
}

export function issueRuntimeReleaseEconomicSafetyServiceV1(input: {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly evaluatorCapability?: RuntimeReleaseEconomicSafetyEvaluatorCapabilityV1;
  readonly familyRuntimeComposition?: FamilyRuntimeCompositionV1;
}): EconomicSafetyFinalizationServiceV1 {
  const state = assertActiveRuntimeReleaseAuthorityState(input.authority);
  if (serviceVersionByAuthority.get(input.authority) === state.version) {
    throw new TypeError("runtime-release economics/safety service was already issued for this release");
  }
  const selected = evaluatorFor(input.authority, input.evaluatorCapability, input.familyRuntimeComposition);
  const releaseProvenanceHash = runtimeReleaseBindingProvenanceHash(state.binding);
  const service = issueEconomicSafetyFinalizationServiceV1({
    authorityRoot: state.binding.releaseAuthorityRoot,
    implementationHash: selected.implementationHash,
    runtimeAuthority: projectRuntimeAuthorityDescriptorV1(state.descriptor),
    releaseProvenanceHash,
    evaluator: selected.evaluator,
  });
  serviceBindings.set(service as object, Object.freeze({
    authority: input.authority,
    authorityVersion: state.version,
    authorityRoot: state.binding.releaseAuthorityRoot,
    implementationHash: selected.implementationHash,
    policyRoot: selected.policyRoot,
    evaluatorExportIdentityHash: selected.evaluatorExportIdentityHash,
    templates: selected.templates,
    actionOwners: selected.actionOwners,
    valuationOwners: selected.valuationOwners,
    executorQualification: selected.executorQualification,
    safetyProfile: selected.safetyProfile,
    runtimeBindingId: state.binding.bindingId,
    candidateReleaseCommit: state.binding.candidateReleaseCommit,
    releaseProvenanceHash,
    available: selected.available,
  }));
  serviceVersionByAuthority.set(input.authority, state.version);
  return service;
}

export function readRuntimeReleaseEconomicEvaluatorBindingV1(
  authority: RuntimeReleaseAuthorityV1,
  service: EconomicSafetyFinalizationServiceV1,
) {
  const current = assertActiveRuntimeReleaseAuthorityState(authority);
  const binding = serviceBindings.get(service as object);
  if (binding === undefined || binding.authority !== authority || binding.authorityVersion !== current.version
    || binding.authorityRoot !== current.binding.releaseAuthorityRoot
    || binding.runtimeBindingId !== current.binding.bindingId
    || binding.candidateReleaseCommit !== current.binding.candidateReleaseCommit
    || binding.releaseProvenanceHash !== runtimeReleaseBindingProvenanceHash(current.binding)) {
    throw new TypeError("runtime-release economic evaluator binding is unavailable or stale");
  }
  return binding;
}
