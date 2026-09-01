import assert from "node:assert/strict";
import test from "node:test";
import { asCapabilityId, asCapabilityVersion, asOwnerRef, asSchemaRef } from "../../capability-contracts/src/index.ts";
import { decodeCanonicalJson, encodeCanonicalJson, hashDomain, type CanonicalJson, type Hash } from "../../canonical-codec/src/index.ts";
import type {
  FamilyIssuedRouteHandleV1,
  FamilyRouteHandleBindingV1,
  FamilyRouteHandleIssuerPortV1,
  FamilyRuntimeOwnerV1,
  FamilyStageDefinitionV1,
  FamilySourcePlanNominationProgramV1,
  FamilyStageRuntimePortV1,
  RuntimeStageExecutorV1,
} from "../../family-sdk/runtime/index.ts";
import type { ProgramInterpretationDraftV1 } from "../../capability-interpreters/src/index.ts";
import { asFamilyId, type GeneratedFamilyEntryV1, type StageCapabilityRefV1 } from "../../family-sdk/runtime-refs/index.ts";
import {
  createFamilyRuntimeComposition,
  createGeneratedFamilyRuntimeComposition,
  assertGeneratedFamilyRuntimeFactory,
  nominationProgramRoot,
  nominationProgramProposalLeafDigest,
  nominationProgramSetRoot,
  generatedFamilyCoarseProjectionDescriptorV1,
  familyCoarseRouteOwnerRefV1,
  runtimeAdapterLeafDigest,
  sourcePlanLeafDigest,
  type GeneratedFamilyRuntimeDescriptorV1,
} from "../src/index.ts";
import {
  createGeneratedFamilyRuntimeFactory,
  issueGeneratedFamilyLifecycleRuntimePort,
  issueGeneratedUnsignedDryRunFamilyRuntimeAuthorityCapability,
  issueGeneratedFamilySearchRuntimePort,
  readGeneratedFamilyRuntimeAdapterFactories,
  readGeneratedFamilyRuntimeFactoryMetadata,
  readGeneratedFamilyRuntimeMembership,
  readGeneratedFamilySourcePlanDeclarations,
  readGeneratedFamilyLifecycleRuntimePort,
  readGeneratedFamilySearchRuntimePort,
} from "../src/internal/generated-runtime-composition.ts";
import {
  createUnsignedDryRunRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../runtime-authority/src/index.ts";
import {
  installGeneratedFamilyCoarseProjectionOwnerV1,
  readGeneratedFamilyCoarseProjectionCapabilityV1,
} from "../src/internal/coarse-runtime-owner.ts";
import { issueQualifiedCoarseProjectionOwnerCapabilityV1 } from "../../coarse-economics/src/internal/qualification-owner.ts";
import { issueCoarseProjectionServiceV1 } from "../../coarse-economics/src/internal/owner.ts";
import { issueCoarseRouteBindingV1 } from "../../coarse-economics/src/internal/search-owner.ts";
import { issueCoarseEdgeSweepBindingV1 } from "../../coarse-economics/src/internal/full-graph-sweep-owner.ts";
import { coarseEdgeSweepBindingRootV1, readQualifiedCoarseProjectionReceiptV1, readQualifiedCoarseProjectionV1 } from "../../coarse-economics/src/index.ts";
import {
  familySearchAmountHash,
  familySearchArtifactHash,
  familySearchPayloadHash,
  familySearchRouteBindingHash,
  type FamilySearchAdapterFactoryV1,
  type FamilySearchStateRequestV1,
  type FamilySearchCoarseRequestV1,
} from "../../family-sdk/search-runtime/index.ts";
import type { CoarseProjectionCapabilityV1 } from "../../coarse-economics/src/index.ts";

const h = (value: string): Hash => hashDomain("test/family-composition", value);
const familyId = asFamilyId("composition-family");
const familyDefinitionHash = h("definition");

function refs(): GeneratedFamilyEntryV1["lifecycleRefs"] {
  const values = (["nomination", "identity", "materialization", "projection", "rehydration"] as const)
    .map((stage, index): StageCapabilityRefV1 => ({
      familyId,
      familyDefinitionHash,
      stage,
      capabilityId: asCapabilityId("composition." + stage),
      version: asCapabilityVersion("1.0.0"),
      schemaHash: asSchemaRef(h("schema:" + index)),
      interpreterHash: h("interpreter:" + index),
      ownerRef: asOwnerRef(h("owner:" + index)),
    }));
  return {
    nomination: values[0]!,
    identity: values[1]!,
    materialization: values[2]!,
    projection: values[3]!,
    rehydration: values[4]!,
  };
}

function setup() {
  const lifecycleRefs = refs();
  const routeHandles: FamilyRouteHandleIssuerPortV1 = {
    issueRouteHandle(): FamilyIssuedRouteHandleV1 { return { opaque: Object.freeze({}) }; },
    resolveRouteHandle(): FamilyRouteHandleBindingV1 { throw new Error("unused"); },
    assertRouteHandleActive(): void {},
    rotate(): void {},
    revoke(): void {},
  };
  const owner: FamilyRuntimeOwnerV1 = {
    port: {
      getStage(stageRef) {
        return { stageRef } as unknown as FamilyStageRuntimePortV1;
      },
    },
    routeHandles,
    revoke(): void {},
    rotate(): void {},
  };
  const sourcePlan = Object.freeze({
    sourcePlanId: "composition-family.fixed-cutoff-50-block",
    completeness: "nomination-only" as const,
    historyStartBlock: null,
    schemaHash: h("source-plan-schema"),
    async execute() { throw new Error("source plan execution is not used"); },
  });
  const nominationProgram: FamilySourcePlanNominationProgramV1 = Object.freeze({
    kind: "aloha.family-source-plan-nomination-program",
    version: 1,
    schemaHash: h("nomination-program-schema"),
    async evaluate() { return Object.freeze([]); },
  });
  const sourcePlanRef = Object.freeze({
    ownerRef: h("source-plan-owner"),
    sourcePlanRef: h("source-plan-ref"),
    familyDefinitionHash,
    completeness: sourcePlan.completeness,
    historyStartBlock: sourcePlan.historyStartBlock,
  });
  const entry: GeneratedFamilyEntryV1 = {
    familyId,
    familyDefinitionHash,
    issuerRef: asOwnerRef(h("issuer")),
    authorityRef: h("authority") as GeneratedFamilyEntryV1["authorityRef"],
    lifecycleRefs,
    extensionRefs: [],
    actionOwnerRefs: [],
    factContractRefs: [],
    sourcePlanRefs: [sourcePlanRef],
    definitionCatalogLeafDigest: h("leaf"),
    capabilityCatalogRoot: h("capabilities"),
  };
  return {
    entry,
    sourcePlan,
    sourcePlanRef,
    owner,
    lifecycleRefs,
    nominationProgram,
    composition: createFamilyRuntimeComposition({
      definitionCatalogRoot: h("catalog"),
      bindings: [{ entry, owner }],
    }),
  };
}

test("composition binds exact generated lifecycle refs and keeps rehydration sessions opaque", () => {
  const composition = setup().composition;
  assert.equal(composition.resolve(familyDefinitionHash, familyId)?.familyId, familyId);
  assert.equal(composition.resolve(h("unknown")), null);
  const session = composition.openRehydrationSession(familyDefinitionHash);
  assert.throws(
    () => composition.rehydrateRouteHandle({ ...session }, {} as never, {} as never, {} as never),
    /not issued by this composition/,
  );
});

function generatedFixture() {
  const base = setup();
  const stages = (["nomination", "identity", "materialization", "projection", "rehydration"] as const)
    .map(stage => ({
      stage,
      modulePath: "families/composition-family/" + stage + ".ts",
      exportName: stage + "RuntimeDefinition",
      closureRoot: base.entry.lifecycleRefs[stage].interpreterHash,
      stageRef: base.entry.lifecycleRefs[stage],
    }))
    .sort((left, right) => left.stage.localeCompare(right.stage));
  const stageDefinitionRoot = hashDomain(
    "aloha/family-runtime-definition-set/v1",
    [...stages].sort((left, right) => left.stage.localeCompare(right.stage)),
  );
  const sourcePlanDescriptorBase = {
    sourcePlanId: base.sourcePlan.sourcePlanId,
    modulePath: "families/composition-family/source-plan.ts",
    exportName: "SOURCE_PLAN",
    closureRoot: h("source-plan-closure"),
    schemaHash: base.sourcePlan.schemaHash,
    planRef: base.sourcePlanRef,
  };
  const sourcePlanDescriptor = {
    ...sourcePlanDescriptorBase,
    leafDigest: sourcePlanLeafDigest(sourcePlanDescriptorBase),
  };
  const nominationProposalBase = {
    program: {
      modulePath: "families/composition-family/nomination-program.ts",
      exportName: "NOMINATION_PROGRAM",
      closureRoot: h("nomination-program-closure"),
      schemaHash: base.nominationProgram.schemaHash,
    },
    mutationCorpus: {
      modulePath: "families/composition-family/nomination-mutations.ts",
      exportName: "NOMINATION_MUTATIONS",
      closureRoot: h("nomination-mutations-closure"),
    },
    independentOracle: {
      modulePath: "families/composition-family/nomination-oracle.ts",
      exportName: "NOMINATION_ORACLE",
      closureRoot: h("nomination-oracle-closure"),
    },
  };
  const proposalWithoutLeaf = {
    ...nominationProposalBase,
    nominationProgramRoot: nominationProgramRoot(nominationProposalBase),
  };
  const nominationProgramProposal = {
    ...proposalWithoutLeaf,
    proposalLeafDigest: nominationProgramProposalLeafDigest(sourcePlanDescriptor.leafDigest, proposalWithoutLeaf),
  };
  const qualifiedSourcePlanDescriptor = { ...sourcePlanDescriptor, nominationProgramProposal };
  const withoutRoot = {
    schemaVersion: 1 as const,
    releaseIntentRoot: h("release-intent"),
    definitionCatalogRoot: h("catalog"),
    proposedCapabilitySetRoot: h("proposed-capability-set"),
    nominationProgramSetRoot: nominationProgramSetRoot([nominationProgramProposal.proposalLeafDigest]),
    families: [{
      entry: base.entry,
      publicEntry: {
        modulePath: "families/composition-family/public.ts",
        exportName: "PUBLIC_ENTRY",
        closureRoot: h("public-closure"),
      },
      stages,
      sourcePlans: [qualifiedSourcePlanDescriptor],
      extensions: [],
      actionOwners: [],
      runtimeAdapters: [],
      runtimeAdapterRoot: hashDomain("aloha/family-runtime-adapter-set/v1", []),
      sourcePlanRoot: hashDomain("aloha/family-source-plan-set/v1", [sourcePlanDescriptor.leafDigest]),
      stageDefinitionRoot,
    }],
  };
  const descriptor: GeneratedFamilyRuntimeDescriptorV1 = {
    ...withoutRoot,
    descriptorRoot: hashDomain("aloha/generated-family-runtime-descriptor/v1", withoutRoot),
  };
  const definitions: readonly FamilyStageDefinitionV1[] = Object.freeze(stages.map(stage => Object.freeze({
    stage: stage.stage,
    capabilityId: stage.stageRef.capabilityId,
    version: stage.stageRef.version,
    schemaHash: stage.stageRef.schemaHash,
    payloadCodec: Object.freeze({
      schemaRef: stage.stageRef.schemaHash,
      decodeExact(value: unknown): CanonicalJson {
        return decodeCanonicalJson(encodeCanonicalJson(value));
      },
    }),
    dependencyIds: Object.freeze([]),
    outputSchemaRef: h(stage.stage + "-output"),
    implementationClosureHash: h(stage.stage + "-implementation"),
    outputCodecHash: h(stage.stage + "-codec"),
    outputCodec: Object.freeze({ decodeExact(value: unknown): CanonicalJson { return decodeCanonicalJson(encodeCanonicalJson(value)); } }),
    prepareIssueValue: ({ candidate, cutoff, identityMemo, materializationOutput }: Parameters<FamilyStageDefinitionV1["prepareIssueValue"]>[0]) => ({
      candidate,
      cutoff,
      identityMemo,
      materializationOutput,
    }),
    interpret(_input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 {
      return Object.freeze({ kind: "invalidProgram", code: "test-only" });
    },
  })));
  const binding = {
    familyId,
    familyDefinitionHash,
    releaseAuthorityRoot: h("release-authority"),
    programAuthorityHash: h("program-authority"),
    executorAuthorityRoot: h("executor-authority"),
    workerEpoch: "epoch-1",
    executorSessionHash: h("executor-session"),
  };
  const executors: readonly { readonly stage: typeof stages[number]["stage"]; readonly executor: RuntimeStageExecutorV1 }[] = Object.freeze(stages.map(stage => ({
    stage: stage.stage,
    executor: {
      async execute() { return []; },
    },
  })));
  const authority = {
    familyDefinitionHash,
    definitionBindingRoot: stageDefinitionRoot,
    binding,
    executors,
  };
  return { descriptor, authority, definitions, sourcePlan: base.sourcePlan, nominationProgram: base.nominationProgram, stageDefinitionRoot };
}

test("generated composition consumes exact named definitions and rejects definition mutations", () => {
  const fixture = generatedFixture();
  const composition = createGeneratedFamilyRuntimeComposition({
    descriptor: fixture.descriptor,
    authorities: [fixture.authority],
    definitions: [fixture.definitions],
    extensions: [[]],
    actionOwners: [[]],
  });
  assert.equal(composition.resolve(familyDefinitionHash, familyId)?.familyId, familyId);

  const changedStages = fixture.descriptor.families[0]!.stages.map((stage, index) =>
    index === 1 ? { ...stage, stageRef: { ...stage.stageRef, interpreterHash: h("different-interpreter") } } : stage);
  const changedStageRoot = hashDomain(
    "aloha/family-runtime-definition-set/v1",
    [...changedStages].sort((left, right) => left.stage.localeCompare(right.stage)),
  );
  const changedWithoutRoot = {
    ...fixture.descriptor,
    families: [{
      ...fixture.descriptor.families[0]!,
      stages: changedStages,
      stageDefinitionRoot: changedStageRoot,
    }],
  };
  const changedDescriptor: GeneratedFamilyRuntimeDescriptorV1 = {
    ...changedWithoutRoot,
    descriptorRoot: hashDomain("aloha/generated-family-runtime-descriptor/v1", {
      schemaVersion: changedWithoutRoot.schemaVersion,
      releaseIntentRoot: changedWithoutRoot.releaseIntentRoot,
      definitionCatalogRoot: changedWithoutRoot.definitionCatalogRoot,
      proposedCapabilitySetRoot: changedWithoutRoot.proposedCapabilitySetRoot,
      nominationProgramSetRoot: changedWithoutRoot.nominationProgramSetRoot,
      families: changedWithoutRoot.families,
    }),
  };
  assert.throws(
    () => createGeneratedFamilyRuntimeComposition({
      descriptor: changedDescriptor,
      authorities: [fixture.authority],
      definitions: [fixture.definitions],
      extensions: [[]],
      actionOwners: [[]],
    }),
    /binding mismatch/,
  );
});

test("generated factory closes the assembly and fails closed without a release authority capability", () => {
  const fixture = generatedFixture();
  const factory = createGeneratedFamilyRuntimeFactory({
    descriptor: fixture.descriptor,
    definitions: [fixture.definitions],
    extensions: [[]],
    actionOwners: [[]],
    runtimeAdapters: [[]],
    sourcePlans: [[fixture.sourcePlan]],
    nominationPrograms: [[fixture.nominationProgram]],
  });
  assert.doesNotThrow(() => assertGeneratedFamilyRuntimeFactory(factory));
  const metadata = readGeneratedFamilyRuntimeFactoryMetadata(factory);
  assert.equal(metadata.proposedCapabilitySetRoot, fixture.descriptor.proposedCapabilitySetRoot);
  assert.equal(metadata.descriptorRoot, fixture.descriptor.descriptorRoot);
  assert.throws(() => readGeneratedFamilyRuntimeFactoryMetadata(() => ({} as never)), /not generated/);
  assert.throws(
    () => factory({} as never),
    /production authority is unavailable/,
  );
  assert.throws(
    () => assertGeneratedFamilyRuntimeFactory(() => ({} as never)),
    /not generated and release-authenticated/,
  );
});

test("generated factory exact-binds every runtime adapter import descriptor and keeps actual factories private", () => {
  const fixture = generatedFixture();
  const adapterBase = Object.freeze({
    role: "search/v1",
    modulePath: "families/composition-family/search-adapter.ts",
    exportName: "SEARCH_ADAPTER_FACTORY",
    closureRoot: h("generated-adapter-closure"),
    capabilityRefs: Object.freeze({}),
    actionOwnerRefs: Object.freeze({}),
  });
  const adapter = Object.freeze({ ...adapterBase, leafDigest: runtimeAdapterLeafDigest(adapterBase) });
  const family = fixture.descriptor.families[0]!;
  const changedFamily = Object.freeze({
    ...family,
    runtimeAdapters: Object.freeze([adapter]),
    runtimeAdapterRoot: hashDomain("aloha/family-runtime-adapter-set/v1", [adapter.leafDigest]),
  });
  const withoutRoot = Object.freeze({
    schemaVersion: fixture.descriptor.schemaVersion,
    releaseIntentRoot: fixture.descriptor.releaseIntentRoot,
    definitionCatalogRoot: fixture.descriptor.definitionCatalogRoot,
    proposedCapabilitySetRoot: fixture.descriptor.proposedCapabilitySetRoot,
    nominationProgramSetRoot: fixture.descriptor.nominationProgramSetRoot,
    families: Object.freeze([changedFamily]),
  });
  const descriptor = Object.freeze({
    ...withoutRoot,
    descriptorRoot: hashDomain("aloha/generated-family-runtime-descriptor/v1", withoutRoot),
  });
  const actualFactory: FamilySearchAdapterFactoryV1 = () => { throw new TypeError("not opened"); };
  const exactImport = Object.freeze({
    factory: actualFactory,
    modulePath: adapter.modulePath,
    exportName: adapter.exportName,
    closureRoot: adapter.closureRoot,
    leafDigest: adapter.leafDigest,
  });
  const assembly = {
    descriptor,
    definitions: [fixture.definitions],
    extensions: [[]],
    actionOwners: [[]],
    runtimeAdapters: [[exactImport]],
    sourcePlans: [[fixture.sourcePlan]],
    nominationPrograms: [[fixture.nominationProgram]],
  } as const;
  const factory = createGeneratedFamilyRuntimeFactory(assembly);
  const bindings = readGeneratedFamilyRuntimeAdapterFactories(factory);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0]!.actualFactory, actualFactory);
  assert.deepEqual(bindings[0]!.descriptor, adapter);
  for (const mutation of [
    { modulePath: "families/forged/search-adapter.ts" },
    { exportName: "FORGED_FACTORY" },
    { closureRoot: h("forged-adapter-closure") },
    { leafDigest: h("forged-adapter-leaf") },
  ]) {
    assert.throws(
      () => createGeneratedFamilyRuntimeFactory({
        ...assembly,
        runtimeAdapters: [[{ ...exactImport, ...mutation }]],
      }),
      /import descriptor mismatch/,
    );
  }
  assert.throws(
    () => createGeneratedFamilyRuntimeFactory({ ...assembly, runtimeAdapters: [[actualFactory]] }),
    /import descriptor is missing/,
  );
});

