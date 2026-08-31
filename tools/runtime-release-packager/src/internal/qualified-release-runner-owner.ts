/// <reference path="./qualified-release-runtime-entry.ts" />

import { types as nodeTypes } from "node:util";
import {
  CANONICAL_LIMITS,
  assertExactKeys,
  assertPlainObject,
  decodeCanonicalJson,
  encodeCanonicalBytes,
  hashDomain,
  readOwnEnumerableDataProperty,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  assertPredicateCommonEnvelopeRoleContractV1,
  decodeObserverSigningKey,
  hashObserverSigningKeySetRoot,
  hashRevokedObserverKeyIdsRoot,
  type ObserverSigningKeyV1,
} from "../../../../specs/qualification/src/index.ts";
import {
  decodeAcceptanceQuery,
  decodeAcquisitionProcessObservation,
  decodeQualifiedFactSnapshot,
  decodeQualifiedObservation,
  decodeSignedObserverInvocationSnapshot,
  decodeStoreEpochObservation,
  decodeTargetProcessObservation,
  type AcceptanceQueryV1,
  type QualifiedFactSnapshotV1,
  type QualifiedObservationEnvelopeV1,
  type QualifiedSidecarObservationV1,
  type SignedObserverInvocationSnapshotV1,
} from "../../../../specs/qualified-facts/src/index.ts";
import {
  decodeRuntimeReleaseBindingV1,
  type RuntimeReleaseBindingV1,
  type RuntimeReleaseSignerPinV1,
} from "../../../../specs/release-authority/src/index.ts";
import type { VerifyExternalQualificationInputV2 } from "../../../../packages/external-qualification-verifier/src/index.ts";
import {
  computeGateCoreAuthorityPinDigest,
  type AssembledPredicateEvaluationV1,
  type GateCoreAuthorityPinV1,
  type GateCoreInputV1,
  type PredicateMaterialSourcePortV1,
  type RegistryMembershipFactsV1,
} from "../../../../acceptance/gate-core/src/index.ts";
import type {
  PredicateCompositionBindingV1,
  SelectedPredicateAuthorityEntryV1,
} from "../../../../acceptance/gate-core/src/predicate-composition.ts";
import {
  type CommonEnvelopeAssemblyStateV1,
} from "../../../../acceptance/gate-core/src/internal/material-provider-state.ts";
import { issueCommonEnvelopeAuthorityPortV1 } from "../../../../acceptance/gate-core/src/internal/common-envelope-authority-issuer.ts";
import type { PredicateDomainMaterialV1 } from "../../../../acceptance/gate-core/src/material-provider.ts";
import {
  assembleReleaseGateInvocations,
  evaluateAssembledReleaseGateInvocations,
} from "../../../../acceptance/gate-core/src/generated/release-runtime.ts";
import { readAssembledReleaseAcceptanceResultsV1 } from "../../../../acceptance/gate-core/src/internal/assembled-acceptance-owner.ts";
import {
  assertRuntimeBindingJoinsReleaseApprovalV1,
  prepareReleaseAcceptanceV1,
  verifyReleaseRequirementDenominatorV1,
  type PreparedReleaseAcceptanceV1,
} from "../release-acceptance.ts";
import { verifyRuntimeReleaseBindingSignatureV1 } from "./runtime-binding-verifier.ts";
import {
  issueDeploymentReleaseClockV1,
  readDeploymentReleaseClockUnixNsV1,
  type DeploymentReleaseClockCapabilityV1,
} from "./deployment-clock-owner.ts";

export type QualifiedReleaseAcceptanceRunnerCapabilityV1 = object;

/**
 * Untrusted deployment artifacts for one generated predicate.  Predicate
 * facts and content refs are deliberately absent: the generated material
 * provider obtains those from owner-issued production observer ports.
 */
