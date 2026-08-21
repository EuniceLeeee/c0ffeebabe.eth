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
}

/**
 * Static release intent consumed by the role-manifest generator. The
 * generator parses this object as a literal and then checks every digest and
 * named export against the actual adapter/oracle modules.
 */
export const RELEASE_ROLE_COMPOSITION = Object.freeze({
  schemaVersion: 1 as const,
  genericCore: {
    modulePath: "acceptance/gate-core/src/index.ts",
    exportName: "evaluateGateCoreRuntime",
  },
  releaseRuntime: {
    modulePath: "acceptance/gate-core/src/generated/release-runtime.ts",
    exportName: "evaluateGateCore",
  },
  predicateAdapters: [{
    predicateId: "aloha.artifact-lineage.facts",
    predicateSpecDigest: "0x3b31e4d45e9fa9256612d86c386b350f2d478ef0dcc852090a02934175e108b5" as Hash,
    predicateProgramDescriptorDigest: "0x79e2f2681c22d4fc2f4e9a8b62a38bbed51b968d31d902505b46d8931328b997" as Hash,
    oracleProgramDescriptorDigest: "0xe80e8e6a155135d247f4688b51f7ff755d48aa1bc1a47d65b0a12972a01832cc" as Hash,
    adapterVersion: "artifact-lineage-gate-core-adapter-v1",
    oracleVersion: "artifact-lineage-independent-oracle-v2",
    modulePath: "acceptance/gate-core/src/predicates/artifact-lineage.ts",
    exportName: "ARTIFACT_LINEAGE_PREDICATE_EVALUATOR",
    oracleModulePath: "acceptance/artifact-lineage-facts/src/reference-model.ts",
    oracleExportName: "evaluateArtifactLineageOracle",
  }],
});

export function computePredicateCompositionRootDigest(leaves: readonly Hash[]): Hash {
  return hashDomain("aloha/predicate-composition-root/v1", [...leaves].sort());
}