function generatedSearchFactoryFixture() {
  const fixture = generatedFixture();
  const adapterBase = Object.freeze({
    role: "search/v1",
    modulePath: "families/composition-family/search-adapter.ts",
    exportName: "SEARCH_ADAPTER_FACTORY",
    closureRoot: h("neutral-search-adapter-closure"),
    capabilityRefs: Object.freeze({}),
    actionOwnerRefs: Object.freeze({}),
  });
  const adapterDescriptor = Object.freeze({
    ...adapterBase,
    leafDigest: runtimeAdapterLeafDigest(adapterBase),
  });
  const family = fixture.descriptor.families[0]!;
  const changedFamily = Object.freeze({
    ...family,
    runtimeAdapters: Object.freeze([adapterDescriptor]),
    runtimeAdapterRoot: hashDomain("aloha/family-runtime-adapter-set/v1", [adapterDescriptor.leafDigest]),
  });
  const withoutRoot = Object.freeze({
    schemaVersion: fixture.descriptor.schemaVersion,
    releaseIntentRoot: fixture.descriptor.releaseIntentRoot,
    definitionCatalogRoot: fixture.descriptor.definitionCatalogRoot,
    proposedCapabilitySetRoot: fixture.descriptor.proposedCapabilitySetRoot,
    nominationProgramSetRoot: fixture.descriptor.nominationProgramSetRoot,
    families: Object.freeze([changedFamily]),
  });
  const descriptor: GeneratedFamilyRuntimeDescriptorV1 = Object.freeze({
    ...withoutRoot,
    descriptorRoot: hashDomain("aloha/generated-family-runtime-descriptor/v1", withoutRoot),
  });
  const adapter = Object.freeze({
    async readState() { return Object.freeze({ kind: "unavailable", stage: "state", reasonCode: "unused", evidenceHash: h("state") }); },
    projectCoarse() { return Object.freeze({ kind: "unavailable", stage: "coarse", reasonCode: "test-only", evidenceHash: h("coarse") }); },
    evaluateExact() { return Object.freeze({ kind: "unavailable", stage: "exact", reasonCode: "unused", evidenceHash: h("exact") }); },
    buildAction() { return Object.freeze({ kind: "unavailable", stage: "action", reasonCode: "unused", evidenceHash: h("action") }); },
    async run() { return Object.freeze({ kind: "unavailable", stage: "state", reasonCode: "unused", evidenceHash: h("run") }); },
  });
  const actualFactory: FamilySearchAdapterFactoryV1 = () => adapter;
  const factory = createGeneratedFamilyRuntimeFactory({
    descriptor,
    definitions: [fixture.definitions],
    extensions: [[]],
    actionOwners: [[]],
    runtimeAdapters: [[Object.freeze({
      factory: actualFactory,
      modulePath: adapterDescriptor.modulePath,
      exportName: adapterDescriptor.exportName,
      closureRoot: adapterDescriptor.closureRoot,
      leafDigest: adapterDescriptor.leafDigest,
    })]],
    sourcePlans: [[fixture.sourcePlan]],
    nominationPrograms: [[fixture.nominationProgram]],
  });
  return { fixture, descriptor, adapter, factory };
}