export interface QualifiedPredicateCommonEnvelopeMaterialV1 {
  readonly predicateId: string;
  readonly maxInvocationTtlUnixNs: string;
  readonly selectedPredicateAuthority: SelectedPredicateAuthorityEntryV1;
  readonly query: AcceptanceQueryV1;
  readonly snapshot: QualifiedFactSnapshotV1;
  readonly observerSigningKeys: readonly ObserverSigningKeyV1[];
  readonly revokedObserverKeyIds: readonly Hash[];
  readonly observations: readonly QualifiedObservationEnvelopeV1[];
  readonly sidecarObservations: readonly QualifiedSidecarObservationV1[];
  readonly signedInvocationSnapshot: SignedObserverInvocationSnapshotV1;
}

export interface InstallQualifiedReleaseAcceptanceRunnerInputV1 {
  readonly runtimeBinding: RuntimeReleaseBindingV1;
  readonly runtimeSignerPin: RuntimeReleaseSignerPinV1;
  readonly externalQualifications: readonly VerifyExternalQualificationInputV2[];
  readonly predicateMaterials: readonly QualifiedPredicateCommonEnvelopeMaterialV1[];
}

export interface QualifiedReleaseAcceptanceAdvisoryRunV1 {
  readonly evaluations: readonly AssembledPredicateEvaluationV1[];
}

export interface QualifiedReleaseAcceptancePreparedRunV1 {
  readonly evaluations: readonly AssembledPredicateEvaluationV1[];
  readonly preparedAcceptance: PreparedReleaseAcceptanceV1;
}

type InstalledMaterialV1 =
  | Readonly<{ readonly status: "available"; readonly value: QualifiedPredicateCommonEnvelopeMaterialV1 }>
  | Readonly<{ readonly status: "invalid"; readonly evidenceRoot: Hash }>;

interface RunnerStateV1 {
  readonly runtimeBinding: RuntimeReleaseBindingV1;
  readonly externalQualifications: readonly VerifyExternalQualificationInputV2[];
  readonly qualificationByPredicate: ReadonlyMap<string, VerifyExternalQualificationInputV2>;
  readonly materialByPredicate: ReadonlyMap<string, InstalledMaterialV1>;
  readonly clock: DeploymentReleaseClockCapabilityV1;
  readonly authority: ReturnType<typeof issueCommonEnvelopeAuthorityPortV1>;
}

const runners = new WeakMap<object, RunnerStateV1>();

function sameCanonical(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalBytes(left)).equals(Buffer.from(encodeCanonicalBytes(right)));
}

function canonicalClone<T>(value: T): T {
  return decodeCanonicalJson(encodeCanonicalBytes(value)) as T;
}

function copyExactInputArray(value: unknown, path: string): readonly unknown[] {
  if (value !== null && typeof value === "object" && nodeTypes.isProxy(value)) {
    throw new TypeError(`${path} must not be a Proxy`);
  }
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (descriptor === undefined || !("value" in descriptor)
    || typeof descriptor.value !== "number" || !Number.isSafeInteger(descriptor.value)
    || descriptor.value < 0 || descriptor.value > CANONICAL_LIMITS.maxArrayItems) {
    throw new TypeError(`${path} array length invalid`);
  }
  const length = descriptor.value;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1
    || keys.some(key => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) {
    throw new TypeError(`${path} must be a dense exact array`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (item === undefined || !("value" in item) || !item.enumerable) {
      throw new TypeError(`${path}[${index}] must be an enumerable data property`);
    }
    result.push(item.value);
  }
  return Object.freeze(result);
}

function preflightNestedArrays(value: unknown, path: string, seen: WeakSet<object> = new WeakSet()): void {
  if (value === null || typeof value !== "object") return;
  if (nodeTypes.isProxy(value)) throw new TypeError(`${path} must not be a Proxy`);
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    const copy = copyExactInputArray(value, path);
    copy.forEach((item, index) => preflightNestedArrays(item, `${path}[${index}]`, seen));
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor && descriptor.enumerable) {
      preflightNestedArrays(descriptor.value, `${path}.${key}`, seen);
    }
  }
}

