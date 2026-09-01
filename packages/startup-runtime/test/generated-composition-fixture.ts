import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  nominationProgramProposalLeafDigest,
  nominationProgramRoot,
  nominationProgramSetRoot,
  sourcePlanLeafDigest,
  type GeneratedFamilyRuntimeDescriptorV1,
} from "../../family-composition/src/index.ts";
import {
  createGeneratedFamilyRuntimeFactory,
  issueGeneratedFamilyRuntimeAuthorityCapability,
  issueGeneratedFamilySearchRuntimePort,
} from "../../family-composition/src/internal/generated-runtime-composition.ts";
import type {
  FamilySourcePlanNominationProgramV1,
  FamilyStageDefinitionV1,
  RuntimeStageExecutorV1,
} from "../../family-sdk/runtime/index.ts";
import type { GeneratedFamilyEntryV1, StageCapabilityRefV1 } from "../../family-sdk/runtime-refs/index.ts";
import { asCapabilityId, asCapabilityVersion, asOwnerRef, asSchemaRef } from "../../capability-contracts/src/index.ts";
import { asFamilyId } from "../../family-sdk/runtime-refs/index.ts";
import type { RuntimeAuthorityDescriptorV1 } from "../../runtime-authority/src/index.ts";

const h = (value: string): Hash => hashDomain("test/startup-runtime", value);