test("unsigned dry-run generated Family ports bind one exact factory and runtime authority", () => {
  const first = generatedSearchFactoryFixture();
  const second = generatedSearchFactoryFixture();
  const descriptor = createUnsignedDryRunRuntimeAuthorityDescriptorV1({
    authorityClass: "dry-run",
    runtimeBindingId: h("unsigned-runtime-binding"),
    implementationCommit: "a".repeat(40),
  });
  let current = true;
  const assertCurrent = () => { if (!current) throw new TypeError("Family runtime rotated"); };
  const capability = issueGeneratedUnsignedDryRunFamilyRuntimeAuthorityCapability({
    factory: first.factory,
    runtimeAuthority: descriptor,
    declaredCapabilitySetRoot: first.descriptor.proposedCapabilitySetRoot,
    nominationProgramSetRoot: first.descriptor.nominationProgramSetRoot,
    authorities: [first.fixture.authority],
    assertCurrent,
  });
  const membership = readGeneratedFamilyRuntimeMembership(first.factory, capability);
  assert.equal(membership.runtimeAuthority.authorityClass, "dry-run");
  assert.equal(membership.runtimeAuthority.implementationCommit, "a".repeat(40));
  assert.equal(Object.prototype.hasOwnProperty.call(membership, "releaseProvenanceHash"), false);
  assert.equal(readGeneratedFamilySourcePlanDeclarations(first.factory, capability).length, 1);
  const lifecyclePort = issueGeneratedFamilyLifecycleRuntimePort(first.factory, capability);
  const lifecycle = readGeneratedFamilyLifecycleRuntimePort(
    lifecyclePort,
    projectRuntimeAuthorityDescriptorV1(descriptor),
  );
  assert.equal(
    lifecycle.requireStage(familyDefinitionHash, familyId, "projection").stageRef.stage,
    "projection",
  );
  const searchPort = issueGeneratedFamilySearchRuntimePort(first.factory, capability, lifecyclePort);
  const search = readGeneratedFamilySearchRuntimePort(
    searchPort,
    projectRuntimeAuthorityDescriptorV1(descriptor),
  );
  assert.equal(search.requireAdapter(familyDefinitionHash, "search/v1"), first.adapter);
  assert.throws(() => readGeneratedFamilyLifecycleRuntimePort({ ...lifecyclePort }), /not owner-issued/);
  assert.throws(() => readGeneratedFamilySearchRuntimePort({ ...searchPort }), /not owner-issued/);
  assert.throws(
    () => issueGeneratedFamilySearchRuntimePort(second.factory, capability),
    /another generated factory/,
  );
  current = false;
  assert.throws(() => readGeneratedFamilyLifecycleRuntimePort(lifecyclePort), /rotated/);
  assert.throws(() => readGeneratedFamilySearchRuntimePort(searchPort), /rotated/);
  assert.throws(() => issueGeneratedUnsignedDryRunFamilyRuntimeAuthorityCapability({
    factory: first.factory,
    runtimeAuthority: descriptor,
    declaredCapabilitySetRoot: h("foreign-declared-set"),
    nominationProgramSetRoot: first.descriptor.nominationProgramSetRoot,
    authorities: [first.fixture.authority],
    assertCurrent() {},
  }), /declared capability set/);
});

