import assert from "node:assert/strict";
import test from "node:test";
import { asCapabilityId, asCapabilityVersion, asOwnerRef, asSchemaRef } from "../../capability-contracts/src/index.ts";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { sourcePlanIdentity } from "../../discovery/src/index.ts";
import { asFamilyId, type StageCapabilityRefV1 } from "../../family-sdk/runtime-refs/index.ts";
import type {
  QualifiedExecutorAuthorityCapability,
  QualifiedExecutorAuthorityIssuer,
} from "../../scheduler/src/index.ts";
import { WorkScheduler } from "../../scheduler/src/index.ts";
import { issueQualifiedExecutorAuthorityIssuer } from "../../scheduler/src/internal/authority-owner.ts";
import { issueQualifiedSharedSchedulerRuntimePort } from "../../scheduler/src/internal/shared-runtime-owner.ts";
import {
  createSchedulerOwnedFamilyExecutionPort,
  issueQualifiedPhysicalExecutionPort,
} from "../../work-plane/src/internal/family-execution-port.ts";
import {
  readGeneratedFamilyRuntimeFactoryMetadata,
  readGeneratedFamilyRuntimeMembership,
  readGeneratedFamilySourcePlanDeclarations,
  readGeneratedFamilySourcePlanRuntimes,
} from "../../family-composition/src/internal/generated-runtime-composition.ts";
import {
  generatedFamilyCoarseProjectionDescriptorV1,
  runtimeAdapterLeafDigest,
  type GeneratedFamilyRuntimeFamilyV1,
} from "../../family-composition/src/index.ts";
import { readQualifiedCoarseProjectionV1 } from "../../coarse-economics/src/index.ts";
import { createReleaseFamilyRuntimeComposition } from "../../../generated/runtime-composition/index.ts";
import {
  issueRuntimeReleaseFamilyRuntimeAuthorityCapability,
  issueUnsignedDryRunFamilyRuntimeAuthorityCapability,
} from "../src/internal/family-runtime-owner.ts";
import {
  issueRuntimeReleaseNominationQualificationVerifier,
  issueUnsignedDryRunNominationProgramMembershipVerifier,
} from "../src/internal/nomination-qualification-owner.ts";
import { issueRuntimeReleaseCandidatePartitionProofIssuer } from "../src/internal/candidate-partition-proof-owner.ts";
import { issueCandidatePartitionProofIssuerPort } from "../../../specs/candidate-partition-authority/src/internal/issuer-owner.ts";
import type { CandidatePartitionProofIssuerPortV1 } from "../../../specs/candidate-partition-authority/src/index.ts";
import {
  runtimeReleaseBindingProvenanceHash,
  sealRuntimeReleaseNominationQualificationSetV1,
} from "../../../specs/release-authority/src/index.ts";
import {
  releaseApproval,
  runtimeAuthorityForReleaseApproval,
  rotateReleaseApproval,
} from "../../attestation/test/authority-fixture.ts";
import { createUnsignedDryRunRuntimeAuthorityDescriptorV1 } from "../../runtime-authority/src/index.ts";

const h = (value: string): Hash => hashDomain("test/family-runtime-owner", value);

type ReleaseBinding = ReturnType<ReturnType<typeof runtimeAuthorityForReleaseApproval>["resolver"]["resolve"]>;

function schedulerFor(binding: ReleaseBinding): {
  readonly issuer: QualifiedExecutorAuthorityIssuer;
  readonly capability: QualifiedExecutorAuthorityCapability;
} {
  const capability = Object.freeze(Object.create(null)) as QualifiedExecutorAuthorityCapability;
  const provenance = Object.freeze({
    authorityRoot: binding.executorAuthorityRoot,
    workerEpoch: binding.workerEpoch,
    executorSession: binding.executorSessionHash,
    version: 1,
  });
  const issuer = issueQualifiedExecutorAuthorityIssuer(Object.freeze({
    registryRoot: binding.qualifiedExecutorRegistryRoot,
    authorityRoot: binding.executorAuthorityRoot,
    open: () => capability,
    rotate: () => capability,
    revoke: () => undefined,
    assert: (value: object) => {
      if (value !== capability) throw new TypeError("unknown executor capability");
      return provenance;
    },
    provenance: (value: object) => {
      if (value !== capability) throw new TypeError("unknown executor capability");
      return provenance;
    },
  }));
  return { issuer, capability };
}

