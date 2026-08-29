import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";

/**
 * The release BOM is data-only. Concrete predicate modules are bound by the
 * generated composition output. This authoring module owns only the static
 * release intent and a pure root helper; it cannot substitute a runtime map.
 */
export interface PredicateCompositionReleaseEntryV1 {
  readonly predicateId: string;
  readonly predicateSpecDigest: Hash;
  readonly predicateProgramDescriptorDigest: Hash;
  readonly oracleProgramDescriptorDigest: Hash;
  readonly adapterVersion: string;
  readonly oracleVersion: string;
  readonly modulePath: string;
  readonly exportName: string;
  readonly oracleModulePath: string;
  readonly oracleExportName: string;
  readonly materialProviderModulePath: string;
  readonly materialProviderExportName: string;
  readonly materialProviderContractDigest: Hash;
}

/**
 * Static release intent consumed by the role-manifest generator. The
 * generator parses this object as a literal and then checks every digest and
 * named export against the actual adapter/oracle modules.
 */
export const RELEASE_ROLE_COMPOSITION = Object.freeze({
  schemaVersion: 1 as const,
  commonEnvelopeRoleContractVersion: "1.0.0",
  genericCore: {
    modulePath: "acceptance/gate-core/src/index.ts",
    exportName: "evaluateGateCoreRuntime",
  },
  qualifiedRunner: {
    modulePath: "tools/runtime-release-packager/src/internal/qualified-release-runner-owner.ts",
    exportName: "observeQualifiedReleaseAcceptanceAdvisoryV1",
  },
  releaseRuntime: {
    modulePath: "acceptance/gate-core/src/generated/release-runtime.ts",
    exportName: "evaluateGateCore",
  },
  predicateAdapters: [{
    predicateId: "aloha.artifact-lineage.facts",
    predicateSpecDigest: "0x91dd08c14942bf66fbd260c70dab940a06f9e470030c6813ef65f28d25c36215" as Hash,
    predicateProgramDescriptorDigest: "0x79e2f2681c22d4fc2f4e9a8b62a38bbed51b968d31d902505b46d8931328b997" as Hash,
    oracleProgramDescriptorDigest: "0x16a8c441a786aefb94923d61ce0d40f8aed50200f1f00348ae6d958c58b53672" as Hash,
    adapterVersion: "artifact-lineage-gate-core-adapter-v1",
    oracleVersion: "artifact-lineage-independent-oracle-v3",
    modulePath: "acceptance/gate-core/src/predicates/artifact-lineage.ts",
    exportName: "ARTIFACT_LINEAGE_PREDICATE_EVALUATOR",
    oracleModulePath: "acceptance/artifact-lineage-facts/src/reference-model.ts",
    oracleExportName: "evaluateArtifactLineageOracle",
    materialProviderModulePath: "acceptance/collectors/src/material-providers/artifact-lineage.ts",
    materialProviderExportName: "ARTIFACT_LINEAGE_MATERIAL_PROVIDER",
    materialProviderContractDigest: "0xcd6273428674ff1750d647c5299635406d511800a9fa025b0932958ca750f855" as Hash,
  }, {
    predicateId: "aloha.full-family.facts",
    predicateSpecDigest: "0x718bad35ae39d2fb0dd877babe277ba4284695f818bcf7d188b57a10564ecdfb" as Hash,
    predicateProgramDescriptorDigest: "0xe2e929d4c51193d54ac4c73407e9203fdbd1fc2381fd1fcd844778bc74de8a87" as Hash,
    oracleProgramDescriptorDigest: "0x69fcf69f7eda4a7cfdd02d334b73652b749153e915b62d411d7b4a8973346dd0" as Hash,
    adapterVersion: "full-family-gate-core-adapter-v10",
    oracleVersion: "full-family-independent-reference-model-v10",
    modulePath: "acceptance/gate-core/src/predicates/full-family.ts",
    exportName: "FULL_FAMILY_PREDICATE_EVALUATOR",
    oracleModulePath: "acceptance/full-family-facts/src/reference-model.ts",
    oracleExportName: "evaluateFullFamilyReferenceModel",
    materialProviderModulePath: "acceptance/collectors/src/material-providers/full-family.ts",
    materialProviderExportName: "FULL_FAMILY_MATERIAL_PROVIDER",
    materialProviderContractDigest: "0xc3e5170edefa14ad134efec09b33228bcfcdb96133276177f78a08d9ebfca924" as Hash,
  }, {
    predicateId: "aloha.legacy-shaped-authority-zero",
    predicateSpecDigest: "0xf29edb1a013c51d9e4173bb6ce5ac3f15f224ec7dffa57812043132e56fe4603" as Hash,
    predicateProgramDescriptorDigest: "0x0ce4eb4397c3c836445619c9de17699abeddf5ac8718c11f22614136667e6b89" as Hash,
    oracleProgramDescriptorDigest: "0x8401323519415b43dd4ead2b3d78f68ac540ca7da21e285c0b3549e218521f2b" as Hash,
    adapterVersion: "legacy-shaped-authority-zero-gate-core-adapter-v1",
    oracleVersion: "legacy-shaped-authority-independent-reference-model-v1",
    modulePath: "acceptance/gate-core/src/predicates/runtime-acceptance.ts",
    exportName: "LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_EVALUATOR",
    oracleModulePath: "acceptance/runtime-acceptance-facts/src/reference-model.ts",
    oracleExportName: "evaluateLegacyShapedAuthorityReferenceModel",
    materialProviderModulePath: "acceptance/collectors/src/material-providers/runtime-boundaries.ts",
    materialProviderExportName: "LEGACY_SHAPED_AUTHORITY_ZERO_MATERIAL_PROVIDER",
    materialProviderContractDigest: "0xeb66f19f5cb55697f9f93cf48b2128469fe7b03b480a124b5180e6b96c274c24" as Hash,
  }, {
    predicateId: "aloha.performance.facts",
    predicateSpecDigest: "0x7dadb43c59f00a2af2c7c6ac80aed71b3dd4e2e7525bbab8c876eaff2b81b5c9" as Hash,
    predicateProgramDescriptorDigest: "0x0f669f4f92f25607c2b48e7561612f98690318fa3de11a678d6384a41bad0698" as Hash,
    oracleProgramDescriptorDigest: "0xf060cd56b9a75cb29d536042be875a708004703a266bde0dd567a185abaf665a" as Hash,
    adapterVersion: "performance-gate-core-adapter-v2",
    oracleVersion: "performance-independent-reference-model-v2",
    modulePath: "acceptance/gate-core/src/predicates/performance.ts",
    exportName: "PERFORMANCE_PREDICATE_EVALUATOR",
    oracleModulePath: "acceptance/performance-facts/src/reference-model.ts",
    oracleExportName: "evaluatePerformanceReferenceModel",
    materialProviderModulePath: "acceptance/collectors/src/material-providers/performance.ts",
    materialProviderExportName: "PERFORMANCE_MATERIAL_PROVIDER",
    materialProviderContractDigest: "0x16478451b563d343dd062ff7a3985e868766ac3ac05143bad30df6f3dd96e353" as Hash,
  }, {
    predicateId: "aloha.runtime-restart.facts",
    predicateSpecDigest: "0x10ccdeaa4317fbd0a3f6e1b6125e4f8e3ca21d4b64fd4e6f87f07d62f6138086" as Hash,
    predicateProgramDescriptorDigest: "0x9d0c87c2a6e7f08d528f7fddfe4fb63ee639b26226017b73196d099205634314" as Hash,
    oracleProgramDescriptorDigest: "0x797fde4716e6129ee71219a98ce1e2017d6681caf76ef99c4b31e6849db6ea6d" as Hash,
    adapterVersion: "runtime-restart-gate-core-adapter-v1",
    oracleVersion: "runtime-restart-independent-reference-model-v1",
    modulePath: "acceptance/gate-core/src/predicates/runtime-acceptance.ts",
    exportName: "RUNTIME_RESTART_PREDICATE_EVALUATOR",
    oracleModulePath: "acceptance/runtime-acceptance-facts/src/reference-model.ts",
    oracleExportName: "evaluateRuntimeRestartReferenceModel",
    materialProviderModulePath: "acceptance/collectors/src/material-providers/runtime-boundaries.ts",
    materialProviderExportName: "RUNTIME_RESTART_MATERIAL_PROVIDER",
    materialProviderContractDigest: "0xc8256b102180019b712194dc928fa245b688e79549078051c856701b6545c672" as Hash,
  }, {
    predicateId: "aloha.six-step.facts",
    // These digests are generated from the frozen six-step spec and descriptor
    // bytes. They are intent, not a caller-selectable runtime map.
    predicateSpecDigest: "0x98a293fef05cdb95e43140479dd3a43ef06cb82ef78e4ffbe45d69bea7abbc59" as Hash,
    predicateProgramDescriptorDigest: "0x25a7595749d931baa98522b3b76a5a33020f27e7e309cd690d5fd35a84659bdd" as Hash,
    oracleProgramDescriptorDigest: "0xd663c23ddaf895f4b982b31a64ab58885a5f19fbbb7a3c066d64c34f9a16b842" as Hash,
    adapterVersion: "six-step-gate-core-adapter-v1",
    oracleVersion: "six-step-independent-reference-model-v1",
    modulePath: "acceptance/gate-core/src/predicates/six-step.ts",
    exportName: "SIX_STEP_PREDICATE_EVALUATOR",
    oracleModulePath: "acceptance/six-step-facts/src/reference-model.ts",
    oracleExportName: "evaluateSixStepReferenceModel",
    materialProviderModulePath: "acceptance/collectors/src/material-providers/six-step.ts",
    materialProviderExportName: "SIX_STEP_MATERIAL_PROVIDER",
    materialProviderContractDigest: "0xc132f3bb2a141ab37abd74d5aeacf2538e8a4becf99c43983580eea87c340944" as Hash,
  }, {
    predicateId: "aloha.source-repository-production-closure-zero",
    predicateSpecDigest: "0x1215c3ce71ed37ac367201a6c5523530153e265c6629d3dbdf4134615e2fb113" as Hash,
    predicateProgramDescriptorDigest: "0x63446ae39c102ec7154211dc0969120a90438cd8af2c0a6d2cbc5e58e2d009a6" as Hash,
    oracleProgramDescriptorDigest: "0x0f0f093376671e30e85a2d0ad2949696079c8ae7753180a481d062a2298530b6" as Hash,
    adapterVersion: "source-repository-production-closure-zero-gate-core-adapter-v1",
    oracleVersion: "source-repository-production-closure-independent-reference-model-v1",
    modulePath: "acceptance/gate-core/src/predicates/runtime-acceptance.ts",
    exportName: "SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR",
    oracleModulePath: "acceptance/runtime-acceptance-facts/src/reference-model.ts",
    oracleExportName: "evaluateSourceRepositoryProductionClosureReferenceModel",
    materialProviderModulePath: "acceptance/collectors/src/material-providers/runtime-boundaries.ts",
    materialProviderExportName: "SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_MATERIAL_PROVIDER",
    materialProviderContractDigest: "0x9b7c614acafd557b82e4895e6f4a8a54be80d6a8118e75ec2108d0f98a8a62a9" as Hash,
  }, {
    predicateId: "aloha.terminal-selection-lineage.facts",
    predicateSpecDigest: "0x677057c80e8cb44b5c4711720dc8148d6789406306aa8de0ced8807dc997bd20" as Hash,
    predicateProgramDescriptorDigest: "0x09b0735d23a69b74cc72275008de1dc2acc15a9bbe2d742ed39839c3caa55355" as Hash,
    oracleProgramDescriptorDigest: "0x1fabf359833b4fada8c9dd382bbecc2d36184392affeb9513b2a5c5fadf9e56f" as Hash,
    adapterVersion: "terminal-selection-gate-core-adapter-v1",
    oracleVersion: "terminal-selection-lineage-reference-model-v1",
    modulePath: "acceptance/gate-core/src/predicates/terminal-selection.ts",
    exportName: "TERMINAL_SELECTION_PREDICATE_EVALUATOR",
    oracleModulePath: "acceptance/terminal-selection-facts/src/reference-model.ts",
    oracleExportName: "evaluateTerminalSelectionReferenceModel",
    materialProviderModulePath: "acceptance/collectors/src/material-providers/terminal-selection.ts",
    materialProviderExportName: "TERMINAL_SELECTION_MATERIAL_PROVIDER",
    materialProviderContractDigest: "0x3590a7a74cb587f45cf84ffb5c81fd3f456b40f4aa79cf2b45ec46ac620ecaaf" as Hash,
  }],
});

export function computePredicateCompositionRootDigest(leaves: readonly Hash[]): Hash {
  return hashDomain("aloha/predicate-composition-root/v1", [...leaves].sort());
}
