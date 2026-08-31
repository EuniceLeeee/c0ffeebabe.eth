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
    materialProviderContractDigest: "0xe64f0cf45473d4777839fe8004d09f3d030a35aa1d631261ccff13a28f88151a" as Hash,
  }, {
    predicateId: "aloha.full-family.facts",
    predicateSpecDigest: "0x44383fab2b57e703c722ee21852f80c1d7addc5de0b03573f7c0f54afd73a50d" as Hash,
    predicateProgramDescriptorDigest: "0xf5c36544944221c1734cbca46a991d5257def0dc0b7855e7da918f27748e4851" as Hash,
    oracleProgramDescriptorDigest: "0x8378dc6460efc65704772592da53b4493e3b317365ddde0ff40fcbaaf3f931fb" as Hash,
    adapterVersion: "full-family-gate-core-adapter-v11",
    oracleVersion: "full-family-independent-reference-model-v10",
    modulePath: "acceptance/gate-core/src/predicates/full-family.ts",
    exportName: "FULL_FAMILY_PREDICATE_EVALUATOR",
    oracleModulePath: "acceptance/full-family-facts/src/reference-model.ts",
    oracleExportName: "evaluateFullFamilyReferenceModel",
    materialProviderModulePath: "acceptance/collectors/src/material-providers/full-family.ts",
    materialProviderExportName: "FULL_FAMILY_MATERIAL_PROVIDER",
    materialProviderContractDigest: "0x6d9dbf46290a735b307f3e5ffbee75c5eb8567f4c858cc85bf8d7bf92f9b7ec3" as Hash,
  }, {
    predicateId: "aloha.legacy-shaped-authority-zero",
    predicateSpecDigest: "0x147831b195b0e100da01f9e5a79d2c6a1663fefad8f34a3c2b512376f58280f8" as Hash,
    predicateProgramDescriptorDigest: "0x290bc5263890e4bf4584b8c9c2d3f09ace7d8270e97c4e5cc7a5aec718c53bd1" as Hash,
    oracleProgramDescriptorDigest: "0x1b08be5df4e968d4f5e2c4d3cffea7952a5df53b3fe86124e361399930907254" as Hash,
    adapterVersion: "legacy-shaped-authority-zero-gate-core-adapter-v3",
    oracleVersion: "legacy-shaped-authority-independent-reference-model-v1",
    modulePath: "acceptance/gate-core/src/predicates/runtime-acceptance.ts",
    exportName: "LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_EVALUATOR",
    oracleModulePath: "acceptance/runtime-acceptance-facts/src/reference-model.ts",
    oracleExportName: "evaluateLegacyShapedAuthorityReferenceModel",
    materialProviderModulePath: "acceptance/collectors/src/material-providers/runtime-boundaries.ts",
    materialProviderExportName: "LEGACY_SHAPED_AUTHORITY_ZERO_MATERIAL_PROVIDER",
    materialProviderContractDigest: "0xf288279c1937b7ee16152b5b20531e29e23906bcc319d78e3e9c5df7abf5fd72" as Hash,
  }, {
    predicateId: "aloha.performance.facts",
    predicateSpecDigest: "0xe588c7970985e9049b3cf74489f2e75f0ab07fbaa62c581e8091b8993c159085" as Hash,
    predicateProgramDescriptorDigest: "0x0f669f4f92f25607c2b48e7561612f98690318fa3de11a678d6384a41bad0698" as Hash,
    oracleProgramDescriptorDigest: "0x67c45cf45e2afb158b97a5602e1b04e6fa9fe1d93a70eb72ebb3b2be7989e358" as Hash,
    adapterVersion: "performance-gate-core-adapter-v2",
    oracleVersion: "performance-independent-reference-model-v2",
    modulePath: "acceptance/gate-core/src/predicates/performance.ts",
    exportName: "PERFORMANCE_PREDICATE_EVALUATOR",
    oracleModulePath: "acceptance/performance-facts/src/reference-model.ts",
    oracleExportName: "evaluatePerformanceReferenceModel",
    materialProviderModulePath: "acceptance/collectors/src/material-providers/performance.ts",
    materialProviderExportName: "PERFORMANCE_MATERIAL_PROVIDER",
    materialProviderContractDigest: "0xd69c012457c3dfb69eb9f72afc20f8b78322374660b5caa01a144986d08d24b5" as Hash,
  }, {
    predicateId: "aloha.runtime-restart.facts",
    predicateSpecDigest: "0xf9e10bcaba618ab3a457efec86424ddbeb049330d98375eaba550775abe33433" as Hash,
    predicateProgramDescriptorDigest: "0x9540a5648aa1b43268ffe7a1c3676e1009def6786f2e1ab12d16cdfddc555257" as Hash,
    oracleProgramDescriptorDigest: "0xcdf48766c4c398153eb84a94d325d3877790e403e2fb148c9f77180dd7b9e692" as Hash,
    adapterVersion: "runtime-restart-gate-core-adapter-v1",
    oracleVersion: "runtime-restart-independent-reference-model-v1",
    modulePath: "acceptance/gate-core/src/predicates/runtime-acceptance.ts",
    exportName: "RUNTIME_RESTART_PREDICATE_EVALUATOR",
    oracleModulePath: "acceptance/runtime-acceptance-facts/src/reference-model.ts",
    oracleExportName: "evaluateRuntimeRestartReferenceModel",
    materialProviderModulePath: "acceptance/collectors/src/material-providers/runtime-boundaries.ts",
    materialProviderExportName: "RUNTIME_RESTART_MATERIAL_PROVIDER",
    materialProviderContractDigest: "0x35e11707bd4d7e49e0340604524f9a181bd1813181462b48bff8db3e8defcfc7" as Hash,
  }, {
    predicateId: "aloha.six-step.facts",
    // These digests are generated from the frozen six-step spec and descriptor
    // bytes. They are intent, not a caller-selectable runtime map.
    predicateSpecDigest: "0xf2e2142ba8e7238ee2cb3b408c78fc7fadd184901bebaf7eefc344670a57cd73" as Hash,
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
    materialProviderContractDigest: "0xa547e9c16bc048cbf751938daa24d6a7f7a575bffe0c6123591019fbdec67b92" as Hash,
  }, {
    predicateId: "aloha.source-repository-production-closure-zero",
    predicateSpecDigest: "0x23b26ebe18de016685f5e27fb79571f32a5c2edb967c5804a8b52285cbdef567" as Hash,
    predicateProgramDescriptorDigest: "0xdb5cb81046531b31aff6f6e1b3b06b28b883c58107afd2376e171a16a9197c27" as Hash,
    oracleProgramDescriptorDigest: "0x6a2871a5cefea418af57561739aedbeac7f91762cc4aaf70a2b357e8922be75c" as Hash,
    adapterVersion: "source-repository-production-closure-zero-gate-core-adapter-v3",
    oracleVersion: "source-repository-production-closure-independent-reference-model-v1",
    modulePath: "acceptance/gate-core/src/predicates/runtime-acceptance.ts",
    exportName: "SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR",
    oracleModulePath: "acceptance/runtime-acceptance-facts/src/reference-model.ts",
    oracleExportName: "evaluateSourceRepositoryProductionClosureReferenceModel",
    materialProviderModulePath: "acceptance/collectors/src/material-providers/runtime-boundaries.ts",
    materialProviderExportName: "SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_MATERIAL_PROVIDER",
    materialProviderContractDigest: "0xfc131804460d4da504920430572c4a24e9183b1f1a2fc9b921927f757987de26" as Hash,
  }, {
    predicateId: "aloha.terminal-selection-lineage.facts",
    predicateSpecDigest: "0x6225c27ecf4d524b0536d1ac6f756e39e039f94852121cd20e489fa69ddea943" as Hash,
    predicateProgramDescriptorDigest: "0xb2c989e5fd2b73ea63a67d6233acc4188d66b63d7daba6711acce13acded90ff" as Hash,
    oracleProgramDescriptorDigest: "0x8a234b3740d57513dc142cad31b3f637d7e913b68ca72da80fc62d05b530f1c4" as Hash,
    adapterVersion: "terminal-selection-gate-core-adapter-v1",
    oracleVersion: "terminal-selection-lineage-reference-model-v1",
    modulePath: "acceptance/gate-core/src/predicates/terminal-selection.ts",
    exportName: "TERMINAL_SELECTION_PREDICATE_EVALUATOR",
    oracleModulePath: "acceptance/terminal-selection-facts/src/reference-model.ts",
    oracleExportName: "evaluateTerminalSelectionReferenceModel",
    materialProviderModulePath: "acceptance/collectors/src/material-providers/terminal-selection.ts",
    materialProviderExportName: "TERMINAL_SELECTION_MATERIAL_PROVIDER",
    materialProviderContractDigest: "0x213f510cdeff8e8e381e236f57bccde47f28e8b9caa2e4dc7bd8b8671e577605" as Hash,
  }],
});

export function computePredicateCompositionRootDigest(leaves: readonly Hash[]): Hash {
  return hashDomain("aloha/predicate-composition-root/v1", [...leaves].sort());
}