function executionFor(binding: ReleaseBinding) {
  const scheduler = schedulerFor(binding);
  const schedulerRuntime = issueQualifiedSharedSchedulerRuntimePort({
    scheduler: new WorkScheduler(),
    issuer: scheduler.issuer,
    capability: scheduler.capability,
  });
  const physicalExecution = issueQualifiedPhysicalExecutionPort({
    ...scheduler,
    schedulerRuntime,
    execute: async () => Object.freeze({
      kind: "returned" as const,
      requestId: h("request"),
      dataHex: "0x01",
    }),
  });
  return createSchedulerOwnedFamilyExecutionPort({
    ...scheduler,
    physicalExecution,
  });
}

function release() {
  const metadata = readGeneratedFamilyRuntimeFactoryMetadata(createReleaseFamilyRuntimeComposition);
  const nominationQualificationSet = sealRuntimeReleaseNominationQualificationSetV1(
    metadata.nominationProgramProposalLeafDigests.map(proposalLeafDigest => ({
      proposalLeafDigest,
      criticalMutationCorpusRoot: h(`nomination-mutations:${proposalLeafDigest}`),
      independentOracleCaseRoot: h(`nomination-oracle:${proposalLeafDigest}`),
      qualificationSpecDigest: h(`nomination-spec:${proposalLeafDigest}`),
      verifierQualificationCertificateRoot: h(`nomination-certificate:${proposalLeafDigest}`),
    })),
  );
  const approval = releaseApproval(
    h("framework"),
    h("executor"),
    "epoch-family",
    h("executor-session"),
    h("release-authority"),
    metadata.proposedCapabilitySetRoot,
    "http://127.0.0.1:8545",
    nominationQualificationSet,
  );
  const authority = runtimeAuthorityForReleaseApproval(approval);
  return { approval, authority, binding: authority.resolver.resolve(authority.capability), metadata };
}

test("Family runtime authority is derived only from signed release, generated metadata, and one qualified execution port", async () => {
  const value = release();
  const execution = executionFor(value.binding);
  const capability = issueRuntimeReleaseFamilyRuntimeAuthorityCapability(
    value.authority,
    execution,
    createReleaseFamilyRuntimeComposition,
  );
  assert.deepEqual(Reflect.ownKeys(capability), []);
  const composition = createReleaseFamilyRuntimeComposition(capability);
  assert.equal(composition.entries.length, value.metadata.families.length);
  assert.equal("authorities" in composition, false);
  assert.equal("programAuthorityHash" in composition, false);
  const coarseFamily = value.metadata.families.find(family => family.runtimeAdapters.some(adapter => adapter.capabilityRefs.coarse !== undefined));
  assert.ok(coarseFamily, "generated release must contain a coarse-capable Family");
  const seam = composition.resolveCoarseProjection(coarseFamily.familyDefinitionHash);
  assert.ok(seam, "release owner must install the generated coarse seam");
  assert.deepEqual(Reflect.ownKeys(seam.producer), []);
  assert.deepEqual(Reflect.ownKeys(seam.service), []);
  await assert.rejects(
    () => composition.issueCoarseProjection({ ...seam.producer }, {} as never),
    /producer was not issued/,
  );
  assert.throws(
    () => readQualifiedCoarseProjectionV1({ service: { ...seam.service }, capability: {} }),
    /not owner-issued/,
  );

  assert.throws(
    () => createReleaseFamilyRuntimeComposition({ ...capability }),
    /authority is unavailable/,
  );
  assert.throws(
    () => issueRuntimeReleaseFamilyRuntimeAuthorityCapability(value.authority, { ...execution }, createReleaseFamilyRuntimeComposition),
    /not release-issued/,
  );

  rotateReleaseApproval(value.approval, { workerEpoch: "epoch-rotated" });
  assert.throws(() => createReleaseFamilyRuntimeComposition(capability), /stale|rotation/);
  await assert.rejects(
    () => composition.issueCoarseProjection(seam.producer, {} as never),
    /stale|rotation/,
  );
});

