import {
  assertHash,
  hashDomain,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  assertGeneratedFamilyRuntimeFactory,
  issueGeneratedFamilyRuntimeAuthorityCapability,
  issueGeneratedUnsignedDryRunFamilyRuntimeAuthorityCapability,
  readGeneratedFamilyRuntimeFactoryMetadata,
  type GeneratedFamilyRuntimeFactoryV1,
  type GeneratedFamilyRuntimeAuthorityCapabilityV1,
} from "../../../../packages/family-composition/src/internal/generated-runtime-composition.ts";
import {
  generatedFamilyCoarseProjectionDescriptorV1,
  type GeneratedFamilyRuntimeAuthorityBindingV1,
  type GeneratedFamilyRuntimeFamilyV1,
} from "../../../../packages/family-composition/src/index.ts";
import {
  installGeneratedFamilyCoarseProjectionOwnerV1,
  readGeneratedFamilyCoarseProjectionCapabilityV1,
} from "../../../../packages/family-composition/src/internal/coarse-runtime-owner.ts";
import { issueCoarseProjectionServiceV1 } from "../../../../packages/coarse-economics/src/internal/owner.ts";
import { issueQualifiedCoarseProjectionOwnerCapabilityV1 } from "../../../../packages/coarse-economics/src/internal/qualification-owner.ts";
import type { CoarseProjectionCapabilityV1 } from "../../../../packages/coarse-economics/src/index.ts";
import type { FamilyRuntimeAuthorityBindingV1 } from "../../../../packages/family-sdk/runtime/index.ts";
import type { FamilyFrozenProgramExecutionPort } from "../../../../packages/work-plane/src/index.ts";
import {
  assertIssuedFamilyFrozenProgramExecutionPort,
  createFamilyRuntimeStageExecutors,
  readIssuedFamilyFrozenProgramExecutionBinding,
} from "../../../../packages/work-plane/src/internal/family-execution-port.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import { assertActiveRuntimeReleaseAuthorityState } from "./state.ts";
import { runtimeReleaseBindingProvenanceHash } from "../../../../specs/release-authority/src/index.ts";
import { readActiveSignedRuntimeAuthorityDescriptorV1 } from "./runtime-authority-descriptor-owner.ts";
import {
  decodeUnsignedDryRunRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
  type UnsignedDryRunRuntimeAuthorityDescriptorV1,
} from "../../../../packages/runtime-authority/src/index.ts";

/**
 * The Family runtime owner has one physical execution edge. The old
 * deployment-owned authority array and five callback surface deliberately do
 * not exist: release metadata and the single frozen-program execution port
 * are the only inputs from which the five stage executors are derived.
 */
export type RuntimeReleaseFamilyRuntimeDeploymentPortV1 = never;

function familyProgramAuthorityHash(
  release: ReturnType<typeof assertActiveRuntimeReleaseAuthorityState>["binding"],
  metadata: ReturnType<typeof readGeneratedFamilyRuntimeFactoryMetadata>,
  family: ReturnType<typeof readGeneratedFamilyRuntimeFactoryMetadata>["families"][number],
): Hash {
  return hashDomain("aloha/family-runtime-program-authority/v2", {
    signedRuntimeBinding: {
      bindingId: release.bindingId,
      releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(release),
      releaseAuthorityRoot: release.releaseAuthorityRoot,
      executorAuthorityRoot: release.executorAuthorityRoot,
      workerEpoch: release.workerEpoch,
      executorSessionHash: release.executorSessionHash,
      qualifiedCapabilityRefsRoot: release.qualifiedCapabilityRefsRoot,
      nominationProgramSetRoot: release.nominationProgramSetRoot,
      nominationQualificationSetRoot: release.nominationQualificationSetRoot,
    },
    generatedFactory: {
      proposedCapabilitySetRoot: metadata.proposedCapabilitySetRoot,
      nominationProgramSetRoot: metadata.nominationProgramSetRoot,
      releaseIntentRoot: metadata.releaseIntentRoot,
      definitionCatalogRoot: metadata.definitionCatalogRoot,
      descriptorRoot: metadata.descriptorRoot,
      familyId: family.familyId,
      familyDefinitionHash: family.familyDefinitionHash,
      stageDefinitionRoot: family.stageDefinitionRoot,
    },
  });
}

