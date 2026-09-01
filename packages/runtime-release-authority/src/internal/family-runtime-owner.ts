import { assertHash, hashDomain } from "../../../canonical-codec/src/index.ts";
import {
  assertGeneratedFamilyRuntimeFactory,
  issueGeneratedFamilyRuntimeAuthorityCapability,
  readGeneratedFamilyRuntimeFactoryMetadata,
  type GeneratedFamilyRuntimeAuthorityCapabilityV1,
  type GeneratedFamilyRuntimeFactoryV1,
} from "../../../family-composition/src/internal/generated-runtime-composition.ts";
import {
  generatedFamilyCoarseProjectionDescriptorV1,
  type GeneratedFamilyRuntimeAuthorityBindingV1,
  type GeneratedFamilyRuntimeFamilyV1,
} from "../../../family-composition/src/index.ts";
import {
  installGeneratedFamilyCoarseProjectionOwnerV1,
  readGeneratedFamilyCoarseProjectionCapabilityV1,
} from "../../../family-composition/src/internal/coarse-runtime-owner.ts";
import { issueCoarseProjectionServiceV1 } from "../../../coarse-economics/src/internal/owner.ts";
import { issueQualifiedCoarseProjectionOwnerCapabilityV1 } from "../../../coarse-economics/src/internal/qualification-owner.ts";
import type { CoarseProjectionCapabilityV1 } from "../../../coarse-economics/src/index.ts";
import type { FamilyRuntimeAuthorityBindingV1 } from "../../../family-sdk/runtime/index.ts";
import type { FamilyFrozenProgramExecutionPort } from "../../../work-plane/src/index.ts";
import {
  assertIssuedFamilyFrozenProgramExecutionPort,
  createFamilyRuntimeStageExecutors,
  readIssuedFamilyFrozenProgramExecutionBinding,
} from "../../../work-plane/src/internal/family-execution-port.ts";
import {
  decodeRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
  type RuntimeAuthorityDescriptorV1,
} from "../../../runtime-authority/src/index.ts";

export interface FamilyRuntimeAuthorityInputV1 {
  readonly runtimeAuthority: RuntimeAuthorityDescriptorV1;
  readonly execution: FamilyFrozenProgramExecutionPort<unknown>;
  readonly factory: GeneratedFamilyRuntimeFactoryV1;
  readonly assertCurrent: () => void;
}

function deriveAuthorityBindings(
  runtimeAuthorityValue: RuntimeAuthorityDescriptorV1,
  factory: GeneratedFamilyRuntimeFactoryV1,
  execution: FamilyFrozenProgramExecutionPort<unknown>,
): readonly GeneratedFamilyRuntimeAuthorityBindingV1[] {
  const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(
    decodeRuntimeAuthorityDescriptorV1(runtimeAuthorityValue),
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
      programAuthorityHash: hashDomain("aloha/family-runtime-program-authority/v1", {
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
      executorAuthorityRoot: assertHash(executionBinding.authorityRoot, "familyRuntime.executorAuthorityRoot"),
      workerEpoch: executionBinding.workerEpoch,
      executorSessionHash: assertHash(executionBinding.executorSession, "familyRuntime.executorSessionHash"),
    });
    return Object.freeze({
      familyDefinitionHash: family.familyDefinitionHash,
      definitionBindingRoot: family.stageDefinitionRoot,
      binding,
      executors,
    });
  }));
}

/** Bind the exact generated Family set to the process runtime and one physical
 * execution port. No signer, release approval, or caller-supplied Family list
 * crosses this owner. */
export function issueFamilyRuntimeAuthorityCapability(
  input: FamilyRuntimeAuthorityInputV1,
): GeneratedFamilyRuntimeAuthorityCapabilityV1 {
  if (input === null || typeof input !== "object" || typeof input.assertCurrent !== "function") {
    throw new TypeError("Family runtime authority is unavailable");
  }
  assertGeneratedFamilyRuntimeFactory(input.factory);
  assertIssuedFamilyFrozenProgramExecutionPort(input.execution);
  const runtimeAuthority = decodeRuntimeAuthorityDescriptorV1(input.runtimeAuthority);
  const metadata = readGeneratedFamilyRuntimeFactoryMetadata(input.factory);
  input.assertCurrent();
  const capability = issueGeneratedFamilyRuntimeAuthorityCapability({
    factory: input.factory,
    runtimeAuthority,
    declaredCapabilitySetRoot: metadata.proposedCapabilitySetRoot,
    nominationProgramSetRoot: metadata.nominationProgramSetRoot,
    authorities: deriveAuthorityBindings(runtimeAuthority, input.factory, input.execution),
    assertCurrent: input.assertCurrent,
  });
  const composition = input.factory(capability);
  const runtimeMembershipRoot = hashDomain("aloha/family-runtime-membership-root/v1", {
    runtimeAuthority: projectRuntimeAuthorityDescriptorV1(runtimeAuthority),
    proposedCapabilitySetRoot: metadata.proposedCapabilitySetRoot,
    nominationProgramSetRoot: metadata.nominationProgramSetRoot,
    descriptorRoot: metadata.descriptorRoot,
  });
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
      releaseMembershipRoot: runtimeMembershipRoot,
      descriptor: descriptor.ownerDescriptor,
      port: Object.freeze({
        read: (projectionCapability: CoarseProjectionCapabilityV1) =>
          readGeneratedFamilyCoarseProjectionCapabilityV1(composition, projectionCapability),
        verifyConservativeBound: () => {
          throw new TypeError("generated Family coarse hard-prune verifier is unavailable");
        },
      }),
    });
    installGeneratedFamilyCoarseProjectionOwnerV1(composition, {
      familyDefinitionHash: family.familyDefinitionHash,
      ownerDescriptor: descriptor.ownerDescriptor,
      service: issueCoarseProjectionServiceV1({ owner }),
      releaseMembershipRoot: runtimeMembershipRoot,
      assertCurrent: input.assertCurrent,
    });
  }
  return capability;
}