test("unsigned Family owner binds exact generated declarations without qualification facts", () => {
  const value = release();
  const runtimeAuthority = createUnsignedDryRunRuntimeAuthorityDescriptorV1({
    authorityClass: "unsigned-dry-run",
    runtimeBindingId: h("unsigned-runtime-binding"),
    implementationCommit: "b".repeat(40),
  });
  const capability = issueUnsignedDryRunFamilyRuntimeAuthorityCapability({
    runtimeAuthority,
    execution: executionFor(value.binding),
    factory: createReleaseFamilyRuntimeComposition,
    assertCurrent() {},
  });
  const membership = readGeneratedFamilyRuntimeMembership(createReleaseFamilyRuntimeComposition, capability);
  assert.equal(membership.runtimeAuthority.authorityClass, "unsigned-dry-run");
  assert.equal(Object.prototype.hasOwnProperty.call(membership, "releaseProvenanceHash"), false);
  const declarations = readGeneratedFamilySourcePlanDeclarations(
    createReleaseFamilyRuntimeComposition,
    capability,
  ).map(binding => Object.freeze({
    sourcePlanIdentity: sourcePlanIdentity(binding.sourcePlanRef),
    sourcePlanLeafDigest: binding.sourcePlanLeafDigest,
    nominationProgramRoot: binding.nominationProgramRoot,
    nominationProgramProposalLeafDigest: binding.nominationProgramProposalLeafDigest,
  }));
  const verifier = issueUnsignedDryRunNominationProgramMembershipVerifier(
    createReleaseFamilyRuntimeComposition,
    capability,
  );
  assert.doesNotThrow(() => verifier.assertDeclared(declarations));
  assert.throws(
    () => verifier.assertDeclared(declarations.map((binding, index) => index === 0
      ? { ...binding, qualificationLeafDigest: h("forbidden-qualification") } as never
      : binding)),
    /non-exact fields/,
  );
  assert.throws(
    () => issueRuntimeReleaseNominationQualificationVerifier(
      value.authority,
      createReleaseFamilyRuntimeComposition,
      capability,
    ),
    /qualification is unavailable in unsigned dry-run/,
  );
});

function isolationFamily(familyIdValue: string, coarse: boolean): GeneratedFamilyRuntimeFamilyV1 {
  const familyId = asFamilyId(familyIdValue);
  const familyDefinitionHash = h(`isolation-definition:${familyId}`);
  const lifecycleRefs = Object.fromEntries(
    (["nomination", "identity", "materialization", "projection", "rehydration"] as const).map(stage => [stage, Object.freeze({
      familyId,
      familyDefinitionHash,
      stage,
      capabilityId: asCapabilityId(`${familyId}.${stage}`),
      version: asCapabilityVersion("1.0.0"),
      schemaHash: asSchemaRef(h(`isolation-schema:${familyId}:${stage}`)),
      interpreterHash: h(`isolation-interpreter:${familyId}:${stage}`),
      ownerRef: asOwnerRef(h(`isolation-owner:${familyId}:${stage}`)),
    })]),
  ) as unknown as GeneratedFamilyRuntimeFamilyV1["entry"]["lifecycleRefs"];
  const coarseRef: StageCapabilityRefV1 = Object.freeze({
    familyId,
    familyDefinitionHash,
    stage: "capability",
    capabilityId: asCapabilityId(`${familyId}.coarse`),
    version: asCapabilityVersion("1.0.0"),
    schemaHash: asSchemaRef(h(`isolation-coarse-schema:${familyId}`)),
    interpreterHash: h(`isolation-coarse-interpreter:${familyId}`),
    ownerRef: asOwnerRef(h(`isolation-coarse-owner:${familyId}`)),
  });
  const extension = Object.freeze({
    modulePath: `families/${familyId}/src/coarse.ts`,
    exportName: `${familyId.toUpperCase().replaceAll("-", "_")}_COARSE_PORT`,
    closureRoot: h(`isolation-coarse-extension:${familyId}`),
    capabilityRef: coarseRef,
  });
  const adapterBase = Object.freeze({
    role: "search/v1",
    modulePath: `families/${familyId}/src/search-adapter.ts`,
    exportName: `${familyId.toUpperCase().replaceAll("-", "_")}_SEARCH_ADAPTER`,
    closureRoot: h(`isolation-coarse-adapter:${familyId}`),
    capabilityRefs: Object.freeze({ coarse: coarseRef }),
    actionOwnerRefs: Object.freeze({}),
  });
  const adapter = Object.freeze({ ...adapterBase, leafDigest: runtimeAdapterLeafDigest(adapterBase) });
  const extensions = coarse ? Object.freeze([extension]) : Object.freeze([]);
  const runtimeAdapters = coarse ? Object.freeze([adapter]) : Object.freeze([]);
  return Object.freeze({
    entry: Object.freeze({
      familyId,
      familyDefinitionHash,
      issuerRef: asOwnerRef(h(`isolation-issuer:${familyId}`)),
      authorityRef: h(`isolation-authority:${familyId}`) as GeneratedFamilyRuntimeFamilyV1["entry"]["authorityRef"],
      lifecycleRefs,
      extensionRefs: coarse ? Object.freeze([coarseRef]) : Object.freeze([]),
      actionOwnerRefs: Object.freeze([]),
      factContractRefs: Object.freeze([]),
      sourcePlanRefs: Object.freeze([]),
      definitionCatalogLeafDigest: h(`isolation-definition-leaf:${familyId}`),
      capabilityCatalogRoot: h(`isolation-capability-root:${familyId}`),
    }),
    publicEntry: Object.freeze({
      modulePath: `families/${familyId}/src/public.ts`,
      exportName: `${familyId.toUpperCase().replaceAll("-", "_")}_PUBLIC`,
      closureRoot: h(`isolation-public:${familyId}`),
    }),
    stages: Object.freeze([]),
    sourcePlans: Object.freeze([]),
    extensions,
    actionOwners: Object.freeze([]),
    runtimeAdapters,
    runtimeAdapterRoot: hashDomain("aloha/family-runtime-adapter-set/v1", runtimeAdapters.map(value => value.leafDigest)),
    sourcePlanRoot: hashDomain("aloha/family-source-plan-set/v1", []),
    stageDefinitionRoot: hashDomain("aloha/family-runtime-definition-set/v1", []),
  });
}