function deriveAuthorityBindings(
  release: ReturnType<typeof assertActiveRuntimeReleaseAuthorityState>["binding"],
  factory: GeneratedFamilyRuntimeFactoryV1,
  execution: FamilyFrozenProgramExecutionPort<unknown>,
): readonly GeneratedFamilyRuntimeAuthorityBindingV1[] {
  const metadata = readGeneratedFamilyRuntimeFactoryMetadata(factory);
  const executors = createFamilyRuntimeStageExecutors({ execution });
  if (executors.length !== 5) throw new TypeError("Family runtime stage executor derivation is incomplete");
  return Object.freeze(metadata.families.map((family) => {
    const binding: FamilyRuntimeAuthorityBindingV1 = Object.freeze({
      familyId: family.familyId as FamilyRuntimeAuthorityBindingV1["familyId"],
      familyDefinitionHash: family.familyDefinitionHash,
      releaseAuthorityRoot: release.releaseAuthorityRoot,
      programAuthorityHash: familyProgramAuthorityHash(release, metadata, family),
      executorAuthorityRoot: release.executorAuthorityRoot,
      workerEpoch: release.workerEpoch,
      executorSessionHash: release.executorSessionHash,
    });
    return Object.freeze({
      familyDefinitionHash: family.familyDefinitionHash,
      definitionBindingRoot: family.stageDefinitionRoot,
      binding,
      executors,
    });
  }));
}

function deriveUnsignedDryRunAuthorityBindings(
  runtimeAuthorityValue: UnsignedDryRunRuntimeAuthorityDescriptorV1,
  factory: GeneratedFamilyRuntimeFactoryV1,
  execution: FamilyFrozenProgramExecutionPort<unknown>,
): readonly GeneratedFamilyRuntimeAuthorityBindingV1[] {
  const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(
    decodeUnsignedDryRunRuntimeAuthorityDescriptorV1(runtimeAuthorityValue),
  );
  const metadata = readGeneratedFamilyRuntimeFactoryMetadata(factory);
  const executionBinding = readIssuedFamilyFrozenProgramExecutionBinding(execution);
  const executors = createFamilyRuntimeStageExecutors({ execution });
  if (executors.length !== 5) throw new TypeError("Family runtime stage executor derivation is incomplete");
  return Object.freeze(metadata.families.map(family => {
    const binding: FamilyRuntimeAuthorityBindingV1 = Object.freeze({
      familyId: family.familyId as FamilyRuntimeAuthorityBindingV1["familyId"],
      familyDefinitionHash: family.familyDefinitionHash,
      releaseAuthorityRoot: runtimeAuthority.authorityBindingHash,
      programAuthorityHash: hashDomain("aloha/family-runtime-unsigned-dry-run-program-authority/v1", {
        runtimeAuthority,
        proposedCapabilitySetRoot: metadata.proposedCapabilitySetRoot,
        nominationProgramSetRoot: metadata.nominationProgramSetRoot,
        descriptorRoot: metadata.descriptorRoot,
        familyId: family.familyId,
        familyDefinitionHash: family.familyDefinitionHash,
        stageDefinitionRoot: family.stageDefinitionRoot,
        sourcePlanRoot: family.sourcePlanRoot,
        executorAuthorityRoot: executionBinding.authorityRoot,
        workerEpoch: executionBinding.workerEpoch,
        executorSessionHash: executionBinding.executorSession,
      }),
      executorAuthorityRoot: assertHash(executionBinding.authorityRoot, "unsignedFamilyRuntime.executorAuthorityRoot"),
      workerEpoch: executionBinding.workerEpoch,
      executorSessionHash: assertHash(executionBinding.executorSession, "unsignedFamilyRuntime.executorSessionHash"),
    });
    return Object.freeze({
      familyDefinitionHash: family.familyDefinitionHash,
      definitionBindingRoot: family.stageDefinitionRoot,
      binding,
      executors,
    });
  }));
}

/**
 * Join verified release material, generated descriptor metadata, and the one
 * owner-issued work-plane port. All roots are derived here; callers cannot
 * provide a Family binding, program authority hash, executor list, or stage
 * callback. The generated capability remains fenced on rotation/revoke.
 */