/** Real generated-composition owner used by cross-package runtime tests. */
export function generatedCompositionFixture(input: Readonly<{
  readonly familyId?: string;
  readonly familyDefinitionHash?: Hash;
  readonly runtimeAuthority: RuntimeAuthorityDescriptorV1;
}>) {
  const familyId = asFamilyId(input.familyId ?? "startup-test-family");
  const familyDefinitionHash = input.familyDefinitionHash ?? h("startup-family-definition");
  const stages = (["nomination", "identity", "materialization", "projection", "rehydration"] as const).map((stage, index) => ({
    stage,
    modulePath: `test/startup/${stage}.ts`,
    exportName: `${stage}Definition`,
    closureRoot: h(`startup-stage-closure:${stage}`),
    stageRef: {
      familyId,
      familyDefinitionHash,
      stage,
      capabilityId: asCapabilityId(`startup.${stage}`),
      version: asCapabilityVersion("1.0.0"),
      schemaHash: asSchemaRef(h(`startup-schema:${index}`)),
      interpreterHash: h(`startup-interpreter:${index}`),
      ownerRef: asOwnerRef(h(`startup-owner:${index}`)),
    } satisfies StageCapabilityRefV1,
  })).sort((left, right) => left.stage.localeCompare(right.stage));
  const lifecycleRefs = Object.fromEntries(stages.map(stage => [stage.stage, stage.stageRef])) as GeneratedFamilyEntryV1["lifecycleRefs"];
  const sourcePlanRef = Object.freeze({
    ownerRef: h("startup-source-plan-owner"),
    sourcePlanRef: h("startup-source-plan-ref"),
    familyDefinitionHash,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  });
  const entry: GeneratedFamilyEntryV1 = {
    familyId,
    familyDefinitionHash,
    issuerRef: asOwnerRef(h("startup-issuer")),
    authorityRef: h("startup-authority") as GeneratedFamilyEntryV1["authorityRef"],
    lifecycleRefs,
    extensionRefs: [],
    actionOwnerRefs: [],
    factContractRefs: [],
    sourcePlanRefs: [sourcePlanRef],
    definitionCatalogLeafDigest: h("startup-leaf"),
    capabilityCatalogRoot: h("startup-capabilities"),
  };
  const stageDefinitionRoot = hashDomain("aloha/family-runtime-definition-set/v1", stages.map(stage => ({
    stage: stage.stage,
    modulePath: stage.modulePath,
    exportName: stage.exportName,
    closureRoot: stage.closureRoot,
    stageRef: stage.stageRef,
  })));
  const sourcePlanDescriptorBase = {
    sourcePlanId: "startup-test-family.fixed-cutoff-50-block",
    modulePath: "test/startup/source-plan.ts",
    exportName: "STARTUP_SOURCE_PLAN",
    closureRoot: h("startup-source-plan-closure"),
    schemaHash: h("startup-source-plan-schema"),
    planRef: sourcePlanRef,
  };
  const sourcePlanDescriptor = {
    ...sourcePlanDescriptorBase,
    leafDigest: sourcePlanLeafDigest(sourcePlanDescriptorBase),
  };
  const nominationProposalBase = {
    program: { modulePath: "test/startup/nomination-program.ts", exportName: "STARTUP_NOMINATION_PROGRAM", closureRoot: h("startup-nomination-program-closure"), schemaHash: sourcePlanDescriptor.schemaHash },
    mutationCorpus: { modulePath: "test/startup/nomination-mutations.ts", exportName: "STARTUP_NOMINATION_MUTATIONS", closureRoot: h("startup-nomination-mutations-closure") },
    independentOracle: { modulePath: "test/startup/nomination-oracle.ts", exportName: "STARTUP_NOMINATION_ORACLE", closureRoot: h("startup-nomination-oracle-closure") },
  };
  const nominationProposalWithoutLeaf = { ...nominationProposalBase, nominationProgramRoot: nominationProgramRoot(nominationProposalBase) };
  const nominationProgramProposal = { ...nominationProposalWithoutLeaf, proposalLeafDigest: nominationProgramProposalLeafDigest(sourcePlanDescriptor.leafDigest, nominationProposalWithoutLeaf) };
  const descriptorWithoutRoot = {
    schemaVersion: 1 as const,
    releaseIntentRoot: h("startup-release-intent"),
    definitionCatalogRoot: h("startup-family-catalog"),
    proposedCapabilitySetRoot: h("startup-proposed-capabilities"),
    nominationProgramSetRoot: nominationProgramSetRoot([nominationProgramProposal.proposalLeafDigest]),
    families: [{
      entry,
      publicEntry: { modulePath: "test/startup/public.ts", exportName: "PUBLIC_ENTRY", closureRoot: h("startup-public") },
      stages,
      extensions: [],
      actionOwners: [],
      sourcePlans: [{ ...sourcePlanDescriptor, nominationProgramProposal }],
      runtimeAdapters: [],
      runtimeAdapterRoot: hashDomain("aloha/family-runtime-adapter-set/v1", []),
      sourcePlanRoot: hashDomain("aloha/family-source-plan-set/v1", [sourcePlanDescriptor.leafDigest]),
      stageDefinitionRoot,
    }],
  };
  const descriptor: GeneratedFamilyRuntimeDescriptorV1 = {
    ...descriptorWithoutRoot,
    descriptorRoot: hashDomain("aloha/generated-family-runtime-descriptor/v1", descriptorWithoutRoot),
  };
  const definitions: readonly FamilyStageDefinitionV1[] = stages.map(stage => ({
    stage: stage.stage,
    capabilityId: stage.stageRef.capabilityId,
    version: stage.stageRef.version,
    schemaHash: stage.stageRef.schemaHash,
    payloadCodec: { schemaRef: stage.stageRef.schemaHash, decodeExact: (value: unknown) => value as never },
    dependencyIds: [],
    outputSchemaRef: h(`startup-output-schema:${stage.stage}`),
    implementationClosureHash: h(`startup-implementation:${stage.stage}`),
    outputCodecHash: h(`startup-output-codec:${stage.stage}`),
    outputCodec: { decodeExact: (value: unknown) => value as never },
    prepareIssueValue: () => ({}),
    interpret: () => ({ kind: "invalidProgram", code: "startup-test" }),
  }));
  const binding = {
    familyId,
    familyDefinitionHash,
    releaseAuthorityRoot: h("startup-release-authority"),
    programAuthorityHash: h("startup-program-authority"),
    executorAuthorityRoot: h("startup-executor-authority"),
    workerEpoch: "1",
    executorSessionHash: h("startup-executor-session"),
  };
  const executors: readonly { readonly stage: typeof stages[number]["stage"]; readonly executor: RuntimeStageExecutorV1 }[] = stages.map(stage => ({
    stage: stage.stage,
    executor: { async execute() { return []; } },
  }));
  const sourcePlan = Object.freeze({
    sourcePlanId: sourcePlanDescriptor.sourcePlanId,
    completeness: sourcePlanDescriptor.planRef.completeness,
    historyStartBlock: sourcePlanDescriptor.planRef.historyStartBlock,
    schemaHash: sourcePlanDescriptor.schemaHash,
    async execute() { throw new Error("startup source plan is not used"); },
  });
  const nominationProgram: FamilySourcePlanNominationProgramV1 = Object.freeze({
    kind: "aloha.family-source-plan-nomination-program",
    version: 1,
    schemaHash: nominationProgramProposal.program.schemaHash,
    async evaluate() { return Object.freeze([]); },
  });
  const authority = { familyDefinitionHash, definitionBindingRoot: stageDefinitionRoot, binding, executors };
  const factory = createGeneratedFamilyRuntimeFactory({
    descriptor,
    definitions: [definitions],
    extensions: [[]],
    actionOwners: [[]],
    runtimeAdapters: [[]],
    sourcePlans: [[sourcePlan]],
    nominationPrograms: [[nominationProgram]],
  });
  const capability = issueGeneratedFamilyRuntimeAuthorityCapability({
    factory,
    runtimeAuthority: input.runtimeAuthority,
    declaredCapabilitySetRoot: descriptor.proposedCapabilitySetRoot,
    nominationProgramSetRoot: descriptor.nominationProgramSetRoot,
    authorities: [authority],
    assertCurrent() {},
  });
  return Object.freeze({
    familyRuntime: factory(capability),
    familySearchRuntime: issueGeneratedFamilySearchRuntimePort(factory, capability),
  });
}