function requireHash(value: unknown, path: string): asserts value is Hash {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${path} must be an exact lowercase hash`);
  }
}

function decodeSidecar(value: QualifiedSidecarObservationV1): QualifiedSidecarObservationV1 {
  switch (value.kind) {
    case "aloha.acquisition-process-observation":
      return decodeAcquisitionProcessObservation(value);
    case "aloha.store-epoch-observation":
      return decodeStoreEpochObservation(value);
    case "aloha.target-process-observation":
      return decodeTargetProcessObservation(value);
  }
}

function normalizePredicateMaterial(
  value: QualifiedPredicateCommonEnvelopeMaterialV1,
): QualifiedPredicateCommonEnvelopeMaterialV1 {
  assertPlainObject(value, "predicateMaterial");
  assertExactKeys(value, [
    "predicateId",
    "maxInvocationTtlUnixNs",
    "selectedPredicateAuthority",
    "query",
    "snapshot",
    "observerSigningKeys",
    "revokedObserverKeyIds",
    "observations",
    "sidecarObservations",
    "signedInvocationSnapshot",
  ], "predicateMaterial");
  if (typeof value.predicateId !== "string" || value.predicateId.length === 0) {
    throw new TypeError("predicate common-envelope material predicateId is required");
  }
  if (typeof value.maxInvocationTtlUnixNs !== "string"
    || !/^(0|[1-9][0-9]*)$/.test(value.maxInvocationTtlUnixNs)
    || BigInt(value.maxInvocationTtlUnixNs) <= 0n) {
    throw new TypeError("predicate common-envelope max invocation TTL must be a positive decimal string");
  }
  const revokedObserverKeyIds = value.revokedObserverKeyIds.map((keyId, index) => {
    requireHash(keyId, `revokedObserverKeyIds[${index}]`);
    return keyId;
  });
  for (let index = 1; index < revokedObserverKeyIds.length; index += 1) {
    if (revokedObserverKeyIds[index - 1]! >= revokedObserverKeyIds[index]!) {
      throw new TypeError("revoked observer key ids must be strictly sorted and unique");
    }
  }
  const observerSigningKeys = value.observerSigningKeys.map(key => decodeObserverSigningKey(key));
  for (let index = 1; index < observerSigningKeys.length; index += 1) {
    if (observerSigningKeys[index - 1]!.keyId >= observerSigningKeys[index]!.keyId) {
      throw new TypeError("observer signing keys must be strictly sorted and unique");
    }
  }
  const selectedPredicateAuthority = canonicalClone(value.selectedPredicateAuthority);
  if (selectedPredicateAuthority.predicateId !== value.predicateId) {
    throw new TypeError("selected predicate authority predicateId mismatch");
  }
  return Object.freeze({
    predicateId: value.predicateId,
    maxInvocationTtlUnixNs: value.maxInvocationTtlUnixNs,
    selectedPredicateAuthority,
    query: decodeAcceptanceQuery(value.query),
    snapshot: decodeQualifiedFactSnapshot(value.snapshot),
    observerSigningKeys: Object.freeze(observerSigningKeys),
    revokedObserverKeyIds: Object.freeze(revokedObserverKeyIds),
    observations: Object.freeze(value.observations.map(observation => decodeQualifiedObservation(observation))),
    sidecarObservations: Object.freeze(value.sidecarObservations.map(decodeSidecar)),
    signedInvocationSnapshot: decodeSignedObserverInvocationSnapshot(value.signedInvocationSnapshot),
  });
}

function buildAuthority(
  state: RunnerStateV1,
  binding: PredicateCompositionBindingV1,
  material: QualifiedPredicateCommonEnvelopeMaterialV1,
): GateCoreAuthorityPinV1 {
  const qualification = state.qualificationByPredicate.get(binding.predicateId);
  if (qualification === undefined) throw new TypeError("predicate external qualification is missing");
  const approval = qualification.evidence.releaseAuthorityApproval;
  const requirement = approval.releaseAcceptanceRequirements.find(value => value.predicateId === binding.predicateId);
  if (requirement === undefined) throw new TypeError("predicate release requirement is missing");
  const predicate = binding.evaluator.predicateSpec;
  const verifier = qualification.verifierCertificate;
  const commonEnvelope = assertPredicateCommonEnvelopeRoleContractV1(predicate);
  const observerIds = qualification.observerCertificates.map(value => value.certificateId).sort();
  if (
    binding.commonEnvelopeRoleContractVersion !== commonEnvelope.version
    || predicate.predicateId !== binding.predicateId
    || predicate.specDigest !== binding.predicateSpecDigest
    || verifier.verdict !== "qualified"
    || verifier.certificateId !== requirement.verifierCertificateId
    || verifier.predicateSpecDigest !== binding.predicateSpecDigest
    || verifier.predicateProgramDescriptorDigest !== binding.predicateProgramDescriptorDigest
    || verifier.oracleProgramDescriptorDigest !== binding.oracleProgramDescriptorDigest
    || verifier.predicateCompositionLeafDigest !== binding.compositionLeafDigest
    || verifier.predicateImplementationExportDigest !== binding.predicateImplementationExportDigest
    || verifier.oracleImplementationExportDigest !== binding.oracleImplementationExportDigest
    || !sameCanonical(verifier.observerQualificationIds, observerIds)
    || !sameCanonical(requirement.observerCertificateIds, observerIds)
  ) {
    throw new TypeError("generated predicate binding does not exact-join its signed qualification material");
  }
  const runtimeBinding = state.runtimeBinding;
  const pin = qualification.pin;
  if (
    pin.expectedTrustAnchorRoot !== runtimeBinding.externalTrustAnchorRoot
    || pin.expectedIssuerKeySetRoot !== runtimeBinding.externalIssuerKeySetRoot
    || pin.expectedRegistryApprovalId !== runtimeBinding.qualificationRegistryApprovalId
    || pin.expectedReleaseAuthorityApprovalId !== runtimeBinding.releaseAuthorityApprovalId
    || pin.expectedQualificationAudienceHash !== runtimeBinding.qualificationAudienceHash
    || pin.expectedReleaseRoleManifestRoot !== runtimeBinding.releaseRoleManifestRoot
    || pin.expectedCandidateReleaseCommit !== runtimeBinding.candidateReleaseCommit
    || qualification.registry.registryId !== runtimeBinding.qualificationRegistryRoot
    || qualification.registry.epoch !== runtimeBinding.qualificationEpoch
  ) {
    throw new TypeError("runtime release binding does not exact-join predicate qualification authority");
  }
  const authority: GateCoreAuthorityPinV1 = Object.freeze({
    registry: Object.freeze({
      expectedRegistryRoot: qualification.registry.registryId,
      expectedGovernanceTrustAnchorHash: qualification.registry.governanceTrustAnchorHash,
      expectedEpoch: qualification.registry.epoch,
    }),
    externalQualification: qualification.pin,
    predicate,
    predicateProgramDescriptorDigest: binding.predicateProgramDescriptorDigest,
    oracleProgramDescriptorDigest: binding.oracleProgramDescriptorDigest,
    predicateCompositionLeafDigest: binding.compositionLeafDigest,
    predicateCompositionRootDigest: runtimeBinding.predicateCompositionRootDigest,
    predicateImplementationClosureDigest: verifier.predicateImplementationDigest,
    predicateImplementationExportDigest: binding.predicateImplementationExportDigest,
    oracleImplementationClosureDigest: verifier.oracleImplementationClosureDigest,
    oracleImplementationExportDigest: binding.oracleImplementationExportDigest,
    gateCoreImplementationClosureDigest: runtimeBinding.gateCoreImplementationClosureDigest,
    gateCoreRuntimeClosureDigest: runtimeBinding.gateCoreRuntimeClosureDigest,
    verifierQualificationId: verifier.certificateId,
    signedInvocationRoleId: commonEnvelope.signedInvocationRoleId,
    maxInvocationTtlUnixNs: material.maxInvocationTtlUnixNs,
    expectedAudienceHash: runtimeBinding.qualificationAudienceHash,
    selectedPredicateAuthority: material.selectedPredicateAuthority,
  });
  if (computeGateCoreAuthorityPinDigest(authority) !== requirement.authorityPinDigest
    || qualification.release.authorityPinDigest !== requirement.authorityPinDigest) {
    throw new TypeError("predicate CommonEnvelope authority does not equal the externally signed authority pin");
  }
  return authority;
}

function inputFor(
  qualification: VerifyExternalQualificationInputV2,
  envelope: QualifiedPredicateCommonEnvelopeMaterialV1,
  material: PredicateDomainMaterialV1,
  authority: GateCoreAuthorityPinV1,
): GateCoreInputV1 {
  if (material.candidateReleaseCommit !== qualification.pin.expectedCandidateReleaseCommit) {
    throw new TypeError("predicate owner material candidate release commit mismatch");
  }
  if (envelope.query.predicateSpecDigest !== qualification.release.predicateSpecDigest
    || envelope.query.qualificationRegistryRoot !== qualification.registry.registryId
    || envelope.snapshot.qualificationRegistryRoot !== qualification.registry.registryId
    || envelope.snapshot.snapshotId !== envelope.query.qualifiedFactSnapshotId
    || envelope.signedInvocationSnapshot.acceptanceQueryId !== envelope.query.queryId
    || envelope.signedInvocationSnapshot.qualifiedFactSnapshotId !== envelope.snapshot.snapshotId
    || envelope.signedInvocationSnapshot.registryRoot !== qualification.registry.registryId
    || envelope.signedInvocationSnapshot.registryEpoch !== qualification.registry.epoch
    || envelope.signedInvocationSnapshot.roleId !== authority.signedInvocationRoleId
    || envelope.signedInvocationSnapshot.audienceHash !== authority.expectedAudienceHash) {
    throw new TypeError("predicate query/snapshot/invocation material does not exact-join qualification authority");
  }
  if (hashObserverSigningKeySetRoot(envelope.observerSigningKeys.map(value => value.keyId)) !== qualification.registry.observerKeySetRoot
    || hashRevokedObserverKeyIdsRoot(envelope.revokedObserverKeyIds) !== qualification.registry.revokedObserverKeyIdsRoot) {
    throw new TypeError("predicate observer key material does not exact-join the qualification registry");
  }
  const invocationKeys = envelope.observerSigningKeys.filter(
    value => value.keyId === envelope.signedInvocationSnapshot.keyId,
  );
  if (invocationKeys.length !== 1
    || invocationKeys[0]!.observerQualificationId !== envelope.signedInvocationSnapshot.observerQualificationId
    || invocationKeys[0]!.roleId !== envelope.signedInvocationSnapshot.roleId
    || invocationKeys[0]!.audienceHash !== envelope.signedInvocationSnapshot.audienceHash
    || envelope.revokedObserverKeyIds.includes(invocationKeys[0]!.keyId)
    || !qualification.observerCertificates.some(
      value => value.certificateId === invocationKeys[0]!.observerQualificationId,
    )) {
    throw new TypeError("predicate signed invocation does not exact-join one current observer key and certificate");
  }
  const registryFacts: RegistryMembershipFactsV1 = Object.freeze({
    trustedIssuerIds: Object.freeze([...qualification.registryFacts.trustedIssuerIds]),
    certificateMemberships: Object.freeze([...qualification.registryFacts.certificateMemberships]),
    revokedCertificateIds: Object.freeze([...qualification.registryFacts.revokedCertificateIds]),
    observerSigningKeys: envelope.observerSigningKeys,
    revokedObserverKeyIds: envelope.revokedObserverKeyIds,
  });
  const predicateFacts = Object.freeze([...material.predicateFacts]);
  return Object.freeze({
    query: envelope.query,
    snapshot: envelope.snapshot,
    registry: qualification.registry,
    registryFacts,
    externalQualification: qualification.evidence,
    verifierCertificate: qualification.verifierCertificate,
    observerCertificates: qualification.observerCertificates,
    artifactRefs: material.artifactRefs,
    resolverPolicies: material.resolverPolicies,
    retentionLeases: material.retentionLeases,
    artifactClaims: material.artifactClaims,
    observations: envelope.observations,
    sidecarObservations: envelope.sidecarObservations,
    signedInvocationSnapshot: envelope.signedInvocationSnapshot,
    predicateFacts,
  });
}

function invalidMaterial(predicateId: string, error: unknown): InstalledMaterialV1 {
  return Object.freeze({
    status: "invalid",
    evidenceRoot: hashDomain("aloha/qualified-release-runner/material-invalid/v1", {
      predicateId,
      message: error instanceof Error ? error.message : "invalid-common-envelope-material",
    }),
  });
}

/**
 * Deployment/release owner.  It verifies the signed runtime binding and the
 * exact generated V3 denominator before issuing a process-local runner.  It
 * owns no signer and accepts neither GateCoreInput nor an evaluator/verdict
 * callback.
 */
export function installQualifiedReleaseAcceptanceRunnerV1(
  input: InstallQualifiedReleaseAcceptanceRunnerInputV1,
): QualifiedReleaseAcceptanceRunnerCapabilityV1 {
  assertPlainObject(input, "qualifiedReleaseAcceptanceRunner");
  assertExactKeys(input, [
    "runtimeBinding",
    "runtimeSignerPin",
    "externalQualifications",
    "predicateMaterials",
  ], "qualifiedReleaseAcceptanceRunner");
  const runtimeBindingValue = readOwnEnumerableDataProperty(
    input,
    "runtimeBinding",
    "qualifiedReleaseAcceptanceRunner",
  ) as RuntimeReleaseBindingV1;
  const runtimeSignerPin = readOwnEnumerableDataProperty(
    input,
    "runtimeSignerPin",
    "qualifiedReleaseAcceptanceRunner",
  ) as RuntimeReleaseSignerPinV1;
  const externalQualificationValues = readOwnEnumerableDataProperty(
    input,
    "externalQualifications",
    "qualifiedReleaseAcceptanceRunner",
  ) as readonly VerifyExternalQualificationInputV2[];
  const predicateMaterialValues = readOwnEnumerableDataProperty(
    input,
    "predicateMaterials",
    "qualifiedReleaseAcceptanceRunner",
  ) as readonly QualifiedPredicateCommonEnvelopeMaterialV1[];
  const externalQualificationItems = copyExactInputArray(
    externalQualificationValues,
    "qualifiedReleaseAcceptanceRunner.externalQualifications",
  );
  const predicateMaterialItems = copyExactInputArray(
    predicateMaterialValues,
    "qualifiedReleaseAcceptanceRunner.predicateMaterials",
  );
  preflightNestedArrays(externalQualificationItems, "qualifiedReleaseAcceptanceRunner.externalQualifications");
  preflightNestedArrays(predicateMaterialItems, "qualifiedReleaseAcceptanceRunner.predicateMaterials");
  const runtimeBinding = verifyRuntimeReleaseBindingSignatureV1(
    decodeRuntimeReleaseBindingV1(runtimeBindingValue),
    runtimeSignerPin,
  );
  const externalQualifications = Object.freeze(
    canonicalClone(externalQualificationItems) as readonly VerifyExternalQualificationInputV2[],
  );
  const denominator = verifyReleaseRequirementDenominatorV1(externalQualifications);
  assertRuntimeBindingJoinsReleaseApprovalV1(runtimeBinding, denominator.approval);
  const qualificationByPredicate = new Map<string, VerifyExternalQualificationInputV2>();
  for (const qualification of externalQualifications) {
    qualificationByPredicate.set(qualification.release.predicateId, qualification);
  }
  const materialByPredicate = new Map<string, InstalledMaterialV1>();
  const predicateMaterials = canonicalClone(predicateMaterialItems) as readonly QualifiedPredicateCommonEnvelopeMaterialV1[];
  for (const raw of predicateMaterials) {
    if (typeof raw?.predicateId !== "string" || !qualificationByPredicate.has(raw.predicateId)) {
      throw new TypeError("predicate CommonEnvelope material is outside the signed release denominator");
    }
    if (materialByPredicate.has(raw.predicateId)) {
      throw new TypeError("predicate CommonEnvelope material denominator contains a duplicate");
    }
    try {
      materialByPredicate.set(raw.predicateId, Object.freeze({
        status: "available",
        value: normalizePredicateMaterial(raw),
      }));
    } catch (error) {
      materialByPredicate.set(raw.predicateId, invalidMaterial(raw.predicateId, error));
    }
  }
  let state: RunnerStateV1;
  const authority = issueCommonEnvelopeAuthorityPortV1(async (
    binding: PredicateCompositionBindingV1,
    ownerMaterial: PredicateDomainMaterialV1,
  ): Promise<CommonEnvelopeAssemblyStateV1> => {
    const installed = state.materialByPredicate.get(binding.predicateId);
    if (installed === undefined) {
      return Object.freeze({
        status: "missing",
        code: "common-envelope-material-missing",
        evidenceRoot: hashDomain("aloha/qualified-release-runner/material-missing/v1", binding.predicateId),
      });
    }
    if (installed.status === "invalid") {
      return Object.freeze({
        status: "invalid",
        code: "common-envelope-material-invalid",
        evidenceRoot: installed.evidenceRoot,
      });
    }
    try {
      const qualification = state.qualificationByPredicate.get(binding.predicateId);
      if (qualification === undefined) throw new TypeError("predicate external qualification is missing");
      const gateAuthority = buildAuthority(state, binding, installed.value);
      return Object.freeze({
        status: "available",
        authority: gateAuthority,
        input: inputFor(qualification, installed.value, ownerMaterial, gateAuthority),
        nowUnixNs: readDeploymentReleaseClockUnixNsV1(state.clock, state.runtimeBinding.bindingId),
      });
    } catch (error) {
      return Object.freeze({
        status: "invalid",
        code: "common-envelope-material-invalid",
        evidenceRoot: hashDomain("aloha/qualified-release-runner/assembly-invalid/v1", {
          predicateId: binding.predicateId,
          message: error instanceof Error ? error.message : "invalid-common-envelope-assembly",
        }),
      });
    }
  });
  state = Object.freeze({
    runtimeBinding,
    externalQualifications,
    qualificationByPredicate,
    materialByPredicate,
    clock: issueDeploymentReleaseClockV1(runtimeBinding.bindingId),
    authority,
  });
  const capability = Object.freeze(Object.create(null)) as object;
  runners.set(capability, state);
  return capability;
}

/** Evaluate the exact generated predicate denominator without crossing the
 * prepared-acceptance bridge. This is the only runner entry used by
 * pre-release advisory observation; even an all-pass result cannot mint a
 * release, runtime, signing, submission, or publication capability. */
export async function observeQualifiedReleaseAcceptanceAdvisoryV1(
  capability: QualifiedReleaseAcceptanceRunnerCapabilityV1,
  source: PredicateMaterialSourcePortV1,
): Promise<QualifiedReleaseAcceptanceAdvisoryRunV1> {
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("qualified release acceptance runner capability is invalid");
  }
  const state = runners.get(capability);
  if (state === undefined) {
    throw new TypeError("qualified release acceptance runner capability was not deployment-owner-issued");
  }
  const assembled = await assembleReleaseGateInvocations(state.authority, source);
  return Object.freeze({ evaluations: evaluateAssembledReleaseGateInvocations(assembled) });
}

/** External-release path for the same generated denominator. It returns only
 * certificates and signer bytes; it owns no signer or package authority. */
export async function prepareQualifiedReleaseAcceptanceV1(
  capability: QualifiedReleaseAcceptanceRunnerCapabilityV1,
  source: PredicateMaterialSourcePortV1,
): Promise<QualifiedReleaseAcceptancePreparedRunV1> {
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("qualified release acceptance runner capability is invalid");
  }
  const state = runners.get(capability);
  if (state === undefined) {
    throw new TypeError("qualified release acceptance runner capability was not deployment-owner-issued");
  }
  const assembled = await assembleReleaseGateInvocations(state.authority, source);
  const evaluations = evaluateAssembledReleaseGateInvocations(assembled);
  if (!evaluations.every(evaluation => evaluation.status === "evaluated" && evaluation.verdict === "pass")) {
    throw new TypeError("assembled GateCore denominator did not pass");
  }
  const results = readAssembledReleaseAcceptanceResultsV1(assembled);
  return Object.freeze({
    evaluations,
    preparedAcceptance: prepareReleaseAcceptanceV1({
      runtimeBinding: state.runtimeBinding,
      externalQualifications: state.externalQualifications,
      acceptanceCertificates: results.map(result => result.certificate),
    }),
  });
}