function coarseFixture(options: Readonly<{ stateUnavailable?: boolean }> = {}) {
  const fixture = generatedFixture();
  const capabilityRef: StageCapabilityRefV1 = Object.freeze({
    familyId,
    familyDefinitionHash,
    stage: "capability",
    capabilityId: asCapabilityId("composition.coarse"),
    version: asCapabilityVersion("1.0.0"),
    schemaHash: asSchemaRef(h("coarse-schema")),
    interpreterHash: h("coarse-interpreter"),
    ownerRef: asOwnerRef(h("coarse-owner")),
  });
  const extension = Object.freeze({
    modulePath: "families/composition-family/coarse.ts",
    exportName: "COARSE_PORT",
    closureRoot: h("coarse-extension-closure"),
    capabilityRef,
  });
  const adapterBase = Object.freeze({
    role: "search/v1",
    modulePath: "families/composition-family/search-adapter.ts",
    exportName: "SEARCH_ADAPTER",
    closureRoot: h("coarse-adapter-closure"),
    capabilityRefs: Object.freeze({ coarse: capabilityRef }),
    actionOwnerRefs: Object.freeze({}),
  });
  const adapterDescriptor = Object.freeze({
    ...adapterBase,
    leafDigest: runtimeAdapterLeafDigest(adapterBase),
  });
  const family = fixture.descriptor.families[0]!;
  const entry = Object.freeze({ ...family.entry, extensionRefs: Object.freeze([capabilityRef]) });
  const changedFamily = Object.freeze({
    ...family,
    entry,
    extensions: Object.freeze([extension]),
    runtimeAdapters: Object.freeze([adapterDescriptor]),
    runtimeAdapterRoot: hashDomain("aloha/family-runtime-adapter-set/v1", [adapterDescriptor.leafDigest]),
  });
  const withoutRoot = Object.freeze({
    schemaVersion: fixture.descriptor.schemaVersion,
    releaseIntentRoot: fixture.descriptor.releaseIntentRoot,
    definitionCatalogRoot: fixture.descriptor.definitionCatalogRoot,
    proposedCapabilitySetRoot: fixture.descriptor.proposedCapabilitySetRoot,
    nominationProgramSetRoot: fixture.descriptor.nominationProgramSetRoot,
    families: Object.freeze([changedFamily]),
  });
  const descriptor: GeneratedFamilyRuntimeDescriptorV1 = Object.freeze({
    ...withoutRoot,
    descriptorRoot: hashDomain("aloha/generated-family-runtime-descriptor/v1", withoutRoot),
  });
  const factory: FamilySearchAdapterFactoryV1 = () => Object.freeze({
    async readState(input: FamilySearchStateRequestV1) {
      if (options.stateUnavailable === true) {
        return Object.freeze({
          kind: "unavailable" as const,
          stage: "state" as const,
          reasonCode: "source-unavailable",
          evidenceHash: h("state-unavailable-evidence"),
        });
      }
      const routeBindingHash = familySearchRouteBindingHash(input.route);
      const payload = Object.freeze({ reserve: "10" }) as CanonicalJson;
      const payloadHash = familySearchPayloadHash("state", payload);
      return Object.freeze({
        kind: "verified" as const,
        artifact: Object.freeze({
          kind: "state" as const,
          status: "verified" as const,
          source: input.currentSource.source,
          routeBindingHash,
          payload,
          payloadHash,
          artifactHash: familySearchArtifactHash({ kind: "state", source: input.currentSource.source, routeBindingHash, objectiveRef: null, amountHash: null, payloadHash }),
          factsRoot: h("current-state-facts"),
          sourceRequestId: h("current-state-request"),
        }),
      });
    },
    projectCoarse(input: FamilySearchCoarseRequestV1) {
      const routeBindingHash = familySearchRouteBindingHash(input.route);
      const payload = Object.freeze({ output: "11" }) as CanonicalJson;
      const payloadHash = familySearchPayloadHash("coarse", payload);
      const amountHash = familySearchAmountHash(input.amount);
      return Object.freeze({
        kind: "verified" as const,
        artifact: Object.freeze({
          kind: "coarse" as const,
          status: "rankable" as const,
          source: input.currentSource.source,
          routeBindingHash,
          objectiveRef: input.objective.objectiveRef,
          amountHash,
          payload,
          payloadHash,
          artifactHash: familySearchArtifactHash({ kind: "coarse", source: input.currentSource.source, routeBindingHash, objectiveRef: input.objective.objectiveRef, amountHash, payloadHash }),
          projectionHash: h("family-coarse-projection"),
          stateFactsRoot: input.state.factsRoot,
          input: Object.freeze({ assetRef: input.amount.inputAssetRef, amount: input.amount.amountIn }),
          output: Object.freeze({ assetRef: input.amount.outputAssetRef, amount: "11" }),
          conservativeOutputUpperBound: "999999",
          inputCapacityUpperBound: "999999",
          rankKey: h("rank-key"),
          reasonCode: null,
        }),
      });
    },
    evaluateExact() { throw new Error("unused"); },
    buildAction() { throw new Error("unused"); },
    async run() { throw new Error("unused"); },
  });
  const composition = createGeneratedFamilyRuntimeComposition({
    descriptor,
    authorities: [fixture.authority],
    definitions: [fixture.definitions],
    extensions: [[Object.freeze({ project() {}, decode() {} })]],
    actionOwners: [[]],
    runtimeAdapters: [[factory]],
  });
  const coarseDescriptor = generatedFamilyCoarseProjectionDescriptorV1(descriptor.families[0]!);
  assert.ok(coarseDescriptor);
  const releaseProvenanceHash = null;
  const releaseMembershipRoot = h("coarse-release-membership");
  const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(createUnsignedDryRunRuntimeAuthorityDescriptorV1({
    authorityClass: "dry-run",
    runtimeBindingId: h("coarse-runtime-binding"),
    implementationCommit: "a".repeat(40),
  }));
  let releaseCurrent = true;
  const assertCurrent = () => { if (!releaseCurrent) throw new TypeError("coarse release stale"); };
  const owner = issueQualifiedCoarseProjectionOwnerCapabilityV1({
    releaseMembershipRoot,
    descriptor: coarseDescriptor.ownerDescriptor,
    port: Object.freeze({
      read: (capability: CoarseProjectionCapabilityV1) => readGeneratedFamilyCoarseProjectionCapabilityV1(composition, capability),
      verifyConservativeBound: () => { throw new TypeError("rank-only"); },
    }),
  });
  const service = issueCoarseProjectionServiceV1({ owner });
  installGeneratedFamilyCoarseProjectionOwnerV1(composition, {
    familyDefinitionHash,
    ownerDescriptor: coarseDescriptor.ownerDescriptor,
    service,
    releaseMembershipRoot,
    assertCurrent,
  });
  const identityMemo = Object.freeze({ family: "composition" }) as CanonicalJson;
  const publication = Object.freeze({
    familyId,
    familyDefinitionHash,
    instanceKey: "instance-1",
    identityMemo,
    identityMemoHash: hashDomain("aloha/identity-memo/v1", identityMemo),
    instancePublicationHash: h("instance-publication"),
    staticProjectionMemoHash: h("static-projection-memo"),
    requestedArtifactDependencyRoot: h("artifact-dependency"),
  });
  const ref = Object.freeze({
    familyDefinitionHash,
    instanceKey: publication.instanceKey,
    instancePublicationHash: publication.instancePublicationHash,
    staticProjectionMemoHash: publication.staticProjectionMemoHash,
    requestedArtifactDependencyRoot: publication.requestedArtifactDependencyRoot,
  });
  const session = composition.openRehydrationSession(familyDefinitionHash);
  const issuedHandle = composition.rehydrateRouteHandle(session, publication, {
    staticProjectionHash: h("static-projection"),
    projectionHash: h("projection"),
  }, ref);
  const source = Object.freeze({ chainId: "1", number: "100", hash: h("head"), stateRoot: h("state-root") });
  const objectivePayload = Object.freeze({ mode: "test" }) as CanonicalJson;
  const objective = Object.freeze({ objectiveRef: hashDomain("aloha/search-objective/v1", objectivePayload), payload: objectivePayload });
  const amount = Object.freeze({ inputAssetRef: h("asset-in"), outputAssetRef: h("asset-out"), amountIn: "10", recipient: "recipient" });
  const execution = Object.freeze({ transactionOrigin: "caller", executorAddress: amount.recipient });
  const resolvedRouteBindingHash = familySearchRouteBindingHash(composition.resolveRouteHandle(issuedHandle, familyDefinitionHash));
  const bindingValue = {
    candidateId: h("candidate"),
    orderKey: h("order"),
    planningProblemHash: h("planning-problem"),
    routeHash: h("route"),
    routeBindingHash: h("route-binding"),
    dependencySetRef: h("dependency-set"),
    ownerRefs: Object.freeze([familyCoarseRouteOwnerRefV1(familyDefinitionHash, resolvedRouteBindingHash)]),
    generationId: "generation-1",
    graphRoot: h("graph"),
    source,
    objectiveRef: objective.objectiveRef,
    runtimeAuthority,
    releaseProvenanceHash,
    legs: Object.freeze([
      { edgeId: h("edge"), transitionRef: h("transition"), inputAssetRef: amount.inputAssetRef, inputPortRef: h("port-in"), outputAssetRef: amount.outputAssetRef, outputPortRef: h("port-out") },
      { edgeId: h("edge-return"), transitionRef: h("transition-return"), inputAssetRef: amount.outputAssetRef, inputPortRef: h("port-return-in"), outputAssetRef: amount.inputAssetRef, outputPortRef: h("port-return-out") },
    ]),
  };
  return {
    composition,
    coarseDescriptor,
    service,
    seam: composition.resolveCoarseProjection(familyDefinitionHash)!,
    issuedHandle,
    source,
    objective,
    amount,
    execution,
    bindingValue,
    binding: issueCoarseRouteBindingV1(bindingValue),
    sourceRead: Object.freeze({ async read() { throw new Error("adapter fixture does not make physical reads"); } }),
    revokeRelease: () => { releaseCurrent = false; },
  };
}