test("coarse owner qualification leaf inputs are isolated from unrelated Family membership", () => {
  const targetFamily = isolationFamily("target-coarse-family", true);
  const unrelatedFamily = isolationFamily("unrelated-family", false);
  const baseline = Object.freeze([targetFamily]);
  const expanded = Object.freeze([targetFamily, unrelatedFamily]);
  const baselineTarget = baseline.find(candidate => candidate.entry.familyDefinitionHash === targetFamily.entry.familyDefinitionHash);
  const expandedTarget = expanded.find(candidate => candidate.entry.familyDefinitionHash === targetFamily.entry.familyDefinitionHash);
  assert.ok(baselineTarget);
  assert.ok(expandedTarget);
  assert.equal(baseline.length, 1);
  assert.equal(expanded.length, 2);
  assert.ok(expanded.some(candidate => candidate.entry.familyDefinitionHash === unrelatedFamily.entry.familyDefinitionHash));

  const before = generatedFamilyCoarseProjectionDescriptorV1(baselineTarget);
  const after = generatedFamilyCoarseProjectionDescriptorV1(expandedTarget);
  assert.ok(before);
  assert.ok(after);
  assert.deepEqual(after.ownerDescriptor, before.ownerDescriptor);
  assert.equal(after.ownerDescriptor.implementationHash, before.ownerDescriptor.implementationHash);
});