export function issueRuntimeReleaseFamilyRuntimeAuthorityCapability(
  authorityValue: unknown,
  executionValue: unknown,
  generatedFactoryValue: unknown,
): GeneratedFamilyRuntimeAuthorityCapabilityV1 {
  const authority = authorityValue as RuntimeReleaseAuthorityV1;
  const state = assertActiveRuntimeReleaseAuthorityState(authorityValue);
  assertGeneratedFamilyRuntimeFactory(generatedFactoryValue);
  assertIssuedFamilyFrozenProgramExecutionPort(executionValue);
  const executionBinding = readIssuedFamilyFrozenProgramExecutionBinding(executionValue);
  if (
    executionBinding.authorityRoot !== state.binding.executorAuthorityRoot
    || executionBinding.workerEpoch !== state.binding.workerEpoch
    || executionBinding.executorSession !== state.binding.executorSessionHash
  ) {
    throw new TypeError("Family execution port is not bound to the signed runtime executor");
  }
  const factory = generatedFactoryValue as GeneratedFamilyRuntimeFactoryV1;
  const metadata = readGeneratedFamilyRuntimeFactoryMetadata(factory);
  assertHash(metadata.proposedCapabilitySetRoot, "generatedFamilyRuntime.proposedCapabilitySetRoot");
  if (metadata.proposedCapabilitySetRoot !== state.binding.qualifiedCapabilityRefsRoot) {
    throw new TypeError("generated Family runtime factory is not bound to the signed capability set");
  }
  if (metadata.nominationProgramSetRoot !== state.binding.nominationProgramSetRoot) {
    throw new TypeError("generated Family runtime factory is not bound to the signed nomination program set");
  }
  const authorities = deriveAuthorityBindings(
    state.binding,
    factory,
    executionValue as FamilyFrozenProgramExecutionPort<unknown>,
  );
  const version = state.version;
  const assertCurrent = (): void => {
    const current = assertActiveRuntimeReleaseAuthorityState(authority);
    if (current.version !== version || current.binding.bindingId !== state.binding.bindingId) {
      throw new TypeError("generated Family runtime authority stale after runtime release rotation");
    }
  };
  const capability = issueGeneratedFamilyRuntimeAuthorityCapability({
    factory,
    runtimeAuthority: readActiveSignedRuntimeAuthorityDescriptorV1(authority),
    qualifiedCapabilityRefsRoot: state.binding.qualifiedCapabilityRefsRoot,
    nominationProgramSetRoot: state.binding.nominationProgramSetRoot,
    nominationQualifications: state.binding.nominationQualificationSet.entries.map(entry => ({
      proposalLeafDigest: entry.proposalLeafDigest,
      qualificationLeafDigest: entry.qualificationLeafDigest,
    })),
    authorities,
    assertCurrent,
  });
  const composition = factory(capability);
  const releaseProvenanceHash = runtimeReleaseBindingProvenanceHash(state.binding);
  for (const family of metadata.families) {
    const descriptor = generatedFamilyCoarseProjectionDescriptorV1({
      entry: {
        familyId: family.familyId,
        familyDefinitionHash: family.familyDefinitionHash,
      },
      extensions: family.extensions,
      runtimeAdapters: family.runtimeAdapters,
    } as GeneratedFamilyRuntimeFamilyV1);
    if (descriptor === null) continue;
    const owner = issueQualifiedCoarseProjectionOwnerCapabilityV1({
      releaseProvenanceHash,
      releaseMembershipRoot: state.binding.qualifiedCapabilityRefsRoot,
      descriptor: descriptor.ownerDescriptor,
      port: Object.freeze({
        read: (projectionCapability: CoarseProjectionCapabilityV1) => readGeneratedFamilyCoarseProjectionCapabilityV1(composition, projectionCapability),
        verifyConservativeBound: () => {
          throw new TypeError("generated Family coarse hard-prune verifier is not qualified");
        },
      }),
    });
    const service = issueCoarseProjectionServiceV1({ owner });
    installGeneratedFamilyCoarseProjectionOwnerV1(composition, {
      familyDefinitionHash: family.familyDefinitionHash,
      ownerDescriptor: descriptor.ownerDescriptor,
      service,
      releaseProvenanceHash,
      releaseMembershipRoot: state.binding.qualifiedCapabilityRefsRoot,
      assertCurrent,
    });
  }
  return capability;
}

export interface UnsignedDryRunFamilyRuntimeAuthorityInputV1 {
  readonly runtimeAuthority: UnsignedDryRunRuntimeAuthorityDescriptorV1;
  readonly execution: FamilyFrozenProgramExecutionPort<unknown>;
  readonly factory: GeneratedFamilyRuntimeFactoryV1;
  readonly assertCurrent: () => void;
}

/** Unsigned bootstrap adapter into the same generated Family factory. It
 * binds declarations and executable metadata only; it never accepts a
 * qualification leaf, release approval, or signer fact. */
export function issueUnsignedDryRunFamilyRuntimeAuthorityCapability(
  input: UnsignedDryRunFamilyRuntimeAuthorityInputV1,
): GeneratedFamilyRuntimeAuthorityCapabilityV1 {
  if (input === null || typeof input !== "object" || typeof input.assertCurrent !== "function") {
    throw new TypeError("unsigned dry-run Family runtime authority is unavailable");
  }
  assertGeneratedFamilyRuntimeFactory(input.factory);
  assertIssuedFamilyFrozenProgramExecutionPort(input.execution);
  const runtimeAuthority = decodeUnsignedDryRunRuntimeAuthorityDescriptorV1(input.runtimeAuthority);
  const metadata = readGeneratedFamilyRuntimeFactoryMetadata(input.factory);
  input.assertCurrent();
  const capability = issueGeneratedUnsignedDryRunFamilyRuntimeAuthorityCapability({
    factory: input.factory,
    runtimeAuthority,
    declaredCapabilitySetRoot: metadata.proposedCapabilitySetRoot,
    nominationProgramSetRoot: metadata.nominationProgramSetRoot,
    authorities: deriveUnsignedDryRunAuthorityBindings(runtimeAuthority, input.factory, input.execution),
    assertCurrent: input.assertCurrent,
  });
  input.factory(capability);
  return capability;
}