test("generated coarse seam binds runtime membership, route, transition, source and objective without trusting raw bounds", async () => {
  const fixture = coarseFixture();
  let fences = 0;
  const currentSource = Object.freeze({ source: fixture.source, assertCurrent: () => { fences += 1; } });
  const capability = await fixture.composition.issueCoarseProjection(fixture.seam.producer, {
    binding: fixture.binding,
    legIndex: 0,
    issuedHandle: fixture.issuedHandle,
    currentSource,
    sourceRead: fixture.sourceRead,
    objective: fixture.objective,
    amount: fixture.amount,
    execution: fixture.execution,
  });
  assert.equal(fences, 2);
  const receipt = readQualifiedCoarseProjectionReceiptV1(readQualifiedCoarseProjectionV1({ service: fixture.seam.service, capability }));
  assert.equal(receipt.releaseMembershipRoot, h("coarse-release-membership"));
  assert.equal(receipt.projection.transitionRef, fixture.bindingValue.legs[0]!.transitionRef);
  assert.equal(receipt.projection.objectiveRef, fixture.objective.objectiveRef);
  assert.equal(receipt.projection.status, "rankable");
  assert.equal(receipt.projection.estimatedOutput?.amount, "11");
  assert.equal(receipt.projection.conservativeOutputUpperBound, null, "raw Family upper bound must remain rank-only");
  assert.equal(receipt.boundVerification, null);
  const observation = fixture.composition.readCoarseProjectionObservation(fixture.seam.producer, capability);
  assert.equal(observation.familyDefinitionHash, familyDefinitionHash);
  assert.equal(observation.binding.candidateId, fixture.bindingValue.candidateId);
  assert.equal(observation.binding.graphRoot, fixture.bindingValue.graphRoot);
  assert.equal(observation.legIndex, "0");
  assert.equal(observation.routeHandleBindingHash, resolvedRouteBindingHashFrom(fixture));
  assert.equal(observation.projectionId, receipt.projection.projectionId);
  assert.equal((observation.stateOutcome as { readonly kind: string }).kind, "verified");
  const observedCoarse = observation.coarseOutcome as {
    readonly kind: string;
    readonly artifact: { readonly artifactHash: Hash; readonly conservativeOutputUpperBound: string | null };
  };
  assert.equal(observedCoarse.kind, "verified");
  assert.equal(observedCoarse.artifact.conservativeOutputUpperBound, "999999", "raw Family artifact must not be reconstructed from the rank-only generic projection");
  const { observationRoot: _observationRoot, ...observationBody } = observation;
  assert.equal(
    observation.observationRoot,
    hashDomain("aloha/family-runtime-coarse-projection-observation/v1", observationBody as unknown as CanonicalJson),
  );
  assert.throws(
    () => fixture.composition.readCoarseProjectionObservation({ ...fixture.seam.producer }, capability),
    /producer was not issued/,
  );
  assert.throws(
    () => fixture.composition.readCoarseProjectionObservation(fixture.seam.producer, { ...capability }),
    /observation was not issued/,
  );
  const otherFixture = coarseFixture();
  assert.throws(
    () => fixture.composition.readCoarseProjectionObservation(otherFixture.seam.producer, capability),
    /producer was not issued/,
  );
  assert.throws(
    () => otherFixture.composition.readCoarseProjectionObservation(otherFixture.seam.producer, capability),
    /observation was not issued/,
  );

  await assert.rejects(
    () => fixture.composition.issueCoarseProjection({ ...fixture.seam.producer }, {} as never),
    /producer was not issued/,
  );
  await assert.rejects(
    () => fixture.composition.issueCoarseProjection(fixture.seam.producer, { binding: { ...fixture.binding } as never } as never),
    /binding capability|not issued/,
  );
  for (const [field, value, expected] of [
    ["source", { ...fixture.source, hash: h("wrong-source") }, /current source mismatch/],
    ["objective", { ...fixture.objective, objectiveRef: h("wrong-objective") }, /objective.*mismatch/],
    ["amount", { ...fixture.amount, outputAssetRef: h("wrong-output") }, /route asset mismatch/],
  ] as const) {
    const request = {
      binding: fixture.binding,
      legIndex: 0,
      issuedHandle: fixture.issuedHandle,
      currentSource: Object.freeze({ source: field === "source" ? value : fixture.source, assertCurrent() {} }),
      sourceRead: fixture.sourceRead,
      objective: field === "objective" ? value : fixture.objective,
      amount: field === "amount" ? value : fixture.amount,
      execution: fixture.execution,
    } as never;
    await assert.rejects(() => fixture.composition.issueCoarseProjection(fixture.seam.producer, request), expected);
  }
  const wrongOwner = issueCoarseRouteBindingV1({ ...fixture.bindingValue, ownerRefs: [h("wrong-family")] });
  await assert.rejects(
    () => fixture.composition.issueCoarseProjection(fixture.seam.producer, {
      binding: wrongOwner, legIndex: 0, issuedHandle: fixture.issuedHandle,
      currentSource, sourceRead: fixture.sourceRead, objective: fixture.objective, amount: fixture.amount, execution: fixture.execution,
    }),
    /route owner mismatch/,
  );
  assert.throws(
    () => issueCoarseRouteBindingV1({ ...fixture.bindingValue, releaseProvenanceHash: h("wrong-release") } as never),
    /cannot carry release provenance/,
  );
  let reorgFences = 0;
  await assert.rejects(
    () => fixture.composition.issueCoarseProjection(fixture.seam.producer, {
      binding: fixture.binding,
      legIndex: 0,
      issuedHandle: fixture.issuedHandle,
      currentSource: Object.freeze({
        sessionId: h("real-current-source-session"),
        source: fixture.source,
        assertCurrent() {
          reorgFences += 1;
          if (reorgFences === 2) throw new TypeError("current source changed after read");
        },
      }),
      sourceRead: fixture.sourceRead,
      objective: fixture.objective,
      amount: fixture.amount,
      execution: fixture.execution,
    }),
    /current source changed after read/,
  );
  assert.equal(reorgFences, 2, "post-read current-source fence must run before any capability is issued");
  fixture.revokeRelease();
  assert.throws(
    () => fixture.composition.readCoarseProjectionObservation(fixture.seam.producer, capability),
    /coarse release stale/,
  );
  await assert.rejects(
    () => fixture.composition.issueCoarseProjection(fixture.seam.producer, {} as never),
    /coarse release stale/,
  );
});