test("nomination verifier exact-joins signed qualification leaves to generated source-plan and proposal bindings", () => {
  const value = release();
  const capability = issueRuntimeReleaseFamilyRuntimeAuthorityCapability(
    value.authority,
    executionFor(value.binding),
    createReleaseFamilyRuntimeComposition,
  );
  const verifier = issueRuntimeReleaseNominationQualificationVerifier(
    value.authority,
    createReleaseFamilyRuntimeComposition,
    capability,
  );
  assert.deepEqual(Reflect.ownKeys(verifier), ["assertQualified"]);
  const exact = readGeneratedFamilySourcePlanRuntimes(
    createReleaseFamilyRuntimeComposition,
    capability,
  ).map(binding => Object.freeze({
    sourcePlanIdentity: sourcePlanIdentity(binding.sourcePlanRef),
    sourcePlanLeafDigest: binding.sourcePlanLeafDigest,
    nominationProgramRoot: binding.nominationProgramRoot,
    nominationProgramProposalLeafDigest: binding.nominationProgramProposalLeafDigest,
    qualificationLeafDigest: binding.nominationQualificationLeafDigest,
  }));
  const projection = Object.freeze({
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(value.binding),
    releaseAuthorityRoot: value.binding.releaseAuthorityRoot,
    candidatePartitionProofIssuerKeyId: value.binding.candidatePartitionProofIssuerKeyId,
  });
  const implementation = issueCandidatePartitionProofIssuerPort(Object.freeze({
    currentRelease: () => projection,
    assertNominationQualificationsQualified: () => {
      throw new TypeError("deployment proof implementation must not qualify nominations");
    },
    issue: () => { throw new Error("test issuer not called"); },
    verify: () => { throw new Error("test verifier not called"); },
  }) as unknown as CandidatePartitionProofIssuerPortV1);
  const issuer = issueRuntimeReleaseCandidatePartitionProofIssuer(
    value.authority,
    implementation,
    verifier,
  );
  assert.doesNotThrow(() => issuer.assertNominationQualificationsQualified(exact));
  assert.throws(
    () => issuer.assertNominationQualificationsQualified(exact.slice(1)),
    /do not cover the generated source-plan set/,
  );

  for (const field of [
    "sourcePlanLeafDigest",
    "nominationProgramRoot",
    "nominationProgramProposalLeafDigest",
    "qualificationLeafDigest",
  ] as const) {
    assert.throws(
      () => issuer.assertNominationQualificationsQualified(exact.map((binding, index) =>
        index === 0 ? { ...binding, [field]: h(`mutated:${field}`) } : binding)),
      /not in the signed runtime release generated set/,
      field,
    );
  }
  assert.throws(
    () => issueRuntimeReleaseCandidatePartitionProofIssuer(value.authority, implementation, { ...verifier }),
    /not release-issued/,
  );
  rotateReleaseApproval(value.approval, { workerEpoch: "epoch-nomination-rotated" });
  assert.throws(() => issuer.assertNominationQualificationsQualified(exact), /stale|rotation/);
});

test("Family runtime owner rejects an execution port or generated capability set from another release", () => {
  const value = release();
  const foreignApproval = releaseApproval(
    h("foreign-framework"),
    h("foreign-executor"),
    "epoch-foreign",
    h("foreign-session"),
    h("foreign-release"),
    value.metadata.proposedCapabilitySetRoot,
  );
  const foreignAuthority = runtimeAuthorityForReleaseApproval(foreignApproval);
  const foreignBinding = foreignAuthority.resolver.resolve(foreignAuthority.capability);
  assert.throws(
    () => issueRuntimeReleaseFamilyRuntimeAuthorityCapability(
      value.authority,
      executionFor(foreignBinding),
      createReleaseFamilyRuntimeComposition,
    ),
    /not bound to the signed runtime executor/,
  );

  const wrongRootApproval = releaseApproval(
    h("wrong-root-framework"),
    h("wrong-root-executor"),
    "epoch-wrong-root",
    h("wrong-root-session"),
    h("wrong-root-release"),
    h("wrong-capability-root"),
  );
  const wrongRootAuthority = runtimeAuthorityForReleaseApproval(wrongRootApproval);
  const wrongRootBinding = wrongRootAuthority.resolver.resolve(wrongRootAuthority.capability);
  assert.throws(
    () => issueRuntimeReleaseFamilyRuntimeAuthorityCapability(
      wrongRootAuthority,
      executionFor(wrongRootBinding),
      createReleaseFamilyRuntimeComposition,
    ),
    /not bound to the signed capability set/,
  );

  const wrongNominationApproval = releaseApproval(
    h("wrong-nomination-framework"),
    h("wrong-nomination-executor"),
    "epoch-wrong-nomination",
    h("wrong-nomination-session"),
    h("wrong-nomination-release"),
    value.metadata.proposedCapabilitySetRoot,
  );
  const wrongNominationAuthority = runtimeAuthorityForReleaseApproval(wrongNominationApproval);
  const wrongNominationBinding = wrongNominationAuthority.resolver.resolve(wrongNominationAuthority.capability);
  assert.throws(
    () => issueRuntimeReleaseFamilyRuntimeAuthorityCapability(
      wrongNominationAuthority,
      executionFor(wrongNominationBinding),
      createReleaseFamilyRuntimeComposition,
    ),
    /not bound to the signed nomination program set/,
  );
});