test("generated coarse edge sweep observes one real directed edge without weakening route-cycle binding", async () => {
  const fixture = coarseFixture();
  assert.equal(fixture.composition.resolveCoarseProjection(h("unknown-family-definition")), null);
  const routeBindingHash = resolvedRouteBindingHashFrom(fixture);
  const body = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.coarse-edge-sweep-binding-v1" as const,
    familyId,
    familyDefinitionHash,
    edgeId: fixture.bindingValue.legs[0]!.edgeId,
    transitionRef: fixture.bindingValue.legs[0]!.transitionRef,
    inputAssetRef: fixture.amount.inputAssetRef,
    inputPortRef: fixture.bindingValue.legs[0]!.inputPortRef,
    outputAssetRef: fixture.amount.outputAssetRef,
    outputPortRef: fixture.bindingValue.legs[0]!.outputPortRef,
    routeBindingHash,
    routeOwnerRef: familyCoarseRouteOwnerRefV1(familyDefinitionHash, routeBindingHash),
    generationId: fixture.bindingValue.generationId,
    readyRecordHash: h("ready-record"),
    graphRoot: fixture.bindingValue.graphRoot,
    readyCutoff: fixture.source,
    source: fixture.source,
    objectiveRef: fixture.objective.objectiveRef,
    releaseProvenanceHash: fixture.bindingValue.releaseProvenanceHash,
  });
  const binding = issueCoarseEdgeSweepBindingV1({
    ...body,
    bindingRoot: coarseEdgeSweepBindingRootV1(body),
  });
  const capability = await fixture.composition.issueCoarseEdgeSweepProjection(fixture.seam.producer, {
    binding,
    issuedHandle: fixture.issuedHandle,
    currentSource: Object.freeze({ source: fixture.source, assertCurrent() {} }),
    sourceRead: fixture.sourceRead,
    objective: fixture.objective,
    amount: fixture.amount,
    execution: fixture.execution,
  });
  const observation = fixture.composition.readCoarseEdgeSweepObservation(fixture.seam.producer, capability);
  const receipt = readQualifiedCoarseProjectionReceiptV1(readQualifiedCoarseProjectionV1({
    service: fixture.seam.service,
    capability,
  }));
  assert.equal(observation.kind, "aloha.family-runtime-coarse-edge-sweep-observation-v1");
  assert.equal(observation.binding.edgeId, body.edgeId);
  assert.equal(observation.binding.bindingRoot, coarseEdgeSweepBindingRootV1(body));
  assert.equal(observation.routeHandleBindingHash, routeBindingHash);
  assert.equal(receipt.projection.edgeId, body.edgeId);
  assert.equal(receipt.projection.status, "rankable");
  assert.throws(
    () => fixture.composition.readCoarseEdgeSweepObservation(fixture.seam.producer, { ...capability }),
    /observation was not issued/,
  );
  await assert.rejects(
    () => fixture.composition.issueCoarseEdgeSweepProjection(fixture.seam.producer, {
      binding: { ...binding } as never,
      issuedHandle: fixture.issuedHandle,
      currentSource: Object.freeze({ source: fixture.source, assertCurrent() {} }),
      sourceRead: fixture.sourceRead,
      objective: fixture.objective,
      amount: fixture.amount,
      execution: fixture.execution,
    }),
    /binding capability|not issued/,
  );
});

function resolvedRouteBindingHashFrom(fixture: ReturnType<typeof coarseFixture>): Hash {
  return familySearchRouteBindingHash(fixture.composition.resolveRouteHandle(fixture.issuedHandle, familyDefinitionHash));
}

test("generated coarse observation retains exact state-unavailable and does not synthesize a coarse artifact", async () => {
  const fixture = coarseFixture({ stateUnavailable: true });
  const capability = await fixture.composition.issueCoarseProjection(fixture.seam.producer, {
    binding: fixture.binding,
    legIndex: 0,
    issuedHandle: fixture.issuedHandle,
    currentSource: Object.freeze({ source: fixture.source, assertCurrent() {} }),
    sourceRead: fixture.sourceRead,
    objective: fixture.objective,
    amount: fixture.amount,
    execution: fixture.execution,
  });
  const receipt = readQualifiedCoarseProjectionReceiptV1(readQualifiedCoarseProjectionV1({
    service: fixture.seam.service,
    capability,
  }));
  const observation = fixture.composition.readCoarseProjectionObservation(fixture.seam.producer, capability);
  assert.equal(receipt.projection.status, "unavailable");
  assert.equal(receipt.projection.reasonCode, "state:source-unavailable");
  assert.deepEqual(observation.stateOutcome, {
    kind: "unavailable",
    stage: "state",
    reasonCode: "source-unavailable",
    evidenceHash: h("state-unavailable-evidence"),
  });
  assert.equal(observation.coarseOutcome, null);
});
